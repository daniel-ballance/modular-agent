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
const aliases = [["openai-codex", "chatgpt", "gpt-6.1-sol"], ["xai", "grok", "grok-4.7"]] as const;
const fixtureAccess = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
const fixtureLogin = { type: "oauth", access: fixtureAccess, refresh: "fixture-refresh", expires: Date.now() + 60_000, account: "fixture-account" };

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

for (const [former, current, model] of aliases) {
  const host = current === "chatgpt" ? "chatgpt.com" : "api.x.ai";
  test(`ma login and logout accept ${former} and migrate old logins on write`, async t => {
    const p = await project(t);
    await p.put("auth.json", { logins: Object.fromEntries(aliases.map(([old]) => [old, fixtureLogin])), answers: { fixture: "keep" }, extra: true });
    const { stderr } = await p.run("login", former, "--device");
    assert.match(stderr, /enter the code: FIXTURE[\s\S]*Waiting for the sign-in to finish/);
    assert.deepEqual(Object.keys((await p.auth()).logins), ["chatgpt", "grok"]);
    if (current === "grok") assert.equal(Object.hasOwn((await p.auth()).logins.grok, "account"), false);
    assert.deepEqual((await p.auth()).answers, { fixture: "keep" });
    assert.equal((await p.auth()).extra, true);
    await p.put("auth.json", { logins: { [former]: fixtureLogin } });
    await p.run("logout", former);
    assert.deepEqual((await p.auth()).logins, {});
  });

  test(`ma --model, settings.json and models.json accept ${former}`, async t => {
    const p = await project(t);
    await p.put("auth.json", { logins: { [former]: fixtureLogin } });
    assert.equal((await p.run("--model", `${former}/${model}`, "-p", "hello")).stdout.trim(), `${host}/${model}`);
    assert.ok(Object.hasOwn((await p.auth()).logins, former)); // Reading alone is not a migration.
    await p.put("settings.json", { model: `${former}/fixture-model` });
    await p.put("models.json", { [former]: [{ id: "fixture-model", name: "Fixture", contextWindow: 32768, maxTokens: 2048, effort: { low: "low" } }] });
    assert.match((await p.run("models")).stdout, new RegExp(`${current}/fixture-model`));
    assert.equal((await p.run("-p", "hello")).stdout.trim(), `${host}/fixture-model`);
  });

  test(`ma reopens a session whose saved model is ${former}/${model}`, async t => {
    const p = await project(t);
    await p.put("auth.json", { logins: { [former]: fixtureLogin } });
    const old = await createAgent({ project: p.project, dataDir: join(p.config, "state"), durability: "kept", providers: [{
      id: former, supports: { keepsState: false, safeToRepeat: true },
      models: () => [{ provider: former, id: model, contextWindow: 32768, maxOutput: 2048, input: ["text"], reasoning: false }],
      request: () => ({ role: "assistant", stop: "finished", content: [{ type: "text", text: "saved fixture" }] }),
    }] });
    const id = await (async () => {
      try {
        const session = await old.session();
        assert.equal((await session.prompt("save this session")).text, "saved fixture");
        assert.deepEqual((await old.sessionInfo(session.id)).settings.model, { provider: former, id: model });
        return session.id;
      } finally { await old.close(); }
    })();
    assert.equal((await p.run("--session", id, "-p", "hello")).stdout.trim(), `${host}/${model}`);
  });
}
