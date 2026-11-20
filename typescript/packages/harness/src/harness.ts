import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { interruptedCalls, modelView, pendingToolCalls, restoreAnsweredStep, withoutProviderData } from "./view.js";
import { HookRegistry } from "./hooks.js";
import { inputIdOf, inputKeyScope, type InputReceipt, type InputTiming, type QueuedInput, Session } from "./session.js";
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
	type SecretScope,
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
	type ModelMessage,
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
	type Usage,
	type WorkingEnvironment,
	addUsage,
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

export interface SessionStartOptions { tenant?: string; settings?: Record<string, unknown>; actor?: Actor; forkFrom?: { sessionId: string; entryId: string }; parentSessionId?: string; prepare?: SessionPrepare }
export type SessionPrepare = (id: string) => Promise<void>;
const schemaValidator = new Ajv2020({ strict: false, validateFormats: false, ownProperties: true, addUsedSchema: false });

export interface InputOptions { resultShape?: Record<string, unknown>; content: ContentPart[] | string; when?: InputTiming; key?: string; actorId: string; kind?: string; delegatedBy?: string; startedBy?: QueuedInput["startedBy"]; sources?: string[] }
export interface ErasureReport {
	erased: string[]; pending: string[]; outOfReach: string[];
	erasedPairs: { sessionId: string; id: string }[]; pendingPairs: { sessionId: string; id: string }[];
}

export interface JobHandle {
	id: string;
	started: boolean;
	ready: Promise<unknown>;
	/** The entry that recorded this job starting. */
	startEntryId?: string;
	progress(content: ContentPart[] | string): void;
	/** Finish the job. Its result enters the session as input and may start a turn, unless report is false. */
	finish(state: Exclude<JobState, "running">, result?: ContentPart[] | string, options?: { report?: boolean; sources?: string[]; error?: string }): Promise<void>;
	onCancel(fn: () => void | Promise<void>): void;
}
interface JobStart { kind: string; key?: string; actorId?: string; actors?: string[]; jobs?: string[]; toolCallId?: string; detail?: unknown }
interface KeptJob { job: Job; key?: string; detail?: unknown; actors?: string[]; rights?: Authority[] }

export interface Transaction {
	append(draft: EntryDraft): void;
	setSetting(key: string, value: unknown, actorId?: string): void;
	input(options: InputOptions): void;
}
export interface FollowOptions { recipient: string; fromEntry?: number; raw?: boolean; onLag?: () => void }

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
	on(hook: string, handler: (payload: any) => unknown, order?: HandlerOrder, options?: { stream?: boolean }): () => void;
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
	openSession(id: string, actor?: Actor, prepare?: SessionPrepare): Promise<string>;
	/** Add an actor to a session. Its authority must be within the authority of whoever grants it. */
	join(sessionId: string, actor: Actor, grantedBy: string): Promise<void>;
	leave(sessionId: string, actorId: string, requestedBy?: string): Promise<void>;
	presentActors(sessionId: string): string[];
	presenceChanged(sessionId: string): void;
	/** Sessions in this project, another project, or every project (null). */
	listSessions(project?: string | null): Promise<StoredSession[]>;
	forkSession(sessionId: string, entryId: string): Promise<string>;
	closeSession(sessionId: string, actorId?: string, delegatedBy?: string): Promise<void>;
	session(sessionId: string): { id: string; project: string; settings: Record<string, unknown>; position: string | null; busy: boolean; actors: Actor[]; ephemeral: boolean };
	// input and turns
	input(sessionId: string, options: InputOptions): Promise<InputReceipt & { handled?: boolean; output?: string }>;
	withdraw(sessionId: string, inputId: string): QueuedInput | undefined;
	proposals(sessionId: string, actorId: string): { inputId: string; actorId: string; content: ContentPart[]; time: number }[];
	withdrawProposal(sessionId: string, inputId: string, actorId: string, delegatedBy?: string): Promise<void>;
	cancel(sessionId: string): Promise<QueuedInput[]>;
	releaseInput(sessionId: string, inputId: string, when: Exclude<InputTiming, "propose">, actorId: string, declined?: boolean): Promise<InputReceipt>;
	recoveredInput(sessionId: string): QueuedInput[];
	waitForIdle(sessionId: string): Promise<void>;
	moveTo(sessionId: string, entryId: string, options?: { rewind?: boolean; actorId?: string }): Promise<{ outOfReach?: string[] }>;
	setSetting(sessionId: string, key: string, value: unknown, actorId?: string): Promise<void>;
	setLimit(sessionId: string, rights: Authority[] | null, actorId: string): Promise<void>;
	tenant(sessionId: string): Promise<TenantInfo>;
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
	deferTool(sessionId: string, turnId: string | undefined, question: InputRequestDraft): Promise<{ pending: string } | { refuse: string } | undefined>;
	answer(sessionId: string, answer: Answer): { accepted: boolean; reason?: string };
	submitAnswer(sessionId: string, answer: Answer): Promise<{ accepted: boolean; reason?: string }>;
	openRequests(sessionId: string): InputRequest[];
	// jobs
	/** Start a job. It is recorded in the history, with the plugin's own detail. */
	startJob(sessionId: string, options: JobStart): JobHandle;
	workActors(sessionId: string): string[];
	workJobs(sessionId: string): string[];
	workMay(sessionId: string, right: Authority, actors: string[], jobs?: string[]): boolean;
	findJob(jobId: string): { sessionId: string } | undefined;
	onJobCancel(handler: (jobId: string) => Promise<void>): void;
	/** Jobs this plugin started that the history shows as never ended, for example because the process stopped. */
	unfinishedJobs(sessionId: string): KeptJob[];
	/** Take over a recorded, unfinished job of this plugin's after a restart. */
	resumeJob(sessionId: string, jobId: string, cancelling?: boolean): JobHandle;
	jobs(sessionId: string): (Omit<Job, "state"> & { state: "running" | "unfinished" | "cleanupUnconfirmed" })[];
	cancelJob(sessionId: string, jobId: string): Promise<void>;
	// following along
	follow(sessionId: string, options: FollowOptions, listener: (event: AgentEvent) => unknown): (() => void) & { idle(): Promise<void> };
	flushOutput(sessionId: string, recipient: string): Promise<void>;
	gateOutput<T>(sessionId: string, recipient: string, type: string, data: T): Promise<T | undefined>;
	declaration(sessionId?: string): Declaration;
	modelAccess(sessionId: string): ModelAccess | undefined;
	// settings
	config(): Record<string, unknown>;
}

export interface HarnessOptions { project: string; home: string; now?: () => number; newId?: () => string; questionsOutlastTurns?: boolean; settingsDuringTurn?: "nextTurn" | "refused"; jobReportsStartTurns?: boolean; rejectUnknownModel?: boolean; tenants?: Record<string, Tenant> | null }

export const ALL_AUTHORITY: Authority[] = ["watch", "propose", "input", "answer", "approve", "tools", "cancel", "settings", "erase", "grant", "jobs", "delegate", "administer"];

