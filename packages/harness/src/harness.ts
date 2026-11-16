import { randomUUID } from "node:crypto";
import { HookRegistry } from "./hooks.js";
import { type InputReceipt, type InputTiming, type QueuedInput, Session } from "./session.js";
import {
	type Actor,
	type AgentEvent,
	type Answer,
	type Authority,
	type Configuration,
	type ContentPart,
	type Declaration,
	type EntryDraft,
	type GateResult,
	type HandlerOrder,
	type HistoryEntry,
	type HistoryStore,
	type HookRule,
	type InputRequest,
	type InputRequestDraft,
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
	type ToolResult,
	type ToolSource,
	type TurnOutcome,
	type WorkingEnvironment,
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
	setup(api: PluginApi): void | Promise<void>;
	stop?(): void | Promise<void>;
}

export interface CommandContext { sessionId: string; actorId: string; api: PluginApi }
export interface Command { description: string; run(args: string, context: CommandContext): Promise<string | void> | string | void }

export interface SessionStartOptions { settings?: Record<string, unknown>; actor?: Actor; forkFrom?: { sessionId: string; entryId: string }; parentSessionId?: string }
export interface InputOptions { content: ContentPart[] | string; when?: InputTiming; key?: string; actorId: string; kind?: string; startedBy?: QueuedInput["startedBy"] }
export interface JobHandle {
	id: string;
	progress(content: ContentPart[] | string): void;
	/** Finish the job. Its result enters the session as input and may start a turn. */
	finish(state: Exclude<JobState, "running">, result?: ContentPart[] | string): Promise<void>;
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
	// capabilities
	provide(capability: string, implementation: unknown): void;
	use<T>(capability: string): T | undefined;
	useAll<T>(capability: string): T[];
	// hook points
	defineHook(name: string, rule: HookRule): void;
	on(hook: string, handler: (payload: any) => unknown, order?: HandlerOrder): () => void;
	/** Run a hook point this plugin owns, by its rule. */
	runHook<T = any>(hook: string, payload: any): Promise<T>;
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
	listSessions(): Promise<StoredSession[]>;
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
	append(sessionId: string, draft: EntryDraft): Promise<HistoryEntry>;
	transaction(sessionId: string, fn: (tx: Transaction) => void | Promise<void>): Promise<void>;
	erase(sessionId: string, entryIds: string[], actorId: string): Promise<void>;
	// tools
	tools(sessionId?: string): ToolDefinition[];
	callTool(sessionId: string, call: Omit<ToolCall, "id"> & { id?: string }): Promise<ToolResult>;
	// actors
	ask(sessionId: string, request: InputRequestDraft): Promise<Answer>;
	answer(sessionId: string, answer: Answer): { accepted: boolean; reason?: string };
	openRequests(sessionId: string): InputRequest[];
	// jobs
	startJob(sessionId: string, options: { kind: string; actorId?: string }): JobHandle;
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

export const ALL_AUTHORITY: Authority[] = ["watch", "propose", "input", "answer", "approve", "settings", "erase"];

interface TurnState { systemPrompt: string }

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

