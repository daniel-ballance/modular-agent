import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createAgent } from "@modular-agent/core";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/main.js", import.meta.url));
const fixtureAccess = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;

async function project(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "ma-subscriptions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, "config"), project = join(dir, "project"), home = join(dir, "home"), preload = join(dir, "fixture.mjs");
  await Promise.all([config, project, home].map(path => mkdir(path)));
  // The child cannot make a real model request or sign in. All fetches end here.
  await writeFile(preload, `import assert from "node:assert/strict";
    globalThis.fetch = async (address, init) => {
      const url = new URL(address);
      if (url.host === "auth.openai.com") {
        if (url.pathname.endsWith("/usercode")) return Response.json({ user_code: "FIXTURE", device_auth_id: "fixture", interval: 1 });
        if (url.pathname.endsWith("/deviceauth/token")) return Response.json({ authorization_code: "fixture", code_verifier: "fixture" });
        assert.equal(url.pathname, "/oauth/token");
      } else if (url.host === "auth.x.ai") {
        if (url.pathname.endsWith("/device/code")) {
          assert.equal(new URLSearchParams(init.body).get("referrer"), "fixture-ma");
          return Response.json({ verification_uri: "https://example.invalid", user_code: "FIXTURE", device_code: "fixture", interval: 1 });
        }
        assert.equal(url.pathname, "/oauth2/token");
      } else {
        assert.ok(["chatgpt.com", "api.x.ai"].includes(url.host), String(url));
        const headers = new Headers(init.headers);
        if (url.host === "chatgpt.com") assert.equal(headers.get("originator"), "fixture-ma");
        else {
          assert.equal(url.href, "https://api.x.ai/v1/responses");
          assert.equal(headers.get("originator"), null);
          assert.equal(headers.get("referrer"), null);
        }
        const text = url.host + "/" + JSON.parse(init.body).model;
        return new Response("data: " + JSON.stringify({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text }] }] } }) + "\\n\\n");
      }
      return Response.json({ access_token: ${JSON.stringify(fixtureAccess)}, refresh_token: "fixture-refresh", expires_in: 3600 });
    };`);
  const run = (...args: string[]) => exec(process.execPath, ["--import", preload, cli, ...args], { cwd: project,
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, MODULAR_AGENT_DATA_DIR: config, MA_CLIENT_IDENTITY: "fixture-ma", MA_NO_BROWSER: "1" } });
  const put = (name: string, value: unknown) => writeFile(join(config, name), JSON.stringify(value), { mode: 0o600 });
  const auth = async () => JSON.parse(await readFile(join(config, "auth.json"), "utf8"));
  return { run, put, config, project, auth };
}

for (const [provider, host] of [["chatgpt", "chatgpt.com"], ["grok", "api.x.ai"]]) {
  test(`ma uses the ${provider} login for its configured models`, async t => {
    const p = await project(t);
    await p.put("auth.json", { answers: { fixture: "keep" } });
    const { stderr } = await p.run("login", provider, "--device");
    assert.match(stderr, /enter the code: FIXTURE[\s\S]*Waiting for the sign-in to finish/);
    const { logins } = await p.auth();
    assert.deepEqual(Object.keys(logins), [provider]);
    assert.equal(logins[provider].account, provider === "grok" ? undefined : "fixture-account");
    await p.put("models.json", { [provider]: [{ id: "fixture", name: "Fixture", contextWindow: 4096, maxTokens: 512, effort: {} }] });
    await p.put("settings.json", { model: `${provider}/fixture` });
    assert.equal((await p.run("-p", "hello")).stdout.trim(), `${host}/fixture`);
    await p.run("logout", provider);
    assert.deepEqual(await p.auth(), { logins: {}, answers: { fixture: "keep" } });
  });
}

test("ma does not use another provider's login, catalog or saved selection", async t => {
  const p = await project(t);
  await p.put("auth.json", { logins: { "openai-codex": { type: "api_key", key: "fixture" } } });
  await p.put("models.json", { xai: [{ id: "extra", name: "Extra", contextWindow: 4096, maxTokens: 512, effort: {} }] });
  assert.doesNotMatch((await p.run("models")).stdout, /grok\/extra/);
  assert.match((await p.run("auth")).stdout, /chatgpt[^\n]*not signed in/);
  await assert.rejects(p.run("login", "openai-codex", "--device"), /unknown provider/);
  await assert.rejects(p.run("logout", "xai"), /unknown provider/);
  await assert.rejects(p.run("--model", "xai/grok-4.7", "-p", "hello"), /model is not offered/);
  const id = "openai-codex", model = "gpt-6.1-sol";
  const a = await createAgent({ project: p.project, dataDir: join(p.config, "state"), durability: "kept", providers: [{
    id, supports: { keepsState: false, safeToRepeat: true },
    models: () => [{ provider: id, id: model, contextWindow: 32768, maxOutput: 2048, input: ["text"], reasoning: false }],
    request: () => ({ role: "assistant", stop: "finished", content: [] }),
  }] });
  const session = await a.session();
  try { await session.prompt("save"); } finally { await a.close(); }
  await assert.rejects(p.run("--session", session.id, "-p", "hello"), /model is not offered/);
});
