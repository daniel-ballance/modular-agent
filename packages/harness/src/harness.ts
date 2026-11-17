import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { interruptedCalls } from "./view.js";
import { HookRegistry } from "./hooks.js";
import { type InputReceipt, type InputTiming, type QueuedInput, Session } from "./session.js";
import {
	interruptedNote,
	type Actor,
	type AgentEvent,
	type Answer,
	type Authority,
	type Configuration,
	type ContentPart,
	type Declaration,
	type CredentialStore,
	type EntryDraft,
	type GateResult,
	type HandlerOrder,
	type HistoryEntry,
	type HistoryStore,
	type HookRule,
	type InputRequest,
	type InputRequestDraft,
	type InterruptedTurn,
	type InterfaceCapability,
	type Job,
	type JobState,
	type ModelAccess,
	type ModelInfo,
	type ModelRequest,
	type OutputAnswer,
	type OutputPayload,
	type Provider,
	type Runtime,
	type RuntimeHost,
	type StoredSession,
	type ToolCall,
	type ToolDefinition,
	type ToolPending,
	type ToolResult,
	type ToolSource,
	type TurnOutcome,
	type TurnSettings,
	type TurnSnapshot,
	type WorkingEnvironment,
	isPending,
	isToolCall,
	text,
	textOf,
	zeroUsage,
} from "./types.js";

// ---------- Plugins ----------

export interface Plugin {
	name: string;
	/** Global plugins load; project plugins load only once the project is trusted. */
	origin?: "global" | "project";
	/** A plugin this one deliberately replaces. */
	replaces?: string;
	/** How to load this plugin somewhere else, such as in another process: a module, the factory it exports, and options it can take as JSON. */
	spawn?: { module: string; export: string; options?: unknown };
	setup(api: PluginApi): void | Promise<void>;
	stop?(): void | Promise<void>;
}

export interface CommandContext { sessionId: string; actorId: string; api: PluginApi }
export interface Command { description: string; run(args: string, context: CommandContext): Promise<string | void> | string | void }

export interface SessionStartOptions { settings?: Record<string, unknown>; actor?: Actor; forkFrom?: { sessionId: string; entryId: string }; parentSessionId?: string }
export interface InputOptions { content: ContentPart[] | string; when?: InputTiming; key?: string; actorId: string; kind?: string; startedBy?: QueuedInput["startedBy"]; sources?: string[] }
export interface ErasureReport { erased: string[]; pending: string[]; outOfReach: string[] }

export interface JobHandle {
	id: string;
	/** The entry that recorded this job starting. */
	startEntryId?: string;
	progress(content: ContentPart[] | string): void;
	/** Finish the job. Its result enters the session as input and may start a turn, unless report is false. */
	finish(state: Exclude<JobState, "running">, result?: ContentPart[] | string, options?: { report?: boolean; sources?: string[] }): Promise<void>;
	onCancel(fn: () => void | Promise<void>): void;
}
export interface Transaction {
	append(draft: EntryDraft): void;
	setSetting(key: string, value: unknown, actorId?: string): void;
	input(options: InputOptions): void;
}
export interface FollowOptions { recipient: string; fromEntry?: number; raw?: boolean }

/** Everything a plugin can do. A plugin can do nothing else. */
export interface PluginApi {
	readonly name: string;
	readonly project: string;
	readonly home: string;
	/** The project a session works on: its "cwd" setting, or the Harness's project. */
	projectOf(sessionId: string): string;
	// capabilities
	provide(capability: string, implementation: unknown): void;
	use<T>(capability: string): T | undefined;
	useAll<T>(capability: string): T[];
	// hook points
	defineHook(name: string, rule: HookRule): void;
	on(hook: string, handler: (payload: any) => unknown, order?: HandlerOrder): () => void;
	/** Run a hook point this plugin owns, by its rule. */
	runHook<T = any>(hook: string, payload: any): Promise<T>;
	/** Report a problem that didn't stop this plugin, such as a server it couldn't reach. Hosts and Interfaces see it. */
	reportProblem(where: string, error: unknown): void;
	// events
	onEvent(listener: (event: AgentEvent) => void, options?: { raw?: boolean }): () => void;
	emit(sessionId: string, type: string, data?: any, ids?: Partial<AgentEvent>): void;
	// commands
	registerCommand(name: string, command: Command): void;
	commands(): { name: string; description: string; plugin: string }[];
	runCommand(sessionId: string, line: string, actorId: string): Promise<string | void>;
	// sessions
	startSession(options?: SessionStartOptions): Promise<string>;
	openSession(id: string, actor?: Actor): Promise<string>;
	/** Add an actor to a session. Its authority must be within the authority of whoever grants it. */
	join(sessionId: string, actor: Actor, grantedBy: string): Promise<void>;
	leave(sessionId: string, actorId: string): Promise<void>;
	/** Sessions in this project, another project, or every project (null). */
	listSessions(project?: string | null): Promise<StoredSession[]>;
	forkSession(sessionId: string, entryId: string): Promise<string>;
	closeSession(sessionId: string): Promise<void>;
	session(sessionId: string): { id: string; settings: Record<string, unknown>; position: string | null; busy: boolean; actors: Actor[]; ephemeral: boolean };
	// input and turns
	input(sessionId: string, options: InputOptions): Promise<InputReceipt & { handled?: boolean; output?: string }>;
	withdraw(sessionId: string, inputId: string): QueuedInput | undefined;
	cancel(sessionId: string): Promise<QueuedInput[]>;
	waitForIdle(sessionId: string): Promise<void>;
	moveTo(sessionId: string, entryId: string, options?: { rewind?: boolean; actorId?: string }): Promise<void>;
	setSetting(sessionId: string, key: string, value: unknown, actorId?: string): Promise<void>;
	// history
	history(sessionId: string, options?: { all?: boolean }): HistoryEntry[];
	/** The history as a recipient may see it: every entry passes the output gate for that recipient. */
	gatedHistory(sessionId: string, options: { recipient: string; all?: boolean }): Promise<HistoryEntry[]>;
	append(sessionId: string, draft: EntryDraft): Promise<HistoryEntry>;
	transaction(sessionId: string, fn: (tx: Transaction) => void | Promise<void>): Promise<void>;
	erase(sessionId: string, entryIds: string[], actorId: string): Promise<ErasureReport>;
	// tools
	tools(sessionId?: string): ToolDefinition[];
	callTool(sessionId: string, call: Omit<ToolCall, "id"> & { id?: string }): Promise<ToolResult>;
	// actors
	ask(sessionId: string, request: InputRequestDraft): Promise<Answer>;
	answer(sessionId: string, answer: Answer): { accepted: boolean; reason?: string };
	openRequests(sessionId: string): InputRequest[];
	// jobs
	/** Start a job. It is recorded in the history, with the plugin's own detail. */
	startJob(sessionId: string, options: { kind: string; actorId?: string; detail?: unknown }): JobHandle;
	/** Jobs this plugin started that the history shows as never ended, for example because the process stopped. */
	unfinishedJobs(sessionId: string): { job: Job; detail?: unknown }[];
	/** Take over a recorded, unfinished job of this plugin's after a restart. */
	resumeJob(sessionId: string, jobId: string): JobHandle;
	jobs(sessionId: string): Job[];
	cancelJob(sessionId: string, jobId: string): Promise<void>;
	// following along
	follow(sessionId: string, options: FollowOptions, listener: (event: AgentEvent) => void): () => void;
	declaration(sessionId?: string): Declaration;
	modelAccess(sessionId: string): ModelAccess | undefined;
	// settings
	config(): Record<string, unknown>;
}

export interface HarnessOptions { project: string; home: string; now?: () => number; newId?: () => string }

export const ALL_AUTHORITY: Authority[] = ["watch", "propose", "input", "answer", "approve", "tools", "cancel", "settings", "erase", "grant", "jobs", "delegate"];

interface TurnState extends TurnSnapshot { endedHook?: boolean; sources: Map<string, string[]>; actors: Set<string> }

/**
 * The Harness: hosts plugins, offers the plugin API, keeps sessions.
 * It runs no turns, calls no models and runs no tools itself.
 */
export class Harness {
	readonly hooks: HookRegistry;
	readonly project: string;
	readonly home: string;
	private caps = new Map<string, { plugin: string; impl: unknown }[]>();
	private loaded: { plugin: Plugin; api: PluginApi }[] = [];
	private sessions = new Map<string, Session>();
	private listeners: { plugin: string; raw: boolean; fn: (e: AgentEvent) => void }[] = [];
	private commandTable = new Map<string, Command & { plugin: string }>();
	private now: () => number;
	private newId: () => string;
	private refusedTools = new Set<string>();
	private turnAuthority = new AsyncLocalStorage<{ sessionId: string; actors: Set<string> }>();
	private toolWork = new AsyncLocalStorage<ToolCall>();
	readonly problems: { plugin: string; where: string; error: string }[] = [];

	constructor(options: HarnessOptions) {
		this.project = options.project;
		this.home = options.home;
		this.now = options.now ?? Date.now;
		this.newId = options.newId ?? randomUUID;
		this.hooks = new HookRegistry(({ hook, plugin, error }) => this.problem(plugin, `hook ${hook}`, error));
		const h = (name: string, rule: HookRule, owner: string) => this.hooks.define(name, rule, owner);
		// Harness hook points
		h("plugin.load", "gate", "harness");
		h("session.start", "observe", "harness");
		h("session.end", "observe", "harness");
		h("input", "transform", "harness");
		h("turn.before", "collect", "harness");
		h("output", "gate", "harness"); // applied by the Harness with its own rule: pass, redact, block or hold
		// The standard Runtime hook points, defined here so every Runtime offers the same set
		h("turn.start", "observe", "runtime");
		h("step.before", "transform", "runtime");
		h("step.after", "gate", "runtime");
		h("tool.before", "gate", "runtime");
		h("tool.after", "transform", "runtime");
		h("model.failed", "first", "runtime");
		h("turn.result", "gate", "runtime");
		h("turn.end", "observe", "runtime");
		// Provider hook points
		h("provider.request", "transform", "provider");
		h("provider.response", "observe", "provider");
	}

	// ---------- hosting ----------

