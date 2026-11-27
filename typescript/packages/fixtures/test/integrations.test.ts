import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { client, methods, ndJsonStream, PROTOCOL_VERSION, type SessionNotification } from "@agentclientprotocol/sdk";
import {
  createAgent, encodeHistoryJson, fileHistory, HistoryServiceError, httpHistory, memoryHistory, parseHistoryJson, serveHistory, tool,
  type HistoryJsonObject, type HistoryReadOptions, type HistoryServiceErrorCode, type HistoryServiceStore,
} from "@modular-agent/core";
import { restart, testAgent, testResources } from "@modular-agent/core/testing";
import { openai } from "@modular-agent/openai";
import { anthropic } from "@modular-agent/anthropic";
import { fixture } from "../src/index.js";

test("guide 03 loads the tide from a fixture program", async () => {
  const node = process.execPath;
  const program = fileURLToPath(new URL("../src/bin.js", import.meta.url));
  const agent = await testAgent({
    script: [
      { toolCalls: [{ name: "tide", input: { harbour: "Whitby" } }] },
      { text: "High tide is at 14:02." },
    ],
    processPlugins: [{ command: [node, program, "tide"] }],
  });
  try {
    const turn = await (await agent.session()).prompt("When is high tide at Whitby?");
    assert.equal(turn.toolResults()[0].text(), "High tide at Whitby is 14:02.");
  } finally {
    await agent.close();
  }
});

