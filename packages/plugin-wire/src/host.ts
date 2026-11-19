import { spawn } from "node:child_process";
import { relative, isAbsolute, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { addUsage, interruptedNote, isToolCall, pendingToolCalls, restoreAnsweredStep, text, zeroUsage, type Harness, type HistoryEntry, type Usage } from "@modular-agent/harness";
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
import { mapOutput } from "./output.js";
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
	const child = spawn(spec.command[0], spec.command.slice(1), { stdio: ["pipe", "pipe", "inherit"], env: { PATH: process.env.PATH, LANG: process.env.LANG, ...(spec.env ?? {}) } });
	const peer = new WirePeer((line) => child.stdin.write(line), () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
	child.stdout.on("data", (chunk: Buffer) => peer.feed(chunk));
	child.stdout.on("end", () => peer.close("The plugin closed its output"));
	const exited = new Promise<void>((resolve) => child.on("close", () => resolve()));
	child.on("exit", () => peer.close("The plugin ended"));
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
				if (harness.plugins().includes(reg.name)) return `Plugin ${reg.name} is already loaded`;
				if (reg.hooks?.some((h) => h.order != null && !["first", "normal", "last"].includes(h.order))) return "Unknown hook order";
				if (new Set(items).size !== items.length) return "Registration repeats an item";
				if (reg.replaces && new Set(reg.replaces).size !== reg.replaces.length) return "Registration repeats a replacement";
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
	jobs?: string[];
	runtime?: boolean;
	provider?: ProviderAttempt;
	sessionId?: string;
	tool?: ToolContext;
	signal?: AbortSignal;
}

interface ProviderAttempt {
	model: ModelRef;
	request: unknown;
	prepare?: () => Promise<ModelRequest>;
	begun?: boolean;
	committed?: boolean;
	response?: unknown;
	failure?: unknown;
}

function hostPlugin(peer: WirePeer, reg: Registration, stop: () => Promise<void>): Plugin {
	const parents = new Map<number | string, Parent>();
	let workActors: PluginApi["workActors"];
	let workJobs: PluginApi["workJobs"];
	const changedBy = new Map<number, Promise<unknown>>();
	const track = <T>(p: Promise<T> & { id: number }, parent: Parent): Promise<T> => {
		parents.set(p.id, { ...parent, actors: parent.actors ?? (parent.sessionId ? workActors(parent.sessionId) : []), jobs: parent.sessionId ? workJobs(parent.sessionId) : [] });
		return p.then(async (value) => { await changedBy.get(p.id)?.catch(() => undefined); return value; })
			.finally(() => { parents.delete(p.id); changedBy.delete(p.id); });
	};
	return {
		name: reg.name,
		stop,
		async setup(api: PluginApi) {
			workActors = api.workActors;
			workJobs = api.workJobs;
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
				if ((!parent.tool && !parent.actors?.length) || !api.workMay(sessionId, "tools", parent.actors ?? [], parent.jobs)) {
					throw new WireError("invalid_request", "The parent does not have tools rights");
				}
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
				if (signal.aborted) throw new WireError("cancelled", "Parent or callback was cancelled");
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
			peer.handle("host/env/write", async (p, ctx) => {
				const env = await environment(p);
				if (signalOf(p.parentRequestId, ctx.signal).aborted) throw new WireError("cancelled", "Parent or callback was cancelled");
				await env.writeFile(p.path, Buffer.from(p.data, "base64"));
				return {};
			});
			peer.handle("host/env/exists", async (p) => ({ exists: await (await environment(p)).exists(p.path) }));
			peer.handle("host/env/exec", async (p, ctx) => {
				const env = await environment(p);
				const signal = signalOf(p.parentRequestId, ctx.signal);
				if (signal.aborted) throw new WireError("cancelled", "Parent or callback was cancelled");
				const result = await env.exec(String(p.command), { signal, timeoutMs: p.timeoutMs,
					onOutput: (chunk) => { if (!signal.aborted) peer.notify("host/env/output", { parentRequestId: ctx.id, chunk }); },
				});
				if (signal.aborted) throw new WireError("cancelled", "Parent or callback was cancelled");
				return result;
			});
			peer.handle("host/hook", async (p) => {
				const parent = parentOf(p);
				const attempt = parent.provider;
				if (!attempt || !["provider.request", "provider.response"].includes(p.hook)
					|| p.payload?.provider !== attempt.model.provider || (p.payload?.sessionId ?? undefined) !== parent.sessionId
					|| !wireEqual(p.payload.model, attempt.model)) throw invalidState("Not this Provider's hook");
				if (p.hook === "provider.response") {
					if (!attempt.committed || attempt.response || p.payload.message?.role !== "assistant") throw invalidState("Invalid Provider response phase");
					attempt.response = p.payload.message;
					const { sessionId, provider, model, message } = p.payload;
					await api.runHook(p.hook, fromWire({ sessionId: sessionId ?? null, provider, model, message }));
					return null;
				}
				if (parent.signal?.aborted) throw new WireError("cancelled", "Parent was cancelled");
				if (attempt.begun || !wireEqual(p.payload.request, attempt.request)) throw invalidState("Invalid Provider request phase or payload");
				attempt.begun = true;
				try {
					const result = attempt.prepare ? { ...p.payload, request: toWire(await attempt.prepare()) } : toWire(await api.runHook(p.hook, fromWire(p.payload)));
					parent.signal?.throwIfAborted();
					if (!peer.isWaiting(p.parentRequestId)) throw invalidState("Parent is no longer live");
					attempt.committed = true;
					return result;
				} catch (error) {
					attempt.failure = error;
					const e = error as { code?: string; limit?: string };
					if (e.code === "turn_limit") throw new WireError("turn_limit", "Turn limit reached", -32000, { limit: e.limit });
					if (parent.signal?.aborted) throw new WireError("cancelled", "Parent was cancelled");
					throw error;
				}
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
						if (!entries.length) throw new WireError("result_too_large", "One entry and its cursor do not fit in a page");
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

			const activeJobs = new Set<string>();
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
					const handle = api.startJob(parent.sessionId, { kind: p.kind, key: p.key, detail: p.detail, actors: parent.actors, jobs: parent.jobs, toolCallId: parent.tool?.call.id });
					await handle.ready;
					if (handle.started) activeJobs.add(handle.id);
					return { jobId: handle.id, started: handle.started };
				} catch (error) { throw new WireError("invalid_request", String(error)); }
			});
			peer.onNotification("host/jobs/progress", (p) => {
				const id = ownJob(p);
				if (activeJobs.has(p.jobId) && Array.isArray(p.content)) api.resumeJob(id, p.jobId).progress(fromWire(p.content));
			});
			peer.handle("host/jobs/end", async (p) => {
				const id = ownJob(p);
				if (!["completed", "failed", "cancelled"].includes(p.outcome?.kind) || typeof p.report !== "boolean" ||
					(p.result !== undefined && !Array.isArray(p.result))) throw new WireError("invalid_request", "Invalid job result");
				const previous = api.history(id, { all: true }).find((e) => e.kind === "jobEnded" && e.jobId === p.jobId);
				if (previous) {
					if (!previous.erased && wireEqual(previous.data, { outcome: p.outcome, result: fromWire(p.result), report: p.report })) return {};
					throw new WireError("invalid_request", "Job already ended");
				}
				try { await api.resumeJob(id, p.jobId).finish(p.outcome.kind, fromWire(p.result), { report: p.report, error: p.outcome.error }); }
				catch (error) { throw new WireError("invalid_request", String(error)); }
				return {};
			});
			peer.handle("host/jobs/unfinished", async (p) => ({
				jobs: api.unfinishedJobs(sessionOf(p)).map(({ job, key, detail }) => ({ jobId: job.id, kind: job.kind, key, detail, actorId: job.actorId })),
			}));
			peer.handle("host/jobs/resume", async (p) => {
				if (activeJobs.has(p.jobId)) throw new WireError("invalid_request", "Job is already running on this connection");
				try { api.resumeJob(ownJob(p), p.jobId); } catch { throw new WireError("invalid_request", "Job cannot resume"); }
				activeJobs.add(p.jobId);
				return {};
			});
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
			else for (const method of ["newId", "prepareStep", "model", "hook", "definition", "runToolCall", "record", "takeSteering", "hasSteering"]) {
				peer.handle(`host/runtime/${method}`, () => { throw new WireError("invalid_request", "This connection has no Runtime parent"); });
			}
			for (const h of reg.hooks ?? []) {
				if (h.hook === "output") {
					api.on(h.hook, async (p: import("@modular-agent/harness").OutputPayload) => {
						const mapped = p.events.map(mapOutput);
						const events = mapped.map((m) => m.wire);
						const answer = await peer.request<{ events?: { type: string; data: unknown }[]; block?: boolean } | null>("hook/handle", {
							handlerId: h.handlerId, hook: h.hook, payload: { sessionId: p.sessionId, recipient: p.recipient, events, final: true },
						});
						if (answer === null) return undefined;
						if (answer?.block === true) return { action: "block" };
						if (!Array.isArray(answer?.events) || answer.events.length !== events.length) throw new WireError("invalid_request", "Invalid output gate answer");
						return { action: "pass", events: mapped.map((m, i) => m.restore(answer.events![i])) };
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

interface Attempt {
	request?: ModelRequest;
	answer?: AssistantMessage;
	sent?: boolean;
	record?: HistoryEntry;
	writing?: boolean;
	after?: boolean;
}
interface CallState {
	original: ToolCall;
	offered: boolean;
	phase: "unstarted" | "checking" | "allowed" | "dispatched" | "pending" | "settled";
	allowed?: ToolCall;
	registration?: ReturnType<NonNullable<RuntimeHost["registration"]>>;
	result?: ToolResult;
	record?: HistoryEntry;
}
interface Turn {
	input: TurnInput; host: RuntimeHost; signal: AbortSignal;
	attempts: Map<string, Attempt>;
	calls: Map<string, CallState>;
	usage: Usage;
	current?: string;
	entries: Set<string>;
	ended?: boolean;
	limit?: string;
	refusal?: string;
	replacement?: ModelRequest;
	replay?: HistoryEntry;
}
const invalidState = (message: string) => new WireError("invalid_request", message);
const comparable = (value: unknown) => JSON.parse(JSON.stringify(value ?? null));
const wireEqual = (a: unknown, b: unknown) => isDeepStrictEqual(comparable(a), comparable(b));
const sameCall = (a: ToolCall, b: ToolCall) => a?.id === b.id && a?.name === b.name && a?.startedBy === b.startedBy &&
	(a.stepId === undefined || a.stepId === b.stepId) && (a.actorId === undefined || a.actorId === b.actorId) && wireEqual(a.input, b.input);

/** A Runtime in another process proposes work. Dispatch and settlement belong to this parent. */
class WireRuntime implements Runtime {
	private turns = new Map<number | string, Turn>();
	constructor(private peer: WirePeer, readonly id: string, readonly supports: Runtime["supports"], private track: Track) {
		const turn = (p: any): Turn => {
			const t = this.turns.get(p?.parentRequestId);
			if (!t || t.ended || !peer.isWaiting(p.parentRequestId) || (p.sessionId !== undefined && p.sessionId !== t.input.sessionId)) throw invalidState("No live turn for this session");
			return t;
		};
		const effect = (t: Turn) => {
			if (t.signal.aborted) throw new WireError("cancelled", "Turn was cancelled");
			if (t.refusal !== undefined) throw invalidState("The step gate refused further work");
		};
		const atBoundary = (t: Turn) => !t.current || t.attempts.get(t.current)?.after;
		const withLimit = async <T>(t: Turn, work: () => Promise<T>): Promise<T> => {
			try { return await work(); }
			catch (error) {
				const e = error as { code?: string; limit?: string };
				if (e.code === "turn_limit" && e.limit) { t.limit = e.limit; throw new WireError("turn_limit", "Turn limit reached", -32000, { limit: e.limit }); }
				throw error;
			}
		};
		peer.handle("host/runtime/newId", async (p) => {
			const t = turn(p);
			const id = await t.host.newId();
			t.attempts.set(id, {});
			return { id };
		});
		peer.handle("host/runtime/prepareStep", async (p) => {
			const t = turn(p);
			effect(t);
			const step = t.attempts.get(p.stepId);
			if (!step || step.sent || step.request || !atBoundary(t) || !wireEqual(t.usage, p.usage)) throw invalidState("Invalid step preparation");
			t.current = p.stepId;
			try {
				await this.closeReplay(t);
				step.request = await withLimit(t, () => t.host.prepareStep({ stepId: p.stepId, usage: p.usage }));
			} catch (error) { t.current = undefined; throw error; }
			t.host.report("step.started", {}, { stepId: p.stepId });
			return toWire(step.request);
		});
		peer.handle("host/runtime/model", async (p, ctx) => {
			const t = turn(p);
			effect(t);
			const step = t.attempts.get(p.stepId);
			const request = fromWire(p.request) as ModelRequest;
			if (!step || step.sent || !(p.stepId === t.current && step.request && wireEqual(step.request, request) ||
				atBoundary(t) && (t.replacement && wireEqual(t.replacement, request) || t.replay && wireEqual((t.replay.data as { request: ModelRequest }).request, request)))) throw invalidState("Model request is not authorized for this step");
			t.current = p.stepId;
			step.request = request;
			step.sent = true;
			t.replacement = undefined;
			const exactReplay = t.replay !== undefined;
			try {
				await this.closeReplay(t);
				step.answer = await withLimit(t, () => t.input.model.request(request, {
					signal: AbortSignal.any([t.signal, ctx.signal]), sessionId: t.input.sessionId, stepId: p.stepId, exactReplay,
					onEffectiveRequest: (effective) => { step.request = effective; },
					onEvent: (event) => { if (peer.isWaiting(p.parentRequestId)) peer.notify("host/runtime/modelEvent", { parentRequestId: ctx.id, event }); },
				}));
			} catch (error) { t.current = undefined; throw error; }
			return toWire(step.answer);
		});
		peer.handle("host/runtime/hook", async (p) => {
			const t = turn(p);
			if (!RUNTIME_HOOKS.has(p.hook) || !p.payload || typeof p.payload !== "object" || Array.isArray(p.payload)) throw invalidState("Invalid Runtime hook");
			const payload = fromWire(p.payload);
			if (payload.sessionId !== undefined && payload.sessionId !== t.input.sessionId ||
				payload.turnId !== undefined && payload.turnId !== t.input.turnId) throw invalidState("Hook scope does not match the turn");
			if (p.hook === "tool.before") {
				effect(t);
				const call = t.calls.get(payload.call?.id);
				if (!call || call.phase !== "unstarted" || !sameCall(payload.call, call.original)) throw invalidState("Call has no eligible gate transition");
				if ([...t.calls.values()].some((other) => other !== call && other.phase === "dispatched" &&
					!(t.host.registration?.(call.original.name)?.definition.parallel && other.registration?.definition.parallel))) throw invalidState("A serial tool is still dispatched");
				call.phase = "checking";
				const registration = t.host.registration?.(call.original.name);
				const hookPayload = { call: call.original, definition: registration?.definition };
				const gate: { value: { call: ToolCall }; refused?: string; pending?: string } = !call.offered || !registration ? { value: hookPayload, refused: "not offered" } :
					await t.host.hook<{ value: { call: ToolCall }; refused?: string; pending?: string }>("tool.before", hookPayload);
				if (gate.refused !== undefined) {
					const result = await this.settle(t, call, { callId: call.original.id, status: "refused", content: [text(gate.refused)] });
					return toWire({ value: hookPayload, refused: gate.refused, result });
				}
				else if (gate.pending) call.phase = "pending";
				else {
					const allowed = gate.value.call;
					if (!allowed || allowed.id !== call.original.id || allowed.name !== call.original.name ||
						allowed.startedBy !== call.original.startedBy || allowed.actorId !== call.original.actorId || allowed.stepId !== call.original.stepId) {
						const result = await this.settle(t, call, { callId: call.original.id, status: "refused", content: [text("Gate changed call identity")] });
						return toWire({ value: hookPayload, refused: "Gate changed call identity", result });
					}
					call.allowed = allowed;
					call.registration = registration;
					call.phase = "allowed";
				}
				return toWire(gate);
			}
			if (p.hook === "tool.after") {
				const call = t.calls.get(payload.call?.id);
				if (!call?.result || !sameCall(payload.call, call.allowed ?? call.original) || !wireEqual(payload.result, call.result)) throw invalidState("Tool result differs from committed result");
				return toWire({ ...payload, result: call.result });
			}
			if (p.hook === "step.after" || p.hook === "model.failed") {
				const stepId = p.hook === "step.after" ? payload.stepId : t.current;
				const step = t.attempts.get(stepId);
				if (!step?.record || stepId !== t.current) throw invalidState("No answered step for hook");
				if (p.hook === "step.after") {
					if (!wireEqual(payload.response, step.answer) || [...t.calls.values()].some((call) => call.phase !== "pending" && call.phase !== "settled")) throw invalidState("Step has an unfinished call round");
					const answer = await t.host.hook<{ refused?: string }>("step.after", { stepId, response: step.answer });
					if (!step.after) t.host.report("step.ended", { usage: step.answer?.usage }, { stepId });
					step.after = true;
					t.refusal = answer.refused;
					return toWire(answer);
				} else {
					if (step.answer?.stop !== "failed") throw invalidState("Step did not fail");
					payload.stepId = stepId;
					payload.request = step.request ?? payload.request;
					payload.error = step.answer.error ?? { kind: "other", message: "unknown" };
				}
			}
			if (p.hook === "turn.end") {
				if (!t.signal.aborted && !t.limit && payload.outcome?.kind !== "failed" && !atBoundary(t)) throw invalidState("Turn ended inside a step");
				if (t.signal.aborted || t.limit) payload.outcome = t.signal.aborted ? { kind: "cancelled" } : { kind: "limit", limit: t.limit };
				else if (t.refusal !== undefined) payload.outcome = { kind: "failed", error: t.refusal };
				await this.closeReplay(t);
				t.ended = true;
			}
			const answer = await t.host.hook<any>(p.hook, payload);
			if (p.hook === "model.failed" && answer?.retry) t.replacement = answer.request;
			return toWire(answer ?? null);
		});
		peer.handle("host/runtime/definition", async (p) => {
			const t = turn(p);
			const step = t.current ? t.attempts.get(t.current) : undefined;
			return step && !step.request?.tools.some((d) => d.name === p.toolName) ? null : toWire((await t.host.definition(p.toolName)) ?? null);
		});
		peer.handle("host/runtime/runToolCall", async (p, ctx) => {
			const t = turn(p);
			effect(t);
			const candidate = fromWire(p.call) as ToolCall;
			const call = t.calls.get(candidate?.id);
			if (!call || call.phase !== "allowed") throw invalidState("No unused allowance for this call");
			if (!wireEqual(call.registration, t.host.registration?.(call.original.name))) {
				call.phase = "unstarted";
				call.allowed = undefined;
				throw invalidState("Tool registration has changed; a new gate is required");
			}
			const round = [...t.calls.values()].filter((c) => c.original.stepId === call.original.stepId);
			if (!round.every((c) => t.host.registration?.(c.original.name)?.definition.parallel) &&
				round.slice(0, round.indexOf(call)).some((c) => c.phase !== "settled" && c.phase !== "pending")) throw invalidState("Calls must dispatch in model order");
			call.phase = "dispatched";
			if (!sameCall(candidate, call.allowed!)) return toWire(await this.settle(t, call, { callId: call.original.id, status: "refused", content: [text("Call differs from the allowed operation")] }));
			const result = await t.host.runToolCall(call.allowed!, AbortSignal.any([t.signal, ctx.signal]));
			if ("pending" in result) { call.phase = "pending"; return toWire(result); }
			return toWire(await this.settle(t, call, result));
		});
		peer.handle("host/runtime/record", async (p) => {
			const t = turn(p);
			const entry = fromWire(p.entry);
			if (!entry || typeof entry.kind !== "string") throw invalidState("Missing Runtime entry");
			let record: HistoryEntry;
			if (entry.kind === "response") {
				const step = t.attempts.get(entry.stepId);
				if (!step?.answer || !wireEqual(entry.message, step.answer) || step.writing) throw invalidState("Response does not match the model attempt");
				if (!step.record) {
					step.writing = true;
					try {
						step.record = await t.host.record({ kind: "response", writer: this.id, stepId: entry.stepId, message: step.answer, modelVisible: true });
						t.usage = addUsage(t.usage, step.answer.usage);
						if (step.answer.stop === "toolUse" || step.answer.stop === "finished") for (const part of step.answer.content.filter(isToolCall)) {
							t.calls.set(part.id, { original: { id: part.id, name: part.name, input: part.arguments, startedBy: "model", actorId: t.host.callActor?.(), stepId: entry.stepId },
								offered: step.request!.tools.some((d) => d.name === part.name), phase: "unstarted" });
						}
					} finally { step.writing = false; }
				}
				record = step.record;
			} else if (entry.kind === "toolResult") {
				const call = t.calls.get(entry.toolCallId);
				if (!call?.record || entry.data?.status === "notStarted" || !wireEqual(call.record.message, entry.message) ||
					!wireEqual(call.record.data, entry.data) || entry.stepId !== call.record.stepId) throw invalidState("Result does not match a committed result");
				record = call.record;
			} else {
				if (!entry.kind.includes(".")) throw invalidState("The Runtime cannot record this entry kind");
				record = await t.host.record({ kind: entry.kind.startsWith(this.id + ".") ? entry.kind : this.id + "." + entry.kind, writer: this.id, data: entry.data, modelVisible: false });
			}
			t.entries.add(record.id);
			return toWire(record);
		});
		peer.handle("host/runtime/takeSteering", async (p) => {
			const t = turn(p);
			if (!this.supports.inputDuringTurn) throw new WireError("not_supported", "Steering is not offered");
			if (p.final !== undefined && typeof p.final !== "boolean" || p.final && !atBoundary(t)) throw invalidState("Final steering outside the boundary");
			const entries = atBoundary(t) ? await t.host.takeSteering(p.final === true) : [];
			for (const entry of entries) t.entries.add(entry.id);
			return { entries: toWire(entries) };
		});
		peer.handle("host/runtime/hasSteering", async (p) => ({ waiting: await turn(p).host.hasSteering() }));
		peer.onNotification("host/runtime/report", (p) => {
			const t = this.turns.get(p?.parentRequestId);
			if (!t || t.ended || !peer.isWaiting(p.parentRequestId) || typeof p.type !== "string" || !p.type.startsWith(this.id + ".")) return;
			t.host.report(p.type, fromWire(p.data), { stepId: p.stepId, toolCallId: p.toolCallId });
		});
	}

	private async closeReplay(t: Turn) {
		const replay = t.replay;
		t.replay = undefined;
		if (replay) await this.abortAttempt(t.host, replay);
	}

	private async abortAttempt(host: RuntimeHost, attempt: HistoryEntry) {
		await host.record({ kind: "response", writer: "harness", stepId: attempt.stepId, modelVisible: false,
			message: { role: "assistant", content: [], stop: "aborted" }, data: { recovery: true } });
	}

	private async settle(t: Turn, call: CallState, result: ToolResult): Promise<ToolResult> {
		const original = call.allowed ?? call.original;
		try {
			const transformed = await t.host.hook<{ result?: ToolResult }>("tool.after", { call: original, result });
			if (transformed?.result) result = { ...result, content: transformed.result.content, value: transformed.result.value };
		} catch { result = { callId: original.id, status: result.status, content: [text("Tool result could not be processed")] }; }
		call.record = await t.host.record({ kind: "toolResult", writer: "harness", modelVisible: true, stepId: original.stepId, toolCallId: original.id,
			message: { role: "toolResult", toolCallId: original.id, toolName: original.name, content: result.content, isError: result.status !== "completed" },
			data: { status: result.status, value: result.value } });
		call.phase = "settled";
		return call.result = result;
	}
	private async turn(method: string, input: TurnInput, host: RuntimeHost, signal: AbortSignal, extra: Record<string, unknown> = {}): Promise<TurnOutcome> {
		const turn = { sessionId: input.sessionId, turnId: input.turnId, startedBy: input.startedBy, model: toWire(input.model.model), modelSupports: input.model.supports, settings: input.settings, ...(input.resultShape ? { resultShape: input.resultShape } : {}) };
		const t: Turn = { input, host, signal, attempts: new Map(), calls: new Map(), usage: zeroUsage(), entries: new Set() };
		const interrupted = extra.interrupted as InterruptedTurn | undefined;
		if (interrupted) {
			const branch = await host.history();
			const restored = restoreAnsweredStep(branch, input.turnId, await host.history({ all: true }));
			if (restored) {
				const { lastStep, response } = restored;
				t.current = lastStep.stepId;
				const intent = branch.find((e) => e.kind === "modelRequest" && e.stepId === lastStep.stepId);
				t.attempts.set(t.current, { answer: response.message as AssistantMessage, record: response, sent: true,
					request: (intent?.data as { request?: ModelRequest } | undefined)?.request, after: lastStep.decision !== undefined });
				t.refusal = lastStep.decision?.refuse;
			}
			const history = branch.filter((e) => e.turnId === input.turnId);
			const responses = new Map(history.filter((e) => e.kind === "response").map((e) => [e.stepId, e]));
			const unmatched = history.filter((e) => e.kind === "modelRequest" && !responses.has(e.stepId));
			const last = unmatched.at(-1);
			for (const attempt of unmatched) {
				const d = attempt.data as { safeToRepeat?: boolean; model?: ModelRef; request?: ModelRequest; auxiliary?: boolean } | undefined;
				const supports = input.model.supports;
				if (attempt === last && this.supports.continuesAfterRestart && !attempt.erased && d?.safeToRepeat && !d.auxiliary && d.request &&
					wireEqual(d.model, { id: input.model.model.id, provider: input.model.model.provider }) &&
					(supports.safeToRepeat || supports.keepsState === false && supports.runsTools === false)) t.replay = attempt;
				else await this.abortAttempt(host, attempt);
			}
			for (const attempt of history.filter((e) => e.kind === "modelRequest" && !(e.data as { auxiliary?: boolean } | undefined)?.auxiliary)) {
				const row = responses.get(attempt.stepId);
				t.usage = addUsage(t.usage, row?.message?.role === "assistant" ? row.message.usage : row?.usage);
			}
		}
		for (const call of interrupted?.calls ?? (extra.calls as InterruptedTurn["calls"] | undefined) ?? []) {
			const original: ToolCall = { id: call.id, name: call.name, input: call.input, startedBy: "model", actorId: host.callActor?.(), stepId: call.stepId };
			t.calls.set(call.id, { original, offered: true, phase: "unstarted" });
		}
		const req = this.peer.request<TurnOutcome>(method, { turn, ...toWire(extra) }, signal);
		this.turns.set(req.id, t);
		try {
			const reply = fromWire(await this.track(req, { runtime: true, sessionId: input.sessionId, signal })) as TurnOutcome;
			await this.closeReplay(t);
			if (signal.aborted) return { outcome: { kind: "cancelled" }, result: { openToolCalls: [] }, entries: [...t.entries], usage: t.usage };
			if (t.limit && (reply.outcome.kind !== "limit" || reply.outcome.limit !== t.limit)) throw invalidState("Runtime did not report the signalled limit");
			if (method === "runtime/runTurn" && (!wireEqual(reply.usage, t.usage) || !wireEqual(reply.entries, [...t.entries]))) throw invalidState("Runtime outcome does not match its committed work");
			const pending = reply.outcome.kind === "cancelled" ? [] :
				pendingToolCalls(await host.history(), input.turnId, await host.history({ all: true }));
			if (!wireEqual(reply.result.openToolCalls, pending)) throw invalidState("Runtime outcome has invalid open calls");
			if (t.refusal !== undefined && !t.limit) return { ...reply, outcome: { kind: "failed", error: t.refusal } };
			return reply;
		} finally {
			this.turns.delete(req.id);
			for (const call of t.calls.values()) {
				if (!["unstarted", "allowed", "checking"].includes(call.phase)) continue;
				const original = call.original;
				await host.record({ kind: "toolResult", writer: "harness", modelVisible: true, stepId: original.stepId, toolCallId: original.id,
					message: { role: "toolResult", toolCallId: original.id, toolName: original.name, content: [text(interruptedNote(false))], isError: true },
					data: { status: "notStarted" } });
			}
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
	readonly prepareOnWire = true;
	constructor(private peer: WirePeer, readonly id: string, readonly supports: Provider["supports"], private list: ModelInfo[], private track: Track) {}
	models(): ModelInfo[] {
		return this.list;
	}
	async available(): Promise<boolean> {
		return (await this.peer.request<{ available: boolean }>("provider/available", { provider: this.id }).catch(() => ({ available: true }))).available;
	}
	async request(model: ModelRef, request: ModelRequest, options: RequestOptions): Promise<AssistantMessage> {
		const attempt: ProviderAttempt = { model, request: toWire(request), prepare: options.prepareDispatch };
		const req = this.peer.request("provider/request", { provider: this.id, model, request: attempt.request, sessionId: options.sessionId }, options.signal);
		const onEvent = (p: { parentRequestId: number; event: { type: "text" | "reasoning" | "toolInput"; delta: string } }) => {
			if (p.parentRequestId === req.id && attempt.committed && !attempt.response && !options.signal.aborted) options.onEvent?.(p.event);
		};
		WireProvider.listen(this.peer, req.id, onEvent);
		try {
			const answer = await this.track(req, { provider: attempt, sessionId: options.sessionId, signal: options.signal });
			if (!attempt.committed || !attempt.response || !wireEqual(answer, attempt.response)) throw invalidState("Provider did not settle the committed attempt consistently");
			return fromWire(answer) as AssistantMessage;
		} catch (error) {
			if (attempt.failure) throw attempt.failure;
			if (!attempt.committed && options.prepareDispatch) throw error;
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
	async hasPoint(point: string): Promise<boolean> {
		return (await this.peer.request<{ exists: boolean }>("env/checkPoint", { cwd: this.cwd, sessionId: this.sessionId, point })).exists === true;
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