export interface Tenant { rights: Authority[]; tokens?: number }
interface TenantInfo { tenant: string | null; rights: Authority[] | null; tokens: { budget: number; used: number } | null }
interface TurnState extends TurnSnapshot { endedHook?: boolean; sources: Map<string, string[]>; actors: Set<string>; jobs: Set<string>; tenantLimit?: boolean; stepAfterRunning?: boolean; toolResultError?: string }

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
	private opening = new Set<string>();
	private readonly tenants: Map<string, Tenant>;
	private listeners: { plugin: string; raw: boolean; fn: (e: AgentEvent) => void }[] = [];
	private commandTable = new Map<string, Command & { plugin: string }>();
	private now: () => number;
	private readonly questionsOutlastTurns: boolean;
	private readonly settingsDuringTurn?: "nextTurn" | "refused";
	private readonly jobReportsStartTurns: boolean;
	private readonly rejectUnknownModel: boolean;
	private newId: () => string;
	private jobCancels = new Map<string, (jobId: string) => Promise<void>>();
	private refusedTools = new Set<string>();
	private turnAuthority = new AsyncLocalStorage<{ sessionId: string; actors: Set<string>; jobs: Set<string> }>();
	private toolWork = new AsyncLocalStorage<ToolCall>();
	private gateSignal = new AsyncLocalStorage<AbortSignal | undefined>();
	readonly problems: { plugin: string; where: string; error: string }[] = [];

	constructor(options: HarnessOptions) {
		this.tenants = readTenants(options.tenants === undefined ? process.env.MODULAR_AGENT_TENANTS : JSON.stringify(options.tenants ?? {}));
		this.project = options.project;
		this.home = options.home;
		this.now = options.now ?? Date.now;
		this.newId = options.newId ?? randomUUID;
		this.questionsOutlastTurns = options.questionsOutlastTurns ?? true;
		this.settingsDuringTurn = options.settingsDuringTurn;
		this.jobReportsStartTurns = options.jobReportsStartTurns ?? true;
		this.rejectUnknownModel = options.rejectUnknownModel === true;
		this.hooks = new HookRegistry(({ hook, plugin, error }) => this.problem(plugin, `hook ${hook}`, error));
		const h = (name: string, rule: HookRule, owner: string) => this.hooks.define(name, rule, owner);
		// Harness hook points
		h("plugin.load", "gate", "harness");
		h("session.prepare", "observe", "harness");
		h("session.start", "observe", "harness");
		h("session.end", "observe", "harness");
		h("session.join", "observe", "harness");
		h("session.leave", "observe", "harness");
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
		h("provider.piece", "observe", "provider");
	}

	// ---------- hosting ----------

	async load(plugins: Plugin[]): Promise<void> {
		const replaced = new Set(plugins.map((p) => p.replaces).filter((r): r is string => !!r));
		for (const plugin of plugins) {
			if (replaced.has(plugin.name)) {
				this.emit("", "plugin.replaced", { plugin: plugin.name }, "harness");
				continue;
			}
			if (this.loaded.some((loaded) => loaded.plugin.name === plugin.name)) {
				this.problem(plugin.name, "load", new Error("A plugin with this name is already loaded"));
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
	async interrupt(): Promise<void> {
		await Promise.all([...this.sessions.keys()].map(id => this.suspendSession(id)));
	}

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
			on: (hook, handler, order, options) => this.hooks.on(hook, pluginName, handler, order, options?.stream),
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
			openSession: (id, actor, prepare) => this.openSession(id, actor, prepare),
			join: (sessionId, actor, grantedBy) => this.join(this.session(sessionId), actor, grantedBy, pluginName),
			leave: async (sessionId, actorId, requestedBy) => {
				const s = this.session(sessionId);
				if (requestedBy && requestedBy !== actorId) this.requireAuthority(s, requestedBy, "grant");
				if (!s.actors.has(actorId)) throw new Error(`Actor ${actorId} is not part of this session`);
				await this.commit(s, [{ kind: "actorLeft", writer: pluginName, actorId, modelVisible: false, data: { actorId } }]);
				await this.hooks.observe("session.leave", { sessionId, actorId, requestedBy });
				this.emit(s.id, "session.left", { actorId }, pluginName, { actorId });
				this.closeUnanswerable(s);
			},
			presentActors: (id) => this.presentActors(this.session(id)),
			presenceChanged: (id) => { const s = this.sessions.get(id); if (s) this.closeUnanswerable(s); },
			listSessions: async (project) => (await this.use<HistoryStore>("history-store")?.list(project === null ? undefined : { project: project ?? this.project })) ?? [],
			forkSession: (sessionId, entryId) => this.forkSession(sessionId, entryId),
			closeSession: (id, actorId, delegatedBy) => this.closeSession(id, actorId, delegatedBy),
			session: (id) => {
				const s = this.session(id);
				return { id: s.id, project: s.meta.project, settings: { ...s.settings }, position: s.position, busy: s.isBusy(), actors: [...s.actors.values()].map((a) => ({ ...a, authority: this.rightsOf(s, a.id) })), ephemeral: s.ephemeral };
			},
			input: (sessionId, options) => this.input(sessionId, options),
			withdraw: (sessionId, inputId) => this.withdraw(sessionId, inputId),
			proposals: (id, actorId) => {
				const s = this.session(id);
				this.requireAuthority(s, actorId, "watch");
				return [...s.proposals.values()].map((q) => ({ inputId: q.id, actorId: q.actorId, content: q.content, time: q.time! }));
			},
			withdrawProposal: (id, inputId, actorId, delegatedBy) => this.withdrawProposal(this.session(id), inputId, actorId, delegatedBy),
			cancel: (sessionId) => this.cancel(sessionId),
			releaseInput: (id, inputId, when, actorId, declined) => this.releaseInput(this.session(id), inputId, when, actorId, declined),
			recoveredInput: (id) => this.session(id).recoveredInput,
			waitForIdle: (sessionId) => this.waitForIdle(sessionId),
			moveTo: (sessionId, entryId, options) => this.moveTo(sessionId, entryId, options ?? {}, pluginName),
			setSetting: (sessionId, key, value, actorId) => this.setSetting(this.session(sessionId), key, value, pluginName, actorId),
			setLimit: (id, rights, actorId) => this.setLimit(this.session(id), rights, actorId, pluginName),
			tenant: (id) => this.tenantInfo(this.session(id)),
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
			deferTool: (id, turnId, question) => this.deferTool(this.session(id), turnId, question, pluginName),
			answer: (sessionId, answer) => this.answer(this.session(sessionId), answer),
			submitAnswer: (sessionId, answer) => this.submitAnswer(this.session(sessionId), answer),
			openRequests: (sessionId) => {
				const s = this.session(sessionId);
				return [...[...s.requests.values()].map((r) => r.request), ...this.waitingRequests(s)];
			},
			startJob: (sessionId, options) => this.startJob(this.session(sessionId), options, pluginName),
			workActors: (id) => this.workActors(this.session(id)),
			workJobs: (id) => { const work = this.turnAuthority.getStore(); return work?.sessionId === id ? [...work.jobs] : []; },
			workMay: (id, right, actors, jobs) => this.workRights(this.session(id), actors, jobs).includes(right),
			findJob: (jobId) => {
				for (const s of this.sessions.values()) {
					if (s.order.some((id) => { const e = s.entries.get(id)!; return e.kind === "jobStarted" && e.jobId === jobId && e.writer === pluginName; })) return { sessionId: s.id };
				}
				return undefined;
			},
			onJobCancel: (handler) => this.jobCancels.set(pluginName, handler),
			unfinishedJobs: (id) => this.runningJobs(this.session(id)).filter(({ job }) => job.plugin === pluginName),
			resumeJob: (id, jobId) => {
				const s = this.session(id);
				const found = this.runningJobs(s).find((j) => j.job.id === jobId && j.job.plugin === pluginName);
				if (!found) throw new Error(`No unfinished job ${jobId} of ${pluginName}`);
				return s.jobs.get(jobId)?.handle ?? this.jobHandle(s, found);
			},
			jobs: (id) => {
				const s = this.session(id);
				const cleanup = new Set(s.order.map((eid) => s.entries.get(eid)!).filter((e) => e.kind === "jobCleanupUnconfirmed").map((e) => e.jobId));
				return this.runningJobs(s).map(({ job }) => ({ ...job, state: cleanup.has(job.id) ? "cleanupUnconfirmed" as const : s.jobs.has(job.id) ? "running" as const : "unfinished" as const }));
			},
			cancelJob: (sessionId, jobId) => this.cancelJob(this.session(sessionId), jobId),
			follow: (sessionId, options, listener) => this.follow(this.session(sessionId), options, listener),
			flushOutput: async (id, recipient) => {
				const followers = [...(this.sessions.get(id)?.followers ?? [])].filter((f) => f.recipient === recipient);
				await Promise.all(followers.map((f) => f.idle()));
			},
			gateOutput: async (sessionId, recipient, type, data) => {
				let out: typeof data | undefined;
				const follower = new Follower(this.hooks, recipient, false, (e) => { if (e.type === type) out = e.data; }, (e) => this.problem("harness", "output gate", e));
				follower.push({ type, time: this.now(), sessionId, source: pluginName, data });
				await follower.idle();
				return out;
			},
			declaration: (sessionId) => this.declaration(sessionId ? this.session(sessionId) : undefined),
			gatedHistory: async (sessionId, options) => {
				const s = this.session(sessionId);
				const entries = options.all ? s.order.map((id) => s.entries.get(id)!) : s.branch();
				const out: HistoryEntry[] = [];
				const follower = new Follower(this.hooks, options.recipient, false, (e) => { if (e.type === "entry") out.push(e.data as HistoryEntry); }, (e) => this.problem("harness", "gated history", e));
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

	private follow(s: Session, options: FollowOptions, listener: (event: AgentEvent) => unknown): (() => void) & { idle(): Promise<void> } {
		const follower = new Follower(this.hooks, options.recipient, options.raw ?? false, listener, (e) => this.problem("harness", "follow", e),
			options.onLag && (() => { s.followers.delete(follower); options.onLag!(); }));
		// History first, from the requested point, then live events.
		const from = options.fromEntry ?? s.order.length;
		for (const id of s.order.slice(from)) follower.push({ type: "entry", time: this.now(), sessionId: s.id, source: "harness", data: s.entries.get(id) });
		s.followers.add(follower);
		return Object.assign(() => { s.followers.delete(follower); follower.disconnect(); }, { idle: () => follower.idle() });
	}

	// ---------- commands ----------

	private async runCommand(sessionId: string, line: string, actorId: string): Promise<string | void> {
		const match = /^\/(\S+)\s*([\s\S]*)$/.exec(line.trim());
		if (!match) throw new Error("Not a command");
		this.requireAuthority(this.session(sessionId), actorId, "input");
		this.use<HistoryStore>("history-store")?.checkWriter?.(sessionId);
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
		const sourceId = options.forkFrom?.sessionId ?? options.parentSessionId;
		const ancestor = sourceId ? this.sessions.get(sourceId) ?? await this.loadInto(sourceId) : undefined;
		const tenant = ancestor?.tenant ?? options.tenant;
		if (tenant !== undefined && !this.tenants.has(tenant)) throw Object.assign(new Error(`Unknown tenant ${tenant}`), { code: "invalid_params" });
		const cwd = options.settings?.cwd;
		const meta: StoredSession = { id: this.newId(), created: this.now(), project: ancestor?.meta.project ?? (typeof cwd === "string" ? cwd : this.project), forkedFrom: options.forkFrom, parentSessionId: options.parentSessionId };
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
		let copies: HistoryEntry[] = [];
		if (options.forkFrom) {
			const source = ancestor;
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
				copies = copyForkPrefix(path, meta.id, () => this.newId());
				Object.assign(defaults, source.settings);
			}
		}
		const actors = options.forkFrom && ancestor ? [...ancestor.actors.values()] : [actor];
		const drafts: EntryDraft[] = [...actors.map((a) => actorJoined(a, "harness")), ...Object.entries(defaults).map(([key, value]): EntryDraft => ({ kind: "setting", writer: "harness", modelVisible: false, data: { key, value } }))];
		if (tenant !== undefined && s.tenant === undefined) drafts.unshift({ kind: "tenant", writer: "harness", modelVisible: false, data: { tenant } });
		if (options.forkFrom && ancestor?.limit) drafts.push({ kind: "limit", writer: "harness", modelVisible: false, actorId: actor.id, data: { rights: ancestor.limit } });
		else if (options.forkFrom && s.limit !== null) drafts.push({ kind: "limit", writer: "harness", modelVisible: false, actorId: actor.id, data: { rights: null } });
		if (options.parentSessionId) {
			const actors = ancestor ? this.workActors(ancestor) : [];
			const work = this.turnAuthority.getStore();
			const jobs = work?.sessionId === ancestor?.id && work ? [...work.jobs] : [];
			if (actors.length || jobs.length) drafts.push({ kind: "harness.parentAuthority", writer: "harness", modelVisible: false, data: { actors, jobs } });
		}
		try {
			if (options.forkFrom) {
				const departed = new Set(ancestor?.order.map((id) => ancestor.entries.get(id)!).flatMap((e) => e.kind === "actorLeft" ? [(e.data as { actorId: string }).actorId] : []));
				for (const id of departed) if (!ancestor?.actors.has(id)) drafts.push({ kind: "actorLeft", writer: "harness", modelVisible: false, data: { actorId: id } });
				drafts.push({ kind: "plugins", writer: "harness", modelVisible: false, data: { active: this.activePlugins() } });
				let parentId = copies.at(-1)?.id ?? null;
				const setup = drafts.map((draft): HistoryEntry => {
					const entry = { ...draft, id: this.newId(), parentId, sessionId: s.id, time: this.now() };
					if (entry.kind === "setting") entry.data = normalizeSetting(entry.data as { key: string; value: unknown });
					parentId = entry.id;
					return entry;
				});
				const batch = [...copies, ...setup];
				await store?.append(s.id, batch);
				for (const e of batch) s.apply(e);
			} else {
				await this.commit(s, drafts);
				await this.recordPlugins(s);
			}
		} catch (error) {
			this.sessions.delete(meta.id);
			await store?.close(meta.id);
			throw error;
		}
		await this.prepareSession(s, false, options.prepare);
		await this.hooks.observe("session.start", { sessionId: s.id, resumed: false });
		this.emit(s.id, "session.started", { meta }, "harness");
		return s.id;
	}

	private async loadInto(id: string, reconcile = false): Promise<Session | undefined> {
		const store = this.use<HistoryStore>("history-store");
		if (!store) return undefined;
		const { meta, entries } = await store.load(id);
		if (reconcile && store.erase) {
			const live = new Set(entries.filter((e) => !e.erased).map((e) => e.id));
			const pending = [...new Set(entries.flatMap((e) => e.kind === "erasure" && !e.erased ? (e.data as { entryIds: string[] }).entryIds : []).filter((eid) => live.has(eid)))];
			if (pending.length) await store.erase(id, pending);
		}
		const s = new Session(meta, false);
		for (const e of entries) s.apply(e);
		return s;
	}

	private async prepareSession(s: Session, resumed: boolean, prepare?: SessionPrepare) {
		try {
			await this.hooks.observe("session.prepare", { sessionId: s.id, project: s.meta.project, resumed });
			await prepare?.(s.id);
		} catch (error) {
			await this.hooks.observe("session.end", { sessionId: s.id });
			this.sessions.delete(s.id);
			await this.use<HistoryStore>("history-store")?.close(s.id);
			throw error;
		}
	}

	async openSession(id: string, actor?: Actor, prepare?: SessionPrepare): Promise<string> {
		if (this.opening.has(id) || this.sessions.get(id)?.closing) {
			throw Object.assign(new Error("Session is busy"), { code: "busy" });
		}
		this.opening.add(id);
		try { return await this.openStoredSession(id, actor, prepare); }
		finally { this.opening.delete(id); }
	}

	private async openStoredSession(id: string, actor?: Actor, prepare?: SessionPrepare): Promise<string> {
		const opened = this.sessions.get(id);
		if (opened) {
			if (actor) await this.authorizeOpeningActor(opened, actor);
			await prepare?.(id);
			return id;
		}
		const store = this.use<HistoryStore>("history-store");
		if (!store) throw new Error("No history store: sessions can't be reopened");
		await store.openForWriting(id, { wait: true });
		const s = await this.loadInto(id, true).catch(async (error) => { await store.close(id); throw error; });
		if (!s || (s.tenant !== undefined && !this.tenants.has(s.tenant))) {
			await store.close(id);
			throw new Error(s ? `Unknown tenant ${s.tenant}` : `Session ${id} not found`);
		}
		const a = actor ?? this.defaultActor();
		try { await this.authorizeOpeningActor(s, a); }
		catch (error) { await store.close(id); throw error; }
		this.sessions.set(id, s);
		s.reopening = true;
		try { await this.recoverSecrets(s); }
		catch (error) { this.sessions.delete(id); await store.close(id); throw error; }
		await this.prepareSession(s, true, prepare);
		const latest = s.entries.get(s.order.at(-1) ?? "");
		if (latest?.kind === "position") {
			const data = latest.data as { to: string | null; restore?: { point: string; undo: string } };
			if (data.restore) {
				const before = s.entries.get(s.order.at(-2) ?? "");
				const prior = before?.kind === "position" && (before.data as typeof data).restore;
				const undoing = !!prior && prior.point === data.restore.undo && prior.undo === data.restore.point && before?.parentId === data.to;
				try { await this.completeRewind(s, data.to, latest.parentId, data.restore, undoing); }
				catch (error) {
					if (s.suspended || (error as { code?: string }).code !== "conflict") { this.sessions.delete(id); await store.close(id); throw error; }
				}
			}
		}

		if (s.settings.approval === undefined) s.settings.approval = "all";
		else if (!["off", "ask", "all", "never"].includes(String(s.settings.approval))) s.settings.approval = "never";
		await this.recordPlugins(s);
		const admissions = [...s.admissions.values()].filter((q) => !s.proposals.has(q.id));
		const recovery = this.recoveryPolicy();
		const handBack = (q: QueuedInput) => (q.startedBy.kind === "job" ? recovery.jobs : recovery.input) === "handedBack";
		s.recoveredInput = admissions.filter(handBack);
		s.followUps.push(...admissions.filter(q => !handBack(q)));
		await this.handBack(s, s.recoveredInput, "restart");
		await this.hooks.observe("session.start", { sessionId: s.id, resumed: true });
		await this.recoverNestedCalls(s);
		await this.recoverInterruptedTurn(s);
		await this.recoverReports(s);
		s.reopening = false;
		this.startQueued(s);
		this.emit(s.id, "session.started", { meta: s.meta, resumed: true }, "harness");
		// Questions left open past their turn are still answerable after a restart.
		for (const request of this.waitingRequests(s)) {
			this.emit(s.id, "input.request.opened", { request, waiting: true }, "harness", { toolCallId: request.toolCallId });
			for (const i of this.viewersFor(s, request)) i.onInputRequest?.(request);
		}
		this.maybeContinueOpenCalls(s);
		return id;
	}

	private async authorizeOpeningActor(s: Session, actor: Actor): Promise<void> {
		const denied = () => Object.assign(new Error("Session is inaccessible"), { code: "forbidden" });
		if (s.actors.has(actor.id)) {
			if (!this.actorRights(s, actor.id).includes("watch")) throw denied();
			return;
		}
		if (s.order.some((id) => { const e = s.entries.get(id)!; return e.kind === "actorLeft" && (e.data as { actorId?: string }).actorId === actor.id; })) throw denied();
		const rights = actor.authority.filter((r) => this.withinLimits(s, r));
		if (!rights.includes("watch")) throw denied();
		await this.commit(s, [actorJoined({ ...actor, authority: rights }, "harness")]);
	}

	private activePlugins() { return this.loaded.map(({ plugin: { name, origin } }) => ({ name, ...(origin ? { origin } : {}) })); }

	private async recordPlugins(s: Session): Promise<void> {
		const active = this.activePlugins();
		const last = s.order.map((id) => s.entries.get(id)!).findLast((e) => e.kind === "plugins" && !e.erased);
		if (!isDeepStrictEqual(last?.data, { active })) await this.commit(s, [{ kind: "plugins", writer: "harness", modelVisible: false, data: { active } }]);
	}

	private async recoverReports(s: Session): Promise<void> {
		const entries = s.order.map((id) => s.entries.get(id)!);
		const jobs = new Map(entries.flatMap((e) => {
			const job = this.readJob(s, e);
			return job ? [[job.job.id, job] as const] : [];
		}));
		for (const end of entries) {
			if (!end.jobId || end.kind !== "jobEnded" || end.erased || !(end.data as { report?: boolean })?.report) continue;
			const job = jobs.get(end.jobId);
			if (job) await this.reportJob(s, job, end);
		}
	}

	/** Find a turn whose process stopped, and hand it to the Runtime, which decides what happens to it. */
	private async recoverInterruptedTurn(s: Session): Promise<void> {
		const branch = s.branch();
		const lastStart = branch.findLast((e) => e.kind === "turnStart" && !e.erased && !s.copied.has(e.id));
		if (!lastStart?.turnId) return;
		if (s.order.some((id) => { const e = s.entries.get(id)!; return e.kind === "turnEnd" && e.turnId === lastStart.turnId; })) return;
		const startedBy = (lastStart.data as { startedBy?: QueuedInput["startedBy"] } | undefined)?.startedBy ?? { kind: "actor", id: lastStart.actorId ?? "user" };
		const pending = new Map((startedBy.kind === "answer" ? this.openCalls(s) : []).map((c) => [c.id, c]));
		for (const c of interruptedCalls(branch, lastStart.turnId)) pending.set(c.id, c);
		// This host has no restart-time cleanup confirmation from its environments.
		const settled = new Set(s.order.map((id) => s.entries.get(id)!).filter((e) => e.kind === "toolResult").map((e) => e.toolCallId));
		const calls = [...pending.values()].filter((c) => !settled.has(c.id)).map((c) => ({ ...c, safeToRepeat: false }));
		const interrupted: InterruptedTurn = { turnId: lastStart.turnId, calls };
		this.emit(s.id, "turn.interrupted", { pending: interrupted.calls.length }, "harness", { turnId: interrupted.turnId });
		// Not awaited: the resumed turn may wait for an answer that only an Interface opened after this can give.
		void this.launch(s, interrupted.turnId, (signal) => this.resumeTurn(s, interrupted, startedBy, signal, lastStart.data as Partial<TurnSnapshot>));
	}

	/** Used when no Runtime is loaded: the turn ends as failed, and each pending call gets one result. */
	private async endInterruptedTurn(s: Session, interrupted: InterruptedTurn): Promise<void> {
		const drafts: EntryDraft[] = interrupted.calls.map((c) => ({
			kind: "toolResult", writer: "harness", modelVisible: true, turnId: interrupted.turnId, stepId: c.stepId, toolCallId: c.id,
			message: { role: "toolResult", toolCallId: c.id, toolName: c.name, content: [text(interruptedNote(c.started))], isError: true },
			data: { status: c.started ? "outcomeUnknown" : "notStarted" },
		}));
		if (drafts.length) await this.commit(s, drafts);
	}

	async forkSession(sessionId: string, entryId: string): Promise<string> {
		const s = this.session(sessionId);
		if (s.erasing) throw new Error("Erasure is in progress");
		// Forking at unfinished work would copy work that is still running: refused.
		if (s.running || this.runningJobs(s).length || this.waitingRequests(s).length) throw new Error("Can't fork while the session has unfinished work: a running turn, a job, or a call waiting for an answer");
		const target = s.entries.get(entryId);
		if (!target) throw Object.assign(new Error("Unknown fork target"), { code: "not_found" });
		if (target.kind === "position") throw Object.assign(new Error("Cannot fork a position record"), { code: "conflict" });
		const id = await this.startSession({ forkFrom: { sessionId, entryId }, actor: [...s.actors.values()][0] });
		await this.suspendSession(id);
		return id;
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

	async closeSession(id: string, actorId?: string, delegatedBy?: string): Promise<void> {
		const s = this.sessions.get(id);
		if (!s) return;
		await this.admit(s, async () => {
			if (s.closing || s.reopening) throw Object.assign(new Error("Session is busy"), { code: "busy" });
			const needsCancel = !!s.running || this.runningJobs(s).length > 0;
			if ([actorId, delegatedBy].some(id => id !== undefined &&
				(!s.actors.has(id) || (needsCancel && !this.rightsOf(s, id).includes("cancel"))))) {
				throw Object.assign(new Error("Actor may not close this session"), { code: "forbidden" });
			}
			s.closing = true;
		});
		await this.cancel(id);
		for (const { job } of this.runningJobs(s)) await this.cancelJob(s, job.id);
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
		if (!s.ephemeral) {
			const store = this.use<HistoryStore>("history-store");
			try { await store?.append(s.id, entries); }
			catch (error) {
				if (store?.writerSignal?.(s.id)?.aborted) { s.suspended = true; s.running?.abort.abort(); }
				throw error;
			}
		}
		for (const e of entries) {
			s.apply(e);
			const ids = { turnId: e.turnId, stepId: e.stepId, toolCallId: e.toolCallId, actorId: e.actorId };
			this.emit(s.id, "entry.added", e, e.writer, ids);
			if (e.kind === "toolResult" && e.toolCallId && e.message?.role === "toolResult") {
				this.emit(s.id, "tool.result.delivered", { status: (e.data as { status?: string } | undefined)?.status ?? "failed", content: e.message.content }, "harness", ids);
			}
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
		if (this.settingsDuringTurn === "refused" && s.isBusy()) throw Object.assign(new Error("Cannot change settings during a turn"), { code: "busy" });
		await this.commit(s, [{ kind: "setting", writer, actorId, modelVisible: false, data: { key, value } }]);
		this.emit(s.id, "setting.changed", { key, value, appliesFrom: this.settingsDuringTurn === "nextTurn" ? "next turn" : "next step" }, writer, { actorId });
	}

	private async moveTo(sessionId: string, entryId: string, options: { rewind?: boolean; actorId?: string }, writer: string): Promise<{ outOfReach?: string[] }> {
		const s = this.session(sessionId);
		return this.admit(s, async () => {
			if (options.actorId) this.requireAuthority(s, options.actorId, "settings");
			if (s.isBusy() || s.outsideTools || s.erasing || s.settling || s.requests.size || this.waitingRequests(s).length || this.openCalls(s).length || this.runningJobs(s).length) {
				throw new Error("Can't move while work is unfinished");
			}
			const target = s.branch().find((e) => e.id === entryId);
			if (!target) {
				if (s.entries.has(entryId)) throw Object.assign(new Error("Target is not a quiescent entry on the current branch"), { code: "conflict" });
				throw Object.assign(new Error("Unknown move target"), { code: "not_found" });
			}
			if (target.turnId && target.kind !== "turnEnd") throw Object.assign(new Error("Move target is inside a turn"), { code: "conflict" });
			s.moving = true;
			let journal: { point: string; undo: string } | undefined;
				const previous = s.position;
			const outOfReach: string[] = [];
			try {
				if (options.rewind) {
					const env = await this.environmentFor(s);
					if (!env || !(env.keepsPoints?.(this.projectOf(s)) ?? env.points) || !env.restore || !env.save || !env.hasPoint) throw new Error("This environment cannot rewind");
					const branch = s.branch();
					const at = branch.findIndex((e) => e.id === entryId);
					if (at < 0) throw new Error("Rewind needs an entry on the current branch");
					const after = branch.slice(at + 1);
					if (after.some((e) => e.kind === "jobStarted" || e.kind === "harness.jobStarted" || e.kind === "jobEnded")) throw new Error("Cannot rewind past a job");
					for (const e of after) {
						if (e.kind !== "toolStarted" || !e.toolCallId) continue;
						const data = e.data as { call?: ToolCall; openWorld?: boolean } | undefined;
						const start = branch.find((start) => start.kind === "turnStart" && e.turnId && e.turnId === start.turnId);
						const tool = data?.call?.name;
						const definition = (start?.data as TurnSnapshot | undefined)?.tools?.find((t) => t.name === tool)
							?? (tool ? this.findTool(s, tool)?.definition : undefined);
						if (data?.openWorld ?? true) outOfReach.push(e.toolCallId);
					}
					if ([...this.sessions.values()].some((other) => other !== s && other.meta.project === s.meta.project)) throw Object.assign(new Error("Another open session uses the project"), { code: "conflict" });
					const points = after.filter((e) => e.kind === "turnStart" || (e.kind === "toolStarted" && !e.turnId))
						.map((e) => (e.data as { point?: string } | undefined)?.point);
					for (const point of points) if (!point || !await env.hasPoint(point)) {
						throw Object.assign(new Error("Saved point not found in this environment"), { code: "conflict" });
					}
					if (points.length) {
						journal = { point: points[0]!, undo: await env.save() };
						await this.commit(s, [{ kind: "position", writer, actorId: options.actorId, modelVisible: false, data: { to: entryId, restore: journal } }]);
						await this.completeRewind(s, entryId, previous, journal, false);
					}
				}
				if (!journal) await this.commit(s, [{ kind: "position", writer, actorId: options.actorId, modelVisible: false, data: { to: entryId } }]);
				const provider = this.providerFor(s);
				if (provider?.supports.keepsState === true) await provider.discardState?.(s.id).catch((e) => this.problem(writer, "discard provider state on move", e));
				this.emit(s.id, "position.moved", { to: entryId }, writer);
				return outOfReach.length ? { outOfReach: [...new Set(outOfReach)] } : {};
			} finally { s.moving = false; }
		});
	}

	private async completeRewind(s: Session, to: string | null, previous: string | null, restore: { point: string; undo: string }, undoing: boolean): Promise<void> {
		const move = (target: string | null, intent?: typeof restore) => this.commit(s, [{ kind: "position", writer: "harness", modelVisible: false, data: { to: target, ...(intent ? { restore: intent } : {}) } }]);
		const env = await this.environmentFor(s);
		if (!env?.restore || !env.hasPoint || !(env.keepsPoints?.(this.projectOf(s)) ?? env.points)) { s.suspended = true; throw new Error("Rewind environment unavailable"); }
		const verify = async (point: string) => {
			try {
				if (!await env.hasPoint!(point)) throw new Error("Cannot verify ownership of rewind point");
			} catch (error) { s.suspended = true; throw error; }
		};
		await verify(restore.point);
		const check = () => this.use<HistoryStore>("history-store")?.checkWriter?.(s.id);
		try {
			check();
			await env.restore(restore.point);
		} catch (error) {
			if (undoing) { s.suspended = true; throw error; }
			try {
				check();
				await verify(restore.undo);
				await move(previous, { point: restore.undo, undo: restore.point });
				check();
				await env.restore(restore.undo);
				await move(previous);
			} catch (failure) { s.suspended = true; throw failure; }
			throw Object.assign(new Error("Rewind failed; original point restored", { cause: error }), { code: "conflict" });
		}
		try { await move(to); }
		catch (error) { s.suspended = true; throw error; }
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
		const report: ErasureReport = { erased: [], pending: [], outOfReach: [], erasedPairs: [], pendingPairs: [] };
		const heldCopies = new Set<Session>();
		try {
			// Take every lease before erasing anything. These acquisitions never wait for a writer.
			for (const session of targets.keys()) {
				if (session.running || this.runningJobs(session).length || session.erasing || session.moving) throw new Error("Cannot erase while affected work is running");
				session.erasing = true;
				guarded.push(session);
				if (!session.ephemeral) {
					if (!store?.erase) throw new Error("Erasure is not supported by this history store");
					if (!this.sessions.has(session.id)) {
						try { await store.openForWriting(session.id); }
						catch (error) {
							if ((error as { code?: string }).code !== "held" && !/open for writing/.test(String(error))) throw error;
							heldCopies.add(session);
							continue;
						}
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
				if (heldCopies.has(session)) {
					report.pending.push(...entryIds);
					if (this.actorRights(session, actorId).includes("watch")) report.pendingPairs.push(...entryIds.map((id) => ({ sessionId: session.id, id })));
					else if (!report.outOfReach.includes("copies in other sessions")) report.outOfReach.push("copies in other sessions");
					continue;
				}
				try {
					const inputKeys = entryIds.flatMap((id) => {
						const e = session.entries.get(id);
						const d = e?.data as { key?: string; submittedBy?: string; delegatedBy?: string } | undefined;
						const inputId = e && inputIdOf(e);
						return e?.kind === "inputAccepted" && inputId && d?.key ? [{ inputId, key: d.key, actorId: e.actorId, submittedBy: d.submittedBy ?? d.delegatedBy ?? e.actorId }] : [];
					});
					const reservations = [...new Map(inputKeys.map((k) => [k.inputId, k])).values()];
					await this.commit(session, [{ kind: "erasure", writer, actorId, modelVisible: false, data: { entryIds, ...(reservations.length ? { inputKeys: reservations } : {}) } }]);
					if (!session.ephemeral) await store!.erase!(session.id, entryIds);
					report.erased.push(...entryIds);
					if (session === s || this.actorRights(session, actorId).includes("watch")) report.erasedPairs.push(...entryIds.map((id) => ({ sessionId: session.id, id })));
					else if (!report.outOfReach.includes("copies in other sessions")) report.outOfReach.push("copies in other sessions");
					session.recent.length = 0;
				} catch (error) {
					report.pending.push(...entryIds);
					if (session === s || this.actorRights(session, actorId).includes("watch")) report.pendingPairs.push(...entryIds.map((id) => ({ sessionId: session.id, id })));
					else if (!report.outOfReach.includes("copies in other sessions")) report.outOfReach.push("copies in other sessions");
					this.problem(writer, "local erasure", error);
					continue;
				}
				for (const provider of this.useAll<Provider>("provider").filter((p) => p.supports.keepsState === true)) {
					try {
						const remote = await provider.discardState?.(session.id, { erase: true, entryIds });
						if (!provider.discardState) report.outOfReach.push(`Copies held by ${provider.id}`);
						report.pending.push(...(remote?.pending ?? []));
						report.outOfReach.push(...(remote?.outOfReach ?? []));
					} catch (error) { report.pending.push(...entryIds); this.problem(writer, `erase at ${provider.id}`, error); }
				}
				this.emit(session.id, "entries.erased", { count: ids.size }, writer, { actorId });
			}
		} finally {
			for (const session of guarded) session.erasing = false;
			for (const id of acquired) await store!.close(id);
		}
		if (report.erased.length) report.outOfReach.push("Output already delivered and copies beyond the agent");
		return { ...report, pending: [...new Set(report.pending)] };
	}

	// ---------- authority ----------

	/** Authority only narrows: a granted actor can do no more than whoever grants it. */
	private async join(s: Session, actor: Actor, grantedBy: string, writer: string): Promise<void> {
		this.requireAuthority(s, grantedBy, "grant");
		const beyond = actor.authority.filter((a) => !ALL_AUTHORITY.includes(a) || !this.rightsOf(s, grantedBy).includes(a));
		if (beyond.length) throw Object.assign(new Error(`${grantedBy} can't grant ${beyond.join(", ")}`), { code: "forbidden" });
		await this.commit(s, [actorJoined(actor, writer, grantedBy)]);
		await this.hooks.observe("session.join", { sessionId: s.id, actorId: actor.id, actor, grantedBy });
		this.emit(s.id, "session.joined", { actor }, writer, { actorId: actor.id });
		this.closeUnanswerable(s);
	}

	private requireAuthority(s: Session, actorId: string, authority: Authority): void {
		const actor = s.actors.get(actorId);
		if (!actor || !this.rightsOf(s, actorId).includes(authority)) {
			throw Object.assign(new Error(`Actor ${actorId} may not ${authority}`), { code: "forbidden" });
		}
	}

	private withinLimits(s: Session, right: Authority): boolean {
		const tenant = s.tenant === undefined ? undefined : this.tenants.get(s.tenant);
		return ALL_AUTHORITY.includes(right) && (right === "administer" || s.limit === null || s.limit.includes(right)) &&
			(s.tenant === undefined || tenant?.rights.includes(right) === true);
	}

	private actorRights(s: Session, actorId: string): Authority[] {
		const allowed = (s.actors.get(actorId)?.authority ?? []).filter((right) => this.withinLimits(s, right));
		if (!s.meta.parentSessionId) return allowed;
		const parent = this.sessions.get(s.meta.parentSessionId);
		const link = s.order.map((id) => s.entries.get(id)!).find((e) => e.kind === "harness.parentAuthority");
		const work = link?.data as { actors?: string[]; jobs?: string[] } | undefined;
		return allowed.filter((right) => parent
			? this.workRights(parent, work?.actors ?? [], work?.jobs).includes(right)
			: right === "watch");
	}

	private actorForJob(s: Session, jobs?: Set<string>): string | undefined {
		return s.order.map((id) => s.entries.get(id)!).find((e) => e.kind === "jobStarted" && e.jobId && jobs?.has(e.jobId))?.actorId;
	}

	private workRights(s: Session, actors: Iterable<string>, jobs: Iterable<string> = []): Authority[] {
		const owners = [...actors].map((id) => this.actorRights(s, id));
		const recordedJobs = [...jobs].map((jobId) => {
			const start = s.order.map((id) => s.entries.get(id)!).find((e) => e.jobId === jobId && e.kind === "jobStarted");
			const kept = s.jobs.get(jobId) ?? (start && this.readJob(s, start));
			return { rights: kept?.rights ?? ["watch"], ancestors: [...new Set([...(kept?.actors ?? []), ...(kept?.job.actorId ? [kept.job.actorId] : [])])].map((id) => this.actorRights(s, id)) };
		});
		return ALL_AUTHORITY.filter((right) => this.withinLimits(s, right) &&
			owners.every((owner) => owner.includes(right)) &&
			recordedJobs.every((job) => job.rights.includes(right) && job.ancestors.every((owner) => owner.includes(right))));
	}

	private rightsOf(s: Session, actorId: string): Authority[] {
		const context = this.turnAuthority.getStore();
		return context?.sessionId === s.id
			? this.workRights(s, [actorId, ...context.actors], context.jobs)
			: this.actorRights(s, actorId);
	}

	private setLimit(s: Session, rights: Authority[] | null, actorId: string, writer: string): Promise<void> {
		return this.admit(s, async () => {
			this.requireAuthority(s, actorId, "administer");
			const effective = (s.actors.get(actorId)?.authority ?? []).filter((r) => s.tenant === undefined || this.tenants.get(s.tenant)?.rights.includes(r));
			if ((rights ?? ALL_AUTHORITY).some((right) => !effective.includes(right))) throw Object.assign(new Error("A limit cannot give a right the administrator lacks"), { code: "forbidden" });
			await this.commit(s, [{ kind: "limit", writer, actorId, modelVisible: false, data: { rights: rights === null ? null : [...new Set(rights)] } }]);
			this.closeUnanswerable(s);
		});
	}

	private async tenantInfo(s: Session): Promise<TenantInfo> {
		const tenant = s.tenant === undefined ? undefined : this.tenants.get(s.tenant);
		if (tenant?.tokens === undefined) return { tenant: s.tenant ?? null, rights: tenant?.rights ?? null, tokens: null };
		const store = this.use<HistoryStore>("history-store");
		const other = await Promise.all((await store?.list() ?? [])
			.filter(({ id }) => !this.sessions.has(id)).map(async ({ id }) => (await store!.load(id)).entries));
		const histories = [...other, ...[...this.sessions.values()].filter((session) => session.tenant === s.tenant)
			.map((session) => session.order.map((id) => session.entries.get(id)!))];
		// Count each turn once even across branches and forks. For an interrupted or running turn,
		// the committed responses are the usage that has not made it into a turnEnd yet.
		const ends = new Map<string, Usage>();
		const responses = new Map<string, HistoryEntry>();
		for (const entries of histories) {
			if ((entries.find((e) => e.kind === "tenant")?.data as { tenant?: string } | undefined)?.tenant !== s.tenant) continue;
			for (const e of entries) {
				if (!e.turnId || e.erased) continue;
				if (e.kind === "turnEnd") {
					const usage = (e.data as { usage?: Usage }).usage;
					if (usage) ends.set(e.turnId, usage);
				} else if (e.kind === "response") responses.set(e.id, e);
			}
		}
		let used = [...ends.values()].reduce((n, u) => n + tokenCount(u), 0);
		for (const e of responses.values()) {
			if (!ends.has(e.turnId!) && e.message?.role === "assistant") used += tokenCount(e.message.usage);
		}
		return { tenant: s.tenant!, rights: tenant.rights, tokens: { budget: tenant.tokens, used } };
	}

	private async tenantBudgetReached(s: Session): Promise<boolean> {
		if (s.tenant === undefined || this.tenants.get(s.tenant)?.tokens === undefined) return false;
		const { tokens } = await this.tenantInfo(s);
		return !!tokens && tokens.used >= tokens.budget;
	}

	// ---------- input and turns ----------

	private async input(sessionId: string, options: InputOptions): Promise<InputReceipt & { handled?: boolean; output?: string }> {
		const s = this.session(sessionId);
		if (s.erasing) throw new Error("Erasure is in progress");
		const right = options.when === "propose" ? "propose" : "input";
		if (options.startedBy?.kind !== "job") {
			this.requireAuthority(s, options.actorId, right);
			if (options.delegatedBy) this.requireAuthority(s, options.delegatedBy, right);
		}
		const scoped = options.key && inputKeyScope(options.key, options.actorId, options.delegatedBy);
		if (scoped) {
			if (s.erasedKeys.has(scoped)) return { duplicate: true, erased: true } as InputReceipt;
			const earlier = s.keys.get(scoped);
			if (earlier) return { ...earlier, duplicate: true };
		}
		let content = typeof options.content === "string" ? [text(options.content)] : options.content;
		const typed = textOf(content).trim();
		if (options.when !== "propose" && !options.delegatedBy && options.startedBy?.kind !== "job" && typed.startsWith("/") && this.commandTable.has(/^\/(\S+)/.exec(typed)?.[1] ?? "")) {
			const output = await this.runCommand(sessionId, typed, options.actorId);
			const receipt = { inputId: this.newId(), taken: "now" as const, handled: true, output: output ?? undefined };
			if (scoped) s.keys.set(scoped, receipt);
			return receipt;
		}
		const transformed = await this.hooks.transform("input", { sessionId, content, actorId: options.actorId, when: options.when ?? "now" },
			(before, after) => {
				if (!Array.isArray(after.value?.content) || after.value.sessionId !== before.sessionId || after.value.when !== before.when || after.value.actorId !== before.actorId) {
					throw new Error("An input hook may change only content");
				}
			});
		if (s.erasing) throw new Error("Erasure is in progress");
		if (transformed.stopped) {
			let output: string | void = undefined;
			const command = transformed.command;
			if (command !== undefined) {
				if (right !== "input") throw Object.assign(new Error("A proposal cannot run a command"), { code: "forbidden" });
				if (options.delegatedBy) this.requireAuthority(s, options.delegatedBy, "input");
				output = await this.runCommand(sessionId, command, options.actorId);
			}
			const receipt = { inputId: this.newId(), taken: "now" as const, handled: true, ...(output === undefined ? {} : { output }) };
			if (scoped) s.keys.set(scoped, receipt);
			return receipt;
		}
		content = transformed.value.content;
		const queued: QueuedInput = {
			id: this.newId(), content, actorId: options.actorId, when: options.when ?? "now", key: options.key,
			resultShape: options.resultShape,
			startedBy: options.startedBy ?? { kind: "actor", id: options.actorId }, kind: options.kind ?? "input", sources: options.sources, delegatedBy: options.delegatedBy,
		};
		return this.admit(s, async () => {
			if (queued.startedBy.kind !== "job") {
				this.requireAuthority(s, queued.actorId, right);
				if (queued.delegatedBy) this.requireAuthority(s, queued.delegatedBy, right);
			}
			if (scoped && s.erasedKeys.has(scoped)) return { duplicate: true, erased: true } as InputReceipt;
			const earlier = scoped && s.keys.get(scoped);
			if (earlier) return { ...earlier, duplicate: true };
			return this.acceptInput(s, queued);
		});
	}

	/** Serialize receipts, release and cancellation for a session. */
	private admit<T>(s: Session, work: () => Promise<T>): Promise<T> {
		const run = s.admitting.then(work);
		s.admitting = run.catch(() => undefined);
		return run;
	}

	private async acceptInput(s: Session, q: QueuedInput): Promise<InputReceipt> {
		if (s.closed || s.closing || s.suspended || s.erasing || s.moving) throw new Error("Session cannot take input right now");
		if (this.rejectUnknownModel && q.startedBy.kind === "actor" && q.when !== "propose" && s.settings.model != null) {
			await this.providerFor(s)?.refreshModels?.();
			if (!this.modelAccess(s)) throw Object.assign(new Error("The selected model is not offered"), { code: "invalid_request" });
		}
		const steer = q.when === "steer" && this.runtime()?.supports.inputDuringTurn === true && !s.running?.steeringClosed;
		const taken = q.when === "propose" ? "proposed" : !s.isBusy() && !s.reopening && !s.followUps.length ? "now" : steer && !s.reopening ? "inTurn" : "after";
		await this.commit(s, [{
			kind: "inputAccepted", writer: "harness", modelVisible: false, actorId: q.actorId, inputId: q.id, sources: q.sources,
			jobId: q.startedBy.kind === "job" ? q.startedBy.id : undefined,
			data: { inputId: q.id, key: q.key, when: q.when, ...(q.startedBy.kind === "job" && !q.releasedBy ? { parked: q.when === "propose" } : {}), content: q.content, releasedBy: q.releasedBy, submittedBy: q.delegatedBy, taken },
		}]);
		const receipt: InputReceipt = { inputId: q.id, taken };
		if (q.when !== "propose") {
			if (taken === "now") this.startTurn(s, q);
			else (taken === "inTurn" ? s.steering : s.followUps).push(q);
		}
		this.emit(s.id, "input.accepted", { inputId: q.id, taken }, "harness", { actorId: q.actorId });
		return receipt;
	}

	private releaseInput(s: Session, inputId: string, when: Exclude<InputTiming, "propose">, actorId: string, declined?: boolean): Promise<InputReceipt> {
		return this.admit(s, async () => {
			this.requireAuthority(s, actorId, "input");
			const q = s.proposals.get(inputId);
			if (!q) throw new Error(`No proposed input ${inputId}`);
			const receipt = declined
				? (await this.handBack(s, [q], "declined"), { inputId, taken: "handedBack" as const })
				: await this.acceptInput(s, { ...q, when, releasedBy: actorId });
			s.proposals.delete(inputId);
			return receipt;
		});
	}

	private withdrawProposal(s: Session, id: string, actorId: string, delegatedBy?: string): Promise<void> {
		return this.admit(s, async () => {
			const q = s.proposals.get(id);
			if (!q) throw new Error(`No proposed input ${id}`);
			if (!s.actors.has(actorId) || (delegatedBy && !s.actors.has(delegatedBy))) throw new Error("Actor is not part of this session");
			if (q.actorId !== actorId) {
				this.requireAuthority(s, actorId, "input");
				if (delegatedBy) this.requireAuthority(s, delegatedBy, "input");
			}
			await this.handBack(s, [q], "withdrawn");
		});
	}

	private async handBack(s: Session, queued: QueuedInput[], reason: string): Promise<void> {
		const inputIds = queued.filter((q) => s.admissions.has(q.id)).map((q) => q.id);
		if (inputIds.length) await this.commit(s, inputIds.map((inputId) => ({ kind: "inputHandedBack", writer: "harness", modelVisible: false, inputId, data: { inputId, reason } })));
		for (const q of queued) this.emit(s.id, "input.withdrawn", { inputId: q.id, content: q.content, reason }, "harness");
	}

	private withdraw(sessionId: string, inputId: string): QueuedInput | undefined {
		const s = this.session(sessionId);
		for (const queue of [s.steering, s.followUps]) {
			const i = queue.findIndex((q) => q.id === inputId);
			if (i >= 0) {
				const [q] = queue.splice(i, 1);
				void this.handBack(s, [q], "withdrawn").catch((e) => this.problem("harness", "withdraw input", e));
				return q;
			}
		}
		return undefined;
	}

	/** Cancel the running turn. Its jobs keep running. Queued input is handed back. */
	private async cancel(sessionId: string): Promise<QueuedInput[]> {
		const s = this.session(sessionId);
		const { handedBack, running } = await this.admit(s, async () => {
			const handedBack = [...s.steering, ...s.followUps];
			s.steering = [];
			s.followUps = [];
			const running = s.running;
			const recorded = this.handBack(s, handedBack, "cancelled");
			running?.abort.abort();
			for (const r of [...s.requests.values()]) r.resolve({ requestId: r.request.id, declined: true, actorId: "harness", reason: "cancelled" });
			await recorded;
			return { handedBack, running };
		});
		await running?.done;
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
		const writer = this.use<HistoryStore>("history-store")?.writerSignal?.(s.id);
		const signal = writer ? AbortSignal.any([abort.signal, writer]) : abort.signal;
		const done = body(signal, turnId)
			.catch((error) => this.problem("harness", "turn", error))
			.finally(() => {
				s.running = undefined;
				this.startQueued(s);
			});
		s.running = { turnId, abort, done };
		return done;
	}

	private startQueued(s: Session): void {
		if (s.running || s.reopening || s.closed || s.closing || s.suspended) return;
		const next = [...s.steering, ...s.followUps];
		s.steering = [];
		s.followUps = next.slice(1);
		if (next[0]) this.startTurn(s, next[0]);
	}

	private async runTurn(s: Session, queued: QueuedInput, turnId: string, signal: AbortSignal): Promise<void> {
		const continuing = queued.continueCalls ? this.openCalls(s).filter((c) => queued.continueCalls!.includes(c.id)) : undefined;
		const continuesTurnId = continuing ? s.branch().findLast((e) => e.kind === "turnEnd" && (e.data as { result?: TurnOutcome["result"] } | undefined)?.result?.openToolCalls?.some((id) => queued.continueCalls!.includes(id)))?.turnId : undefined;
		if (queued.continueCalls && !continuing?.length) return; // already settled
		const runtime = this.runtime();
		const ref = parseModel(s.settings.model);
		const model: ModelAccess | undefined = this.modelAccess(s, ref) ?? (ref ? {
			model: { ...ref, contextWindow: 0, maxOutput: 0, reasoning: false, input: ["text"] },
			supports: { keepsState: false, runsTools: false },
			request: async () => ({ role: "assistant", content: [], stop: "failed", error: { kind: "other", message: `Model ${ref.provider}/${ref.id} is not offered` } }),
		} : undefined);
		const settings = this.turnSettings(s, model?.model);
		const modelTools = s.settings.modelTools;
		const tools = this.toolDefinitions(s).filter((t) => (!t.callers || t.callers.includes("model")) &&
			(modelTools == null || (Array.isArray(modelTools) && modelTools.includes(t.name))));
		const resultShape = queued.resultShape ?? s.settings.resultShape as Record<string, unknown> | undefined;
		let point: string | undefined;
		let contributions: { system?: string; context?: ContentPart[] }[] = [];
		let failure: string | undefined;
		let limited = false;
		try {
			limited = await this.tenantBudgetReached(s);
			if (!limited && !signal.aborted) {
				const env = await this.environmentFor(s);
				if (env?.save && (env.keepsPoints?.(this.projectOf(s)) ?? env.points)) point = await env.save();
				contributions = await this.hooks.collect("turn.before", { sessionId: s.id, turnId, input: queued.content });
			}
		} catch (error) { failure = String(error); }
		const context = contributions.flatMap((c) => c.context ?? []);
		const snapshot: TurnSnapshot = {
			model: ref ?? null,
			system: contributions.map((c) => c.system).filter(Boolean).join("\n\n"), tools, settings,
			...(context.length ? { context } : {}),
		};
		const state: TurnState = { ...snapshot, sources: new Map(), actors: new Set(inputActors(queued)), jobs: new Set([...(queued.authorityJobs ?? []), ...(queued.startedBy.kind === "job" ? [queued.startedBy.id] : [])]) };
		await this.commit(s, [
			{ kind: "turnStart", writer: "harness", modelVisible: false, turnId, continuesTurnId, actorId: queued.actorId, data: { ...snapshot, startedBy: queued.startedBy, resultShape, point, ...(continuing ? { authorityActors: inputActors(queued), authorityJobs: queued.authorityJobs } : {}) } },
			...(continuing ? [] : [this.inputEntry(s, queued, turnId)]),
		]);
		this.emit(s.id, "turn.started", { startedBy: queued.startedBy }, "harness", { turnId });
		let outcome: TurnOutcome;
		if (limited) outcome = this.tenantLimitOutcome();
		else if (failure) outcome = this.failedOutcome(failure);
		else if (!runtime) outcome = this.failedOutcome("No Runtime is loaded");
		else if (!model) outcome = this.failedOutcome("No model is selected, or its Provider is not loaded");
		else {
			try {
				const input = {
					sessionId: s.id, turnId, startedBy: queued.startedBy, model: this.turnModel(s, turnId, state, model),
					settings, resultShape,
				};
				const host = this.runtimeHost(s, turnId, state, resultShape);
				outcome = continuing ? await runtime.continueOpenCalls(input, host, signal, continuing) : await runtime.runTurn(input, host, signal);
			} catch (error) {
				outcome = this.failedOutcome(error instanceof Error ? error.message : String(error));
			}
		}
		await this.finishTurn(s, turnId, outcome, state, signal, resultShape);
	}

	private async finishTurn(s: Session, turnId: string, outcome: TurnOutcome, state?: TurnState, signal?: AbortSignal, resultShape?: Record<string, unknown>): Promise<void> {
		// The process stopped: the turn is interrupted, not ended. Nothing is recorded or announced here;
		// reopening the session finds the turn and hands it to the Runtime.
		if (s.suspended || this.use<HistoryStore>("history-store")?.writerSignal?.(s.id)?.aborted) return;
		if (state?.toolResultError && outcome.outcome.kind !== "limit" && outcome.outcome.kind !== "cancelled") {
			outcome = { ...outcome, outcome: { kind: "failed", error: state.toolResultError }, result: { openToolCalls: [] } };
		}
		const responses = s.order.map((id) => s.entries.get(id)!)
			.filter((e) => e.turnId === turnId && e.kind === "response" && e.message?.role === "assistant");
		if (responses.length && (state?.tenantLimit || outcome.outcome.kind === "failed" || outcome.outcome.kind === "cancelled")) {
			// A Runtime whose callback failed may have lost its in-memory usage.
			const recorded = responses.reduce((usage, e) => addUsage(usage, e.message?.role === "assistant" ? e.message.usage : undefined), zeroUsage());
			if (tokenCount(recorded) > tokenCount(outcome.usage)) outcome = { ...outcome, usage: recorded };
		}
		if (signal?.aborted && outcome.outcome.kind !== "completed") outcome = { ...outcome, outcome: { kind: "cancelled" } };
		else if (outcome.outcome.kind !== "cancelled" && (state?.tenantLimit || (responses.length > 0 && await this.tenantBudgetReached(s)))) {
			outcome = { ...outcome, outcome: { kind: "limit", limit: "tenantTokens" } };
		}
		if (outcome.outcome.kind === "completed" && resultShape) {
			const reason = shapeViolation(resultShape, outcome.result.value);
			if (reason !== undefined) {
				await this.commit(s, [{ kind: "resultFeedback", writer: "harness", turnId, modelVisible: true, data: { reason } }]);
				outcome = { ...outcome, outcome: { kind: "failed", error: reason }, result: { ...outcome.result, value: undefined } };
			}
		}
		// Committed dispositions survive a lost or invalid Runtime outcome.
		const branch = s.branch();
		const pending = pendingToolCalls(branch, turnId, s.order.map((id) => s.entries.get(id)!));
		const cancelled = outcome.outcome.kind === "cancelled";
		const open = new Set(cancelled ? [] : pending);
		outcome = { ...outcome, result: { ...outcome.result, openToolCalls: [...open] } };
		if (cancelled && pending.length) {
			const drafts = pending.map((id): EntryDraft => {
				const disposition = branch.findLast((e) => e.kind === "toolPending" && e.turnId === turnId && e.toolCallId === id);
				const offer = branch.find((e) => e.kind === "response" && e.message?.role === "assistant" && e.message.content.some((p) => isToolCall(p) && p.id === id));
				const call = offer?.message?.content.filter(isToolCall).find((p) => p.id === id);
				return { kind: "toolResult", writer: "harness", modelVisible: true, turnId, stepId: disposition?.stepId, toolCallId: id,
					message: { role: "toolResult", toolCallId: id, toolName: call?.name ?? "", content: [text("Cancelled while waiting for an answer")], isError: true },
					data: { status: "cancelled" } };
			});
			await this.commit(s, drafts);
		}
		for (const request of this.recordedOpenRequests(s).filter((r) => r.turnId === turnId && !s.requests.has(r.id) && !s.lateAnswers.has(r.id) && !open.has(r.toolCallId ?? ""))) {
			const answer = { requestId: request.id, actorId: "harness", declined: true, reason: outcome.outcome.kind === "cancelled" ? "cancelled" : "noLongerAnswerable" };
			await this.recordAnswer(s, request, answer, s.order.map(id => s.entries.get(id)!).find(e => e.kind === "inputRequest" && e.requestId === request.id)?.stepId);
			this.emitAnswer(s, request, answer);
		}
		const sources = s.branch().filter((e) => e.turnId === turnId && (e.kind === "response" || e.kind === "toolResult")).map((e) => e.id);
		await this.commit(s, [{ kind: "turnEnd", writer: "harness", modelVisible: false, turnId, sources, data: { outcome: outcome.outcome, result: outcome.result, usage: outcome.usage } }]);
		if (!state?.endedHook) await this.hooks.observe("turn.end", { sessionId: s.id, turnId, outcome: outcome.outcome, result: outcome.result });
		this.emit(s.id, "turn.ended", outcome, "harness", { turnId });
		if (open.size) this.maybeContinueOpenCalls(s);
	}

	private async resumeTurn(s: Session, interrupted: InterruptedTurn, startedBy: QueuedInput["startedBy"], signal: AbortSignal, snapshot?: Partial<TurnSnapshot> & { resultShape?: Record<string, unknown> }): Promise<void> {
		const turnId = interrupted.turnId;
		const runtime = this.runtime();
		const model = this.modelAccess(s, snapshot?.model);
		if (!runtime || !model) {
			const pending = new Set(pendingToolCalls(s.branch(), turnId, s.order.map((id) => s.entries.get(id)!)));
			await this.endInterruptedTurn(s, { turnId, calls: interrupted.calls.filter((c) => !pending.has(c.id)) });
			await this.finishTurn(s, turnId, this.failedOutcome("The process stopped during the turn"), undefined, signal);
			return;
		}
		const branch = s.branch();
		const state: TurnState = {
			model: model.model, system: snapshot?.system ?? "", context: snapshot?.context, tools: snapshot?.tools ?? this.toolDefinitions(s),
			settings: snapshot?.settings ? { ...snapshot.settings, reasoning: lowerReasoning(snapshot.settings.reasoning, model.model) } : this.turnSettings(s, model.model),
			sources: new Map(), actors: new Set(this.recordedTurnActors(branch, turnId)),
			jobs: new Set(this.recordedTurnJobs(branch, turnId)),
		};
		const kept = s.order.map((id) => s.entries.get(id)!);
		const pending = new Set(pendingToolCalls(branch, turnId, kept));
		const calls = interrupted.calls.filter((c) => !pending.has(c.id));
		let outcome: TurnOutcome;
		try {
			const restored = restoreAnsweredStep(branch, turnId, kept);
			const eligible = calls.filter((c) => {
				const offer = branch.find((e) => e.kind === "modelRequest" && e.stepId === c.stepId && !e.erased);
				return runtime.supports.continuesAfterRestart && !restored?.lastStep.decision && !c.started && this.findTool(s, c.name) &&
					(offer?.data as { tools?: string[] } | undefined)?.tools?.includes(c.name) && this.workRights(s, [...state.actors], state.jobs).includes("tools");
			});
			await this.endInterruptedTurn(s, { turnId, calls: calls.filter((c) => !eligible.includes(c)) });
			outcome = await runtime.resumeTurn(
				{ sessionId: s.id, turnId, startedBy, model: this.turnModel(s, turnId, state, model), settings: state.settings, resultShape: snapshot?.resultShape },
				this.runtimeHost(s, turnId, state, snapshot?.resultShape),
				signal,
				{ turnId, calls: eligible, ...(restored ? { lastStep: restored.lastStep } : {}) },
			);
		} catch (error) {
			outcome = this.failedOutcome(error instanceof Error ? error.message : String(error));
		}
		if (!s.suspended) {
			const keptNow = s.order.map((id) => s.entries.get(id)!);
			const terminal = new Set(keptNow.filter((e) => e.kind === "toolResult").map((e) => e.toolCallId));
			const open = new Set(pendingToolCalls(s.branch(), turnId, keptNow));
			await this.endInterruptedTurn(s, { turnId, calls: interrupted.calls.filter((c) => !terminal.has(c.id) && !open.has(c.id)) });
		}
		await this.finishTurn(s, turnId, outcome, state, signal, snapshot?.resultShape);
	}

	private recordedTurnActors(branch: HistoryEntry[], turnId: string): string[] {
		return branch.flatMap((e) => {
			if (e.turnId !== turnId || e.erased || (e.kind !== "input" && e.kind !== "turnStart")) return [];
			const d = e.data as { startedBy?: QueuedInput["startedBy"]; releasedBy?: string; delegatedBy?: string; authorityActors?: string[] } | undefined;
			if (e.jobId || d?.startedBy?.kind === "job") return [];
			const actor = e.actorId ?? (d?.startedBy?.kind === "actor" ? d.startedBy.id : undefined);
			return [actor, d?.releasedBy, d?.delegatedBy, ...(d?.authorityActors ?? [])].filter((id): id is string => typeof id === "string");
		});
	}

	private recordedTurnJobs(branch: HistoryEntry[], turnId: string): string[] {
		return branch.flatMap((e) => {
			if (e.turnId !== turnId || e.kind !== "turnStart" || e.erased) return [];
			const d = e.data as { startedBy?: QueuedInput["startedBy"]; authorityJobs?: string[] } | undefined;
			return d?.startedBy?.kind === "job" ? [d.startedBy.id] : d?.authorityJobs ?? [];
		});
	}

	private turnSettings(s: Session, model?: ModelInfo): TurnSettings {
		return { maxSteps: s.settings.maxSteps as number | undefined, reasoning: lowerReasoning(s.settings.reasoning, model), maxOutput: s.settings.maxOutput as number | undefined };
	}

	private tenantLimitOutcome(): TurnOutcome {
		return { outcome: { kind: "limit", limit: "tenantTokens" }, result: { openToolCalls: [] }, entries: [], usage: zeroUsage() };
	}

	private inputEntry(s: Session, q: QueuedInput, turnId: string): EntryDraft {
		const jobId = q.startedBy.kind === "job" ? q.startedBy.id : undefined;
		const sources = jobId ? s.order.filter((id) => { const e = s.entries.get(id)!; return e.jobId === jobId && e.kind === "jobEnded"; }) : undefined;
		return {
			kind: "input", writer: "harness", modelVisible: true, turnId, actorId: q.actorId, jobId, inputId: q.id, sources: [...(sources ?? []), ...(q.sources ?? [])],
			message: { role: "user", content: q.content }, data: { inputId: q.id, key: q.key, releasedBy: q.releasedBy, delegatedBy: q.delegatedBy, authorityActors: q.authorityActors },
		};
	}

	private failedOutcome(error: string): TurnOutcome {
		return { outcome: { kind: "failed", error }, result: { openToolCalls: [] }, entries: [], usage: zeroUsage() };
	}

	private runtimeHost(s: Session, turnId: string, state: TurnState, resultShape?: Record<string, unknown>): RuntimeHost {
		const withAuthority = <T>(fn: () => T): T => this.turnAuthority.run({ sessionId: s.id, actors: state.actors, jobs: state.jobs }, fn);
		return {
			newId: async () => this.newId(),
			callActor: () => state.actors.values().next().value ?? this.actorForJob(s, state.jobs),
			prepareStep: async ({ stepId, usage }) => {
				if (state.tenantLimit || await this.tenantBudgetReached(s)) { state.tenantLimit = true; throw turnLimit("tenantTokens"); }
				const attempts = s.order.map((id) => s.entries.get(id)!).filter((e) => e.turnId === turnId && e.kind === "modelRequest" && !(e.data as { auxiliary?: boolean })?.auxiliary).length;
				if (state.settings.maxSteps !== undefined && attempts >= state.settings.maxSteps) throw turnLimit("steps");
				const model = this.modelAccess(s, state.model);
				const branch = s.branch();
				const lastAttempt = branch.findLastIndex((e) => e.turnId === turnId && e.kind === "modelRequest" && !(e.data as { auxiliary?: boolean })?.auxiliary);
				const feedback = branch.slice(lastAttempt + 1).filter((e) => !e.erased && e.turnId === turnId && e.kind === "resultFeedback");
				const request: ModelRequest = {
					systemPrompt: state.system, messages: s.modelMessages(branch, turnId), tools: state.tools, providerTools: "none",
					settings: { reasoning: state.settings.reasoning, maxOutput: state.settings.maxOutput },
				};
				const payload = { sessionId: s.id, turnId, stepId, usage, model: model?.model, history: s.branch(), request };
				const transformed = (await withAuthority(() => this.hooks.transform("step.before", payload))).value.request;
				if (!Array.isArray(transformed?.tools) || transformed.tools.some(t => !request.tools.some(offered => isDeepStrictEqual(offered, t)))) throw new Error("step.before cannot widen the tool offer");
				const prepared: ModelRequest = feedback.length ? { ...transformed, messages: [...transformed.messages,
					...feedback.map((e): ModelMessage => ({ role: "user", content: [text((e.data as { reason: string }).reason)] }))] } : transformed;
				// Hooks may copy or transform messages, so conservatively name their visible sources.
				state.sources.set(stepId, [...new Set([...branch.filter((e) => (e.modelVisible && e.kind !== "resultFeedback") || e.kind === "summary" || (e.kind === "turnStart" && e.turnId === turnId && state.context?.length)), ...feedback].map((e) => e.id))]);
				return prepared;
			},
			hook: async (name, payload) => {
				if (name === "turn.end") {
					if (state.endedHook || s.suspended) return null as never;
					state.endedHook = true;
					if (state.toolResultError && payload.outcome?.kind !== "cancelled" && payload.outcome?.kind !== "limit") {
						payload = { ...payload, outcome: { kind: "failed", error: state.toolResultError }, result: {} };
					}
					if ((state.tenantLimit || await this.tenantBudgetReached(s)) && payload.outcome?.kind !== "cancelled") payload = { ...payload, outcome: { kind: "limit", limit: "tenantTokens" } };
					const openToolCalls = payload.outcome?.kind === "cancelled" ? [] :
						pendingToolCalls(s.branch(), turnId, s.order.map((id) => s.entries.get(id)!));
					payload = { ...payload, result: { ...payload.result, openToolCalls } };
				}
				if (name === "step.after") {
					if (state.toolResultError) throw new Error(state.toolResultError);
					if (state.stepAfterRunning) throw new Error("Step gate is in progress");
					state.stepAfterRunning = true;
					try {
						const restored = restoreAnsweredStep(s.branch(), turnId, s.order.map((id) => s.entries.get(id)!));
						if (!restored || restored.lastStep.stepId !== payload.stepId || !isDeepStrictEqual(restored.response.message, payload.response)) throw new Error("No matching answered step");
						if (await this.tenantBudgetReached(s)) state.tenantLimit = true;
						const value = { sessionId: s.id, turnId, stepId: payload.stepId, response: restored.response.message };
						let decision = restored.lastStep.decision;
						if (decision === undefined) {
							const gate = await withAuthority(() => this.hooks.gate("step.after", value));
							decision = gate.refused !== undefined ? { refuse: gate.refused } : gate.pending !== undefined ? { refuse: "Invalid pending step decision" } : null;
							await this.commit(s, [{ kind: "modular-agent.stepAfter", writer: "harness", turnId, stepId: payload.stepId,
								modelVisible: false, data: { decision }, sources: [restored.response.id] }]);
						}
						return { value, ...(decision === null ? {} : { refused: decision.refuse }) } as never;
					} finally { state.stepAfterRunning = false; }
				}
				const scope = { ...payload, sessionId: s.id, turnId };
				if (name === "tool.after") {
					const { result, error } = await withAuthority(() => this.toolAfter(s, scope));
					if (error) state.toolResultError ??= error.message;
					return { ...scope, result };
				}
				if (name === "turn.result") scope.shape = resultShape;
				const violation = name === "turn.result" && resultShape ? shapeViolation(resultShape, scope.result?.value) : undefined;
				const result = violation ? { value: scope, refused: violation } : name === "tool.before" && payload.call
					? await withAuthority(() => this.toolGate(scope))
					: await withAuthority(() => this.hooks.run(name, scope));
				if (name === "turn.result" && typeof result?.refused === "string") {
					await this.commit(s, [{ kind: "resultFeedback", writer: "harness", turnId, modelVisible: true, data: { reason: result.refused } }]);
				}
				if (name === "model.failed" && result?.retry) {
					const provider = this.providerFor(s, state.model);
					if (provider?.supports.keepsState === true) await provider.discardState?.(s.id);
				}
				return result;
			},
			runToolCall: (call, signal) => withAuthority(() => this.executeTool(s, call, signal, turnId, state)),
			definition: async (name) => this.findTool(s, name)?.definition,
			registration: (name) => {
				const found = this.findTool(s, name);
				return found && { source: { plugin: found.plugin, toolSource: found.source.id }, definition: found.definition };
			},
			history: async (options) => options?.all ? s.order.map((id) => s.entries.get(id)!) : s.branch(),
			record: async (draft) => {
				if (draft.kind === "turnStart" || draft.kind === "turnEnd") {
					return s.branch().find((e) => e.turnId === turnId && e.kind === draft.kind)
						?? { ...draft, id: turnId, turnId, sessionId: s.id, time: this.now(), parentId: s.position };
				}
				const modelSources = draft.kind === "response" ? [
					...(state.sources.get(draft.stepId ?? "") ?? []),
					...s.branch().filter((e) => e.kind === "modelRequest" && e.turnId === turnId && e.stepId === draft.stepId).map((e) => e.id),
				] : [];
				const callSources = draft.kind === "toolResult" && draft.toolCallId ? s.branch()
					.filter((e) => e.kind === "toolStarted" && e.toolCallId === draft.toolCallId
						|| e.message?.role === "assistant" && e.message.content.some((p) => isToolCall(p) && p.id === draft.toolCallId))
					.map((e) => e.id) : [];
				const sources = [...new Set([...(draft.sources ?? []), ...modelSources, ...callSources])];
				return (await this.commit(s, [{ ...draft, turnId, sources }]))[0];
			},
			takeSteering: (final = false) => this.admit(s, async () => {
				const items = s.steering.splice(0);
				if (final && !items.length && s.running?.turnId === turnId) s.running.steeringClosed = true;
				if (!items.length) return [];
				for (const q of items) for (const id of inputActors(q)) state.actors.add(id);
				return this.commit(s, items.map((q) => this.inputEntry(s, q, turnId)));
			}),
			hasSteering: async () => s.steering.length > 0,
			report: (type, data, ids) => { if (type !== "model.output") this.emit(s.id, type, data, "runtime", { turnId, ...ids }); },
		};
	}

	// ---------- models ----------

	private turnModel(s: Session, turnId: string, state: TurnState, model: ModelAccess): ModelAccess {
		return { ...model, request: async (request, options) => {
			return this.turnAuthority.run({ sessionId: s.id, actors: state.actors, jobs: state.jobs }, async () => {
				options.signal.throwIfAborted();
				if (state.tenantLimit || await this.tenantBudgetReached(s)) { state.tenantLimit = true; throw turnLimit("tenantTokens"); }
				const stepId = options.stepId ?? [...state.sources.keys()].at(-1) ?? this.newId();

				const scope = { sessionId: s.id, provider: model.model.provider, model: { provider: model.model.provider, id: model.model.id } };
				const safeToRepeat = model.supports.safeToRepeat === true || (model.supports.keepsState === false && model.supports.runsTools === false);
				const check = async () => {
					options.signal.throwIfAborted();
					if (await this.tenantBudgetReached(s)) { state.tenantLimit = true; throw turnLimit("tenantTokens"); }
					options.signal.throwIfAborted();
					this.use<HistoryStore>("history-store")?.checkWriter?.(s.id);
				};
				const prepareDispatch = async () => {
					await check();
					const input = { ...scope, request };
					const prepared = options.exactReplay ? input : (await this.hooks.transform("provider.request", input)).value;
					if (!prepared || !isDeepStrictEqual(prepared.model, scope.model) || prepared.provider !== scope.provider || prepared.sessionId !== scope.sessionId ||
						!Array.isArray(prepared.request?.tools) || prepared.request.tools.some((tool) => !request.tools.some((offered) => isDeepStrictEqual(offered, tool))) ||
						!isDeepStrictEqual(prepared.request.providerTools, request.providerTools)) throw new Error("Invalid provider.request transform");
					await check();
					// A hook sees readable context. Restore opaque data only to unmodified,
					// unambiguously matched messages belonging to the selected Provider.
					const originals = options.exactReplay ? [] : modelView(s.branch(), turnId, scope.provider)
						.map(message => ({ message, readable: withoutProviderData(message) }));
					const readable = options.exactReplay ? [] : prepared.request.messages.map(withoutProviderData);
					const unchanged = readable.length === originals.length && readable.every((message, i) => isDeepStrictEqual(message, originals[i].readable));
					const dispatched = options.exactReplay ? prepared.request : { ...prepared.request,
						messages: unchanged ? originals.map(({ message }) => message) : readable.map(message => {
							if (message.role !== "assistant") return message;
							const matches = originals.filter(candidate => isDeepStrictEqual(candidate.readable, message));
							return matches.length === 1 ? matches[0].message : message;
						}),
					};
					const [intent] = await this.commit(s, [{
						kind: "modelRequest", writer: "harness", turnId, stepId, modelVisible: false,
						data: { model: scope.model, safeToRepeat, tracksStepAfter: true, tools: prepared.request.tools.map((t) => t.name), ...(safeToRepeat ? { request: dispatched } : {}) },
						sources: state.sources.get(stepId),
					}]);
					try { await check(); }
					catch (error) {
						if (intent && !s.suspended && !this.use<HistoryStore>("history-store")?.writerSignal?.(s.id)?.aborted) {
							await this.commit(s, [{ kind: "response", writer: "harness", turnId, stepId, modelVisible: false,
								message: { role: "assistant", stop: "aborted", content: [] }, sources: [intent.id], data: { recovery: true } }]);
						}
						throw error;
					}
					options.onEffectiveRequest?.(prepared.request);
					return dispatched;
				};
				let observed = Promise.resolve();
				const onEvent = (event: import("./types.js").ModelStreamEvent) => {
					observed = observed.then(() => this.hooks.observe("provider.piece", { ...scope, turnId, stepId, piece: structuredClone(event) }));
					this.emit(s.id, "model.output", event, "harness", { turnId, stepId });
					options.onEvent?.(event);
				};
				try {
					if (model.prepareOnWire) return await model.request(request, { ...options, prepareDispatch, onEvent });
					const finalRequest = await prepareDispatch();
					const message = await model.request(finalRequest, { ...options, requestPrepared: true, onEvent });
					await this.hooks.observe("provider.response", { ...scope, message: withoutProviderData(message) });
					return message;
				} finally { await observed; this.emit(s.id, "model.streamEnd", {}, "harness", { turnId, stepId }); }
			});
		} };
	}

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
			prepareOnWire: provider.prepareOnWire,
			request: async (request, options) => {
				const available = provider.prepareOnWire ? true : await provider.available?.().catch(() => false);
				options.signal.throwIfAborted();
				if (available === false) return { role: "assistant", stop: "failed", content: [],
					error: { kind: "credentials", message: "Provider is not available" } };
				return provider.request(ref, request, { ...options, sessionId: s.id });
			},
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

	private findTool(s: Session | undefined, name: string): { plugin: string; source: ToolSource; definition: ToolDefinition } | undefined {
		for (const { plugin, impl } of this.caps.get("tool-source") ?? []) {
			const source = impl as ToolSource;
			const definition = source.tools(s?.id).find((t) => t.name === name && !this.replacedFor(plugin, `tool:${t.name}`));
			if (definition) return { plugin, source, definition };
		}
		return undefined;
	}

	private toolDefinitions(s?: Session, applyLegacyFilter = true): ToolDefinition[] {
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
		return applyLegacyFilter && allowed ? out.filter((t) => allowed.includes(t.name)) : out;
	}

	/** Run one tool call. Hook points are applied by whoever owns the operation. */
	private async executeTool(s: Session, call: ToolCall, signal: AbortSignal, turnId?: string, state?: TurnState,
		nested?: { depth: number; registration: NonNullable<ReturnType<Harness["findTool"]>>; approval: unknown }): Promise<ToolResult | (ToolPending & { callId: string })> {
		const found = this.findTool(s, call.name);
		if (s.erasing) return { callId: call.id, status: "refused", content: [text("Erasure is in progress")] };
		if (!found) return { callId: call.id, status: "failed", content: [text(`Unknown tool: ${call.name}`)] };
		const violation = shapeViolation(found.definition.parameters, call.input);
		if (violation) return { callId: call.id, status: "failed", content: [text(`Invalid input: ${violation}`)] };
		if (signal.aborted) return { callId: call.id, status: "notStarted", content: [text("Cancelled before it ran")] };
		if (nested && !sameRegistration(found, nested.registration)) return { callId: call.id, status: "refused", content: [text("Registration changed before dispatch")] };
		if (!nested && state && !state.tools.some((t) => t.name === call.name)) return { callId: call.id, status: "refused", content: [text("Tool was not offered to this turn")] };
		// The "tools" right: every actor the work belongs to must let tools run for it (docs/bindings/data.md#actors).
		const owners = state ? [...state.actors] : call.actorId ? [call.actorId] : [];
		call = { ...call, actorId: call.actorId ?? owners[0] ?? this.actorForJob(s, state?.jobs) };
		const allowed = () => (!state || owners.length > 0 || state.jobs.size > 0) && this.workRights(s, owners, state?.jobs).includes("tools");
		const refused = () => ({ callId: call.id, status: "refused" as const, content: [text(`No "tools" right: ${owners.join(", ")}`)] });
		if (!allowed()) return refused();
		const env = await this.environmentFor(s);
		const safeToRepeat = found.definition.hints?.safeToRepeat === true && env?.containment === "strong";
		const point = !nested && !turnId && env?.save && (env.keepsPoints?.(this.projectOf(s)) ?? env.points) ? await env.save() : undefined;
		const eligible = (current: ReturnType<Harness["findTool"]>) => allowed() && !s.erasing && !s.suspended &&
			sameRegistration(current, found) && (!nested || nested.approval === s.settings.approval);
		if (!eligible(this.findTool(s, call.name))) return refused();
		if (signal.aborted) return { callId: call.id, status: "notStarted", content: [text("Cancelled before it ran")] };
		this.use<HistoryStore>("history-store")?.checkWriter?.(s.id);
		const [start] = await this.commit(s, [{ kind: "toolStarted", writer: "harness", modelVisible: false, turnId, actorId: call.actorId ?? owners[0] ?? this.actorForJob(s, state?.jobs), toolCallId: call.id, stepId: call.stepId,
			sources: nested ? s.branch().filter(e => e.kind === "modular-agent.nestedCall" && e.toolCallId === call.id).map(e => e.id) : undefined,
			data: { call: { ...call, actorId: call.actorId ?? owners[0] ?? this.actorForJob(s, state?.jobs) }, source: { plugin: found.plugin, toolSource: found.source.id }, definition: found.definition, safeToRepeat, point, openWorld: found.definition.hints?.openWorld ?? true,
				authorizers: owners.map((actorId) => ({ sessionId: s.id, actorId })), rights: this.workRights(s, owners, state?.jobs) } }]);
		const current = this.findTool(s, call.name);
		if (!eligible(current)) return refused();
		this.use<HistoryStore>("history-store")?.checkWriter?.(s.id);
		if (signal.aborted) return { callId: call.id, status: "notStarted", content: [text("Cancelled before it ran")] };
		this.emit(s.id, "tool.started", { call }, found.source.id, { turnId, toolCallId: call.id, stepId: call.stepId });
		let asked = 0;
		const pendingQuestions: string[] = [];
		const children = new Set<Promise<ToolResult>>();
		const lifetime = new AbortController();
		let live = true;
		const check = () => {
			if (!live) throw Object.assign(new Error("There is no live parent"), { code: "invalid_request" });
			if (signal.aborted) throw Object.assign(new Error("The parent was cancelled"), { code: "cancelled" });
			if (!allowed() || s.erasing || s.suspended) throw Object.assign(new Error("The parent cannot run tools"), { code: "invalid_request" });
			this.use<HistoryStore>("history-store")?.checkWriter?.(s.id);
		};
		const drain = async () => {
			live = false;
			lifetime.abort();
			await Promise.allSettled(children);
		};
		try {
			const result = await this.toolWork.run(call, () => found.source.run(call, {
				sessionId: s.id,
				signal,
				call,
				jobs: { start: async (kind, detail, key) => {
					check();
					const job = this.startJob(s, { kind, detail, key, actors: owners, toolCallId: call.id }, found.plugin);
					await job.ready;
					return job;
				} },
				progress: (content) => {
					for (const part of content) this.emit(s.id, "tool.progress", { content: [part] }, found.source.id, { turnId, toolCallId: call.id });
				},
				environment: env,
				tools: this.runtime()?.supports.nestedToolCalls === true ? {
					list: async () => {
						check();
						return structuredClone(this.toolDefinitions(s, false).filter(t => !t.callers || t.callers.includes("plugin")));
					},
					call: async (name, input, askingSignal) => {
						check();
						if (typeof name !== "string" || !name || !input || typeof input !== "object" || Array.isArray(input)) {
							throw Object.assign(new Error("A tool name and input object are required"), { code: "invalid_request" });
						}
						const childSignal = AbortSignal.any([signal, lifetime.signal, ...(askingSignal ? [askingSignal] : [])]);
						if (childSignal.aborted) throw Object.assign(new Error("The callback was cancelled"), { code: "cancelled" });
						const work = this.callNested(s, call, name, structuredClone(input), childSignal, (nested?.depth ?? 0) + 1, turnId, state, start.id);
						children.add(work);
						try { return await work; } finally { children.delete(work); }
					},
				} : undefined,
				ask: (request, askingSignal) => {
					const n = ++asked;
					return this.ask(s, { ...request, toolCallId: call.id, key: request.key ?? `call:${call.id}:${n}` }, found.source.id, askingSignal ? AbortSignal.any([signal, askingSignal]) : signal)
						.then((answer) => { if (answer.pending) pendingQuestions.push(answer.requestId); return answer; });
				},
			}));
			await drain();
			if (isPending(result)) {
				if (nested) return { callId: call.id, status: "refused", content: [text("A nested call cannot be left open")] };
				if (!turnId || !pendingQuestions.length) return { callId: call.id, status: "failed", content: [text("No qualifying question for a pending result")] };
				await this.commit(s, [{ kind: "toolPending", writer: "harness", modelVisible: false, turnId, stepId: call.stepId, toolCallId: call.id, data: { requestIds: [...new Set(pendingQuestions)], toolStartedId: start.id } }]);
				this.emit(s.id, "tool.ended", { status: "open", reason: result.pending }, found.source.id, { turnId, toolCallId: call.id });
				return { callId: call.id, pending: result.pending };
			}
			const out: ToolResult = { ...result, callId: call.id };
			this.emit(s.id, "tool.ended", { status: out.status }, found.source.id, { turnId, toolCallId: call.id });
			return out;
		} catch (error) {
			await drain();
			const status = (error as { code?: string })?.code === "lost" ? "outcomeUnknown" : signal.aborted ? "cancelled" : "failed";
			const message = error instanceof Error ? error.message : String(error);
			this.emit(s.id, "tool.ended", { status }, found.source.id, { turnId, toolCallId: call.id });
			return { callId: call.id, status, content: [text(status === "cancelled" ? "Cancelled" : `Tool failed: ${message}`)] };
		}
	}

	/** Nested calls never use a model offer and are settled by the Harness, not the Runtime. */
	private async callNested(s: Session, parent: ToolCall, name: string, input: Record<string, unknown>,
		signal: AbortSignal, depth: number, turnId: string | undefined, state: TurnState | undefined, parentStart: string): Promise<ToolResult> {
		const call: ToolCall = { id: this.newId(), name, input, startedBy: "tool", parentCallId: parent.id, actorId: parent.actorId, stepId: parent.stepId };
		const scope = { turnId, stepId: call.stepId, actorId: call.actorId, toolCallId: call.id };
		const [intent] = await this.commit(s, [{ ...scope, kind: "modular-agent.nestedCall", writer: "harness", modelVisible: false, sources: [parentStart], data: { call } }]);
		const stop = (status: ToolResult["status"], reason: string): ToolResult => ({ callId: call.id, status, content: [text(reason)] });
		let registration = this.findTool(s, name);
		let executed = call;
		let result: ToolResult;
		let processingError: unknown;
		try {
			if (signal.aborted) result = stop("notStarted", "Cancelled before it ran");
			else if (depth > 8) result = stop("refused", "Nested tool call depth exceeds 8");
			else {
				// A replacement while a gate waits invalidates its answer. Limit churn so the child always settles.
				for (let pass = 0; ; pass++) {
					if (!registration || (registration.definition.callers && !registration.definition.callers.includes("plugin"))) {
						result = stop("refused", `Tool ${name} is not registered for plugin callers`); break;
					}
					const approval = s.settings.approval;
					const gate = await this.toolGate({ sessionId: s.id, turnId, call, definition: registration.definition }, signal);
					if (signal.aborted) { result = stop("notStarted", "Cancelled before it ran"); break; }
					if (gate.pending !== undefined) { result = stop("refused", "A nested call cannot be left open"); break; }
					const current = this.findTool(s, name);
					if (!sameRegistration(current, registration) || approval !== s.settings.approval) {
						if (pass >= 7) { result = stop("refused", "Registration kept changing"); break; }
						registration = current;
						continue;
					}
					if (gate.refused !== undefined) { result = stop("refused", gate.refused); break; }
					executed = gate.value.call;
					const ran = await this.executeTool(s, executed, signal, turnId, state, { depth, registration, approval });
					result = isPending(ran) ? stop("refused", "A nested call cannot be left open") : ran;
					break;
				}
			}
		} catch (error) {
			processingError = error;
			result = stop(signal.aborted ? "notStarted" : "failed", "Could not process the nested call");
		}
		await this.closeNestedQuestions(s, call.id);
		const after = await this.toolAfter(s, { sessionId: s.id, call: executed, result });
		result = after.result;
		processingError ??= after.error;
		await this.recordNestedResult(s, executed, turnId, result, intent?.id);
		if (processingError !== undefined) {
			this.problem("harness", "nested tool result", processingError);
			throw processingError;
		}
		return result;
	}

	private async recordNestedResult(s: Session, call: ToolCall, turnId: string | undefined, result: ToolResult, intent?: string): Promise<void> {
		await this.commit(s, [{ kind: "toolResult", writer: "harness", modelVisible: false, turnId, stepId: call.stepId,
			actorId: call.actorId, toolCallId: call.id, sources: intent ? [intent] : undefined,
			message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content, isError: result.status !== "completed" },
			data: { status: result.status, value: result.value, call } }]);
	}

	private async closeNestedQuestions(s: Session, callId: string): Promise<void> {
		for (const request of this.recordedOpenRequests(s).filter(r => r.toolCallId === callId)) {
			if (s.lateAnswers.has(request.id)) continue;
			const answer = { requestId: request.id, actorId: "harness", declined: true, reason: "noLongerAnswerable" };
			await this.recordAnswer(s, request, answer, s.order.map(id => s.entries.get(id)!).find(e => e.kind === "inputRequest" && e.requestId === request.id)?.stepId);
			s.waiting.delete(request.id);
			for (const viewer of this.viewersFor(s, request)) viewer.onInputRequestClosed?.(request.id);
			this.emit(s.id, "input.request.closed", answer, "harness", { turnId: request.turnId, toolCallId: callId });
		}
	}

	private async recoverNestedCalls(s: Session): Promise<void> {
		const entries = s.branch();
		const terminal = new Set(entries.filter(e => e.kind === "toolResult").map(e => e.toolCallId));
		const started = new Set(entries.filter(e => e.kind === "toolStarted").map(e => e.toolCallId));
		for (const e of entries.slice().reverse()) {
			if ((e.kind !== "modular-agent.nestedCall" && e.kind !== "toolStarted") || terminal.has(e.toolCallId)) continue;
			const call = (e.data as { call?: ToolCall } | undefined)?.call;
			if (!call || call.startedBy !== "tool" || !call.parentCallId) continue;
			terminal.add(call.id);
			await this.closeNestedQuestions(s, call.id);
			const dispatched = started.has(call.id);
			await this.recordNestedResult(s, call, e.turnId, { callId: call.id,
				status: dispatched ? "outcomeUnknown" : "notStarted", content: [text(interruptedNote(dispatched))] }, e.id);
		}
	}

	private async toolGate<T extends { call: ToolCall }>(payload: T, signal?: AbortSignal): Promise<GateResult<T>> {
		const { call } = payload;
		let changed = false;
		const pass = (p: T, second: boolean) => this.hooks.gate("tool.before", p, {
			invoke: (value, handler) => this.gateSignal.run(signal, () => this.toolWork.run(value.call, handler)),
			change: (before, after) => {
				const candidate = after?.call;
				if (!candidate || !isDeepStrictEqual({ ...call, input: {} }, { ...candidate, input: {} }) ||
					!candidate.input || typeof candidate.input !== "object" || Array.isArray(candidate.input)) {
					throw new Error("Tool gate changed the call identity or gave invalid input");
				}
				if (!isDeepStrictEqual(before.call.input, candidate.input)) {
					if (second) throw new Error("Tool gate changed the call again");
					changed = true;
				}
				return { ...before, call: { ...before.call, input: candidate.input } };
			},
		});
		const first = await pass(payload, false);
		return changed && first.refused === undefined && first.pending === undefined ? pass(first.value, true) : first;
	}

	/** A tool call a UI or plugin starts. The same checks apply. */
	private async callTool(s: Session, call: ToolCall): Promise<ToolResult> {
		if (s.moving || s.closed || s.suspended) throw new Error("Session cannot run tools right now");
		s.outsideTools++;
		try { return await this.callOutsideTurn(s, call); }
		finally { s.outsideTools--; }
	}

	private async callOutsideTurn(s: Session, call: ToolCall): Promise<ToolResult> {
		const definition = this.findTool(s, call.name)?.definition;
		const gate = definition?.callers && call.startedBy !== "tool" && !definition.callers.includes(call.startedBy as "ui" | "plugin")
			? { refused: `${call.name} can't be called by a ${call.startedBy}`, value: { call } }
			: await this.toolGate({ sessionId: s.id, call, definition });
		let result: ToolResult;
		if (gate.refused) result = { callId: call.id, status: "refused", content: [text(gate.refused)] };
		else {
			const ran = await this.executeTool(s, gate.value.call, new AbortController().signal);
			// Only a turn can carry an open call forward, so outside a turn it fails instead.
			result = isPending(ran) ? { callId: call.id, status: "failed", content: [text(`${call.name} can't wait for an answer outside a turn`)] } : ran;
		}
		const after = await this.toolAfter(s, { sessionId: s.id, call, result });
		result = after.result;
		await this.commit(s, [{ kind: "toolResult", writer: "harness", modelVisible: false, toolCallId: call.id, actorId: call.actorId, message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content, isError: result.status !== "completed" }, data: { status: result.status, value: result.value, call } }]);
		if (after.error) throw after.error;
		return result;
	}

	private async toolAfter(s: Session, payload: { sessionId: string; call: ToolCall; result: ToolResult }) {
		const { sessionId, call, result } = payload;
		try {
			const after = (await this.hooks.transform("tool.after", structuredClone({ sessionId, call, result }), (before, answer) => {
				const next = answer.value;
				const fixedFields = ({ result: { content: _content, value: _value, ...result }, ...rest }: typeof next) =>
					JSON.parse(JSON.stringify({ ...rest, result }));
				if (answer.stop || !Array.isArray(next?.result?.content) || !isDeepStrictEqual(fixedFields(before), fixedFields(next))) {
					throw new Error("tool.after may change only result content and value");
				}
			})).value.result;
			const startId = s.order.findLast(id => {
				const e = s.entries.get(id)!;
				return e.kind === "toolStarted" && e.toolCallId === call.id;
			});
			const start = startId && s.entries.get(startId);
			const shape = ((start || undefined)?.data as { definition?: ToolDefinition } | undefined)?.definition?.returns;
			const violation = after.status === "completed" && shape ? shapeViolation(shape, after.value) : undefined;
			if (violation) throw new Error(`Invalid tool output: ${violation}`);
			return { result: after };
		} catch (cause) {
			const error = cause instanceof Error ? cause : new Error(String(cause));
			this.problem("harness", "tool result", error);
			return { error, result: { callId: result.callId, status: result.status, content: [text("Tool result could not be processed")] } };
		}
	}

	// ---------- asking actors ----------

	private interfaces(): InterfaceCapability[] {
		return this.useAll<InterfaceCapability>("interface");
	}

	private presentActors(s: Session, request?: InputRequest): string[] {
		return [...new Set(this.interfaces().filter((i) => i.present?.(s.id, request) !== false)
			.flatMap((i) => [i.actorId, ...(i.presentActors?.(s.id) ?? [])]))].filter((id) => s.actors.has(id));
	}

	private mayAnswer(s: Session, request: InputRequest, actorId: string): boolean {
		const actor = s.actors.get(actorId);
		if (!actor) return false;
		if (request.answerers.length && !request.answerers.includes(actorId)) return false;
		return this.actorRights(s, actorId).includes(request.kind === "approval" ? "approve" : "answer");
	}

	/** Questions recorded on the current branch that have no answer and were not closed. */
	private hasAnswerer(s: Session, request: InputRequest): boolean {
		const candidates = request.kind === "approval" ? this.presentActors(s, request) : [...s.actors.keys()];
		return candidates.some(id => this.mayAnswer(s, request, id));
	}

	private closeUnanswerable(s: Session): void {
		for (const { request, resolve } of s.requests.values()) {
			if (!this.hasAnswerer(s, request)) {
				resolve({ requestId: request.id, actorId: "harness", declined: true, reason: "noLongerAnswerable" });
			}
		}
	}

	private recordedOpenRequests(s: Session): InputRequest[] {
		const branch = s.branch();
		const settled = new Set(s.order.map(id => s.entries.get(id)!).filter(e =>
			e.kind === "inputAnswer" || e.kind === "inputClosed" || e.kind === "secretAnswerAccepted").map(requestIdOf));
		return branch.filter(e => e.kind === "inputRequest" && !e.erased).map(readRequest).filter(r => !settled.has(r.id));
	}

	/** A recorded answer to the question with this key, if it can still be used. */
	private recordedAnswer(s: Session, draft: BoundRequest, approval?: ApprovalBinding): { request: InputRequest; answer?: Answer } | undefined {
		const branch = s.branch();
		const entry = [...branch].reverse().find((e) => e.kind === "inputRequest" && !e.erased && readRequest(e).key === draft.key);
		if (!entry) return undefined;
		const request = readRequest(entry);
		if (request.kind !== draft.kind || request.question !== draft.question || request.details !== draft.details
			|| JSON.stringify(request.options ?? []) !== JSON.stringify(draft.options ?? [])
			|| (request.credential ?? undefined) !== (draft.credential ?? undefined) || request.toolCallId !== draft.toolCallId) return undefined;
		if (approval?.call.startedBy === "tool") {
			const prior = entry.data as Partial<ApprovalBinding> | undefined;
			const exact = (value: unknown) => JSON.parse(JSON.stringify(value));
			if (!prior?.call || !prior.source || !prior.definition ||
				!isDeepStrictEqual(exact(approval), exact({ call: prior.call, source: prior.source, definition: prior.definition }))) return undefined;
		}
		const bound = (request as BoundRequest).boundCall;
		if (bound && !isDeepStrictEqual(bound, draft.boundCall)) return undefined;
		if (branch.some((e) => e.kind === "inputClosed" && (e.data as { requestId: string }).requestId === request.id)) return undefined;
		const answered = branch.find((e) => e.kind === "inputAnswer" && !e.erased && (e.data as { requestId: string }).requestId === request.id);
		if (!answered) return { request };
		const body = answered.data as Answer & { answer?: Answer };
		const answer = body.answer ?? body;
		if (request.kind === "secret" && (answer.reason === "restart" || !answer.declined &&
			!branch.some(e => !e.erased && e.kind === "secretAnswerAccepted" && e.requestId === request.id))) return undefined;
		// A secret's recorded answer holds only where it was stored, so it can be reused like any other.
		// A recorded allow counts only if whoever gave it may still answer.
		if (!answer.declined && !this.mayAnswer(s, request, answer.actorId)) return undefined;
		return { request, answer };
	}

	private secretStore() {
		const store = this.use<CredentialStore>("credential-store");
		return store?.stage && store.lookupStaged && store.activate && store.discard
			? store as CredentialStore & Required<Pick<CredentialStore, "stage" | "lookupStaged" | "activate" | "discard">> : undefined;
	}

	private secretScope(s: Session, requestId: string): SecretScope {
		return { deployment: resolve(this.home), sessionId: s.id, requestId };
	}

	private async recordAnswer(s: Session, request: InputRequest, answer: Answer, stepId?: string, acceptSecret = false): Promise<Answer> {
		const fields = { writer: "harness", modelVisible: false, turnId: request.turnId, stepId,
			requestId: request.id, toolCallId: request.toolCallId, actorId: answer.actorId };
		let kept = answer;
		if (request.kind === "secret" && !answer.declined) {
			if (acceptSecret) await this.commit(s, [{ ...fields, kind: "secretAnswerAccepted" }]);
			let outcome;
			try { outcome = await this.secretStore()!.activate(this.secretScope(s, request.id)); }
			catch { throw new Error("Could not confirm secret activation"); }
			kept = outcome === "activated" ? { requestId: request.id, actorId: answer.actorId, stored: request.credential }
				: { requestId: request.id, actorId: answer.actorId, declined: true, reason: "superseded" };
		}
		await this.commit(s, [{ ...fields, kind: "inputAnswer", data: kept }]);
		if (request.kind === "secret" && kept.declined) await this.discardSecret(s, request.id);
		return kept;
	}

	private async discardSecret(s: Session, requestId: string): Promise<void> {
		try { await this.secretStore()?.discard(this.secretScope(s, requestId)); }
		catch { throw new Error("Could not discard secret staging"); }
	}

	private async recoverSecrets(s: Session): Promise<void> {
		const entries = s.order.map(id => s.entries.get(id)!).filter(e => !s.copied.has(e.id));
		const decisions = new Map(entries.filter(e => e.kind === "secretAnswerAccepted").map(e => [e.requestId, e]));
		const answers = new Map(entries.filter(e => e.kind === "inputAnswer").map(e => [requestIdOf(e), e]));
		for (const entry of entries) {
			if (entry.kind !== "inputRequest" || entry.erased) continue;
			const request = readRequest(entry);
			if (request.kind !== "secret") continue;
			const answer = answers.get(request.id);
			if (answer) {
				if (answer.erased || (answer.data as Answer)?.declined) await this.discardSecret(s, request.id);
				continue;
			}
			const decision = decisions.get(request.id);
			if (decision?.actorId) {
				await this.recordAnswer(s, request, { requestId: request.id, actorId: decision.actorId }, entry.stepId);
			} else {
				// Do not let pre-decision staging win on reopen. If the Runtime asks again,
				// recordedAnswer ignores this closure and ask allocates a fresh identity.
				await this.recordAnswer(s, request, { requestId: request.id, actorId: "harness", declined: true, reason: "restart" }, entry.stepId);
			}
		}
	}

	private async deferTool(s: Session, turnId: string | undefined, question: InputRequestDraft, plugin: string) {
		const call = this.toolWork.getStore();
		if (!this.questionsOutlastTurns || !call || !turnId || turnId !== s.running?.turnId || call.startedBy !== "model" || question.kind === "approval") {
			return { refuse: "This call cannot wait for a late answer" };
		}
		const answer = await this.ask(s, { ...question, toolCallId: call.id, key: `gate:${call.id}:${plugin}:${question.key ?? "question"}`,
			timeLimitMs: 0, whenTimeLimit: "leaveOpen" }, plugin, s.running.abort.signal);
		if (!answer.pending) return answer.declined ? { refuse: answer.reason ?? "The gate question was declined" } : undefined;
		await this.commit(s, [{ kind: "toolPending", writer: "harness", modelVisible: false, turnId, stepId: call.stepId,
			toolCallId: call.id, data: { requestIds: [answer.requestId] } }]);
		return { pending: "Waiting for an answer to the gate" };
	}

	private async ask(s: Session, draft: BoundRequest, askedBy: string, signal?: AbortSignal): Promise<Answer> {
		const gateSignal = this.gateSignal.getStore();
		signal = signal && gateSignal ? AbortSignal.any([signal, gateSignal]) : signal ?? gateSignal;
		signal?.throwIfAborted();
		if (draft.whenTimeLimit === "leaveOpen" && !this.questionsOutlastTurns) throw Object.assign(new Error("Questions cannot outlast the turn"), { code: "not_supported" });
		const call = this.toolWork.getStore();
		if (call && call.id === draft.toolCallId) draft = { ...draft, boundCall: { name: call.name, input: call.input } };
		if (draft.kind === "secret" && (!draft.credential || !this.secretStore() ||
			this.useAll<Provider>("provider").some(p => p.id === draft.credential))) {
			return { requestId: "", declined: true, actorId: "harness", reason: "A secret needs a credential name and a credential store to keep it" };
		}
		let request: InputRequest = { ...draft, id: this.newId(), sessionId: s.id, askedBy, answerers: draft.answerers ?? [], turnId: s.running?.turnId };
		const stepId = call?.stepId ?? (draft.toolCallId ? s.order.map((id) => s.entries.get(id)!).findLast((e) => e.kind === "toolStarted" && e.toolCallId === draft.toolCallId)?.stepId : undefined);
		const registered = draft.kind === "approval" && call ? this.findTool(s, call.name) : undefined;
		const approval = registered && call ? { call, source: { plugin: registered.plugin, toolSource: registered.source.id }, definition: registered.definition } : undefined;
		let reopened = false;
		if (draft.key) {
			// Changed input or registration needs a new approval identity, not a replay of the old one.
			let key = approval?.call.startedBy === "tool" ? draft.key + ":" + approvalKey(approval) : draft.key;
			if (draft.kind === "secret") {
				const branch = s.branch();
				for (const entry of branch) {
					if (entry.kind !== "inputRequest" || entry.erased) continue;
					const prior = readRequest(entry);
					if (prior.kind === "secret" && prior.key === key && branch.some(e => e.kind === "inputAnswer" &&
						requestIdOf(e) === prior.id && (e.data as Answer | undefined)?.reason === "restart")) key += ":" + prior.id;
				}
			}
			draft = { ...draft, key };
			request = { ...request, key };
			const recorded = this.recordedAnswer(s, draft, approval);
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
		if (!reopened) {
			await this.commit(s, [{ kind: "inputRequest", writer: askedBy, modelVisible: false, turnId: request.turnId, stepId, requestId: request.id, toolCallId: request.toolCallId, data: { request: { ...request, answerable: viewers.length > 0 }, ...approval } }]);
		}
		if (!this.hasAnswerer(s, request)) {
			const approval = request.kind === "approval";
			const answer = { requestId: request.id, declined: true, actorId: "harness", reason: approval ? "refused" : "noLongerAnswerable" };
			await this.recordAnswer(s, request, answer, stepId);
			this.emitAnswer(s, request, answer);
			return approval ? { ...answer, reason: "No one present can answer" } : answer;
		}
		return new Promise<Answer>((resolve, reject) => {
			const cancel = () => void open.resolve({ requestId: request.id, declined: true, actorId: "harness", reason: "cancelled" });
			const open = {
				request,
				resolve: (answer: Answer) => {
					signal?.removeEventListener("abort", cancel);
					if (open.timer) clearTimeout(open.timer);
					s.requests.delete(request.id);
					s.lateAnswers.add(request.id);
					for (const i of viewers) i.onInputRequestClosed?.(request.id);
					if (s.suspended) { resolve({ ...answer, declined: true }); return Promise.resolve(); }
					const work = this.recordAnswer(s, request, answer, stepId, request.kind === "secret" && !answer.declined).then(kept => {
						this.emitAnswer(s, request, kept);
						s.lateAnswers.delete(request.id);
						resolve(kept);
					}, error => { reject(error); throw error; });
					void work.catch(error => this.problem("harness", "record answer", error));
					return work;
				},
				timer: undefined as NodeJS.Timeout | undefined,
			};
			if (request.timeLimitMs !== undefined) {
				open.timer = setTimeout(() => {
					if (request.kind === "approval" || request.whenTimeLimit !== "leaveOpen") return open.resolve({ requestId: request.id, declined: true, actorId: "harness", reason: "timeLimit" });
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
		return this.interfaces().filter((i) => i.present?.(s.id, request) !== false && (this.actorRights(s, i.actorId).includes("watch") || this.mayAnswer(s, request, i.actorId)));
	}

	/** Questions on the current branch that were left open past their turn and have no answer yet. */
	private waitingRequests(s: Session): InputRequest[] {
		const calls = new Set(this.openCalls(s).map((c) => c.id));
		return this.recordedOpenRequests(s).filter((r) => (s.waiting.has(r.id) || calls.has(r.toolCallId ?? "") || r.turnId !== s.running?.turnId)
			&& !s.requests.has(r.id) && !s.lateAnswers.has(r.id));
	}

	/** Answer a question left open past its turn. The answer is recorded, then the open calls carry on if they can. */
	private answerLate(s: Session, answer: Answer): { accepted: boolean; reason?: string; settled?: Promise<void> } {
		const request = this.waitingRequests(s).find((r) => r.id === answer.requestId);
		if (!request) return { accepted: false, reason: "The request is closed or can no longer be answered" };
		if (!this.mayAnswer(s, request, answer.actorId)) return { accepted: false, reason: `${answer.actorId} may not answer this request` };
		s.lateAnswers.add(request.id);
		const previous = s.settling ?? Promise.resolve();
		const work = previous.then(async () => {
			const kept = await this.recordAnswer(s, request, answer,
				s.order.map(id => s.entries.get(id)!).find(e => e.requestId === request.id)?.stepId,
				request.kind === "secret" && !answer.declined);
			s.lateAnswers.delete(request.id);
			for (const i of this.viewersFor(s, request)) i.onInputRequestClosed?.(request.id);
			this.emitAnswer(s, request, kept, true);
			s.waiting.delete(request.id);
			this.continueOpenCalls(s, kept);
		});
		s.settling = work.catch((error) => this.problem("harness", "late answer", error)).finally(() => {
			if (s.settling === tracked) s.settling = undefined;
		});
		const tracked = s.settling;
		return { accepted: true, settled: work };
	}

	/** Tool calls on the current branch that have no result and are not part of a running turn. */
	private openCalls(s: Session): InterruptedTurn["calls"] {
		const branch = s.branch();
		const kept = s.order.map((id) => s.entries.get(id)!);
		const results = new Set(kept.filter((e) => e.kind === "toolResult").map((e) => e.toolCallId));
		const continued = new Set(kept.filter((e) => e.kind === "turnStart").map((e) => e.continuesTurnId ?? (e.data as { continuesTurnId?: string } | undefined)?.continuesTurnId));
		const open = new Set(branch.flatMap((e) => e.kind === "turnEnd" && !e.erased && !continued.has(e.turnId) ? (e.data as { result?: TurnOutcome["result"] }).result?.openToolCalls ?? [] : []));
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
		const callIds = new Set(calls.map((c) => c.id));
		const branch = s.branch();
		const owners = new Set<string>();
		const jobs = new Set<string>();
		for (const e of branch) {
			if (!e.turnId || e.message?.role !== "assistant" || !e.message.content.some((p) => isToolCall(p) && callIds.has(p.id))) continue;
			for (const actorId of this.recordedTurnActors(branch, e.turnId)) owners.add(actorId);
			for (const jobId of this.recordedTurnJobs(branch, e.turnId)) jobs.add(jobId);
		}
		const queued: QueuedInput = {
			id: this.newId(), content: [], actorId: [...owners][0] ?? answer.actorId, authorityActors: [...owners], authorityJobs: [...jobs],
			when: "after", startedBy: { kind: "answer", id: answer.requestId }, kind: "continue", continueCalls: [...callIds],
		};
		if (s.isBusy()) {
			if (!s.followUps.some((q) => q.continueCalls)) s.followUps.push(queued);
		} else this.startTurn(s, queued);
	}

	private emitAnswer(s: Session, request: InputRequest, answer: Answer, late = false): void {
		const ids = { actorId: answer.actorId, toolCallId: request.toolCallId, turnId: request.turnId };
		if (answer.reason === "noLongerAnswerable") this.emit(s.id, "input.request.unanswerable", { requestId: request.id }, "harness", ids);
		if (answer.actorId !== "harness") this.emit(s.id, "input.request.answered", { requestId: request.id, declined: answer.declined ?? false }, "harness", ids);
		this.emit(s.id, "input.request.closed", { requestId: request.id, declined: answer.declined ?? false, value: answer.value, late }, "harness", ids);
	}

	private async submitAnswer(s: Session, answer: Answer): Promise<{ accepted: boolean; reason?: string }> {
		const find = () => s.requests.get(answer.requestId)?.request ?? this.waitingRequests(s).find(r => r.id === answer.requestId);
		const may = (request: InputRequest) => this.mayAnswer(s, request, answer.actorId) &&
			(!answer.delegatedBy || this.mayAnswer(s, { ...request, answerers: [] }, answer.delegatedBy));
		const request = find();
		if (!request || !may(request)) return { accepted: false };
		if (request.kind === "secret" && !answer.declined) {
			const store = this.secretStore();
			if (!store || !request.credential || typeof answer.value !== "string") return { accepted: false };
			const scope = { ...this.secretScope(s, request.id), credential: request.credential, actorId: answer.actorId };
			try {
				const staged = await store.stage(scope, answer.value);
				if (!staged) return { accepted: false };
				const receipt = await store.lookupStaged(scope);
				if (!receipt || receipt.receipt !== staged.receipt || !Object.entries(scope).every(([k, value]) => receipt[k as keyof typeof scope] === value)) {
					await this.discardSecret(s, request.id);
					return { accepted: false };
				}
			} catch { throw new Error("Could not stage the secret answer"); }
			if (!find() || !may(request)) {
				await this.discardSecret(s, request.id);
				return { accepted: false };
			}
			answer = { requestId: answer.requestId, actorId: answer.actorId, delegatedBy: answer.delegatedBy };
		}
		const open = s.requests.get(request.id);
		if (open) await open.resolve(answer);
		else {
			const accepted = this.answerLate(s, answer);
			if (!accepted.accepted) return accepted;
			await accepted.settled;
		}
		return { accepted: true };
	}

	private answer(s: Session, answer: Answer): { accepted: boolean; reason?: string } {
		const open = s.requests.get(answer.requestId);
		const request = open?.request ?? this.waitingRequests(s).find(r => r.id === answer.requestId);
		// Legacy local interfaces can submit asynchronously. ACP never carries secret values.
		if (request?.kind === "secret" && !answer.declined) {
			if (!this.mayAnswer(s, request, answer.actorId)) return { accepted: false };
			void this.submitAnswer(s, answer).catch(error => this.problem("harness", "secret answer", error));
			return { accepted: true };
		}
		if (!open) {
			const { accepted, reason } = this.answerLate(s, answer);
			return reason === undefined ? { accepted } : { accepted, reason };
		}
		if (!this.mayAnswer(s, open.request, answer.actorId)) return { accepted: false, reason: `${answer.actorId} may not answer this request` };
		open.resolve(answer); // the first accepted answer closes the request
		return { accepted: true };
	}

	// ---------- jobs ----------

	private workActors(s: Session): string[] {
		const context = this.turnAuthority.getStore();
		if (context?.sessionId === s.id) return [...new Set([...context.actors, ...[...context.jobs].flatMap((id) => {
			const actor = s.order.map((id) => s.entries.get(id)!).find((e) => e.kind === "jobStarted" && e.jobId === id)?.actorId;
			return actor ? [actor] : [];
		})])];
		const actorId = this.toolWork.getStore()?.actorId;
		return actorId ? [actorId] : [];
	}

	private startJob(s: Session, options: JobStart, plugin: string): JobHandle {
		if (s.moving || s.closing || s.closed || s.suspended || s.erasing) throw new Error("Session cannot start jobs right now");
		const current = [...this.workActors(s), ...(options.actors ?? [])];
		const actorId = current[0] ?? options.actorId ?? [...s.actors.keys()][0];
		const actors = [...new Set([actorId, ...current, options.actorId].filter((id): id is string => id !== undefined))];
		const context = this.turnAuthority.getStore();
		const rights = this.workRights(s, actors, context?.sessionId === s.id ? context.jobs : options.jobs);
		if (!actorId || !rights.includes("jobs")) throw new Error('Job requires the "jobs" right');
		const { key, detail } = options;
		if (key !== undefined) {
			const active = [...s.jobs.values()].find((r) => r.key === key && r.job.plugin === plugin);
			const id = active?.job.id ?? s.order.map((id) => s.entries.get(id)!).find((e) => e.kind === "jobStarted" && e.writer === plugin && !s.copied.has(e.id) && (e.data as { key?: string } | undefined)?.key === key)?.jobId;
			if (id) return { id, started: false, ready: active?.handle.ready ?? Promise.resolve(), finish: async () => {}, progress: () => {}, onCancel: () => {} };
		}
		const startEntryId = this.newId();
		const job: Job = { id: this.newId(), kind: options.kind, sessionId: s.id, plugin, actorId, turnId: s.running?.turnId, state: "running", usage: zeroUsage() };
		const ready = this.commit(s, [{
			id: startEntryId, kind: "jobStarted", writer: plugin, modelVisible: false, turnId: job.turnId,
			toolCallId: options.toolCallId ?? this.toolWork.getStore()?.id, jobId: job.id, actorId,
			data: { kind: job.kind, key, detail: detail ?? null, actors, rights },
		}]).then(() => this.emit(s.id, "job.started", { job }, plugin, { jobId: job.id }));
		void ready.catch((error) => { s.jobs.delete(job.id); this.problem(plugin, "record job", error); });
		return this.jobHandle(s, { job, key, detail, actors, rights }, startEntryId, ready);
	}

	private readJob(s: Session, e: HistoryEntry): KeptJob | undefined {
		if (!e.jobId || e.erased || s.copied.has(e.id)) return undefined;
		if (e.kind === "harness.jobStarted") return e.data as KeptJob;
		if (e.kind !== "jobStarted") return undefined;
		const data = e.data as Omit<KeptJob, "job"> & { kind: string };
		return { ...data, job: { id: e.jobId, kind: data.kind, sessionId: s.id, plugin: e.writer, actorId: e.actorId, turnId: e.turnId, state: "running", usage: zeroUsage() } };
	}

	private runningJobs(s: Session): KeptJob[] {
		const all = s.order.map((id) => s.entries.get(id)!);
		const ended = new Set(all.filter((e) => e.kind === "jobEnded" || e.kind === "harness.jobEnded").map((e) => e.jobId));
		const jobs = new Map<string, KeptJob>();
		for (const e of all) {
			const kept = this.readJob(s, e);
			if (kept && !ended.has(e.jobId)) jobs.set(kept.job.id, kept);
		}
		for (const [id, active] of s.jobs) if (!ended.has(id)) jobs.set(id, active);
		return [...jobs.values()];
	}

	private jobHandle(s: Session, kept: KeptJob, startEntryId?: string, ready: Promise<unknown> = Promise.resolve()): JobHandle {
		const { job } = kept;
		const plugin = job.plugin;
		const handle: JobHandle = {
			id: job.id, started: true, ready, startEntryId,
			progress: (content) => {
				if (!record.ending && !s.suspended && !s.closed) this.emit(s.id, "job.progress", { content: typeof content === "string" ? [text(content)] : content }, plugin, { jobId: job.id });
			},
			finish: (state, result, options) => {
				if (record.ending) return Promise.reject(new Error("Job already ended"));
				const work = async () => {
					await ready;
					if (s.closed || s.suspended) return;
					const content = typeof result === "string" ? [text(result)] : result;
					const outcome = state === "outcomeUnknown"
						? { kind: "failed", error: "Job outcome is unknown" }
						: { kind: state, error: options?.error };
					const report = options?.report !== false;
					await this.admit(s, async () => {
						if (report && s.closing) throw new Error("Cannot report to a closing session");
						const end: EntryDraft = { id: this.newId(), kind: "jobEnded", writer: plugin, modelVisible: false, jobId: job.id, sources: options?.sources, data: { outcome, result: content, report } };
						let queued: QueuedInput | undefined;
						const drafts = [end];
						if (report && !s.keys.has(`job:${job.id}`)) {
							if (!this.workRights(s, [], [job.id]).includes("input")) throw new Error('Job report requires the "input" right');
							queued = { id: this.newId(), actorId: job.actorId ?? "harness", when: this.jobReportsStartTurns ? "after" : "propose", key: `job:${job.id}`, kind: "input",
								startedBy: { kind: "job", id: job.id }, sources: [end.id!], content: content ?? [] };
							drafts.push({ kind: "inputAccepted", writer: "harness", modelVisible: false, inputId: queued.id, actorId: queued.actorId, jobId: job.id,
								sources: queued.sources, data: { inputId: queued.id, key: queued.key, content: queued.content, when: queued.when, taken: queued.when === "propose" ? "proposed" : "after", parked: queued.when === "propose" } });
						}
						await this.commit(s, drafts);
						job.state = state;
						job.result = content;
						this.emit(s.id, "job.ended", { state, result: content }, plugin, { jobId: job.id });
						if (queued?.when === "after") { s.followUps.push(queued); this.startQueued(s); }
					});
				};
				record.ending = work().catch((error) => { if (job.state === "running") record.ending = undefined; throw error; });
				return record.ending.finally(() => { if (job.state !== "running") s.jobs.delete(job.id); });
			},
			onCancel: (fn) => { record.cancel = fn; },
		};
		const record: import("./session.js").JobRecord = { ...kept, handle };
		s.jobs.set(job.id, record);
		return handle;
	}

	private async reportJob(s: Session, { job }: KeptJob, end: HistoryEntry): Promise<void> {
		const data = end.data as { result?: ContentPart[]; outcome: { kind: JobState } };
		const key = `job:${job.id}`;
		await this.admit(s, async () => {
			if (s.keys.has(key) || s.closed || s.closing || s.suspended) return;
			await this.acceptInput(s, {
				id: this.newId(), actorId: job.actorId ?? "harness", when: this.jobReportsStartTurns ? "after" : "propose", key, kind: "input",
				startedBy: { kind: "job", id: job.id }, sources: [end.id],
				content: data.result ?? [],
			});
		});
	}

	private async cancelJob(s: Session, jobId: string): Promise<void> {
		const kept = this.runningJobs(s).find(({ job }) => job.id === jobId);
		if (!kept) { await s.jobs.get(jobId)?.ending; return; }
		const handle = s.jobs.get(jobId)?.handle ?? this.jobHandle(s, kept);
		const record = s.jobs.get(jobId)!;
		if (record.cancelling) return record.cancelling;
		const cancel = async () => {
			if (record.ending) return record.ending;
			try {
				if (record.cancel) await record.cancel();
				else await this.jobCancels.get(kept.job.plugin)?.(jobId);
			} catch (error) { this.problem(kept.job.plugin, "cancel job", error); }
			if (record.ending) await record.ending;
			else await handle.finish("cancelled", undefined, { report: false });
		};
		record.cancelling = cancel();
		return record.cancelling;
	}

	// ---------- declarations ----------

	private recoveryPolicy() {
		const supports = this.runtime()?.supports;
		const input = supports?.queuedInputAfterRestart === "run" ? "run" : "handedBack";
		const jobs = supports?.queuedJobReportsAfterRestart ?? (supports?.queuedInputAfterRestart ? input : "run");
		return { input, jobs: jobs === "handedBack" ? "handedBack" : "run" };
	}

	declaration(s?: Session): Declaration {
		const runtime = this.runtime();
		const store = this.use<HistoryStore>("history-store");
		const provider = s ? this.providerFor(s) : undefined;
		const env = this.use<WorkingEnvironment>("working-environment");
		const recovery = this.recoveryPolicy();
		return {
			inputDuringTurn: runtime?.supports.inputDuringTurn === true,
			waitingThroughRestart: runtime?.supports.waitingThroughRestart === true && !!store && !s?.ephemeral,
			continuesAfterRestart: runtime?.supports.continuesAfterRestart === true,
			rewinding: env?.keepsPoints?.(s ? this.projectOf(s) : this.project) ?? env?.points === true,
			forking: !!store,
			keepsStateAtProvider: provider?.supports.keepsState === true,
			runsToolsAtProvider: provider?.supports.runsTools === true,
			liveSessions: provider?.supports.liveSessions === true,
			severalActors: true,
			sessionLimits: true,
			tenants: true,
			holdsOutput: this.hooks.raw("output").some(handler => handler.stream),
			outputBypassesAgent: false,
			startsTurnsUnasked: this.jobReportsStartTurns ? "when a job reports back" : "never",
			cancellingTurnCancelsJobs: false,
			pluginsDuringSession: false,
			erasure: s?.ephemeral ? true : !!store?.erase,
			inputKeys: true,
			portableSessions: true,
			nestedToolCalls: runtime?.supports.nestedToolCalls === true,
			mixedActorInput: "shared",
			erasureDuringTurn: "refused",
			questionsOutlastTurns: this.questionsOutlastTurns,
			queuedInputAfterRestart: recovery.input,
			...(recovery.jobs !== recovery.input ? { queuedJobReportsAfterRestart: recovery.jobs } : {}),
			movingWithUnfinishedWork: "refused",
			commandContainment: env?.containment ?? "none",
			confinesFiles: env?.confinesFiles === true,
			settingsDuringTurn: this.settingsDuringTurn ?? "nextTurn",
		};
	}
}

/** One recipient following a session, through the output gate. */
class Follower {
	private pending = 0;
	private disconnected = false;
	private held: AgentEvent[] = [];
	private streams = new Map<string, AgentEvent[]>();
	private chain: Promise<void> = Promise.resolve();
	constructor(
		private hooks: HookRegistry,
		readonly recipient: string,
		private raw: boolean,
		private listener: (event: AgentEvent) => unknown,
		private onError: (e: unknown) => void,
		private onLag?: () => void,
	) {}

	disconnect(): void {
		this.disconnected = true;
		this.held = [];
		this.streams.clear();
	}

	push(event: AgentEvent): void {
		if (this.disconnected) return;
		if (this.onLag && this.pending >= 1024) {
			if (event.type === "model.output" || event.type === "tool.progress") return;
			this.disconnect();
			this.onLag();
			return;
		}
		this.pending++;
		this.chain = this.chain.then(() => this.disconnected ? undefined : this.deliver(event)).catch(this.onError).finally(() => { this.pending--; });
	}

	/** Resolves once everything pushed so far has been delivered or blocked. */
	idle(): Promise<void> {
		return this.chain;
	}

	private async deliver(event: AgentEvent): Promise<void> {
		if (!this.raw && (event.type === "entry" || event.type === "entry.added")) {
			const entry = event.data as HistoryEntry;
			const data = entry.data as { request?: ModelRequest } | undefined;
			event = { ...event, data: { ...entry,
				...(entry.message ? { message: withoutProviderData(entry.message) } : {}),
				...(entry.kind === "modelRequest" && data?.request && Array.isArray(data.request.messages) ? { data: { ...data, request: {
					...data.request, messages: data.request.messages.map(withoutProviderData),
				} } } : {}),
			} };
		}
		const handlers = this.raw ? [] : this.hooks.raw("output");
		const modelEnd = event.type === "model.streamEnd";
		if (handlers.some((h) => h.stream)) {
			const stream = event.type === "model.output" || modelEnd
				? ["model", event.sessionId, event.turnId, event.stepId]
				: event.type === "tool.progress" || event.type === "tool.ended"
					? ["tool", event.sessionId, event.toolCallId] : undefined;
			if (stream) {
				const key = JSON.stringify(stream);
				const pieces = this.streams.get(key) ?? [];
				if (!modelEnd && event.type !== "tool.ended") {
					pieces.push(event);
					this.streams.set(key, pieces);
					return;
				}
				this.streams.delete(key);
				if (pieces.length) await this.gate(pieces, true, handlers);
			}
			if (!modelEnd) await this.gate([event], true, handlers);
			return;
		}
		const events = this.held.splice(0);
		if (!modelEnd) events.push(event);
		if (events.length) await this.gate(events, event.type !== "model.output", handlers);
	}

	private async gate(initial: AgentEvent[], final: boolean, handlers: ReturnType<HookRegistry["raw"]>): Promise<void> {
		let events = initial;
		for (const h of handlers) {
			const payload: OutputPayload = { sessionId: initial[0].sessionId, events, recipient: this.recipient, final };
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
		for (const e of events) if (!this.disconnected) await this.listener(e);
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

const STANDARD_ENTRY_KINDS = new Set("limit tenant actorJoined actorLeft setting inputAccepted inputHandedBack input turnStart modelRequest response toolStarted toolPending toolResult inputRequest secretAnswerAccepted inputAnswer resultFeedback modular-agent.stepAfter turnEnd summary position erasure jobStarted jobCleanupUnconfirmed jobEnded plugins".split(" "));

function copyForkPrefix(branch: HistoryEntry[], sessionId: string, makeId: () => string): HistoryEntry[] {
	const kept = branch.filter((e) => !e.erased && e.kind !== "position");
	const entries = new Map(kept.map((e) => [e.id, makeId()]));
	const associations = new Map<string, Map<string, string>>();
	const remap = (kind: string, id: string) => {
		const group = associations.get(kind) ?? new Map<string, string>();
		associations.set(kind, group);
		if (!group.has(id)) group.set(id, makeId());
		return group.get(id)!;
	};
	let parentId: string | null = null;
	return kept.map((old) => {
		const e: HistoryEntry = { ...structuredClone(old), id: entries.get(old.id)!, parentId, sessionId, sources: [old.id] };
		if (e.turnId) e.turnId = remap("turn", e.turnId);
		if (e.continuesTurnId) e.continuesTurnId = remap("turn", e.continuesTurnId);
		if (e.stepId) e.stepId = remap("step", e.stepId);
		if (e.toolCallId) e.toolCallId = remap("call", e.toolCallId);
		if (e.jobId) e.jobId = remap("job", e.jobId);
		if (e.inputId) e.inputId = remap("input", e.inputId);
		if (e.requestId) e.requestId = remap("request", e.requestId);
		if (e.message?.role === "assistant") for (const part of e.message.content) {
			if (isToolCall(part)) part.id = remap("call", part.id);
		}
		if (e.message?.role === "toolResult") e.message.toolCallId = remap("call", e.message.toolCallId);
		if (e.kind === "summary") {
			const data = e.data as { summary: string; summarizes?: string[] };
			data.summarizes = (data.summarizes ?? old.sources ?? []).flatMap((id) => entries.has(id) ? [entries.get(id)!] : []);
		}
		if (e.kind === "turnEnd") {
			const result = (e.data as { result: TurnOutcome["result"] }).result;
			result.openToolCalls = result.openToolCalls.map((id) => remap("call", id));
		}
		parentId = e.id;
		return e;
	});
}

/** Walk copy links to a fixed point, without following parentId (which is just position). */
function eraseCopies(origin: Session, ids: string[], sessions: Map<string, Session>): Map<Session, Set<string>> {
	const targets = new Map<Session, Set<string>>();
	const authority = (kind: string) => ["actorJoined", "actorLeft", "limit", "tenant", "grant", "authority.grant", "authority.revoke", "position", "erasure", "jobCleanupUnconfirmed"].includes(kind);
	const add = (session: Session, id: string) => {
		const e = session.entries.get(id);
		if (!e || targets.get(session)?.has(id)) return false;
		if (authority(e.kind) && !session.copied.has(e.id)) throw Object.assign(new Error("Records of authority cannot be erased"), { code: "forbidden" });
		if (!targets.has(session)) targets.set(session, new Set());
		targets.get(session)!.add(id);
		return true;
	};
	for (const id of ids) { if (!origin.entries.has(id)) throw Object.assign(new Error("Unknown erasure target"), { code: "not_found" }); add(origin, id); }
	const all = [...sessions.values()];
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
				if (targetsHere?.has(e.id) || authority(e.kind)) continue;
				const forkedFrom = session.copied.has(e.id) ? session.meta.forkedFrom : undefined;
				const links = forkedFrom ? e.sources?.some((id) => targets.get(sessions.get(forkedFrom.sessionId)!)?.has(id)) : e.sources?.some((id) => targetsHere?.has(id));
				const callCopy = e.toolCallId && calls.has(e.toolCallId);
				const turnResult = e.kind === "turnEnd" && erased.some((x) => x.turnId === e.turnId && ["response", "toolResult"].includes(x.kind));
				// A completed turn with an erased outcome must not look like an interrupted turn on reopen.
				const endedTurnStart = e.kind === "turnStart" && erased.some((x) => x.kind === "turnEnd" && x.turnId === e.turnId);
				const jobId = e.jobId ?? (e.data as { value?: { jobId?: string } } | undefined)?.value?.jobId;
				const jobCopy = jobId && erased.some((x) => x.jobId === jobId && ["jobStarted", "jobEnded", "harness.jobStarted", "harness.jobEnded"].includes(x.kind));
				const startedByCall = (e.kind === "harness.jobStarted" || e.kind === "jobStarted") && !e.toolCallId && erased.some((x) => x.turnId === e.turnId && x.kind === "toolStarted");
				// Older or foreign responses need not give sources. Earlier branch entries may all have been in the request.
				let ancestry = false;
				if (e.kind === "response" && !e.sources && erased.length) {
					const seen = new Set<string>();
					for (let id = e.parentId; id && !seen.has(id); id = session.entries.get(id)?.parentId ?? null) {
						if (targetsHere?.has(id)) { ancestry = true; break; }
						seen.add(id);
					}
				}
				const inputId = e.inputId ?? (e.data as { inputId?: string } | undefined)?.inputId;
				const takingInput = inputId && erased.some((x) => (x.inputId ?? (x.data as { inputId?: string } | undefined)?.inputId) === inputId);
				if (links || callCopy || turnResult || endedTurnStart || jobCopy || startedByCall || ancestry || takingInput) grew = add(session, e.id) || grew;
			}
		}
	}
	return targets;
}

const turnLimit = (limit: string) => Object.assign(new Error(`Turn limit: ${limit}`), { code: "turn_limit", limit });

type ApprovalBinding = { call: ToolCall; source: { plugin: string; toolSource: string }; definition: ToolDefinition };
function approvalKey(binding?: ApprovalBinding): string {
	return createHash("sha256").update(JSON.stringify(binding ?? null, (_, value) =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value)).digest("hex");
}

type BoundRequest = InputRequestDraft & { boundCall?: Pick<ToolCall, "name" | "input"> };

function requestIdOf(entry: HistoryEntry): string | undefined {
	return entry.requestId ?? (entry.data as { requestId?: string } | undefined)?.requestId;
}

function readRequest(entry: HistoryEntry): InputRequest {
	const request = (entry.data as { request: InputRequest }).request;
	return { ...request, sessionId: entry.sessionId, answerers: request.answerers ?? [], toolCallId: entry.toolCallId ?? request.toolCallId ?? undefined, turnId: entry.turnId ?? request.turnId ?? undefined };
}

export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function thinkingLevels(model?: ModelInfo): string[] {
	return REASONING_LEVELS.filter((level) => model?.thinking ? model.thinking.includes(level) : model?.reasoning || level === "off");
}

export function lowerReasoning(value: unknown, model?: ModelInfo): string | undefined {
	if (typeof value !== "string" || value === "default") return undefined;
	if (!model) return value;
	const index = REASONING_LEVELS.findIndex((level) => level === value);
	return thinkingLevels(model).findLast((level) => REASONING_LEVELS.findIndex((known) => known === level) <= index);
}

function tokenCount(usage?: Usage): number {
	return (usage?.input ?? 0) + (usage?.output ?? 0);
}

function readTenants(json: string | undefined): Map<string, Tenant> {
	if (json === undefined) return new Map();
	const value: unknown = JSON.parse(json);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MODULAR_AGENT_TENANTS must be a JSON object");
	return new Map(Object.entries(value).map(([name, config]) => {
		if (!name || !config || !Array.isArray(config.rights) || !config.rights.every((right: unknown) => typeof right === "string") ||
			(config.tokens !== undefined && (!Number.isSafeInteger(config.tokens) || config.tokens < 0))) {
			throw new Error(`Invalid tenant configuration for ${name}`);
		}
		return [name, { rights: [...new Set<Authority>(config.rights)], tokens: config.tokens }];
	}));
}

function actorJoined(actor: Actor, writer: string, actorId?: string): EntryDraft {
	const { authority, ...details } = actor;
	return { kind: "actorJoined", writer, actorId, modelVisible: false, data: { actor: { ...details, kind: details.kind === "plugin" ? "program" : details.kind, rights: authority }, ...(actorId ? {} : { operatorAdmission: true }) } };
}

export function normalizeSetting({ key, value }: { key: string; value: unknown }): { key: string; value: unknown } {
	if (key === "approvalPolicy" || key === "approval") return { key: "approval", value: ["off", "ask", "all", "never"].includes(String(value)) ? value : "never" };
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

function inputActors(q: QueuedInput): string[] {
	return [q.startedBy.kind === "job" ? undefined : q.actorId, q.releasedBy, q.delegatedBy, ...(q.authorityActors ?? [])].filter((id): id is string => id !== undefined);
}

function shapeViolation(shape: Record<string, unknown>, value: unknown): string | undefined {
	if (value === undefined) return "Return a JSON value matching the result schema.";
	try {
		const validate = schemaValidator.compile(shape);
		if (!validate(value)) return `Value does not match the schema: ${schemaValidator.errorsText(validate.errors)}`;
	} catch { return "Invalid JSON Schema"; }
}

function sameRegistration(a: { plugin: string; source: ToolSource; definition: ToolDefinition } | undefined,
	b: { plugin: string; source: ToolSource; definition: ToolDefinition }): boolean {
	return !!a && a.plugin === b.plugin && a.source === b.source && isDeepStrictEqual(a.definition, b.definition);
}

export type { GateResult };
