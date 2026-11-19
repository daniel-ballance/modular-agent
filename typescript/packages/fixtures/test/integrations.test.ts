import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { client, methods, ndJsonStream, PROTOCOL_VERSION, type SessionNotification } from "@agentclientprotocol/sdk";
import { createAgent, fileHistory, httpHistory, memoryHistory, serveHistory } from "@modular-agent/core";
import { testAgent } from "@modular-agent/core/testing";
import { openai } from "@modular-agent/openai";
import { anthropic } from "@modular-agent/anthropic";

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
      if (calls++) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "authentication_error", message: "Test key rejected" } }));
        return;
      }
      const model = JSON.parse(body).model;
      const message = { type: "message", id: "msg_test", role: "assistant", content: [] };
      const emitted = name === "openai" ? [
        { type: "response.output_item.added", output_index: 0, item: message },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Test reply." },
        { type: "response.completed", response: { status: "completed", usage: { input_tokens: 2, output_tokens: 3 } } },
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
  const project = await mkdtemp(join(tmpdir(), "ma-acp-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/acp-agent.js", import.meta.url))],
    { cwd: project, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => { child.kill(); });
  const updates: SessionNotification[] = [];
  const app = client({ name: "sdk-client" }).onNotification(methods.client.session.update, ({ params }) => { updates.push(params); });
  const cx = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>)).agent;
  await cx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  const { sessionId } = await cx.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
  const reply = await cx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "Hello." }] });
  assert.equal(reply.stopReason, "end_turn");
  assert.ok(updates.some(({ update }) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && update.content.text === "Hi over ACP."));
  const done = once(child, "close");
  child.stdin.end();
  await done;
});

test("a kept session reopens over the history HTTP binding", { timeout: 10_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "ma-http-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, "token");
  await writeFile(tokenFile, "literal-fake-history-token\n", { mode: 0o600 });
  const service = await serveHistory(fileHistory(join(dir, "service")), { address: "127.0.0.1:0", tokenFile });
  t.after(() => service.close());
  const history = httpHistory(service.url, tokenFile);
  const script = [{ text: "First." }, { text: "Still here." }];
  const a = await testAgent({ script, durability: "kept", history });
  t.after(() => a.close());
  const s = await a.session();
  assert.equal((await s.prompt("First")).text, "First.");
  await a.close();
  const b = await testAgent({ script, durability: "kept", history });
  t.after(() => b.close());
  const reopened = await b.openSession(s.id);
  assert.equal((await reopened.lastTurn())?.text, "First.");
  assert.equal((await reopened.prompt("Second")).text, "Still here.");
});

for (const placement of ["file", "memory", "relay"] as const) {
  test(`SDK ${placement} history passes the history binding kit`, { timeout: 60_000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), "ma-sdk-history-"));
    const tokenFile = join(dir, "token");
    await writeFile(tokenFile, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
    const options = { address: "127.0.0.1:0", tokenFile };
    const store = placement === "file" ? fileHistory(join(dir, "archive")) : memoryHistory();
    const direct = await serveHistory(store, options);
    let relay: Awaited<ReturnType<typeof serveHistory>> | undefined;
    t.after(async () => { await relay?.close(); await direct.close(); await rm(dir, { recursive: true, force: true }); });
    if (placement === "relay") relay = await serveHistory(httpHistory(direct.url, tokenFile), options);
    const kit = fileURLToPath(new URL("../../../../../conformance/history/run.mjs", import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [kit, (relay ?? direct).url, tokenFile], { timeout: 52_000 });
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
  const service = await serveHistory(history, { address: "127.0.0.1:0", tokenFile });
  t.after(async () => { await a.close(); await service.close(); await rm(dir, { recursive: true, force: true }); });
  const reader = await testAgent({ history: httpHistory(service.url, tokenFile), script: [] });
  t.after(() => reader.close());
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
