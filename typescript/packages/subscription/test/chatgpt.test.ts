import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { chatgpt, signIn, signOut, subscriptionLogins } from "@modular-agent/subscription";

export const access = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.test`;
export const tokens = { access_token: access, refresh_token: "fixture-refresh", expires_in: 3600 };
export async function fixture(t: TestContext, handle: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => {
    void Promise.resolve().then(() => handle(req, res)).catch(error => {
      t.diagnostic(String(error)); res.writeHead(500).end();
      process.exitCode = 1;
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, port };
}
export async function loginFile(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "chatgpt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return subscriptionLogins(join(dir, "auth.json"));
}
export async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

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