	async load(plugins: Plugin[]): Promise<void> {
		const replaced = new Set(plugins.map((p) => p.replaces).filter((r): r is string => !!r));
		for (const plugin of plugins) {
			if (replaced.has(plugin.name)) {
				this.emit("", "plugin.replaced", { plugin: plugin.name }, "harness");
				continue;
			}
			const gate = await this.hooks.gate("plugin.load", { name: plugin.name, origin: plugin.origin ?? "global", project: this.project });
			if (gate.refused) {
				this.emit("", "plugin.refused", { plugin: plugin.name, reason: gate.refused }, "harness");
				continue;
			}
			const api = this.api(plugin.name);
			try {
				await plugin.setup(api);
				this.loaded.push({ plugin, api });
				this.emit("", "plugin.loaded", { plugin: plugin.name }, "harness");
			} catch (error) {
				this.problem(plugin.name, "setup", error);
			}
		}
	}

	/**
	 * Stop the process's part in every session. This is an interruption, not a
	 * close: running turns and jobs are abandoned without being recorded as ended,
	 * so reopening a session lets its Runtime and job plugins decide what happens.
	 */
	async stop(): Promise<void> {
		for (const id of [...this.sessions.keys()]) await this.suspendSession(id).catch(() => undefined);
		for (const { plugin } of [...this.loaded].reverse()) {
			try {
				await plugin.stop?.();
			} catch (error) {
				this.problem(plugin.name, "stop", error);
			}
		}
	}

	plugins(): string[] {
		return this.loaded.map((l) => l.plugin.name);
	}

	/** The plugin API, as seen by one plugin. The host uses its own copy, named "host". */
	api(pluginName: string): PluginApi {
		const self = this;
		return {
			name: pluginName,
			project: this.project,
			home: this.home,
			projectOf: (sessionId) => this.projectOf(this.session(sessionId)),
			provide: (capability, impl) => this.provide(pluginName, capability, impl),
			use: <T>(capability: string) => this.use<T>(capability),
			useAll: <T>(capability: string) => this.useAll<T>(capability),
			defineHook: (name, rule) => this.hooks.define(name, rule, pluginName),
			on: (hook, handler, order) => this.hooks.on(hook, pluginName, handler, order),
			reportProblem: (where, error) => this.problem(pluginName, where, error),
			runHook: async (hook, payload) => {
				// Only the owner runs a hook point: the plugin that defined it, or a plugin providing the capability that owns it.
				const owner = this.hooks.owner(hook);
				const provides = this.caps.get(owner)?.some((c) => c.plugin === pluginName);
				if (owner !== pluginName && !provides) throw new Error(`${pluginName} can't run ${hook}: it belongs to ${owner}`);
				return this.hooks.run(hook, payload);
			},
			onEvent: (fn, options) => {
				if (options?.raw) {
					const entry = { plugin: pluginName, raw: true, fn };
					this.listeners.push(entry);
					return () => {
						this.listeners = this.listeners.filter((l) => l !== entry);
					};
				}
				// Plugins that follow events see the gated view unless they ask for the raw one.
				const follower = new Follower(this.hooks, `plugin:${pluginName}`, false, fn, (e) => this.problem(pluginName, "event listener", e));
				this.pluginFollowers.push(follower);
				return () => {
					this.pluginFollowers = this.pluginFollowers.filter((f) => f !== follower);
				};
			},
			emit: (sessionId, type, data, ids) => this.emit(sessionId, type, data, pluginName, ids),
			registerCommand: (name, command) => {
				if (this.replacedFor(pluginName, `command:${name}`)) return;
				const previous = this.commandTable.get(name);
				if (previous && !this.replacedFor(previous.plugin, `command:${name}`)) this.problem(pluginName, "registerCommand", new Error(`Command /${name} is already registered`));
				else this.commandTable.set(name, { ...command, plugin: pluginName });
			},
			commands: () => [...this.commandTable].map(([name, c]) => ({ name, description: c.description, plugin: c.plugin })),
			runCommand: (sessionId, line, actorId) => this.runCommand(sessionId, line, actorId),
			startSession: (options) => this.startSession(options),
			openSession: (id, actor) => this.openSession(id, actor),
			join: (sessionId, actor, grantedBy) => this.join(this.session(sessionId), actor, grantedBy, pluginName),
			leave: async (sessionId, actorId) => {
				const s = this.session(sessionId);
				await this.commit(s, [{ kind: "actorLeft", writer: pluginName, actorId, modelVisible: false, data: { actorId } }]);
				this.emit(s.id, "session.left", { actorId }, pluginName, { actorId });
			},
			listSessions: async (project) => (await this.use<HistoryStore>("history-store")?.list(project === null ? undefined : { project: project ?? this.project })) ?? [],
			forkSession: (sessionId, entryId) => this.forkSession(sessionId, entryId),
			closeSession: (id) => this.closeSession(id),
			session: (id) => {
				const s = this.session(id);
				return { id: s.id, settings: { ...s.settings }, position: s.position, busy: s.isBusy(), actors: [...s.actors.values()].map((a) => ({ ...a, authority: this.rightsOf(s, a.id) })), ephemeral: s.ephemeral };
			},
			input: (sessionId, options) => this.input(sessionId, options),
			withdraw: (sessionId, inputId) => this.withdraw(sessionId, inputId),
			cancel: (sessionId) => this.cancel(sessionId),
			waitForIdle: (sessionId) => this.waitForIdle(sessionId),
			moveTo: (sessionId, entryId, options) => this.moveTo(sessionId, entryId, options ?? {}, pluginName),
			setSetting: (sessionId, key, value, actorId) => this.setSetting(this.session(sessionId), key, value, pluginName, actorId),
			history: (sessionId, options) => {
				const s = this.session(sessionId);
				return options?.all ? s.order.map((id) => s.entries.get(id)!) : s.branch();
			},
			append: async (sessionId, draft) => (await this.commit(this.session(sessionId), [{ ...draft, writer: draft.writer ?? pluginName }]))[0],
			transaction: (sessionId, fn) => this.transaction(this.session(sessionId), pluginName, fn),
			erase: (sessionId, ids, actorId) => this.erase(this.session(sessionId), ids, actorId, pluginName),
			tools: (sessionId) => this.toolDefinitions(sessionId ? this.session(sessionId) : undefined),
			callTool: (sessionId, call) => this.callTool(this.session(sessionId), { ...call, id: call.id ?? this.newId() }),
			ask: (sessionId, request) => this.ask(this.session(sessionId), request, pluginName),
			answer: (sessionId, answer) => this.answer(this.session(sessionId), answer),
			openRequests: (sessionId) => {
				const s = this.session(sessionId);
				return [...[...s.requests.values()].map((r) => r.request), ...this.waitingRequests(s)];
			},
			startJob: (sessionId, options) => this.startJob(this.session(sessionId), options, pluginName),
			unfinishedJobs: (sessionId) => this.unfinishedJobs(this.session(sessionId)).filter((j) => j.job.plugin === pluginName),
			resumeJob: (sessionId, jobId) => {
				const s = this.session(sessionId);
				const found = this.unfinishedJobs(s).find((j) => j.job.id === jobId && j.job.plugin === pluginName);
				if (!found) throw new Error(`No unfinished job ${jobId} of ${pluginName}`);
				return this.jobHandle(s, { ...found.job, state: "running" }, pluginName);
			},
			jobs: (sessionId) => [...this.session(sessionId).jobs.values()].map((j) => ({ ...j.job })),
			cancelJob: (sessionId, jobId) => this.cancelJob(this.session(sessionId), jobId),
			follow: (sessionId, options, listener) => this.follow(this.session(sessionId), options, listener),
			declaration: (sessionId) => this.declaration(sessionId ? this.session(sessionId) : undefined),
			gatedHistory: async (sessionId, options) => {
				const s = this.session(sessionId);
				const entries = options.all ? s.order.map((id) => s.entries.get(id)!) : s.branch();
				const out: HistoryEntry[] = [];
				const follower = new Follower(this.hooks, options.recipient, false, (e) => e.type === "entry" && out.push(e.data as HistoryEntry), (e) => this.problem("harness", "gated history", e));
				for (const entry of entries) follower.push({ type: "entry", time: this.now(), sessionId: s.id, source: "harness", data: entry });
				await follower.idle();
				return out;
			},
			modelAccess: (sessionId) => this.modelAccess(this.session(sessionId)),
			config: () => self.use<Configuration>("configuration")?.plugin(pluginName) ?? {},
		};
	}

	// ---------- capabilities ----------

	/**
	 * Items one plugin deliberately takes over from the others: "working-environment",
	 * "provider:<id>", "tool:<name>" or "command:<name>", mapped to the plugin that owns
	 * them. A plugin in another process names these in its registration
	 * (docs/bindings/plugin.md); everyone else's copy is left out, not shadowed.
	 */
	readonly replacements = new Map<string, string>();
	private replacedFor(plugin: string, item: string): boolean {
		const owner = this.replacements.get(item);
		return owner !== undefined && owner !== plugin;
	}

	private provide(plugin: string, capability: string, impl: unknown): void {
		if (capability === "working-environment" && this.replacedFor(plugin, "working-environment")) return;
		if (capability === "runtime" && this.replacedFor(plugin, "runtime")) return;
		if (capability === "provider" && this.replacedFor(plugin, `provider:${(impl as { id?: string }).id}`)) return;
		const list = this.caps.get(capability) ?? [];
		list.push({ plugin, impl });
		this.caps.set(capability, list);
		this.emit("", "capability.provided", { capability, plugin }, "harness");
	}

	use<T>(capability: string): T | undefined {
		return this.useAll<T>(capability)[0];
	}

	useAll<T>(capability: string): T[] {
		return (this.caps.get(capability) ?? []).filter(({ plugin, impl }) => {
			const item = capability === "provider" ? `provider:${(impl as Provider).id}` : capability;
			return !this.replacedFor(plugin, item);
		}).map((c) => c.impl as T);
	}

	hasItem(item: string): boolean {
		if (item.startsWith("provider:")) return this.useAll<Provider>("provider").some((p) => `provider:${p.id}` === item);
		if (item.startsWith("tool:")) return !!this.findTool(undefined, item.slice(5));
		if (item.startsWith("command:")) return this.commandTable.has(item.slice(8));
		return !!this.use(item);
	}

	// ---------- events ----------

