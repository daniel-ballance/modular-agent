import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { amount, reviewer, waitingAgent } from "./fixtures/waiting-approval.js";
import { definePlugin, tool, transientRuntime, type AgentOptions } from "../src/index.js";
import { testAgent } from "../src/testing.js";

async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "waiting-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
async function count(dir: string) {
  try { return (await readFile(join(dir, "count"), "utf8")).length; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; return 0; }
}
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { release, promise }; }

test("only a handle that received the waiting approval can allow the unstarted call", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ma-approval-"));
  let effects = 0;
  const agent = await testAgent({ durability: "kept", dataDir, approval: "all", questionsOutlastTurns: true,
    maxApprovalWaitMs: 60_000, severalActors: true, tools: [tool({ name: "bump", description: "Increment the counter", input: { type: "object" },
      run: () => String(++effects) })], script: [{ toolCalls: [{ name: "bump", input: { by: 1 } }] }, { text: "Done" }] });
  try {
    assert.equal(agent.declaration().approvalsOutlastTurns, true);
    const session = await agent.session({ settings: { approvalWait: "untilDeadline" }, actors: [{ id: "reviewer", kind: "user", rights: ["watch", "approve"] }] });
    const origin = await session.prompt("Increment the counter");
    await session.waitIdle();
    const [id] = origin.openToolCalls;
    assert.ok(id);
    assert.equal(effects, 0);
    const handle = session.as("reviewer");
    const [q] = await handle.questions();
    assert.equal(q.approvalWait, "untilDeadline");
    assert.deepEqual(q.call?.input, { by: 1 });
    await assert.rejects(handle.answer(q.id, "allow"));
    assert.deepEqual(await handle.questions({ present: true }), [q]);
    await assert.rejects(session.as("reviewer").answer(q.id, "allow"));
    await handle.answer(q.id, "allow");
    await session.waitIdle();
    assert.equal(effects, 1);
    const history = await session.history();
    const start = history.find(e => e.kind === "toolStarted");
    const continuation = history.find(e => e.kind === "turnStart" && e.continuesTurnId === origin.turnId);
    assert.ok(start && continuation);
    assert.equal(start.turnId, continuation.turnId);
    assert.equal(start.toolCallId, id);
    assert.equal(history.filter(e => e.kind === "inputAccepted").length, 1);
  } finally { await agent.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("the operator maximum needs compatible history, approval and continuation support", async t => {
  const dir = await directory(t);
  const unsupported = transientRuntime(); unsupported.supports.interfaceTools = false;
  for (const options of [{ durability: "ephemeral", dataDir: undefined }, { approval: undefined }, { questionsOutlastTurns: false },
    { runtime: unsupported }, ...[0, -1, Number.NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1].map(maxApprovalWaitMs => ({ maxApprovalWaitMs }))]) {
    await assert.rejects(waitingAgent(dir, false, options as AgentOptions), { code: "invalid_composition" });
  }
  const agent = await waitingAgent(dir, false, { maxApprovalWaitMs: undefined, settings: {} }); t.after(() => agent.close());
  assert.equal(agent.declaration().approvalsOutlastTurns, undefined);
  await assert.rejects(agent.session({ settings: { approvalWait: "untilDeadline" } }), { code: "not_supported" });
  const session = await agent.session();
  await assert.rejects(session.setSetting("approvalWait", "untilDeadline"), { code: "not_supported" });
  await assert.rejects(session.questions({ present: true }), { code: "not_supported" });
  assert.equal((await session.prompt("Increment")).toolResults()[0].status, "refused");
  assert.equal(await count(dir), 0);
});

for (const remote of [false, true]) {
  const where = remote ? "served" : "in process";
  test(where + ": live default and approval policy take precedence over a session's lifetime choice", async t => {
    const dir = await directory(t);
    const agent = await waitingAgent(dir, remote, { settings: {} }, undefined, "counter", "Read the counter", true); t.after(() => agent.close());
    for (const [approval, wait, status] of [["all", "live", "refused"], ["ask", "untilDeadline", "completed"], ["off", "untilDeadline", "completed"], ["never", "untilDeadline", "refused"]]) {
      const session = await agent.session({settings:{approval, ...(wait !== "live" ? {approvalWait:wait} : {})}});
      await assert.rejects(session.setSetting("approvalWait", "tomorrow"), {code:"invalid_params"});
      const origin = await session.prompt("Counter");
      assert.deepEqual(origin.openToolCalls, []);
      assert.equal(origin.toolResults()[0].status,status);
      assert.deepEqual(await session.questions(),[]);
      if (wait !== "live") assert.ok(!(await session.history()).some(e => e.kind === "inputRequest"));
      await session.close();
    }
  });

  for (const reason of ["allow", "decline", "expire open", "expire allowed", "revoke approver", "revoke worker", "changed input", "gated decision"] as const) {
    test(where + ": " + reason + " at the continuation boundary", async t => {
      const dir = await directory(t);
      let now = Date.now(), changed = false, gated = false, turns = 0;
      t.mock.method(Date, "now", () => now);
      const entered = latch(), release = latch();
      const barrier = definePlugin({ name: "barrier", setup(r) {
        r.on("turn.before", async () => { if (++turns === 2) { entered.release(); await release.promise; } });
        r.on("tool.before", ({call}) => changed && call.input.amount !== 2 ? {change:{amount:2}} : undefined);
        r.on("output", ({recipient, events}) => gated && recipient === reviewer.id && events.some(e => e.type === "input.request.opened") ? "block" : undefined);
      }});
      const short = reason === "expire open";
      const agent = await waitingAgent(dir, remote, { plugins:[barrier], settings: { approvalWait:"untilDeadline", approvalWaitMs: short ? 10_000 : 90_000 } });
      t.after(() => agent.close());
      try {
        const worker = { id: "worker", kind:"program" as const, rights:["watch","input","tools"] as ("watch"|"input"|"tools")[] };
        const session = await agent.session({ actors: [reviewer, worker] });
        const origin = await session.as(worker.id).prompt("Increment");
        assert.equal(origin.outcome?.kind,"completed");
        assert.equal(origin.openToolCalls.length,1);
        const [id] = origin.openToolCalls;
        const handle = session.as(reviewer.id);
        const [q] = await handle.questions({present:true});
        assert.deepEqual(q.call, {id, name:"bump", input:amount, startedBy:"model", actorId:worker.id, stepId:q.call?.stepId});
        assert.equal(q.deadline, now + (short ? 10_000 : 60_000));
        const history = await session.history(), request = history.find(e=>e.requestId===q.id)!;
        const pending = history[history.indexOf(request)+1];
        assert.deepEqual(pending.data,{requestIds:[q.id]}); assert.equal(pending.kind,"toolPending"); assert.equal(pending.stepId,q.call?.stepId);
        assert.equal((request.data as any).request.answerable,false); assert.equal((request.data as any).request.deadlineAt,q.deadline);
        assert.ok(request.sources?.includes(history.find(e=>e.kind==="response")!.id));
        assert.equal(await count(dir),0); assert.ok(!history.some(e=>e.kind==="toolStarted"));
        if (reason === "expire open") { now = q.deadline!; await assert.rejects(handle.answer(q.id,"allow")); }
        else await handle.answer(q.id, reason === "decline" ? "decline" : "allow");
        await entered.promise;
        if (reason === "revoke approver") await session.leave(reviewer.id);
        if (reason === "revoke worker") await session.leave(worker.id);
        if (reason === "expire allowed") now = q.deadline!;
        changed = reason === "changed input"; gated = reason === "gated decision";
        release.release(); await session.waitIdle();
        const entries = await session.history();
        const answers = entries.filter(e=>e.kind==="inputAnswer"), results = entries.filter(e=>e.kind==="toolResult");
        assert.equal(answers.length,1); assert.equal(results.length,1);
        const body = answers[0].data as any;
        if (reason === "expire open") { assert.equal(body.reason,"timeLimit"); assert.equal(body.actorId,undefined); }
        else if (reason === "decline") assert.equal(body.declined,true);
        else assert.equal(body.value,"allow");
        assert.equal(body.approvalView,undefined,"ordinary history hides the proof");
        assert.deepEqual(results[0].data && (results[0].data as any).status, reason === "allow" ? "completed" : reason.startsWith("expire") ? "notStarted" : "refused");
        assert.ok(results[0].sources?.includes(request.id)); assert.ok(results[0].sources?.includes(answers[0].id));
        assert.equal(await count(dir),reason === "allow" ? 1 : 0);
        assert.equal(entries.filter(e=>e.kind==="toolStarted").length, reason === "allow" ? 1 : 0);
        assert.equal(entries.filter(e=>e.kind==="inputAccepted").length,1);
        assert.equal(entries.filter(e=>e.kind==="inputRequest").length,1);
        assert.equal(entries.filter(e=>e.kind==="turnStart" && e.continuesTurnId===origin.turnId).length,1);
        await assert.rejects(handle.answer(q.id,"allow"));
      } finally { release.release(); }
    });
  }

  for (const change of ["registration", "definition", "unsupported writer", "smaller maximum", "expire offline"] as const) {
    test(where + ": reopen with " + change, async t => {
      const dir = await directory(t);
      let now = Date.now(); t.mock.method(Date,"now",()=>now);
      const agent = await waitingAgent(dir, remote); const session = await agent.session();
      const origin = await session.prompt("Increment");
      const [original] = await session.questions({present:true});
      await session.close(); await agent.close();
      if (change === "expire offline") now = original.deadline!;
      const reopened = await waitingAgent(dir, remote, change === "unsupported writer" ? { maxApprovalWaitMs:undefined, settings:{} }
        : change === "smaller maximum" ? {maxApprovalWaitMs:1000} : {}, undefined, change === "registration" ? "replacement" : "counter", change === "definition" ? "Changed" : "Increment");
      t.after(() => reopened.close());
      const later = await reopened.openSession(session.id);
      if (change === "registration" || change === "definition") {
        await assert.rejects(later.answer(original.id,"allow"));
        assert.deepEqual(await later.questions({present:true}),[original]); await later.answer(original.id,"allow");
      }
      await later.waitIdle();
      const entries = await later.history();
      assert.equal(entries.filter(e=>e.kind==="inputRequest").length,1);
      assert.equal(entries.filter(e=>e.kind==="toolStarted").length,0);
      const result = entries.filter(e=>e.kind==="toolResult" && origin.openToolCalls.includes(e.toolCallId!));
      assert.equal(result.length,1); assert.equal((result[0].data as any).status, ["unsupported writer","expire offline"].includes(change) ? "notStarted" : "refused");
      assert.equal(await count(dir),0);
    });
  }

  test(where + ": erasing an open request retires its view, call and queued effects", async t => {
    const dir = await directory(t), agent = await waitingAgent(dir,remote); t.after(()=>agent.close());
    const session = await agent.session();
    const origin = await session.prompt("Increment"), [q] = await session.questions({present:true});
    const entries = await session.history(), req = entries.find(e=>e.requestId===q.id)!;
    await assert.rejects(session.fork(),{code:"busy"}); await assert.rejects(session.moveTo(entries[0].id),{code:"busy"});
    await session.erase([req.id]); await assert.rejects(session.answer(q.id,"allow")); await session.waitIdle();
    const records = await session.history();
    assert.ok(records.find(e=>e.id===req.id)?.erased);
    assert.equal(records.filter(e=>e.kind==="toolResult" && e.toolCallId===origin.openToolCalls[0]).length,1);
    assert.equal(await count(dir),0);
  });

  for (const durability of ["kept","durable"] as const) for (const cutoff of ["waiting","allowed","effect"]) {
    test(where + ": SIGKILL " + cutoff + " and reopen " + durability, {skip: process.platform === "win32"}, async t => {
      const dir = await directory(t);
      const child = fork(new URL("./fixtures/waiting-approval.js", import.meta.url), ["approval-crash", dir, remote ? "served" : "local", cutoff, durability],
        { detached:true, execArgv:[], stdio:["ignore","ignore","pipe","ipc"] });
      let diagnostic = ""; child.stderr!.setEncoding("utf8").on("data", data => { diagnostic += data; });
      const exited = once(child,"exit");
      const kill = () => { if (child.pid && child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid!,"SIGKILL"); } catch(e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; } };
      t.after(async () => { kill(); await exited; });
      const ready = await Promise.race([once(child,"message").then(([v]) => v as {id:string; callId:string; questionId:string; deadline:number}),
        exited.then(() => { throw new Error("Wait fixture exited before its commit barrier: " + diagnostic); })]);
      kill(); assert.equal((await exited)[1],"SIGKILL");
      assert.equal(await count(dir),cutoff === "effect" ? 1 : 0);
      const agent = await waitingAgent(dir,remote,{durability}); t.after(()=>agent.close());
      const session = await agent.openSession(ready.id), approver = session.as(reviewer.id);
      if (cutoff === "waiting") {
        await assert.rejects(approver.answer(ready.questionId,"allow"));
        const [q] = await approver.questions({present:true});
        assert.equal(q.id,ready.questionId); assert.equal(q.call?.id,ready.callId); assert.equal(q.deadline,ready.deadline);
        await approver.answer(q.id,"allow");
      }
      await session.waitIdle(); const history = await session.history();
      assert.equal(await count(dir),1);
      assert.equal(history.filter(e=>e.kind==="inputRequest").length,1);
      assert.equal(history.filter(e=>e.kind==="inputAnswer").length,1);
      assert.equal(history.filter(e=>e.kind==="toolStarted").length,1);
      assert.equal(history.filter(e=>e.kind==="toolResult").length,1);
      assert.equal((history.find(e=>e.kind==="toolResult")?.data as any).status, cutoff === "effect" ? "outcomeUnknown" : "completed");
      assert.equal(history.filter(e=>e.kind==="turnStart" && e.continuesTurnId).length,1);
    });
  }
}
