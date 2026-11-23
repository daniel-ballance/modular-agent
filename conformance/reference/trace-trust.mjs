import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { on, once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { startReceiver } from "../telemetry/receiver.mjs";
import { ACP_PROTOCOL, socketPeer } from "../tools/websocket.mjs";

const actor = { id: "desk", kind: "host", rights: ["watch", "input"] };
const traceId = "bb0d8cb2f62649d48ee0bc98cf631eef";
const traceparent = `00-${traceId}-a172caab9c83c91f-01`;

// A new session for each run lets us match the invocation even when the
// receiver has already seen the same remote trace ID from another token.
async function checkInvocation(receiver, session, trusted) {
  const attr = (s, key) => s.attributes?.find(a => a.key === key)?.value?.stringValue;
  const matches = s => attr(s, "gen_ai.operation.name") === "invoke_agent" && attr(s, "gen_ai.conversation.id") === session;
  const { spans } = await receiver.waitFor(spans => spans.some(matches), { timeoutMs: 15_000 });
  for (const span of spans.filter(matches)) {
    assert.match(span.traceId, /^(?!0{32}$)[0-9a-f]{32}$/);
    assert.equal(span.traceId === traceId, trusted, `session ${session}: trace trust should be ${trusted}, got ${span.traceId}`);
  }
}

async function acpTurn(send, receive, cwd) {
  let id = 0;
  async function request(method, params) {
    send(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }));
    for (;;) {
      const msg = JSON.parse(await receive());
      if (msg.id !== id) continue;
      assert.equal(msg.error, undefined, JSON.stringify(msg.error));
      return msg.result;
    }
  }
  await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await request("session/new", { cwd, mcpServers: [] });
  await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Hello" }], _meta: { traceparent } });
  return sessionId;
}

async function aguiTurn(origin, token, signal) {
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
  return threadId;
}

export async function checkTraceTrust(command, t, environment, invoke) {
  const policy = join(t.dir, "operator.json");
  const entries = [{ traceTrusted: true }, { traceTrusted: false }, {}];
  const tokens = entries.map(() => randomBytes(24).toString("hex"));
  const actors = entries.map((entry, i) => {
    const tokenFile = `actor-${i}.token`;
    writeFileSync(join(t.dir, tokenFile), tokens[i], { mode: 0o600 });
    return { actor, tokenFile, clientId: `client-${i}`, ...entry };
  });
  for (const invalid of [{ stdio: { actor, traceTrusted: null } }, { actors: [{ ...actors[0], traceTrusted: "false" }] }]) {
    writeFileSync(policy, JSON.stringify(invalid), { mode: 0o600 });
    const r = await invoke(command, { args: ["--policy", policy, "--declaration"] });
    assert.ok(!r.timeoutDetail && r.exit > 0 && r.stderr.includes("operator.json") && /boolean|traceTrusted/i.test(r.stderr),
      `malformed traceTrusted must fail startup and name the policy and problem: ${r.stderr}`);
  }

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
    const read = async () => {
      const line = await replies.next();
      assert(!line.done, `ma closed stdout: ${stderr.trim()}`);
      return line.value;
    };
    const signal = AbortSignal.timeout(30_000);
    try {
      await Promise.race([work(child, read, signal), closed.then(() => { throw Error(`ma exited: ${stderr.trim()}`); }),
        once(signal, "abort").then(() => { throw Error("ma trace trust check timed out"); })]);
    } finally {
      lines.close();
      if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
      await closed;
    }
  }
  try {
    const listen = ["--agui", "--acp", "--listen", "127.0.0.1:0"];
    await serve(listen, { actors }, async (_, read, signal) => {
      const origin = await read();
      assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+\/?$/);
      const sessions = [];
      for (const [i, token] of tokens.entries()) {
        const trusted = i === 0;
        sessions.push([await aguiTurn(origin, token, signal), trusted]);
        const peer = socketPeer({ url: origin.replace("http:", "ws:"), protocol: ACP_PROTOCOL, token });
        try {
          const ws = await peer.ready;
          const frames = on(ws, "message", { signal });
          try {
            const id = await acpTurn(msg => ws.send(msg), async () => (await frames.next()).value[0].data, t.project);
            sessions.push([id, trusted]);
          } finally { await frames.return(); }
        } finally { peer.end(); }
      }
      // An exporter may batch all six turns. Do not wait for a flush between tokens.
      await Promise.all(sessions.map(([id, trusted]) => checkInvocation(receiver, id, trusted)));
    });
    await serve([...listen, "--token-file", join(t.dir, actors[0].tokenFile)], {}, async (_, read, signal) => {
      const origin = await read();
      assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+\/?$/);
      await checkInvocation(receiver, await aguiTurn(origin, tokens[0], signal), false);
    });
    for (const [settings, trusted] of [[{}, true], [{ stdio: { actor } }, true], [{ stdio: { actor, traceTrusted: false } }, false]]) {
      await serve(["--acp"], settings, async (child, read) => {
        const id = await acpTurn(msg => child.stdin.write(msg + "\n"), read, t.project);
        await checkInvocation(receiver, id, trusted);
      });
    }
  } finally { await receiver.close(); }
}