	private emit(sessionId: string, type: string, data: any, source: string, ids?: Partial<AgentEvent>): void {
		const event: AgentEvent = { type, time: this.now(), sessionId, source, ...ids, data };
		const s = sessionId ? this.sessions.get(sessionId) : undefined;
		s?.remember(event);
		for (const l of [...this.listeners]) {
			try {
				l.fn(event);
			} catch (error) {
				if (type !== "plugin.problem") this.problem(l.plugin, "event listener", error);
			}
		}
		for (const f of s?.followers ?? []) f.push(event);
		for (const f of this.pluginFollowers) f.push(event);
	}

	private problem(plugin: string, where: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.problems.push({ plugin, where, error: message });
		this.emit("", "plugin.problem", { plugin, where, error: message }, "harness");
	}

	// ---------- following, through the output gate ----------

	private pluginFollowers: Follower[] = [];

	private follow(s: Session, options: FollowOptions, listener: (event: AgentEvent) => void): () => void {
		const follower = new Follower(this.hooks, options.recipient, options.raw ?? false, listener, (e) => this.problem("harness", "follow", e));
		// History first, from the requested point, then live events.
		const from = options.fromEntry ?? s.order.length;
		for (const id of s.order.slice(from)) follower.push({ type: "entry", time: this.now(), sessionId: s.id, source: "harness", data: s.entries.get(id) });
		s.followers.add(follower);
		return () => s.followers.delete(follower);
	}

	// ---------- commands ----------

	private async runCommand(sessionId: string, line: string, actorId: string): Promise<string | void> {
		const match = /^\/(\S+)\s*([\s\S]*)$/.exec(line.trim());
		if (!match) throw new Error("Not a command");
		this.requireAuthority(this.session(sessionId), actorId, "input");
		const command = this.commandTable.get(match[1]);
		if (!command) throw new Error(`Unknown command /${match[1]}`);
		return command.run(match[2], { sessionId, actorId, api: this.api(command.plugin) });
	}

	// ---------- sessions ----------

	session(id: string): Session {
		const s = this.sessions.get(id);
		if (!s) throw new Error(`Session ${id} is not open`);
		return s;
	}

	private defaultActor(): Actor {
		return { id: "user", kind: "user", authority: ALL_AUTHORITY };
	}

	async startSession(options: SessionStartOptions = {}): Promise<string> {
		const store = this.use<HistoryStore>("history-store");
		const cwd = options.settings?.cwd;
		const meta: StoredSession = { id: this.newId(), created: this.now(), project: typeof cwd === "string" ? cwd : this.project, forkedFrom: options.forkFrom, parentSessionId: options.parentSessionId };
		const s = new Session(meta, !store);
		if (store) {
			await store.create(meta);
			await store.openForWriting(meta.id);
		}
		this.sessions.set(meta.id, s);
		const actor = options.actor ?? this.defaultActor();
		s.actors.set(actor.id, actor);
		const config = this.use<Configuration>("configuration");
		const defaults = { ...(config?.get<Record<string, unknown>>("session") ?? {}), ...(options.settings ?? {}) };
		if (options.forkFrom) {
			const source = this.sessions.get(options.forkFrom.sessionId) ?? (store ? await this.loadInto(options.forkFrom.sessionId) : undefined);
			if (source) {
				const path: HistoryEntry[] = [];
				let id: string | null = options.forkFrom.entryId;
				while (id) {
					const e = source.entries.get(id);
					if (!e) break;
					path.push(e);
					id = e.parentId;
				}
				path.reverse();
				const copies = path.map((e) => ({ ...e, sessionId: meta.id }));
				if (store && copies.length) await store.append(meta.id, copies);
				for (const e of copies) s.apply(e);
				for (const [k, v] of Object.entries(source.settings)) if (!(k in defaults)) defaults[k] = v;
			}
		}
		const drafts: EntryDraft[] = [actorJoined(actor, "harness"), ...Object.entries(defaults).map(([key, value]): EntryDraft => ({ kind: "setting", writer: "harness", modelVisible: false, data: { key, value } }))];
		if (drafts.length) await this.commit(s, drafts);
		await this.hooks.observe("session.start", { sessionId: s.id, resumed: false });
		this.emit(s.id, "session.started", { meta }, "harness");
		return s.id;
	}

	private async loadInto(id: string): Promise<Session | undefined> {
		const store = this.use<HistoryStore>("history-store");
		if (!store) return undefined;
		const { meta, entries } = await store.load(id);
		const s = new Session(meta, false);
		for (const e of entries) s.apply(e);
		return s;
	}

	async openSession(id: string, actor?: Actor): Promise<string> {
		if (this.sessions.has(id)) return id;
		const store = this.use<HistoryStore>("history-store");
		if (!store) throw new Error("No history store: sessions can't be reopened");
		await store.openForWriting(id, { wait: true });
		const s = await this.loadInto(id).catch(async (error) => { await store.close(id); throw error; });
		if (!s) throw new Error(`Session ${id} not found`);
		this.sessions.set(id, s);
		const a = actor ?? this.defaultActor();
		if (!s.actors.has(a.id) && !s.order.some((id) => s.entries.get(id)?.kind === "actorLeft" && (s.entries.get(id)?.data as { actorId?: string } | undefined)?.actorId === a.id)) await this.commit(s, [actorJoined(a, "harness")]);
		await this.hooks.observe("session.start", { sessionId: s.id, resumed: true });
		await this.recoverInterruptedTurn(s);
		this.emit(s.id, "session.started", { meta: s.meta, resumed: true }, "harness");
		// Questions left open past their turn are still answerable after a restart.
		for (const request of this.waitingRequests(s)) {
			this.emit(s.id, "input.request.opened", { request, waiting: true }, "harness", { toolCallId: request.toolCallId });
			for (const i of this.viewersFor(s, request)) i.onInputRequest?.(request);
		}
		this.maybeContinueOpenCalls(s);
		return id;
	}

	/** Find a turn whose process stopped, and hand it to the Runtime, which decides what happens to it. */
	private async recoverInterruptedTurn(s: Session): Promise<void> {
		const branch = s.branch();
		const lastStart = branch.findLast((e) => e.kind === "turnStart" && !e.erased);
		if (!lastStart?.turnId) return;
		if (branch.some((e) => e.kind === "turnEnd" && e.turnId === lastStart.turnId)) return;
		const env = await this.environmentFor(s);
		const startedBy = (lastStart.data as { startedBy?: QueuedInput["startedBy"] } | undefined)?.startedBy ?? { kind: "actor", id: lastStart.actorId ?? "user" };
		const pending = new Map((startedBy.kind === "answer" ? this.openCalls(s) : []).map((c) => [c.id, c]));
		for (const c of interruptedCalls(branch, lastStart.turnId)) pending.set(c.id, c);
		const calls = [...pending.values()].map((c) => ({
			...c,
			safeToRepeat: c.safeToRepeat && env?.safeToRepeat === true && this.findTool(s, c.name)?.definition.hints?.safeToRepeat === true,
		}));
		const interrupted: InterruptedTurn = { turnId: lastStart.turnId, calls };
		this.emit(s.id, "turn.interrupted", { pending: interrupted.calls.length }, "harness", { turnId: interrupted.turnId });
		// Not awaited: the resumed turn may wait for an answer that only an Interface opened after this can give.
		void this.launch(s, interrupted.turnId, (signal) => this.resumeTurn(s, interrupted, startedBy, signal, lastStart.data as Partial<TurnSnapshot>));
	}

	/** Used when no Runtime is loaded: the turn ends as failed, and each pending call gets one result. */
	private async endInterruptedTurn(s: Session, interrupted: InterruptedTurn): Promise<void> {
		const drafts: EntryDraft[] = interrupted.calls.map((c) => ({
			kind: "toolResult", writer: "harness", modelVisible: true, turnId: interrupted.turnId, toolCallId: c.id,
			message: { role: "toolResult", toolCallId: c.id, toolName: c.name, content: [text(interruptedNote(c.started))], isError: true },
			data: { status: c.started ? "outcomeUnknown" : "notStarted" },
		}));
		if (drafts.length) await this.commit(s, drafts);
	}

	async forkSession(sessionId: string, entryId: string): Promise<string> {
		const s = this.session(sessionId);
		if (s.erasing) throw new Error("Erasure is in progress");
		// Forking at unfinished work would copy work that is still running: refused.
		if (s.running || s.jobs.size || this.waitingRequests(s).length) throw new Error("Can't fork while the session has unfinished work: a running turn, a job, or a call waiting for an answer");
		return this.startSession({ forkFrom: { sessionId, entryId }, actor: [...s.actors.values()][0] });
	}

	private async suspendSession(id: string): Promise<void> {
		const s = this.sessions.get(id);
		if (!s) return;
		s.suspended = true;
		s.steering = [];
		s.followUps = [];
		s.running?.abort.abort();
		for (const r of s.requests.values()) r.resolve({ requestId: r.request.id, declined: true, actorId: "harness", reason: "the process stopped" });
		s.requests.clear();
		// A stopping process doesn't wait for its work to finish. Nothing more is recorded once suspended.
		await s.committing;
		await this.use<HistoryStore>("history-store")?.close(id);
		this.sessions.delete(id);
	}

	async closeSession(id: string): Promise<void> {
		const s = this.sessions.get(id);
		if (!s) return;
		await this.cancel(id);
		for (const jobId of [...s.jobs.keys()]) await this.cancelJob(s, jobId);
		for (const r of s.requests.values()) r.resolve({ requestId: r.request.id, declined: true, actorId: "harness", reason: "session closed" });
		s.requests.clear();
		await this.hooks.observe("session.end", { sessionId: id });
		await this.use<WorkingEnvironment>("working-environment")?.sessionEnded?.(id);
		this.emit(id, "session.ended", {}, "harness");
		s.closed = true;
		await this.use<HistoryStore>("history-store")?.close(id);
		this.sessions.delete(id);
	}

	// ---------- the record ----------

	/** Commit drafts to the session. All are kept, or none are. */
	commit(s: Session, drafts: EntryDraft[]): Promise<HistoryEntry[]> {
		// A suspended session's process has stopped: nothing more is recorded for it here.
		if (s.suspended) return Promise.resolve([]);
		const run = s.committing.then(() => this.commitNow(s, drafts));
		s.committing = run.catch(() => undefined);
		return run;
	}

