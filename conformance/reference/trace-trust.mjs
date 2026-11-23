import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { startReceiver } from "../telemetry/receiver.mjs";

const actor = { id: "desk", kind: "host", rights: ["watch", "input"] };
const traceId = "bb0d8cb2f62649d48ee0bc98cf631eef";
const traceparent = `00-${traceId}-a172caab9c83c91f-01`;

// Compare the invocation for this session, not an arbitrary span in the batch.
async function checkInvocation(receiver, session, trusted) {
  const attr = (s, key) => s.attributes?.find(a => a.key === key)?.value?.stringValue;
  const matches = s => attr(s, "gen_ai.operation.name") === "invoke_agent" && attr(s, "gen_ai.conversation.id") === session;
  const { spans } = await receiver.waitFor(spans => spans.some(matches), { timeoutMs: 15_000 });
  for (const span of spans.filter(matches)) {
    assert.match(span.traceId, /^(?!0{32}$)[0-9a-f]{32}$/);
    assert.equal(span.traceId === traceId, trusted, `session ${session}: trace trust should be ${trusted}, got ${span.traceId}`);
  }
}

export async function checkTraceTrust(command, t, environment) {
  const policy = join(t.dir, "operator.json");
  const tokens = [randomBytes(24).toString("hex"), randomBytes(24).toString("hex")];
  const actors = tokens.map((token, i) => {
    const tokenFile = `actor-${i}.token`;
    writeFileSync(join(t.dir, tokenFile), token, { mode: 0o600 });
    return { actor, tokenFile, clientId: `client-${i}`, ...(i === 0 && { traceTrusted: true }) };
  });
  const receiver = await startReceiver();
  const env = { ...environment, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: receiver.endpoint,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf", OTEL_TRACES_SAMPLER: "always_on", OTEL_BSP_SCHEDULE_DELAY: "100" };
  async function serve(flags, settings, work) {
    writeFileSync(policy, JSON.stringify(settings), { mode: 0o600 });
    const child = spawn(command[0], [...command.slice(1), ...flags, "--policy", policy], {
      cwd: t.project, env, stdio: ["pipe", "pipe", "pipe"], detached: true,
    });
    let stderr = "";
    child.stderr.on("data", data => { stderr += data; });
    const closed = once(child, "close");
    const lines = createInterface({ input: child.stdout });
    const replies = lines[Symbol.asyncIterator]();
    const signal = AbortSignal.timeout(30_000);
    try {
      await Promise.race([work(child, replies, signal), closed.then(() => { throw Error(`ma exited: ${stderr.trim()}`); }),
        once(signal, "abort").then(() => { throw Error("ma trace trust check timed out"); })]);
    } finally {
      lines.close();
      if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
      await closed;
    }
  }
  try {
    await serve(["--agui", "--listen", "127.0.0.1:0"], { actors }, async (_, lines, signal) => {
      const { value: origin } = await lines.next();
      if (!origin) throw Error("ma did not print its AG-UI listener");
      assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+\/?$/);
      for (const [i, token] of tokens.entries()) {
        const post = (path, body, headers = {}) => fetch(new URL(`/agui/v1/${path}`, origin), {
          signal, redirect: "error", method: "POST", body: JSON.stringify(body),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
        });
        const created = await post("threads", {});
        assert.equal(created.status, 201);
        const { threadId } = await created.json();
        const response = await post("run", { protocolVersion: "1.0", runId: randomUUID(), threadId,
          messages: [{ id: randomUUID(), role: "user", content: "Hello" }], tools: [], context: [], state: {}, forwardedProps: {},
        }, { traceparent, accept: "text/event-stream" });
        assert.equal(response.status, 200);
        assert.match(await response.text(), /RUN_FINISHED/);
        await checkInvocation(receiver, threadId, i === 0);
      }
    });
    for (const trusted of [true, false]) {
      await serve(["--acp"], { stdio: { actor, ...(!trusted && { traceTrusted: false }) } }, async (child, lines) => {
        let id = 0;
        async function request(method, params) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) + "\n");
          for (;;) {
            const line = await lines.next();
            assert(!line.done, `ACP disconnected during ${method}`);
            const msg = JSON.parse(line.value);
            if (msg.id !== id) continue;
            assert.equal(msg.error, undefined, JSON.stringify(msg.error));
            return msg.result;
          }
        }
        await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
        const { sessionId } = await request("session/new", { cwd: t.project, mcpServers: [] });
        await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Hello" }], _meta: { traceparent } });
        await checkInvocation(receiver, sessionId, trusted);
      });
    }
  } finally { await receiver.close(); }
}

// The language suites run the same wire test against their own CLI build.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = mkdtempSync(join(tmpdir(), "ma-trace-trust-"));
  try {
    const project = join(dir, "project"), home = join(dir, "home"), script = join(dir, "script.json");
    mkdirSync(project); mkdirSync(home);
    writeFileSync(script, JSON.stringify([{ text: "Hello." }, { text: "Hello." }]));
    await checkTraceTrust(process.argv.slice(2), { dir, project }, { PATH: process.env.PATH, HOME: home,
      TMPDIR: process.env.TMPDIR, MODULAR_AGENT_DATA_DIR: join(dir, "data"), MODULAR_AGENT_SCRIPT: script });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
