import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    child.exited = new Promise((resolve) => child.on("exit", resolve));
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms, "timed out"));

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

test("two runs that each hold a slot and ask for more both fail instead of waiting on each other", async (t) => {
  const box = machine(t, 2);
  const nested = `bash -c '. "$0"; take_check_slots 2' "$0"`;
  const runs = [1, 2].map(() => box.start("bash", ["-c", `. "$0"; take_check_slots 1 || exit; echo ready; read -r _; ${nested}`, library]));
  for (const run of runs) await waitFor(run, /ready/, "out");
  for (const run of runs) run.stdin.end();
  for (const run of runs) {
    assert.equal(await Promise.race([run.done, delay(10_000)]), 2, run.err);
    assert.match(run.err, /already holds a check slot \(MA_CHECK_SLOT_HELD\), so it cannot wait for 1 more/);
  }
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
  for (const slots of ["65", "18446744073709551616", "-1", "1e3", " 2", "three"]) {
    const malformed = box.run("take_check_slots 1", { MA_CHECK_SLOTS: slots });
    assert.equal(malformed.status, 2, `MA_CHECK_SLOTS=${slots}: ${malformed.stderr}`);
    assert.match(malformed.stderr, /MA_CHECK_SLOTS must be a whole number from 0 to 64/);
  }
});

test("MA_CHECK_SLOTS with leading zeros is read as decimal", (t) => {
  const box = machine(t, 2);
  const eight = box.run("take_check_slots 8", { MA_CHECK_SLOTS: "08" });
  assert.equal(eight.status, 0, eight.stderr);
  assert.match(eight.stderr, /took slot 1 2 3 4 5 6 7 8 of 8/);
  const ten = box.run("take_check_slots 10", { MA_CHECK_SLOTS: "010" });
  assert.equal(ten.status, 0, ten.stderr);
  assert.match(ten.stderr, /took slot 1 2 3 4 5 6 7 8 9 10 of 10/);
  const padded = box.run("take_check_slots 8", { MA_CHECK_SLOTS: "00000000000000000008" });
  assert.equal(padded.status, 0, padded.stderr);
  assert.match(padded.stderr, /took slot 1 2 3 4 5 6 7 8 of 8/);
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

// The interface the slot wrapper in ~/.cache/ma-std-tmp follows: hold the lock
// on a descriptor, export its number and MA_CHECK_SLOT_HELD, then exec the run.
const wrapper = String.raw`
  dir="$HOME/.cache/ma-std-tmp/slots"; mkdir -p "$dir"
  exec {fd}>"$dir/slot-1.lock"; flock -n "$fd" || exit 9
  export MA_CHECK_SLOT_HELD=1 MA_CHECK_SLOT_FD=$fd
  exec "$@"`;

test("a process left behind by a step does not keep the slot a wrapper handed over", async (t) => {
  const box = machine(t, 1);
  const run = `. "$0"; take_check_slots 1 || exit
    ( drop_check_slots; echo "fd=\${MA_CHECK_SLOT_FD-unset}"; exec sleep 60 >/dev/null ) 2>/dev/null & echo started`;
  const left = box.start("bash", ["-c", wrapper, "wrapper", "bash", "-c", run, library]);
  await left.done;
  const next = box.run("take_check_slots 1");
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stderr, /took slot 1 of 1 at .* after 0s/);
  assert.match(left.out, /started/);
  assert.match(left.out, /fd=unset/);
});

test("a child under MA_CHECK_SLOTS=0 does not keep the slot a wrapper handed over", async (t) => {
  const box = machine(t, 1);
  const run = `. "$0"; take_check_slots 1 || exit
    ( drop_check_slots; exec sleep 60 >/dev/null ) 2>/dev/null & echo started`;
  const left = box.start("bash", ["-c", wrapper, "wrapper", "bash", "-c", run, library], { MA_CHECK_SLOTS: "0" });
  await left.done;
  assert.match(left.out, /started/);
  const next = box.run("take_check_slots 1");
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stderr, /took slot 1 of 1 at .* after 0s/);
});