	private async commitNow(s: Session, drafts: EntryDraft[]): Promise<HistoryEntry[]> {
		let position = s.position;
		const entries: HistoryEntry[] = drafts.map((d) => {
			const entry: HistoryEntry = { ...d, id: d.id ?? this.newId(), parentId: position, sessionId: s.id, time: this.now() };
			if (entry.kind === "setting") entry.data = normalizeSetting(entry.data as { key: string; value: unknown });
			if (!STANDARD_ENTRY_KINDS.has(entry.kind) && !entry.kind.includes(".")) entry.kind = `${entry.writer}.${entry.kind}`;
			position = entry.kind === "position" ? (entry.data as { to: string | null }).to : entry.id;
			return entry;
		});
		if (!s.ephemeral) await this.use<HistoryStore>("history-store")?.append(s.id, entries);
		for (const e of entries) {
			s.apply(e);
			this.emit(s.id, "entry.added", e, e.writer, { turnId: e.turnId, stepId: e.stepId, toolCallId: e.toolCallId, actorId: e.actorId });
		}
		return entries;
	}

	private async transaction(s: Session, plugin: string, fn: (tx: Transaction) => void | Promise<void>): Promise<void> {
		const drafts: EntryDraft[] = [];
		const inputs: InputOptions[] = [];
		await fn({
			append: (d) => drafts.push({ ...d, writer: d.writer ?? plugin }),
			setSetting: (key, value, actorId) => drafts.push({ kind: "setting", writer: plugin, actorId, modelVisible: false, data: { key, value } }),
			input: (o) => inputs.push(o),
		});
		// Nothing is kept unless the callback finished; then the entries are kept together.
		if (drafts.length) await this.commit(s, drafts);
		for (const o of inputs) await this.input(s.id, o);
	}

	private async setSetting(s: Session, key: string, value: unknown, writer: string, actorId?: string): Promise<void> {
		if (actorId) this.requireAuthority(s, actorId, "settings");
		await this.commit(s, [{ kind: "setting", writer, actorId, modelVisible: false, data: { key, value } }]);
		this.emit(s.id, "setting.changed", { key, value, appliesFrom: "next step" }, writer, { actorId });
	}

	private async moveTo(sessionId: string, entryId: string, options: { rewind?: boolean; actorId?: string }, writer: string): Promise<void> {
		const s = this.session(sessionId);
		if (s.isBusy()) throw new Error("Can't move while a turn is running");
		if (!s.entries.has(entryId)) throw new Error(`Entry ${entryId} not found`);
		if (options.rewind) {
			const decl = this.declaration(s);
			if (decl.rewinding !== true) throw new Error("Rewinding is not supported by this setup. Moving without rewinding still works.");
		}
		const provider = this.providerFor(s);
		if (provider?.supports.keepsState === true) await provider.discardState?.(s.id);
		// Pending work on the branch left behind is cancelled.
		for (const r of s.requests.values()) r.resolve({ requestId: r.request.id, declined: true, actorId: "harness", reason: "moved to another point" });
		s.requests.clear();
		await this.commit(s, [{ kind: "position", writer, actorId: options.actorId, modelVisible: false, data: { to: entryId, rewind: options.rewind ?? false } }]);
		this.emit(s.id, "position.moved", { to: entryId }, writer);
	}

	private async erase(s: Session, entryIds: string[], actorId: string, writer: string): Promise<ErasureReport> {
		this.requireAuthority(s, actorId, "erase");
		const store = this.use<HistoryStore>("history-store");
		const sessions = new Map(this.sessions);
		for (const meta of await store?.list() ?? []) {
			if (!sessions.has(meta.id)) sessions.set(meta.id, (await this.loadInto(meta.id))!);
		}
		for (const session of sessions.values()) await session.committing;
		const targets = eraseCopies(s, entryIds, sessions);
		const acquired: string[] = [];
		const guarded: Session[] = [];
		const report: ErasureReport = { erased: [], pending: [], outOfReach: [] };
		try {
			// Take every lease before erasing anything. These acquisitions never wait for a writer.
			for (const session of targets.keys()) {
				if (session.running || session.jobs.size || session.erasing) throw new Error("Cannot erase while affected work is running");
				session.erasing = true;
				guarded.push(session);
				if (!session.ephemeral) {
					if (!store?.erase) throw new Error("Erasure is not supported by this history store");
					if (!this.sessions.has(session.id)) {
						await store.openForWriting(session.id);
						acquired.push(session.id);
						// A writer may have appended between our read and acquisition. Refuse and retry from a fresh view.
						const current = (await store.load(session.id)).entries;
						if (current.length !== session.order.length || current.some((e, i) => e.id !== session.order[i] || e.erased !== session.entries.get(e.id)?.erased)) {
							throw new Error(`Session ${session.id} changed while planning erasure; retry`);
						}
					}
				}
			}
			for (const [session, ids] of targets) {
				const entryIds = [...ids];
				try {
					if (!session.ephemeral) await store!.erase!(session.id, entryIds);
					await this.commit(session, [{ kind: "erasure", writer, actorId, modelVisible: false, data: { entryIds } }]);
					report.erased.push(...entryIds);
					session.recent.length = 0;
				} catch (error) {
					report.pending.push(`Local erasure in ${session.id}: ${String(error)}`);
					continue;
				}
				for (const provider of this.useAll<Provider>("provider").filter((p) => p.supports.keepsState === true)) {
					try {
						const remote = await provider.discardState?.(session.id, { erase: true });
						if (!provider.discardState) report.outOfReach.push(`Copies held by ${provider.id}`);
						report.pending.push(...(remote?.pending ?? []));
						report.outOfReach.push(...(remote?.outOfReach ?? []));
					} catch (error) { report.pending.push(`${provider.id}: ${String(error)}`); }
				}
				this.emit(session.id, "entries.erased", { count: ids.size }, writer, { actorId });
			}
		} finally {
			for (const session of guarded) session.erasing = false;
			for (const id of acquired) await store!.close(id);
		}
		if (report.erased.length) report.outOfReach.push("Output already delivered and copies beyond the agent");
		return report;
	}

	// ---------- authority ----------

	/** Authority only narrows: a granted actor can do no more than whoever grants it. */
	private async join(s: Session, actor: Actor, grantedBy: string, writer: string): Promise<void> {
		const granter = s.actors.get(grantedBy);
		if (!granter) throw new Error(`Actor ${grantedBy} is not part of this session`);
		const beyond = actor.authority.filter((a) => !this.rightsOf(s, grantedBy).includes(a));
		if (beyond.length) throw new Error(`${grantedBy} can't grant ${beyond.join(", ")}`);
		await this.commit(s, [actorJoined(actor, writer, grantedBy)]);
		this.emit(s.id, "session.joined", { actor }, writer, { actorId: actor.id });
	}

	private requireAuthority(s: Session, actorId: string, authority: Authority): void {
		const actor = s.actors.get(actorId);
		if (!actor) throw new Error(`Actor ${actorId} is not part of this session`);
		if (!this.rightsOf(s, actorId).includes(authority)) throw new Error(`Actor ${actorId} may not ${authority}`);
	}

	private rightsOf(s: Session, actorId: string): Authority[] {
		const context = this.turnAuthority.getStore();
		const contributors = context?.sessionId === s.id ? context.actors : [];
		return (s.actors.get(actorId)?.authority ?? []).filter((right) => [...contributors].every((id) => s.actors.get(id)?.authority.includes(right)));
	}

	// ---------- input and turns ----------

	private async input(sessionId: string, options: InputOptions): Promise<InputReceipt & { handled?: boolean; output?: string }> {
		const s = this.session(sessionId);
		if (s.erasing) throw new Error("Erasure is in progress");
		if (options.startedBy?.kind !== "job") this.requireAuthority(s, options.actorId, "input");
		if (options.key) {
			const earlier = s.keys.get(options.key);
			if (earlier) return { ...earlier, duplicate: true };
		}
		let content = typeof options.content === "string" ? [text(options.content)] : options.content;
		const typed = textOf(content).trim();
		if (typed.startsWith("/") && this.commandTable.has(/^\/(\S+)/.exec(typed)?.[1] ?? "")) {
			const output = await this.runCommand(sessionId, typed, options.actorId);
			const receipt = { inputId: this.newId(), taken: "now" as const, handled: true, output: output ?? undefined };
			if (options.key) s.keys.set(options.key, receipt);
			return receipt;
		}
		const transformed = await this.hooks.transform("input", { sessionId, content, actorId: options.actorId, when: options.when ?? "now" });
		if (s.erasing) throw new Error("Erasure is in progress");
		if (transformed.stopped) {
			const receipt = { inputId: this.newId(), taken: "now" as const, handled: true };
			if (options.key) s.keys.set(options.key, receipt);
			return receipt;
		}
		content = transformed.value.content;
		const queued: QueuedInput = {
			id: this.newId(), content, actorId: options.actorId, when: options.when ?? "now", key: options.key,
			startedBy: options.startedBy ?? { kind: "actor", id: options.actorId }, kind: options.kind ?? "input", sources: options.sources,
		};
		let receipt: InputReceipt;
		if (!s.isBusy()) {
			receipt = { inputId: queued.id, taken: "now" };
			this.startTurn(s, queued);
		} else if (queued.when === "steer" && this.runtime()?.supports.inputDuringTurn === true) {
			s.steering.push(queued);
			receipt = { inputId: queued.id, taken: "inTurn" };
		} else {
			s.followUps.push(queued);
			receipt = { inputId: queued.id, taken: "after" };
		}
		if (options.key) s.keys.set(options.key, receipt);
		this.emit(s.id, "input.accepted", { inputId: queued.id, taken: receipt.taken }, "harness", { actorId: options.actorId });
		return receipt;
	}

	private withdraw(sessionId: string, inputId: string): QueuedInput | undefined {
		const s = this.session(sessionId);
		for (const queue of [s.steering, s.followUps]) {
			const i = queue.findIndex((q) => q.id === inputId);
			if (i >= 0) {
				const [q] = queue.splice(i, 1);
				this.emit(s.id, "input.withdrawn", { inputId, content: q.content }, "harness");
				return q;
			}
		}
		return undefined;
	}

