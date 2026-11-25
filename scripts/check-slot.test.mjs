import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = fileURLToPath(new URL("..", import.meta.url));
const library = fileURLToPath(new URL("check-slot.sh", import.meta.url));

function machine(t, slots) {
  const home = mkdtempSync(join(tmpdir(), "check-slot-"));
  const env = { PATH: process.env.PATH, HOME: home, MA_CHECK_SLOTS: String(slots) };
  const children = [];
  t.after(() => {
    for (const child of children) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    rmSync(home, { recursive: true, force: true });
  });
  const start = (command, args, extra = {}) => {
    const child = spawn(command, args, { cwd: repo, env: { ...env, ...extra }, detached: true });
    child.out = "";
    child.err = "";
    child.stdout.on("data", (data) => { child.out += data; });
    child.stderr.on("data", (data) => { child.err += data; });
    child.done = new Promise((resolve) => child.on("close", resolve));
    children.push(child);
    return child;
  };
  // A holder takes its slots, then keeps them until its stdin closes.
  const hold = (count = 1, extra) =>
    start("bash", ["-c", `. "$0"; take_check_slots ${count} || exit; echo ready; read -r _`, library], extra);
  const run = (script, extra = {}) =>
    spawnSync("bash", ["-c", `. "$0"; ${script}`, library], { env: { ...env, ...extra }, encoding: "utf8", timeout: 10_000 });
  return { env, start, hold, run };
}

async function waitFor(child, pattern, stream = "err") {
  for (let waited = 0; waited < 10_000; waited += 50) {
    if (pattern.test(child[stream])) return;
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`no ${pattern} in ${stream}: ${child[stream]}`);
}

test("a run waits while every slot is taken and starts when one frees", async (t) => {
  const box = machine(t, 2);
  const first = box.hold();
  await waitFor(first, /ready/, "out");
  const second = box.hold();
  await waitFor(second, /ready/, "out");
  const third = box.hold();
  await waitFor(third, /check-slot: waiting for 1 free of 2 slots/);
  assert.doesNotMatch(third.err, /took slot/);
  first.stdin.end();
  await waitFor(third, /check-slot: took slot 1 of 2 at .* after \d+s/);
});

test("a nested run uses its caller's slot instead of waiting for another", (t) => {
  const box = machine(t, 1);
  const result = box.run(`take_check_slots 1 && bash -c '. "$0"; take_check_slots 1 && echo nested ran' "$0"`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "nested ran\n");
  assert.equal(result.stderr.match(/took slot/g).length, 1);
});

test("a caller's slot counts toward a run that wants several", async (t) => {
  const box = machine(t, 2);
  const result = box.run(`take_check_slots 1 && bash -c '. "$0"; take_check_slots 2' "$0"`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /took slot 1 of 2[^]*took slot 2 of 2/);
});

test("a run that wants several slots holds none of them while it waits", async (t) => {
  const box = machine(t, 2);
  const holder = box.hold();
  await waitFor(holder, /ready/, "out");
  const stress = box.hold(2);
  await waitFor(stress, /waiting for 2 free of 2 slots/);
  const single = box.hold();
  await waitFor(single, /took slot 2 of 2/);
  holder.stdin.end();
  single.stdin.end();
  await waitFor(stress, /took slot 1 2 of 2/);
});

test("MA_CHECK_SLOTS=0 takes no slot and never waits", async (t) => {
  const box = machine(t, 1);
  const holder = box.hold();
  await waitFor(holder, /ready/, "out");
  const result = box.run("take_check_slots 3 && echo ran", { MA_CHECK_SLOTS: "0" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ran\n");
  assert.equal(result.stderr, "");
});

test("more slots than MA_CHECK_SLOTS, or a malformed MA_CHECK_SLOTS, fails at once", (t) => {
  const box = machine(t, 2);
  const many = box.run("take_check_slots 3");
  assert.equal(many.status, 2);
  assert.match(many.stderr, /3 slots wanted, but MA_CHECK_SLOTS is 2/);
  const malformed = box.run("take_check_slots 1", { MA_CHECK_SLOTS: "three" });
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /MA_CHECK_SLOTS must be a whole number/);
});

test("a process left behind after drop_check_slots does not keep the slot", async (t) => {
  const box = machine(t, 1);
  const left = box.start("bash", ["-c", `. "$0"; take_check_slots 1; ( drop_check_slots; exec sleep 60 ) >/dev/null 2>&1 & echo started`, library]);
  await left.done;
  assert.match(left.out, /started/);
  const next = box.run("take_check_slots 1");
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stderr, /took slot 1 of 1 at .* after 0s/);
});

test("check.sh waits for a slot before its first step", async (t) => {
  const box = machine(t, 1);
  const holder = box.hold();
  await waitFor(holder, /ready/, "out");
  const check = box.start("scripts/check.sh", ["--quick"]);
  await waitFor(check, /check-slot: waiting for 1 free of 1 slots/);
  assert.doesNotMatch(check.out, /Step logs/);
});

test("stress.sh takes one slot per run and refuses more runs than slots", (t) => {
  const { env } = machine(t, 2);
  const result = spawnSync("scripts/stress.sh", ["3"], { cwd: repo, env, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /3 slots wanted, but MA_CHECK_SLOTS is 2/);
  assert.doesNotMatch(result.stdout, /Stress logs/);
});
