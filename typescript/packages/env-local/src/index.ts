import { spawn } from "node:child_process";
import { access, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { join } from "node:path";
import type { ExecResult, Plugin, WorkingEnvironment } from "@modular-agent/harness";
import { randomUUID } from "node:crypto";
import { SavedPoints } from "./points.js";
import { COMMAND_MARKER, markedProcesses, ProcessTracker } from "./processes.js";

export { ProcessTracker, RUN_MARKER, COMMAND_MARKER, markedProcesses } from "./processes.js";

/** The local machine as the working environment. */
export class LocalEnvironment implements WorkingEnvironment {
	readonly id: string;
	readonly containment = process.platform === "linux" ? "strong" : "processGroup";
	readonly safeToRepeat = this.containment === "strong";
	readonly points = true;
	constructor(readonly cwd: string, private processes = new ProcessTracker(), private sessionId?: string, private snapshots = new SavedPoints(), private root?: string) {
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
		return this.snapshots.save(this.cwd, this.sessionId);
	}
	hasPoint(point: string): Promise<boolean> {
		return this.snapshots.has(this.cwd, point, this.sessionId);
	}

	restore(point: string): Promise<void> {
		return this.snapshots.restore(this.cwd, point, this.sessionId);
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
	async exists(path: string): Promise<boolean> {
		try {
			await access(await this.confined(path));
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "invalid_request") throw error;
			return false;
		}
	}
	exec(command: string, options: { signal: AbortSignal; timeoutMs?: number; onOutput?(chunk: string): void }): Promise<ExecResult> {
		if (options.signal.aborted) return Promise.resolve({ exitCode: null, output: "", timedOut: false });
		return new Promise((done) => {
			const commandId = randomUUID();
			const child = spawn("bash", ["-c", command], { cwd: this.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...this.processes.env(), [COMMAND_MARKER]: commandId } });
			if (child.pid) this.processes.started(child.pid, commandId, this.sessionId);
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
			child.stdout.on("data", collect);
			child.stderr.on("data", collect);
			let finished = false;
			const finish = (code: number | null) => {
				if (finished) return;
				finished = true;
				if (child.pid) this.processes.ended(child.pid, commandId);
				if (timer) clearTimeout(timer);
				options.signal.removeEventListener("abort", onAbort);
				child.stdout.destroy();
				child.stderr.destroy();
				done({ exitCode: code, output, timedOut });
			};
			child.on("close", (code) => finish(code));
			// A command that starts a background process ends when bash exits, not when the
			// background process lets go of the output. Leave a moment for the last output.
			child.on("exit", (code) => setTimeout(() => finish(code), 100));
		});
	}
}

export function localEnvironment(options: { cwd?: string; confineFiles?: boolean } = {}): Plugin {
	let stop: () => void | Promise<void> = () => {};
	return {
		name: "env-local",
		spawn: { module: "@modular-agent/env-local", export: "localEnvironment", options },
		setup(api) {
			// No command this agent starts outlives it: see ProcessTracker.
			const processes = new ProcessTracker(join(api.home, "run"));
			const snapshots = new SavedPoints(api.home);
			api.provide("working-environment", new LocalEnvironment(options.cwd ?? api.project, processes, undefined, snapshots, options.confineFiles ? api.project : undefined));
			stop = async () => { processes.stopAll(); await snapshots.stop(); };
		},
		stop: () => stop(),
	};
}
