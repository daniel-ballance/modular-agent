import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const envLocal = import.meta.resolve("@modular-agent/env-local");
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const until = async (check: () => boolean, ms = 5000) => {
	for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (check()) return true;
	return false;
};

/** An agent process that starts commands, then is killed with SIGKILL. */
function agentScript(dir: string, home: string): string {
	const file = join(dir, "agent.mjs");
	writeFileSync(file, `
import { LocalEnvironment, ProcessTracker } from ${JSON.stringify(envLocal)};
const env = new LocalEnvironment(${JSON.stringify(dir)}, new ProcessTracker(${JSON.stringify(join(home, "run"))}));
const signal = new AbortController().signal;
// A command that leaves a process behind in its group, and one that escapes its group entirely.
await env.exec("sleep 60 & echo $! > bg.pid", { signal });
void env.exec("setsid sleep 61 & echo $! > escaped.pid; sleep 62", { signal });
setInterval(() => {}, 1000);
console.log("ready");
`);
	return file;
}

test("no command outlives an agent killed with SIGKILL", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ma-proc-"));
	const home = mkdtempSync(join(tmpdir(), "ma-h-"));
	const agent = spawn(process.execPath, [agentScript(dir, home)], { stdio: ["ignore", "pipe", "inherit"] });
	await new Promise<void>((r) => agent.stdout.on("data", (d) => String(d).includes("ready") && r()));
	assert.ok(await until(() => existsSync(join(dir, "escaped.pid"))));
	const bg = Number(readFileSync(join(dir, "bg.pid"), "utf8"));
	const escaped = Number(readFileSync(join(dir, "escaped.pid"), "utf8"));
	assert.ok(alive(bg) && alive(escaped), "both are running while the agent lives");
	agent.kill("SIGKILL");
	assert.ok(await until(() => !alive(bg)), "the background process in the command's group died with the agent");
	if (process.platform === "linux") assert.ok(await until(() => !alive(escaped)), "the process that left its group died too");
	else process.kill(escaped, "SIGKILL");
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

test("an agent killed but not yet reaped (a zombie) counts as dead, so its leftovers are swept", { skip: process.platform !== "linux" && "reads /proc" }, async () => {
	const home = mkdtempSync(join(tmpdir(), "ma-h-"));
	const run = join(home, "run");
	mkdirSync(run);
	// `sleep 0` exits and its parent execs into `sleep 5`, which never reaps it: a zombie.
	const holder = spawn("sh", ["-c", "sleep 0 & echo $!; exec sleep 5"], { stdio: ["ignore", "pipe", "ignore"] });
	const zombie = Number(await new Promise<string>((r) => holder.stdout.once("data", (d) => r(String(d)))));
	assert.ok(await until(() => readFileSync(`/proc/${zombie}/stat`, "latin1").split(") ")[1]?.startsWith("Z")), "the agent pid is a zombie");
	const runId = "zombie-test-run";
	const leftover = spawn("sleep", ["60"], { env: { ...process.env, MODULAR_AGENT_RUN: runId }, stdio: "ignore" });
	await until(() => readFileSync(`/proc/${leftover.pid}/environ`, "latin1").includes(`MODULAR_AGENT_RUN=${runId}\0`));
	writeFileSync(join(run, "1-zombie.json"), JSON.stringify({ agentPid: zombie, runId, groups: [] }));
	const { ProcessTracker } = await import(envLocal);
	new ProcessTracker(run);
	assert.ok(await until(() => leftover.exitCode !== null || leftover.signalCode !== null), "the leftover was killed");
	assert.deepEqual(readdirSync(run), []);
	holder.kill("SIGKILL");
});
