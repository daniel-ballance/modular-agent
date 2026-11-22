import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as wait } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "@modular-agent/core";
import { AuthFile } from "../src/auth.js";
import { oauth, pastedCode } from "../src/oauth.js";
import { responses } from "../src/responses.js";

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
  const rust = '{\n  "logins": {\n    "openai-codex": {\n      "type": "oauth",\n      "access": "test-access",\n      "refresh": "test-refresh",\n      "expires": 2000000000000,\n      "account": "test-account"\n    },\n    "xai": {\n      "type": "api_key",\n      "key": "dummy"\n    }\n  },\n  "answers": {\n    "test-answer": "test-value"\n  }\n}';
  await writeFile(auth.path, rust, { mode: 0o600 });
  await chmod(auth.path, 0o644);
  await assert.rejects(auth.login("openai-codex"), /credential file must be private/);
  await chmod(auth.path, 0o600);
  const codex = await auth.login("openai-codex");
  assert.equal(codex?.type === "oauth" && codex.account, "test-account");
  assert.deepEqual(await auth.login("xai"), { type: "api_key", key: "dummy" });
  await auth.setLogin("openai-codex", codex);
  assert.equal(await readFile(auth.path, "utf8"), rust);
  assert.equal((await stat(auth.path)).mode & 0o777, 0o600);
  await auth.setLogin("xai");
  assert.deepEqual(JSON.parse(await readFile(auth.path, "utf8")).answers, { "test-answer": "test-value" });
});

test("ChatGPT browser sign-in verifies state and exchanges PKCE over loopback", async t => {
  let challenge: string | null = null, redirect: string | null = null;
  const base = await fixture(t, (req, res, body) => {
    assert.equal(req.url, "/token");
    const form = new URLSearchParams(body);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("code"), "fixture+code");
    assert.equal(form.get("redirect_uri"), redirect);
    assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), challenge);
    send(res, token());
  });
  const service = oauth({ endpoints: { codexToken: `${base}/token`, codexAuthorize: `${base}/authorize` }, port: 0 });
  let callback: Promise<number> | undefined;
  const login = await service.login("openai-codex", false, step => {
    assert.equal(step.kind, "open");
    if (step.kind !== "open") return;
    const url = new URL(step.address);
    challenge = url.searchParams.get("code_challenge");
    redirect = url.searchParams.get("redirect_uri");
    const link = new URL(redirect!);
    link.searchParams.set("state", url.searchParams.get("state")!);
    link.searchParams.set("code", "fixture+code");
    callback = fetch(link).then(async r => { await r.text(); return r.status; });
  });
  assert.equal(await callback, 200);
  assert.equal(login.account, "test-account");
  assert.ok(login.expires - Date.now() <= 3_300_000 && login.expires - Date.now() > 3_290_000);
  const denied = service.login("openai-codex", false, step => {
    assert.equal(step.kind, "open");
    if (step.kind === "open") callback = fetch(`${new URL(step.address).searchParams.get("redirect_uri")}?code=no&state=wrong`).then(async r => { await r.text(); return r.status; });
  });
  await assert.rejects(denied, /wrong state/);
  assert.equal(await callback, 400);
});

test("ChatGPT sign-in finishes by pasting when the callback port is busy", { timeout: 4000 }, async t => {
  const redirect = "http://localhost:1455/auth/callback";
  const base = await fixture(t, (req, res, body) => {
    assert.equal(req.url, "/token");
    const form = new URLSearchParams(body);
    assert.equal(form.get("code"), "pasted-code");
    assert.equal(form.get("redirect_uri"), redirect);
    send(res, token());
  });
  // The token fake holds the callback port; no local callback can complete this login.
  const service = oauth({ endpoints: { codexToken: `${base}/token`, codexAuthorize: `${base}/authorize` }, port: Number(new URL(base).port) });
  const notes: string[] = [];
  let state: string | null = null;
  const login = await service.login("openai-codex", false, step => {
    if (step.kind === "note") { notes.push(step.message); return; }
    assert.equal(step.kind, "open-and-paste");
    const query = new URL(step.address).searchParams;
    state = query.get("state");
    assert.ok(state);
    assert.equal(query.get("originator"), "pi");
    assert.equal(query.get("redirect_uri"), redirect);
  }, receive => {
    receive("");
    receive(`${redirect}?code=stale&state=other`);
    receive(`${redirect}?code=pasted-code&scope=x&state=${state}`);
    return () => {};
  });
  assert.equal(login.account, "test-account");
  assert.equal(login.refresh, "refresh");
  assert.equal(notes.length, 2);
  assert.match(notes[0], /Port 1455 is in use/);
  assert.match(notes[1], /different sign-in.*Paste it again/);
});

