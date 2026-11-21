import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { definePlugin, memoryHistory, serve, tool } from "@modular-agent/core";
import { testAgent } from "@modular-agent/core/testing";
import { ACP_PROTOCOL, connectWebSocket } from "@modular-agent/plugin-wire";
import { interruptedHistory } from "./fixtures/interrupted-history.js";

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
    await assert.rejects(testAgent({ script: [], pluginHost: false, servicePlugins: [configured] }), { code: "invalid_composition" });
    await assert.rejects(testAgent({ script: [], servicePlugins: [{ ...configured, config: {} }] }), { code: "invalid_composition" });
    await second.close();
    await assert.rejects(testAgent({ script: [], servicePlugins: [configured] }), { code: "invalid_composition" });
  } finally {
    if (prior === undefined) delete process.env.MODULAR_AGENT_PLUGINS;
    else process.env.MODULAR_AGENT_PLUGINS = prior;
    await Promise.all([first.close(), second.close()]);
  }
});

let nextRequest = 1;
function request(socket: Awaited<ReturnType<typeof connectWebSocket>>, method: string, params: unknown = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextRequest++;
    const listener = (bytes: Buffer) => {
      const response = JSON.parse(bytes.toString());
      if (response.id !== id) return;
      socket.off("message", listener);
      if (response.error) reject(response.error.data ?? response.error);
      else resolve(response.result);
    };
    socket.on("message", listener);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

for (const reason of ["commitFailed", "writerLost"] as const) {
  test(`ACP broadcasts ${reason} to both followers and fails the waiting prompt with lost`, { timeout: 10_000 }, async t => {
    const { dir, tokenFile } = await token(t);
    const { store, revoke, failNextAppend } = interruptedHistory();
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const hold = tool({ name: "hold", description: "Wait for interruption", input: { type: "object" },
      run: async (_, cx) => {
        started();
        if (!cx.cancelled.aborted) await new Promise<void>(resolve => cx.cancelled.addEventListener("abort", () => resolve(), { once: true }));
      },
    });
    const agent = await testAgent({ project: dir, dataDir: dir, durability: "kept", tools: [hold],
      plugins: [definePlugin({ name: "lease-fixture", replaces: ["history-store"], setup: r => r.historyStore(store) })],
      script: [{ toolCalls: [{ name: "hold", input: {} }] }, { text: "Recovered" }],
    });
    t.after(() => agent.close());
    const server = await agent.serveAcp({ listen: "127.0.0.1:0", actors: [
      { tokenFile, actor: { id: "local", kind: "user", rights: ["watch", "input", "tools", "settings"] } },
    ] });
    t.after(() => server.close());
    const [a, b] = await Promise.all([1, 2].map(() => connectWebSocket(server.url, tokenFile, ACP_PROTOCOL, 5000)));
    await Promise.all([a, b].map(socket => request(socket, "initialize", { protocolVersion: 1 })));
    const { sessionId } = await request(a, "session/new", { cwd: dir, mcpServers: [] });
    await request(b, "session/load", { sessionId, cwd: dir, mcpServers: [] });
    const events = [a, b].map(socket => new Promise<unknown>(resolve => {
      const handler = (bytes: Buffer) => {
        const message = JSON.parse(bytes.toString());
        if (message.method !== "_modular-agent/interrupted" || message.params?.sessionId !== sessionId) return;
        socket.off("message", handler);
        resolve({ reason: message.params.reason });
      };
      socket.on("message", handler);
    }));
    const prompt = (text: string) => request(a, "session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    const pending = assert.rejects(prompt("Start"), { code: "lost" });
    await running;
    if (reason === "writerLost") revoke(sessionId);
    else {
      failNextAppend();
      await assert.rejects(request(b, "_modular-agent/input", { sessionId, content: "Do not start", when: "after" }), { code: "lost" });
    }
    assert.deepEqual(await Promise.all(events), [{ reason }, { reason }]);
    await pending;
    await request(a, "session/resume", { sessionId, cwd: dir });
    assert.equal((await prompt("Fresh input")).stopReason, "end_turn");
  });
}

test("ACP service selects each connection's actor and enforces token scope", async t => {
  const { dir, tokenFile } = await token(t);
  const other = await token(t);
  const agent = await testAgent({ project: dir, script: [{ text: "Hi" }], tenants: { team: { rights: ["watch", "input"] } } });
  const service = await agent.serveAcp({ listen: "127.0.0.1:0", actors: [
    { tokenFile, actor: { id: "team-viewer", kind: "program", rights: ["watch", "input"] }, tenants: ["team"], projects: [dir] },
    { tokenFile: other.tokenFile, actor: { id: "visitor", kind: "user", rights: ["watch", "input"] } },
  ] });
  try {
    const a = await connectWebSocket(service.url, tokenFile, ACP_PROTOCOL, 5000);
    const b = await connectWebSocket(service.url, other.tokenFile, ACP_PROTOCOL, 5000);
    const init = { protocolVersion: 1, _meta: { "modular-agent": { actor: { id: "not-trusted" } } } };
    assert.deepEqual(await request(a, "$/ping"), {});
    assert.deepEqual((await request(a, "initialize", init))._meta["modular-agent"].actor, { id: "team-viewer", kind: "program", rights: ["watch", "input"] });
    assert.equal((await request(b, "initialize", init))._meta["modular-agent"].actor.id, "visitor");
    assert.deepEqual(await request(a, "$/ping"), {});
    await assert.rejects(request(a, "session/new", { cwd: dir, mcpServers: [] }), { code: "forbidden" });
    const team = { mcpServers: [], _meta: { "modular-agent": { tenant: "team" } } };
    await assert.rejects(request(a, "session/new", { ...team, cwd: other.dir }), { code: "forbidden" });
    const { sessionId } = await request(a, "session/new", { ...team, cwd: dir });
    await assert.rejects(request(b, "session/new", { ...team, cwd: dir }), { code: "forbidden" });
    await assert.rejects(request(b, "session/load", { sessionId, cwd: dir, mcpServers: [] }), { code: "forbidden" });
    assert.deepEqual((await request(b, "session/list")).sessions, []);
    await assert.rejects(request(b, "session/new", { cwd: dir,
      mcpServers: [{ name: "untrusted", command: "/not-executed", args: [], env: [] }] }), { code: "forbidden" });
    const own = await request(b, "session/new", { cwd: dir, mcpServers: [] });
    assert.notEqual(own.sessionId, sessionId);
    assert.equal((await request(b, "session/prompt", { sessionId: own.sessionId, prompt: [{ type: "text", text: "Yes" }] })).stopReason, "end_turn");
  } finally { await service.close(); }
});

test("ACP token rights are independent ceilings and never change recorded grants", async t => {
  const admin = await token(t), view = await token(t), noTenant = await token(t), noProject = await token(t);
  const child = join(admin.dir, "child");
  await mkdir(child);
  const history = memoryHistory();
  const agent = await testAgent({ project: admin.dir, history, script: [{ text: "Hi" }], severalActors: true });
  const actor = { id: "user", kind: "user" as const, rights: ["watch", "input", "settings"] as const };
  const service = await agent.serveAcp({ listen: "127.0.0.1:0", actors: [
    { tokenFile: admin.tokenFile, actor: { ...actor, rights: [...actor.rights] } },
    { tokenFile: view.tokenFile, actor: { ...actor, rights: ["watch"] }, tenants: [null], projects: [admin.dir] },
    { tokenFile: noTenant.tokenFile, actor: { ...actor, rights: [...actor.rights] }, tenants: [] },
    { tokenFile: noProject.tokenFile, actor: { ...actor, rights: [...actor.rights] }, projects: [] },
  ] });
  t.after(() => service.close());
  const connect = async (file: string) => {
    const ws = await connectWebSocket(service.url, file, ACP_PROTOCOL, 5000);
    await request(ws, "initialize", { protocolVersion: 1 });
    return ws;
  };
  const wide = await connect(admin.tokenFile), read = await connect(view.tokenFile);
  const location = { cwd: admin.dir, mcpServers: [] };
  const { sessionId } = await request(wide, "session/new", location);
  await assert.rejects(request(read, "session/load", { ...location, cwd: child, sessionId }), { code: "forbidden" });
  await assert.rejects(request(wide, "session/new", { ...location, cwd: child }), { code: "forbidden" });
  await assert.rejects(request(read, "session/load", { ...location, sessionId: "missing" }), { code: "forbidden" });
  await request(read, "session/load", { ...location, sessionId });
  for (const none of [noTenant, noProject]) {
    const ws = await connect(none.tokenFile);
    assert.deepEqual((await request(ws, "session/list")).sessions, []);
    await assert.rejects(request(ws, "session/load", { ...location, sessionId }), { code: "forbidden" });
  }
  const prompt = { sessionId, prompt: [{ type: "text", text: "Hello" }] };
  await assert.rejects(request(read, "session/prompt", prompt), { code: "forbidden" });
  assert.equal((await request(wide, "session/prompt", prompt)).stopReason, "end_turn");
  await service.close();
  const reopened = await testAgent({ project: admin.dir, history, script: [] });
  t.after(() => reopened.close());
  const grants = (await (await reopened.openSession(sessionId)).history()).filter(e => e.kind === "actorJoined");
  assert.equal(grants.length, 1);
  assert.match(JSON.stringify(grants[0].data), /settings/);
});

test("an ACP composition shares an open session between connections without replacing its saved settings", async t => {
  const { dir, tokenFile } = await token(t);
  const project = join(dir, "project");
  await mkdir(project);
  const history = memoryHistory();
  const agent = await testAgent({ project: dir, history, script: [] });
  const calls: string[] = [];
  const composed = await testAgent({ project, history, script: [{ text: "From the project" }] });
  t.after(() => composed.close());
  const service = await agent.serveAcp({ listen: "127.0.0.1:0", actors: [
    { tokenFile, actor: { id: "user", kind: "user", rights: ["input", "watch"] }, projects: [project] },
  ],
    compose: async (cwd, saved) => { assert.equal(saved, undefined); calls.push(cwd); return composed; },
    projectSettings: async cwd => ({ title: cwd }),
  });
  t.after(() => service.close());
  const connect = async () => {
    const ws = await connectWebSocket(service.url, tokenFile, ACP_PROTOCOL, 5000);
    await request(ws, "initialize", { protocolVersion: 1 });
    return ws;
  };
  const a = await connect(), b = await connect();
  const location = { cwd: project, mcpServers: [] };
  const { sessionId } = await request(a, "session/new", location);
  await request(b, "session/load", { ...location, sessionId });
  assert.equal((await request(b, "session/prompt", { sessionId, prompt: [{ type: "text", text: "Hello" }] })).stopReason, "end_turn");
  assert.equal((await composed.sessionInfo(sessionId)).settings.title, project);
  assert.deepEqual(calls, [project]);
});

test("a plugin service factory registers and stops a fresh instance with each connection's config", async t => {
  const { tokenFile } = await token(t);
  const stopped: string[] = [];
  const service = await serve(() => {
    let label = "unset";
    return definePlugin({ name: "scoped", stop() { stopped.push(label); }, setup(r) {
      label = String(r.config().label);
      r.tool(tool({ name: "label", description: "Instance label", input: { type: "object" }, run: () => label }));
    } });
  }, { listen: "127.0.0.1:0", tokenFile });
  t.after(() => service.close());
  const connect = (label: string) => testAgent({ script: [], servicePlugins: [{ url: service.url, tokenFile, config: { label } }] });
  const a = await connect("A"), b = await connect("B");
  try {
    assert.equal((await (await a.session()).callTool("label", {})).text(), "A");
    assert.equal((await (await b.session()).callTool("label", {})).text(), "B");
  } finally { await Promise.all([a.close(), b.close()]); }
  await service.close();
  assert.deepEqual(stopped.sort(), ["A", "B"]);
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
