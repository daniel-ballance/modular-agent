import { spawn } from "node:child_process";
import type {
	Answer,
	AssistantMessage,
	CredentialStore,
	ExecResult,
	HandlerOrder,
	ModelInfo,
	ModelRef,
	ModelRequest,
	Plugin,
	PluginApi,
	Provider,
	RequestOptions,
	ToolCall,
	ToolContext,
	ToolDefinition,
	ToolPending,
	ToolResult,
	ToolSource,
	WorkingEnvironment,
} from "@modular-agent/harness";
import { fromWire, toWire } from "./translate.js";
import { DATA_BINDING, notFoundAsEnoent, PLUGIN_BINDING, WireError, WirePeer } from "./wire.js";

/** One external plugin to start, as MODULAR_AGENT_PLUGINS lists it. */
export interface ExternalPluginSpec {
	command: string[];
	env?: Record<string, string>;
	config?: Record<string, unknown>;
}

/** What a plugin registered at its handshake. */
export interface Registration {
	binding: string;
	name: string;
	providers?: { id: string; supports?: Record<string, boolean | string>; models: unknown[] }[];
	toolSources?: { id: string; tools: unknown[]; perSession?: boolean }[];
	workingEnvironment?: { containment: "strong" | "processGroup" | "none"; platforms?: string[] };
	hooks?: { hook: string; handlerId: number; order?: HandlerOrder }[];
	commands?: { name: string; description: string }[];
	replaces?: string[];
}

/** A started external plugin: the connection, its registration, and the Plugin the Harness loads. */
export interface ExternalPlugin {
	registration: Registration;
	plugin: Plugin;
	stop(): Promise<void>;
}

/** Read MODULAR_AGENT_PLUGINS. */
export function pluginSpecsFromEnv(env: NodeJS.ProcessEnv = process.env): ExternalPluginSpec[] {
	const raw = env.MODULAR_AGENT_PLUGINS;
	if (!raw) return [];
	const list = JSON.parse(raw) as ExternalPluginSpec[];
	if (!Array.isArray(list) || list.some((s) => !Array.isArray(s.command) || !s.command.length)) throw new Error("MODULAR_AGENT_PLUGINS must be a JSON array of { command: [...] }");
	return list;
}

/**
 * Start a plugin that follows modular-agent-plugin/1, in any language, and do the
 * handshake. The registration is known before the Harness loads anything, so the
 * host can leave out its own plugins that this one `replaces`.
 */
export async function startExternalPlugin(spec: ExternalPluginSpec, info: { project: string; home: string }): Promise<ExternalPlugin> {
	const child = spawn(spec.command[0], spec.command.slice(1), { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...(spec.env ?? {}) } });
	const peer = new WirePeer((line) => child.stdin.write(line));
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => peer.feed(chunk));
	const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
	child.on("exit", () => peer.close(`The plugin ${spec.command.join(" ")} ended`));
	child.stdin.on("error", () => undefined);
	const registration = await peer.request<Registration>("plugin/initialize", {
		binding: PLUGIN_BINDING,
		data: DATA_BINDING,
		host: { name: "modular-agent (TypeScript)", version: "0.1.0" },
		project: info.project,
		home: info.home,
		config: spec.config ?? {},
	});
	if (registration?.binding !== PLUGIN_BINDING) throw new Error(`${spec.command.join(" ")} speaks ${registration?.binding}, not ${PLUGIN_BINDING}`);
	const stop = async () => {
		if (!peer.closed) await Promise.race([peer.request("plugin/shutdown", { reason: "stop" }).catch(() => undefined), new Promise((r) => setTimeout(r, 2000))]);
		child.stdin.end();
		const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
		await exited;
		clearTimeout(timer);
	};
	return { registration, plugin: hostPlugin(peer, registration, stop), stop };
}

/** What the host knows about each request it sent: the tool call's context, for the plugin's callbacks. */
interface Parent {
	sessionId?: string;
	tool?: ToolContext;
	signal?: AbortSignal;
}

