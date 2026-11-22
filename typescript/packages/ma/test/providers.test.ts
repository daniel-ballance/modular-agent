import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { AuthFile } from "../src/auth.js";

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
