import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ModelFailure } from "@modular-agent/core";
import { subscriptionLogins, type OAuth } from "@modular-agent/subscription";

const old: OAuth = { type: "oauth", access: "fixture-old", refresh: "fixture-once", expires: 0 };
const fresh = { ...old, access: "fixture-new", expires: Date.now() + 60_000 };
async function file(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "subscription-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "auth.json");
}

test("two login handles spend the refresh token once", async t => {
  const path = await file(t), a = subscriptionLogins(path), b = subscriptionLogins(path);
  await a.setLogin("chatgpt", old);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const first = a.current("chatgpt", async token => {
    assert.deepEqual(token, old);
    enter();
    await released;
    return fresh;
  });
  await entered;
  const second = b.current("chatgpt", async () => assert.fail("the refresh was spent twice"));
  release();
  assert.deepEqual(await Promise.all([first, second]), [fresh, fresh]);
  assert.equal((await stat(path.replace(/\.json$/, ".lock"))).mode & 0o777, 0o600);
});

test("a refused refresh leaves bytes intact; public permissions prevent reading or writing", async t => {
  const path = await file(t), logins = subscriptionLogins(path);
  await writeFile(path, JSON.stringify({ answers: { fixture: "answer" }, extra: { enabled: true } }), { mode: 0o600 });
  await logins.setLogin("chatgpt", old);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).extra, { enabled: true });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const before = await readFile(path);
  await assert.rejects(logins.current("chatgpt", async () => {
    throw new ModelFailure({ kind: "credentials", message: "Sign in again." });
  }), ModelFailure);
  assert.deepEqual(await readFile(path), before);
  await chmod(path, 0o644);
  await assert.rejects(logins.login("chatgpt"), /private/);
  await assert.rejects(logins.setLogin("chatgpt"), /private/);
  assert.deepEqual(await readFile(path), before);
});