function hostPlugin(peer: WirePeer, reg: Registration, stop: () => Promise<void>): Plugin {
	const parents = new Map<number | string, Parent>();
	const track = <T>(p: Promise<T> & { id: number }, parent: Parent): Promise<T> => {
		parents.set(p.id, parent);
		return p.finally(() => parents.delete(p.id));
	};
	return {
		name: reg.name,
		stop,
		async setup(api: PluginApi) {
			const environment = (parentId: unknown, cwd?: string): WorkingEnvironment => {
				const parent = parents.get(parentId as number);
				const env = parent?.tool?.environment ?? api.use<WorkingEnvironment>("working-environment");
				if (!env) throw new WireError("invalid_request", "There is no working environment");
				return cwd && env.cwd !== cwd && env.at ? (env.at(cwd) as WorkingEnvironment) : env;
			};
			const signalOf = (parentId: unknown, signal: AbortSignal) => {
				const parent = parents.get(parentId as number)?.signal;
				return parent ? AbortSignal.any([parent, signal]) : signal;
			};

			// ---------- what the plugin may ask the host ----------
			peer.handle("host/ask", async (p) => {
				const tool = parents.get(p.parentRequestId)?.tool;
				if (!tool) throw new WireError("invalid_request", "host/ask needs the tool call it belongs to");
				return toWire(await tool.ask(fromWire(p.request)));
			});
			peer.handle("host/env/read", async (p) => {
				try {
					return { data: (await environment(p.parentRequestId, p.cwd).readFile(p.path)).toString("base64") };
				} catch (error) {
					if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new WireError("not_found", `No file ${p.path}`);
					throw error;
				}
			});
			peer.handle("host/env/write", async (p) => (await environment(p.parentRequestId, p.cwd).writeFile(p.path, Buffer.from(p.data, "base64")), {}));
			peer.handle("host/env/exists", async (p) => ({ exists: await environment(p.parentRequestId, p.cwd).exists(p.path) }));
			peer.handle("host/env/exec", async (p, ctx) =>
				environment(p.parentRequestId, p.cwd).exec(String(p.command), {
					signal: signalOf(p.parentRequestId, ctx.signal),
					timeoutMs: p.timeoutMs,
					onOutput: (chunk) => peer.notify("host/env/output", { parentRequestId: ctx.id, chunk }),
				}),
			);
			peer.handle("host/hook", async (p) => {
				const result = await api.runHook(p.hook, fromWire(p.payload));
				return toWire(result);
			});
			peer.handle("host/credentials/read", async (p) => {
				if (!(reg.providers ?? []).some((x) => x.id === p.provider)) throw new WireError("invalid_request", `${reg.name} did not register provider ${p.provider}`);
				return { credential: (await api.use<CredentialStore>("credential-store")?.read(p.provider)) ?? null };
			});
			peer.handle("host/history", async (p) => {
				const all = api.history(String(p.sessionId), { all: p.all === true });
				let from = 0;
				if (p.after !== undefined) {
					from = all.findIndex((e) => e.id === p.after) + 1;
					if (from === 0) throw new WireError("invalid_request", `Unknown entry ${p.after}`);
				}
				const limit = Math.min(Number(p.limit) || 500, 500);
				const page = all.slice(from, from + limit);
				return { entries: toWire(page), ...(from + limit < all.length ? { next: page.at(-1)?.id } : {}) };
			});
			peer.handle("host/session", async (p) => {
				const s = api.session(String(p.sessionId));
				return { id: s.id, project: api.projectOf(s.id), settings: s.settings, busy: s.busy, actors: s.actors };
			});
			peer.handle("host/declaration", async (p) => api.declaration(p.sessionId));
			peer.onNotification("host/emit", (p) => api.emit(String(p.sessionId), String(p.type), p.data));
			peer.onNotification("host/problem", (p) => api.reportProblem(String(p.where ?? reg.name), new Error(String(p.message))));

			// ---------- what the plugin provides ----------
			for (const p of reg.providers ?? []) api.provide("provider", new WireProvider(peer, p.id, (p.supports ?? {}) as never, fromWire(p.models) as ModelInfo[], track));
			for (const t of reg.toolSources ?? []) {
				const source = new WireToolSource(peer, t.id, fromWire(t.tools) as ToolDefinition[], track);
				api.provide("tool-source", source);
				if (t.perSession) api.on("session.start", (s: { sessionId: string }) => source.refresh(s.sessionId));
			}
			peer.onNotification("tools/changed", (p) => void WireToolSource.changed.get(peer)?.get(p?.toolSource)?.refresh().catch(() => undefined));
			if (reg.workingEnvironment) api.provide("working-environment", new WireEnvironment(peer, api.project, reg.workingEnvironment.containment));
			for (const h of reg.hooks ?? []) {
				if (h.hook === "output") {
					api.reportProblem("hooks", new Error("\"Before output reaches a recipient\" can't be handled by a plugin in another process (not_supported)"));
					continue;
				}
				api.on(h.hook, async (payload: unknown) => fromWire(await peer.request("hook/handle", { handlerId: h.handlerId, hook: h.hook, payload: toWire(payload) })) ?? undefined, h.order ?? "normal");
			}
			for (const c of reg.commands ?? []) {
				api.registerCommand(c.name, {
					description: c.description,
					run: async (args, ctx) => (await peer.request<{ output?: string }>("command/run", { name: c.name, args, sessionId: ctx.sessionId, actorId: ctx.actorId }))?.output,
				});
			}
		},
	};
}

