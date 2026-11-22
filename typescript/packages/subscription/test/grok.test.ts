import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createAgent, definePlugin, type AssistantMessage } from "@modular-agent/core";
import { memoryEnvironment, overWire } from "@modular-agent/core/testing";
import { grok, signIn, signOut, subscriptionLogins, type OAuth, type SignInStep } from "@modular-agent/subscription";
import { body, fixture, loginFile } from "./fixtures.js";

const client = "b1a00492-073a-47ea-816f-4c329264a828";
const scope = "openid profile email offline_access grok-cli:access api:access";
const verification = "https://example.test/device";
const device = { verification_uri: verification, device_code: "fixture-device", user_code: "FIXTURE" };
const fresh = { access_token: "fixture-new-access", refresh_token: "fixture-new-refresh" };
const old: OAuth = { type: "oauth", access: "fixture-expired", refresh: "fixture-once", expires: 0 };
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const signInTest = (base: string) => {
  const delays: number[] = [];
  let time = 0;
  return { delays, options: { endpoints: { xaiDeviceCode: `${base}/oauth2/device/code`, xaiToken: `${base}/oauth2/token` },
    pollClock: { now: () => time, async wait(ms: number) { delays.push(ms); time += ms; } } } };
};

for (const identity of [undefined, "fixture-grok_2.0"]) {
  test(`Grok device sign-in uses ${identity ?? "the default identity"} and follows polling backoff`, async t => {
    const logins = await loginFile(t), steps: SignInStep[] = [];
    const p = grok({ logins });
    assert.equal(await p.available(), false);
    const complete = identity ? `${verification}?code=FIXTURE` : undefined;
    const errors = ["authorization_pending", "slow_down", "authorization_pending", "slow_down"];
    let polls = 0, starts = 0;
    const server = await fixture(t, async (req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.headers["content-type"], "application/x-www-form-urlencoded");
      assert.equal(req.headers.accept, "application/json");
      const form = [...new URLSearchParams(await body(req))];
      if (req.url === "/oauth2/device/code") {
        starts++;
        assert.deepEqual(form, [["client_id", client], ["scope", scope], ["referrer", identity ?? "modular-agent"]]);
        res.end(JSON.stringify({ ...device, verification_uri_complete: complete, interval: identity ? 2 : undefined }));
      } else {
        assert.equal(req.url, "/oauth2/token");
        assert.deepEqual(steps, [{ kind: "deviceCode", url: complete ?? verification, code: "FIXTURE" }, { kind: "waiting" }]);
        assert.deepEqual(form, [["grant_type", "urn:ietf:params:oauth:grant-type:device_code"], ["client_id", client], ["device_code", device.device_code]]);
        const error = errors[polls++];
        if (error) res.writeHead(400).end(JSON.stringify({ error }));
        else res.end(JSON.stringify(fresh));
      }
    });
    const clock = signInTest(server.url);
    await signIn("grok", logins, { clientIdentity: identity, device: !!identity, paste: () => assert.fail("Grok does not paste"),
      onStep: step => steps.push(step), test: clock.options });
    assert.equal(starts, 1);
    assert.equal(polls, 5);
    const interval = identity ? 2_000 : 5_000;
    assert.deepEqual(clock.delays, [interval, interval, interval + 5_000, interval + 5_000, interval + 10_000]);
    assert.equal(await p.available(), true);
    const login = await logins.login("grok");
    assert.equal(login?.type, "oauth");
    assert.equal(login.access, fresh.access_token);
    assert.equal(login.refresh, fresh.refresh_token);
    assert.equal(Object.hasOwn(login, "account"), false);
    await signOut("grok", logins);
    assert.equal(await p.available(), false);
  });
}

for (const [error, message] of [["access_denied", /was denied/], ["authorization_denied", /was denied/], ["expired_token", /code expired/]] as const) {
  test(`Grok device sign-in stops after ${error}`, async t => {
    const logins = await loginFile(t);
    let polls = 0;
    const server = await fixture(t, (req, res) => {
      if (req.url === "/oauth2/device/code") res.end(JSON.stringify(device));
      else { polls++; res.writeHead(400).end(JSON.stringify({ error })); }
    });
    const clock = signInTest(server.url);
    await assert.rejects(signIn("grok", logins, { test: clock.options }), message);
    assert.equal(polls, 1);
    assert.deepEqual(clock.delays, [5_000]);
    assert.equal(await logins.login("grok"), undefined);
  });
}

