import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { access, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { join } from "node:path";
import type { DirEntry, ExecResult, Plugin, WorkingEnvironment } from "@modular-agent/harness";
import { randomUUID } from "node:crypto";
import { GitPoints } from "./git-points.js";
import { SavedPoints } from "./points.js";
import { COMMAND_MARKER, markedProcesses, ProcessTracker } from "./processes.js";

export { GitPoints };
export { ProcessTracker, RUN_MARKER, COMMAND_MARKER, markedProcesses } from "./processes.js";

/** The local machine as the working environment. */
export class LocalEnvironment implements WorkingEnvironment {
	readonly id: string;
	get containment() { return this.processes.platform === "linux" ? "strong" : "processGroup"; }
	get safeToRepeat() { return this.containment === "strong"; }
	get platforms() { return [this.processes.platform]; }
	get points(): boolean { return this.keepsPoints(this.cwd); }
	keepsPoints(cwd: string): boolean {
		return !(this.snapshots instanceof GitPoints) || this.snapshots.keepsPoints(cwd);
	}
	get confinesFiles(): boolean { return this.root !== undefined; }
	constructor(readonly cwd: string, private processes = new ProcessTracker(), private sessionId?: string, private snapshots: SavedPoints | GitPoints = new SavedPoints(), private root?: string) {
		this.id = `local:${cwd}`;
	}
	at(cwd: string): WorkingEnvironment {
		return new LocalEnvironment(cwd, this.processes, this.sessionId, this.snapshots, this.root);
	}
	forSession(sessionId: string): WorkingEnvironment {
		return new LocalEnvironment(this.cwd, this.processes, sessionId, this.snapshots, this.root);
	}
	async sessionEnded(sessionId: string): Promise<void> {
		await this.processes.stopSession(sessionId);
		// Kept until the environment stops, so a session reopened here still has its points.
	}
	save(): Promise<string> {
		return this.confined(".").then(cwd => this.snapshots.save(cwd, this.sessionId));
	}
	hasPoint(point: string): Promise<boolean> {
		return this.confined(".").then(cwd => this.snapshots.has(cwd, point, this.sessionId));
	}

	restore(point: string): Promise<void> {
		return this.confined(".").then(cwd => this.snapshots.restore(cwd, point, this.sessionId));
	}
	resolve(path: string): string {
		return isAbsolute(path) ? path : resolve(this.cwd, path);
	}
	private async confined(path: string): Promise<string> {
		const full = this.resolve(path);
		if (!this.root) return full;
		const within = (p: string) => {
			const rel = relative(this.root!, p);
			if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
				throw Object.assign(new Error("Path is outside the project"), { code: "invalid_request" });
			}
		};
		within(full);
		let current = full;
		for (;;) {
			try { within(await realpath(current)); return full; }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" || current === this.root) throw error;
				// A dangling link cannot be treated as a missing file on write.
				if (await lstat(current).catch(e => { if (e.code !== "ENOENT") throw e; })) throw error;
				current = dirname(current);
			}
		}
	}
	async readFile(path: string): Promise<Buffer> {
		return readFile(await this.confined(path));
	}
	async writeFile(path: string, data: string | Buffer): Promise<void> {
		const full = await this.confined(path);
		await mkdir(dirname(full), { recursive: true });
		await writeFile(full, data);
	}
	async list(path: string): Promise<DirEntry[]> {
		if (typeof path !== "string" || !path || path.includes("\0")) throw Object.assign(new Error("Invalid directory path"), { code: "invalid_request" });
		try {
			return (await readdir(await this.confined(path), { withFileTypes: true })).map(entry => ({
				name: entry.name, kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
			}));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") throw Object.assign(new Error("Directory does not exist"), { code: "not_found" });
			if (code === "ENOTDIR" || code === "EACCES" || code === "EPERM") {
				throw Object.assign(new Error("Not an accessible directory"), { code: "invalid_request" });
			}
			throw error;
		}
	}
	async exists(path: string): Promise<boolean> {
		try {
			await access(await this.confined(path));
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "invalid_request") throw error;
			return false;
		}
	}
	async exec(command: string, options: { signal: AbortSignal; timeoutMs?: number; onOutput?(chunk: string): void }): Promise<ExecResult> {
		const cwd = await this.confined(".");
		if (options.signal.aborted) return { exitCode: null, output: "", timedOut: false };
		if (this.processes.groups) return this.processes.groups.exec(cwd, command, this.sessionId, options);
		return new Promise((done) => {
			const commandId = randomUUID();
			// The launcher owns the process group but cannot start bash until the
			// owner has saved its identity and started the cleanup watcher. Owner
			// loss before that boundary closes fd 3 without releasing the command.
			const launch = 'read -r start <&3 && [ "$start" = start ] || exit 1; exec 3<&-; exec bash -c "$1"';
			const child = spawn("/bin/sh", ["-c", launch, "ma-launch", command], { cwd, stdio: ["ignore", "pipe", "pipe", "pipe"], detached: true, env: { ...this.processes.env(), [COMMAND_MARKER]: commandId } });
			const control = child.stdio[3] as Writable;
			control.on("error", () => {}); // A killed launcher cannot execute the command.
			if (child.pid) {
				try { this.processes.started(child.pid, commandId, this.sessionId); }
				catch (error) { control.destroy(); throw error; }
				control.end("start\n");
			}
			let output = "";
			let timedOut = false;
			const kill = () => {
				try {
					if (child.pid) process.kill(-child.pid, "SIGKILL");
				} catch {
					/* already gone */
				}
				// Cancelling also reaches processes that left the group, such as with setsid (Linux).
				for (const pid of markedProcesses(commandId, COMMAND_MARKER)) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						/* gone */
					}
				}
			};
			const timer = options.timeoutMs ? setTimeout(() => ((timedOut = true), kill()), options.timeoutMs) : undefined;
			const onAbort = () => kill();
			options.signal.addEventListener("abort", onAbort, { once: true });
			const collect = (chunk: Buffer) => {
				const text = chunk.toString("utf8");
				output += text;
				options.onOutput?.(text);
			};
			child.stdout!.on("data", collect);
			child.stderr!.on("data", collect);
			let finished = false;
			const finish = (code: number | null) => {
				if (finished) return;
				finished = true;
				if (child.pid) this.processes.ended(child.pid, commandId);
				if (timer) clearTimeout(timer);
				options.signal.removeEventListener("abort", onAbort);
				child.stdout!.destroy();
				child.stderr!.destroy();
				done({ exitCode: code, output, timedOut });
			};
			child.on("close", (code) => finish(code));
			// A command that starts a background process ends when bash exits, not when the
			// background process lets go of the output. Leave a moment for the last output.
			child.on("exit", (code) => setTimeout(() => finish(code), 100));
		});
	}
}

export function localEnvironment(options: { cwd?: string; confineFiles?: boolean; points?: "copy" | "git"; stateDir?: string } = {}): Plugin {
	let stop: () => void | Promise<void> = () => {};
	return {
		name: "env-local",
		spawn: { module: "@modular-agent/env-local", export: "localEnvironment", options },
		setup(api) {
			// No command this agent starts outlives it: see ProcessTracker.
			const stateDir = options.stateDir ?? api.home;
			const processes = new ProcessTracker(join(stateDir, "run"));
			const snapshots = options.points === "copy" ? new SavedPoints(stateDir) : new GitPoints(stateDir);
			api.provide("working-environment", new LocalEnvironment(options.cwd ?? api.project, processes, undefined, snapshots, options.confineFiles ? api.project : undefined));
			stop = async () => { await processes.stopAll(); await snapshots.stop(); };
		},
		stop: () => stop(),
	};
}