type Track = <T>(p: Promise<T> & { id: number }, parent: Parent) => Promise<T>;

class WireProvider implements Provider {
	constructor(private peer: WirePeer, readonly id: string, readonly supports: Provider["supports"], private list: ModelInfo[], private track: Track) {}
	models(): ModelInfo[] {
		return this.list;
	}
	async available(): Promise<boolean> {
		return (await this.peer.request<{ available: boolean }>("provider/available", { provider: this.id }).catch(() => ({ available: true }))).available;
	}
	async request(model: ModelRef, request: ModelRequest, options: RequestOptions): Promise<AssistantMessage> {
		const req = this.peer.request("provider/request", { provider: this.id, model, request: toWire(request), sessionId: options.sessionId }, options.signal);
		const onEvent = (p: { parentRequestId: number; event: { type: "text" | "reasoning" | "toolInput"; delta: string } }) => {
			if (p.parentRequestId === req.id) options.onEvent?.(p.event);
		};
		WireProvider.listen(this.peer, req.id, onEvent);
		try {
			return fromWire(await this.track(req, { sessionId: options.sessionId, signal: options.signal })) as AssistantMessage;
		} catch (error) {
			if (options.signal.aborted) return { role: "assistant", content: [], stop: "aborted" };
			return { role: "assistant", content: [], stop: "failed", error: { kind: "temporary", message: error instanceof Error ? error.message : String(error) } };
		} finally {
			WireProvider.listeners.get(this.peer)?.delete(req.id);
		}
	}
	async discardState(sessionId: string): Promise<void> {
		if (this.supports.keepsState) await this.peer.request("provider/discard", { provider: this.id, sessionId }).catch(() => undefined);
	}
	static listeners = new WeakMap<WirePeer, Map<number, (p: any) => void>>();
	static listen(peer: WirePeer, id: number, fn: (p: any) => void): void {
		let m = WireProvider.listeners.get(peer);
		if (!m) {
			m = new Map();
			WireProvider.listeners.set(peer, m);
			const all = m;
			peer.onNotification("provider/event", (p) => all.get(p?.parentRequestId)?.(p));
		}
		m.set(id, fn);
	}
}