test("a handed-over MA_CHECK_SLOT_FD must name an open descriptor", (t) => {
  const box = machine(t, 1);
  for (const fd of ["9", "0", "x", "18446744073709551616"]) {
    const result = box.run("take_check_slots 1", { MA_CHECK_SLOT_HELD: "1", MA_CHECK_SLOT_FD: fd });
    assert.equal(result.status, 2, `MA_CHECK_SLOT_FD=${fd}: ${result.stderr}`);
    assert.match(result.stderr, /MA_CHECK_SLOT_FD must be the number of an open descriptor on a slot file/);
  }
});

test("a handed-over MA_CHECK_SLOT_FD is accepted only while some process holds its slot file's lock", (t) => {
  const box = machine(t, 1);
  const open = String.raw`dir="$HOME/.cache/ma-std-tmp/slots"; mkdir -p "$dir"; exec 7>"$dir/slot-2.lock"`;
  const unlocked = box.run(`${open}; take_check_slots 1`, { MA_CHECK_SLOT_HELD: "1", MA_CHECK_SLOT_FD: "7" });
  assert.equal(unlocked.status, 2, unlocked.stderr);
  assert.match(unlocked.stderr, /MA_CHECK_SLOT_FD 7 is open on .*slot-2\.lock, but no process holds its lock/);
  const locked = box.run(`${open}; flock -n 7 || exit 9; take_check_slots 1`, { MA_CHECK_SLOT_HELD: "1", MA_CHECK_SLOT_FD: "7" });
  assert.equal(locked.status, 0, locked.stderr);
  const broken = box.run(`${open}; flock() { echo "flock: command not found" >&2; return 127; }; take_check_slots 1`, { MA_CHECK_SLOT_HELD: "1", MA_CHECK_SLOT_FD: "7" });
  assert.equal(broken.status, 2, broken.stderr);
  assert.match(broken.stderr, /but no process holds its lock/);
});

test("check.sh waits for a slot before its first step", async (t) => {
  const box = machine(t, 1);
  const holder = box.hold();
  await waitFor(holder, /ready/, "out");
  const check = box.start("scripts/check.sh", ["--quick"]);
  await waitFor(check, /check-slot: waiting for 1 free of 1 slots/);
  assert.doesNotMatch(check.out, /Step logs/);
});

