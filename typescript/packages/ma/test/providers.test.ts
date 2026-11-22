import { execFile } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { AuthFile } from "../src/auth.js";
import { grokOAuth } from "../src/grok-oauth.js";
import { grokResponses } from "../src/grok-responses.js";

const run = promisify(execFile);
const jwt = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
const token = (access = jwt) => ({ access_token: access, refresh_token: "refresh", expires_in: 3600 });
async function fixture(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse, body: string) => Promise<void> | void) {
  const errors: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      req.setEncoding("utf8");
      let body = "";
      for await (const part of req) body += part;
      await handler(req, res, body);
    } catch (err) { errors.push(err); res.writeHead(500).end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections(); assert.deepEqual(errors, []); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
const send = (res: ServerResponse, value: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
async function authFile(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "ma-auth-ts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new AuthFile(dir);
}

test("auth.json matches Rust serde_json bytes and keeps its answers and private mode", async t => {
  const auth = await authFile(t);
  // Rendered by serde_json::to_vec_pretty on credentials_auth::Contents:
  // two-space indent, snake-case tags, BTreeMap order and no final newline.
  const rust = '{\n  "logins": {\n    "chatgpt": {\n      "type": "oauth",\n      "access": "test-access",\n      "refresh": "test-refresh",\n      "expires": 2000000000000,\n      "account": "test-account"\n    },\n    "grok": {\n      "type": "api_key",\n      "key": "dummy"\n    }\n  },\n  "answers": {\n    "test-answer": "test-value"\n  }\n}';
  await writeFile(auth.path, rust, { mode: 0o600 });
  await chmod(auth.path, 0o644);
  await assert.rejects(auth.login("chatgpt"), /credential file must be private/);
  await chmod(auth.path, 0o600);
  const codex = await auth.login("chatgpt");
  assert.equal(codex?.type === "oauth" && codex.account, "test-account");
  assert.deepEqual(await auth.login("grok"), { type: "api_key", key: "dummy" });
  await auth.setLogin("chatgpt", codex);
  assert.equal(await readFile(auth.path, "utf8"), rust);
  assert.equal((await stat(auth.path)).mode & 0o777, 0o600);
  await auth.setLogin("grok");
  assert.deepEqual(JSON.parse(await readFile(auth.path, "utf8")).answers, { "test-answer": "test-value" });
});

test("Grok device sign-in handles slow_down and never opens a non-HTTPS verification address", async t => {
  let polls = 0, bad = false;
  const base = await fixture(t, (req, res, body) => {
    const form = new URLSearchParams(body);
    assert.equal(form.get("client_id"), "b1a00492-073a-47ea-816f-4c329264a828");
    if (req.url === "/device") {
      assert.equal(form.get("referrer"), "fixture-grok");
      send(res, { verification_uri_complete: bad ? "http://example.invalid" : "https://example.invalid", user_code: "CODE", device_code: "dev", interval: 1 });
    } else {
      assert.equal(form.get("device_code"), "dev");
      assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
      if (++polls === 1) send(res, { error: "authorization_pending" }, 400);
      else if (polls === 2) send(res, { error: "slow_down" }, 400);
      else send(res, token("access"));
    }
  });
  const service = grokOAuth({ clientIdentity: "fixture-grok", test: { endpoints: { xaiDeviceCode: `${base}/device`, xaiToken: `${base}/token` }, pollUnit: 1 } });
  const login = await service.login( s => { assert.equal(s.kind, "code"); });
  assert.equal(login.access, "access");
  assert.equal(login.account, undefined);
  assert.equal(polls, 3);
  bad = true;
  await assert.rejects(service.login( () => assert.fail("should not show an HTTP URL")), /not https/);
});

test("refresh holds Rust's flock while awaiting the token endpoint, and concurrent refreshes spend one token", async t => {
  const auth = await authFile(t);
  await auth.setLogin("grok", { type: "oauth", access: "expired", refresh: "once", expires: 1 });
  let requests = 0;
  const base = await fixture(t, async (_req, res, body) => {
    requests++;
    assert.equal(new URLSearchParams(body).get("refresh_token"), "once");
    const lock = join(auth.directory, "auth.lock");
    if (process.platform === "darwin") {
      await assert.rejects(run("/usr/bin/perl", ["-MFcntl=:flock", "-MErrno=EWOULDBLOCK", "-e",
        'open(my $fd, "<", $ARGV[0]) or die $!; exit 0 if flock($fd, LOCK_EX | LOCK_NB); exit($! == EWOULDBLOCK ? 1 : 2);', lock], { env: {} }), { code: 1 });
    } else {
      await assert.rejects(run("flock", ["-n", lock, "true"]), { code: 1 });
    }
    send(res, { access_token: "fresh", expires_in: 3600 });
  });
  const service = grokOAuth({ test: { endpoints: { xaiToken: base } } });
  const refresh = () => auth.current("grok", old => service.refresh(old));
  const [a, b] = await Promise.all([refresh(), refresh()]);
  assert.equal(requests, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(await auth.login("grok"), a);
  assert.equal(a.type === "oauth" && a.refresh, "once");
});

test("Grok sends the system item, caps output, and maps a stream error", async t => {
  const auth = await authFile(t);
  await auth.setLogin("grok", { type: "api_key", key: "fake-key" });
  const base = await fixture(t, (req, res, body) => {
    assert.equal(req.headers.authorization, "Bearer fake-key");
    assert.equal(req.headers.originator, undefined);
    const parsed = JSON.parse(body);
    assert.equal(parsed.instructions, undefined);
    assert.equal(parsed.max_output_tokens, 20);
    assert.deepEqual(parsed.input, [{ role: "system", content: "rules" }, { role: "user", content: "hey" }]);
    assert.deepEqual(parsed.reasoning, { effort: "high", summary: "auto" });
    res.writeHead(200, { "content-type": "text/event-stream" }).end('data: {"type":"response.failed","response":{"error":{"code":"context_length_exceeded","message":"too long"}}}\n\n');
  });
  const provider = grokResponses(auth, { grok: [{ id: "test", name: "Test", contextWindow: 1000, maxTokens: 20, effort: { off: "none", high: "high" } }] }, { test: { endpoint: base, oauth: grokOAuth({ test: { endpoints: {} } }) } });
  await assert.rejects(async () => provider.request({ provider: "grok", id: "test" }, { systemPrompt: "rules", messages: [{ role: "user", content: [{ type: "text", text: "hey" }] }], tools: [], settings: { reasoning: "xhigh", maxOutput: 99 } }, {
    cancelled: new AbortController().signal, async credential() { return undefined; }, piece() {}, log() {}, emit() {},
  }), { modelError: { kind: "contextTooLarge", message: "too long (context_length_exceeded)" } });
});
