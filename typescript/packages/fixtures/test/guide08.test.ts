import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

test("drives one ACP prompt", { timeout: 10_000 }, async t => {
  const project = await realpath(await mkdtemp(join(tmpdir(), "ma-acp-guide-")));
  t.after(() => rm(project, { recursive: true, force: true }));
  const server = `
    import { testAgent } from ${JSON.stringify(import.meta.resolve("@modular-agent/core/testing"))};
    const agent = await testAgent({
      project: process.cwd(), pluginHost: true, script: [{ text: "Hello over ACP." }],
    });
    await agent.serveAcp();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", server], {
    cwd: project, stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, MODULAR_AGENT_PLUGINS: "" },
  });
  t.after(() => { child.kill(); });
  const exited = once(child, "close");

  const chunks: string[] = [];
  const app = client({ name: "guide-client" })
    .onNotification(methods.client.session.update, ({ params: { update } }) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        chunks.push(update.content.text);
      }
    });
  const { agent } = app.connect(ndJsonStream(
    Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ));
  await agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
  const { sessionId } = await agent.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
  const reply = await agent.request(methods.agent.session.prompt, {
    sessionId, prompt: [{ type: "text", text: "Say hello." }],
  });
  assert.equal(reply.stopReason, "end_turn");
  assert.equal(chunks.join(""), "Hello over ACP.");

  child.stdin.end();
  const [code] = await exited;
  assert.equal(code, 0);
});
