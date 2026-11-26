import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const envLocal = import.meta.resolve("@modular-agent/env-local");
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		if (process.platform === "linux") return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
		return !/^Z/.test(spawnSync("ps", ["-p", String(pid), "-o", "state="], { encoding: "utf8" }).stdout.trim());
	} catch {
		return false;
	}
};
const until = async (check: () => boolean, ms = 5000) => {
	for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (check()) return true;
	return false;
};

/** An agent process that starts commands, then is killed with SIGKILL. */
function agentScript(dir: string, home: string, platform = process.platform): string {
	const file = join(dir, "agent.mjs");
	writeFileSync(file, `
import { LocalEnvironment, ProcessTracker } from ${JSON.stringify(envLocal)};
const env = new LocalEnvironment(${JSON.stringify(dir)}, new ProcessTracker(${JSON.stringify(join(home, "run"))}, ${JSON.stringify(platform)}));
const signal = new AbortController().signal;
// A command that leaves a process behind in its group, and one that escapes its group entirely.
await env.exec("sleep 60 & echo $! > bg.pid", { signal });
${platform === "linux" ? 'void env.exec("setsid sleep 61 & echo $! > escaped.pid; sleep 62", { signal });' : ""}
setInterval(() => {}, 1000);
console.log("ready");
`);
	return file;
}

for (const platform of new Set<NodeJS.Platform>([process.platform, "darwin"])) test(`${platform}: agent SIGKILL stops background commands in their group`, async t => {
	const dir = mkdtempSync(join(tmpdir(), "ma-proc-"));
	const home = mkdtempSync(join(tmpdir(), "ma-h-"));
	const agent = spawn(process.execPath, [agentScript(dir, home, platform)], { stdio: ["ignore", "pipe", "inherit"] });
	t.after(() => { agent.kill("SIGKILL"); });
	await new Promise<void>((r, reject) => {
		agent.once("exit", code => reject(new Error(`agent exited before ready: ${code}`)));
		agent.stdout.on("data", (d) => String(d).includes("ready") && r());
	});
	let escaped: number | undefined;
	if (platform === "linux") {
		assert.ok(await until(() => /^\d+\n$/.test(existsSync(join(dir, "escaped.pid")) ? readFileSync(join(dir, "escaped.pid"), "utf8") : "")));
		escaped = Number(readFileSync(join(dir, "escaped.pid"), "utf8"));
		assert.ok(alive(escaped));
	}
	const bg = Number(readFileSync(join(dir, "bg.pid"), "utf8"));
	assert.ok(alive(bg));
	agent.kill("SIGKILL");
	assert.ok(await until(() => !alive(bg)), "the background process in the command's group died with the agent");
	if (escaped !== undefined) assert.ok(await until(() => !alive(escaped!)), "the process that left its group died too");
});

test("Linux cannot start a command if the owner dies before registering its group", { skip: process.platform !== "linux" }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "ma-launch-barrier-"));
	const script = `import { writeFileSync } from 'node:fs';
		import { LocalEnvironment, ProcessTracker } from ${JSON.stringify(envLocal)};
		class InterruptedTracker extends ProcessTracker {
			started(pid) { writeFileSync('pid', String(pid)); process.kill(process.pid, 'SIGKILL'); }
		}
		const env = new LocalEnvironment(process.cwd(), new InterruptedTracker('run'));
		await env.exec('echo started > effect', { signal: new AbortController().signal });`;
	const owner = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: dir, stdio: "ignore" });
	assert.equal(await new Promise(resolve => owner.once("exit", (_, signal) => resolve(signal))), "SIGKILL");
	const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
	assert.ok(await until(() => !alive(pid)));
	assert.equal(existsSync(join(dir, "effect")), false);
});

test("Darwin groups stop on timeout, cancellation and session close", async t => {
	const dir = mkdtempSync(join(tmpdir(), "ma-proc-"));
	const { LocalEnvironment, ProcessTracker } = await import(envLocal);
	const tracker = new ProcessTracker(undefined, "darwin");
	t.after(async () => { await tracker.stopAll(); });
	const local = new LocalEnvironment(dir, tracker);
	assert.equal(local.containment, "processGroup");
	assert.deepEqual(local.platforms, ["darwin"]);
	assert.equal(local.safeToRepeat, false);
	const one = local.forSession("one"), two = local.forSession("two");
	const signal = new AbortController().signal;
	await one.exec("sleep 60 >/dev/null 2>&1 & echo $! > one", { signal });
	await two.exec("sleep 60 >/dev/null 2>&1 & echo $! > two", { signal });
	const onePid = Number(readFileSync(join(dir, "one"), "utf8"));
	const twoPid = Number(readFileSync(join(dir, "two"), "utf8"));
	assert.ok(alive(onePid) && alive(twoPid));
	await local.sessionEnded("one");
	assert.ok(await until(() => !alive(onePid)));
	assert.ok(alive(twoPid));

	const abort = new AbortController();
	let started!: () => void;
	const ready = new Promise<void>(resolve => { started = resolve; });
	const task = one.exec("trap '' TERM; echo $$ > foreground; printf ready; while :; do sleep 60; done", {
		signal: abort.signal, onOutput: started,
	});
	await ready;
	abort.abort();
	assert.deepEqual(await task, { exitCode: null, output: "ready", timedOut: false });
	assert.ok(await until(() => !alive(Number(readFileSync(join(dir, "foreground"), "utf8")))));

	const timeout = await one.exec("exec sleep 60", { signal, timeoutMs: 50 });
	assert.equal(timeout.exitCode, null);
	assert.equal(timeout.timedOut, true);
});

