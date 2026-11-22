import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chatgpt, signIn, signOut } from "@modular-agent/subscription";
import { body, fixture, loginFile, tokens } from "./fixtures.js";

const packaged = new URL("../../subscription-models.json", import.meta.url);
test("the shipped model table is byte-identical to the specification", async () => {
  assert.deepEqual(await readFile(packaged), await readFile(new URL("../../../../../docs/sdk/subscription-models.json", import.meta.url)));
});

test("ChatGPT validates the public client identity options", async t => {
  const logins = await loginFile(t);
  assert.throws(() => chatgpt({ logins, clientIdentity: "bad\n" }), { code: "invalid_composition" });
  await assert.rejects(signIn("chatgpt", logins, { clientIdentity: "" }), { code: "invalid_params" });
});

test("ChatGPT sign-in exchanges a pasted code and sign-out changes availability", async t => {
  const logins = await loginFile(t), p = chatgpt({ logins });
  const server = await fixture(t, async (req, res) => {
    const form = new URLSearchParams(await body(req));
    assert.equal(form.get("code"), "fixture-code");
    res.end(JSON.stringify(tokens));
  });
  assert.equal(await p.available(), false);
  await signIn("chatgpt", logins, { test: { endpoints: { codexToken: server.url, codexAuthorize: server.url }, port: 0 },
    onStep(step) { assert.equal(step.kind, "openAndPaste"); }, paste: () => "fixture-code" });
  assert.equal(await p.available(), true);
  assert.equal((await logins.login("chatgpt"))?.type, "oauth");
  await signOut("chatgpt", logins);
  assert.equal(await p.available(), false);
});

for (const mode of ["redirect", "query", "fragment", "address", "bare"] as const) {
  test(`ChatGPT accepts ${mode} and checks sign-in state`, async t => {
    const logins = await loginFile(t);
    let challenge = "", redirect = "", state = "", asked = 0, callback: Promise<Response> | undefined;
    const server = await fixture(t, async (req, res) => {
      const form = new URLSearchParams(await body(req));
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("code"), "fixture-code");
      assert.equal(form.get("redirect_uri"), redirect);
      assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), challenge);
      res.end(JSON.stringify(tokens));
    });
    await signIn("chatgpt", logins, {
      clientIdentity: mode === "redirect" ? undefined : "fixture-agent_2.0",
      test: { endpoints: { codexToken: server.url, codexAuthorize: `${server.url}/authorize` }, port: mode === "redirect" ? 0 : server.port },
      onStep(step) {
        assert.equal(step.kind, "openAndPaste");
        const url = new URL(step.url), params = url.searchParams;
        assert.equal(url.pathname, "/authorize");
        assert.equal(params.get("originator"), mode === "redirect" ? "modular-agent" : "fixture-agent_2.0");
        assert.equal(params.get("scope"), "openid profile email offline_access");
        assert.equal(params.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
        assert.equal(params.get("response_type"), "code");
        assert.equal(params.get("id_token_add_organizations"), "true");
        assert.equal(params.get("codex_cli_simplified_flow"), "true");
        assert.equal(params.get("code_challenge_method"), "S256");
        state = params.get("state")!; redirect = params.get("redirect_uri")!; challenge = params.get("code_challenge")!;
        if (mode === "redirect") callback = fetch(`${redirect}?code=fixture-code&state=${state}`);
        else assert.equal(redirect, "http://localhost:1455/auth/callback");
      },
      paste: mode === "redirect" ? undefined : (_signal, problem) => {
        switch (++asked) {
          case 1: return "code=wrong&state=wrong";
          case 2: assert.match(problem ?? "", /different sign-in/); return "error=denied";
          case 3:
            assert.match(problem ?? "", /sign-in error/);
            if (mode === "query") return `code=fixture-code&state=${state}`;
            if (mode === "fragment") return `fixture-code#${state}`;
            if (mode === "address") return `${redirect}?code=fixture-code&state=${state}`;
            return "fixture-code";
          default: assert.fail("asked again after a valid line");
        }
      },
    });
    if (callback) assert.equal((await callback).status, 200);
    else assert.equal(asked, 3);
    const login = await logins.login("chatgpt");
    assert.ok(login?.type === "oauth");
    assert.equal(login.account, "fixture-account");
    assert.ok(login.expires - Date.now() > 3290000 && login.expires - Date.now() <= 3300000);
  });
}

for (const device of [true, false]) {
  test(`ChatGPT device sign-in ${device ? "when requested" : "when the port is busy without paste"}`, async t => {
    const logins = await loginFile(t);
    let polls = 0;
    const server = await fixture(t, async (req, res) => {
      const raw = await body(req);
      if (req.url === "/device") {
        assert.equal(JSON.parse(raw).client_id, "app_EMoamEEZ73f0CkXaXp7hrann");
        res.end(JSON.stringify({ user_code: "FIXTURE", device_auth_id: "fixture-device", interval: "1" }));
      } else if (req.url === "/poll") {
        assert.deepEqual(JSON.parse(raw), { device_auth_id: "fixture-device", user_code: "FIXTURE" });
        if (++polls === 1) res.writeHead(404).end("{}");
        else res.end(JSON.stringify({ authorization_code: "fixture-code", code_verifier: "fixture-verifier" }));
      } else {
        const form = new URLSearchParams(raw);
        assert.equal(form.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
        assert.equal(form.get("code"), "fixture-code");
        assert.equal(form.get("code_verifier"), "fixture-verifier");
        res.end(JSON.stringify(tokens));
      }
    });
    const steps: unknown[] = [];
    await signIn("chatgpt", logins, { device, onStep: step => steps.push(step), test: { port: server.port, pollUnit: 1, endpoints: {
      codexDeviceCode: `${server.url}/device`, codexDeviceToken: `${server.url}/poll`, codexToken: `${server.url}/token`,
    } } });
    assert.deepEqual(steps, [{ kind: "deviceCode", url: "https://auth.openai.com/codex/device", code: "FIXTURE" }, { kind: "waiting" }]);
    assert.equal(polls, 2);
  });
}
