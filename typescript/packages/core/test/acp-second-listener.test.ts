import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { testAgent } from "@modular-agent/core/testing";
import { ACP_PROTOCOL, connectWebSocket } from "@modular-agent/plugin-wire";

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

test("a second ACP listener on one Agent checks scope before refusing an open session with busy", { timeout: 30_000 }, async t => {
  const dir = await scratch(t);
  const project = join(dir, "project");
  await mkdir(project);
  const allowed = await token(dir, "allowed"), denied = await token(dir, "denied");
  const agent = await testAgent({ project, script: [{ text: "first reply" }, { text: "second reply" }, { text: "third reply" }] });
  t.after(() => agent.close());
  const actor = { id: "editor", kind: "user" as const, rights: ["input", "watch"] as ("input" | "watch")[] };
  const principal = (tokenFile: string, tenants: (string | null)[]) => ({ tokenFile, actor, tenants, projects: [project] });
  const first = await agent.serveAcp({ listen: "127.0.0.1:0", actors: [principal(allowed, [null])] });
  const second = await agent.serveAcp({ listen: "127.0.0.1:0", actors: [principal(allowed, [null]), principal(denied, ["another-tenant"])] });
  assert.notEqual(first.url, second.url);
  await assert.rejects(agent.serveAcp({ listen: "127.0.0.1:0", actors: [principal(allowed, [null])], projectMcp: async () => ({}) }),
    { code: "invalid_composition" });

  const sockets: Socket[] = [];
  t.after(() => { for (const ws of sockets) ws.close(); });
  const connect = async (url: string, file: string) => {
    const ws = await connectWebSocket(url, file, ACP_PROTOCOL, 5000);
    sockets.push(ws);
    await request(ws, "initialize", { protocolVersion: 1 });
    return ws;
  };
  const prompt = async (ws: Socket, sessionId: string, text: string) => {
    const reply = await request(ws, "session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    assert.equal(reply.stopReason, "end_turn");
    assert.equal(reply._meta["modular-agent"].outcome.kind, "completed");
  };

  const writer = await connect(first.url, allowed);
  const { sessionId } = await request(writer, "session/new", { cwd: project, mcpServers: [] });
  await prompt(writer, sessionId, "materialize this session");
  const params = { sessionId, cwd: project, mcpServers: [] };
  for (const method of ["session/resume", "session/load"]) {
    // Scope comes first: an out-of-scope principal learns nothing about the open session.
    await assert.rejects(request(await connect(second.url, denied), method, params), { code: "forbidden" });
    await assert.rejects(request(await connect(second.url, allowed), method, params), { code: "busy" });
  }
  // A second connection on the writer's own listener still shares the open session.
  const peer = await connect(first.url, allowed);
  await request(peer, "session/resume", params);
  await prompt(writer, sessionId, "continue");

  // Once no connection on the first listener holds the session, the other listener may open it.
  writer.close(); peer.close();
  const deadline = Date.now() + 10_000;
  let reopened: Socket | undefined;
  while (!reopened) {
    const ws = await connect(second.url, allowed);
    try { await request(ws, "session/resume", params); reopened = ws; }
    catch (error) {
      assert.equal((error as { code?: string }).code, "busy");
      if (Date.now() > deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  await prompt(reopened, sessionId, "after the first listener let go");
});