for (const [name, provider, endpoint, credential] of [
  ["openai", openai, "/v1/responses", "OPENAI_API_KEY"],
  ["anthropic", anthropic, "/v1/messages", "ANTHROPIC_API_KEY"],
] as const) {
  test(`${name}: streams text and maps a model service refusing the key`, async t => {
    let calls = 0;
    const requests: { path?: string; key?: string; body: string }[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      requests.push({ path: req.url, key: req.headers.authorization ?? String(req.headers["x-api-key"]), body });
      const call = ++calls;
      if (call > (name === "openai" ? 2 : 1)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "authentication_error", message: "Test key rejected" } }));
        return;
      }
      const model = JSON.parse(body).model;
      const message = { type: "message", id: "msg_test", role: "assistant", content: [] };
      const emitted = name === "openai" ? [
        { type: "response.output_item.added", output_index: 0, item: message },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Test reply." },
        { type: "response.completed", response: { status: "completed", usage: call === 1 ? {
          input_tokens: 1000, output_tokens: 3, input_tokens_details: { cached_tokens: 700 },
        } : undefined } },
      ] : [
        { type: "message_start", message: { ...message, model, usage: { input_tokens: 2, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Test reply." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of emitted) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise<void>(r => server.close(() => r())));
    const prior = process.env[credential];
    process.env[credential] = "literal-fake-key";
    t.after(() => { if (prior === undefined) delete process.env[credential]; else process.env[credential] = prior; });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}${name === "openai" ? "/v1" : ""}`;
    const p = provider({ baseUrl });
    assert.ok(p.models().length > 0);
    const project = await mkdtemp(join(tmpdir(), "ma-provider-"));
    t.after(() => rm(project, { recursive: true, force: true }));
    const a = await createAgent({ providers: [p], model: p.models()[0], project });
    t.after(() => a.close());
    const s = await a.session();
    const deltas: string[] = [];
    for await (const e of s.promptStream("Test")) if (e.type === "text") deltas.push(e.data.delta);
    assert.deepEqual(deltas, ["Test reply."]);
    assert.equal((await s.lastTurn())?.text, "Test reply.");
    if (name === "openai") {
      const reply = (await s.history()).findLast(e => e.kind === "response")?.message;
      assert.equal(reply?.role, "assistant");
      assert.equal(reply.usage?.input, 300);
      assert.equal(reply.usage?.cacheRead, 700);
      assert.equal((await s.prompt("Without usage")).text, "Test reply.");
      const unmetered = (await s.history()).findLast(e => e.kind === "response")?.message;
      assert.equal(unmetered?.role, "assistant");
      assert.equal(unmetered.usage, undefined);
    }
    assert.equal((await s.prompt("Fail")).outcome?.kind, "failed");
    const message = (await s.history()).findLast(e => e.kind === "response")?.message;
    assert.equal(message?.role, "assistant");
    assert.equal(message.stop, "failed");
    assert.equal(message.error?.kind, "credentials");
    assert.equal(requests[0].path?.split("?")[0], endpoint);
    assert.equal(requests[0].key, name === "openai" ? "Bearer literal-fake-key" : "literal-fake-key");
  });
}

test("ACP serves an SDK agent on stdio", { timeout: 5_000 }, async t => {
  const start = testResources(t);
  const project = await start(() => mkdtemp(join(tmpdir(), "ma-acp-")), project => rm(project, { recursive: true, force: true }));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/acp-agent.js", import.meta.url))],
    { cwd: project, stdio: ["pipe", "pipe", "inherit"] });
  const done = once(child, "close");
  t.after(async () => { child.kill(); await done; });
  const updates: SessionNotification[] = [];
  const app = client({ name: "sdk-client" }).onNotification(methods.client.session.update, ({ params }) => { updates.push(params); });
  const cx = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>)).agent;
  await cx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  const { sessionId } = await cx.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
  const reply = await cx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "Hello." }] });
  assert.equal(reply.stopReason, "end_turn");
  assert.ok(updates.some(({ update }) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && update.content.text === "Hi over ACP."));
  child.stdin.end();
  await done;
});

test("ACP resume returns while recovered work waits for the client's answer", { timeout: 10_000 }, async t => {
  const start = testResources(t);
  const project = await start(() => mkdtemp(join(tmpdir(), "ma-acp-recover-")), project => rm(project, { recursive: true, force: true }));
  const dataDir = join(project, "state");
  let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const hold = tool({ name: "hold", description: "Wait until interrupted", input: { type: "object" }, async run(_, cx) {
    started();
    await delay(30_000, undefined, { signal: cx.cancelled });
  } });
  const first = await start(() => testAgent({ project, dataDir, durability: "durable", tools: [hold],
    plugins: [fixture("confirm")], script: [{ toolCalls: [{ name: "hold", input: {} }] }] }), agent => agent.close());
  const session = await first.session();
  const interrupted = assert.rejects(session.prompt("Before crash"), { code: "lost" });
  await ready;
  const restarted = await start(() => restart(first), agent => agent.close());
  await restarted.close();
  await interrupted;

  t.signal.throwIfAborted();
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/acp-agent.js", import.meta.url)), dataDir],
    { cwd: project, stdio: ["pipe", "pipe", "inherit"] });
  const closed = once(child, "close");
  t.after(async () => { child.kill(); await closed; });
  const updates: SessionNotification[] = [];
  const app = client({ name: "sdk-client" }).onNotification(methods.client.session.update, ({ params }) => { updates.push(params); });
  const cx = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>)).agent;
  await cx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  const sessionId = session.id;
  await cx.request(methods.agent.session.resume, { sessionId, cwd: project, mcpServers: [] });
  const ext = cx.request.bind(cx) as (method: string, params: object) => Promise<unknown>;
  let question: { id: string; question: string; answerable: boolean } | undefined;
  for (let i = 0; i < 100 && !question; i++) {
    const { requests } = await ext("_modular-agent/requests", { sessionId }) as { requests: NonNullable<typeof question>[] };
    question = requests[0];
    if (!question) await delay(20);
  }
  assert.equal(question?.question, "Recover?");
  assert.equal(question.answerable, true);
  await ext("_modular-agent/answer", { sessionId, requestId: question.id, value: "yes" });
  const reply = await cx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "Continue" }] });
  assert.equal(reply.stopReason, "end_turn");
  assert.ok(updates.some(({ update }) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && update.content.text === "Fresh turn."));
  child.stdin.end();
  await closed;
});

test("setup-discovered in-process registration answers initialize with not_supported", { timeout: 5_000 }, async t => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { definePlugin, serve, tool } from "@modular-agent/core";
    try {
      await serve(definePlugin({ name: "configured", setup(r) {
        if (r.config().enabled) r.tool(tool({ name: "local", description: "Local", input: { type: "object" }, inProcessOnly: true, run() {} }));
      } }));
    } catch { process.exitCode = 1; }
  `], { stdio: ["pipe", "pipe", "inherit"] });
  const closed = once(child, "close");
  t.after(async () => { child.kill(); await closed; });
  const lines = createInterface({ input: child.stdout });
  const reply = once(lines, "line");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "plugin/initialize", params: {
    binding: "modular-agent-plugin/1", project: process.cwd(), home: tmpdir(), config: { enabled: true },
  } }) + "\n");
  const [line] = await reply;
  assert.deepEqual(JSON.parse(line), { jsonrpc: "2.0", id: 1, error: {
    code: -32000, message: "configured: cannot serve tool local", data: { code: "not_supported" },
  } });
  child.stdin.end();
  assert.deepEqual(await closed, [1, null]);
});