test("Grok device sign-in respects the advertised and default expiry", async t => {
  const logins = await loginFile(t);
  let expiry: number | undefined = 3, polls = 0;
  const server = await fixture(t, (req, res) => {
    if (req.url === "/oauth2/device/code") res.end(JSON.stringify({ ...device, interval: expiry === undefined ? 450 : 2, expires_in: expiry }));
    else { polls++; res.writeHead(400).end(JSON.stringify({ error: "authorization_pending" })); }
  });
  const clock = signInTest(server.url);
  await assert.rejects(signIn("grok", logins, { test: clock.options }), /not completed in time/);
  assert.deepEqual(clock.delays, [2_000, 1_000]);
  assert.equal(polls, 1);
  expiry = undefined;
  const defaults = signInTest(server.url);
  await assert.rejects(signIn("grok", logins, { test: defaults.options }), /not completed in time/);
  assert.deepEqual(defaults.delays, [450_000, 450_000]);
  assert.equal(polls, 2);
});

test("Grok refuses a non-https verification address before showing the code or polling", async t => {
  const logins = await loginFile(t);
  let complete: string | undefined = "http://example.test/device?code=FIXTURE";
  const server = await fixture(t, (req, res) => {
    assert.equal(req.url, "/oauth2/device/code");
    res.end(JSON.stringify({ ...device, verification_uri_complete: complete,
      verification_uri: complete ? verification : "http://example.test/device" }));
  });
  const clock = signInTest(server.url);
  const signInOptions = { onStep: () => assert.fail("Grok showed an unsafe address"), test: clock.options };
  await assert.rejects(signIn("grok", logins, signInOptions), /not https/);
  complete = undefined;
  await assert.rejects(signIn("grok", logins, signInOptions), /not https/);
  assert.deepEqual(clock.delays, []);
  assert.equal(await logins.login("grok"), undefined);
});

test("Grok validates client identity before sign-in or construction", async t => {
  const logins = await loginFile(t);
  for (const clientIdentity of ["", "contains a space", "x".repeat(65)]) {
    assert.throws(() => grok({ logins, clientIdentity }), { code: "invalid_composition" });
    await assert.rejects(signIn("grok", logins, { clientIdentity, test: { endpoints: {} } }), { code: "invalid_params" });
  }
});