	/** Cancel the running turn. Its jobs keep running. Queued input is handed back. */
	private async cancel(sessionId: string): Promise<QueuedInput[]> {
		const s = this.session(sessionId);
		const handedBack = [...s.steering, ...s.followUps];
		s.steering = [];
		s.followUps = [];
		for (const q of handedBack) this.emit(s.id, "input.withdrawn", { inputId: q.id, content: q.content, reason: "cancelled" }, "harness");
		const running = s.running;
		if (running) {
			running.abort.abort();
			for (const r of [...s.requests.values()]) r.resolve({ requestId: r.request.id, declined: true, actorId: "harness", reason: "cancelled" });
			await running.done;
		}
		return handedBack;
	}

	private async waitForIdle(sessionId: string): Promise<void> {
		const s = this.session(sessionId);
		while (s.running || s.settling) {
			if (s.settling) await s.settling;
			if (s.running) await s.running.done;
		}
	}

	private runtime(): Runtime | undefined {
		return this.use<Runtime>("runtime");
	}

	private startTurn(s: Session, queued: QueuedInput): void {
		void this.launch(s, this.newId(), (signal, turnId) => this.runTurn(s, queued, turnId, signal));
	}

	/** Run a turn as the session's running turn, then start any queued input. */
	private launch(s: Session, turnId: string, body: (signal: AbortSignal, turnId: string) => Promise<void>): Promise<void> {
		const abort = new AbortController();
		const done = body(abort.signal, turnId)
			.catch((error) => this.problem("harness", "turn", error))
			.finally(() => {
				s.running = undefined;
				const next = [...s.steering, ...s.followUps];
				s.steering = [];
				s.followUps = next.slice(1);
				if (next[0] && !s.closed) this.startTurn(s, next[0]);
			});
		s.running = { turnId, abort, done };
		return done;
	}

	private async runTurn(s: Session, queued: QueuedInput, turnId: string, signal: AbortSignal): Promise<void> {
		const continuing = queued.continueCalls ? this.openCalls(s).filter((c) => queued.continueCalls!.includes(c.id)) : undefined;
		if (queued.continueCalls && !continuing?.length) return; // already settled
		const runtime = this.runtime();
		const model = this.modelAccess(s);
		const settings = this.turnSettings(s);
		const tools = this.toolDefinitions(s).filter((t) => !t.callers || t.callers.includes("model"));
		const resultShape = s.settings.resultShape as Record<string, unknown> | undefined;
		let contributions: { system?: string; context?: ContentPart[] }[] = [];
		let failure: string | undefined;
		try {
			contributions = await this.hooks.collect("turn.before", { sessionId: s.id, turnId, input: queued.content });
		} catch (error) { failure = String(error); }
		const snapshot: TurnSnapshot = {
			model: model ? { provider: model.model.provider, id: model.model.id } : null,
			system: contributions.map((c) => c.system).filter(Boolean).join("\n\n"), tools, settings,
		};
		const state: TurnState = { ...snapshot, sources: new Map(), actors: new Set([queued.actorId]) };
		const context = contributions.flatMap((c) => c.context ?? []);
		await this.commit(s, [
			{ kind: "turnStart", writer: "harness", modelVisible: false, turnId, actorId: queued.actorId, data: { ...snapshot, startedBy: queued.startedBy, resultShape } },
			...(continuing ? [] : [this.inputEntry(s, queued, turnId, context)]),
		]);
		this.emit(s.id, "turn.started", { startedBy: queued.startedBy }, "harness", { turnId });
		let outcome: TurnOutcome;
		if (failure) outcome = this.failedOutcome(failure);
		else if (!runtime) outcome = this.failedOutcome("No Runtime is loaded");
		else if (!model) outcome = this.failedOutcome("No model is selected, or its Provider is not loaded");
		else {
			try {
				const input = {
					sessionId: s.id, turnId, startedBy: queued.startedBy, model,
					settings, resultShape,
				};
				const host = this.runtimeHost(s, turnId, state);
				outcome = continuing ? await runtime.continueOpenCalls(input, host, signal, continuing) : await runtime.runTurn(input, host, signal);
			} catch (error) {
				outcome = this.failedOutcome(error instanceof Error ? error.message : String(error));
			}
		}
		await this.finishTurn(s, turnId, outcome, state);
	}

	private async finishTurn(s: Session, turnId: string, outcome: TurnOutcome, state?: TurnState): Promise<void> {
		// The process stopped: the turn is interrupted, not ended. Nothing is recorded or announced here;
		// reopening the session finds the turn and hands it to the Runtime.
		if (s.suspended) return;
		const open = new Set(outcome.result.openToolCalls);
		for (const request of this.recordedOpenRequests(s).filter((r) => r.turnId === turnId && !s.requests.has(r.id) && !open.has(r.toolCallId ?? ""))) {
			await this.commit(s, [{ kind: "inputAnswer", writer: "harness", modelVisible: false, turnId, toolCallId: request.toolCallId, data: { requestId: request.id, actorId: "harness", declined: true, reason: "no longer answerable" } }]);
			this.emit(s.id, "input.request.closed", { requestId: request.id, declined: true, lost: true }, "harness", { turnId, toolCallId: request.toolCallId });
		}
		const sources = s.branch().filter((e) => e.turnId === turnId && (e.kind === "response" || e.kind === "toolResult")).map((e) => e.id);
		await this.commit(s, [{ kind: "turnEnd", writer: "harness", modelVisible: false, turnId, sources, data: { outcome: outcome.outcome, result: outcome.result, usage: outcome.usage } }]);
		if (!state?.endedHook) await this.hooks.observe("turn.end", { sessionId: s.id, turnId, outcome });
		this.emit(s.id, "turn.ended", outcome, "harness", { turnId });
		if (open.size) this.maybeContinueOpenCalls(s);
	}

	private async resumeTurn(s: Session, interrupted: InterruptedTurn, startedBy: QueuedInput["startedBy"], signal: AbortSignal, snapshot?: Partial<TurnSnapshot> & { resultShape?: Record<string, unknown> }): Promise<void> {
		const turnId = interrupted.turnId;
		const runtime = this.runtime();
		const model = this.modelAccess(s, snapshot?.model);
		if (!runtime || !model) {
			await this.endInterruptedTurn(s, interrupted);
			await this.finishTurn(s, turnId, this.failedOutcome("The process stopped during the turn"));
			return;
		}
		const inTurn = s.branch().filter((e) => e.turnId === turnId);
		const state: TurnState = {
			model: model.model, system: snapshot?.system ?? "", tools: snapshot?.tools ?? this.toolDefinitions(s),
			settings: snapshot?.settings ?? this.turnSettings(s), sources: new Map(),
			actors: new Set(inTurn.filter((e) => (e.kind === "input" || e.kind === "turnStart") && e.actorId).map((e) => e.actorId!)),
		};
		let outcome: TurnOutcome;
		try {
			outcome = await runtime.resumeTurn(
				{ sessionId: s.id, turnId, startedBy, model, settings: state.settings, resultShape: snapshot?.resultShape },
				this.runtimeHost(s, turnId, state),
				signal,
				interrupted,
			);
		} catch (error) {
			outcome = this.failedOutcome(error instanceof Error ? error.message : String(error));
		}
		await this.finishTurn(s, turnId, outcome, state);
	}

	private turnSettings(s: Session): TurnSettings {
		return { maxSteps: s.settings.maxSteps as number | undefined, reasoning: s.settings.reasoning as string | undefined, maxOutput: s.settings.maxOutput as number | undefined };
	}

	private inputEntry(s: Session, q: QueuedInput, turnId: string, context: ContentPart[] = []): EntryDraft {
		const jobId = q.startedBy.kind === "job" ? q.startedBy.id : undefined;
		const sources = jobId ? s.branch().filter((e) => e.jobId === jobId && e.kind === "harness.jobEnded").map((e) => e.id) : undefined;
		return {
			kind: "input", writer: "harness", modelVisible: true, turnId, actorId: q.actorId, jobId, sources: [...(sources ?? []), ...(q.sources ?? [])],
			message: { role: "user", content: [...context, ...q.content] }, data: { inputId: q.id, key: q.key },
		};
	}

	private failedOutcome(error: string): TurnOutcome {
		return { outcome: { kind: "failed", error }, result: { openToolCalls: [] }, entries: [], usage: zeroUsage() };
	}

	private runtimeHost(s: Session, turnId: string, state: TurnState): RuntimeHost {
		const withAuthority = <T>(fn: () => T): T => this.turnAuthority.run({ sessionId: s.id, actors: state.actors }, fn);
		return {
			newId: async () => this.newId(),
			prepareStep: async ({ stepId, usage }) => {
				const model = this.modelAccess(s, state.model);
				const request: ModelRequest = {
					systemPrompt: state.system, messages: s.modelMessages(), tools: state.tools, providerTools: "none",
					settings: { reasoning: state.settings.reasoning, maxOutput: state.settings.maxOutput },
				};
				const payload = { sessionId: s.id, turnId, stepId, usage, model: model?.model, history: s.branch(), request };
				const prepared = (await withAuthority(() => this.hooks.transform("step.before", payload))).value.request;
				// Hooks may copy or transform messages, so conservatively name every visible source.
				state.sources.set(stepId, s.branch().filter((e) => e.modelVisible || e.kind === "summary").map((e) => e.id));
				return prepared;
			},
			hook: async (name, payload) => {
				if (name === "turn.end") {
					if (state.endedHook || s.suspended) return null as never;
					state.endedHook = true;
				}
				const run = () => withAuthority(() => this.hooks.run(name, { ...payload, sessionId: s.id, turnId }));
				const result = name === "tool.before" && payload.call ? await this.toolWork.run(payload.call, run) : await run();
				if (name === "model.failed" && result?.retry) {
					const provider = this.providerFor(s, state.model);
					if (provider?.supports.keepsState === true) await provider.discardState?.(s.id);
				}
				return result;
			},
			runToolCall: (call, signal) => withAuthority(() => this.executeTool(s, call, signal, turnId, state)),
			definition: async (name) => this.findTool(s, name)?.definition,
			history: async () => s.branch(),
			record: async (draft) => {
				if (draft.kind === "turnStart" || draft.kind === "turnEnd") {
					return s.branch().find((e) => e.turnId === turnId && e.kind === draft.kind)
						?? { ...draft, id: turnId, turnId, sessionId: s.id, time: this.now(), parentId: s.position };
				}
				const modelSources = draft.kind === "response" ? [
					...(state.sources.get(draft.stepId ?? "") ?? []),
					...s.branch().filter((e) => e.modelVisible || e.kind === "summary").map((e) => e.id),
				] : [];
				const callSources = draft.kind === "toolResult" && draft.toolCallId ? s.branch()
					.filter((e) => e.kind === "toolStarted" && e.toolCallId === draft.toolCallId
						|| e.message?.role === "assistant" && e.message.content.some((p) => isToolCall(p) && p.id === draft.toolCallId))
					.map((e) => e.id) : [];
				const sources = [...new Set([...(draft.sources ?? []), ...modelSources, ...callSources])];
				return (await this.commit(s, [{ ...draft, turnId, sources }]))[0];
			},
			takeSteering: async () => {
				const items = s.steering.splice(0);
				if (!items.length) return [];
				for (const q of items) state.actors.add(q.actorId);
				return this.commit(s, items.map((q) => this.inputEntry(s, q, turnId)));
			},
			hasSteering: async () => s.steering.length > 0,
			report: (type, data, ids) => this.emit(s.id, type, data, "runtime", { turnId, ...ids }),
		};
	}

