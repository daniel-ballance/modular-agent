import { spawn } from "node:child_process";
import { relative, isAbsolute, sep } from "node:path";
import type { Harness } from "@modular-agent/harness";
import type {
	Answer,
	AssistantMessage,
	CredentialStore,
	ExecResult,
	HandlerOrder,
	InterruptedTurn,
	Runtime,
	RuntimeHost,
	TurnInput,
	TurnOutcome,
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
	workingEnvironment?: { containment: "strong" | "processGroup" | "none"; platforms?: string[]; points?: boolean };
	hooks?: { hook: string; handlerId: number; order?: HandlerOrder }[];
	runtime?: { id: string; supports: Record<string, boolean | string> };
	commands?: { name: string; description: string }[];
	replaces?: string[];
}

/** A started external plugin: the connection, its registration, and the Plugin the Harness loads. */
export interface ExternalPlugin {
	registration: Registration;
	plugin: Plugin;
	items: string[];
	replacements: string[];
	refusal(harness: Harness, externalItems: Set<string>): string | undefined;
	stop(reason?: "stop" | "reload" | "refused", detail?: string): Promise<void>;
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
	const exited = new Promise<void>((resolve) => child.on("close", () => resolve()));
	child.on("exit", () => peer.close(`The plugin ${spec.command.join(" ")} ended`));
	child.on("error", (error) => peer.close(error.message));
	child.stdin.on("error", () => undefined);
	const stop = async (reason = "stop", detail?: string) => {
		let timeout: NodeJS.Timeout | undefined;
		if (!peer.closed) await Promise.race([peer.request("plugin/shutdown", { reason, detail }).catch(() => undefined), new Promise((r) => { timeout = setTimeout(r, 2000); })]);
		clearTimeout(timeout);
		child.stdin.end();
		const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
		await exited;
		clearTimeout(timer);
	};
	const registration = await peer.request<Registration>("plugin/initialize", {
		binding: PLUGIN_BINDING,
		data: DATA_BINDING,
		host: { name: "modular-agent (TypeScript)", version: "0.1.0" },
		project: info.project,
		home: info.home,
		config: spec.config ?? {},
	}).catch(async (error) => { await stop("refused", "Initialization failed"); throw error; });
	try {
		const reg = registration;
		if (reg?.binding !== PLUGIN_BINDING || typeof reg.name !== "string" || !reg.name) throw new Error("Invalid plugin registration");
		const items = [
			...(reg.runtime ? ["runtime"] : []),
			...(reg.workingEnvironment ? ["working-environment"] : []),
			...(reg.providers ?? []).map((p) => `provider:${p.id}`),
			...(reg.toolSources ?? []).flatMap((s) => s.tools.map((t) => `tool:${(t as ToolDefinition).name}`)),
			...(reg.commands ?? []).map((c) => `command:${c.name}`),
		];
		const replacements = [...new Set([...(reg.replaces ?? []), ...(reg.runtime ? ["runtime"] : [])])];
		return {
			registration, plugin: hostPlugin(peer, reg, stop), stop, items, replacements,
			refusal(harness, externalItems) {
				if (reg.hooks?.some((h) => h.order != null && !["first", "normal", "last"].includes(h.order))) return "Unknown hook order";
				if (new Set(items).size !== items.length) return "Registration repeats an item";
				const missing = replacements.find((item) => !items.includes(item));
				if (missing) return `Replacement ${missing} is not registered`;
				const external = items.find((item) => externalItems.has(item));
				if (external) return `${external} belongs to another external plugin`;
				const collision = items.find((item) => harness.hasItem(item) && !replacements.includes(item));
				if (collision) return `${collision} is already registered`;
				const hook = reg.hooks?.find((h) => !STANDARD_HOOKS.has(h.hook));
				if (hook) return `Hook ${hook.hook} is not supported over the plugin binding`;
			},
		};
	} catch (error) {
		await stop("refused", "Invalid plugin registration");
		throw error;
	}
}

/** What the host knows about each request it sent: the tool call's context, for the plugin's callbacks. */
const STANDARD_HOOKS = new Set("plugin.load session.start session.end input turn.before turn.start step.before step.after tool.before tool.after model.failed turn.result turn.end provider.request provider.response output".split(" "));
const RUNTIME_HOOKS = new Set("turn.start step.after tool.before tool.after model.failed turn.result turn.end".split(" "));

