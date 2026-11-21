import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExecResult } from "@modular-agent/harness";
import type { Readable, Writable } from "node:stream";

const watcher = fileURLToPath(new URL("./group-watcher.js", import.meta.url));
type Group = { session?: string; stop(): Promise<void>; };
type ExecOptions = { signal: AbortSignal; timeoutMs?: number; onOutput?(chunk: string): void };

export class Groups {
	private active = new Set<Group>();

	async stop(session?: string) {
		await Promise.all([...this.active].filter(g => session === undefined || g.session === session).map(g => g.stop()));
	}

	async exec(cwd: string, command: string, session: string | undefined, options: ExecOptions): Promise<ExecResult> {
		const child = spawn(process.execPath, [watcher, command], { cwd, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
		const control = child.stdin as Writable & { unref?(): void };
		const result = child.stdio[3] as Readable;
		const streams = [child.stdout!, child.stderr!];
		let output = "", timedOut = false, stopping = false;
		for (const stream of streams) {
			stream.setEncoding("utf8").on("data", (chunk: string) => {
				output += chunk;
				options.onOutput?.(chunk);
			});
		}
		control.on("error", () => {}); // EOF/exit determines whether cleanup succeeded.
		let launchError: Error | undefined;
		child.on("error", error => { launchError = error; });
		const exited = new Promise<string | null>(resolve => {
			child.once("exit", (_, signal) => resolve(signal));
			child.once("error", () => resolve(null));
		});
		const group: Group = { session, stop: async () => {
			stopping = true;
			control.destroy();
			if (await exited !== "SIGKILL") throw Object.assign(new Error("Command group cleanup was not confirmed"), { code: "lost" });
		} };
		this.active.add(group);
		// Keep an unexpectedly lost supervisor in the session until stop can report loss.
		void exited.then(signal => { if (signal === "SIGKILL" && stopping || launchError) this.active.delete(group); });
		const stop = () => { void group.stop().catch(() => {}); };
		options.signal.addEventListener("abort", stop, { once: true });
		if (options.signal.aborted) stop();
		const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs) : undefined;
		try {
			let frame = "";
			result.setEncoding("utf8");
			for await (const chunk of result) frame += chunk;
			if (launchError) throw launchError;
			if (!frame && !stopping) throw Object.assign(new Error("Command supervisor stopped without a result"), { code: "lost" });
			if (timer) clearTimeout(timer);
			// The command may leave background writers. Forward buffered output but do not wait for those writers.
			let drain: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				Promise.all(streams.map(stream => stream.readableEnded ? Promise.resolve() : new Promise(resolve => stream.once("end", resolve)))),
				new Promise(resolve => { drain = setTimeout(resolve, 100); }),
			]);
			clearTimeout(drain);
			if (stopping) {
				await group.stop();
				return { exitCode: null, output, timedOut };
			}
			const { code, error } = JSON.parse(frame);
			if (error) { await group.stop(); throw new Error(error); }
			return { exitCode: code, output, timedOut };
		} finally {
			if (timer) clearTimeout(timer);
			options.signal.removeEventListener("abort", stop);
			for (const stream of streams) stream.destroy();
			child.unref();
			control.unref?.();
		}
	}
}
