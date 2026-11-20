import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { definePlugin, serve, tool } from "@modular-agent/core";
import { testAgent } from "@modular-agent/core/testing";
import { ACP_PROTOCOL, connectWebSocket } from "@modular-agent/plugin-wire";

async function token(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "sdk-websocket-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, "token");
  await writeFile(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  return { dir, tokenFile };
}

test("SDK loads in-process, stdio, explicit service and environment services in order", async t => {
  const { tokenFile } = await token(t);
  const names: string[] = [];
  const plugin = definePlugin({ name: "listener", hooks: { "plugin.load": p => { names.push(p.name); } } });
  const first = await serve(definePlugin({ name: "first" }), { listen: "127.0.0.1:0", tokenFile });
  const second = await serve(definePlugin({ name: "second", setup(r) { assert.equal(r.config().check, true); } }), { listen: "127.0.0.1:0", tokenFile });
  const prior = process.env.MODULAR_AGENT_PLUGINS;
  const configured = { url: second.url, tokenFile, config: { check: true } };
  try {
    process.env.MODULAR_AGENT_PLUGINS = JSON.stringify([configured]);
    // An env entry is not sufficient to enable hosting in an embedded agent.
    const embedded = await testAgent({ script: [] });
    await embedded.close();
    const child = `process.stdin.on('data', b => { for (const line of String(b).trim().split('\\n')) {
      const { id, method } = JSON.parse(line);
      console.log(JSON.stringify({jsonrpc:'2.0', id, result: method === 'plugin/initialize' ? { name:'child', binding:'modular-agent-plugin/1' } : {} }));
    }});`;
    const hosted = await testAgent({ script: [], plugins: [plugin], processPlugins: [{ command: [process.execPath, "-e", child] }],
      servicePlugins: [{ url: first.url, tokenFile }] });
    await hosted.close();
    assert.deepEqual(names.filter(n => ["child", "first", "second"].includes(n)), ["child", "first", "second"]);
    process.env.MODULAR_AGENT_PLUGINS = JSON.stringify([{ ...configured, command: ["also-stdio"] }]);
    await assert.rejects(testAgent({ script: [], pluginHost: true }), { code: "invalid_composition" });
    delete process.env.MODULAR_AGENT_PLUGINS;
    await assert.rejects(testAgent({ script: [], pluginHost: false, servicePlugins: [] }), { code: "invalid_composition" });
    await assert.rejects(testAgent({ script: [], servicePlugins: [{ ...configured, config: {} }] }), { code: "invalid_composition" });
    await second.close();
    await assert.rejects(testAgent({ script: [], servicePlugins: [configured] }), { code: "invalid_composition" });
  } finally {
    if (prior === undefined) delete process.env.MODULAR_AGENT_PLUGINS;
    else process.env.MODULAR_AGENT_PLUGINS = prior;
    await Promise.all([first.close(), second.close()]);
  }
});

test("ACP service selects each connection's actor and enforces token scope", async t => {
  const { dir, tokenFile } = await token(t);
  const other = await token(t);
  const agent = await testAgent({ project: dir, script: [{ text: "Hi" }], tenants: { team: { rights: ["watch", "input"] } } });
  const service = await agent.serveAcp({ listen: "127.0.0.1:0", actors: [
    { tokenFile, actor: { id: "team-viewer", kind: "program", rights: ["watch"] }, tenants: ["team"], projects: [dir] },
    { tokenFile: other.tokenFile, actor: { id: "visitor", kind: "user", rights: ["watch", "input"] }, tenants: [null] },
  ] });
  try {
    const a = await connectWebSocket(service.url, tokenFile, ACP_PROTOCOL, 5000);
    const b = await connectWebSocket(service.url, other.tokenFile, ACP_PROTOCOL, 5000);
    let id = 1;
    const request = (socket: typeof a, method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
      const requestId = id++;
      const listener = (bytes: Buffer) => {
        const response = JSON.parse(bytes.toString());
        if (response.id !== requestId) return;
        socket.off("message", listener);
        if (response.error) reject(response.error.data ?? response.error);
        else resolve(response.result);
      };
      socket.on("message", listener);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
    });
    const init = { protocolVersion: 1, _meta: { "modular-agent": { actor: { id: "not-trusted" } } } };
    assert.deepEqual((await request(a, "initialize", init))._meta["modular-agent"].actor, { id: "team-viewer", kind: "program", rights: ["watch"] });
    assert.equal((await request(b, "initialize", init))._meta["modular-agent"].actor.id, "visitor");
    assert.deepEqual(await request(a, "$/ping"), {});
    await assert.rejects(request(a, "session/new", { cwd: dir, mcpServers: [] }), { code: "forbidden" });
    const team = { mcpServers: [], _meta: { "modular-agent": { tenant: "team" } } };
    await assert.rejects(request(a, "session/new", { ...team, cwd: other.dir }), { code: "forbidden" });
    const { sessionId } = await request(a, "session/new", { ...team, cwd: dir });
    await assert.rejects(request(a, "session/prompt", { sessionId, prompt: [{ type: "text", text: "No" }] }), { code: "forbidden" });
    await assert.rejects(request(b, "session/load", { sessionId, cwd: dir, mcpServers: [] }), { code: "forbidden" });
    assert.deepEqual((await request(b, "session/list")).sessions, []);
    const own = await request(b, "session/new", { cwd: dir, mcpServers: [] });
    assert.notEqual(own.sessionId, sessionId);
    assert.equal((await request(b, "session/prompt", { sessionId: own.sessionId, prompt: [{ type: "text", text: "Yes" }] })).stopReason, "end_turn");
  } finally { await service.close(); }
});

test("loss of a plugin service settles its dispatched tool once as outcomeUnknown", async t => {
  const { tokenFile } = await token(t);
  let signalStarted!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  let calls = 0;
  const plugin = definePlugin({ name: "hold", tools: [tool({ name: "hold", description: "Wait for cancel", input: { type: "object" },
    async run(_, cx) {
      calls++;
      signalStarted();
      await new Promise<void>(resolve => cx.cancelled.addEventListener("abort", () => resolve(), { once: true }));
      return "cancelled";
    } })] });
  const service = await serve(plugin, { listen: "127.0.0.1:0", tokenFile });
  try {
    const agent = await testAgent({ script: [{ toolCalls: [{ name: "hold", input: {} }] }, { text: "Done" }],
      servicePlugins: [{ url: service.url, tokenFile }] });
    try {
      const session = await agent.session();
      const result = session.prompt("Hold");
      await started;
      await service.close();
      assert.deepEqual((await result).toolResults().map(r => r.status), ["outcomeUnknown"]);
      assert.equal(calls, 1);
    } finally { await agent.close(); }
  } finally { await service.close(); }
});