test("a kept session reopens over the history HTTP binding", { timeout: 10_000 }, async t => {
  const start = testResources(t);
  const dir = await start(() => mkdtemp(join(tmpdir(), "ma-http-")), dir => rm(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, "token");
  await writeFile(tokenFile, "literal-fake-history-token\n", { mode: 0o600 });
  const service = await start(
    () => serveHistory(fileHistory(join(dir, "service")), { address: "127.0.0.1:0", tokenFile }),
    service => service.close(),
  );
  const history = httpHistory(service.url, tokenFile);
  const script = [{ text: "First." }, { text: "Still here." }];
  const a = await start(() => testAgent({ script, durability: "kept", history }), agent => agent.close());
  const s = await a.session();
  assert.equal((await s.prompt("First")).text, "First.");
  await a.close();
  const b = await start(() => testAgent({ script, durability: "kept", history }), agent => agent.close());
  const reopened = await b.openSession(s.id);
  assert.equal((await reopened.lastTurn())?.text, "First.");
  assert.equal((await reopened.prompt("Second")).text, "Still here.");
});

// A custom backend with its durable records and leases kept by a separate archive.
// Use the SDK's lossless codec on both sides, not a byte-forwarding HTTP relay.
async function customHistory(url: string, token: string, signal: AbortSignal): Promise<HistoryServiceStore> {
  const call = async (path: string, method = "GET", body?: string): Promise<string> => {
    const response = await fetch(`${url}/v1${path}`, { method, body, signal, headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json",
    } });
    const raw = await response.text();
    if (!response.ok) {
      const data = JSON.parse(raw) as { code: HistoryServiceErrorCode; error: string; retryAfterMs?: number };
      throw new HistoryServiceError(data.code, data.error, data.retryAfterMs);
    }
    return raw;
  };
  const at = (id: string) => `/sessions/${encodeURIComponent(id)}`;
  const query = ({ limit, after, project }: HistoryReadOptions & { project?: string }) => `?limit=${limit}` +
    (after === undefined ? "" : `&after=${encodeURIComponent(after)}`) +
    (project === undefined ? "" : `&project=${encodeURIComponent(project)}`);
  return {
    ttlMs: JSON.parse(await call("")).ttlMs,
    async create(id, metadata) {
      await call(at(id), "PUT", encodeHistoryJson(metadata));
      if (id === "committed-without-reply") throw new Error("Commit acknowledgement was lost");
    },
    async list(q) { return parseHistoryJson(await call(`/sessions${query(q)}`)) as unknown as Awaited<ReturnType<HistoryServiceStore["list"]>>; },
    async read(id, q) { return parseHistoryJson(await call(at(id) + query(q))) as unknown as Awaited<ReturnType<HistoryServiceStore["read"]>>; },
    async acquire(id, owner) { return JSON.parse(await call(`${at(id)}/lease`, "POST", JSON.stringify({ owner }))).lease; },
    async renew(id, lease) { await call(`${at(id)}/lease/${encodeURIComponent(lease)}/renew`, "POST"); },
    async release(id, lease) { await call(`${at(id)}/lease/${encodeURIComponent(lease)}`, "DELETE"); },
    async append(id, lease, entries) {
      const body: HistoryJsonObject = { lease, entries };
      return JSON.parse(await call(`${at(id)}/entries`, "POST", encodeHistoryJson(body))).kept;
    },
    async erase(id, entryIds, lease) { return JSON.parse(await call(`${at(id)}/erase`, "POST", JSON.stringify({ entryIds, lease }))).erased; },
  };
}