for (const served of [false, true]) {
  const placement = served ? "served" : "in process";
  test(`Grok maps models and streams Responses without ChatGPT fields (${placement})`, async t => {
    const logins = await loginFile(t), requests: Record<string, unknown>[] = [];
    await logins.setLogin("grok", { type: "api_key", key: "fixture-key" });
    const encrypted = { type: "reasoning", encrypted_content: "fixture-encrypted" };
    const output = [encrypted, { type: "message", content: [{ type: "output_text", text: "hello" }] }];
    const server = await fixture(t, async (req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/responses");
      assert.equal(req.headers.authorization, "Bearer fixture-key");
      assert.equal(req.headers.accept, "text/event-stream");
      assert.equal(req.headers["content-type"], "application/json");
      for (const name of ["chatgpt-account-id", "openai-beta", "originator", "referrer", "session-id", "x-client-request-id"])
        assert.equal(req.headers[name], undefined, name);
      requests.push(JSON.parse(await body(req)));
      res.setHeader("content-type", "text/event-stream");
      res.write('data: {"type":"response.output_text.delta","delta":"hel');
      res.end(`lo"}\r\n\r\ndata: ${JSON.stringify({ type: "response.completed", response: { output } })}\n\n`);
    });
    const known = { id: "grok-4.3", contextWindow: 100, maxOutput: 10, input: ["text"] };
    const extra = { id: "fixture-extra", contextWindow: 200, maxOutput: 20, input: ["text"] };
    const p = grok({ logins, clientIdentity: served ? "fixture-grok" : undefined, test: { endpoint: `${server.url}/v1/responses` }, models: [known, extra] });
    assert.equal(p.id, "grok");
    const plugin = definePlugin({ name: "grok-fixture", setup: r => r.provider(p) });
    const hooks = definePlugin({ name: "fixture-request", setup: r => {
      r.on("provider.request", ({ request }) => ({ change: { ...request, systemPrompt: "Fixture rules",
        settings: { ...request.settings, maxOutput: 99_000, reasoning: "high" } } }));
    } });
    const agent = await createAgent({ environment: memoryEnvironment(), plugins: [served ? overWire(plugin) : plugin, hooks] });
    t.after(() => agent.close());
    assert.deepEqual(agent.models().filter(m => m.provider === "grok").map(m => [m.id, m.contextWindow, m.maxOutput, m.thinking]), [
      ["grok-4.3", 1_000_000, 30_000, ["off", "low", "medium", "high", "xhigh"]],
      ...["grok-4.5", "grok-4.6", "grok-4.7"].map(id => [id, 500_000, 500_000, ["low", "medium", "high", "xhigh"]]),
      [extra.id, 200, 20, undefined],
    ]);
    const session = await agent.session({ settings: { model: "grok/grok-4.3" } });
    let text = "";
    for await (const event of session.promptStream("hello")) if (event.type === "text") text += event.data.delta;
    assert.equal(text, "hello");
    assert.equal((await session.lastTurn())?.text, "hello");
    const system = { role: "system", content: "Fixture rules" };
    assert.deepEqual(requests[0], { model: "grok-4.3", stream: true, store: false, include: ["reasoning.encrypted_content"],
      tool_choice: "auto", parallel_tool_calls: true, reasoning: { effort: "high", summary: "auto" }, max_output_tokens: 30_000,
      input: [system, { role: "user", content: "hello" }] });
    assert.equal((await session.prompt("again")).text, "hello");
    assert.deepEqual(requests[1].input, [system, { role: "user", content: "hello" }, ...output, { role: "user", content: "again" }]);
    const enrolled = await agent.session({ settings: { model: `grok/${extra.id}` } });
    assert.equal((await enrolled.prompt("hello")).text, "hello");
    assert.equal(requests[2].model, extra.id);
    assert.equal(requests[2].max_output_tokens, 20);
    assert.equal(requests[2].reasoning, undefined);
  });

  test(`Grok refresh spends one token and a refused refresh leaves the login (${placement})`, async t => {
    const logins = await loginFile(t);
    await logins.setLogin("grok", old);
    let spent = 0, refuse = false, models = 0;
    const entered = barrier(), secondRead = barrier();
    const server = await fixture(t, async (req, res) => {
      if (req.url === "/oauth2/token") {
        spent++;
        assert.equal(req.method, "POST");
        assert.equal(req.headers["content-type"], "application/x-www-form-urlencoded");
        assert.deepEqual([...new URLSearchParams(await body(req))], [["grant_type", "refresh_token"], ["refresh_token", old.refresh], ["client_id", client]]);
        if (refuse) res.writeHead(400).end(JSON.stringify({ error: "invalid_grant", error_description: old.refresh }));
        else {
          entered.resolve();
          await secondRead.promise;
          res.end(JSON.stringify({ access_token: fresh.access_token }));
        }
      } else {
        assert.equal(req.url, "/v1/responses");
        assert.equal(req.headers.authorization, `Bearer ${fresh.access_token}`);
        models++;
        res.end('data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"fresh"}]}]}}\n\n');
      }
    });
    const replies: AssistantMessage[] = [];
    const start = async (file: typeof logins) => {
      const p = grok({ logins: file, test: { endpoint: `${server.url}/v1/responses`, oauth: { endpoints: { xaiToken: `${server.url}/oauth2/token` } } } });
      const plugin = definePlugin({ name: "grok-fixture", setup: r => r.provider(p) });
      const hooks = definePlugin({ name: "fixture-replies", setup: r => {
        r.on("provider.response", ({ message }) => { replies.push(message); });
        r.on("model.failed", () => "stop");
      } });
      const agent = await createAgent({ environment: memoryEnvironment(), plugins: [served ? overWire(plugin) : plugin, hooks] });
      t.after(() => agent.close());
      return agent.session({ settings: { model: "grok/grok-4.7" } });
    };
    const other = subscriptionLogins(logins.path);
    const [a, b] = await Promise.all([start(logins), start(other)]);
    const read = other.login.bind(other);
    // Release the first exchange only after the second reader sees the old login.
    t.mock.method(other, "login", async (provider: string) => {
      const login = await read(provider);
      secondRead.resolve();
      return login;
    });
    const beforeRefresh = Date.now();
    const first = a.prompt("first");
    await Promise.race([entered.promise, first.then(() => assert.fail("the first request did not reach the token endpoint"))]);
    const second = b.prompt("second");
    try {
      await Promise.race([secondRead.promise, second.then(() => assert.fail("the second request did not read the old login"))]);
    } finally { secondRead.resolve(); }
    assert.deepEqual((await Promise.all([first, second])).map(r => r.text), ["fresh", "fresh"]);
    assert.equal(spent, 1);
    assert.equal(models, 2);
    const login = await logins.login("grok");
    assert.equal(login?.type, "oauth");
    assert.deepEqual(login, { ...old, access: fresh.access_token, expires: login.expires });
    assert.ok(login.expires >= beforeRefresh + 3_300_000 && login.expires <= Date.now() + 3_300_000);

    refuse = true;
    await logins.setLogin("grok", old);
    const before = await readFile(logins.path);
    assert.equal((await a.prompt("cannot refresh")).outcome?.kind, "failed");
    assert.equal(replies.at(-1)?.error?.kind, "credentials");
    assert.match(replies.at(-1)?.error?.message ?? "", /sign in again/i);
    assert.doesNotMatch(replies.at(-1)?.error?.message ?? "", /fixture-once/);
    assert.deepEqual(await readFile(logins.path), before);
    assert.equal(spent, 2);
    assert.equal(models, 2);
  });
}