test("if the watcher dies too, the next agent to start cleans up", { skip: process.platform !== "linux" && "reads /proc" }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "ma-proc-"));
	const home = mkdtempSync(join(tmpdir(), "ma-h-"));
	const agent = spawn(process.execPath, [agentScript(dir, home)], { stdio: ["ignore", "pipe", "inherit"] });
	await new Promise<void>((r) => agent.stdout.on("data", (d) => String(d).includes("ready") && r()));
	const bg = Number(readFileSync(join(dir, "bg.pid"), "utf8"));
	// Find the watcher: the process whose command line names this home's run directory.
	const watcher = readdirSync("/proc").filter((p) => /^\d+$/.test(p)).find((p) => {
		try {
			const cmd = readFileSync(`/proc/${p}/cmdline`, "utf8");
			return cmd.includes("watcher.js") && cmd.includes(home);
		} catch {
			return false;
		}
	});
	assert.ok(watcher, "a watcher is running");
	process.kill(Number(watcher), "SIGKILL");
	const exited = new Promise((r) => agent.once("exit", r));
	agent.kill("SIGKILL");
	await exited; // reaped, so the agent's pid is gone, not a zombie
	await new Promise((r) => setTimeout(r, 500));
	assert.ok(alive(bg), "nothing cleaned up yet");
	const { ProcessTracker } = await import(envLocal);
	new ProcessTracker(join(home, "run"));
	assert.ok(await until(() => !alive(bg)), "the next agent's start swept it");
	assert.deepEqual(readdirSync(join(home, "run")), []);
});

test("an agent killed but not yet reaped (a zombie) counts as dead, so its leftovers are swept", { skip: process.platform !== "linux" && "reads /proc" }, async (t) => {
	const home = mkdtempSync(join(tmpdir(), "ma-h-"));
	const run = join(home, "run");
	mkdirSync(run);
	// The shell starts a child, then execs into `sleep`, which never reaps. The child dies only once the exec is seen,
	// so the shell cannot reap it first: it stays a zombie.
	// It leads its own process group, so cleanup stops the child too, even before its pid has been read.
	const holder = spawn("sh", ["-c", "sleep 30 & echo $!; exec sleep 30"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
	t.after(() => {
		try {
			process.kill(-(holder.pid as number), "SIGKILL");
		} catch {
			/* already gone */
		}
	});
	const zombie = Number(await new Promise<string>((resolve, reject) => {
		holder.stdout.once("data", (d) => resolve(String(d)));
		holder.stdout.once("close", () => reject(new Error("the holder closed its output without writing the child's pid")));
	}));
	assert.ok(await until(() => readFileSync(`/proc/${holder.pid}/comm`, "latin1") === "sleep\n"), "the holder has exec'd");
	process.kill(zombie, "SIGKILL");
	assert.ok(await until(() => readFileSync(`/proc/${zombie}/stat`, "latin1").split(") ")[1]?.startsWith("Z")), "the agent pid is a zombie");
	const runId = "zombie-test-run";
	const leftover = spawn("sleep", ["60"], { env: { ...process.env, MODULAR_AGENT_RUN: runId }, stdio: "ignore" });
	t.after(() => leftover.kill("SIGKILL"));
	await until(() => readFileSync(`/proc/${leftover.pid}/environ`, "latin1").includes(`MODULAR_AGENT_RUN=${runId}\0`));
	writeFileSync(join(run, "1-zombie.json"), JSON.stringify({ agentPid: zombie, runId, groups: [] }));
	const { ProcessTracker } = await import(envLocal);
	new ProcessTracker(run);
	assert.ok(await until(() => leftover.exitCode !== null || leftover.signalCode !== null), "the leftover was killed");
	assert.deepEqual(readdirSync(run), []);
});
