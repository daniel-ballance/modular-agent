import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { subscriptionLogins } from "@modular-agent/subscription";

export const access = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.test`;
export const tokens = { access_token: access, refresh_token: "fixture-refresh", expires_in: 3600 };
export async function fixture(t: TestContext, handle: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const errors: unknown[] = [];
  const server = createServer((req, res) => {
    void Promise.resolve().then(() => handle(req, res)).catch(error => {
      errors.push(error); res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    assert.deepEqual(errors, []);
  });
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