	async stop(): Promise<void> {
		for (const id of [...this.sessions.keys()]) await this.closeSession(id).catch(() => undefined);
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
			provide: (capability, impl) => this.provide(pluginName, capability, impl),
			use: <T>(capability: string) => this.use<T>(capability),
			useAll: <T>(capability: string) => this.useAll<T>(capability),
			defineHook: (name, rule) => this.hooks.define(name, rule, pluginName),
			on: (hook, handler, order) => this.hooks.on(hook, pluginName, handler, order),
			runHook: (hook, payload) => this.hooks.run(hook, payload),
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
				if (this.commandTable.has(name)) this.problem(pluginName, "registerCommand", new Error(`Command /${name} is already registered`));
				else this.commandTable.set(name, { ...command, plugin: pluginName });
			},
			commands: () => [...this.commandTable].map(([name, c]) => ({ name, description: c.description, plugin: c.plugin })),
			runCommand: (sessionId, line, actorId) => this.runCommand(sessionId, line, actorId),
			startSession: (options) => this.startSession(options),
			openSession: (id, actor) => this.openSession(id, actor),
			listSessions: async () => (await this.use<HistoryStore>("history-store")?.list({ project: this.project })) ?? [],
			forkSession: (sessionId, entryId) => this.forkSession(sessionId, entryId),
			closeSession: (id) => this.closeSession(id),
			session: (id) => {
				const s = this.session(id);
				return { id: s.id, settings: { ...s.settings }, position: s.position, busy: s.isBusy(), actors: [...s.actors.values()], ephemeral: s.ephemeral };
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
			openRequests: (sessionId) => [...this.session(sessionId).requests.values()].map((r) => r.request),
			startJob: (sessionId, options) => this.startJob(this.session(sessionId), options, pluginName),
			jobs: (sessionId) => [...this.session(sessionId).jobs.values()].map((j) => ({ ...j.job })),
			cancelJob: (sessionId, jobId) => this.cancelJob(this.session(sessionId), jobId),
			follow: (sessionId, options, listener) => this.follow(this.session(sessionId), options, listener),
			declaration: (sessionId) => this.declaration(sessionId ? this.session(sessionId) : undefined),
			modelAccess: (sessionId) => this.modelAccess(this.session(sessionId)),
			config: () => self.use<Configuration>("configuration")?.plugin(pluginName) ?? {},
		};
	}

	// ---------- capabilities ----------

	private provide(plugin: string, capability: string, impl: unknown): void {
		const list = this.caps.get(capability) ?? [];
		list.push({ plugin, impl });
		this.caps.set(capability, list);
		this.emit("", "capability.provided", { capability, plugin }, "harness");
	}

	use<T>(capability: string): T | undefined {
		return this.caps.get(capability)?.[0]?.impl as T | undefined;
	}

	useAll<T>(capability: string): T[] {
		return (this.caps.get(capability) ?? []).map((c) => c.impl as T);
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
		const meta: StoredSession = { id: this.newId(), created: this.now(), project: this.project, forkedFrom: options.forkFrom, parentSessionId: options.parentSessionId };
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
		const drafts: EntryDraft[] = Object.entries(defaults).map(([key, value]) => ({ kind: "setting", writer: "harness", modelVisible: false, data: { key, value } }));
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
		const s = await this.loadInto(id);
		if (!s) throw new Error(`Session ${id} not found`);
		await store.openForWriting(id);
		this.sessions.set(id, s);
		const a = actor ?? this.defaultActor();
		s.actors.set(a.id, a);
		await this.repairInterruptedTurn(s);
		await this.hooks.observe("session.start", { sessionId: s.id, resumed: true });
		this.emit(s.id, "session.started", { meta: s.meta, resumed: true }, "harness");
		return id;
	}

	/** A transient turn whose process stopped ends as failed; its unfinished tool calls get one result each. */
	private async repairInterruptedTurn(s: Session): Promise<void> {
		const all = s.order.map((id) => s.entries.get(id)!);
		const lastStart = [...all].reverse().find((e) => e.kind === "turnStart");
		if (!lastStart) return;
		if (all.some((e) => e.kind === "turnEnd" && e.turnId === lastStart.turnId)) return;
		const inTurn = all.filter((e) => e.turnId === lastStart.turnId);
		const answered = new Set(inTurn.filter((e) => e.kind === "toolResult").map((e) => e.toolCallId));
		const started = new Set(inTurn.filter((e) => e.kind === "toolStarted").map((e) => e.toolCallId));
		const drafts: EntryDraft[] = [];
		for (const e of inTurn) {
			if (e.message?.role !== "assistant") continue;
			for (const part of e.message.content.filter(isToolCall)) {
				if (answered.has(part.id)) continue;
				const status = started.has(part.id) ? "outcomeUnknown" : "notStarted";
				const note = status === "outcomeUnknown" ? "The process stopped while this tool call was running. Its outcome is unknown." : "The process stopped before this tool call started.";
				drafts.push({
					kind: "toolResult", writer: "harness", modelVisible: true, turnId: lastStart.turnId, toolCallId: part.id,
					message: { role: "toolResult", toolCallId: part.id, toolName: part.name, content: [text(note)], isError: true },
					data: { status },
				});
			}
		}
		drafts.push({ kind: "turnEnd", writer: "harness", modelVisible: false, turnId: lastStart.turnId, data: { outcome: { kind: "failed", error: "The process stopped during the turn" } } });
		await this.commit(s, drafts);
	}

	async forkSession(sessionId: string, entryId: string): Promise<string> {
		const s = this.session(sessionId);
		return this.startSession({ forkFrom: { sessionId, entryId }, actor: [...s.actors.values()][0] });
	}

	async closeSession(id: string): Promise<void> {
		const s = this.sessions.get(id);
		if (!s) return;
		await this.cancel(id);
		for (const jobId of [...s.jobs.keys()]) await this.cancelJob(s, jobId);
		for (const r of s.requests.values()) r.resolve({ requestId: r.request.id, declined: true, actorId: "harness", reason: "session closed" });
		s.requests.clear();
		await this.hooks.observe("session.end", { sessionId: id });
		this.emit(id, "session.ended", {}, "harness");
		s.closed = true;
		await this.use<HistoryStore>("history-store")?.close(id);
		this.sessions.delete(id);
	}

	// ---------- the record ----------

	/** Commit drafts to the session. All are kept, or none are. */
	async commit(s: Session, drafts: EntryDraft[]): Promise<HistoryEntry[]> {
		let position = s.position;
		const entries: HistoryEntry[] = drafts.map((d) => {
			const entry: HistoryEntry = { ...d, id: d.id ?? this.newId(), parentId: position, sessionId: s.id, time: this.now() };
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

	private async erase(s: Session, entryIds: string[], actorId: string, writer: string): Promise<void> {
		this.requireAuthority(s, actorId, "erase");
		const store = this.use<HistoryStore>("history-store");
		if (!s.ephemeral) {
			if (!store?.erase) throw new Error("Erasure is not supported by this history store");
			await store.erase(s.id, entryIds);
		}
		await this.commit(s, [{ kind: "erasure", writer, actorId, modelVisible: false, data: { entryIds } }]);
		await this.providerFor(s)?.discardState?.(s.id);
		this.emit(s.id, "entries.erased", { count: entryIds.length }, writer, { actorId });
	}

	// ---------- authority ----------

	private requireAuthority(s: Session, actorId: string, authority: Authority): void {
		const actor = s.actors.get(actorId);
		if (!actor) throw new Error(`Actor ${actorId} is not part of this session`);
		if (!actor.authority.includes(authority)) throw new Error(`Actor ${actorId} may not ${authority}`);
	}

	// ---------- input and turns ----------

	private async input(sessionId: string, options: InputOptions): Promise<InputReceipt & { handled?: boolean; output?: string }> {
		const s = this.session(sessionId);
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
		if (transformed.stopped) {
			const receipt = { inputId: this.newId(), taken: "now" as const, handled: true };
			if (options.key) s.keys.set(options.key, receipt);
			return receipt;
		}
		content = transformed.value.content;
		const queued: QueuedInput = {
			id: this.newId(), content, actorId: options.actorId, when: options.when ?? "now", key: options.key,
			startedBy: options.startedBy ?? { kind: "actor", id: options.actorId }, kind: options.kind ?? "input",
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
		while (s.running) await s.running.done;
	}

	private runtime(): Runtime | undefined {
		return this.use<Runtime>("runtime");
	}

	private startTurn(s: Session, queued: QueuedInput): void {
		const turnId = this.newId();
		const abort = new AbortController();
		const done = this.runTurn(s, queued, turnId, abort.signal)
			.catch((error) => this.problem("harness", "turn", error))
			.finally(() => {
				s.running = undefined;
				const next = [...s.steering, ...s.followUps];
				s.steering = [];
				s.followUps = next.slice(1);
				if (next[0] && !s.closed) this.startTurn(s, next[0]);
			});
		s.running = { turnId, abort, done };
	}

	private async runTurn(s: Session, queued: QueuedInput, turnId: string, signal: AbortSignal): Promise<void> {
		await this.commit(s, [
			{ kind: "turnStart", writer: "harness", modelVisible: false, turnId, actorId: queued.actorId, data: { startedBy: queued.startedBy } },
			{ kind: queued.kind, writer: "harness", modelVisible: true, turnId, actorId: queued.actorId, message: { role: "user", content: queued.content }, data: { inputId: queued.id } },
		]);
		this.emit(s.id, "turn.started", { startedBy: queued.startedBy }, "harness", { turnId });
		const contributions = await this.hooks.collect<{ system?: string; context?: ContentPart[] }>("turn.before", { sessionId: s.id, turnId, input: queued });
		const state: TurnState = { systemPrompt: contributions.map((c) => c.system).filter(Boolean).join("\n\n") };
		const extra = contributions.filter((c) => c.context?.length);
		if (extra.length) {
			await this.commit(s, extra.map((c) => ({ kind: "context", writer: "harness", modelVisible: true, turnId, message: { role: "user" as const, content: c.context! } })));
		}
		let outcome: TurnOutcome;
		const runtime = this.runtime();
		const model = this.modelAccess(s);
		if (!runtime) outcome = this.failedOutcome("No Runtime is loaded");
		else if (!model) outcome = this.failedOutcome("No model is selected, or its Provider is not loaded");
		else {
			await this.hooks.observe("turn.start", { sessionId: s.id, turnId });
			try {
				outcome = await runtime.runTurn(
					{
						sessionId: s.id, turnId, startedBy: queued.startedBy, model,
						settings: { maxSteps: s.settings.maxSteps as number | undefined, reasoning: s.settings.thinking as string | undefined, maxOutput: s.settings.maxOutput as number | undefined },
						resultShape: s.settings.resultShape as Record<string, unknown> | undefined,
					},
					this.runtimeHost(s, turnId, state),
					signal,
				);
			} catch (error) {
				outcome = this.failedOutcome(error instanceof Error ? error.message : String(error));
			}
		}
		await this.commit(s, [{ kind: "turnEnd", writer: "harness", modelVisible: false, turnId, data: { outcome: outcome.outcome, result: outcome.result, usage: outcome.usage } }]);
		await this.hooks.observe("turn.end", { sessionId: s.id, turnId, outcome });
		this.emit(s.id, "turn.ended", outcome, "harness", { turnId });
	}

	private failedOutcome(error: string): TurnOutcome {
		return { outcome: { kind: "failed", error }, result: { openToolCalls: [] }, entries: [], usage: zeroUsage() };
	}

	private runtimeHost(s: Session, turnId: string, state: TurnState): RuntimeHost {
		return {
			newId: () => this.newId(),
			prepareStep: async ({ stepId, usage }) => {
				const model = this.modelAccess(s);
				const request: ModelRequest = {
					systemPrompt: state.systemPrompt,
					messages: s.modelMessages(),
					tools: this.toolDefinitions(s).filter((t) => !t.callers || t.callers.includes("model")),
					providerTools: "none",
					settings: { reasoning: s.settings.thinking as string | undefined, maxOutput: s.settings.maxOutput as number | undefined },
				};
				const payload = { sessionId: s.id, turnId, stepId, usage, model: model?.model, history: s.branch(), request };
				return (await this.hooks.transform("step.before", payload)).value.request;
			},
			hook: (name, payload) => this.hooks.run(name, { sessionId: s.id, turnId, ...payload }),
			runToolCall: (call, signal) => this.executeTool(s, call, signal, turnId),
			definition: (name) => this.findTool(s, name)?.definition,
			record: async (draft) => (await this.commit(s, [{ ...draft, turnId }]))[0],
			takeSteering: async () => {
				const items = s.steering.splice(0);
				if (!items.length) return [];
				return this.commit(s, items.map((q) => ({ kind: q.kind, writer: "harness", modelVisible: true, turnId, actorId: q.actorId, message: { role: "user" as const, content: q.content }, data: { inputId: q.id, steered: true } })));
			},
			hasSteering: () => s.steering.length > 0,
			report: (type, data, ids) => this.emit(s.id, type, data, "runtime", { turnId, ...ids }),
		};
	}

	// ---------- models ----------

	private providerFor(s: Session): Provider | undefined {
		const ref = parseModel(s.settings.model);
		if (!ref) return undefined;
		return this.useAll<Provider>("provider").find((p) => p.id === ref.provider);
	}

	private modelAccess(s: Session): ModelAccess | undefined {
		const ref = parseModel(s.settings.model);
		const provider = this.providerFor(s);
		if (!ref || !provider) return undefined;
		const info: ModelInfo | undefined = provider.models().find((m) => m.id === ref.id);
		if (!info) return undefined;
		return {
			model: info,
			supports: provider.supports,
			request: (request, options) => provider.request(ref, request, { ...options, sessionId: s.id }),
		};
	}

	// ---------- tools ----------

	private findTool(_s: Session | undefined, name: string): { source: ToolSource; definition: ToolDefinition } | undefined {
		for (const source of this.useAll<ToolSource>("tool-source")) {
			const definition = source.tools().find((t) => t.name === name);
			if (definition) return { source, definition };
		}
		return undefined;
	}

	private toolDefinitions(s?: Session): ToolDefinition[] {
		const seen = new Set<string>();
		const out: ToolDefinition[] = [];
		for (const source of this.useAll<ToolSource>("tool-source")) {
			for (const t of source.tools()) {
				if (seen.has(t.name)) continue; // the first source to offer a name wins
				seen.add(t.name);
				out.push(t);
			}
		}
		const allowed = s?.settings.tools as string[] | undefined;
		return allowed ? out.filter((t) => allowed.includes(t.name)) : out;
	}

	/** Run one tool call. Hook points are applied by whoever owns the operation. */
	private async executeTool(s: Session, call: ToolCall, signal: AbortSignal, turnId?: string): Promise<ToolResult> {
		const found = this.findTool(s, call.name);
		if (!found) return { callId: call.id, status: "failed", content: [text(`Unknown tool: ${call.name}`)] };
		const missing = requiredMissing(found.definition.parameters, call.input);
		if (missing.length) return { callId: call.id, status: "failed", content: [text(`Missing required input: ${missing.join(", ")}`)] };
		await this.commit(s, [{ kind: "toolStarted", writer: "harness", modelVisible: false, turnId, toolCallId: call.id, stepId: call.stepId, data: { name: call.name, startedBy: call.startedBy } }]);
		this.emit(s.id, "tool.started", { call }, found.source.id, { turnId, toolCallId: call.id, stepId: call.stepId });
		try {
			const result = await found.source.run(call, {
				sessionId: s.id,
				signal,
				call,
				progress: (content) => this.emit(s.id, "tool.progress", { content }, found.source.id, { turnId, toolCallId: call.id }),
				environment: this.use<WorkingEnvironment>("working-environment"),
				ask: (request) => this.ask(s, { ...request, toolCallId: call.id }, found.source.id),
			});
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
		if (definition?.callers && call.startedBy !== "tool" && !definition.callers.includes(call.startedBy as "ui" | "plugin")) {
			return { callId: call.id, status: "refused", content: [text(`${call.name} can't be called by a ${call.startedBy}`)] };
		}
		const gate = await this.hooks.gate("tool.before", { sessionId: s.id, call, definition });
		let result: ToolResult;
		if (gate.refused) result = { callId: call.id, status: "refused", content: [text(gate.refused)] };
		else result = await this.executeTool(s, gate.value.call, new AbortController().signal);
		result = (await this.hooks.transform("tool.after", { sessionId: s.id, call, result })).value.result;
		await this.commit(s, [{ kind: "toolCallOutsideTurn", writer: "harness", modelVisible: false, toolCallId: call.id, actorId: call.actorId, data: { call, result } }]);
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

	private ask(s: Session, draft: InputRequestDraft, askedBy: string): Promise<Answer> {
		const request: InputRequest = { ...draft, id: this.newId(), sessionId: s.id, askedBy, answerers: draft.answerers ?? [] };
		const viewers = this.interfaces().filter((i) => s.actors.get(i.actorId)?.authority.includes("watch") || this.mayAnswer(s, request, i.actorId));
		if (!viewers.some((i) => this.mayAnswer(s, request, i.actorId))) {
			return Promise.resolve({ requestId: request.id, declined: true, actorId: "harness", reason: "No one present can answer" });
		}
		return new Promise<Answer>((resolve) => {
			const open = {
				request,
				resolve: (answer: Answer) => {
					if (open.timer) clearTimeout(open.timer);
					s.requests.delete(request.id);
					for (const i of viewers) i.onInputRequestClosed?.(request.id);
					this.emit(s.id, "input.request.closed", { requestId: request.id, declined: answer.declined ?? false, value: request.kind === "secret" ? undefined : answer.value }, "harness", { actorId: answer.actorId, toolCallId: request.toolCallId });
					resolve(answer);
				},
				timer: undefined as NodeJS.Timeout | undefined,
			};
			if (request.timeLimitMs) open.timer = setTimeout(() => open.resolve({ requestId: request.id, declined: true, actorId: "harness", reason: "time limit" }), request.timeLimitMs);
			s.requests.set(request.id, open);
			this.emit(s.id, "input.request.opened", { request }, askedBy, { toolCallId: request.toolCallId });
			for (const i of viewers) i.onInputRequest?.(request);
		});
	}

	private answer(s: Session, answer: Answer): { accepted: boolean; reason?: string } {
		const open = s.requests.get(answer.requestId);
		if (!open) return { accepted: false, reason: "The request is closed or can no longer be answered" };
		if (!this.mayAnswer(s, open.request, answer.actorId)) return { accepted: false, reason: `${answer.actorId} may not answer this request` };
		open.resolve(answer); // the first accepted answer closes the request
		return { accepted: true };
	}

	// ---------- jobs ----------

	private startJob(s: Session, options: { kind: string; actorId?: string }, plugin: string): JobHandle {
		const job: Job = { id: this.newId(), kind: options.kind, sessionId: s.id, plugin, actorId: options.actorId, turnId: s.running?.turnId, state: "running", usage: zeroUsage() };
		const record: { job: Job; cancel?: () => void | Promise<void> } = { job };
		s.jobs.set(job.id, record);
		this.emit(s.id, "job.started", { job }, plugin, { jobId: job.id });
		return {
			id: job.id,
			progress: (content) => this.emit(s.id, "job.progress", { content: typeof content === "string" ? [text(content)] : content }, plugin, { jobId: job.id }),
			finish: async (state, result) => {
				if (job.state !== "running") return;
				job.state = state;
				job.result = typeof result === "string" ? [text(result)] : result;
				s.jobs.delete(job.id);
				this.emit(s.id, "job.ended", { state, result: job.result }, plugin, { jobId: job.id });
				if (s.closed) return;
				const report: ContentPart[] = [text(`[Job ${job.kind} ${job.id.slice(0, 8)} ${state}]`), ...(job.result ?? [])];
				await this.input(s.id, { content: report, when: "after", actorId: job.actorId ?? "harness", kind: "jobReport", startedBy: { kind: "job", id: job.id } });
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
		this.emit(s.id, "job.ended", { state: "cancelled" }, record.job.plugin, { jobId });
	}

	// ---------- declarations ----------

	declaration(s?: Session): Declaration {
		const runtime = this.runtime();
		const store = this.use<HistoryStore>("history-store");
		const provider = s ? this.providerFor(s) : undefined;
		return {
			inputDuringTurn: runtime?.supports.inputDuringTurn === true,
			waitingThroughRestart: runtime?.supports.waitingThroughRestart === true,
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

function requiredMissing(schema: Record<string, unknown>, input: Record<string, unknown>): string[] {
	const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
	return required.filter((k) => input?.[k] === undefined);
}

export type { GateResult };