test("pasted ChatGPT codes are read from each accepted form", () => {
  const read = (input: string) => pastedCode(input, "st");
  assert.equal(read("http://localhost:1455/auth/callback?code=c1&state=st"), "c1");
  assert.equal(read("  code=a%2Fb+c&state=st  "), "a/b c");
  assert.equal(read("c3#st"), "c3");
  assert.equal(read("c4"), "c4");
  assert.equal(read("   "), undefined);
  assert.throws(() => read("http://localhost:1455/auth/callback?code=c&state=other"), /different sign-in/);
  assert.throws(() => read("code=c&state="), /different sign-in/);
  assert.throws(() => read("http://localhost:1455/auth/callback?error=access_denied&state=st"), /not completed/);
  assert.throws(() => read("http://localhost:1455/auth/callback?state=st"), /no code/);
});

test("ChatGPT device sign-in waits for authorization and exchanges the device verifier", async t => {
  let polls = 0;
  const base = await fixture(t, (req, res, body) => {
    if (req.url === "/device") {
      assert.equal(JSON.parse(body).client_id, "app_EMoamEEZ73f0CkXaXp7hrann");
      send(res, { device_auth_id: "id", user_code: "CODE", interval: "1" });
    } else if (req.url === "/poll") {
      assert.deepEqual(JSON.parse(body), { device_auth_id: "id", user_code: "CODE" });
      if (++polls === 1) send(res, {}, 404);
      else send(res, { authorization_code: "approved", code_verifier: "verifier" });
    } else {
      const form = new URLSearchParams(body);
      assert.equal(form.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
      assert.equal(form.get("code"), "approved");
      assert.equal(form.get("code_verifier"), "verifier");
      send(res, token());
    }
  });
  const service = oauth({ endpoints: { codexDeviceCode: `${base}/device`, codexDeviceToken: `${base}/poll`, codexToken: `${base}/token` }, pollUnit: 1 });
  const steps: unknown[] = [];
  const login = await service.login("openai-codex", true, s => steps.push(s));
  assert.equal(login.account, "test-account");
  assert.equal(polls, 2);
  assert.deepEqual(steps, [{ kind: "code", address: "https://auth.openai.com/codex/device", code: "CODE" }]);
});

test("Grok device sign-in handles slow_down and never opens a non-HTTPS verification address", async t => {
  let polls = 0, bad = false;
  const base = await fixture(t, (req, res, body) => {
    const form = new URLSearchParams(body);
    assert.equal(form.get("client_id"), "b1a00492-073a-47ea-816f-4c329264a828");
    if (req.url === "/device") {
      assert.equal(form.get("referrer"), "pi");
      send(res, { verification_uri_complete: bad ? "http://example.invalid" : "https://example.invalid", user_code: "CODE", device_code: "dev", interval: 1 });
    } else {
      assert.equal(form.get("device_code"), "dev");
      assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
      if (++polls === 1) send(res, { error: "authorization_pending" }, 400);
      else if (polls === 2) send(res, { error: "slow_down" }, 400);
      else send(res, token("access"));
    }
  });
  const service = oauth({ endpoints: { xaiDeviceCode: `${base}/device`, xaiToken: `${base}/token` }, pollUnit: 1 });
  const login = await service.login("xai", false, s => { assert.equal(s.kind, "code"); });
  assert.equal(login.access, "access");
  assert.equal(login.account, undefined);
  assert.equal(polls, 3);
  bad = true;
  await assert.rejects(service.login("xai", false, () => assert.fail("should not show an HTTP URL")), /not https/);
});

test("refresh holds Rust's flock while awaiting the token endpoint, and concurrent refreshes spend one token", async t => {
  const auth = await authFile(t);
  await auth.setLogin("xai", { type: "oauth", access: "expired", refresh: "once", expires: 1 });
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
  const service = oauth({ endpoints: { xaiToken: base } });
  const refresh = () => auth.current("xai", old => service.refresh("xai", old));
  const [a, b] = await Promise.all([refresh(), refresh()]);
  assert.equal(requests, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(await auth.login("xai"), a);
  assert.equal(a.type === "oauth" && a.refresh, "once");
});

test("Codex sends Pi's headers and request shape, refreshes a rejected token once, and decodes split SSE", async t => {
  const auth = await authFile(t);
  await auth.setLogin("openai-codex", { type: "oauth", access: "old", account: "test-account", refresh: "rotate", expires: Date.now() + 999_999 });
  let requests = 0, refreshes = 0;
  const base = await fixture(t, async (req, res, body) => {
    if (req.url === "/token") {
      assert.equal(new URLSearchParams(body).get("refresh_token"), "rotate");
      refreshes++;
      send(res, token());
      return;
    }
    assert.equal(req.url, "/responses");
    assert.equal(req.headers["openai-beta"], "responses=experimental");
    assert.equal(req.headers.originator, "pi");
    assert.equal(req.headers["chatgpt-account-id"], "test-account");
    const parsed = JSON.parse(body);
    assert.equal(parsed.prompt_cache_key, req.headers["x-client-request-id"]);
    assert.equal(parsed.prompt_cache_key, req.headers["session-id"]);
    assert.equal(parsed.instructions, "You are a helpful assistant.");
    assert.deepEqual(parsed.input, [{ role: "user", content: "hello" }]);
    assert.deepEqual(parsed.include, ["reasoning.encrypted_content"]);
    assert.equal(parsed.store, false);
    assert.equal(parsed.max_output_tokens, undefined);
    if (++requests === 1) { assert.equal(req.headers.authorization, "Bearer old"); send(res, {}, 401); return; }
    assert.equal(req.headers.authorization, `Bearer ${jwt}`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = Buffer.from('data: {"type":"response.output_text.delta","delta":"café"}\r\n\r\n');
    const split = event.indexOf(0xc3) + 1;
    res.write(event.subarray(0, split));
    await wait(5);
    res.write(event.subarray(split));
    res.write('data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"café"}]}}\n\n');
    res.end('data: {"type":"response.completed",\n' + 'data: "response":{"output":[],"usage":{"input_tokens":7,"output_tokens":2,"input_tokens_details":{"cached_tokens":1}}}}\n\n');
  });
  const provider = responses("openai-codex", auth, {}, { endpoint: `${base}/responses`, oauth: oauth({ endpoints: { codexToken: `${base}/token` } }) });
  const agent = await createAgent({ providers: [provider], model: "openai-codex/gpt-6.1-sol", settings: { maxOutput: 20 } });
  t.after(() => agent.close());
  const result = await (await agent.session()).prompt("hello");
  assert.equal(result.text, "café");
  assert.equal(result.usage?.cacheRead, 1);
  assert.equal(requests, 2);
  assert.equal(refreshes, 1);
});

test("Grok sends the system item, caps output, and maps a stream error", async t => {
  const auth = await authFile(t);
  await auth.setLogin("xai", { type: "api_key", key: "fake-key" });
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
  const provider = responses("xai", auth, { xai: [{ id: "test", name: "Test", contextWindow: 1000, maxTokens: 20, effort: { off: "none", high: "high" } }] }, { endpoint: base, oauth: oauth({ endpoints: {} }) });
  await assert.rejects(async () => provider.request({ provider: "xai", id: "test" }, { systemPrompt: "rules", messages: [{ role: "user", content: [{ type: "text", text: "hey" }] }], tools: [], settings: { reasoning: "xhigh", maxOutput: 99 } }, {
    cancelled: new AbortController().signal, async credential() { return undefined; }, piece() {}, log() {}, emit() {},
  }), { modelError: { kind: "contextTooLarge", message: "too long (context_length_exceeded)" } });
});