test("check.sh killed outright frees its slot while its lanes still run", async (t) => {
  const box = machine(t, 1);
  const bin = mkdtempSync(join(tmpdir(), "check-slot-bin-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  // node and npm pass at once, so the run reaches its rust lane, where mise only sleeps.
  for (const tool of ["node", "npm"]) writeFileSync(join(bin, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "mise"), `#!/bin/sh\ntouch "${bin}/lane"\nexec sleep 60\n`, { mode: 0o755 });
  const check = box.start("scripts/check.sh", ["rust"], { PATH: `${bin}:${process.env.PATH}` });
  for (let waited = 0; !existsSync(join(bin, "lane")); waited += 50) {
    if (waited > 10_000) assert.fail(`the rust lane did not start: ${check.out}${check.err}`);
    await delay(50);
  }
  process.kill(check.pid, "SIGKILL");
  await check.exited;
  const next = box.run("take_check_slots 1");
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stderr, /after 0s/);
});

test("stress.sh reads its arguments before it waits for slots", async (t) => {
  const box = machine(t, 1);
  const holder = box.hold();
  await waitFor(holder, /ready/, "out");
  const help = spawnSync("scripts/stress.sh", ["1", "--help"], { cwd: repo, env: box.env, encoding: "utf8", timeout: 10_000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: scripts\/stress\.sh N/);
  const bogus = spawnSync("scripts/stress.sh", ["1", "--bogus"], { cwd: repo, env: box.env, encoding: "utf8", timeout: 10_000 });
  assert.equal(bogus.status, 2, bogus.stderr);
  assert.match(bogus.stderr, /unknown argument: --bogus/);
});

// A copy of stress.sh in a scratch repository whose check.sh only sleeps.
function fakeStress(t, box) {
  const dir = mkdtempSync(join(tmpdir(), "check-slot-stress-"));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "pids"));
  for (const file of ["stress.sh", "check-slot.sh"]) copyFileSync(join(repo, "scripts", file), join(dir, "scripts", file));
  writeFileSync(join(dir, "scripts/check.sh"), `#!/usr/bin/env bash\nsleep 60 & echo $! >"${dir}/pids/.$$" && mv "${dir}/pids/.$$" "${dir}/pids/$$"\nwait\n`, { mode: 0o755 });
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["add", "."], { cwd: dir });
  const pids = () => readdirSync(join(dir, "pids"))
    .filter((name) => !name.startsWith("."))
    .flatMap((name) => [Number(name), Number(readFileSync(join(dir, "pids", name), "utf8"))])
    .filter((pid) => pid > 0);
  t.after(() => {
    for (const pid of pids()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const start = async (count) => {
    const stress = box.start(join(dir, "scripts/stress.sh"), [String(count)]);
    await waitFor(stress, /took slot/);
    for (let waited = 0; pids().length < 2 * count; waited += 50) {
      if (waited > 10_000) assert.fail(`the runs did not start: ${stress.err}`);
      await delay(50);
    }
    return stress;
  };
  return { start, pids, dir };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("stopping stress.sh stops its runs and frees its slots", async (t) => {
  const box = machine(t, 2);
  const fake = fakeStress(t, box);
  const stress = await fake.start(2);
  process.kill(stress.pid, "SIGTERM");
  assert.notEqual(await Promise.race([stress.exited, delay(10_000)]), "timed out");
  const next = box.run("take_check_slots 2");
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stderr, /after 0s/);
  for (let waited = 0; fake.pids().some(alive); waited += 50) {
    if (waited > 5_000) assert.fail(`runs still alive: ${fake.pids().filter(alive)}`);
    await delay(50);
  }
});

test("stress.sh killed outright frees its slots", async (t) => {
  const box = machine(t, 2);
  const fake = fakeStress(t, box);
  const stress = await fake.start(2);
  process.kill(stress.pid, "SIGKILL");
  await stress.exited;
  const next = box.run("take_check_slots 2");
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stderr, /after 0s/);
});

test("stress.sh for two runs inside a slot wrapper exits 2, even under MA_CHECK_SLOTS=0", async (t) => {
  const box = machine(t, 1);
  const fake = fakeStress(t, box);
  const stress = box.start("bash", ["-c", wrapper, "wrapper", join(fake.dir, "scripts/stress.sh"), "2"], { MA_CHECK_SLOTS: "0" });
  assert.equal(await Promise.race([stress.done, delay(10_000)]), 2, stress.out + stress.err);
  assert.match(stress.err, /already holds a check slot \(MA_CHECK_SLOT_HELD\), so it cannot wait for 1 more/);
  assert.doesNotMatch(stress.out, /Stress logs/);
});

for (const [phase, flag] of [["archives the sources", "c"], ["extracts a run's sources", "x"]]) {
  test(`stress.sh killed while it ${phase} frees its slot`, async (t) => {
    const box = machine(t, 1);
    const fake = fakeStress(t, box);
    const tar = spawnSync("bash", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
    const bin = join(fake.dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "tar"), `#!/bin/sh\ncase "$1" in -${flag}*) touch "${bin}/started"; exec sleep 60 ;; esac\nexec "${tar}" "$@"\n`, { mode: 0o755 });
    const stress = box.start(join(fake.dir, "scripts/stress.sh"), ["1"], { PATH: `${bin}:${process.env.PATH}` });
    for (let waited = 0; !existsSync(join(bin, "started")); waited += 50) {
      if (waited > 10_000) assert.fail(`tar -${flag} did not start: ${stress.out}${stress.err}`);
      await delay(50);
    }
    process.kill(stress.pid, "SIGKILL");
    await stress.exited;
    const next = box.run("take_check_slots 1");
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stderr, /took slot 1 of 1 at .* after 0s/);
  });
}

test("stress.sh takes one slot per run and refuses more runs than slots", (t) => {
  const { env } = machine(t, 2);
  const result = spawnSync("scripts/stress.sh", ["3"], { cwd: repo, env, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /3 slots wanted, but MA_CHECK_SLOTS is 2/);
  assert.doesNotMatch(result.stdout, /Stress logs/);
});