	// ---------- models ----------

	private providerFor(s: Session, ref = parseModel(s.settings.model) as ReturnType<typeof parseModel> | null): Provider | undefined {
		if (!ref) return undefined;
		return this.useAll<Provider>("provider").find((p) => p.id === ref.provider);
	}

	private modelAccess(s: Session, ref = parseModel(s.settings.model) as ReturnType<typeof parseModel> | null): ModelAccess | undefined {
		const provider = this.providerFor(s, ref);
		if (!ref || !provider) return undefined;
		const info: ModelInfo | undefined = provider.models().find((m) => m.id === ref.id);
		if (!info) return undefined;
		return {
			model: info,
			supports: provider.supports,
			request: (request, options) => provider.request(ref, request, { ...options, sessionId: s.id }),
		};
	}

	projectOf(s: Session): string {
		return typeof s.settings.cwd === "string" ? s.settings.cwd : this.project;
	}

	/** The working environment, in the session's project when it has its own. */
	private async environmentFor(s: Session): Promise<WorkingEnvironment | undefined> {
		const base = this.use<WorkingEnvironment>("working-environment");
		const env = await base?.forSession?.(s.id) ?? base;
		const cwd = this.projectOf(s);
		return env && env.cwd !== cwd && env.at ? env.at(cwd) : env;
	}

	// ---------- tools ----------

	private findTool(s: Session | undefined, name: string): { source: ToolSource; definition: ToolDefinition } | undefined {
		for (const { plugin, impl } of this.caps.get("tool-source") ?? []) {
			const source = impl as ToolSource;
			const definition = source.tools(s?.id).find((t) => t.name === name && !this.replacedFor(plugin, `tool:${t.name}`));
			if (definition) return { source, definition };
		}
		return undefined;
	}

	private toolDefinitions(s?: Session): ToolDefinition[] {
		const seen = new Set<string>();
		const out: ToolDefinition[] = [];
		for (const { plugin, impl } of this.caps.get("tool-source") ?? []) {
			const source = impl as ToolSource;
			for (const t of source.tools(s?.id)) {
				if (this.replacedFor(plugin, `tool:${t.name}`)) continue;
				if (seen.has(t.name)) {
					// A name is never silently shadowed: the later source's tool is refused, and said so once.
					const key = `${source.id}:${t.name}`;
					if (!this.refusedTools.has(key)) {
						this.refusedTools.add(key);
						this.problem(source.id, "tools", new Error(`Tool ${t.name} is already offered by another tool source; this one is refused`));
					}
					continue;
				}
				seen.add(t.name);
				out.push(t);
			}
		}
		const allowed = s?.settings.tools as string[] | undefined;
		return allowed ? out.filter((t) => allowed.includes(t.name)) : out;
	}

	/** Run one tool call. Hook points are applied by whoever owns the operation. */
	private async executeTool(s: Session, call: ToolCall, signal: AbortSignal, turnId?: string, state?: TurnState): Promise<ToolResult | (ToolPending & { callId: string })> {
		const found = this.findTool(s, call.name);
		if (s.erasing) return { callId: call.id, status: "refused", content: [text("Erasure is in progress")] };
		if (!found) return { callId: call.id, status: "failed", content: [text(`Unknown tool: ${call.name}`)] };
		const missing = requiredMissing(found.definition.parameters, call.input);
		if (missing.length) return { callId: call.id, status: "failed", content: [text(`Missing required input: ${missing.join(", ")}`)] };
		if (signal.aborted) return { callId: call.id, status: "notStarted", content: [text("Cancelled before it ran")] };
		if (state && state.actors.size > 1 && [...state.actors].some((id) => !s.actors.get(id)?.authority.includes("input"))) return { callId: call.id, status: "refused", content: [text("The contributing actors no longer share input rights")] };
		if (state && !state.tools.some((t) => t.name === call.name)) return { callId: call.id, status: "refused", content: [text("Tool was not offered to this turn")] };
		// The "tools" right: every actor the work belongs to must let tools run for it (docs/bindings/data.md#actors).
		const owners = state ? [...state.actors] : call.actorId ? [call.actorId] : [];
		const lacking = owners.filter((id) => s.actors.has(id) && !s.actors.get(id)!.authority.includes("tools"));
		if (lacking.length) return { callId: call.id, status: "refused", content: [text(`No "tools" right: ${lacking.join(", ")}`)] };
		const env = await this.environmentFor(s);
		const safeToRepeat = found.definition.hints?.safeToRepeat === true && env?.safeToRepeat === true;
		await this.commit(s, [{ kind: "toolStarted", writer: "harness", modelVisible: false, turnId, toolCallId: call.id, stepId: call.stepId, data: { call, safeToRepeat } }]);
		this.emit(s.id, "tool.started", { call }, found.source.id, { turnId, toolCallId: call.id, stepId: call.stepId });
		let asked = 0;
		try {
			const result = await this.toolWork.run(call, () => found.source.run(call, {
				sessionId: s.id,
				signal,
				call,
				progress: (content) => this.emit(s.id, "tool.progress", { content }, found.source.id, { turnId, toolCallId: call.id }),
				environment: env,
				ask: (request, askingSignal) => this.ask(s, { ...request, toolCallId: call.id, key: `${call.id}:${request.key ?? `ask:${asked++}`}` }, found.source.id, askingSignal ? AbortSignal.any([signal, askingSignal]) : signal),
			}));
			if (isPending(result)) {
				this.emit(s.id, "tool.ended", { status: "open", reason: result.pending }, found.source.id, { turnId, toolCallId: call.id });
				return { callId: call.id, pending: result.pending };
			}
			const out: ToolResult = { ...result, callId: call.id };
			this.emit(s.id, "tool.ended", { status: out.status }, found.source.id, { turnId, toolCallId: call.id });
			return out;
		} catch (error) {
			const status = signal.aborted ? "cancelled" : "failed";
			const message = error instanceof Error ? error.message : String(error);
			this.emit(s.id, "tool.ended", { status }, found.source.id, { turnId, toolCallId: call.id });
			return { callId: call.id, status, content: [text(status === "cancelled" ? "Cancelled" : `Tool failed: ${message}`)] };
		}
	}