for (const placement of ["file", "memory", "relay", "custom"] as const) {
  test(`SDK ${placement} history passes the history binding kit`, { timeout: 60_000 }, async t => {
    const start = testResources(t);
    const dir = await start(() => mkdtemp(join(tmpdir(), "ma-sdk-history-")), dir => rm(dir, { recursive: true, force: true }));
    const tokenFile = join(dir, "token");
    const token = randomBytes(32).toString("hex");
    await writeFile(tokenFile, token + "\n", { mode: 0o600 });
    const options = { address: "127.0.0.1:0", tokenFile };
    const store = placement === "memory" ? memoryHistory() : fileHistory(join(dir, "archive"));
    // The kit waits for a lease to expire and also appends a large batch.
    const direct = await start(() => serveHistory(store, { ...options, leaseTtl: 5_000, testOnly: placement === "memory" }),
      service => service.close());
    let relay: Awaited<ReturnType<typeof serveHistory>> | undefined;
    if (placement === "relay") relay = await start(() => serveHistory(httpHistory(direct.url, tokenFile), options), service => service.close());
    if (placement === "custom") {
      const upstream = await customHistory(direct.url, token, t.signal);
      relay = await start(() => serveHistory(upstream, options), service => service.close());
      const path = `${relay.url}/v1/sessions/committed-without-reply`;
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const signal = t.signal;
      await assert.rejects(fetch(path, { method: "PUT", headers, signal, body: '{"project":"/precise","created":0,"extra":9007199254740993}' }));
      const kept = await fetch(path, { headers, signal });
      assert.equal(kept.status, 200);
      assert.match(await kept.text(), /"extra":9007199254740993/);
    }
    const kit = fileURLToPath(new URL("../../../../../conformance/history/run.mjs", import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [kit, (relay ?? direct).url, tokenFile], { timeout: 52_000 }).catch((error: unknown) => {
      if (error instanceof Error && "stdout" in error && typeof error.stdout === "string") {
        assert.fail(`${error.message}\n${error.stdout}`);
      }
      throw error;
    });
    t.diagnostic(stdout.trim().split("\n").at(-1)!);
    assert.match(stdout, /\d+\/\d+ checks passed/);
  });
}

test("serving a memory history handle exposes its existing records, without bypassing its local writer", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ma-sdk-history-"));
  const tokenFile = join(dir, "token");
  const token = randomBytes(32).toString("hex");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const history = memoryHistory();
  await assert.rejects(serveHistory({} as typeof history, { address: "127.0.0.1:0", tokenFile }), { code: "not_supported" });
  const a = await testAgent({ history, script: [{ text: "From local history" }] });
  const local = await a.session();
  await local.prompt("First");
  await assert.rejects(serveHistory(history, { address: "127.0.0.1:0", tokenFile }), { code: "not_supported", message: /MemoryHistory/ });
  const service = await serveHistory(history, { address: "127.0.0.1:0", tokenFile, testOnly: true });
  t.after(async () => { await a.close(); await service.close(); await rm(dir, { recursive: true, force: true }); });
  const reader = await testAgent({ durability: "kept", dataDir: dir, history: httpHistory(service.url, tokenFile), script: [] });
  t.after(() => reader.close());
  assert.equal(reader.declaration().erasure, false, "a volatile service cannot declare a durable registry");
  assert.ok((await reader.sessions()).some(s => s.id === local.id));
  const acquire = await fetch(new URL(`/v1/sessions/${local.id}/lease`, service.url), {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ owner: "another writer" }),
  });
  assert.equal(acquire.status, 409);
  assert.equal((await acquire.json() as { code?: string }).code, "held");
  await a.close();
  const fromWire = await reader.openSession(local.id);
  assert.equal((await fromWire.lastTurn())?.text, "From local history");
});
