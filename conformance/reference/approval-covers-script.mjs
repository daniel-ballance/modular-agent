import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

// Appending via read and write makes a repeated effect visible in the files too.
const paths = ["first.txt", "second.txt"];
export const code = `for path in ["first.txt", "second.txt"]:
    try:
        before = tools.read(path=path)
    except RuntimeError:
        before = ""
    tools.write(path=path, content=before + "x")`;
const meta = r => r?._meta?.["modular-agent"];

export async function checkApprovalCoversScript(command, invoke, t, env) {
  const files = () => paths.map(path => existsSync(join(t.project, path)) ? readFileSync(join(t.project, path), "utf8") : null);
  async function writer(label, decision, run) {
    const err = openSync(join(t.dir, label + ".stderr"), "w", 0o600);
    let child;
    try {
      child = spawn(command[0], [...command.slice(1), "--acp", "--approval", "ask"], { cwd: t.project, env, detached: true, stdio: ["pipe", "pipe", err] });
    } finally { closeSync(err); }
    const exit = once(child, "exit"), lines = createInterface({ input: child.stdout });
    const reader = lines[Symbol.asyncIterator](), signal = AbortSignal.timeout(30_000);
    const permissions = [];
    let serial = 0;
    const send = msg => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    async function request(method, params) {
      const id = ++serial;
      send({ id, method, params });
      for (;;) {
        const { value, done } = await reader.next();
        assert.ok(!done, label + ": ma closed ACP during " + method);
        const msg = JSON.parse(value);
        if (msg.method === "session/request_permission") {
          permissions.push(msg.params);
          assert.ok(decision && permissions.length === 1, label + ": unexpected permission RPC");
          assert.equal(msg.params.toolCall.title, "codemode");
          assert.deepEqual(msg.params.toolCall.rawInput, { code }, "permission shows the complete script");
          send({ id: msg.id, result: { outcome: { outcome: "selected", optionId: decision } } });
        } else if (!msg.method && msg.id === id) {
          assert.equal(msg.error, undefined, JSON.stringify(msg.error));
          return msg.result;
        }
      }
    }
    try {
      await Promise.race([once(signal, "abort").then(() => { throw Error(label + " timed out"); }), (async () => {
        await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
        await run(request, permissions, signal);
      })()]);
    } finally {
      lines.close();
      if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH" && !(process.platform === "darwin" && e.code === "EPERM")) throw e; }
      await exit;
    }
  }
  const open = (rpc, id) => rpc(id ? "session/load" : "session/new", { cwd: t.project, mcpServers: [], ...(id && { sessionId: id }) });
  const prompt = (rpc, sessionId) => rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "Write both files." }] });
  const history = async (rpc, sessionId) => (await rpc("_modular-agent/history", {sessionId})).entries;
  function checkHistory(entries, ref, allowed) {
    const starts = entries.filter(e => e.kind === "toolStarted");
    const questions = entries.filter(e => e.kind === "inputRequest");
    assert.equal(questions.length, 1, "only the script asks for approval");
    assert.equal(questions[0].data.request.id, ref.requestId);
    assert.equal(questions[0].data.request.coversNested, true);
    assert.deepEqual(questions[0].data.request.call, { name: "codemode", input: { code } });
    const parents = starts.filter(e => e.toolCallId === ref.toolCallId);
    assert.equal(parents.length, Number(allowed), "the parent starts only on allow and only once");
    if (!allowed) { assert.equal(starts.length, 0); return; }
    const writes = starts.filter(e => e.data.call.name === "write");
    assert.deepEqual(writes.map(e => e.data.call.input.path), paths);
    for (const e of writes) {
      assert.equal(e.data.call.parentCallId, ref.toolCallId);
      assert.deepEqual(e.data.approvalCoveredBy, ref, "each write names the parent's allow");
    }
  }
  for (const decision of ["refuse", "allow"]) await writer(decision, decision, async (rpc, permissions) => {
    const session = await open(rpc), sid = session.sessionId;
    assert.equal(meta(session).declaration.approvalCoversNested, true);
    assert.equal((await prompt(rpc, sid)).stopReason, "end_turn");
    assert.equal(permissions.length, 1);
    const [p] = permissions;
    checkHistory(await history(rpc, sid), { toolCallId: p.toolCall.toolCallId, requestId: meta(p).requestId }, decision === "allow");
    assert.deepEqual(files(), decision === "allow" ? ["x", "x"] : [null, null]);
  });

  for (const path of paths) rmSync(join(t.project, path));
  writeFileSync(join(t.data, "settings.json"), JSON.stringify({ approval_wait: "untilDeadline" }));
  writeFileSync(join(t.data, "policy.json"), JSON.stringify({ approvalWaitMaxMs: 60000 }));
  let sid, ref;
  await writer("park", null, async rpc => {
    const session = await open(rpc); sid = session.sessionId;
    assert.equal(meta(session).declaration.approvalsOutlastTurns, true);
    const reply = await prompt(rpc, sid);
    assert.equal(reply.stopReason, "end_turn");
    const [callId] = meta(reply).openToolCalls;
    const es = await history(rpc, sid);
    const question = es.find(e => e.kind === "inputRequest" && e.toolCallId === callId);
    ref = { toolCallId: callId, requestId: question.data.request.id };
    assert.ok(!es.some(e => e.kind === "toolStarted"));
    assert.deepEqual(files(), [null, null]);
  });
  const batch = await invoke(command, { args: ["--approval", "ask", "--session", sid, "-p", "Write both files."] });
  assert.equal(batch.exit, 1, batch.timeoutDetail ?? batch.stderr);
  assert.match(batch.stderr, /This session has a waiting approval\. Answer it before using print mode\./);
  await writer("continue", null, async (rpc, _, signal) => {
    await open(rpc, sid);
    const { requests } = await rpc("_modular-agent/requests", { sessionId: sid });
    assert.equal(requests.length, 1);
    const [q] = requests;
    assert.equal(q.id, ref.requestId); assert.equal(q.toolCallId, ref.toolCallId);
    assert.equal(q.answerable, true); assert.equal(q.coversNested, true);
    assert.equal(q.approvalWait, "untilDeadline"); assert.deepEqual(q.call, { name: "codemode", input: { code } });
    assert.equal((await rpc("_modular-agent/answer", { sessionId: sid, requestId: q.id, value: "allow" })).accepted, true);
    let es;
    do {
      es = await history(rpc, sid);
      if (es.filter(e => e.kind === "turnEnd").length >= 2) break;
      await delay(10, undefined, { signal });
    } while (true);
    checkHistory(es, ref, true);
    const turns = es.filter(e => e.kind === "turnStart");
    assert.equal(turns.length, 2);
    assert.equal(turns[1].continuesTurnId, turns[0].turnId);
    assert.ok(es.filter(e => e.kind === "toolStarted").every(e => e.turnId === turns[1].turnId));
    assert.deepEqual(files(), ["x", "x"]);
  });
}