interface Parent {
	actors?: string[];
	runtime?: boolean;
	provider?: string;
	sessionId?: string;
	tool?: ToolContext;
	signal?: AbortSignal;
}

function hostPlugin(peer: WirePeer, reg: Registration, stop: () => Promise<void>): Plugin {
	const parents = new Map<number | string, Parent>();
	let workActors: PluginApi["workActors"];
	const changedBy = new Map<number, Promise<unknown>>();
	const track = <T>(p: Promise<T> & { id: number }, parent: Parent): Promise<T> => {
		parents.set(p.id, { ...parent, actors: parent.actors ?? (parent.sessionId ? workActors(parent.sessionId) : []) });
		return p.then(async (value) => { await changedBy.get(p.id); return value; })
			.finally(() => { parents.delete(p.id); changedBy.delete(p.id); });
	};
	return {
		name: reg.name,
		stop,
		async setup(api: PluginApi) {
			workActors = api.workActors;
			const parentOf = (p: any): Parent => {
				const parent = parents.get(p.parentRequestId);
				if (!parent || !peer.isWaiting(p.parentRequestId)) throw new WireError("invalid_request", "There is no live parent");
				if (p.sessionId != null && p.sessionId !== parent.sessionId) throw new WireError("invalid_request", "The parent belongs to another session");
				return parent;
			};
			const sessionOf = (p: any): string => {
				if (p.parentRequestId != null) parentOf(p);
				if (typeof p.sessionId !== "string") throw new WireError("invalid_request", "A session is required");
				try { api.session(p.sessionId); } catch { throw new WireError("invalid_request", "The session is not open"); }
				return p.sessionId;
			};
			const noSession = (p: any) => {
				if (p.sessionId != null || p.parentRequestId != null) throw new WireError("invalid_request", "This request names no session or parent");
			};
			const environment = async (p: any): Promise<WorkingEnvironment> => {
				const parent = parentOf(p);
				if (parent.runtime) throw new WireError("invalid_request", "A Runtime uses host/runtime/runToolCall");
				const sessionId = sessionOf(p);
				const project = api.projectOf(sessionId);
				const path = typeof p.cwd === "string" ? relative(project, p.cwd) : "..";
				if (!isAbsolute(p.cwd ?? "") || path === ".." || path.startsWith(".." + sep) || isAbsolute(path)) throw new WireError("invalid_request", "cwd is outside the session project");
				const base = api.use<WorkingEnvironment>("working-environment");
				const env = parent.tool?.environment ?? (await base?.forSession?.(sessionId)) ?? base;
				if (!env) throw new WireError("invalid_request", "There is no working environment");
				return env.cwd !== p.cwd && env.at ? env.at(p.cwd) : env;
			};
			const signalOf = (parentId: unknown, signal: AbortSignal) => {
				const parent = parents.get(parentId as number)?.signal;
				return parent ? AbortSignal.any([parent, signal]) : signal;
			};

			// ---------- what the plugin may ask the host ----------
			peer.handle("host/ask", async (p, ctx) => {
				const tool = parentOf(p).tool;
				if (!tool) throw new WireError("invalid_request", "host/ask needs the tool call it belongs to");
				const signal = signalOf(p.parentRequestId, ctx.signal);
				signal.throwIfAborted();
				return toWire(await tool.ask(fromWire(p.request), signal));
			});
			peer.handle("host/env/read", async (p) => {
				try {
					return { data: (await (await environment(p)).readFile(p.path)).toString("base64") };
				} catch (error) {
					if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new WireError("not_found", `No file ${p.path}`);
					throw error;
				}
			});
			peer.handle("host/env/write", async (p) => (await (await environment(p)).writeFile(p.path, Buffer.from(p.data, "base64")), {}));
			peer.handle("host/env/exists", async (p) => ({ exists: await (await environment(p)).exists(p.path) }));
			peer.handle("host/env/exec", async (p, ctx) =>
				(await environment(p)).exec(String(p.command), {
					signal: signalOf(p.parentRequestId, ctx.signal),
					timeoutMs: p.timeoutMs,
					onOutput: (chunk) => peer.notify("host/env/output", { parentRequestId: ctx.id, chunk }),
				}),
			);
			peer.handle("host/hook", async (p) => {
				const parent = parentOf(p);
				if (!parent.provider || !["provider.request", "provider.response"].includes(p.hook)
					|| p.payload?.provider !== parent.provider || (p.payload?.sessionId ?? undefined) !== parent.sessionId) throw new WireError("invalid_request", "Not this Provider's hook");
				const result = await api.runHook(p.hook, fromWire(p.payload));
				return p.hook === "provider.response" ? null : toWire(result);
			});
			peer.handle("host/credentials/read", async (p) => {
				noSession(p);
				if (!(reg.providers ?? []).some((x) => x.id === p.provider)) throw new WireError("invalid_request", `${reg.name} did not register provider ${p.provider}`);
				const credential = await api.use<CredentialStore>("credential-store")?.read(p.provider);
				if (typeof credential === "string") return { credential: { type: "apiKey", key: credential } };
				if (credential && typeof credential === "object" && "type" in credential && credential.type === "api_key") return { credential: { ...credential, type: "apiKey" } };
				return { credential: credential ?? null };
			});
			peer.handle("host/history", async (p) => {
				const all = api.history(sessionOf(p), { all: p.all === true });
				let from = 0;
				if (p.after != null) {
					from = all.findIndex((e) => e.id === p.after) + 1;
					if (from === 0) throw new WireError("invalid_request", `Unknown entry ${p.after}`);
				}
				const limit = p.limit ?? 500;
				if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new WireError("invalid_request", "limit must be an integer from 1 to 500");
				const max = 4 * 1024 * 1024;
				const entries: unknown[] = [];
				let bytes = Buffer.byteLength('{"entries":[]}');
				for (let i = from; i < all.length && entries.length < limit; i++) {
					const entry = toWire(all[i]);
					const size = Buffer.byteLength(JSON.stringify(entry));
					const nextBytes = i + 1 < all.length ? Buffer.byteLength(JSON.stringify(all[i].id)) + 8 : 0;
					if (bytes + size + Number(entries.length > 0) + nextBytes > max) {
						if (!entries.length) throw new WireError("result_too_large", "One entry does not fit in a page");
						break;
					}
					bytes += size + Number(entries.length > 0);
					entries.push(entry);
				}
				return { entries, ...(from + entries.length < all.length ? { next: all[from + entries.length - 1].id } : {}) };
			});
			peer.handle("host/session", async (p) => {
				const s = api.session(sessionOf(p));
				return { id: s.id, project: api.projectOf(s.id), settings: s.settings, busy: s.busy, actors: s.actors.map(({ authority, ...a }) => ({ ...a, rights: authority })) };
			});
			peer.handle("host/declaration", async (p) => {
				if (p.sessionId == null) { noSession(p); return api.declaration(); }
				return api.declaration(sessionOf(p));
			});
			peer.onNotification("host/emit", (p) => api.emit(sessionOf(p), String(p.type), p.data));
			peer.onNotification("host/problem", (p) => {
				noSession(p);
				api.reportProblem(String(p.where ?? reg.name), new Error(String(p.message)));
			});

			const ownJob = (p: any) => {
				const job = typeof p.jobId === "string" && api.findJob(p.jobId);
				if (!job || (p.sessionId != null && p.sessionId !== job.sessionId)) throw new WireError("invalid_request", "No such unfinished job of this plugin");
				return job.sessionId;
			};
			peer.handle("host/jobs/start", async (p) => {
				const parent = parentOf(p);
				if (!parent.sessionId || !parent.actors?.length || parent.signal?.aborted ||
					typeof p.kind !== "string" || (p.key !== undefined && typeof p.key !== "string")) throw new WireError("invalid_request", "Job needs an authorized parent and kind");
				try {
					const handle = api.startJob(parent.sessionId, { kind: p.kind, key: p.key, detail: p.detail, actors: parent.actors, toolCallId: parent.tool?.call.id });
					await handle.ready;
					return { jobId: handle.id, started: handle.started };
				} catch (error) { throw new WireError("invalid_request", String(error)); }
			});
			peer.onNotification("host/jobs/progress", (p) => {
				const id = ownJob(p);
				if (Array.isArray(p.content)) api.resumeJob(id, p.jobId).progress(fromWire(p.content));
			});
			peer.handle("host/jobs/end", async (p) => {
				const id = ownJob(p);
				if (!["completed", "failed", "cancelled"].includes(p.outcome?.kind) || typeof p.report !== "boolean" ||
					(p.result !== undefined && !Array.isArray(p.result))) throw new WireError("invalid_request", "Invalid job result");
				try { await api.resumeJob(id, p.jobId).finish(p.outcome.kind, fromWire(p.result), { report: p.report, error: p.outcome.error }); }
				catch (error) { throw new WireError("invalid_request", String(error)); }
				return {};
			});
			peer.handle("host/jobs/unfinished", async (p) => ({
				jobs: api.unfinishedJobs(sessionOf(p)).map(({ job, key, detail }) => ({ jobId: job.id, kind: job.kind, key, detail, actorId: job.actorId })),
			}));
			peer.handle("host/jobs/resume", async (p) => { api.resumeJob(ownJob(p), p.jobId); return {}; });
			api.onJobCancel(async (jobId) => { await peer.request("jobs/cancel", { jobId }); });

			// ---------- what the plugin provides ----------
			for (const p of reg.providers ?? []) api.provide("provider", new WireProvider(peer, p.id, (p.supports ?? {}) as never, fromWire(p.models) as ModelInfo[], track));
			for (const t of reg.toolSources ?? []) {
				const source = new WireToolSource(peer, t.id, fromWire(t.tools) as ToolDefinition[], track, t.perSession === true);
				api.provide("tool-source", source);
				if (t.perSession) api.on("session.start", (s: { sessionId: string }) => source.refresh(s.sessionId));
			}
			peer.onNotification("tools/changed", (p) => {
				const source = WireToolSource.changed.get(peer)?.get(p?.toolSource);
				if (!source) return;
				if (p.parentRequestId != null) parentOf(p);
				const refresh = source.changedList();
				if (p.parentRequestId != null) {
					const previous = changedBy.get(p.parentRequestId);
					changedBy.set(p.parentRequestId, Promise.all([previous, refresh]));
				}
			});
			if (reg.workingEnvironment) api.provide("working-environment", new WireEnvironment(peer, api.project, reg.workingEnvironment.containment, reg.workingEnvironment.points === true));
			if (reg.runtime) api.provide("runtime", new WireRuntime(peer, reg.runtime.id, reg.runtime.supports, track));
			for (const h of reg.hooks ?? []) {
				if (h.hook === "output") {
					api.on(h.hook, async (p: import("@modular-agent/harness").OutputPayload) => {
						const events = p.events.map(({ type, data }) => ({ type, data }));
						const answer = await peer.request<{ events?: { type: string; data: unknown }[]; block?: boolean } | null>("hook/handle", {
							handlerId: h.handlerId, hook: h.hook, payload: { sessionId: p.sessionId, recipient: p.recipient, events, final: true },
						});
						if (answer === null) return undefined;
						if (answer?.block === true) return { action: "block" };
						if (!Array.isArray(answer?.events) || answer.events.some((e) => typeof e?.type !== "string")) throw new WireError("invalid_request", "Invalid output gate answer");
						return { action: "pass", events: answer.events.map((event, i) => ({
							...(p.events[i]?.type === event.type ? p.events[i] : p.events.find((e) => e.type === event.type) ?? p.events[0]), ...event,
						})) };
					}, h.order, { stream: true });
				} else {
					api.on(h.hook, async (payload: { sessionId?: string }) => fromWire(await track(peer.request("hook/handle", { handlerId: h.handlerId, hook: h.hook, payload: toWire(payload) }), { sessionId: payload.sessionId })) ?? undefined, h.order ?? "normal");
				}
			}
			for (const c of reg.commands ?? []) {
				api.registerCommand(c.name, {
					description: c.description,
					run: async (args, ctx) => (await track(peer.request<{ output?: string }>("command/run", { name: c.name, args, sessionId: ctx.sessionId, actorId: ctx.actorId }), { sessionId: ctx.sessionId, actors: [ctx.actorId] }))?.output,
				});
			}
		},
	};
}

