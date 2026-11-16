import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ExecResult, Plugin, WorkingEnvironment } from "@modular-agent/harness";

/** The local machine as the working environment. */
export class LocalEnvironment implements WorkingEnvironment {
	readonly id: string;
	constructor(readonly cwd: string) {
		this.id = `local:${cwd}`;
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
			const child = spawn("bash", ["-c", command], { cwd: this.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
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
			child.on("close", (code) => {
				if (timer) clearTimeout(timer);
				options.signal.removeEventListener("abort", onAbort);
				done({ exitCode: code, output, timedOut });
			});
		});
	}
}

export function localEnvironment(options: { cwd?: string } = {}): Plugin {
	return {
		name: "env-local",
		setup(api) {
			api.provide("working-environment", new LocalEnvironment(options.cwd ?? api.project));
		},
	};
}
