import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { join } from "node:path";
import type { ExecResult, Plugin, WorkingEnvironment } from "@modular-agent/harness";
import { ProcessTracker } from "./processes.js";

export { ProcessTracker, RUN_MARKER, markedProcesses } from "./processes.js";

/** The local machine as the working environment. */
export class LocalEnvironment implements WorkingEnvironment {
	readonly id: string;
	constructor(readonly cwd: string, private processes = new ProcessTracker()) {
		this.id = `local:${cwd}`;
	}
	at(cwd: string): WorkingEnvironment {
		return new LocalEnvironment(cwd, this.processes);
	}
	resolve(path: string): string {
		return isAbsolute(path) ? path : resolve(this.cwd, path);
	}
	readFile(path: string): Promise<Buffer> {
		return readFile(this.resolve(path));
	}
	async writeFile(path: string, data: string | Buffer): Promise<void> {
		const full = this.resolve(path);
		await mkdir(dirname(full), { recursive: true });
		await writeFile(full, data);
	}
	async exists(path: string): Promise<boolean> {
		try {
			await access(this.resolve(path));
			return true;
		} catch {
			return false;
		}
	}
	exec(command: string, options: { signal: AbortSignal; timeoutMs?: number; onOutput?(chunk: string): void }): Promise<ExecResult> {
		return new Promise((done) => {
			const child = spawn("bash", ["-c", command], { cwd: this.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: this.processes.env() });
			if (child.pid) this.processes.started(child.pid);
			let output = "";
			let timedOut = false;
			const kill = () => {
				try {
					if (child.pid) process.kill(-child.pid, "SIGKILL");
				} catch {
					/* already gone */
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
				if (child.pid) this.processes.ended(child.pid);
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

export function localEnvironment(options: { cwd?: string } = {}): Plugin {
	let stop = () => {};
	return {
		name: "env-local",
		setup(api) {
			// No command this agent starts outlives it: see ProcessTracker.
			const processes = new ProcessTracker(join(api.home, "run"));
			api.provide("working-environment", new LocalEnvironment(options.cwd ?? api.project, processes));
			stop = () => processes.stopAll();
		},
		stop: () => stop(),
	};
}
