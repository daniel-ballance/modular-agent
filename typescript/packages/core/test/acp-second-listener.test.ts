import assert from "node:assert/strict";
import { Server, type AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { definePlugin, type Actor } from "@modular-agent/core";
import { testAgent } from "@modular-agent/core/testing";
import { ACP_PROTOCOL, connectWebSocket } from "@modular-agent/plugin-wire";
import { JsonlHistoryStore } from "@modular-agent/history-jsonl";

type Socket = Awaited<ReturnType<typeof connectWebSocket>>;
let nextRequest = 1;

async function scratch(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "sdk-acp-listeners-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function token(dir: string, name: string) {
  const file = join(dir, name);
  await writeFile(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  return file;
}

function request(socket: Socket, method: string, params: unknown = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextRequest++;
    const cleanup = () => {
      socket.off("message", listener);
      socket.off("close", closed);
    };
    const closed = () => { cleanup(); reject(new Error("ACP socket closed")); };
    const listener = (bytes: Buffer) => {
      const response = JSON.parse(bytes.toString());
      if (response.id !== id) return;
      cleanup();
      if (response.error) reject(response.error.data ?? response.error);
      else resolve(response.result);
    };
    socket.on("message", listener);
    socket.once("close", closed);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

const listen = "127.0.0.1:0";
const actor: Actor = { id: "editor", kind: "user", rights: ["input", "watch"] };
const methods = ["session/resume", "session/load"];
const mcpServers = [{ name: "test", command: process.execPath, args: [], env: [] }];
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

async function connect(t: TestContext, url: string, file: string) {
  const ws = await connectWebSocket(url, file, ACP_PROTOCOL, 5000);
  t.after(() => ws.close());
  await request(ws, "initialize", { protocolVersion: 1 });
  return ws;
}

async function prompt(ws: Socket, sessionId: string, text: string) {
  const reply = await request(ws, "session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  assert.equal(reply.stopReason, "end_turn");
  assert.equal(reply._meta["modular-agent"].outcome.kind, "completed");
}

test("a second ACP listener on one Agent checks scope before refusing an open session with busy", { timeout: 30_000 }, async t => {
  const dir = await scratch(t);
  const project = join(dir, "project");
  await mkdir(project);
  const allowed = await token(dir, "allowed"), denied = await token(dir, "denied");
  const agent = await testAgent({ project, script: [{ text: "first reply" }, { text: "second reply" }, { text: "third reply" }] });
  t.after(() => agent.close());
  const principal = (tokenFile: string, tenants: (string | null)[]) => ({ tokenFile, actor, tenants, projects: [project] });
  const first = await agent.serveAcp({ listen: "127.0.0.1:0", actors: [principal(allowed, [null])] });
  const second = await agent.serveAcp({ listen, hostMcpServers: true, actors: [principal(allowed, [null]), principal(denied, ["another-tenant"])] });
  const third = await agent.serveAcp({ listen: "127.0.0.1:0", actors: [principal(allowed, [null])] });
  assert.equal(new Set([first.url, second.url, third.url]).size, 3);
  await assert.rejects(agent.serveAcp({ listen: "127.0.0.1:0", actors: [principal(allowed, [null])], projectMcp: async () => ({}) }),
    { code: "invalid_composition" });

  const writer = await connect(t, first.url, allowed);
  const { sessionId } = await request(writer, "session/new", { cwd: project, mcpServers: [] });
  await prompt(writer, sessionId, "materialize this session");
  const params = { sessionId, cwd: project, mcpServers: [] };
  const outsider = await connect(t, second.url, denied);
  const contender = await connect(t, second.url, allowed);
  for (const method of methods) {
    // Scope and the supplied MCP policy take precedence over listener conflicts.
    await assert.rejects(request(outsider, method, params), { code: "forbidden" });
    await assert.rejects(request(contender, method, { ...params, mcpServers }), { code: "forbidden" });
    await assert.rejects(request(contender, method, params), { code: "busy" });
  }
  // A second connection on the writer's own listener still shares the open session.
  const peer = await connect(t, first.url, allowed);
  await request(peer, "session/resume", params);
  await prompt(writer, sessionId, "continue");

  // Once no connection on the first listener holds the session, another listener may open it.
  // Two listeners racing for it: exactly one opens, the other gets busy.
  writer.close(); peer.close();
  const deadline = Date.now() + 10_000;
  let reopened: Socket | undefined;
  while (!reopened) {
    const racers = await Promise.all([connect(t, second.url, allowed), connect(t, third.url, allowed)]);
    const results = await Promise.allSettled(racers.map(ws => request(ws, "session/resume", params)));
    for (const r of results) if (r.status === "rejected") assert.equal((r.reason as { code?: string }).code, "busy");
    const won = results.flatMap((r, i) => r.status === "fulfilled" ? [racers[i]] : []);
    assert.ok(won.length <= 1, "both listeners opened the session");
    if (won.length) { reopened = won[0]; break; }
    assert.ok(Date.now() < deadline, "the first listener never let go of the session");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await prompt(reopened, sessionId, "after the first listener let go");
});

test("ACP close releases the writer claim and detaches every view on that listener", { timeout: 15_000 }, async t => {
  const project = await scratch(t), tokenFile = await token(project, "token");
  const ending = deferred<void>(), complete = deferred<void>();
  t.after(() => complete.resolve());
  const plugin = definePlugin({ name: "hold-close", hooks: { "session.end": async () => {
    ending.resolve();
    await complete.promise;
  } } });
  const agent = await testAgent({ project, dataDir: project, durability: "kept", script: [{ text: "one" }, { text: "two" }], plugins: [plugin] });
  t.after(() => agent.close());
  const actors = [{ tokenFile, actor }];
  const first = await agent.serveAcp({ listen, actors }), second = await agent.serveAcp({ listen, actors });
  const [writer, peer, contender] = await Promise.all([connect(t, first.url, tokenFile), connect(t, first.url, tokenFile), connect(t, second.url, tokenFile)]);
  const { sessionId } = await request(writer, "session/new", { cwd: project, mcpServers: [] });
  await prompt(writer, sessionId, "keep the session");
  const params = { sessionId, cwd: project, mcpServers: [] };
  await request(peer, "session/resume", params);

  const closing = request(writer, "session/close", { sessionId });
  await ending.promise;
  for (const method of methods) await assert.rejects(request(contender, method, params), { code: "busy" });
  complete.resolve();
  await closing;

  await request(contender, "session/load", params);
  for (const ws of [writer, peer]) {
    await assert.rejects(request(ws, "session/close", { sessionId }), { code: "not_open" });
    await assert.rejects(request(ws, "session/resume", params), { code: "busy" });
  }
  await prompt(contender, sessionId, "continue on the next listener");
});

for (const [hook, disconnect] of [["session.prepare", false], ["session.start", false], ["session.start", true]] as const) {
  test(`ACP reserves a new session during ${hook}${disconnect ? " until the client disconnects" : ""}`, { timeout: 15_000 }, async t => {
    const project = await scratch(t), tokenFile = await token(project, "token");
    const creating = deferred<string>(), proceed = deferred<void>();
    t.after(() => proceed.resolve());
    const plugin = definePlugin({ name: "hold-create", setup(r) {
      r.on(hook, async ({ sessionId, resumed }) => {
        if (resumed) return;
        creating.resolve(sessionId);
        await proceed.promise;
      });
    } });
    const agent = await testAgent({ project, script: [{ text: "ready" }], plugins: [plugin] });
    t.after(() => agent.close());
    const actors = [{ tokenFile, actor }];
    const first = await agent.serveAcp({ listen, actors }), second = await agent.serveAcp({ listen, actors });
    const [writer, peer, contender] = await Promise.all([connect(t, first.url, tokenFile), connect(t, first.url, tokenFile), connect(t, second.url, tokenFile)]);
    const creatingRequest = request(writer, "session/new", { cwd: project, mcpServers: [] });
    const aborted = disconnect ? assert.rejects(creatingRequest, /ACP socket closed/) : undefined;
    const sessionId = await creating.promise;
    const params = { sessionId, cwd: project, mcpServers: [] };
    for (const ws of [peer, contender]) {
      for (const method of methods) await assert.rejects(request(ws, method, params), { code: "busy" });
    }
    if (disconnect) {
      writer.close();
      await aborted;
      await request(contender, "session/resume", params);
      proceed.resolve();
      await assert.rejects(request(peer, "session/resume", params), { code: "busy" });
      await prompt(contender, sessionId, "after the creator disconnected");
    } else {
      proceed.resolve();
      assert.equal((await creatingRequest).sessionId, sessionId);
      await request(peer, "session/resume", params);
      await assert.rejects(request(contender, "session/resume", params), { code: "busy" });
      await prompt(writer, sessionId, "after creation");
    }
  });
}

test("a blocked ACP load releases its provisional claim on a connected socket", { timeout: 15_000 }, async t => {
  const project = await scratch(t), tokenFile = await token(project, "token");
  const outside = join(project, "outside");
  await mkdir(outside);
  const authorizing = deferred<void>(), proceed = deferred<void>();
  t.after(() => proceed.resolve());
  const load = JsonlHistoryStore.prototype.load;
  let pauseLoad = false;
  t.mock.method(JsonlHistoryStore.prototype, "load", async function (this: JsonlHistoryStore, id: string) {
    if (pauseLoad) {
      pauseLoad = false;
      authorizing.resolve();
      await proceed.promise;
    }
    return load.call(this, id);
  });
  let blockLoad = false;
  const plugin = definePlugin({ name: "block-next-load", hooks: { output: ({ events }) => {
    if (blockLoad && events.some(event => event.type === "reply" && (event.data as { method?: string } | undefined)?.method === "session/load")) {
      blockLoad = false;
      return "block";
    }
  } } });
  const agent = await testAgent({ project, dataDir: project, durability: "kept", script: [{ text: "one" }, { text: "two" }], plugins: [plugin] });
  t.after(() => agent.close());
  const actors = [{ tokenFile, actor }];
  const first = await agent.serveAcp({ listen, actors }), second = await agent.serveAcp({ listen, actors });
  const [writer, contender] = await Promise.all([connect(t, first.url, tokenFile), connect(t, second.url, tokenFile)]);
  const { sessionId } = await request(writer, "session/new", { cwd: project, mcpServers: [] });
  await prompt(writer, sessionId, "keep this");
  await request(writer, "session/close", { sessionId });

  const params = { sessionId, cwd: project, mcpServers: [] };
  // A new request on a previously attached socket cannot claim the writer while scope checks are pending.
  pauseLoad = true;
  const wrongProject = assert.rejects(request(writer, "session/resume", { ...params, cwd: outside }), { code: "forbidden" });
  await authorizing.promise;
  await request(contender, "session/resume", params);
  proceed.resolve();
  await wrongProject;
  await request(contender, "session/close", { sessionId });

  blockLoad = true;
  await assert.rejects(request(writer, "session/load", params), { code: "withheld" });
  await request(contender, "session/resume", params);
  await assert.rejects(request(writer, "session/resume", params), { code: "busy" });
  await prompt(contender, sessionId, "after the failed load");
});

test("all supplied MCP specifications are checked before a cross-listener ACP refusal", { timeout: 15_000 }, async t => {
  const project = await scratch(t), tokenFile = await token(project, "token");
  const elevated: Actor = { ...actor, rights: [...actor.rights, "tools", "administer"] };
  const actors = [{ tokenFile, actor: elevated }];
  const agent = await testAgent({ project, sessionLimits: true, script: [] });
  t.after(() => agent.close());
  const first = await agent.serveAcp({ listen, actors, hostMcpServers: true });
  const second = await agent.serveAcp({ listen, actors, hostMcpServers: true });
  const noHostMcp = await agent.serveAcp({ listen, actors, hostMcpServers: false });
  const [writer, contender, denied] = await Promise.all([
    connect(t, first.url, tokenFile), connect(t, second.url, tokenFile), connect(t, noHostMcp.url, tokenFile),
  ]);
  const { sessionId } = await request(writer, "session/new", { cwd: project, mcpServers: [] });
  const params = { sessionId, cwd: project };
  for (const method of methods) {
    await assert.rejects(request(denied, method, { ...params, mcpServers }), { code: "forbidden" });
    const malformed = [{ ...mcpServers[0], command: "relative-command" }];
    await assert.rejects(request(contender, method, { ...params, mcpServers: malformed }), { code: "invalid_params" });
    await assert.rejects(request(contender, method, { ...params, mcpServers }), { code: "busy" });
  }
  await request(writer, "_modular-agent/limit", { sessionId, rights: actor.rights });
  for (const method of methods) {
    await assert.rejects(request(contender, method, { ...params, mcpServers }), { code: "forbidden" });
    await assert.rejects(request(contender, method, { ...params, mcpServers: [] }), { code: "busy" });
  }
});

test("ACP releases a new session's claim when preparation fails after authorization", { timeout: 15_000 }, async t => {
  const project = await scratch(t), tokenFile = await token(project, "token");
  const elevated: Actor = { ...actor, rights: [...actor.rights, "tools", "administer"] };
  const preparing = deferred<string>(), proceed = deferred<void>();
  t.after(() => proceed.resolve());
  let prepareFirst = true;
  const plugin = definePlugin({ name: "pause-tenant-prepare", setup(r) {
    r.on("session.prepare", async ({ sessionId }) => {
      if (!prepareFirst) return;
      prepareFirst = false;
      preparing.resolve(sessionId);
      await proceed.promise;
    });
  } });
  const agent = await testAgent({ project, durability: "ephemeral", tenants: { limited: { rights: actor.rights } }, script: [], plugins: [plugin] });
  t.after(() => agent.close());
  const options = { listen, actors: [{ tokenFile, actor: elevated, tenants: ["limited", null] }], hostMcpServers: true };
  const first = await agent.serveAcp(options), second = await agent.serveAcp(options);
  const [writer, contender] = await Promise.all([connect(t, first.url, tokenFile), connect(t, second.url, tokenFile)]);
  const failed = assert.rejects(request(writer, "session/new", { cwd: project, mcpServers, _meta: { "modular-agent": { tenant: "limited" } } }), { code: "forbidden" });
  const sessionId = await preparing.promise;
  await assert.rejects(request(contender, "session/resume", { sessionId, cwd: project, mcpServers: [] }), { code: "busy" });
  proceed.resolve();
  await failed;
  const params = { sessionId, cwd: project, mcpServers: [] };
  await request(contender, "session/resume", params);
  await assert.rejects(request(writer, "session/resume", params), { code: "busy" });
  const next = await request(writer, "session/new", { cwd: project, mcpServers: [] });
  assert.notEqual(next.sessionId, sessionId);
});

for (const otherListener of [false, true]) {
  test(`Agent close prevents a pending ${otherListener ? "second" : "first"} ACP listener from starting`, { timeout: 15_000 }, async t => {
    const project = await scratch(t), tokenFile = await token(project, "token");
    const agent = await testAgent({ project, script: [] });
    t.after(() => agent.close());
    const options = { listen, actors: [{ tokenFile, actor }] };
    const first = otherListener ? await agent.serveAcp(options) : undefined;
    const bound = deferred<string>(), release = deferred<void>();
    t.after(() => release.resolve());
    const original = Server.prototype.listen;
    const delayed = t.mock.method(Server.prototype, "listen", function (this: Server, port: number, host: string, ready: () => void) {
      return Reflect.apply(original, this, [port, host, () => {
        bound.resolve(`ws://127.0.0.1:${(this.address() as AddressInfo).port}/`);
        void release.promise.then(ready);
      }]);
    });
    const starting = agent.serveAcp(options);
    const refused = assert.rejects(starting, { code: "invalid_composition", message: "Agent is closed" });
    const pendingUrl = await bound.promise;
    delayed.mock.restore();
    const closing = first ? first.close() : agent.close();
    await assert.rejects(connectWebSocket(pendingUrl, tokenFile, ACP_PROTOCOL, 5000));
    await Promise.all([closing, refused]);
    release.resolve();
    await release.promise;
    for (const url of [pendingUrl, ...(first ? [first.url] : [])]) {
      await assert.rejects(connectWebSocket(url, tokenFile, ACP_PROTOCOL, 5000));
    }
    await assert.rejects(agent.serveAcp(options), { code: "not_open" });
  });
}