class WireToolSource implements ToolSource {
	static changed = new WeakMap<WirePeer, Map<string, WireToolSource>>();
	private bySession = new Map<string, ToolDefinition[]>();
	private progress = new Map<number, (content: unknown) => void>();
	constructor(private peer: WirePeer, readonly id: string, private everywhere: ToolDefinition[], private track: Track) {
		let m = WireToolSource.changed.get(peer);
		if (!m) {
			m = new Map();
			WireToolSource.changed.set(peer, m);
		}
		m.set(id, this);
		peer.onNotification("tools/progress", (p) => {
			for (const s of WireToolSource.changed.get(peer)?.values() ?? []) s.progress.get(p?.parentRequestId)?.(p.content);
		});
	}
	tools(sessionId?: string): ToolDefinition[] {
		return (sessionId && this.bySession.get(sessionId)) || this.everywhere;
	}
	async refresh(sessionId?: string): Promise<void> {
		const list = fromWire((await this.peer.request<{ tools: unknown[] }>("tools/list", { toolSource: this.id, ...(sessionId ? { sessionId } : {}) })).tools) as ToolDefinition[];
		if (sessionId) this.bySession.set(sessionId, list);
		else this.everywhere = list;
	}
	async run(call: ToolCall, ctx: ToolContext): Promise<Omit<ToolResult, "callId"> | ToolPending> {
		const req = this.peer.request("tools/call", { toolSource: this.id, sessionId: ctx.sessionId, project: ctx.environment?.cwd, call: toWire(call) }, ctx.signal);
		this.progress.set(req.id, (content) => ctx.progress(fromWire(content)));
		try {
			const result = fromWire(await this.track(req, { sessionId: ctx.sessionId, tool: ctx, signal: ctx.signal }));
			const { callId: _c, ...rest } = result as ToolResult;
			return rest;
		} catch (error) {
			if (ctx.signal.aborted) return { status: "cancelled", content: [{ type: "text", text: "Cancelled" }] };
			throw error;
		} finally {
			this.progress.delete(req.id);
		}
	}
}

class WireEnvironment implements WorkingEnvironment {
	readonly id: string;
	constructor(private peer: WirePeer, readonly cwd: string, readonly containment: string) {
		this.id = `plugin:${cwd}`;
	}
	at(cwd: string): WorkingEnvironment {
		return new WireEnvironment(this.peer, cwd, this.containment);
	}
	async readFile(path: string): Promise<Buffer> {
		try {
			return Buffer.from((await this.peer.request<{ data: string }>("env/read", { cwd: this.cwd, path })).data, "base64");
		} catch (error) {
			throw notFoundAsEnoent(error, path);
		}
	}
	async writeFile(path: string, data: string | Buffer): Promise<void> {
		await this.peer.request("env/write", { cwd: this.cwd, path, data: Buffer.from(data).toString("base64") });
	}
	async exists(path: string): Promise<boolean> {
		return (await this.peer.request<{ exists: boolean }>("env/exists", { cwd: this.cwd, path })).exists;
	}
	async exec(command: string, options: { signal: AbortSignal; timeoutMs?: number; onOutput?(chunk: string): void }): Promise<ExecResult> {
		const req = this.peer.request<ExecResult>("env/exec", { cwd: this.cwd, command, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }, options.signal);
		const listen = (p: { parentRequestId: number; chunk: string }) => {
			if (p.parentRequestId === req.id) options.onOutput?.(p.chunk);
		};
		WireEnvironment.listen(this.peer, req.id, listen);
		try {
			return await req;
		} catch (error) {
			if (options.signal.aborted) return { exitCode: null, output: "", timedOut: false };
			throw error;
		} finally {
			WireEnvironment.listeners.get(this.peer)?.delete(req.id);
		}
	}
	static listeners = new WeakMap<WirePeer, Map<number, (p: any) => void>>();
	static listen(peer: WirePeer, id: number, fn: (p: any) => void): void {
		let m = WireEnvironment.listeners.get(peer);
		if (!m) {
			m = new Map();
			WireEnvironment.listeners.set(peer, m);
			const all = m;
			peer.onNotification("env/output", (p) => all.get(p?.parentRequestId)?.(p));
		}
		m.set(id, fn);
	}
}

export type { Answer };
