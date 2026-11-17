import { join, resolve, sep } from "node:path";
import type { ExecResult, Plugin, WorkingEnvironment } from "@modular-agent/harness";
import { LocalEnvironment, ProcessTracker } from "@modular-agent/env-local";
import { call, type ClientOptions, HttpError, ndjson, serve, stream } from "./http.js";

/**
 * A working environment as a service: a sandbox rooted at one folder. Paths and
 * working directories outside the root are refused. A command stops when the
 * agent that started it disconnects, so nothing it starts outlives the agent's
 * interest in it, wherever the agent runs.
 */
export async function environmentService(options: { root: string; token: string; port?: number; runDir?: string }) {
	const root = resolve(options.root);
	const local = new LocalEnvironment(root, new ProcessTracker(options.runDir ?? join(root, ".modular-agent", "run")));
	const inside = (path: string) => {
		const full = resolve(root, path);
		if (full !== root && !full.startsWith(root + sep)) throw new HttpError(403, `${path} is outside this environment`);
		return full;
	};
	const at = (cwd?: string, sessionId?: string): WorkingEnvironment => {
		const scoped = sessionId ? local.forSession(sessionId) : local;
		return cwd && scoped.at ? scoped.at(inside(cwd)) as WorkingEnvironment : scoped;
	};
	return serve(
		[
			["POST", /^\/read$/, async (req) => {
				const env = await at(req.body.cwd);
				return { data: (await env.readFile(inside(resolve(env.cwd, req.body.path)))).toString("base64") };
			}],
			["POST", /^\/write$/, async (req) => {
				const env = await at(req.body.cwd);
				await env.writeFile(inside(resolve(env.cwd, req.body.path)), Buffer.from(req.body.data, "base64"));
				return {};
			}],
			["POST", /^\/exists$/, async (req) => {
				const env = await at(req.body.cwd);
				return { exists: await env.exists(inside(resolve(env.cwd, req.body.path))) };
			}],
			["POST", /^\/session-ended$/, async (req) => {
				if (typeof req.body?.sessionId !== "string") throw new HttpError(400, "sessionId is required");
				await local.sessionEnded(req.body.sessionId);
				return {};
			}],
			["POST", /^\/exec$/, async (req, res) => {
				const env = at(req.body.cwd, req.body.sessionId);
				const write = ndjson(res);
				const abort = new AbortController();
				let finished = false;
				// The agent hung up, cancelled, or died: stop the command.
				res.on("close", () => finished || abort.abort());
				const result = await env.exec(String(req.body.command), { signal: abort.signal, timeoutMs: req.body.timeoutMs, onOutput: (chunk) => write({ output: chunk }) });
				finished = true;
				write({ result });
				res.end();
			}],
		],
		{ port: options.port, token: options.token },
	);
}

/** A working environment reached over HTTP. Reading and writing files are safe to repeat; running a command is not, so only it is never retried. */
export class HttpEnvironment implements WorkingEnvironment {
	readonly id: string;
	constructor(private client: ClientOptions, readonly cwd: string, private sessionId?: string) {
		this.id = `http:${client.url}:${cwd}`;
	}
	at(cwd: string): WorkingEnvironment {
		return new HttpEnvironment(this.client, cwd, this.sessionId);
	}
	forSession(sessionId: string): WorkingEnvironment {
		return new HttpEnvironment(this.client, this.cwd, sessionId);
	}
	async sessionEnded(sessionId: string): Promise<void> {
		await call(this.client, "POST", "/session-ended", { body: { sessionId }, retry: true });
	}
	async readFile(path: string): Promise<Buffer> {
		const { data } = await call<{ data: string }>(this.client, "POST", "/read", { body: { cwd: this.cwd, path }, retry: true });
		return Buffer.from(data, "base64");
	}
	async writeFile(path: string, data: string | Buffer): Promise<void> {
		await call(this.client, "POST", "/write", { body: { cwd: this.cwd, path, data: Buffer.from(data).toString("base64") }, retry: true });
	}
	async exists(path: string): Promise<boolean> {
		return (await call<{ exists: boolean }>(this.client, "POST", "/exists", { body: { cwd: this.cwd, path }, retry: true })).exists;
	}
	async exec(command: string, options: { signal: AbortSignal; timeoutMs?: number; onOutput?(chunk: string): void }): Promise<ExecResult> {
		let result: ExecResult | undefined;
		try {
			await stream(this.client, "/exec", { cwd: this.cwd, sessionId: this.sessionId, command, timeoutMs: options.timeoutMs }, (line) => (line.output !== undefined ? options.onOutput?.(line.output) : (result = line.result)), options.signal);
		} catch (error) {
			if (!options.signal.aborted) throw error;
		}
		// Cancelled: the service stopped the command when the request was dropped.
		return result ?? { exitCode: null, output: "", timedOut: false };
	}
}

export function environmentHttp(options: ClientOptions & { cwd?: string }): Plugin {
	return {
		name: "env-http",
		replaces: "env-local",
		setup(api) {
			api.provide("working-environment", new HttpEnvironment(options, options.cwd ?? api.project));
		},
	};
}