	/** A tool call a UI or plugin starts. The same checks apply. */
	private async callTool(s: Session, call: ToolCall): Promise<ToolResult> {
		const definition = this.findTool(s, call.name)?.definition;
		const gate = definition?.callers && call.startedBy !== "tool" && !definition.callers.includes(call.startedBy as "ui" | "plugin")
			? { refused: `${call.name} can't be called by a ${call.startedBy}`, value: { call } }
			: await this.toolWork.run(call, () => this.hooks.gate("tool.before", { sessionId: s.id, call, definition }));
		let result: ToolResult;
		if (gate.refused) result = { callId: call.id, status: "refused", content: [text(gate.refused)] };
		else {
			const ran = await this.executeTool(s, gate.value.call, new AbortController().signal);
			// Only a turn can carry an open call forward, so outside a turn it fails instead.
			result = isPending(ran) ? { callId: call.id, status: "failed", content: [text(`${call.name} can't wait for an answer outside a turn`)] } : ran;
		}
		result = (await this.hooks.transform("tool.after", { sessionId: s.id, call, result })).value.result;
		await this.commit(s, [{ kind: "toolResult", writer: "harness", modelVisible: false, toolCallId: call.id, actorId: call.actorId, message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content, isError: result.status !== "completed" }, data: { status: result.status, value: result.value, call } }]);
		return result;
	}

	// ---------- asking actors ----------

	private interfaces(): InterfaceCapability[] {
		return this.useAll<InterfaceCapability>("interface");
	}

	private mayAnswer(s: Session, request: InputRequest, actorId: string): boolean {
		const actor = s.actors.get(actorId);
		if (!actor) return false;
		if (request.answerers.length) return request.answerers.includes(actorId);
		return actor.authority.includes(request.kind === "approval" ? "approve" : "answer");
	}

	/** Questions recorded on the current branch that have no answer and were not closed. */
	private recordedOpenRequests(s: Session): InputRequest[] {
		const branch = s.branch();
		const settled = new Set(branch.filter((e) => !e.erased && (e.kind === "inputAnswer" || e.kind === "inputClosed")).map((e) => (e.data as { requestId: string }).requestId));
		return branch.filter((e) => e.kind === "inputRequest" && !e.erased).map(readRequest).filter((r) => !settled.has(r.id));
	}

	/** A recorded answer to the question with this key, if it can still be used. */
	private recordedAnswer(s: Session, draft: BoundRequest): { request: InputRequest; answer?: Answer } | undefined {
		const branch = s.branch();
		const entry = [...branch].reverse().find((e) => e.kind === "inputRequest" && !e.erased && readRequest(e).key === draft.key);
		if (!entry) return undefined;
		const request = readRequest(entry);
		if (request.kind !== draft.kind || request.question !== draft.question || request.details !== draft.details
			|| JSON.stringify(request.options ?? []) !== JSON.stringify(draft.options ?? [])
			|| (request.credential ?? undefined) !== (draft.credential ?? undefined) || request.toolCallId !== draft.toolCallId) return undefined;
		const bound = (request as BoundRequest).boundCall;
		if (bound && !isDeepStrictEqual(bound, draft.boundCall)) return undefined;
		if (branch.some((e) => e.kind === "inputClosed" && (e.data as { requestId: string }).requestId === request.id)) return undefined;
		const answered = branch.find((e) => e.kind === "inputAnswer" && !e.erased && (e.data as { requestId: string }).requestId === request.id);
		if (!answered) return { request };
		const body = answered.data as Answer & { answer?: Answer };
		const answer = body.answer ?? body;
		// A secret's recorded answer holds only where it was stored, so it can be reused like any other.
		// A recorded allow counts only if whoever gave it may still answer.
		if (!answer.declined && !this.mayAnswer(s, request, answer.actorId)) return undefined;
		return { request, answer };
	}

	/** A secret's answer goes to the credential store. What the asker and the record get is only where it went. */
	private async keepSecret(request: InputRequest, answer: Answer): Promise<Answer> {
		if (request.kind !== "secret" || answer.declined || answer.pending) return answer;
		const { value, ...rest } = answer;
		try {
			const store = this.use<CredentialStore>("credential-store");
			if (!store || !request.credential) throw new Error("there is nowhere to keep a secret");
			await store.modify(request.credential, async () => ({ type: "api_key", key: value ?? "" }));
			return { ...rest, stored: request.credential };
		} catch (error) {
			return { ...rest, declined: true, reason: `The secret was not kept: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	private async ask(s: Session, draft: BoundRequest, askedBy: string, signal?: AbortSignal): Promise<Answer> {
		signal?.throwIfAborted();
		const call = this.toolWork.getStore();
		if (call && call.id === draft.toolCallId) draft = { ...draft, boundCall: { name: call.name, input: call.input } };
		if (draft.kind === "secret" && (!draft.credential || !this.use<CredentialStore>("credential-store"))) {
			return { requestId: "", declined: true, actorId: "harness", reason: "A secret needs a credential name and a credential store to keep it" };
		}
		let request: InputRequest = { ...draft, id: this.newId(), sessionId: s.id, askedBy, answerers: draft.answerers ?? [], turnId: s.running?.turnId };
		let reopened = false;
		if (draft.key) {
			const recorded = this.recordedAnswer(s, draft);
			if (recorded?.answer) {
				this.emit(s.id, "input.request.reused", { requestId: recorded.request.id, key: draft.key }, "harness", { toolCallId: request.toolCallId });
				return recorded.answer;
			}
			if (recorded) {
				request = { ...recorded.request, turnId: s.running?.turnId ?? recorded.request.turnId };
				reopened = true;
			}
		}
		const viewers = this.viewersFor(s, request);
		if (!viewers.some((i) => this.mayAnswer(s, request, i.actorId))) {
			return { requestId: request.id, declined: true, actorId: "harness", reason: "No one present can answer" };
		}
		if (!reopened) {
			await this.commit(s, [{ kind: "inputRequest", writer: askedBy, modelVisible: false, turnId: request.turnId, toolCallId: request.toolCallId, data: { request: { ...request, answerable: true } } }]);
		}
		return new Promise<Answer>((resolve) => {
			const cancel = () => open.resolve({ requestId: request.id, declined: true, actorId: "harness", reason: "cancelled" });
			const open = {
				request,
				resolve: (answer: Answer) => {
					signal?.removeEventListener("abort", cancel);
					if (open.timer) clearTimeout(open.timer);
					s.requests.delete(request.id);
					for (const i of viewers) i.onInputRequestClosed?.(request.id);
					void this.keepSecret(request, answer).then((kept) =>
						this.commit(s, [{ kind: "inputAnswer", writer: "harness", modelVisible: false, turnId: request.turnId, toolCallId: request.toolCallId, actorId: kept.actorId, data: kept }])
							.catch((error) => this.problem("harness", "record answer", error))
							.finally(() => {
								this.emit(s.id, "input.request.closed", { requestId: request.id, declined: kept.declined ?? false, value: kept.value }, "harness", { actorId: kept.actorId, toolCallId: request.toolCallId });
								resolve(kept);
							}),
					);
				},
				timer: undefined as NodeJS.Timeout | undefined,
			};
			if (request.timeLimitMs) {
				open.timer = setTimeout(() => {
					if (request.whenTimeLimit !== "leaveOpen") return open.resolve({ requestId: request.id, declined: true, actorId: "harness", reason: "time limit" });
					// Leave the question open past its turn. Interfaces keep showing it.
					signal?.removeEventListener("abort", cancel);
					s.requests.delete(request.id);
					s.waiting.add(request.id);
					this.emit(s.id, "input.request.waiting", { requestId: request.id }, "harness", { toolCallId: request.toolCallId });
					resolve({ requestId: request.id, actorId: "harness", pending: true });
				}, request.timeLimitMs);
			}
			s.requests.set(request.id, open);
			if (signal?.aborted) return cancel();
			signal?.addEventListener("abort", cancel, { once: true });
			this.emit(s.id, "input.request.opened", { request, reopened }, askedBy, { toolCallId: request.toolCallId });
			for (const i of viewers) i.onInputRequest?.(request);
		});
	}

	private viewersFor(s: Session, request: InputRequest): InterfaceCapability[] {
		return this.interfaces().filter((i) => s.actors.get(i.actorId)?.authority.includes("watch") || this.mayAnswer(s, request, i.actorId));
	}

	/** Questions on the current branch that were left open past their turn and have no answer yet. */
	private waitingRequests(s: Session): InputRequest[] {
		const calls = new Set(this.openCalls(s).map((c) => c.id));
		return this.recordedOpenRequests(s).filter((r) => (s.waiting.has(r.id) || calls.has(r.toolCallId ?? "") || r.turnId !== s.running?.turnId)
			&& !s.requests.has(r.id) && !s.lateAnswers.has(r.id));
	}

	/** Answer a question left open past its turn. The answer is recorded, then the open calls carry on if they can. */
	private answerLate(s: Session, answer: Answer): { accepted: boolean; reason?: string } {
		const request = this.waitingRequests(s).find((r) => r.id === answer.requestId);
		if (!request) return { accepted: false, reason: "The request is closed or can no longer be answered" };
		if (!this.mayAnswer(s, request, answer.actorId)) return { accepted: false, reason: `${answer.actorId} may not answer this request` };
		s.lateAnswers.add(request.id);
		const previous = s.settling ?? Promise.resolve();
		const work = previous.then(async () => {
			const kept = await this.keepSecret(request, answer);
			await this.commit(s, [{ kind: "inputAnswer", writer: "harness", modelVisible: false, toolCallId: request.toolCallId, actorId: answer.actorId, data: kept }]);
			s.lateAnswers.delete(request.id);
			for (const i of this.viewersFor(s, request)) i.onInputRequestClosed?.(request.id);
			this.emit(s.id, "input.request.closed", { requestId: request.id, declined: answer.declined ?? false, late: true }, "harness", { actorId: answer.actorId, toolCallId: request.toolCallId });
			s.waiting.delete(request.id);
			this.continueOpenCalls(s, answer);
		});
		s.settling = work.catch((error) => this.problem("harness", "late answer", error)).finally(() => {
			if (s.settling === tracked) s.settling = undefined;
		});
		const tracked = s.settling;
		return { accepted: true };
	}

	/** Tool calls on the current branch that have no result and are not part of a running turn. */
	private openCalls(s: Session): InterruptedTurn["calls"] {
		const branch = s.branch();
		const results = new Set(branch.filter((e) => e.kind === "toolResult").map((e) => e.toolCallId));
		const open = new Set(branch.flatMap((e) => e.kind === "turnEnd" && !e.erased ? (e.data as { result?: TurnOutcome["result"] }).result?.openToolCalls ?? [] : []));
		const calls: InterruptedTurn["calls"] = [];
		for (const e of branch) {
			if (e.message?.role !== "assistant") continue;
			for (const part of e.message.content.filter(isToolCall)) {
				if (open.has(part.id) && !results.has(part.id)) calls.push({ id: part.id, name: part.name, input: part.arguments ?? {}, stepId: e.stepId, started: false, safeToRepeat: false });
			}
		}
		return calls;
	}

	/** When every open call has its answer, start a turn that carries on from them. */
	private maybeContinueOpenCalls(s: Session): void {
		const calls = this.openCalls(s);
		if (!calls.length) return;
		const branch = s.branch();
		const answers = branch.filter((e) => e.kind === "inputAnswer" && !e.erased);
		if (!calls.every((c) => answers.some((e) => e.toolCallId === c.id))) return;
		this.continueOpenCalls(s, answers.at(-1)!.data as Answer);
	}

	private continueOpenCalls(s: Session, answer: Answer): void {
		const calls = this.openCalls(s);
		if (!calls.length) return;
		const stillWaiting = new Set(this.waitingRequests(s).map((r) => r.toolCallId));
		if (calls.some((c) => stillWaiting.has(c.id))) return;
		const queued: QueuedInput = { id: this.newId(), content: [], actorId: answer.actorId, when: "after", startedBy: { kind: "answer", id: answer.requestId }, kind: "continue", continueCalls: calls.map((c) => c.id) };
		if (s.isBusy()) {
			if (!s.followUps.some((q) => q.continueCalls)) s.followUps.push(queued);
		} else this.startTurn(s, queued);
	}

	private answer(s: Session, answer: Answer): { accepted: boolean; reason?: string } {
		const open = s.requests.get(answer.requestId);
		if (!open) return this.answerLate(s, answer);
		if (!this.mayAnswer(s, open.request, answer.actorId)) return { accepted: false, reason: `${answer.actorId} may not answer this request` };
		open.resolve(answer); // the first accepted answer closes the request
		return { accepted: true };
	}

	// ---------- jobs ----------

	private startJob(s: Session, options: { kind: string; actorId?: string; detail?: unknown }, plugin: string): JobHandle {
		const startEntryId = this.newId();
		const job: Job = { id: this.newId(), kind: options.kind, sessionId: s.id, plugin, actorId: options.actorId, turnId: s.running?.turnId, state: "running", usage: zeroUsage() };
		void this.commit(s, [{ id: startEntryId, kind: "harness.jobStarted", writer: plugin, modelVisible: false, turnId: job.turnId, toolCallId: this.toolWork.getStore()?.id, jobId: job.id, actorId: job.actorId, data: { job, detail: options.detail } }]).catch((e) => this.problem(plugin, "record job", e));
		this.emit(s.id, "job.started", { job }, plugin, { jobId: job.id });
		return this.jobHandle(s, job, plugin, startEntryId);
	}

	private unfinishedJobs(s: Session): { job: Job; detail?: unknown }[] {
		const all = s.order.map((id) => s.entries.get(id)!);
		const ended = new Set(all.filter((e) => e.kind === "harness.jobEnded").map((e) => e.jobId));
		return all.filter((e) => e.kind === "harness.jobStarted" && !e.erased && !ended.has(e.jobId) && !s.jobs.has(e.jobId!)).map((e) => e.data as { job: Job; detail?: unknown });
	}

	private jobHandle(s: Session, job: Job, plugin: string, startEntryId?: string): JobHandle {
		const record: { job: Job; cancel?: () => void | Promise<void> } = { job };
		s.jobs.set(job.id, record);
		return {
			id: job.id,
			startEntryId,
			progress: (content) => this.emit(s.id, "job.progress", { content: typeof content === "string" ? [text(content)] : content }, plugin, { jobId: job.id }),
			finish: async (state, result, options) => {
				if (job.state !== "running") return;
				job.state = state;
				job.result = typeof result === "string" ? [text(result)] : result;
				// The job stays listed until its report is queued, so nobody sees the session as finished in between.
				try {
					if (s.closed) return;
					await this.commit(s, [{ kind: "harness.jobEnded", writer: plugin, modelVisible: false, jobId: job.id, sources: options?.sources, data: { state, result: job.result } }]);
					this.emit(s.id, "job.ended", { state, result: job.result }, plugin, { jobId: job.id });
					if (options?.report === false || s.closed) return;
					const report: ContentPart[] = [text(`[Job ${job.kind} ${job.id.slice(0, 8)} ${state}]\n`), ...(job.result ?? [])];
					// Keyed by the job, so a report is taken once even if delivery is retried.
					await this.input(s.id, { content: report, when: "after", key: `job-report:${job.id}`, actorId: job.actorId ?? "harness", kind: "jobReport", startedBy: { kind: "job", id: job.id } });
				} finally {
					s.jobs.delete(job.id);
				}
			},
			onCancel: (fn) => {
				record.cancel = fn;
			},
		};
	}

	private async cancelJob(s: Session, jobId: string): Promise<void> {
		const record = s.jobs.get(jobId);
		if (!record) return;
		record.job.state = "cancelled";
		s.jobs.delete(jobId);
		await record.cancel?.();
		if (!s.closed && !s.suspended) await this.commit(s, [{ kind: "harness.jobEnded", writer: record.job.plugin, modelVisible: false, jobId, data: { state: "cancelled" } }]);
		this.emit(s.id, "job.ended", { state: "cancelled" }, record.job.plugin, { jobId });
	}

	// ---------- declarations ----------

	declaration(s?: Session): Declaration {
		const runtime = this.runtime();
		const store = this.use<HistoryStore>("history-store");
		const provider = s ? this.providerFor(s) : undefined;
		return {
			inputDuringTurn: runtime?.supports.inputDuringTurn === true,
			waitingThroughRestart: runtime?.supports.waitingThroughRestart === true && !!store && !s?.ephemeral,
			continuesAfterRestart: runtime?.supports.continuesAfterRestart === true,
			rewinding: false,
			forking: !!store,
			keepsStateAtProvider: provider?.supports.keepsState === true,
			runsToolsAtProvider: provider?.supports.runsTools === true,
			liveSessions: provider?.supports.liveSessions === true,
			severalActors: true,
			holdsOutput: true,
			outputBypassesAgent: false,
			startsTurnsUnasked: "when a job reports back",
			cancellingTurnCancelsJobs: false,
			pluginsDuringSession: false,
			erasure: s?.ephemeral ? true : !!store?.erase,
			inputKeys: true,
			portableSessions: true,
			mixedActorInput: "shared",
			erasureDuringTurn: "refused",
			questionsOutlastTurns: true,
		};
	}
}

/** One recipient following a session, through the output gate. */
class Follower {
	private held: AgentEvent[] = [];
	private chain: Promise<void> = Promise.resolve();
	constructor(
		private hooks: HookRegistry,
		private recipient: string,
		private raw: boolean,
		private listener: (event: AgentEvent) => void,
		private onError: (e: unknown) => void,
	) {}

	push(event: AgentEvent): void {
		this.chain = this.chain.then(() => this.deliver(event)).catch(this.onError);
	}

	/** Resolves once everything pushed so far has been delivered or blocked. */
	idle(): Promise<void> {
		return this.chain;
	}

	private async deliver(event: AgentEvent): Promise<void> {
		const handlers = this.raw ? [] : this.hooks.raw("output");
		let events = [...this.held, event];
		const final = event.type !== "model.output";
		for (const h of handlers) {
			const payload: OutputPayload = { events, recipient: this.recipient, final };
			const answer = (await h.handler(payload)) as OutputAnswer;
			if (!answer) continue;
			if (answer.action === "block") {
				this.held = [];
				return;
			}
			if (answer.action === "hold") {
				if (final) {
					this.held = []; // what can't be decided at the end is blocked: fail closed
					return;
				}
				this.held = events;
				return;
			}
			if (answer.events) events = answer.events;
		}
		this.held = [];
		for (const e of events) this.listener(e);
	}
}


export function parseModel(value: unknown): { provider: string; id: string } | undefined {
	if (typeof value === "string" && value.includes("/")) {
		const i = value.indexOf("/");
		return { provider: value.slice(0, i), id: value.slice(i + 1) };
	}
	if (value && typeof value === "object" && "provider" in value && "id" in value) return value as { provider: string; id: string };
	return undefined;
}

const STANDARD_ENTRY_KINDS = new Set("actorJoined actorLeft setting input turnStart response toolStarted toolResult inputRequest inputAnswer turnEnd summary position erasure".split(" "));

/** Walk copy links to a fixed point, without following parentId (which is just position). */
function eraseCopies(origin: Session, ids: string[], sessions: Map<string, Session>): Map<Session, Set<string>> {
	const targets = new Map<Session, Set<string>>();
	const authority = (kind: string) => ["actorJoined", "actorLeft", "grant", "authority.grant", "authority.revoke"].includes(kind);
	const add = (session: Session, id: string) => {
		const e = session.entries.get(id);
		if (!e || targets.get(session)?.has(id)) return false;
		if (authority(e.kind)) throw new Error("Records of authority cannot be erased");
		if (!targets.has(session)) targets.set(session, new Set());
		targets.get(session)!.add(id);
		return true;
	};
	for (const id of ids) add(origin, id);
	const all = [...sessions.values()];
	const copied = (id: string) => all.some((s) => targets.get(s)?.has(id));
	for (let grew = true; grew;) {
		grew = false;
		for (const session of all) {
			const targetsHere = targets.get(session);
			const entries = [...session.entries.values()];
			const erased = entries.filter((e) => targetsHere?.has(e.id));
			const calls = new Set(erased.flatMap((e) => [
				...(e.kind !== "toolResult" && e.toolCallId ? [e.toolCallId] : []),
				...(e.message?.role === "assistant" ? e.message.content.filter(isToolCall).map((c) => c.id) : []),
			]));
			for (const e of entries) {
				if (e.erased || targetsHere?.has(e.id) || authority(e.kind)) continue;
				const fork = session.meta.forkedFrom && targets.get(sessions.get(session.meta.forkedFrom.sessionId)!)?.has(e.id);
				const links = e.sources?.some(copied);
				const callCopy = e.toolCallId && calls.has(e.toolCallId);
				const turnResult = e.kind === "turnEnd" && erased.some((x) => x.turnId === e.turnId && ["response", "toolResult"].includes(x.kind));
				// A completed turn with an erased outcome must not look like an interrupted turn on reopen.
				const endedTurnStart = e.kind === "turnStart" && erased.some((x) => x.kind === "turnEnd" && x.turnId === e.turnId);
				const jobId = e.jobId ?? (e.data as { value?: { jobId?: string } } | undefined)?.value?.jobId;
				const jobCopy = jobId && erased.some((x) => x.jobId === jobId && (x.kind === "harness.jobStarted" || x.kind === "harness.jobEnded"));
				const startedByCall = e.kind === "harness.jobStarted" && !e.toolCallId && erased.some((x) => x.turnId === e.turnId && x.kind === "toolStarted");
				// Older or foreign responses need not give sources. Earlier branch entries may all have been in the request.
				let ancestry = false;
				if (e.kind === "response" && !e.sources && erased.length) {
					const seen = new Set<string>();
					for (let id = e.parentId; id && !seen.has(id); id = session.entries.get(id)?.parentId ?? null) {
						if (targetsHere?.has(id)) { ancestry = true; break; }
						seen.add(id);
					}
				}
				const inputId = (e.data as { inputId?: string } | undefined)?.inputId;
				const takingInput = inputId && erased.some((x) => (x.data as { inputId?: string } | undefined)?.inputId === inputId);
				if (fork || links || callCopy || turnResult || endedTurnStart || jobCopy || startedByCall || ancestry || takingInput) grew = add(session, e.id) || grew;
			}
		}
	}
	return targets;
}

type BoundRequest = InputRequestDraft & { boundCall?: Pick<ToolCall, "name" | "input"> };

function readRequest(entry: HistoryEntry): InputRequest {
	const request = (entry.data as { request: InputRequest }).request;
	return { ...request, sessionId: entry.sessionId, answerers: request.answerers ?? [], toolCallId: entry.toolCallId ?? request.toolCallId ?? undefined, turnId: entry.turnId ?? request.turnId ?? undefined };
}

function actorJoined(actor: Actor, writer: string, actorId?: string): EntryDraft {
	const { authority, ...details } = actor;
	return { kind: "actorJoined", writer, actorId, modelVisible: false, data: { actor: { ...details, rights: authority } } };
}

export function normalizeSetting({ key, value }: { key: string; value: unknown }): { key: string; value: unknown } {
	if (key === "thinking") return { key: "reasoning", value };
	if (key === "model") return { key, value: parseModel(value) ?? null };
	if (key === "settings" && value && typeof value === "object") {
		return { key, value: Object.fromEntries(Object.entries(value).map(([key, value]) => {
			const setting = normalizeSetting({ key, value });
			return [setting.key, setting.value];
		})) };
	}
	return { key, value: value ?? null };
}

function requiredMissing(schema: Record<string, unknown>, input: Record<string, unknown>): string[] {
	const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
	return required.filter((k) => input?.[k] === undefined);
}

export type { GateResult };
