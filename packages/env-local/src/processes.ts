import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Every command this agent starts carries this variable, so its processes can be found after the agent dies. */
export const RUN_MARKER = "MODULAR_AGENT_RUN";
/** Every command also carries its own marker, so cancelling one command reaches what it started, even outside its process group. */
export const COMMAND_MARKER = "MODULAR_AGENT_COMMAND";

interface RunFile { agentPid: number; runId: string; groups: number[] }

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

const killGroup = (pgid: number) => {
	try {
		process.kill(-pgid, "SIGKILL");
	} catch {
		/* already gone */
	}
};

/** Linux only: the processes whose environment carries this run's marker. Exact, so it is safe after pids are reused. */
export function markedProcesses(runId: string, marker = RUN_MARKER): number[] {
	let pids: string[];
	try {
		pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
	} catch {
		return [];
	}
	const needle = `${marker}=${runId}\0`;
	return pids.filter((pid) => {
		try {
			return readFileSync(`/proc/${pid}/environ`, "latin1").includes(needle);
		} catch {
			return false;
		}
	}).map(Number);
}

/** Kill what a dead agent left running, then forget it. */
export function cleanUp(file: string): void {
	let run: RunFile;
	try {
		run = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		rmSync(file, { force: true });
		return;
	}
	if (alive(run.agentPid)) return;
	for (const pgid of run.groups) killGroup(pgid);
	for (const pid of markedProcesses(run.runId)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* gone */
		}
	}
	rmSync(file, { force: true });
}

/**
 * The processes the local environment starts, tracked so that none outlives the
 * agent. A small watcher process kills them as soon as the agent dies, however
 * it dies; a sweep when the next agent starts catches anything the watcher missed.
 */
export class ProcessTracker {
	readonly runId = randomUUID();
	private groups = new Set<number>();
	private file?: string;
	private watcher = false;

	constructor(private runDir?: string) {
		if (!runDir) return;
		mkdirSync(runDir, { recursive: true });
		for (const name of readdirSync(runDir)) if (name.endsWith(".json")) cleanUp(join(runDir, name));
		this.file = join(runDir, `${process.pid}-${this.runId.slice(0, 8)}.json`);
	}

	env(): NodeJS.ProcessEnv {
		return { ...process.env, [RUN_MARKER]: this.runId };
	}

	started(pgid: number): void {
		this.groups.add(pgid);
		this.save();
		this.watch();
	}

	ended(pgid: number): void {
		// A command may leave background processes in its group. Keep the group until it is empty.
		if (alive(-pgid)) return;
		this.groups.delete(pgid);
		this.save();
	}

	/** Stop everything still running. Called when the agent stops cleanly. */
	stopAll(): void {
		for (const pgid of this.groups) killGroup(pgid);
		this.groups.clear();
		if (this.file) rmSync(this.file, { force: true });
	}

	private save(): void {
		if (!this.file) return;
		const run: RunFile = { agentPid: process.pid, runId: this.runId, groups: [...this.groups] };
		writeFileSync(this.file, JSON.stringify(run));
	}

	private watch(): void {
		if (this.watcher || !this.file) return;
		this.watcher = true;
		const script = fileURLToPath(new URL("./watcher.js", import.meta.url));
		const child = spawn(process.execPath, [script, String(process.pid), this.file], { detached: true, stdio: "ignore" });
		child.unref();
	}
}