interface Turn { input: TurnInput; host: RuntimeHost; signal: AbortSignal }

/** A Runtime in another process. Each turn is one request; its callbacks reach this turn's RuntimeHost. */
class WireRuntime implements Runtime {
	private turns = new Map<number | string, Turn>();
	constructor(private peer: WirePeer, readonly id: string, readonly supports: Runtime["supports"], private track: Track) {
		const turn = (p: any): Turn => {
			const t = this.turns.get(p?.parentRequestId);
			if (!t || !peer.isWaiting(p.parentRequestId) || (p.sessionId != null && p.sessionId !== t.input.sessionId)) throw new WireError("invalid_request", "No live turn for this session");
			return t;
		};
		peer.handle("host/runtime/newId", async (p) => ({ id: await turn(p).host.newId() }));
		// The host emits the standard turn events itself (docs/bindings/plugin.md): a step starts here...
		peer.handle("host/runtime/prepareStep", async (p) => {
			const t = turn(p);
			t.host.report("step.started", {}, { stepId: p.stepId });
			return toWire(await t.host.prepareStep({ stepId: p.stepId, usage: p.usage }));
		});
		peer.handle("host/runtime/model", async (p, ctx) => {
			const t = turn(p);
			// Pass pieces on to the Runtime. The Harness delivers the same pieces to followers.
			return toWire(await t.input.model.request(fromWire(p.request), {
				signal: AbortSignal.any([t.signal, ctx.signal]),
				sessionId: t.input.sessionId,
				stepId: p.stepId,
				onEvent: (event) => {
					peer.notify("host/runtime/modelEvent", { parentRequestId: ctx.id, event });
				},
			}));
		});
		peer.handle("host/runtime/hook", async (p) => {
			const t = turn(p);
			if (!RUNTIME_HOOKS.has(p.hook)) throw new WireError("invalid_request", "Not a Runtime hook");
			return toWire((await t.host.hook(p.hook, fromWire(p.payload))) ?? null);
		});
		peer.handle("host/runtime/definition", async (p) => toWire((await turn(p).host.definition(p.toolName)) ?? null));
		peer.handle("host/runtime/runToolCall", async (p, ctx) => {
			const t = turn(p);
			return toWire(await t.host.runToolCall(fromWire(p.call), AbortSignal.any([t.signal, ctx.signal])));
		});
		peer.handle("host/runtime/record", async (p) => {
			const t = turn(p);
			const { id: _id, parentId: _parent, time: _time, turnId: _turn, sessionId: _session, ...entry } = p.entry ?? {};
			if (!["response", "toolResult", "turnStart", "turnEnd"].includes(entry.kind) && (typeof entry.kind !== "string" || !entry.kind.includes("."))) {
				throw new WireError("invalid_request", "The Runtime cannot record this entry kind");
			}
			return toWire(await t.host.record(entry));
		});
		peer.handle("host/runtime/takeSteering", async (p) => ({ entries: toWire(await turn(p).host.takeSteering()) }));
		peer.handle("host/runtime/hasSteering", async (p) => ({ waiting: await turn(p).host.hasSteering() }));
		peer.onNotification("host/runtime/report", (p) => {
			// The host emits these itself; a Runtime's own copy would duplicate them.
			if (["model.output", "step.started", "tool.started", "tool.progress", "tool.ended", "entry.added"].includes(p?.type)) return;
			const t = this.turns.get(p?.parentRequestId);
			t?.host.report(String(p.type), fromWire(p.data), { ...(p.stepId ? { stepId: p.stepId } : {}), ...(p.toolCallId ? { toolCallId: p.toolCallId } : {}) });
		});
	}
	private async turn(method: string, input: TurnInput, host: RuntimeHost, signal: AbortSignal, extra: Record<string, unknown> = {}): Promise<TurnOutcome> {
		const turn = { sessionId: input.sessionId, turnId: input.turnId, startedBy: input.startedBy, model: toWire(input.model.model), modelSupports: input.model.supports, settings: input.settings, ...(input.resultShape ? { resultShape: input.resultShape } : {}) };
		const req = this.peer.request<TurnOutcome>(method, { turn, ...toWire(extra) }, signal);
		this.turns.set(req.id, { input, host, signal });
		try {
			return fromWire(await this.track(req, { runtime: true, sessionId: input.sessionId, signal })) as TurnOutcome;
		} finally {
			this.turns.delete(req.id);
		}
	}
	runTurn(input: TurnInput, host: RuntimeHost, signal: AbortSignal): Promise<TurnOutcome> {
		return this.turn("runtime/runTurn", input, host, signal);
	}
	resumeTurn(input: TurnInput, host: RuntimeHost, signal: AbortSignal, interrupted: InterruptedTurn): Promise<TurnOutcome> {
		return this.turn("runtime/resumeTurn", input, host, signal, { interrupted });
	}
	continueOpenCalls(input: TurnInput, host: RuntimeHost, signal: AbortSignal, calls: InterruptedTurn["calls"]): Promise<TurnOutcome> {
		return this.turn("runtime/continueOpenCalls", input, host, signal, { calls });
	}
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
			return fromWire(await this.track(req, { provider: this.id, sessionId: options.sessionId, signal: options.signal })) as AssistantMessage;
		} catch (error) {
			if (options.signal.aborted) return { role: "assistant", content: [], stop: "aborted" };
			return { role: "assistant", content: [], stop: "failed", error: { kind: "temporary", message: error instanceof Error ? error.message : String(error) } };
		} finally {
			WireProvider.listeners.get(this.peer)?.delete(req.id);
		}
	}
	async discardState(sessionId: string, options?: { erase?: boolean; entryIds?: string[] }): Promise<{ pending?: string[]; outOfReach?: string[] }> {
		return this.peer.request("provider/discard", { provider: this.id, sessionId, erase: options?.erase, entryIds: options?.entryIds });
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
	private changing?: Promise<void>;
	private progress = new Map<number, (content: Parameters<ToolContext["progress"]>[0]) => void>();
	constructor(private peer: WirePeer, readonly id: string, private everywhere: ToolDefinition[], private track: Track, private perSession = false) {
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
	changedList(): Promise<void> {
		const prior = this.changing ?? Promise.resolve();
		const current = prior.then(async () => {
			await this.refresh();
			if (this.perSession) await Promise.all([...this.bySession.keys()].map((id) => this.refresh(id)));
		});
		this.changing = current.catch(() => undefined);
		return this.changing;
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
			await this.changing;
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
	constructor(private peer: WirePeer, readonly cwd: string, readonly containment: string, readonly points: boolean, private sessionId?: string) {
		this.id = `plugin:${cwd}`;
	}
	at(cwd: string): WorkingEnvironment {
		return new WireEnvironment(this.peer, cwd, this.containment, this.points, this.sessionId);
	}
	forSession(sessionId: string): WorkingEnvironment {
		return new WireEnvironment(this.peer, this.cwd, this.containment, this.points, sessionId);
	}
	get safeToRepeat(): boolean { return this.containment === "strong"; }
	async save(): Promise<string> {
		return (await this.peer.request<{ point: string }>("env/save", { cwd: this.cwd, sessionId: this.sessionId })).point;
	}
	async restore(point: string): Promise<void> {
		await this.peer.request("env/restore", { cwd: this.cwd, sessionId: this.sessionId, point });
	}
	async sessionEnded(sessionId: string): Promise<void> {
		await this.peer.request("env/sessionEnded", { sessionId });
	}
	async readFile(path: string): Promise<Buffer> {
		try {
			return Buffer.from((await this.peer.request<{ data: string }>("env/read", { cwd: this.cwd, sessionId: this.sessionId, path })).data, "base64");
		} catch (error) {
			throw notFoundAsEnoent(error, path);
		}
	}
	async writeFile(path: string, data: string | Buffer): Promise<void> {
		await this.peer.request("env/write", { cwd: this.cwd, sessionId: this.sessionId, path, data: Buffer.from(data).toString("base64") });
	}
	async exists(path: string): Promise<boolean> {
		return (await this.peer.request<{ exists: boolean }>("env/exists", { cwd: this.cwd, sessionId: this.sessionId, path })).exists;
	}
	async exec(command: string, options: { signal: AbortSignal; timeoutMs?: number; onOutput?(chunk: string): void }): Promise<ExecResult> {
		const req = this.peer.request<ExecResult>("env/exec", { cwd: this.cwd, sessionId: this.sessionId, command, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }, options.signal);
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
