import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  AgentError, createAgent, definePlugin, fileHistory, httpHistory, serveHistory, tool,
  type ErrorCode,
} from "@modular-agent/core";
import { memoryEnvironment, overWire, testAgent } from "@modular-agent/core/testing";
import { gitProject } from "./fixtures/git-project.js";

async function scratch(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "sdk-errors-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const code = (expected: ErrorCode, data?: unknown) => (error: unknown) => {
  assert.ok(error instanceof AgentError);
  assert.equal(error.code, expected);
  if (data !== undefined) assert.deepEqual(error.data, data);
  return true;
};

for (const action of ["erase", "fork", "move"] as const) {
  test(`${action} reports busy during a running turn`, async t => {
    let started!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const release = new Promise<void>(resolve => { finish = resolve; });
    let turns = 0;
    const agent = await testAgent({ script: [{ text: "first" }, { text: "second" }], plugins: [
      definePlugin({ name: "pause", hooks: { async "provider.request"() {
        if (++turns === 2) { started(); await release; }
      } } }),
    ] });
    t.after(() => agent.close());
    const session = await agent.session();
    await session.prompt("first");
    const end = (await session.history()).find(e => e.kind === "turnEnd")!.id;
    const running = session.prompt("second");
    try {
      await entered;
      await assert.rejects(action === "erase" ? session.erase([end])
        : action === "move" ? session.moveTo(end) : session.fork(end), code("busy"));
    } finally { finish(); await running; }
  });
}

test("rewind without points reports not_supported, not busy", async t => {
  const agent = await testAgent({ environment: memoryEnvironment(), script: [{ text: "done" }] });
  t.after(() => agent.close());
  const session = await agent.session();
  await session.prompt("work");
  const end = (await session.history()).find(e => e.kind === "turnEnd")!.id;
  await assert.rejects(session.moveTo(end, { rewind: true }), code("not_supported"));
});

test("an input-dispatched command that does not exist reports not_found", async t => {
  const agent = await testAgent({ script: [], plugins: [definePlugin({ name: "input-command", setup(r) {
    r.on("input", () => ({ handle: { command: "/missing" } }), "normal", { inProcessOnly: true });
  } })] });
  t.after(() => agent.close());
  await assert.rejects((await agent.session()).prompt("dispatch"), code("not_found"));
});

test("an HTTP history store reports an unpublished or missing session as not_found", async t => {
  const dir = await scratch(t);
  const tokenFile = join(dir, "token");
  const token = randomBytes(32).toString("hex");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const server = await serveHistory(fileHistory(join(dir, "history")), { address: "127.0.0.1:0", tokenFile });
  let agent: Awaited<ReturnType<typeof testAgent>> | undefined;
  try {
    agent = await testAgent({ script: [], durability: "kept", history: httpHistory(server.url, tokenFile) });
    await assert.rejects(agent.sessionInfo("missing"), code("not_found"));
    await assert.rejects(agent.openSession("missing"), code("not_found"));
    assert.equal((await fetch(`${server.url}/v1/sessions/unpublished`, {
      method: "PUT", body: '{"project":"/project","created":1}', headers: {
        authorization: `Bearer ${token}`, "content-type": "application/json",
      },
    })).status, 200);
    await assert.rejects(agent.sessionInfo("unpublished"), code("not_found"));
  } finally {
    try { await agent?.close(); } finally { await server.close(); }
  }
});

for (const [remote, expected, retryAfterMs] of [
  ["unknown_entry", "not_found", undefined], ["entry_too_large", "result_too_large", undefined],
  ["request_too_large", "message_too_large", undefined], ["unavailable", "lost", undefined], ["held", "held", 1500],
] as const) test(`HTTP history maps ${remote} to ${expected}`, async t => {
  const dir = await scratch(t);
  const tokenFile = join(dir, "token");
  await writeFile(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  // These are wire failures: exercise the client rather than injecting SDK errors.
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1") res.end('{"binding":"modular-agent-history/1","ttlMs":10}');
    else if (req.url === "/v1/sessions") res.end('{"sessions":[]}');
    else {
      res.statusCode = retryAfterMs ? 409 : expected === "not_found" ? 404 : expected === "lost" ? 503 : 413;
      res.end(JSON.stringify({ code: remote, error: "test refusal", retryAfterMs }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");
    const agent = await testAgent({ script: [], durability: "kept", history: httpHistory(`http://127.0.0.1:${addr.port}`, tokenFile) });
    try {
      await assert.rejects(agent.openSession("known"), code(expected, retryAfterMs ? { retryAfterMs } : undefined));
    } finally { await agent.close(); }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

for (const served of [false, true]) test(`job start without authority is invalid_request (${served ? "served" : "local"})`, async t => {
  const plugin = definePlugin({ name: "job-probe", tools: [tool({ name: "probe", description: "Check rights",
    input: { type: "object" }, async run(_, cx) {
      await assert.rejects(cx.jobs.start("probe", {}), code("invalid_request"));
      return "denied";
    },
  })] });
  const agent = await createAgent({ project: await gitProject(t), severalActors: true, plugins: [served ? overWire(plugin) : plugin] });
  t.after(() => agent.close());
  const session = await agent.session();
  await session.join({ id: "tool-user", kind: "user", rights: ["watch", "tools"] });
  assert.equal((await session.as("tool-user").callTool("probe", {})).text(), "denied");
});
