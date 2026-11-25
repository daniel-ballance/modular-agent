import { Jobs, type JobStart, type KeptJob } from "./jobs.js";
import { SessionErasure } from "./session-erasure.js";
import { ApprovalReconciliation } from "./approval-reconciliation.js";
import { failure } from "./failure.js";
import { sameJson, waitingApprovals, type ApprovalBinding, type ApprovalProof, type ApprovalDelivery, type ApprovalRoute, type WaitingApproval } from "./waiting-approval.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { activeOperation, carrier, conversation, currentSpan, historyForPeer, observeInference, readTrace, safeName, startOperation, telemetryEvent, toolAttributes, TURN_TRACE, withTrace, type Operation } from "./telemetry.js";
import { Follower } from "./output-gate.js";
import { Reservations, resourceBytes, reservationLimits, type ReservationOptions } from "./reservations.js";
import { RunReceipts, type ReceiptOperation } from "./run-receipts.js";
import { addAbortListener } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { interruptedCalls, modelView, pendingToolCalls, restoreAnsweredStep, withoutProviderData } from "./view.js";
import { HookRegistry } from "./hooks.js";
import { INTERFACE_HANDOFF, INTERFACE_SOURCE, handoffRecords, isJson, sameDefinition, validReportContent,
	type HandoffData, type HandoffRecord, type InterfaceToolConnection, type InterfaceToolConnectionOptions,
	type InterfaceToolHandoff, type InterfaceToolReceipt, type InterfaceToolReport, type InterfaceToolSource } from "./interface-tools.js";
import { inputIdOf, inputKeyScope, type InputReceipt, type InputTiming, type QueuedInput, Session } from "./session.js";
import {
	interruptedNote,
	type Actor,
	type AgentEvent,
	type Answer,
	type AssistantMessage,
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
	type SessionInterruptionReason,
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

export interface CommandContext {
	sessionId: string; actorId: string; stepId: string; signal: AbortSignal; api: PluginApi;
	requestModel(request: ModelRequest): Promise<AssistantMessage>;
	ask(request: InputRequestDraft): Promise<Answer>;
	environment(): Promise<WorkingEnvironment>;
}
export interface Command { description: string; usesModel?: boolean; run(args: string, context: CommandContext): Promise<string | void> | string | void }

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

export interface Transaction {
	append(draft: EntryDraft): void;
	setSetting(key: string, value: unknown, actorId?: string): void;
	input(options: InputOptions): void;
}
export interface FollowOptions { recipient: string; fromEntry?: number; raw?: boolean; onLag?: () => void; /** Ignore unneeded events before reserving follower capacity. */ include?(event: AgentEvent): boolean }

/** A content-free view of committed work. Reading it never attaches a writer or an Interface. */
export interface WaitingSummary { questions: number; toolCalls: number; turn: "none" | "running" | "interrupted" }
export interface SessionSummary { id: string; project: string; tenant?: string; updated: number; waiting: WaitingSummary }
export interface ListingViewer {
	actor: Actor;
	allowJoin: boolean;
	scope?(project: string, tenant?: string): boolean;
	routeId?: string;
	/** In-turn question views held by this connection. Late non-approval questions need no presence. */
	inTurn?: readonly string[] | true;
	secrets?: boolean;
	/** Other actors the operator permits this connection to represent; presence is connection-local. */
	represented?: readonly string[];
	present?: readonly string[];
}

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
	openSession(id: string, actor?: Actor, prepare?: SessionPrepare, operation?: "load" | "resume"): Promise<string>;
	/** Add an actor to a session. Its authority must be within the authority of whoever grants it. */
	join(sessionId: string, actor: Actor, grantedBy: string): Promise<void>;
	leave(sessionId: string, actorId: string, requestedBy?: string): Promise<void>;
	presentActors(sessionId: string): string[];
	presenceChanged(sessionId: string): void;
	/** Sessions in this project, another project, or every project (null). */
	listSessions(project?: string | null): Promise<StoredSession[]>;
	sessionSummary(id: string, viewer: ListingViewer): Promise<SessionSummary | undefined>;
	forkSession(sessionId: string, entryId: string): Promise<string>;
	closeSession(sessionId: string, actorId?: string, delegatedBy?: string, authority?: readonly Authority[]): Promise<void>;
	sessionInterruption(sessionId: string): AbortSignal;
	session(sessionId: string): { id: string; project: string; tenant?: string; settings: Record<string, unknown>; position: string | null; busy: boolean; actors: Actor[]; ephemeral: boolean };
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
	checkPending(sessionId: string): Promise<string>;
	readHistory(sessionId: string, options?: { all?: boolean }): HistoryEntry[] | Promise<HistoryEntry[]>;
	/** Inspect a fresh snapshot and register any follow-up observer without yielding. */
	inspectHistory<T>(sessionId: string, options: { all?: boolean }, inspect: (entries: HistoryEntry[]) => T): T | Promise<T>;
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
	refreshApprovals(sessionId: string): Promise<void>;
	registerApprovalRoute(policy: ApprovalRoute): () => void;
	presentApproval(sessionId: string, requestId: string, delivery: ApprovalDelivery): Promise<boolean>;
	submitAnswer(sessionId: string, answer: Answer, handle?: object): Promise<{ accepted: boolean; reason?: string }>;
	openRequests(sessionId: string): InputRequest[];
	// jobs
	/** Start a job. It is recorded in the history, with the plugin's own detail. */
	startJob(sessionId: string, options: JobStart): JobHandle;
	workActors(sessionId: string): string[];
	workJobs(sessionId: string): string[];
	workMay(sessionId: string, right: Authority, actors: string[], jobs?: string[]): boolean;
	jobTrace?(sessionId: string, jobId: string): Operation | undefined;
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
	gateOutput<T>(sessionId: string, recipient: string, type: string, data: T, ids?: Pick<AgentEvent, "turnId" | "stepId" | "toolCallId">): Promise<T | undefined>;
	declaration(sessionId?: string): Declaration;
	modelAccess(sessionId: string): ModelAccess | undefined;
	// settings
	config(): Record<string, unknown>;
}

export interface HarnessOptions { receiptDir?:string; approvalCoversNested?: boolean; agentName?: string; project: string; home: string; now?: () => number; newId?: () => string; questionsOutlastTurns?: boolean; settingsDuringTurn?: "nextTurn" | "refused"; jobReportsStartTurns?: boolean; rejectUnknownModel?: boolean; resourceReservations?: ReservationOptions; tenants?: Record<string, Tenant> | null }

export const ALL_AUTHORITY: Authority[] = ["watch", "propose", "input", "answer", "approve", "tools", "cancel", "settings", "erase", "grant", "jobs", "delegate", "administer"];

export interface Tenant { rights: Authority[]; tokens?: number }
interface TenantInfo { tenant: string | null; rights: Authority[] | null; tokens: { budget: number; used: number } | null }
type ConnectionRights = NonNullable<QueuedInput["connectionRights"]>;
const connectionRights = new AsyncLocalStorage<ConnectionRights>();
function intersectConnectionRights(...scopes: (ConnectionRights | undefined)[]): ConnectionRights | undefined {
	const rights = new Map<string, Authority[]>();
	for (const scope of scopes) for (const [actor, ceiling] of Object.entries(scope ?? {})) {
		const prior = rights.get(actor);
		rights.set(actor, prior ? prior.filter(right => ceiling.includes(right)) : ceiling);
	}
	return rights.size ? Object.fromEntries(rights) : undefined;
}
interface InterfaceConnection extends InterfaceToolConnectionOptions {
	tools: Map<string, ToolDefinition>;
}
interface LiveHandoff {
	deliver(request: InterfaceToolHandoff): void;
	connection: InterfaceConnection;
	released: boolean;
	check: () => boolean;
}
/** Kept only from an approval gate through that invocation's live tools.call handle. */
interface CoveringAllow { toolCallId: string; requestId: string; actorId: string }
interface ApprovalPass {
	callId: string; attempt: string; inherited?: CoveringAllow; allow?: CoveringAllow;
}
interface DispatchAllowance { call: ToolCall; binding: ApprovalBinding; policy: unknown; cover?: CoveringAllow }
interface NestedDispatch { depth: number; registration: NonNullable<ReturnType<Harness["findTool"]>>; approval: unknown; inherited?: CoveringAllow }
type RecordedSnapshot = TurnSnapshot & { startedBy: QueuedInput["startedBy"]; resultShape?: Record<string, unknown> };
function recordedSnapshot(start: HistoryEntry): RecordedSnapshot {
	const d = start.data as RecordedSnapshot | undefined;
	const id = (x: unknown) => typeof x === "string" && x.length > 0;
	const object = (x: unknown) => x != null && typeof x === "object" && !Array.isArray(x);
	const cap = (x?: number) => x === undefined || Number.isSafeInteger(x) && x > 0;
	if (!d || !id(d.startedBy?.id) || !["actor", "job", "plugin", "answer", "toolResult"].includes(d.startedBy.kind) ||
		d.model !== null && (!id(d.model?.id) || !id(d.model?.provider)) || typeof d.system !== "string" ||
		d.context !== undefined && !validReportContent(d.context) || !Array.isArray(d.tools) ||
		!d.tools.every(t => id(t?.name) && typeof t.description === "string" && (typeof t.parameters === "boolean" || object(t.parameters))) ||
		!object(d.settings) || !cap(d.settings.maxSteps) || !cap(d.settings.maxOutput) ||
		d.settings.reasoning !== undefined && !REASONING_LEVELS.some(level => level === d.settings.reasoning)) {
		throw failure("unavailable", "Cannot recover an incomplete turn snapshot");
	}
	return d;
}

interface TurnState extends TurnSnapshot { interfaceOffer?: Map<string, InterfaceConnection>; interfaceAllowances?: Map<string, { call: ToolCall; approval: unknown } | null>; dispatched: Set<string>; steps: Map<string, Operation>; startingRights?: Authority[]; connectionRights?: ConnectionRights; endedHook?: boolean; sources: Map<string, string[]>; actors: Set<string>; jobs: Set<string>; tenantLimit?: boolean; capacityLimit?: boolean; stepAfterRunning?: boolean; toolResultError?: string }

/**
 * The Harness: hosts plugins, offers the plugin API, keeps sessions.
 * It runs no turns, calls no models and runs no tools itself.
 */
export class Harness {
	private readonly jobWork: Jobs = new Jobs({
		erasure: () => this.erasure,
		workActors: (...args) => this.workActors(...args),
		turnAuthority: () => this.turnAuthority,
		workRights: (...args) => this.workRights(...args),
		reservations: () => this.reservations,
		newId: (...args) => this.newId(...args),
		reserveJob: (...args) => this.reserveJob(...args),
		commit: (...args) => this.commit(...args),
		toolWork: () => this.toolWork,
		emit: (...args) => this.emit(...args),
		problem: (...args) => this.problem(...args),
		admit: (...args) => this.admit(...args),
		jobReportsStartTurns: () => this.jobReportsStartTurns,
		startQueued: (...args) => this.startQueued(...args),
		acceptInput: (...args) => this.acceptInput(...args),
	});

	readonly receipts: RunReceipts;
	readonly receiptOperation = new AsyncLocalStorage<ReceiptOperation>();
	readonly hooks: HookRegistry;
	readonly project: string;
	readonly home: string;
	private caps = new Map<string, { plugin: string; impl: unknown }[]>();
	private loaded: { plugin: Plugin; api: PluginApi }[] = [];
	private sessions = new Map<string, Session>();
	private readonly erasure: SessionErasure;
	private opening = new Set<string>();
	private readonly tenants: Map<string, Tenant>;
	private reservations: Reservations;
	private reservationScan?: Promise<void>;
	private listeners: { plugin: string; raw: boolean; fn: (e: AgentEvent) => void }[] = [];
	private commandTable = new Map<string, Command & { plugin: string }>();
	private now: () => number;
	private readonly questionsOutlastTurns: boolean;
	private readonly approvalCoversNested: boolean;
	private readonly approvals: ApprovalReconciliation = new ApprovalReconciliation({
		now: () => this.now(),
		newId: () => this.newId(),
		reservations: () => this.reservations,
		findTool: (s, name) => this.findTool(s, name),
		actorRights: (s, actor) => this.actorRights(s, actor),
		originalWorkAllows: (s, approval) => this.originalWorkAllows(s, approval),
		exitTurn: work => this.turnAuthority.exit(work),
		exitConnection: work => connectionRights.exit(work),
		commit: (...args) => this.commit(...args),
		commitNow: (...args) => this.commitNow(...args),
		interfaces: () => this.interfaces(),
		emitAnswer: (...args) => this.emitAnswer(...args),
		toolDisposition: (...args) => this.toolDisposition(...args),
		maybeContinueOpenCalls: (...args) => this.maybeContinueOpenCalls(...args),
		problem: (...args) => this.problem(...args),
		intersectRights,
	});
	private readonly approvalPass = new AsyncLocalStorage<ApprovalPass>();
	private readonly modelGate = new AsyncLocalStorage<{ response: HistoryEntry; actorId: string; turnId: string; callId: string }>();
	private readonly dispatchAllowances = new WeakMap<TurnState, Map<string, DispatchAllowance>>();
	private readonly settingsDuringTurn?: "nextTurn" | "refused";
	private readonly jobReportsStartTurns: boolean;
	private readonly rejectUnknownModel: boolean;
	private readonly agentName?: string;
	private newId: () => string;
	private refusedTools = new Set<string>();
	private turnAuthority = new AsyncLocalStorage<{ sessionId: string; actors: Set<string>; jobs: Set<string>; state?: Pick<TurnState, "connectionRights" | "startingRights"> }>();
	private toolWork = new AsyncLocalStorage<ToolCall>();
	private gateSignal = new AsyncLocalStorage<AbortSignal | undefined>();
	readonly problems: { plugin: string; where: string; error: string }[] = [];

	constructor(options: HarnessOptions) {
		this.reservations = new Reservations(reservationLimits(options.resourceReservations));
		this.tenants = readTenants(options.tenants === undefined ? process.env.MODULAR_AGENT_TENANTS : JSON.stringify(options.tenants ?? {}));
		this.project = options.project;
		this.home = options.home;
		this.receipts = new RunReceipts(options.receiptDir ?? options.home);
		this.erasure = new SessionErasure({
			sessions: this.sessions,
			receipts: this.receipts,
			store: () => this.use<HistoryStore>("history-store"),
			providers: () => this.useAll<Provider>("provider"),
			checkWriter: s => this.checkWriter(s),
			hasUnfinishedJobs: s => this.jobWork.runningJobs(s).length > 0,
			invalidateErasedHandoffs: (...args) => this.invalidateErasedHandoffs(...args),
			commitNow: (...args) => this.commitNow(...args),
			write: (s, write) => this.write(s, write),
			emit: (...args) => this.emit(...args),
			loadInto: id => this.loadInto(id),
			requireAuthority: (...args) => this.requireAuthority(...args),
			newId: () => this.newId(),
			problem: (...args) => this.problem(...args),
			actorRights: (s, actor) => this.actorRights(s, actor),
		});
		this.now = options.now ?? Date.now;
		this.newId = options.newId ?? randomUUID;
		this.questionsOutlastTurns = options.questionsOutlastTurns ?? true;
		this.approvalCoversNested = options.approvalCoversNested === true;
		this.settingsDuringTurn = options.settingsDuringTurn;
		this.jobReportsStartTurns = options.jobReportsStartTurns ?? true;
		this.rejectUnknownModel = options.rejectUnknownModel === true;
		this.agentName = safeName(options.agentName);
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
					let queue = Promise.resolve();
					const entry = { plugin: pluginName, raw: true, fn: (event: AgentEvent) => {
						if (!this.erasure.httpErasure() || !event.sessionId) return fn(event);
						// Preserve event order for consumers that track input and turn IDs.
						queue = queue.then(async () => { await this.eventAdmission(event); fn(event); })
							.catch(e => this.problem(pluginName, "event listener", e));
					} };
					this.listeners.push(entry);
					return () => {
						this.listeners = this.listeners.filter((l) => l !== entry);
					};
				}
				// Plugins that follow events see the gated view unless they ask for the raw one.
				const follower = new Follower(this.hooks, `plugin:${pluginName}`, false, fn, (e) => this.problem(pluginName, "event listener", e), undefined, undefined, event => this.eventAdmission(event));
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
			openSession: (id, actor, prepare, operation) => this.openSession(id, actor, prepare, operation),
			join: (sessionId, actor, grantedBy) => this.join(this.session(sessionId), actor, grantedBy, pluginName),
			leave: async (sessionId, actorId, requestedBy) => {
				const s = this.session(sessionId);
				if (requestedBy && requestedBy !== actorId) this.requireAuthority(s, requestedBy, "grant");
				if (!s.actors.has(actorId)) throw new Error(`Actor ${actorId} is not part of this session`);
				await this.commit(s, [{ kind: "actorLeft", writer: pluginName, actorId, modelVisible: false, data: { actorId } }]);
				await this.hooks.observe("session.leave", { sessionId, actorId, requestedBy });
				this.emit(s, "session.left", { actorId }, pluginName, { actorId });
				await this.closeRevokedWaits(s);
				await this.approvals.reconcileApprovals(s);
			},
			presentActors: (id) => this.presentActors(this.session(id)),
			presenceChanged: (id) => { const s = this.sessions.get(id); if (s) {
				this.approvals.presenceChanged(s);
				void this.closeUnanswerable(s).catch(e => this.problem("harness", "close unanswerable wait", e));
			} },
			listSessions: async (project) => (await this.use<HistoryStore>("history-store")?.list(project === null ? undefined : { project: project ?? this.project })) ?? [],
			sessionSummary: (id, viewer) => this.sessionSummary(id, viewer),
			forkSession: (sessionId, entryId) => this.forkSession(sessionId, entryId),
			closeSession: (id, actorId, delegatedBy, authority) => this.closeSession(id, actorId, delegatedBy, authority),
			session: (id) => {
				const s = this.session(id);
				return { id: s.id, project: s.meta.project, tenant: s.tenant, settings: { ...s.settings }, position: s.position, busy: s.isBusy(), actors: [...s.actors.values()].map((a) => ({ ...a, authority: this.rightsOf(s, a.id) })), ephemeral: s.ephemeral };
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
			checkPending: id => this.erasure.admitHistory(this.session(id)),
			readHistory: (id, options) => this.inspectHistory(id, options ?? {}, entries => entries),
			inspectHistory: (id, options, inspect) => this.inspectHistory(id, options, inspect),
			history: (sessionId, options) => {
				const s = this.session(sessionId);
				this.checkScopedWork(s, "watch");
				if (this.erasure.httpErasure() && !s.provisional) throw failure("unavailable", "HTTP history requires asynchronous readHistory");
				this.erasure.checkPending(s);
				return options?.all ? s.order.map((id) => s.entries.get(id)!) : s.branch();
			},
			append: async (sessionId, draft) => (await this.commit(this.session(sessionId), [{ ...draft, writer: draft.writer ?? pluginName }], true))[0],
			transaction: (sessionId, fn) => this.transaction(this.session(sessionId), pluginName, fn),
			erase: (sessionId, ids, actorId) => this.erasure.erase(this.session(sessionId), ids, actorId, pluginName),
			tools: (sessionId) => this.toolDefinitions(sessionId ? this.session(sessionId) : undefined),
			callTool: (sessionId, call) => this.callTool(this.session(sessionId), { ...call, id: call.id ?? this.newId() }),
			ask: (sessionId, request) => this.ask(this.session(sessionId), request, pluginName),
			deferTool: (id, turnId, question) => this.deferTool(this.session(id), turnId, question, pluginName),
			refreshApprovals: id => this.approvals.reconcileApprovals(this.session(id)),
			registerApprovalRoute: policy => this.approvals.registerRoute(policy),
			presentApproval: (id, requestId, delivery) => this.approvals.presentApproval(this.session(id), requestId, delivery),
			submitAnswer: (sessionId, answer, handle) => this.submitAnswer(this.session(sessionId), answer, handle),
			openRequests: (sessionId) => {
				const s = this.session(sessionId);
				return [...[...s.requests.values()].map((r) => r.request), ...this.waitingRequests(s)];
			},
			startJob: (sessionId, options) => this.jobWork.startJob(this.session(sessionId), options, pluginName),
			workActors: (id) => this.workActors(this.session(id)),
			workJobs: (id) => { const work = this.turnAuthority.getStore(); return work?.sessionId === id ? [...work.jobs] : []; },
			workMay: (id, right, actors, jobs) => this.workRights(this.session(id), actors, jobs).includes(right),
			jobTrace: (id, jobId) => {
				const s = this.session(id);
				return s.jobs.get(jobId)?.job.plugin === pluginName ? this.jobWork.jobSpans.get(s)?.get(jobId) : undefined;
			},
			findJob: (jobId) => {
				for (const s of this.sessions.values()) {
					if (s.order.some((id) => { const e = s.entries.get(id)!; return e.kind === "jobStarted" && e.jobId === jobId && e.writer === pluginName; })) return { sessionId: s.id };
				}
				return undefined;
			},
			onJobCancel: (handler) => this.jobWork.jobCancels.set(pluginName, handler),
			unfinishedJobs: (id) => this.jobWork.runningJobs(this.session(id)).filter(({ job }) => job.plugin === pluginName),
			resumeJob: (id, jobId) => {
				const s = this.session(id);
				const found = this.jobWork.runningJobs(s).find((j) => j.job.id === jobId && j.job.plugin === pluginName);
				if (!found) throw new Error(`No unfinished job ${jobId} of ${pluginName}`);
				return s.jobs.get(jobId)?.handle ?? this.jobWork.jobHandle(s, found);
			},
			jobs: (id) => {
				const s = this.session(id);
				const cleanup = new Set(s.order.map((eid) => s.entries.get(eid)!).filter((e) => e.kind === "jobCleanupUnconfirmed").map((e) => e.jobId));
				return this.jobWork.runningJobs(s).map(({ job }) => ({ ...job, state: cleanup.has(job.id) ? "cleanupUnconfirmed" as const : s.jobs.has(job.id) ? "running" as const : "unfinished" as const }));
			},
			cancelJob: (sessionId, jobId) => this.jobWork.cancelJob(this.session(sessionId), jobId),
			sessionInterruption: id => this.session(id).interruption.signal,
			follow: (sessionId, options, listener) => this.follow(this.session(sessionId), options, listener),
			flushOutput: async (id, recipient) => {
				const followers = [...(this.sessions.get(id)?.followers ?? [])].filter((f) => f.recipient === recipient);
				await Promise.all(followers.map((f) => f.idle()));
			},
			gateOutput: async (sessionId, recipient, type, data, ids) => {
				const s = this.sessions.get(sessionId);
				const freshness = s && await this.erasure.admitHistory(s);
				let out: typeof data | undefined;
				let overflow = false;
				const follower = new Follower(this.hooks, recipient, false, (e) => { if (e.type === type) out = e.data; }, (e) => { if ((e as {code?: string}).code === "result_too_large") overflow = true; else this.problem("harness", "output gate", e); }, undefined, undefined,
					s && this.erasure.httpErasure() ? () => this.erasure.admitHistory(s).then(current => { if (current !== freshness) throw failure("unavailable", "Erasure changed the output view"); }) : undefined);
				follower.push({ type, time: this.now(), sessionId, source: pluginName, ...ids, data });
				if (type === "model.output") follower.push({ type: "model.streamEnd", time: this.now(), sessionId, source: pluginName, ...ids });
				await follower.idle();
				if (s && await this.erasure.admitHistory(s) !== freshness) throw failure("unavailable", "Erasure changed the output view");
				if (overflow && type === "reply") throw failure("result_too_large", "Reply exceeds the gate limit");
				return out;
			},
			declaration: (sessionId) => this.declaration(sessionId ? this.session(sessionId) : undefined),
			gatedHistory: async (sessionId, options) => {
				const s = this.session(sessionId);
				await this.erasure.reconcilePending(s);
				const freshness = await this.erasure.admitHistory(s);
				const entries = options.all ? s.order.map((id) => s.entries.get(id)!) : s.branch();
				const out: HistoryEntry[] = [];
				const follower = new Follower(this.hooks, options.recipient, false, (e) => { if (e.type === "entry") out.push(e.data as HistoryEntry); }, (e) => this.problem("harness", "gated history", e), undefined, undefined,
					this.erasure.httpErasure() ? () => this.erasure.admitHistory(s).then(current => { if (current !== freshness) throw failure("unavailable", "Erasure changed the history view"); }) : undefined);
				for (const entry of entries) {
					follower.push({ type: "entry", time: this.now(), sessionId: s.id, source: "harness", data: entry });
					await follower.idle();
				}
				if (await this.erasure.admitHistory(s) !== freshness) throw failure("unavailable", "Erasure changed the history view");
				return out;
			},
			modelAccess: (sessionId) => this.modelAccess(this.session(sessionId)),
			config: () => this.use<Configuration>("configuration")?.plugin(pluginName) ?? {},
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

	private emit(session: string | Session, type: string, data: any, source: string, ids?: Partial<AgentEvent>): void {
		const sessionId = typeof session === "string" ? session : session.id;
		const s = this.sessions.get(sessionId);
		if (typeof session !== "string" && session !== s) return; // An old writer must not publish to a reopened session.
		const event: AgentEvent = { type, time: this.now(), sessionId, source, ...ids, data };
		if (s) this.eventViews.set(event, { session: s, epoch: this.erasure.epoch(s) });
		if (s?.interruption.signal.aborted && type !== "session.ended") return;
		if (type !== "session.interrupted") s?.remember(event);
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
	private eventViews = new WeakMap<AgentEvent, { session: Session; epoch: number }>();
	private eventAdmission(event: AgentEvent): Promise<void> | undefined {
		if (!this.erasure.httpErasure() || !event.sessionId || ["session.interrupted", "entries.erased", "session.ended"].includes(event.type)) return;
		const view = this.eventViews.get(event);
		const s = view?.session ?? this.sessions.get(event.sessionId);
		if (!s || s !== this.sessions.get(event.sessionId) || view && view.epoch !== this.erasure.epoch(s)) return Promise.reject(failure("unavailable", "The queued event no longer has a current view"));
		return this.erasure.admitHistory(s).then(() => undefined);
	}

	private follow(s: Session, options: FollowOptions, listener: (event: AgentEvent) => unknown): (() => void) & { idle(): Promise<void> } {
		const follower = new Follower(this.hooks, options.recipient, options.raw ?? false, event => {
			if (!["session.interrupted", "entries.erased"].includes(event.type)) this.erasure.checkPending(s);
			if (event.type === "entry" || event.type === "entry.added") {
				const current = s.entries.get((event.data as HistoryEntry)?.id);
				if (current?.erased && !event.data?.erased) return;
			}
			return listener(event);
		}, (e) => this.problem("harness", "follow", e),
			() => { s.followers.delete(follower); options.onLag?.(); },
			bytes => {
				const key = `output:${this.newId()}`;
				if (!this.reservations.reserve(s, key, { bufferedBytes: bytes })) return undefined;
				return () => this.reservations.release(s, key);
			}, event => this.eventAdmission(event), options.include);
		// History first, from the requested point, then live events.
		const from = options.fromEntry ?? s.order.length;
		for (const id of s.order.slice(from)) {
			const event = { type: "entry", time: this.now(), sessionId: s.id, source: "harness", data: s.entries.get(id) };
			this.eventViews.set(event, { session: s, epoch: this.erasure.epoch(s) });
			follower.push(event);
		}
		if (!follower.closed) s.followers.add(follower);
		return Object.assign(() => { s.followers.delete(follower); follower.disconnect(); }, { idle: () => follower.idle() });
	}

	// ---------- commands ----------

	private async runCommand(sessionId: string, line: string, actorId: string): Promise<string | void> {
		const match = /^\/(\S+)\s?([\s\S]*)$/.exec(line.trimStart());
		if (!match) throw failure("invalid_params", "Not a command");
		const session = this.session(sessionId);
		await this.erasure.reconcilePending(session);
		this.requireAuthority(session, actorId, "input");
		this.checkWriter(session);
		const command = this.commandTable.get(match[1]);
		if (!command) throw failure("not_found", `Unknown command /${match[1]}`);
		const stepId = this.newId();
		const commandReservation = `command:${stepId}`;
		if (!this.reservations.reserve(session, commandReservation, { calls: 1, bufferedBytes: resourceBytes(line),
			storageBytes: this.reservations.limits.settlementBytes })) throw failure("busy", "No capacity for command");
		const authority = { startingRights: this.rightsOf(session, actorId) };
		const scope = { sessionId, actors: new Set([actorId]), jobs: new Set<string>(), state: authority };
		const abort = new AbortController();
		const signal = AbortSignal.any([abort.signal, session.interruption.signal]);
		const live = () => {
			if (abort.signal.aborted || session.closed || session.closing || session.suspended) {
				throw Object.assign(new Error("Command context has settled"), { code: "invalid_request" });
			}
			signal.throwIfAborted();
			this.erasure.checkPending(session);
			this.checkWriter(session);
			this.requireAuthority(session, actorId, "input");
		};
		let tail = Promise.resolve();
		try {
			return await this.turnAuthority.run(scope, () => command.run(match[2], { sessionId, actorId, stepId, signal, api: this.api(command.plugin),
				requestModel: async (request) => {
					live();
					if (!command.usesModel) throw Object.assign(new Error("Command did not declare usesModel"), { code: "not_supported" });
					const snapshot = structuredClone(request);
					const pending = tail.then(async () => {
						live();
						await this.providerFor(session)?.refreshModels?.();
						const model = this.modelAccess(session);
						if (!model) throw Object.assign(new Error("The selected model is not offered"), { code: "invalid_request" });
						const allowed = this.rightsOf(session, actorId).includes("tools") ? this.toolDefinitions(session) : [];
						const offered = session.settings.modelTools;
						const tools = snapshot.tools.filter(tool => (!tool.callers || tool.callers.includes("model")) && !this.interfaceSources.has(tool.name) &&
							(offered == null || Array.isArray(offered) && offered.includes(tool.name)) && allowed.some(t => isDeepStrictEqual(t, tool)));
						const settings = this.turnSettings(session, model.model);
						const maxOutput = Math.min(settings.maxOutput ?? Infinity, snapshot.settings.maxOutput ?? Infinity);
						const request = { ...snapshot, tools, providerTools: "none" as const, settings: { ...snapshot.settings,
							reasoning: snapshot.settings.reasoning ?? settings.reasoning, maxOutput: Number.isFinite(maxOutput) ? maxOutput : undefined } };
						return this.turnModel(session, undefined, { ...authority, sources: new Map(), actors: scope.actors, jobs: scope.jobs }, model, live)
							.request(request, { signal, stepId });
					});
					tail = pending.then(() => {}, () => {});
					return pending;
				},
				ask: async request => { live(); return this.ask(session, request, command.plugin, signal); },
				environment: async () => {
					live();
					const authorize = () => {
						if (!this.rightsOf(session, actorId).includes("tools")) throw failure("invalid_request", "Command cannot use the environment");
					};
					authorize();
					const environment = await this.environmentFor(session);
					live();
					authorize();
					if (!environment) throw Object.assign(new Error("No working environment"), { code: "not_supported" });
					return this.scopedEnvironment(environment, () => { live(); authorize(); });
				},
			}));
		} finally {
			abort.abort();
			await tail;
			this.reservations.release(session, commandReservation);
		}
	}

	// ---------- sessions ----------

	resourceLimits() { return structuredClone(this.reservations.limits); }

	shareReservations(serving: Harness) {
		serving.reservations.adopt(this.reservations);
		this.reservations = serving.reservations;
	}

	rebuildReservations(): Promise<void> {
		return this.reservationScan ??= (async () => {
			const store = this.use<HistoryStore>("history-store");
			for (const meta of await store?.list() ?? []) {
				const s = await this.loadInto(meta.id);
				if (!s) continue;
				const entries = s.order.map(id => s.entries.get(id)!);
				this.reservations.retain(s, entries.reduce((n, entry) => n + resourceBytes(entry), 0), true);
				for (const q of s.admissions.values()) this.reserveInput(s, q, true);
				for (const { job } of this.jobWork.runningJobs(s)) this.reserveJob(s, job.id, true);
				const own = entries.filter(e => !s.copied.has(e.id));
				const results = new Set(own.filter(e => e.kind === "toolResult").map(e => e.toolCallId));
				const ended = new Set(own.filter(e => e.kind === "turnEnd").map(e => e.turnId));
				const answered = new Set(own.filter(e => e.kind === "response").map(e => e.stepId));
				const closed = new Set(own.filter(e => e.kind === "inputAnswer").map(e => e.requestId));
				const unit = this.reservations.limits.settlementBytes;
				for (const e of own) {
					if (e.kind === "inputRequest" && !e.erased && !closed.has(e.requestId)) {
						this.reservations.reserve(s, `question:${e.requestId}`, { storageBytes: 3 * unit }, true);
					}
					if (e.kind === "turnStart" && e.turnId && !ended.has(e.turnId)) this.reservations.reserve(s, `turn:${e.turnId}`, { storageBytes: 2 * unit }, true);
					if (e.kind === "modelRequest" && e.stepId && !answered.has(e.stepId) && !ended.has(e.turnId)) {
						this.reservations.reserve(s, `model:${e.stepId}`, { calls: 1, storageBytes: 2 * unit }, true);
					}
				}
				for (const entry of entries) {
					if (s.copied.has(entry.id)) continue;
					if (entry.kind === "response" && entry.message?.role === "assistant") {
						for (const part of entry.message.content) if (isToolCall(part) && !results.has(part.id)) this.reserveCall(s, part.id, true);
					}
					if ((entry.kind === "modular-agent.nestedCall" || entry.kind === "toolStarted") && entry.toolCallId && !results.has(entry.toolCallId)) {
						this.reserveCall(s, entry.toolCallId, true);
					}
				}
			}
		})();
	}

	private reserveInput(s: Session, q: QueuedInput, rebuilding = false, startsNow = false) {
		const size = resourceBytes(q);
		const unit = this.reservations.limits.settlementBytes;
		if (!rebuilding && size + 2048 > this.reservations.limits.entryBytes ||
			!this.reservations.reserve(s, `input:${q.id}`, { inputs: startsNow ? 0 : 1, bufferedBytes: size, storageBytes: 3 * size + 4 * unit }, rebuilding)) {
			throw failure("busy", "No capacity for input");
		}
	}

	private reserveCall(s: Session, id: string, rebuilding = false) {
		return this.reservations.reserve(s, `call:${id}`, { calls: 1, storageBytes: 4 * this.reservations.limits.settlementBytes }, rebuilding);
	}

	private reserveJob(s: Session, id: string, rebuilding = false) {
		const unit = this.reservations.limits.settlementBytes;
		if (!this.reservations.reserve(s, `job:${id}`, { jobs: 1, inputs: 1, bufferedBytes: unit, storageBytes: 9 * unit }, rebuilding)) {
			throw failure("busy", "No capacity for job and its report");
		}
	}

	session(id: string): Session {
		const s = this.sessions.get(id);
		if (!s) throw failure("not_open", `Session ${id} is not open`);
		return s;
	}

	/** Live metadata for another connection attaching to a session in this process. */
	liveSessionInfo(id: string) {
		const s = this.sessions.get(id);
		if (!s || s.closing || s.closed || s.interruption.signal.aborted) return undefined;
		return { ...s.meta, updated: s.entries.get(s.order.at(-1) ?? "")?.time ?? s.meta.created,
			settings: { ...s.settings }, tenant: s.tenant };
	}

	private defaultActor(): Actor {
		return { id: "user", kind: "user", authority: ALL_AUTHORITY };
	}

	async startSession(options: SessionStartOptions = {}): Promise<string> {
		const span = startOperation("modular_agent.session.open", { "modular_agent.session.operation": "new" });
		return span.observe(() => this.startSessionWithin(options, span));
	}

	private async startSessionWithin(options: SessionStartOptions, span: Operation): Promise<string> {
		await this.rebuildReservations();
		const store = this.use<HistoryStore>("history-store");
		const sourceId = options.forkFrom?.sessionId ?? options.parentSessionId;
		const ancestor = sourceId ? this.sessions.get(sourceId) ?? await this.loadInto(sourceId) : undefined;
		const ancestorView = ancestor && await this.erasure.admitHistory(ancestor);
		const tenant = ancestor?.tenant ?? options.tenant;
		if (tenant !== undefined && !this.tenants.has(tenant)) throw Object.assign(new Error(`Unknown tenant ${tenant}`), { code: "invalid_params" });
		const cwd = options.settings?.cwd;
		const meta: StoredSession = { id: this.newId(), created: this.now(), project: ancestor?.meta.project ?? (typeof cwd === "string" ? cwd : this.project), forkedFrom: options.forkFrom, parentSessionId: options.parentSessionId };
		span.set("gen_ai.conversation.id", meta.id);
		const s = new Session(meta, !store);
		s.tenant = tenant;
		s.provisional = !!store && store.supports.persistent !== false && !options.forkFrom;
		if (store && !s.provisional) {
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
				copies = copyForkPrefix(path.filter(e => e.kind !== INTERFACE_HANDOFF), meta.id, () => this.newId());
				Object.assign(defaults, source.settings);
			}
		}
		const actors = options.forkFrom && ancestor ? [...ancestor.actors.values()] : [actor];
		const drafts: EntryDraft[] = [...actors.map((a) => actorJoined(a, "harness")), ...Object.entries(defaults).map(([key, value]): EntryDraft => ({ kind: "setting", writer: "harness", modelVisible: false, data: { key, value } }))];
		if (tenant !== undefined) drafts.unshift({ kind: "tenant", writer: "harness", modelVisible: false, data: { tenant } });
		if (options.forkFrom && ancestor?.limit) drafts.push({ kind: "limit", writer: "harness", modelVisible: false, actorId: actor.id, data: { rights: ancestor.limit } });
		else if (options.forkFrom && s.limit !== null) drafts.push({ kind: "limit", writer: "harness", modelVisible: false, actorId: actor.id, data: { rights: null } });
		if (options.parentSessionId) {
			const actors = ancestor ? this.workActors(ancestor) : [];
			const work = this.turnAuthority.getStore();
			const jobs = work?.sessionId === ancestor?.id && work ? [...work.jobs] : [];
			if (actors.length || jobs.length) drafts.push({ kind: "harness.parentAuthority", writer: "harness", modelVisible: false, data: { actors, jobs, rights: this.workRights(ancestor!, actors, jobs) } });
		}
		this.watchWriter(s);
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
				const publish = async () => {
					if (ancestor && await this.erasure.admitHistory(ancestor) !== ancestorView) throw failure("unavailable", "Erasure changed the fork source");
					await this.observeCommit(s, batch.length, () => this.write(s, () => store?.append(s.id, batch, { forkErasureView: ancestorView })));
					for (const e of batch) s.apply(e);
				};
				const registry = this.erasure.pendingRegistry();
				if (registry) await registry.exclusive(publish);
				else await publish();
			} else {
				await this.commit(s, drafts);
				await this.recordPlugins(s);
			}
		} catch (error) {
			this.sessions.delete(meta.id);
			await this.closeWriter(s);
			throw error;
		}
		await this.prepareSession(s, false, options.prepare);
		await this.hooks.observe("session.start", { sessionId: s.id, resumed: false });
		this.emit(s, "session.started", { meta }, "harness");
		return s.id;
	}

	private async loadInto(id: string): Promise<Session | undefined> {
		const store = this.use<HistoryStore>("history-store");
		if (!store) return undefined;
		const { meta, entries } = await store.load(id);
		if (!entries.length) return undefined;
		const s = new Session(meta, false);
		if (store.historyErasure) this.erasure.loadTombstones(s, new Set(entries.filter(e => e.erased === true).map(e => e.id)));
		for (const e of entries) s.apply(e);
		const interrupted = this.unfinishedTurn(s, s.branch());
		if (interrupted) recordedSnapshot(interrupted);
		return s;
	}

	private async prepareSession(s: Session, resumed: boolean, prepare?: SessionPrepare) {
		try {
			await this.hooks.observe("session.prepare", { sessionId: s.id, project: s.meta.project, resumed });
			await prepare?.(s.id);
		} catch (error) {
			await this.hooks.observe("session.end", { sessionId: s.id });
			this.sessions.delete(s.id);
			await this.closeWriter(s);
			throw error;
		}
	}

	async openSession(id: string, actor?: Actor, prepare?: SessionPrepare, operation: "load" | "resume" = "resume"): Promise<string> {
		return startOperation("modular_agent.session.open", { ...conversation(id), "modular_agent.session.operation": operation })
			.observe(async () => (await this.openSessionWithin(id, actor, prepare))!);
	}

	/** Startup recovery never waits for a writer and rechecks the record under the lease. */
	async resumeInterruptedSession(id: string, actor: Actor): Promise<boolean> {
		return startOperation("modular_agent.session.open", { ...conversation(id), "modular_agent.session.operation": "resume" })
			.observe(async () => !!await this.openSessionWithin(id, actor, undefined, true));
	}

	private async openSessionWithin(id: string, actor?: Actor, prepare?: SessionPrepare, interruptedOnly = false) {
		await this.rebuildReservations();
		if (this.opening.has(id) || this.sessions.get(id)?.closing) {
			throw Object.assign(new Error("Session is busy"), { code: "busy" });
		}
		this.opening.add(id);
		try { return await this.openStoredSession(id, actor, prepare, interruptedOnly); }
		finally { this.opening.delete(id); }
	}

	private async openStoredSession(id: string, actor?: Actor, prepare?: SessionPrepare, interruptedOnly = false) {
		const opened = this.sessions.get(id);
		if (opened && !opened.interruption.signal.aborted) {
			if (interruptedOnly) return;
			if (actor) await this.authorizeOpeningActor(opened, actor);
			await this.erasure.reconcilePending(opened);
			await prepare?.(id);
			return id;
		}
		if (opened) {
			if (actor && !await this.canDiscoverSession(id, actor, true)) throw failure("forbidden", "Session is inaccessible");
			await this.retireSession(opened);
		}
		const store = this.use<HistoryStore>("history-store");
		if (!store) throw failure("not_supported", "No history store: sessions can't be reopened");
		await store.openForWriting(id, { wait: !interruptedOnly });
		const s = await this.loadInto(id).catch(async (error) => { await store.close(id); throw error; });
		if (!s || (s.tenant !== undefined && !this.tenants.has(s.tenant))) {
			await store.close(id);
			throw s ? failure("forbidden", "Session tenant is unavailable") : failure("not_found", `Session ${id} not found`);
		}
		if (interruptedOnly && !this.unfinishedTurn(s, s.branch())) {
			await store.close(id);
			return;
		}
		const a = actor ?? this.defaultActor();
		try { await this.authorizeOpeningActor(s, a); }
		catch (error) { await store.close(id); throw error; }
		this.sessions.set(id, s);
		this.watchWriter(s);
		s.reopening = true;
		try {
			await this.erasure.reconcilePending(s);
			await this.recoverSecrets(s);
		}
		catch (error) { this.sessions.delete(id); await this.closeWriter(s); throw error; }
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
					if (s.suspended || (error as { code?: string }).code !== "conflict") { this.sessions.delete(id); await this.closeWriter(s); throw error; }
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
		await this.recoverInterfaceCalls(s);
		await this.approvals.reconcileApprovals(s, true);
		await this.recoverInterruptedTurn(s);
		await this.recoverReports(s);
		s.reopening = false;
		this.startQueued(s);
		this.emit(s, "session.started", { meta: s.meta, resumed: true }, "harness");
		// Questions left open past their turn are still answerable after a restart.
		for (const request of this.waitingRequests(s)) {
			this.emit(s, "input.request.opened", { request, waiting: true }, "harness", { toolCallId: request.toolCallId });
			for (const i of this.viewersFor(s, request)) i.onInputRequest?.(request);
		}
		this.maybeContinueOpenCalls(s);
		return id;
	}

	/** Check the operator's creation ceiling before allocating a provisional session. */
	tenantAllows(tenant: string | undefined, right: Authority): boolean {
		return tenant === undefined || this.tenants.get(tenant)?.rights.includes(right) === true;
	}

	/** Discovery is the open authority check without joining or taking a writer lease. */
	async canDiscoverSession(id: string, actor: Actor, severalActors: boolean): Promise<boolean> {
		const s = this.sessions.get(id) ?? await this.loadInto(id);
		return !!s && this.discoveryRights(s, actor, severalActors).includes("watch");
	}

	/** A host read never joins the viewer, takes a writer or starts recovery. Capture the
	 * branch, the commit offset and effective rights without yielding between them. */
	async hostView(id: string, actor: Actor, scope: (project: string, tenant: string | null) => boolean) {
		const live = this.sessions.get(id);
		const s = live && !live.closed && !live.suspended ? live : await this.loadInto(id);
		if (!s || !scope(s.meta.project, s.tenant ?? null)) throw failure("not_found", "Thread not found");
		const freshness = await this.erasure.admitHistory(s);
		const rights = this.discoveryRights(s, actor, false);
		if (!rights.includes("watch")) throw failure("not_found", "Thread not found");
		const order = s.order.slice();
		return { records:s.branch(), order, all:order.map(id=>s.entries.get(id)!), rights, live:s === live, kept:!s.ephemeral && this.use<HistoryStore>("history-store")?.supports.persistent !== false,
			generation:createHash("sha256").update(JSON.stringify([freshness, order.filter(id => { const e = s.entries.get(id)!; return e.kind === "position" || e.erased; })])).digest("hex") };
	}

	private discoveryRights(s: Session, actor: Actor, allowJoin: boolean): Authority[] {
		if (s.tenant !== undefined && !this.tenants.has(s.tenant)) return [];
		if (s.actors.has(actor.id)) return this.actorRights(s, actor.id).filter(right => actor.authority.includes(right));
		if (!allowJoin || s.order.some(id => {
			const e = s.entries.get(id)!;
			return e.kind === "actorLeft" && (e.data as { actorId?: string } | undefined)?.actorId === actor.id;
		})) return [];
		return actor.authority.filter(right => this.withinLimits(s, right) && (!s.meta.parentSessionId || right === "watch"));
	}

	private async sessionSummary(id: string, viewer: ListingViewer): Promise<SessionSummary | undefined> {
		const store = this.use<HistoryStore>("history-store");
		if (!store || store.supports.persistent !== true && store.supports.portableSessions !== true) return;
		const live = this.sessions.get(id);
		const s = live && !live.interruption.signal.aborted ? live : await this.loadInto(id).catch(error => {
			if (["not_found", "ENOENT", "unknown_session"].includes(error?.code)) return undefined;
			throw error;
		});
		if (!s || s.ephemeral || s.provisional || viewer.scope && !viewer.scope(s.meta.project, s.tenant)) return;
		await this.erasure.admitHistory(s);
		const rights = this.discoveryRights(s, viewer.actor, viewer.allowJoin);
		if (!rights.includes("watch")) return;
		const branch = s.branch(), start = this.unfinishedTurn(s, branch);
		const running = start && (s === live ? s.running?.turnId === start.turnId && !s.suspended : store.writerActive?.(id));
		const turn = !start ? "none" : running ? "running" : "interrupted";
		const questions = this.recordedOpenQuestionEntries(s, branch).filter(e => {
			if (s.copied.has(e.id)) return false;
			const r = readRequest(e);
			const inTurn = !!r.turnId && r.turnId === start?.turnId;
			if (inTurn && viewer.inTurn !== true && !viewer.inTurn?.includes(r.id) ||
				r.kind === "approval" && !inTurn && !(r.approvalWait === "untilDeadline" && this.approvals.maximum && waitingApprovals(s).get(r.toolCallId!)?.end) || r.kind === "secret" && !viewer.secrets ||
				r.timeLimitMs !== undefined && r.whenTimeLimit !== "leaveOpen" && this.now() >= e.time + r.timeLimitMs) return false;
			const right = r.kind === "approval" ? "approve" : "answer";
			if (!rights.includes(right)) return false;
			if (!r.answerers.length || r.answerers.includes(viewer.actor.id)) return true;
			return viewer.represented?.some(actorId => r.answerers.includes(actorId) && this.actorRights(s, actorId).includes(right) &&
				(!inTurn || viewer.present?.includes(actorId)));
		}).length;
		const toolCalls = !viewer.routeId || !rights.includes("tools") ? 0 : this.unsettledHandoffs(s).filter(({data, checkpoint}) => {
			if (!data || data.routeId !== viewer.routeId || data.executorActorId !== viewer.actor.id || data.deadline <= this.now() ||
				!branch.some(e => e === checkpoint)) return false;
			const end = branch.find(e => e.kind === "turnEnd" && e.turnId === checkpoint!.turnId);
			return !end || !end.erased && (end.data as TurnOutcome).result?.openToolCalls?.includes(checkpoint!.toolCallId!);
		}).length;
		return { id, project:s.meta.project, tenant:s.tenant, updated:s.entries.get(s.order.at(-1)!)?.time ?? s.meta.created,
			waiting:{questions, toolCalls, turn} };
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
			const job = this.jobWork.readJob(s, e);
			return job ? [[job.job.id, job] as const] : [];
		}));
		for (const end of entries) {
			if (!end.jobId || end.kind !== "jobEnded" || end.erased || !(end.data as { report?: boolean })?.report) continue;
			const job = jobs.get(end.jobId);
			if (job) await this.jobWork.reportJob(s, job, end);
		}
	}

	private unfinishedTurn(s: Session, branch: HistoryEntry[]) {
		const start = branch.findLast(e => e.kind === "turnStart" && !e.erased && !s.copied.has(e.id));
		return start?.turnId && !s.order.some(id => {
			const e = s.entries.get(id)!;
			return e.kind === "turnEnd" && e.turnId === start.turnId;
		}) ? start : undefined;
	}

	/** Find a turn whose process stopped, and hand it to the Runtime, which decides what happens to it. */
	private async recoverInterruptedTurn(s: Session): Promise<void> {
		const branch = s.branch();
		const lastStart = this.unfinishedTurn(s, branch);
		if (!lastStart?.turnId) return;
		const snapshot = recordedSnapshot(lastStart);
		const pending = new Map((lastStart.continuesTurnId ? this.openCalls(s, lastStart.continuesTurnId) : []).map((c) => [c.id, c]));
		for (const c of interruptedCalls(branch, lastStart.turnId)) pending.set(c.id, c);
		// This host has no restart-time cleanup confirmation from its environments.
		const settled = new Set(s.order.map((id) => s.entries.get(id)!).filter((e) => e.kind === "toolResult").map((e) => e.toolCallId));
		const calls = [...pending.values()].filter((c) => !settled.has(c.id)).map((c) => ({ ...c, safeToRepeat: false }));
		const interrupted: InterruptedTurn = { turnId: lastStart.turnId, calls };
		this.emit(s, "turn.interrupted", { pending: interrupted.calls.length }, "harness", { turnId: interrupted.turnId });
		// Not awaited: the resumed turn may wait for an answer that only an Interface opened after this can give.
		void connectionRights.exit(() => this.launch(s, interrupted.turnId, (signal) => this.resumeTurn(s, interrupted, snapshot, signal)));
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
		await this.erasure.admitHistory(s);
		if (s.erasing) throw failure("busy", "Erasure is in progress");
		// Forking at unfinished work would copy work that is still running: refused.
		if (s.running || this.jobWork.runningJobs(s).length || this.waitingRequests(s).length || this.openCalls(s).length || this.unsettledHandoffs(s).length) throw failure("busy", "Can't fork while the session has unfinished work: a running turn, a job, or a call waiting for an answer");
		const target = s.entries.get(entryId);
		if (!target) throw Object.assign(new Error("Unknown fork target"), { code: "not_found" });
		if (target.kind === "position") throw Object.assign(new Error("Cannot fork a position record"), { code: "conflict" });
		const id = await this.startSession({ forkFrom: { sessionId, entryId }, actor: [...s.actors.values()][0] });
		await this.suspendSession(id);
		return id;
	}

	private stopSessionWork(s: Session): void {
		s.suspended = true;
		this.clearInterfaceWork(s);
		this.jobWork.endJobObservation(s);
		s.steering = [];
		s.followUps = [];
		s.running?.abort.abort();
		for (const r of s.requests.values()) void r.resolve({ requestId: r.request.id, declined: true, actorId: "harness", reason: "the process stopped" });
		s.requests.clear();
	}

	private async suspendSession(id: string): Promise<void> {
		const s = this.sessions.get(id);
		if (!s) return;
		this.stopSessionWork(s);
		// A stopping process doesn't wait for its work to finish. Nothing more is recorded once suspended.
		await this.retireSession(s);
	}

	private async retireSession(s: Session): Promise<void> {
		await s.committing;
		await this.closeWriter(s);
		this.sessions.delete(s.id);
	}

	private async closeWriter(s: Session): Promise<void> {
		s.unwatchWriter?.();
		if (!s.provisional) await this.use<HistoryStore>("history-store")?.close(s.id);
	}

	private watchWriter(s: Session): void {
		if (s.ephemeral || s.provisional) return;
		const signal = this.use<HistoryStore>("history-store")?.writerSignal?.(s.id);
		if (!signal) return;
		const subscription = addAbortListener(signal, () => this.interruptSession(s, "writerLost", signal.reason));
		s.unwatchWriter = () => subscription[Symbol.dispose]();
	}

	private interruptSession(s: Session, reason: SessionInterruptionReason, cause: unknown): void {
		if (s.suspended || s.closed) return;
		// Stop admission synchronously, before notifying anyone or waking a waiting call.
		s.suspended = true;
		this.emit(s, "session.interrupted", { reason }, "harness");
		this.jobWork.endJobObservation(s);
		s.interruption.abort(Object.assign(failure("lost", "Session was interrupted; reopen it to recover"), { cause }));
		this.stopSessionWork(s);
		for (const record of s.jobs.values()) void this.jobWork.cancelJob(s, record.job.id).catch(error => this.problem(record.job.plugin, "cancel interrupted job", error));
	}

	private checkWriter(s: Session): void {
		s.interruption.signal.throwIfAborted();
		if (s.ephemeral || s.provisional) return;
		const store = this.use<HistoryStore>("history-store");
		try {
			store?.writerSignal?.(s.id)?.throwIfAborted();
			store?.checkWriter?.(s.id);
		} catch (error) {
			this.interruptSession(s, "writerLost", error);
			s.interruption.signal.throwIfAborted();
			throw error;
		}
	}

	private async write(s: Session, mutation: () => Promise<void> | undefined): Promise<void> {
		this.checkWriter(s);
		try { await mutation(); }
		catch (error) {
			const writerLost = this.use<HistoryStore>("history-store")?.writerSignal?.(s.id)?.aborted || (error as { code?: string })?.code === "lost";
			this.interruptSession(s, writerLost ? "writerLost" : "commitFailed", error);
			s.interruption.signal.throwIfAborted();
			throw error;
		}
		s.interruption.signal.throwIfAborted();
	}

	async closeSession(id: string, actorId?: string, delegatedBy?: string, authority?: readonly Authority[]): Promise<void> {
		return startOperation("modular_agent.session.close", { ...conversation(id), "modular_agent.session.operation": "close" })
			.observe(() => this.closeSessionWithin(id, actorId, delegatedBy, authority));
	}

	private async closeSessionWithin(id: string, actorId?: string, delegatedBy?: string, authority?: readonly Authority[]): Promise<void> {
		const s = this.sessions.get(id);
		if (!s) return;
		await this.admit(s, async () => {
			if (s.closing || s.reopening) throw Object.assign(new Error("Session is busy"), { code: "busy" });
			const needsCancel = !!s.running || this.jobWork.runningJobs(s).length > 0 || this.unsettledHandoffs(s).length > 0;
			if ((needsCancel && authority && !authority.includes("cancel")) || [actorId, delegatedBy].some(id => id !== undefined &&
				(!s.actors.has(id) || (needsCancel && !this.rightsOf(s, id).includes("cancel"))))) {
				throw Object.assign(new Error("Actor may not close this session"), { code: "forbidden" });
			}
			s.closing = true;
		});
		if (!s.interruption.signal.aborted) {
			await this.cancel(id);
			for (const { job } of this.jobWork.runningJobs(s)) await this.jobWork.cancelJob(s, job.id);
		}
		for (const r of s.requests.values()) r.resolve({ requestId: r.request.id, declined: true, actorId: "harness", reason: "session closed" });
		s.requests.clear();
		await this.hooks.observe("session.end", { sessionId: id });
		await this.use<WorkingEnvironment>("working-environment")?.sessionEnded?.(id);
		this.emit(id, "session.ended", {}, "harness");
		s.closed = true;
		this.clearInterfaceWork(s);
		await this.retireSession(s);
	}

	// ---------- the record ----------

	/** Commit drafts to the session. All are kept, or none are. */
	commit(s: Session, drafts: EntryDraft[], pluginRecord = false, guard?: () => boolean | Promise<boolean>): Promise<HistoryEntry[]> {
		// A suspended session's process has stopped: nothing more is recorded for it here.
		const run = s.committing.then(() => {
			const registry = this.erasure.pendingRegistry();
			const write = async () => guard && !await guard() ? [] : this.commitNow(s, drafts, pluginRecord);
			return registry ? registry.exclusive(write) : write();
		});
		s.committing = run.catch(() => undefined);
		return run;
	}

	private async observeCommit<T>(s: Session, count: number, work: (span: Operation) => Promise<T>): Promise<T> {
		const span = startOperation("modular_agent.history.commit", { ...conversation(s.id), "modular_agent.history.entry.count": count });
		try {
			const result = await span.run(() => work(span));
			span.set("modular_agent.history.commit.status", s.suspended ? "failed" : "committed");
			return result;
		} catch (error) {
			const status = (error as { code?: string }).code === "lost" ? "uncertain" : "failed";
			span.set("modular_agent.history.commit.status", status);
			span.fail(status);
			throw error;
		} finally { span.end(); }
	}

	private commitNow(s: Session, drafts: EntryDraft[], pluginRecord = false): Promise<HistoryEntry[]> {
		return this.observeCommit(s, drafts.length, span => this.commitBatch(s, drafts, pluginRecord, span));
	}

	private async commitBatch(s: Session, drafts: EntryDraft[], pluginRecord: boolean, span: Operation): Promise<HistoryEntry[]> {
		s.interruption.signal.throwIfAborted();
		if (s.suspended) return [];
		const op = this.receiptOperation.getStore();
		const first = !pluginRecord && op && !op.bound && op.thread === s.id && drafts.find(d => d.actorId === op.actor && (
			d.kind === "inputAccepted" && (d.data as {key?:string})?.key === op.key ||
			d.kind === "inputAnswer" && op.answers.has(d.requestId!) || d.kind === "toolResult" && op.reports.has(d.toolCallId!)));
		if (first) {
			if (s.entries.has(op.id)) throw failure("conflict", "Run already accepted");
			// Use the operation's own entry as the commit witness, including in a mixed batch.
			const previous = first.id;
			first.id = op.id;
			if (previous) for (const d of drafts) if (d.sources) d.sources = d.sources.map(id => id === previous ? op.id : id);
			this.receipts.reserve(s.id, op.id);
		}
		const firstAdmission = s.provisional && drafts.some(d => d.kind === "inputAccepted");
		if (s.provisional && !firstAdmission && drafts.some(d => !PROVISIONAL_SETUP.has(d.kind))) {
			throw failure("invalid_request", "Session has not admitted its first input");
		}
		let position = s.position;
		const entries: HistoryEntry[] = drafts.map((d) => {
			const entry: HistoryEntry = { ...d, id: d.id ?? this.newId(), parentId: position, sessionId: s.id, time: this.now() };
			if (entry.kind === "setting") {
				const setting = normalizeSetting(entry.data as { key: string; value: unknown });
				const changes = setting.key === "settings" ? setting.value : { [setting.key]: setting.value };
				if (changes && typeof changes === "object" && "approvalWait" in changes) {
					if (!this.approvals.maximum) throw failure("not_supported", "Waiting approvals are not enabled");
					if (changes.approvalWait !== "live" && changes.approvalWait !== "untilDeadline") throw failure("invalid_params", "Invalid approvalWait setting");
				}
				entry.data = setting;
			}
			if (pluginRecord && (entry.kind === "toolPending" || entry.kind === INTERFACE_HANDOFF)) throw failure("invalid_request", "Only the Harness records pending calls");
			if (entry.kind === "inputRequest") {
				const request = (entry.data as { request?: InputRequest })?.request;
				if (pluginRecord && request?.coversNested !== undefined) throw failure("invalid_request", "Only the approval gate sets coverage");
				if (request?.approvalWait !== undefined) {
					if (pluginRecord || request.approvalWait !== "untilDeadline") throw failure("invalid_request", "Only the approval gate can park a call");
				}
				if (request?.timeLimitMs !== undefined) {
					request.deadlineAt = entry.time + request.timeLimitMs;
					if (!Number.isSafeInteger(request.timeLimitMs) || request.timeLimitMs < 0 || !Number.isSafeInteger(request.deadlineAt)) throw failure("invalid_request", "Unrepresentable question deadline");
				}
			}
			if (pluginRecord && entry.kind === "inputAnswer" && entry.data && typeof entry.data === "object" && "approvalView" in entry.data) throw failure("invalid_request", "Only the Harness can attest to delivery");
			if (!STANDARD_ENTRY_KINDS.has(entry.kind) && !entry.kind.includes(".")) entry.kind = `${entry.writer}.${entry.kind}`;
			position = entry.kind === "position" ? (entry.data as { to: string | null }).to : entry.id;
			return entry;
		});
		const bytes = entries.reduce((sum, entry) => sum + resourceBytes(entry), 0);
		const bounds = this.reservations.limits;
		if (entries.some(entry => resourceBytes(entry) > bounds.entryBytes) || bytes > bounds.batchBytes) {
			const error = failure("result_too_large", "History batch or entry exceeds the write size limit");
			if (entries.some(entry => ["turnEnd", "toolResult", "inputAnswer", "inputHandedBack", "jobEnded", "response"].includes(entry.kind))) {
				this.interruptSession(s, "commitFailed", error);
				throw failure("lost", "Required history record did not fit");
			}
			throw error;
		}
		const inputId = entries.find(e => e.kind === "input" && e.turnId)?.inputId;
		const allocations = entries.map(entry => {
			const control = !pluginRecord && ["actorLeft", "limit", "erasure", "jobCleanupUnconfirmed", "inputHandedBack"].includes(entry.kind);
			const keys: string[] = [];
			const add = (kind: string, id: string | undefined) => { if (id) keys.push(`${kind}:${id}`); };
			if (!pluginRecord) switch (entry.kind) {
				case "input": case "inputAccepted": case "inputHandedBack":
					add("input", inputIdOf(entry)); add("job", entry.jobId); break;
				case "turnStart": add("input", inputId); add("turn", entry.turnId); break;
				case TURN_TRACE: add("turn", entry.turnId); break;
				case "turnEnd":
					add("turn", entry.turnId); break;
				case "modelRequest": case "response":
					add("model", entry.stepId); break;
				case "jobStarted": case "jobEnded": case "jobCleanupUnconfirmed":
					add("job", entry.jobId); break;
				case "toolStarted": case "toolResult": case "toolPending": case INTERFACE_HANDOFF: case "modular-agent.nestedCall":
					add("call", entry.toolCallId); break;
				case "inputRequest": case "inputAnswer": case "secretAnswerAccepted":
					add("question", entry.requestId); break;
			}
			return { bytes: resourceBytes(entry), keys, control };
		});
		if (!this.reservations.writeBatch(s, allocations)) {
			const error = failure("busy", "No history capacity for this write");
			if (entries.some(e => ["turnEnd", "toolResult", "inputAnswer", "inputHandedBack", "jobEnded", "response"].includes(e.kind))) {
				this.interruptSession(s, "commitFailed", error);
				throw failure("lost", "Required history write could not be covered");
			}
			throw error;
		}
		if (firstAdmission) {
			const store = this.use<HistoryStore>("history-store")!;
			const initial = [...s.order.map(id => s.entries.get(id)!), ...entries];
			span.set("modular_agent.history.entry.count", initial.length);
			await this.write(s, async () => {
				await store.create(s.meta);
				await store.openForWriting(s.id);
				s.provisional = false;
				this.watchWriter(s);
				this.checkWriter(s);
				await store.append(s.id, initial);
			});
		} else if (!s.ephemeral && !s.provisional) {
			const store = this.use<HistoryStore>("history-store");
			await this.write(s, () => store?.append(s.id, entries));
		}
		if (first) op.bound = true;
		for (const e of entries) {
			// Attribute a closure to revocation only when this authority commit
			// actually removes the last eligible route. Presence changes are not grants.
			const routes = ["actorJoined","actorLeft","limit"].includes(e.kind)
				? this.recordedOpenRequests(s).map(r => [r,this.hasQuestionRoute(s,r)] as const) : [];
			s.apply(e);
			for (const [r, previouslyEligible] of routes) {
				if (this.hasQuestionRoute(s,r)) s.revokedQuestions.delete(r.id);
				else if (previouslyEligible) s.revokedQuestions.add(r.id);
			}
			if (e.kind === "inputAnswer") s.revokedQuestions.delete(e.requestId!);
			const inputId = inputIdOf(e);
			if (inputId && e.kind === "input" && e.turnId) {
				const unit = this.reservations.limits.settlementBytes;
				if (this.reservations.has(s, `turn:${e.turnId}`)) this.reservations.release(s, `input:${inputId}`);
				else this.reservations.transfer(s, `input:${inputId}`, `turn:${e.turnId}`, { storageBytes: 2 * unit });
			}
			if (inputId && e.kind === "inputHandedBack") this.reservations.release(s, `input:${inputId}`);
			if (e.kind === "turnEnd" && e.turnId) {
				this.reservations.release(s, `turn:${e.turnId}`);
				for (const id of s.order) {
					const kept = s.entries.get(id)!;
					if (kept.turnId === e.turnId && kept.stepId && kept.kind === "modelRequest") this.reservations.release(s, `model:${kept.stepId}`);
				}
			}
			if (e.kind === "response" && e.stepId) this.reservations.release(s, `model:${e.stepId}`);
			if (e.kind === "inputAnswer" && e.requestId) this.reservations.release(s, `question:${e.requestId}`);
			if (e.kind === "toolResult" && e.toolCallId) this.reservations.release(s, `call:${e.toolCallId}`);
			const ids = { turnId: e.turnId, stepId: e.stepId, toolCallId: e.toolCallId, actorId: e.actorId };
			this.emit(s, "entry.added", e, e.writer, ids);
			if (e.kind === "response" && e.turnId && e.modelVisible && e.message?.role === "assistant") {
				for (const part of e.message.content.filter(isToolCall)) {
					const call: ToolCall = { id: part.id, name: part.name, input: part.arguments, startedBy: "model", stepId: e.stepId };
					this.emit(s, "tool.call", { call }, e.writer, { ...ids, toolCallId: part.id });
				}
			}
			if (e.kind === "toolResult" && e.toolCallId && e.message?.role === "toolResult") {
				const data = e.data as { status?: string; value?: unknown } | undefined;
				this.emit(s, "tool.result.delivered", { status: data?.status ?? "failed", content: e.message.content,
					...(data && "value" in data ? { value: data.value } : {}) }, "harness", ids);
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
		if (drafts.length) await this.commit(s, drafts, true);
		for (const o of inputs) await this.input(s.id, o);
	}

	private async setSetting(s: Session, key: string, value: unknown, writer: string, actorId?: string): Promise<void> {
		if (actorId) this.requireAuthority(s, actorId, "settings");
		if (this.settingsDuringTurn === "refused" && s.isBusy()) throw Object.assign(new Error("Cannot change settings during a turn"), { code: "busy" });
		await this.commit(s, [{ kind: "setting", writer, actorId, modelVisible: false, data: { key, value } }]);
		if (s.hasWaitingApprovals) await this.approvals.reconcileApprovals(s);
		this.emit(s, "setting.changed", { key, value, appliesFrom: this.settingsDuringTurn === "nextTurn" ? "next turn" : "next step" }, writer, { actorId });
	}

	private async moveTo(sessionId: string, entryId: string, options: { rewind?: boolean; actorId?: string }, writer: string): Promise<{ outOfReach?: string[] }> {
		const s = this.session(sessionId);
		return this.admit(s, async () => {
			if (options.actorId) this.requireAuthority(s, options.actorId, "settings");
			if (s.provisional) throw failure("invalid_request", "Session has not admitted its first input");
			if (s.isBusy() || s.outsideTools || s.erasing || s.settling || s.requests.size || this.waitingRequests(s).length || this.openCalls(s).length || this.unsettledHandoffs(s).length || this.jobWork.runningJobs(s).length) {
				throw failure("busy", "Can't move while work is unfinished");
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
					if (!env || !(env.keepsPoints?.(this.projectOf(s)) ?? env.points) || !env.restore || !env.save || !env.hasPoint) throw failure("not_supported", "This environment cannot rewind");
					const branch = s.branch();
					const at = branch.findIndex((e) => e.id === entryId);
					if (at < 0) throw failure("conflict", "Rewind needs an entry on the current branch");
					const after = branch.slice(at + 1);
					if (after.some((e) => e.kind === "jobStarted" || e.kind === "harness.jobStarted" || e.kind === "jobEnded")) throw failure("conflict", "Cannot rewind past a job");
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
				this.emit(s, "position.moved", { to: entryId }, writer);
				return outOfReach.length ? { outOfReach: [...new Set(outOfReach)] } : {};
			} finally { s.moving = false; }
		});
	}

	private async completeRewind(s: Session, to: string | null, previous: string | null, restore: { point: string; undo: string }, undoing: boolean): Promise<void> {
		const move = (target: string | null, intent?: typeof restore) => this.commit(s, [{ kind: "position", writer: "harness", modelVisible: false, data: { to: target, ...(intent ? { restore: intent } : {}) } }]);
		const env = await this.environmentFor(s);
		if (!env?.restore || !env.hasPoint || !(env.keepsPoints?.(this.projectOf(s)) ?? env.points)) { s.suspended = true; throw failure("lost", "Rewind environment unavailable"); }
		const verify = async (point: string) => {
			try {
				if (!await env.hasPoint!(point)) throw failure("conflict", "Cannot verify ownership of rewind point");
			} catch (error) { s.suspended = true; throw error; }
		};
		await verify(restore.point);
		const check = () => this.checkWriter(s);
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

	private inspectHistory<T>(id: string, options: { all?: boolean }, inspect: (entries: HistoryEntry[]) => T): T | Promise<T> {
		const s = this.session(id);
		const snapshot = () => {
			this.checkScopedWork(s, "watch");
			return inspect(options.all ? s.order.map(id => s.entries.get(id)!) : s.branch());
		};
		if (this.erasure.httpErasure() && !s.provisional) return this.erasure.admitHistory(s).then(snapshot);
		this.erasure.checkPending(s);
		return snapshot();
	}


	// ---------- authority ----------

	/** Authority only narrows: a granted actor can do no more than whoever grants it. */
	private async join(s: Session, actor: Actor, grantedBy: string, writer: string): Promise<void> {
		this.requireAuthority(s, grantedBy, "grant");
		const beyond = actor.authority.filter((a) => !ALL_AUTHORITY.includes(a) || !this.rightsOf(s, grantedBy).includes(a));
		if (beyond.length) throw Object.assign(new Error(`${grantedBy} can't grant ${beyond.join(", ")}`), { code: "forbidden" });
		await this.commit(s, [actorJoined(actor, writer, grantedBy)]);
		await this.hooks.observe("session.join", { sessionId: s.id, actorId: actor.id, actor, grantedBy });
		this.emit(s, "session.joined", { actor }, writer, { actorId: actor.id });
		await this.closeRevokedWaits(s);
		await this.approvals.reconcileApprovals(s);
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

	/** Apply the token ceiling to this connection's operations without rewriting recorded grants. */
	withConnectionActor<T>(actor: Actor, run: () => T): T {
		return this.turnAuthority.exit(() => connectionRights.run({ [actor.id]: [...actor.authority] }, run));
	}

	private actorRights(s: Session, actorId: string): Authority[] {
		const scope = this.turnAuthority.getStore();
		const ceilings = [connectionRights.getStore(), scope?.state?.connectionRights].flatMap(rights =>
			rights && Object.hasOwn(rights, actorId) ? [rights[actorId]] : []);
		const allowed = (s.actors.get(actorId)?.authority ?? []).filter(right => ceilings.every(ceiling => ceiling.includes(right)) && this.withinLimits(s, right));
		if (!s.meta.parentSessionId) return allowed;
		const parent = this.sessions.get(s.meta.parentSessionId);
		const link = s.order.map((id) => s.entries.get(id)!).find((e) => e.kind === "harness.parentAuthority");
		const work = link?.data as { actors?: string[]; jobs?: string[]; rights?: Authority[] } | undefined;
		return allowed.filter((right) => parent
			? (work?.rights ?? ["watch"]).includes(right) && this.workRights(parent, work?.actors ?? [], work?.jobs).includes(right)
			: right === "watch");
	}

	private actorForJob(s: Session, jobs?: Set<string>): string | undefined {
		return s.order.map((id) => s.entries.get(id)!).find((e) => e.kind === "jobStarted" && e.jobId && jobs?.has(e.jobId))?.actorId;
	}

	private workRights(s: Session, actors: Iterable<string>, jobs: Iterable<string> = []): Authority[] {
		const owners = [...actors].map((id) => this.actorRights(s, id));
		const recordedJobs = [...jobs].map((jobId) => {
			const start = s.order.map((id) => s.entries.get(id)!).find((e) => e.jobId === jobId && e.kind === "jobStarted");
			const kept = s.jobs.get(jobId) ?? (start && this.jobWork.readJob(s, start));
			return { rights: kept?.rights ?? ["watch"], ancestors: [...new Set([...(kept?.actors ?? []), ...(kept?.job.actorId ? [kept.job.actorId] : [])])].map((id) => this.actorRights(s, id)) };
		});
		const scope = this.turnAuthority.getStore();
		const starting = scope?.sessionId === s.id ? scope.state?.startingRights : undefined;
		return ALL_AUTHORITY.filter((right) => (!starting || starting.includes(right)) && this.withinLimits(s, right) &&
			owners.every((owner) => owner.includes(right)) &&
			recordedJobs.every((job) => job.rights.includes(right) && job.ancestors.every((owner) => owner.includes(right))));
	}

	private checkScopedWork(s: Session, right: Authority): void {
		const work = this.turnAuthority.getStore();
		if (work?.sessionId === s.id && (!work.actors.size && !work.jobs.size || !this.workRights(s, work.actors, work.jobs).includes(right))) {
			throw failure("forbidden", `Starting work cannot ${right}`);
		}
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
			await this.closeRevokedWaits(s);
			await this.approvals.reconcileApprovals(s);
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
				if (e.erased || !e.turnId && !e.stepId) continue;
				if (e.kind === "turnEnd" && e.turnId) {
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
		const span = startOperation("modular_agent.input.admit", conversation(sessionId));
		try {
			const receipt = await span.run(() => this.inputWithin(sessionId, options));
			span.set("modular_agent.input.id", receipt.inputId);
			return receipt;
		} catch (error) {
			if ((error as { code?: string }).code === "busy") span.event("modular_agent.capacity.refused", {});
			throw error;
		} finally { span.end(); }
	}

	private async inputWithin(sessionId: string, options: InputOptions): Promise<InputReceipt & { handled?: boolean; output?: string }> {
		const s = this.session(sessionId);
		await this.erasure.reconcilePending(s);
		this.checkWriter(s);
		if (s.erasing) throw failure("busy", "Erasure is in progress");
		const right = options.when === "propose" ? "propose" : "input";
		this.checkScopedWork(s, right);
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
		const typed = textOf(content).trimStart();
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
		if (s.erasing) throw failure("busy", "Erasure is in progress");
		if (transformed.stopped) {
			const inputId = this.newId();
			if (this.receiptOperation.getStore()) {
				await this.commit(s, [
					{kind:"inputAccepted", writer:"harness", modelVisible:false, inputId, actorId:options.actorId,
						data:{key:options.key, when:"now", taken:"now", content}},
					{kind:"inputHandedBack", writer:"harness", modelVisible:false, inputId, data:{reason:"handled"}},
				]);
			}
			let output: string | void = undefined;
			const command = transformed.command;
			if (command !== undefined) {
				if (right !== "input") throw Object.assign(new Error("A proposal cannot run a command"), { code: "forbidden" });
				if (options.delegatedBy) this.requireAuthority(s, options.delegatedBy, "input");
				output = await this.runCommand(sessionId, command, options.actorId);
			}
			const receipt = { inputId, taken: "now" as const, handled: true, ...(output === undefined ? {} : { output }) };
			if (scoped) s.keys.set(scoped, receipt);
			return receipt;
		}
		content = transformed.value.content;
		const queued: QueuedInput = {
			id: this.newId(), content, actorId: options.actorId, when: options.when ?? "now", key: options.key,
			resultShape: options.resultShape,
			connectionRights: connectionRights.getStore(),
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
			if (queued.startedBy.kind !== "job") queued.connectionRights = Object.fromEntries(inputActors(queued).map(id => [id, this.rightsOf(s, id)]));
			return this.acceptInput(s, queued);
		});
	}

	/** Serialize receipts, release and cancellation for a session. */
	private admit<T>(s: Session, work: () => Promise<T>): Promise<T> {
		const wait = s.admissionsInFlight++ > 0 ? startOperation("modular_agent.capacity.wait", {
			...conversation(s.id), "modular_agent.capacity.scope": "session",
		}) : undefined;
		const run = s.admitting.then(() => { wait?.end(); return work(); }).finally(() => { s.admissionsInFlight--; });
		s.admitting = run.catch(() => undefined);
		return run;
	}

	private async acceptInput(s: Session, q: QueuedInput): Promise<InputReceipt> {
		if (s.closed) throw failure("not_open", "Session is closed");
		if (s.suspended) throw failure("lost", "Session has lost its writer");
		if (s.closing || s.erasing || s.moving) throw failure("busy", "Session cannot take input right now");
		if (this.rejectUnknownModel && q.startedBy.kind === "actor" && q.when !== "propose" && s.settings.model != null) {
			await this.providerFor(s)?.refreshModels?.();
			if (!this.modelAccess(s)) throw Object.assign(new Error("The selected model is not offered"), { code: "invalid_request" });
		}
		await this.erasure.admitHistory(s);
		if (q.startedBy.kind !== "job" && !q.releasedBy) {
			const right = q.when === "propose" ? "propose" : "input";
			for (const actor of inputActors(q)) this.requireAuthority(s, actor, right);
		}
		const authorizers = inputActors(q);
		q.startingRights ??= this.workRights(s, authorizers, q.startedBy.kind === "job" ? [q.startedBy.id] : []);
		const steer = q.when === "steer" && this.runtime()?.supports.inputDuringTurn === true && !s.running?.steeringClosed;
		const taken = q.when === "propose" ? "proposed" : !s.isBusy() && !s.reopening && !s.followUps.length ? "now" : steer && !s.reopening ? "inTurn" : "after";
		// A selected turn already owns this input; only input still waiting for
		// disposition takes a slot in the pending queue.
		this.reserveInput(s, q, false, taken === "now");
		try { await this.commit(s, [{
			kind: "inputAccepted", writer: "harness", modelVisible: false, actorId: q.actorId, inputId: q.id, sources: q.sources,
			jobId: q.startedBy.kind === "job" ? q.startedBy.id : undefined,
			data: { key: q.key, when: q.when, ...(q.startedBy.kind === "job" && !q.releasedBy ? { parked: q.when === "propose" } : {}), content: q.content, releasedBy: q.releasedBy, submittedBy: q.delegatedBy, taken, connectionRights: q.connectionRights, rights: q.startingRights,
				authorizers: authorizers.map(actorId => ({ sessionId: s.id, actorId })) },
		}]); }
		catch (error) {
			if (!s.interruption.signal.aborted) this.reservations.release(s, `input:${q.id}`);
			throw error;
		}
		q.trace ??= currentSpan();
		const offerScope = this.offerScope.getStore();
		if (offerScope) this.queuedOffers.set(q, offerScope);
		const receipt: InputReceipt = { inputId: q.id, taken };
		if (q.when !== "propose") {
			if (taken === "now") this.startTurn(s, q);
			else (taken === "inTurn" ? s.steering : s.followUps).push(q);
		}
		this.emit(s, "input.accepted", { inputId: q.id, taken }, "harness", { actorId: q.actorId });
		return receipt;
	}

	private releaseInput(s: Session, inputId: string, when: Exclude<InputTiming, "propose">, actorId: string, declined?: boolean): Promise<InputReceipt> {
		return this.admit(s, async () => {
			this.requireAuthority(s, actorId, "input");
			const q = s.proposals.get(inputId);
			if (!q) throw Object.assign(new Error(`No open proposal ${inputId}`), { code: "conflict" });
			const receipt = declined
				? (await this.handBack(s, [q], "declined"), { inputId, taken: "handedBack" as const })
				: await this.acceptInput(s, { ...q, when, releasedBy: actorId,
					connectionRights: intersectConnectionRights(q.connectionRights, { [actorId]: this.rightsOf(s, actorId) }),
					startingRights: intersectRights(q.startingRights ?? [], this.rightsOf(s, actorId)) });
			s.proposals.delete(inputId);
			return receipt;
		});
	}

	private withdrawProposal(s: Session, id: string, actorId: string, delegatedBy?: string): Promise<void> {
		return this.admit(s, async () => {
			const q = s.proposals.get(id);
			if (!q) throw Object.assign(new Error(`No open proposal ${id}`), { code: "conflict" });
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
		if (inputIds.length) await this.commit(s, inputIds.map((inputId) => ({ kind: "inputHandedBack", writer: "harness", modelVisible: false, inputId, data: { reason } })));
		for (const q of queued) this.emit(s, reason === "withdrawn" ? "input.withdrawn" : "input.handedBack",
			{ inputId: q.id, content: q.content, reason }, "harness");
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
			const handedBack = [...s.steering, ...s.followUps].filter(q => !q.continueTurnId);
			s.steering = [];
			s.followUps = [];
			const running = s.running;
			running?.abort.abort();
			const recorded = this.handBack(s, handedBack, "cancelled");
			for (const w of waitingApprovals(s).values()) if (!w.result && !w.start && !s.closing) await this.approvals.closeWaiting(s, w, "cancelled", "notStarted");
			for (const handoff of this.unsettledHandoffs(s)) await this.settleInterfaceCall(s, handoff);
			for (const r of [...s.requests.values()]) r.resolve({ requestId: r.request.id, declined: true, actorId: "harness", reason: "cancelled" });
			await recorded;
			return { handedBack, running };
		});
		await running?.done;
		if (this.interfaceSources.size || s.hasWaitingApprovals) this.maybeContinueOpenCalls(s);
		return handedBack;
	}

	private async waitForIdle(sessionId: string): Promise<void> {
		const s = this.session(sessionId);
		if (s.hasWaitingApprovals) await this.approvals.reconcileApprovals(s);
		await untilAborted(s.interruption.signal, async () => {
			while (!s.suspended && (s.running || s.settling)) {
				if (s.settling) await s.settling;
				if (s.running && !s.suspended) await s.running.done;
			}
		});
	}

	private runtime(): Runtime | undefined {
		return this.use<Runtime>("runtime");
	}

	private startTurn(s: Session, queued: QueuedInput): void {
		void connectionRights.exit(() => this.launch(s, this.newId(), (signal, turnId) => this.runTurn(s, queued, turnId, signal)));
	}

	/** Run a turn as the session's running turn, then start any queued input. */
	private launch(s: Session, turnId: string, body: (signal: AbortSignal, turnId: string) => Promise<void>): Promise<void> {
		const abort = new AbortController();
		const signal = AbortSignal.any([abort.signal, s.interruption.signal]);
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
		if (s.running || s.reopening || s.closed || s.closing || s.suspended || s.erasing || s.moving) return;
		const next = [...s.steering, ...s.followUps];
		s.steering = [];
		s.followUps = next.slice(1);
		if (next[0]) this.startTurn(s, next[0]);
	}

	private async runTurn(s: Session, queued: QueuedInput, turnId: string, signal: AbortSignal): Promise<void> {
		const continuesTurnId = queued.continueTurnId;
		if (continuesTurnId && !this.readyContinuations(s).some(item => item.origin === continuesTurnId)) return;
		const continuing = continuesTurnId ? this.openCalls(s, continuesTurnId) : undefined;
		if (continuesTurnId && !this.reservations.reserve(s, `turn:${turnId}`, { storageBytes: 3 * this.reservations.limits.settlementBytes })) {
			// No turn was admitted. Wake only exchanges waiting on this origin.
			this.emit(s, "continuation.refused", { code: "busy" }, "harness", { turnId: continuesTurnId });
			return;
		}
		const runtime = this.runtime();
		const ref = parseModel(s.settings.model);
		const model: ModelAccess | undefined = this.modelAccess(s, ref) ?? (ref ? {
			model: { ...ref, contextWindow: 0, maxOutput: 0, reasoning: false, input: ["text"] },
			supports: { keepsState: false, runsTools: false },
			request: async () => ({ role: "assistant", content: [], stop: "failed", error: { kind: "other", message: `Model ${ref.provider}/${ref.id} is not offered` } }),
		} : undefined);
		const settings = this.turnSettings(s, model?.model);
		const modelTools = s.settings.modelTools;
		const interfaceOffer = this.interfaceOffer(s, this.queuedOffers.get(queued));
		const tools = this.toolDefinitions(s).filter((t) => (!t.callers || t.callers.includes("model")) &&
			(!this.interfaceSources.has(t.name) || interfaceOffer.has(t.name)) &&
			(modelTools == null || (Array.isArray(modelTools) && modelTools.includes(t.name))));
		const resultShape = queued.resultShape ?? s.settings.resultShape as Record<string, unknown> | undefined;
		let point: string | undefined;
		const actors = new Set(inputActors(queued));
		const jobs = new Set([...(queued.authorityJobs ?? []), ...(queued.startedBy.kind === "job" ? [queued.startedBy.id] : [])]);
		const authority = { startingRights: queued.startingRights ?? [], connectionRights: queued.connectionRights };
		const withAuthority = <T>(work: () => T) => this.turnAuthority.run({ sessionId: s.id, actors, jobs, state: authority }, work);
		let contributions: { system?: string; context?: ContentPart[] }[] = [];
		let failure: string | undefined;
		let limited = false;
		try {
			limited = await this.tenantBudgetReached(s);
			if (!limited && !signal.aborted) {
				const env = await this.environmentFor(s);
				if (env?.save && (env.keepsPoints?.(this.projectOf(s)) ?? env.points)) {
					withAuthority(() => this.checkScopedWork(s, "watch"));
					await this.erasure.admitHistory(s);
					point = await env.save();
				}
				await this.erasure.admitHistory(s);
				contributions = await withAuthority(() => this.hooks.collect("turn.before", { sessionId: s.id, turnId, input: queued.content }));
			}
		} catch (error) { failure = String(error); }
		const context = contributions.flatMap((c) => c.context ?? []);
		let snapshot: TurnSnapshot = {
			model: ref ?? null,
			system: contributions.map((c) => c.system).filter(Boolean).join("\n\n"), tools, settings,
			...(context.length ? { context } : {}),
		};
		const unit = this.reservations.limits.settlementBytes;
		if (resourceBytes({ ...snapshot, resultShape, point }) + 2048 > unit) {
			failure = "Turn preparation exceeds reserved capacity";
			snapshot = { model: ref ?? null, system: "", settings: {}, tools: [] };
		}
		const state: TurnState = { ...snapshot, ...authority, interfaceOffer, interfaceAllowances: new Map(), dispatched: new Set(), steps: new Map(), sources: new Map(), actors, jobs };
		const span = this.turnSpan(s, turnId, queued.trace ?? null, undefined, continuesTurnId);
		return span.run(async () => {
			try {
				// Kept turns can be settled after a restart even if their Runtime
				// cannot resume them. Save the original segment for any persistent history.
				const store = this.use<HistoryStore>("history-store");
				const traceContext = store && store.supports.persistent !== false ? carrier(span.spanContext) : undefined;
				const [start] = await this.commit(s, [
					{ kind: "turnStart", writer: "harness", modelVisible: false, turnId, continuesTurnId, actorId: queued.actorId, sources: queued.sources, data: { ...snapshot, ...(traceContext ? { traceContext } : {}), startedBy: queued.startedBy, resultShape: failure ? undefined : resultShape, point, rights: state.startingRights,
						authorizers: [...actors].map(actorId => ({ sessionId: s.id, actorId })), ...(continuing ? { authorityActors: [...actors], authorityJobs: [...jobs] } : {}) } },
					...(continuing ? [] : [this.inputEntry(s, queued, turnId)]),
				]);
				if (start && span.spanContext) this.turnTraces.set(start, span.spanContext);
				this.emit(s, "turn.started", { startedBy: queued.startedBy }, "harness", { turnId });
				let outcome: TurnOutcome;
				if (limited) outcome = { outcome: { kind: "limit", limit: "tenantTokens" }, result: { openToolCalls: [] }, entries: [], usage: zeroUsage() };
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
			} finally { this.endSteps(state); span.end(); }
		});
	}

	private turnTraces = new WeakMap<HistoryEntry, NonNullable<ReturnType<typeof currentSpan>>>();

	private turnSpan(s: Session, turnId: string, parent: ReturnType<typeof readTrace> | null, resumed?: boolean, continuesTurnId?: string): Operation {
		const previous = continuesTurnId ? this.savedTrace(s, continuesTurnId) : undefined;
		const link = resumed ? parent : previous;
		return startOperation(this.agentName ? `invoke_agent ${this.agentName}` : "invoke_agent", {
			...conversation(s.id), "modular_agent.turn.id": turnId, "gen_ai.operation.name": "invoke_agent",
			"gen_ai.agent.name": this.agentName, "modular_agent.turn.outcome": "interrupted", "modular_agent.turn.resumed": resumed,
		}, { parent, links: link ? [link] : undefined });
	}

	private savedTrace(s: Session, turnId: string) {
		for (const entry of s.branch().reverse()) {
			if (entry.turnId !== turnId || entry.erased || s.copied.has(entry.id) || entry.writer !== "harness" ||
				(entry.kind !== "turnStart" && entry.kind !== TURN_TRACE)) continue;
			const saved = this.turnTraces.get(entry) ?? readTrace((entry.data as { traceContext?: unknown } | undefined)?.traceContext);
			if (saved) return saved;
		}
	}

	private async finishTurn(s: Session, turnId: string, outcome: TurnOutcome, state?: TurnState, signal?: AbortSignal, resultShape?: Record<string, unknown>): Promise<void> {
		if (state) this.endSteps(state);
		// The process stopped: the turn is interrupted, not ended. Nothing is recorded or announced here;
		// reopening the session finds the turn and hands it to the Runtime.
		if (s.suspended) return;
		if (state?.toolResultError && outcome.outcome.kind !== "limit" && outcome.outcome.kind !== "cancelled") {
			outcome = { ...outcome, outcome: { kind: "failed", error: state.toolResultError }, result: { openToolCalls: [] } };
		}
		if (state?.capacityLimit && outcome.outcome.kind !== "cancelled" && !signal?.aborted) {
			outcome = { ...outcome, outcome: { kind: "limit", limit: "capacity" } };
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
		const complete = async () => {
		for (const item of this.unsettledHandoffs(s)) {
			if ((item.checkpoint ?? item.start)?.turnId === turnId && (signal?.aborted || outcome.outcome.kind !== "completed" || !item.data || item.data.deadline <= this.now())) {
				await this.settleInterfaceCall(s, item);
			}
		}
		if (signal?.aborted && this.interfaceSources.size) outcome = { ...outcome, outcome: { kind: "cancelled" } };
		for (const w of waitingApprovals(s).values()) {
			if (w.entry.turnId === turnId && !w.result && !w.start && (signal?.aborted || outcome.outcome.kind !== "completed")) {
				await this.approvals.closeWaiting(s, w, signal?.aborted ? "cancelled" : "noLongerAnswerable", "notStarted");
			}
		}
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
		if (resourceBytes({ outcome: outcome.outcome, result: outcome.result, usage: outcome.usage, sources }) + 2048 > this.reservations.limits.settlementBytes) {
			this.problem("harness", "settle turn", failure("result_too_large", "Turn result exceeds reserved capacity"));
			outcome = { ...outcome, outcome: outcome.outcome.kind === "completed" ? { kind: "failed", error: "result_too_large" } : outcome.outcome,
				result: { openToolCalls: [...open] } };
		}
		await this.commit(s, [{ kind: "turnEnd", writer: "harness", modelVisible: false, turnId, sources, data: { outcome: outcome.outcome, result: outcome.result, usage: outcome.usage } }]);
		return open;
		};
		const open = this.interfaceSources.size ? await this.admit(s, complete) : await complete();
		activeOperation()?.set("modular_agent.turn.outcome", outcome.outcome.kind);
		if (outcome.outcome.kind === "failed") activeOperation()?.fail("failed");
		if (!state?.endedHook) await this.hooks.observe("turn.end", { sessionId: s.id, turnId, outcome: outcome.outcome, result: outcome.result });
		this.emit(s, "turn.ended", outcome, "harness", { turnId });
		if (s.hasWaitingApprovals) {
			await this.approvals.reconcileApprovals(s);
			for (const w of waitingApprovals(s).values()) if (w.end?.turnId === turnId && !w.decision && !w.result) {
				this.emit(s, "input.request.opened", { request: w.request, waiting: true }, "harness", { toolCallId: w.request.toolCallId });
				for (const i of this.viewersFor(s, w.request)) i.onInputRequest?.(w.request);
			}
		}
		if (open.size) this.maybeContinueOpenCalls(s);
	}

	private async resumeTurn(s: Session, interrupted: InterruptedTurn, snapshot: RecordedSnapshot, signal: AbortSignal): Promise<void> {
		const turnId = interrupted.turnId;
		if (!this.runtime()?.supports.continuesAfterRestart) return withTrace(undefined, () => this.resumeTurnWithin(s, interrupted, snapshot, signal));
		const saved = this.savedTrace(s, turnId);
		const span = this.turnSpan(s, turnId, saved ?? null, true);
		try {
			await span.run(async () => {
				const traceContext = carrier(span.spanContext);
				if (traceContext) await this.commit(s, [{ kind: TURN_TRACE, writer: "harness", turnId, modelVisible: false, data: { traceContext } }]);
				await this.resumeTurnWithin(s, interrupted, snapshot, signal);
			});
		} finally { span.end(); }
	}

	private async resumeTurnWithin(s: Session, interrupted: InterruptedTurn, snapshot: RecordedSnapshot, signal: AbortSignal): Promise<void> {
		const turnId = interrupted.turnId;
		const runtime = this.runtime();
		const model = this.modelAccess(s, snapshot.model);
		if (!runtime || !model) {
			const pending = new Set(pendingToolCalls(s.branch(), turnId, s.order.map((id) => s.entries.get(id)!)));
			await this.endInterruptedTurn(s, { turnId, calls: interrupted.calls.filter((c) => !pending.has(c.id)) });
			await this.finishTurn(s, turnId, this.failedOutcome("The process stopped during the turn"), undefined, signal);
			return;
		}
		const branch = s.branch();
		const state: TurnState = {
			model: model.model, system: snapshot.system, context: snapshot.context, tools: snapshot.tools,
			settings: { ...snapshot.settings, reasoning: lowerReasoning(snapshot.settings.reasoning, model.model) },
			dispatched: new Set(), steps: new Map(), sources: new Map(), actors: new Set(this.recordedTurnActors(branch, turnId)),
			jobs: new Set(this.recordedTurnJobs(branch, turnId)),
			startingRights: this.recordedTurnRights(branch, turnId),
			connectionRights: intersectConnectionRights(...branch.filter(e => e.turnId === turnId && e.kind === "input" && !e.erased)
				.map(e => (e.data as QueuedInput | undefined)?.connectionRights)),
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
					(offer?.data as { tools?: string[] } | undefined)?.tools?.includes(c.name) && state.startingRights?.includes("tools") && this.workRights(s, [...state.actors], state.jobs).includes("tools");
			});
			await this.endInterruptedTurn(s, { turnId, calls: calls.filter((c) => !eligible.includes(c)) });
			outcome = await runtime.resumeTurn(
				{ sessionId: s.id, turnId, startedBy: snapshot.startedBy, model: this.turnModel(s, turnId, state, model), settings: state.settings, resultShape: snapshot.resultShape },
				this.runtimeHost(s, turnId, state, snapshot.resultShape, runtime.supports.continuesAfterRestart === true),
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
		await this.finishTurn(s, turnId, outcome, state, signal, snapshot.resultShape);
	}

	private recordedTurnRights(branch: HistoryEntry[], turnId: string): Authority[] {
		const records = branch.filter(e => e.turnId === turnId && !e.erased && (e.kind === "turnStart" || e.kind === "input"));
		const start = records.find(e => e.kind === "turnStart");
		const explicit = (start?.data as { rights?: Authority[] } | undefined)?.rights;
		const inputs = records.filter(e => e.kind === "input").map(e => {
			const data = e.data as { rights?: Authority[]; connectionRights?: ConnectionRights } | undefined;
			return data?.rights ?? (data?.connectionRights && intersectRights(...Object.values(data.connectionRights))) ?? explicit ?? [];
		});
		return explicit || inputs.length ? intersectRights(...(explicit ? [explicit] : []), ...inputs) : [];
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

	private inputEntry(s: Session, q: QueuedInput, turnId: string): EntryDraft {
		const jobId = q.startedBy.kind === "job" ? q.startedBy.id : undefined;
		const sources = jobId ? s.order.filter((id) => { const e = s.entries.get(id)!; return e.jobId === jobId && e.kind === "jobEnded"; }) : undefined;
		return {
			kind: "input", writer: "harness", modelVisible: true, turnId, actorId: q.actorId, jobId, inputId: q.id, sources: [...(sources ?? []), ...(q.sources ?? [])],
			message: { role: "user", content: q.content }, data: { key: q.key, releasedBy: q.releasedBy, delegatedBy: q.delegatedBy, authorityActors: q.authorityActors, connectionRights: q.connectionRights, rights: q.startingRights },
		};
	}

	private failedOutcome(error: string): TurnOutcome {
		return { outcome: { kind: "failed", error }, result: { openToolCalls: [] }, entries: [], usage: zeroUsage() };
	}

	private endSteps(state: TurnState, except?: string): void {
		for (const [id, span] of state.steps) if (id !== except) { span.end(); state.steps.delete(id); }
	}

	private step(s: Session, turnId: string, steps: Map<string, Operation>, stepId: string): Operation {
		let span = steps.get(stepId);
		if (!span) {
			span = startOperation("modular_agent.step", { ...conversation(s.id), "modular_agent.turn.id": turnId, "modular_agent.step.id": stepId });
			steps.set(stepId, span);
		}
		return span;
	}

	private runtimeHost(s: Session, turnId: string, state: TurnState, resultShape?: Record<string, unknown>, observeSteps = true): RuntimeHost {
		const turn = activeOperation();
		// A kept Runtime may finish bookkeeping, but it does not resume a step.
		const step = (id: string) => observeSteps ? turn?.run(() => this.step(s, turnId, state.steps, id)) : undefined;
		const inStep = <T>(id: string | undefined, work: () => T): T => {
			const span = id ? step(id) : undefined;
			return span ? span.run(work) : work();
		};
		const withAuthority = <T>(fn: () => T): T => this.turnAuthority.run({ sessionId: s.id, actors: state.actors, jobs: state.jobs, state }, fn);
		const checkRead = async () => { await this.erasure.admitHistory(s); withAuthority(() => this.checkScopedWork(s, "watch")); };
		return {
			newId: async () => this.newId(),
			callActor: () => state.actors.values().next().value ?? this.actorForJob(s, state.jobs),
			prepareStep: ({ stepId, usage }) => {
				this.endSteps(state, stepId);
				return inStep(stepId, async () => {
					await checkRead();
					if (state.capacityLimit) throw turnLimit("capacity");
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
					const payload = { sessionId: s.id, turnId, stepId, usage, model: model?.model, history: s.branch().map(historyForPeer), request };
					const transformed = (await withAuthority(() => this.hooks.transform("step.before", payload))).value.request;
					await checkRead();
					if (!Array.isArray(transformed?.tools) || transformed.tools.some(t => !request.tools.some(offered => isDeepStrictEqual(offered, t)))) throw new Error("step.before cannot widen the tool offer");
					const prepared: ModelRequest = feedback.length ? { ...transformed, messages: [...transformed.messages,
						...feedback.map((e): ModelMessage => ({ role: "user", content: [text((e.data as { reason: string }).reason)] }))] } : transformed;
					// Hooks may copy or transform messages, so conservatively name their visible sources.
					state.sources.set(stepId, [...new Set([...branch.filter((e) => !e.erased && ((e.modelVisible && e.kind !== "resultFeedback") || e.kind === "summary" || (e.kind === "turnStart" && e.turnId === turnId && state.context?.length))), ...feedback].map((e) => e.id))]);
					return prepared;
				});
			},
			hook: (name, payload) => inStep(payload?.stepId ?? payload?.call?.stepId, async () => {
				if (name === "turn.end") {
					if (state.endedHook || s.suspended) return null as never;
					state.endedHook = true;
					if (state.toolResultError && payload.outcome?.kind !== "cancelled" && payload.outcome?.kind !== "limit") {
						payload = { ...payload, outcome: { kind: "failed", error: state.toolResultError }, result: {} };
					}
					if (state.capacityLimit && payload.outcome?.kind !== "cancelled") payload = { ...payload, outcome: { kind: "limit", limit: "capacity" } };
					else if ((state.tenantLimit || await this.tenantBudgetReached(s)) && payload.outcome?.kind !== "cancelled") payload = { ...payload, outcome: { kind: "limit", limit: "tenantTokens" } };
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
					} finally { state.stepAfterRunning = false; state.steps.get(payload.stepId)?.end(); state.steps.delete(payload.stepId); }
				}
				const scope = { ...payload, sessionId: s.id, turnId };
				if (name === "tool.before" && this.interfaceSources.has(payload.call?.name)) {
					const call = payload.call as ToolCall;
					const refused = (reason: string) => ({ value: scope, refused: reason });
					const registration = this.findTool(s, call.name);
					const branch = s.branch();
					const attempt = branch.find(e => e.kind === "modelRequest" && e.turnId === turnId && e.stepId === call.stepId && !e.erased);
					const response = branch.find(e => e.kind === "response" && e.turnId === turnId && e.stepId === call.stepId && !e.erased);
					if (call.startedBy !== "model" || call.parentCallId || !state.interfaceOffer?.has(call.name) ||
						!state.interfaceAllowances || state.interfaceAllowances.has(call.id) ||
						registration?.plugin !== INTERFACE_SOURCE ||
						!(attempt?.data as { tools?: string[] } | undefined)?.tools?.includes(call.name) ||
						response?.message?.role !== "assistant" || !response.message.content.some(part => isToolCall(part) &&
							part.id === call.id && part.name === call.name && isDeepStrictEqual(part.arguments, call.input))) return refused("Interface tool was not offered for this call");
					state.interfaceAllowances.set(call.id, null);
					const approval = s.settings.approval;
					const gate = await withAuthority(() => this.toolGate({ ...scope, definition: registration.definition }, s.running?.abort.signal));
					if (gate.pending !== undefined) return refused("An Interface handoff cannot wait on a question");
					if (gate.refused === undefined) state.interfaceAllowances.set(call.id, { call: structuredClone(gate.value.call), approval });
					return gate;
				}
				if (name === "tool.after") {
					const { result, error } = await withAuthority(() => this.toolAfter(s, scope));
					if (error) state.toolResultError ??= error.message;
					return { ...scope, result };
				}
				if (name === "turn.result") scope.shape = resultShape;
				const violation = name === "turn.result" && resultShape ? shapeViolation(resultShape, scope.result?.value) : undefined;
				const result = violation ? { value: scope, refused: violation } : name === "tool.before" && payload.call
					? await withAuthority(() => this.modelApprovalGate(s, state, turnId, scope))
					: await withAuthority(() => this.hooks.run(name, scope));
				if (name === "turn.result" && typeof result?.refused === "string") {
					await this.commit(s, [{ kind: "resultFeedback", writer: "harness", turnId, modelVisible: true, data: { reason: result.refused } }]);
				}
				if (name === "model.failed" && result?.retry) {
					const provider = this.providerFor(s, state.model);
					if (provider?.supports.keepsState === true) await provider.discardState?.(s.id);
				}
				if (name === "tool.before" && result?.pending && payload.call && !waitingApprovals(s).has(payload.call.id)) this.toolDisposition(payload.call, "pending");
				return result;
			}),
			runToolCall: (call, signal) => inStep(call.stepId, () => withAuthority(() => this.executeTool(s, call, signal, turnId, state))),
			definition: async (name) => this.findTool(s, name)?.definition,
			registration: (name) => {
				const found = this.findTool(s, name);
				return found && { source: { plugin: found.plugin, toolSource: found.source.id }, definition: found.definition };
			},
			history: async options => {
				await checkRead();
				return options?.all ? s.order.map(id => s.entries.get(id)!) : s.branch();
			},
			record: (draft) => inStep(draft.stepId, async () => {
				if (draft.kind === "turnStart" || draft.kind === "turnEnd") {
					return s.branch().find((e) => e.turnId === turnId && e.kind === draft.kind)
						?? { ...draft, id: turnId, turnId, sessionId: s.id, time: this.now(), parentId: s.position };
				}
				if (draft.kind === "inputRequest" || draft.kind === "inputAnswer" || draft.kind === "toolPending" || draft.kind === "toolStarted") throw failure("invalid_request", "Only the Harness records questions and pending dispositions");
				const wait = draft.toolCallId && waitingApprovals(s).get(draft.toolCallId);
				if (wait && draft.kind === "toolResult") {
					if (wait.result) return wait.result;
					draft = { ...draft, sources: [...draft.sources ?? [], wait.entry.id, ...(wait.decision ? [wait.decision.id] : [])] };
					if (!state.dispatched.has(draft.toolCallId!) && wait.request.deadlineAt! <= this.now()) {
						draft.data = { status: "notStarted" };
						if (draft.message?.role === "toolResult") draft.message = { ...draft.message, isError: true, content: [text("The approval deadline passed before dispatch")] };
					}
				}
				if (draft.toolCallId && this.interfaceRecords(s).has(draft.toolCallId)) throw failure("invalid_request", "Interface handoffs are settled by the Harness");
				const modelSources = draft.kind === "response" ? [
					...(state.sources.get(draft.stepId ?? "") ?? []),
					...s.branch().filter((e) => e.kind === "modelRequest" && e.turnId === turnId && e.stepId === draft.stepId).map((e) => e.id),
				] : [];
				const callSources = draft.kind === "toolResult" && draft.toolCallId ? s.branch()
					.filter((e) => e.kind === "toolStarted" && e.toolCallId === draft.toolCallId
						|| e.message?.role === "assistant" && e.message.content.some((p) => isToolCall(p) && p.id === draft.toolCallId))
					.map((e) => e.id) : [];
				const sources = [...new Set([...(draft.sources ?? []), ...modelSources, ...callSources])];
				const entry = (await this.commit(s, [{ ...draft, turnId, sources }], false, wait && draft.kind === "toolResult" ? () => !waitingApprovals(s).get(draft.toolCallId!)?.result : undefined))[0];
				if (!entry && wait) return waitingApprovals(s).get(draft.toolCallId!)!.result!;
				if (draft.kind === "toolResult" && draft.toolCallId && !state.dispatched.has(draft.toolCallId) && draft.message?.role === "toolResult") {
					const status = (draft.data as { status?: string } | undefined)?.status;
					if (status) this.toolDisposition({ id: draft.toolCallId, name: draft.message.toolName, startedBy: "model" }, status);
				}
				return entry;
			}),
			takeSteering: (final = false) => this.admit(s, async () => {
				const items = s.steering.splice(0);
				if (final && !items.length && s.running?.turnId === turnId) s.running.steeringClosed = true;
				if (!items.length) return [];
				for (const q of items) for (const id of inputActors(q)) state.actors.add(id);
				state.connectionRights = intersectConnectionRights(state.connectionRights, ...items.map(q => q.connectionRights));
				state.startingRights = intersectRights(state.startingRights ?? [], ...items.map(q => q.startingRights ?? []));
				return this.commit(s, items.map((q) => this.inputEntry(s, q, turnId)));
			}),
			hasSteering: async () => s.steering.length > 0,
			report: (type, data, ids) => {
				if (type === "step.started" && ids?.stepId) { this.endSteps(state, ids.stepId); step(ids.stepId); }
				if (type !== "model.output") this.emit(s, type, data, "runtime", { turnId, ...ids });
			},
		};
	}

	// ---------- models ----------

	private turnModel(s: Session, turnId: string | undefined, state: Pick<TurnState, "sources" | "actors" | "jobs" | "tenantLimit" | "capacityLimit" | "connectionRights" | "startingRights">,
		model: ModelAccess, authorize?: () => void): ModelAccess {
		const turn = activeOperation();
		const steps = "steps" in state ? (state as TurnState).steps : undefined;
		return { ...model, request: async (request, options) => {
			const stepId = options.stepId ?? [...state.sources.keys()].at(-1) ?? this.newId();
			const work = () => this.turnAuthority.run({ sessionId: s.id, actors: state.actors, jobs: state.jobs, state }, async () => {
				options.signal.throwIfAborted();
				if (state.tenantLimit || await this.tenantBudgetReached(s)) { state.tenantLimit = true; throw turnLimit("tenantTokens"); }
				const freshness = await this.erasure.admitHistory(s);
				await this.erasure.reconcileProviderErasure(s, model.model.provider);
				this.erasure.checkProviderErasure(s, model.model.provider);
				if (this.erasure.httpErasure() && freshness !== "[]" && model.supports.keepsState !== false) {
					throw failure("unavailable", "The history registry cannot verify deletion of kept Provider state");
				}
				const attempt = `model:${stepId}`;
				const bounds = this.reservations.limits;
				const requestBytes = resourceBytes(request);
				if (state.capacityLimit || requestBytes + 2048 > bounds.entryBytes ||
					!this.reservations.reserve(s, attempt, { calls: 1, bufferedBytes: requestBytes, storageBytes: requestBytes + 3 * bounds.settlementBytes })) {
					state.capacityLimit = true;
					throw turnLimit("capacity");
				}
				const scope = { sessionId: s.id, turnId, stepId, provider: model.model.provider, model: { provider: model.model.provider, id: model.model.id } };
				const safeToRepeat = !!turnId && (model.supports.safeToRepeat === true || (model.supports.keepsState === false && model.supports.runsTools === false));
				let intentId: string | undefined;
				const finalCheck = async () => {
					if (await this.erasure.admitHistory(s) !== freshness) throw failure("unavailable", "Erasure changed the model view");
					options.signal.throwIfAborted();
					authorize?.();
					this.checkScopedWork(s, "watch");
					this.erasure.checkProviderErasure(s, model.model.provider);
					this.checkWriter(s);
				};
				const check = async () => {
					options.signal.throwIfAborted();
					if (await this.tenantBudgetReached(s)) { state.tenantLimit = true; throw turnLimit("tenantTokens"); }
					await finalCheck();
				};
				const handoff = async (send: () => void) => {
					const publish = async () => { await finalCheck(); send(); };
					const registry = this.erasure.pendingRegistry();
					if (registry) await registry.exclusive(publish); else await publish();
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
					const originals = options.exactReplay || !turnId ? [] : modelView(s.branch(), turnId, scope.provider)
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
					const size = resourceBytes(dispatched);
					if (size + 2048 > bounds.entryBytes || model.supports.runsTools !== false && dispatched.providerTools !== "none" ||
						!this.reservations.resize(s, attempt, { calls: 1, bufferedBytes: size, storageBytes: size + 3 * bounds.settlementBytes })) {
						state.capacityLimit = true;
						throw turnLimit("capacity");
					}
					const [intent] = await this.commit(s, [{
						kind: "modelRequest", writer: "harness", turnId, stepId, modelVisible: false,
						actorId: turnId ? undefined : [...state.actors][0],
						data: { model: scope.model, ...(model.supports.keepsState === true ? { keepsState: true } : {}), safeToRepeat, tools: prepared.request.tools.map((t) => t.name), ...(safeToRepeat ? { request: dispatched } : {}) },
						sources: state.sources.get(stepId),
					}]);
					try { await check(); }
					catch (error) {
						if (intent && !s.suspended) {
							await this.commit(s, [{ kind: "response", writer: "harness", turnId, stepId, modelVisible: false,
								message: { role: "assistant", stop: "aborted", content: [] }, sources: [intent.id], data: { recovery: true } }]);
						}
						throw error;
					}
					intentId = intent?.id;
					options.onEffectiveRequest?.(prepared.request);
					return dispatched;
				};
				const attributes = { ...conversation(s.id), "modular_agent.turn.id": turnId, "modular_agent.step.id": stepId };
				let observed = Promise.resolve();
				const onEvent = (event: import("./types.js").ModelStreamEvent) => {
					observed = observed.then(() => this.hooks.observe("provider.piece", { ...scope, turnId, stepId, piece: structuredClone(event) }));
					if (turnId) this.emit(s, "model.output", event, "harness", { turnId, stepId });
					options.onEvent?.(event);
				};
				try {
					let message: AssistantMessage;
					try {
						if (model.prepareOnWire) {
							const work = { sessionId: s.id, actors: state.actors, jobs: state.jobs, state };
							message = await observeInference(scope.provider, scope.model.id, attributes, !!options.onEvent, () => model.request(request, { ...options, onEvent,
								prepareDispatch: () => this.turnAuthority.run(work, prepareDispatch),
								handoff: send => this.turnAuthority.run(work, () => handoff(send)) }));
						} else {
							const dispatched = await prepareDispatch();
							let result!: Promise<AssistantMessage>;
							await handoff(() => {
								result = observeInference(scope.provider, scope.model.id, attributes, !!options.onEvent,
									() => model.request(dispatched, { ...options, requestPrepared: true, onEvent }), model.inProcessInference !== true);
								void result.catch(() => {});
							});
							message = await result;
						}
					} catch (error) {
						if (turnId || !intentId) throw error;
						message = options.signal.aborted ? { role: "assistant", stop: "aborted", content: [] }
							: { role: "assistant", stop: "failed", content: [], error: { kind: "other", message: String(error) } };
					}
					const reserved: string[] = [];
					const calls = message.content.filter(isToolCall);
					const size = resourceBytes(message);
					const replace = !!turnId && calls.length > 0;
					let fits = size + 2048 <= bounds.entryBytes && this.reservations.resize(s, attempt, {
						calls: replace ? 0 : 1, bufferedBytes: size, storageBytes: size + 2 * bounds.settlementBytes,
					});
					if (fits && turnId) for (const call of calls) {
						if (!this.reserveCall(s, call.id)) { fits = false; break; }
						reserved.push(call.id);
					}
					if (!fits) {
						for (const id of reserved) this.reservations.release(s, `call:${id}`);
						state.capacityLimit = true;
						message = { role: "assistant", content: [], usage: message.usage, stop: "failed",
							error: { kind: "other", message: "Response exceeds reserved capacity" } };
					}
					if (!model.prepareOnWire) await this.hooks.observe("provider.response", { ...scope, message: withoutProviderData(message) });
					if (!turnId && intentId) await this.commit(s, [{ kind: "response", writer: "harness", stepId,
						actorId: [...state.actors][0], message, modelVisible: false, sources: [intentId] }]);
					return message;
				} finally {
					if (!turnId || !intentId) this.reservations.release(s, attempt);
					await observed;
					if (turnId) this.emit(s, "model.streamEnd", {}, "harness", { turnId, stepId }); }
			});
			if (!turnId || !steps) return work();
			const step = () => this.step(s, turnId, steps, stepId);
			return (turn ? turn.run(step) : step()).run(work);
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
			inProcessInference: provider.inProcessInference,
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
	private scopedEnvironment(env: WorkingEnvironment, check: () => void): WorkingEnvironment {
		return new Proxy(env, {
			get: (environment, key) => {
				const member: unknown = Reflect.get(environment, key, environment);
				if (typeof member !== "function") return member;
				if (key === "at" || key === "forSession") return async (...args: unknown[]) => {
					check();
					const next = await member.apply(environment, args) as WorkingEnvironment;
					check();
					return this.scopedEnvironment(next, check);
				};
				return (...args: unknown[]) => {
					check();
					const result: unknown = member.apply(environment, args);
					// A read begun before a revocation cannot disclose its reply afterwards.
					if (key === "readFile" || key === "exists" || key === "list" || key === "hasPoint") {
						return Promise.resolve(result).then(value => { check(); return value; });
					}
					return result;
				};
			},
		});
	}

	private async environmentFor(s: Session): Promise<WorkingEnvironment | undefined> {
		const base = this.use<WorkingEnvironment>("working-environment");
		const env = await base?.forSession?.(s.id) ?? base;
		const cwd = this.projectOf(s);
		return env && env.cwd !== cwd && env.at ? env.at(cwd) : env;
	}

	// ---------- Interface tool routes ----------

	// A request-scoped offer follows its admission, not whichever connection happens
	// to be present when a queued turn starts. Embedded connections remain ambient.
	private offerScope = new AsyncLocalStorage<symbol>();
	private queuedOffers = new WeakMap<QueuedInput, symbol>();
	private connectionOffers = new WeakMap<InterfaceConnection, symbol>();
	withInterfaceOffer<T>(scope: symbol, work: () => T): T { return this.offerScope.run(scope, work); }
	private interfaceSources = new Map<string, InterfaceToolSource>();
	private interfaceConnections = new WeakMap<Session, Set<InterfaceConnection>>();
	private interfaceWork = new WeakMap<Session, Map<string, LiveHandoff>>();
	private interfaceTimers = new WeakMap<Session, Map<string, ReturnType<typeof setTimeout>>>();
	private handoffSpans = new WeakMap<Session, Map<string, NonNullable<ReturnType<typeof currentSpan>>>>();

	async registerInterfaceTools(sources: readonly InterfaceToolSource[]): Promise<void> {
		if (!sources.length) return;
		if (this.runtime()?.supports.interfaceTools !== true) throw new Error("Interface tools need a Runtime that supports result-only continuations");
		if (this.plugins().includes(INTERFACE_SOURCE)) throw new Error("Interface tools conflict with an existing plugin");
		const ids = new Set(this.useAll<ToolSource>("tool-source").map(s => s.id));
		const routes = new Map<string, string>();
		const definitions = new Map<string, InterfaceToolSource>();
		const copy = structuredClone(sources);
		for (const source of copy) {
			const { sourceId, actorId, routeId, resultTimeoutMs, tools } = source;
			if (![sourceId, actorId, routeId].every(id => typeof id === "string" && id.length)
				|| !Number.isSafeInteger(resultTimeoutMs) || resultTimeoutMs <= 0 || !Number.isSafeInteger(this.now() + resultTimeoutMs)) {
				throw new Error("Interface tool source needs IDs and a positive result timeout within Time range");
			}
			if (ids.has(sourceId) || routes.has(routeId) && routes.get(routeId) !== actorId) throw new Error("Conflicting Interface tool source or route");
			ids.add(sourceId);
			routes.set(routeId, actorId);
			for (const tool of tools) {
				if (!isJson(tool) || typeof tool.name !== "string" || !tool.name || typeof tool.description !== "string" ||
					!isDeepStrictEqual(tool.callers, ["model"]) || tool.hints?.safeToRepeat === true || tool.hints?.openWorld === false) {
					throw new Error("An Interface tool must be model-only, open-world and not safe to repeat");
				}
				shapeViolation(tool.parameters, {});
				if (tool.returns !== undefined) shapeViolation(tool.returns, undefined);
				if (definitions.has(tool.name) || this.hasItem(`tool:${tool.name}`) || this.replacements.has(`tool:${tool.name}`)) throw new Error(`Tool ${tool.name} is already registered`);
				definitions.set(tool.name, source);
			}
		}
		if (!definitions.size) return;
		await this.load([{ name: INTERFACE_SOURCE, setup: api => {
			for (const source of copy) api.provide("tool-source", {
				id: source.sourceId, tools: () => structuredClone([...source.tools]),
				run: () => { throw new Error("Only the registered Interface can execute this tool"); },
			} satisfies ToolSource);
		} }]);
		if (!this.plugins().includes(INTERFACE_SOURCE)) throw new Error("Interface tool registration failed");
		this.interfaceSources = definitions;
	}

	connectInterfaceTools(sessionId: string, options: InterfaceToolConnectionOptions): InterfaceToolConnection {
		const s = this.session(sessionId);
		if (![...this.interfaceSources.values()].some(r => r.routeId === options.routeId && r.actorId === options.actor.id)) {
			throw failure("forbidden", "No Interface tool route for this actor");
		}
		const connection: InterfaceConnection = { ...options, actor: structuredClone(options.actor), tools: new Map() };
		if (!this.executorRights(s, connection).includes("watch")) throw failure("forbidden", "Actor cannot watch this session");
		const connections = this.interfaceConnections.get(s) ?? new Set();
		this.interfaceConnections.set(s, connections);
		connections.add(connection);
		const scope = this.offerScope.getStore();
		if (scope) this.connectionOffers.set(connection, scope);
		return {
			advertise: tools => {
				if (!this.interfacePresent(s, connection)) throw failure("not_open", "Interface connection ended");
				const next = new Map<string, ToolDefinition>();
				for (const tool of tools) {
					const source = this.interfaceSources.get(tool.name);
					const definition = source?.tools.find(t => t.name === tool.name);
					if (!definition || source?.actorId !== connection.actor.id || source.routeId !== connection.routeId ||
						next.has(tool.name) || !sameDefinition(tool, definition)) throw failure("invalid_request", "Advertisement does not match the registered Interface tool");
					next.set(tool.name, definition);
				}
				connection.tools = next;
			},
			release: id => this.releaseInterfaceCall(s, id, connection),
			reportInterfaceToolResult: report => this.reportInterfaceToolResult(s, connection, report),
			disconnect: () => { connections.delete(connection); connection.tools.clear(); },
		};
	}

	private executorRights(s: Session, connection: InterfaceConnection): Authority[] {
		return this.withConnectionActor(connection.actor, () => this.actorRights(s, connection.actor.id));
	}

	private interfacePresent(s: Session, connection: InterfaceConnection): boolean {
		return !s.closed && !s.closing && !s.suspended && this.sessions.get(s.id) === s && !!this.interfaceConnections.get(s)?.has(connection);
	}

	private interfaceOffer(s: Session, scope?: symbol): Map<string, InterfaceConnection> {
		const offer = new Map<string, InterfaceConnection>();
		for (const connection of this.interfaceConnections.get(s) ?? []) {
			if (scope !== this.connectionOffers.get(connection)) continue;
			const rights = this.executorRights(s, connection);
			if (!this.interfacePresent(s, connection) || !rights.includes("tools") || !rights.includes("watch")) continue;
			for (const name of connection.tools.keys()) if (!offer.has(name)) offer.set(name, connection);
		}
		return offer;
	}

	private interfaceRecords(s: Session) {
		return handoffRecords(s.order.filter(id => !s.copied.has(id)).map(id => s.entries.get(id)!));
	}

	private unsettledHandoffs(s: Session) {
		return [...this.interfaceRecords(s).values()].filter(item => !item.result);
	}

	private validHandoff(s: Session, item: HandoffRecord) {
		const { data, dispatch, checkpoint, start } = item;
		const source = dispatch?.call && this.interfaceSources.get(dispatch.call.name);
		return !!data && !!start && !!checkpoint && !!dispatch && !!source && this.runtime()?.supports.interfaceTools === true &&
			source.actorId === data.executorActorId && source.routeId === data.routeId && source.sourceId === dispatch.source.toolSource &&
			(source.tools.some(t => sameDefinition(t, dispatch.definition))) &&
			s.branch().some(e => e.id === checkpoint.id) && s.actors.has(data.executorActorId);
	}

	private async gateHandoff(s: Session, connection: InterfaceConnection, request: InterfaceToolHandoff): Promise<boolean> {
		const payload = structuredClone(request);
		const event = { type: "tool.handoff", time: this.now(), sessionId: s.id, source: INTERFACE_SOURCE,
			turnId: request.turnId, toolCallId: request.call.id, stepId: request.call.stepId, data: payload };
		let unchanged = false;
		const follower = new Follower(this.hooks, connection.actor.id, false, gated => {
			unchanged = isDeepStrictEqual(gated, event);
		}, error => this.problem("harness", "Interface handoff output gate", error));
		follower.push(structuredClone(event));
		await follower.idle();
		return unchanged;
	}

	private async handoffInterfaceCall(s: Session, source: InterfaceToolSource, connection: InterfaceConnection, call: ToolCall,
		turnId: string, state: TurnState, signal: AbortSignal, allowed: () => boolean, approval: unknown): Promise<ToolResult | (ToolPending & { callId: string })> {
		const refused = (): ToolResult => ({ callId: call.id, status: "refused", content: [text("Interface handoff is not authorized")] });
		const definition = source.tools.find(t => t.name === call.name)!;
		const eligible = () => {
			const current = this.findTool(s, call.name);
			const rights = this.executorRights(s, connection);
			return !signal.aborted && !s.moving && !s.erasing && allowed() && approval === s.settings.approval && this.interfacePresent(s, connection) &&
				rights.includes("watch") && rights.includes("tools") && connection.tools.get(call.name) === definition &&
				current?.plugin === INTERFACE_SOURCE && current.source.id === source.sourceId && sameDefinition(current.definition, definition) &&
				state.tools.some(t => t.name === call.name && sameDefinition(t, definition));
		};
		const deadline = this.now() + source.resultTimeoutMs;
		if (!Number.isSafeInteger(deadline) || !eligible()) return refused();
		await this.erasure.admitHistory(s);
		if (!eligible()) return refused();
		const request = { sessionId: s.id, turnId, deadline, call };
		if (!(await this.gateHandoff(s, connection, request))) return refused();
		return this.admit(s, async () => {
			const freshness = await this.erasure.admitHistory(s);
			const previous = this.interfaceRecords(s).has(call.id);
			if (!eligible() || previous || deadline <= this.now()) return refused();
			this.checkWriter(s);
			const startId = this.newId();
			const scope = { toolCallId: call.id, turnId, stepId: call.stepId };
			const data: HandoffData = { toolStartedId: startId, executorActorId: source.actorId, routeId: source.routeId,
				rights: this.executorRights(s, connection), deadline };
			const committed = await this.commit(s, [
				{ ...scope, id: startId, kind: "toolStarted", writer: "harness", modelVisible: false, actorId: call.actorId,
					data: { call, source: { plugin: INTERFACE_SOURCE, toolSource: source.sourceId }, definition, safeToRepeat: false, openWorld: true,
						authorizers: [...state.actors].map(actorId => ({ sessionId: s.id, actorId })), rights: this.workRights(s, state.actors, state.jobs) } },
				{ ...scope, kind: INTERFACE_HANDOFF, writer: "harness", modelVisible: false, sources: [startId], data: { ...scope, ...data } },
			], false, () => eligible() && deadline > this.now() && data.rights.every(r => this.executorRights(s, connection).includes(r)) &&
				(!this.erasure.pendingRegistry() || this.erasure.checkPending(s) === freshness));
			if (!committed.length) return refused();
			const pinned = AsyncLocalStorage.snapshot();
			const live: LiveHandoff = { connection, released: false, check: () => pinned(() => eligible() && deadline > this.now()),
				deliver: request => pinned(() => this.deliverHandoff(s, live, request)) };
			const work = this.interfaceWork.get(s) ?? new Map();
			this.interfaceWork.set(s, work);
			work.set(call.id, live);
			state.dispatched.add(call.id);
			const item = this.interfaceRecords(s).get(call.id)!;
			let fresh = false;
			try { fresh = (await this.erasure.admitHistory(s)) === freshness; } catch { /* fail closed */ }
			if (!fresh || !live.check()) {
				// No executable request left the Harness.
				await this.settleInterfaceCall(s, item);
				return { callId: call.id, pending: "Interface request was not released" };
			}
			this.checkWriter(s);
			this.scheduleInterfaceExpiry(s, item);
			if (!connection.defer) this.deliverHandoff(s, live, request);
			return { callId: call.id, pending: "Waiting for Interface tool result" };
		});
	}

	private deliverHandoff(s: Session, live: LiveHandoff, request: InterfaceToolHandoff): void {
		const { call, turnId } = request;
		const span = startOperation(`execute_tool ${safeName(call.name) ?? "interface"}`, {
			...conversation(s.id), "modular_agent.turn.id": turnId, "modular_agent.step.id": call.stepId, ...toolAttributes(call),
			"gen_ai.agent.name": this.agentName, "modular_agent.tool.status": "pending",
		});
		if (span.spanContext) {
			const spans = this.handoffSpans.get(s) ?? new Map();
			this.handoffSpans.set(s, spans);
			spans.set(call.id, span.spanContext);
		}
		live.released = true; // A delivery error cannot establish that nothing ran.
		this.interfaceWork.get(s)?.delete(call.id);
		try { span.run(() => live.connection.onHandoff(structuredClone(request))); }
		catch { this.problem("harness", "Interface handoff", new Error("Interface delivery was not confirmed")); }
		finally { span.end(); }
	}

	private releaseInterfaceCall(s: Session, id: string, connection: InterfaceConnection): Promise<boolean> {
		return this.admit(s, async () => {
			const live = this.interfaceWork.get(s)?.get(id);
			const item = live?.connection === connection && this.interfaceRecords(s).get(id);
			if (!item || item.result || !live || !this.validHandoff(s, item)) return false;
			const { data, dispatch, checkpoint } = item;
			const request = { sessionId: s.id, turnId: checkpoint!.turnId!, deadline: data!.deadline, call: dispatch!.call };
			const freshness = await this.erasure.admitHistory(s);
			if (!live.check() || !(await this.gateHandoff(s, connection, request))) return false;
			if (await this.erasure.admitHistory(s) !== freshness) return false;
			this.checkWriter(s);
			if (!live.check()) return false;
			live.deliver(request);
			return true;
		});
	}

	private scheduleInterfaceExpiry(s: Session, item: HandoffRecord): void {
		if (!item.data) return;
		const timers = this.interfaceTimers.get(s) ?? new Map();
		this.interfaceTimers.set(s, timers);
		clearTimeout(timers.get(item.id));
		timers.set(item.id, setTimeout(() => {
			void withTrace(undefined, () => this.admit(s, async () => {
				if (s.closed || s.suspended) return;
				const current = this.interfaceRecords(s).get(item.id);
				if (!current || current.result || !current.data) return;
				if (current.data.deadline > this.now()) return this.scheduleInterfaceExpiry(s, current);
				await this.settleInterfaceCall(s, current);
				this.maybeContinueOpenCalls(s);
			})).catch(error => this.problem("harness", "Interface tool expiry", error));
		}, Math.min(2_147_483_647, Math.max(1, item.data.deadline - this.now()))).unref());
	}

	private clearInterfaceWork(s: Session): void {
		this.approvals.clear(s);
		for (const timer of this.interfaceTimers.get(s)?.values() ?? []) clearTimeout(timer);
		this.interfaceTimers.delete(s);
		this.interfaceConnections.delete(s);
		this.interfaceWork.delete(s);
		this.handoffSpans.delete(s);
	}

	private async invalidateErasedHandoffs(s: Session, entryIds: string[]): Promise<void> {
		const ids = new Set(entryIds);
		this.approvals.invalidateDeliveries(s);
		for (const w of waitingApprovals(s).values()) {
			if (!w.result && !w.start && [w.entry.id, w.decision?.id, w.end?.id, ...(w.entry.sources ?? []),
				...s.branch().filter(e => e.toolCallId === w.request.toolCallId && e.kind === "toolPending").map(e => e.id)].some(id => id && ids.has(id))) {
				await this.approvals.closeWaiting(s, w, "noLongerAnswerable", "notStarted", true);
			}
		}
		for (const item of this.unsettledHandoffs(s)) {
			if ([item.start?.id, item.checkpoint?.id].some(id => id && ids.has(id))) {
				await this.settleInterfaceCall(s, item, undefined, true);
			}
		}
	}

	private async recoverInterfaceCalls(s: Session): Promise<void> {
		for (const item of this.unsettledHandoffs(s)) {
			const end = s.branch().find(e => e.kind === "turnEnd" && e.turnId === (item.checkpoint ?? item.start)?.turnId);
			if (!this.validHandoff(s, item) || item.data!.deadline <= this.now() ||
				(end ? end.erased || !(end.data as { result?: TurnOutcome["result"] })?.result?.openToolCalls.includes(item.id) : !this.runtime()?.supports.continuesAfterRestart)) {
				await this.settleInterfaceCall(s, item);
			} else this.scheduleInterfaceExpiry(s, item);
		}
	}

	private reportInterfaceToolResult(s: Session, connection: InterfaceConnection, raw: InterfaceToolReport): Promise<InterfaceToolReceipt> {
		const refused = { status: "refused" } as const;
		let report: InterfaceToolReport;
		try {
			const { callId, status, content, value } = raw;
			if (typeof callId !== "string" || !callId || !["completed", "failed"].includes(status) ||
				!validReportContent(content) || status === "failed" && !content.length || value !== undefined && !isJson(value)) return Promise.resolve(refused);
			report = structuredClone({ callId, status, content, ...(value === undefined ? {} : { value }) });
		} catch { return Promise.resolve(refused); }
		const parent = currentSpan();
		return this.admit(s, async () => {
			if (!this.interfacePresent(s, connection) || s.erasing || s.moving || s.reopening) return refused;
			const item = this.interfaceRecords(s).get(report.callId);
			if (!item?.data || !this.validHandoff(s, item)) return refused;
			const { data, checkpoint } = item;
			const authorized = () => this.interfacePresent(s, connection) && !s.erasing && !s.moving &&
				data.executorActorId === connection.actor.id && data.routeId === connection.routeId &&
				intersectRights(data.rights, this.executorRights(s, connection)).includes("watch") &&
				intersectRights(data.rights, this.executorRights(s, connection)).includes("tools");
			if (!authorized()) return refused;
			try { await this.erasure.admitHistory(s); } catch { return refused; }
			if (!authorized()) return refused;
			if (data.deadline <= this.now()) {
				if (!item.result) { await this.settleInterfaceCall(s, item); this.maybeContinueOpenCalls(s); }
				return refused;
			}
			const end = s.branch().find(e => e.turnId === checkpoint!.turnId && e.kind === "turnEnd");
			if (end?.erased || item.result?.erased) return refused;
			if (!end) return { status: "refused", reason: "notReady" };
			if (!(end.data as { result?: TurnOutcome["result"] })?.result?.openToolCalls.includes(item.id)) return refused;
			if (item.result) return item.result.actorId === connection.actor.id && !item.result.erased ? { status: "alreadySettled" } : refused;
			if (this.interfaceWork.get(s)?.has(item.id)) return refused;
			const span = startOperation("modular_agent.interface.report", { ...conversation(s.id) }, { parent: parent ?? null });
			return span.observe(async () => {
				const settled = await this.settleInterfaceCall(s, item, { report, actorId: connection.actor.id, authorized });
				this.maybeContinueOpenCalls(s, currentSpan());
				if (settled?.error) throw settled.error;
				return settled ? { status: "accepted" } : refused;
			});
		});
	}

	private async settleInterfaceCall(s: Session, item: HandoffRecord,
		submitted?: { report: InterfaceToolReport; actorId: string; authorized: () => boolean }, erasure = false) {
		if (item.result || s.suspended) return;
		const { checkpoint, start, dispatch } = item;
		const origin = checkpoint ?? start;
		const { id } = item;
		const link = this.handoffSpans.get(s)?.get(id);
		const span = startOperation("modular_agent.tool.settle", {
			...conversation(s.id), "modular_agent.turn.id": origin?.turnId, "modular_agent.step.id": origin?.stepId,
			"modular_agent.tool.call.id": id,
		}, { parent: submitted ? currentSpan() : null, links: link ? [link] : undefined });
		return span.observe(async () => {
			const live = this.interfaceWork.get(s)?.get(id);
			const call = dispatch?.call;
			const branch = s.branch();
			const actors = new Set(origin?.turnId ? this.recordedTurnActors(branch, origin.turnId) : []);
			const jobs = new Set(origin?.turnId ? this.recordedTurnJobs(branch, origin.turnId) : []);
			const startingRights = origin?.turnId ? this.recordedTurnRights(branch, origin.turnId) : [];
			const checked = submitted && call ? await this.turnAuthority.run({ sessionId: s.id, actors, jobs, state: { startingRights } },
				() => this.toolAfter(s, { sessionId: s.id, call, result: submitted.report }, true)) : undefined;

			const result: ToolResult = checked?.result ?? { callId: id, status: live && !live.released ? "notStarted" : "outcomeUnknown",
				content: [text(live && !live.released ? "Interface request was not released" : "Interface tool outcome is unknown")] };
			const draft: EntryDraft = { kind: "toolResult", writer: "harness", modelVisible: true, turnId: origin?.turnId,
				stepId: origin?.stepId, toolCallId: id, actorId: submitted?.actorId,
				sources: [start?.id, checkpoint?.id].filter((entry): entry is string => !!entry),
				message: { role: "toolResult", toolCallId: id, toolName: call?.name ?? "unknown", content: result.content, isError: result.status !== "completed" },
				data: { status: result.status, value: result.value },
			};
			const written = erasure ? await this.commitNow(s, [draft]) : await this.commit(s, [draft], false, async () => {
				if (this.interfaceRecords(s).get(id)?.result) return false;
				if (!submitted) return true;
				try { await this.erasure.admitHistory(s); } catch { return false; }
				return submitted.authorized();
			});
			if (!written.length) return;
			clearTimeout(this.interfaceTimers.get(s)?.get(id));
			this.interfaceTimers.get(s)?.delete(id);
			this.interfaceWork.get(s)?.delete(id);
			this.handoffSpans.get(s)?.delete(id);
			span.set("modular_agent.tool.status", result.status);
			if (checked?.error || result.status === "failed" || result.status === "outcomeUnknown") span.fail(result.status);
			this.emit(s, "tool.result", { status: result.status }, "harness", { turnId: origin?.turnId, stepId: origin?.stepId, toolCallId: id, actorId: submitted?.actorId });
			return { error: checked?.error };
		});
	}

	// ---------- tools ----------

	private findTool(s: Session | undefined, name: string): { plugin: string; source: ToolSource; definition: ToolDefinition } | undefined {
		for (const { plugin, impl } of this.caps.get("tool-source") ?? []) {
			if (this.interfaceSources.has(name) && plugin !== INTERFACE_SOURCE) continue;
			const source = impl as ToolSource;
			const definition = source.tools(s?.id).find((t) => t.name === name && !this.replacedFor(plugin, `tool:${t.name}`));
			if (definition) return { plugin, source, definition };
		}
		return undefined;
	}

	private toolDefinitions(s?: Session): ToolDefinition[] {
		const seen = new Set<string>();
		const out: ToolDefinition[] = [];
		for (const { plugin, impl } of this.caps.get("tool-source") ?? []) {
			const source = impl as ToolSource;
			for (const t of source.tools(s?.id)) {
				if (this.interfaceSources.has(t.name) && plugin !== INTERFACE_SOURCE) continue;
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
		return out;
	}

	/** Run one tool call. Hook points are applied by whoever owns the operation. */
	private async executeTool(s: Session, call: ToolCall, signal: AbortSignal, turnId?: string, state?: TurnState,
		nested?: NestedDispatch, directAllowance?: DispatchAllowance): Promise<ToolResult | (ToolPending & { callId: string })> {
		const wait = waitingApprovals(s).get(call.id);
		const allowance = directAllowance ?? (state && this.dispatchAllowances.get(state)?.get(call.id));
		if (state) this.dispatchAllowances.get(state)?.delete(call.id);
		const denied = (): ToolResult => ({ callId: call.id, status: wait && wait.request.deadlineAt! <= this.now() ? "notStarted" : "refused", content: [text("Consent no longer authorizes dispatch")] });
		const needsGate = !nested && state && !this.interfaceSources.has(call.name) && (this.coversNested() || this.approvals.maximum && s.settings.approvalWait === "untilDeadline" &&
			!s.branch().some(e => e.kind === "toolStarted" && e.toolCallId === call.id));
		if (!this.intactInheritedCall(s, turnId, call) || needsGate && !allowance || wait && (!allowance || wait.start || wait.result || !this.approvals.validWait(s, wait))) return denied();
		const found = this.findTool(s, call.name);
		if (s.erasing) return { callId: call.id, status: "refused", content: [text("Erasure is in progress")] };
		if (!found && wait) return denied();
		if (!found) return { callId: call.id, status: "failed", content: [text(`Unknown tool: ${call.name}`)] };
		const violation = shapeViolation(found.definition.parameters, call.input);
		if (violation && wait) return denied();
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
		if (found.plugin === INTERFACE_SOURCE) {
			const registration = this.interfaceSources.get(call.name);
			const connection = state?.interfaceOffer?.get(call.name);
			const allowance = state?.interfaceAllowances?.get(call.id);
			if (!allowance || !isDeepStrictEqual({ ...allowance.call, actorId: call.actorId }, call) ||
				call.actorId !== (owners[0] ?? this.actorForJob(s, state?.jobs))) return refused();
			state?.interfaceAllowances?.set(call.id, null);
			if (!registration || !connection || !turnId || !call.stepId || !state || nested || call.startedBy !== "model" || !call.actorId) return refused();
			return this.handoffInterfaceCall(s, registration, connection, call, turnId, state, signal, allowed, allowance.approval);
		}
		const env = await this.environmentFor(s);
		const safeToRepeat = found.definition.hints?.safeToRepeat === true && env?.containment === "strong";
		const point = !nested && !turnId && env?.save && (env.keepsPoints?.(this.projectOf(s)) ?? env.points) ? await env.save() : undefined;
		const eligible = (current: ReturnType<Harness["findTool"]>) => allowed() && !s.erasing && !s.suspended &&
			(!allowance || sameJson(allowance.call, call) && (wait || allowance.policy === s.settings.approval) && current &&
				current.plugin === allowance.binding.source.plugin && current.source.id === allowance.binding.source.toolSource && sameJson(current.definition, allowance.binding.definition)) &&
			sameRegistration(current, found) && (!nested || nested.approval === s.settings.approval);
		if (!eligible(this.findTool(s, call.name))) return refused();
		if (signal.aborted) return { callId: call.id, status: "notStarted", content: [text("Cancelled before it ran")] };
		this.checkWriter(s);
		const consent = (afterStart?: HistoryEntry) => {
			if (!wait) return true;
			const w = waitingApprovals(s).get(call.id);
			return !!w && w.start === afterStart && w.entry === wait.entry && w.decision === wait.decision && !w.result &&
				sameJson(call, allowance?.call) && this.approvals.matchesApproval(w, call, s) && this.approvals.approvalPrincipalsAllow(s, w) &&
				this.workRights(s, owners, state?.jobs).includes("tools") && !signal.aborted && !s.erasing && !s.suspended;
		};
		if (wait && (!consent() || !await this.approvals.approverStillAllows(s, wait) || !consent())) return denied();
		const [start] = await this.commit(s, [{ kind: "toolStarted", writer: "harness", modelVisible: false, turnId, actorId: call.actorId ?? owners[0] ?? this.actorForJob(s, state?.jobs), toolCallId: call.id, stepId: call.stepId,
			sources: wait ? [wait.entry.id, wait.decision!.id] : nested ? s.branch().filter(e => e.kind === "modular-agent.nestedCall" && e.toolCallId === call.id).map(e => e.id) : undefined,
			data: { call: { ...call, actorId: call.actorId ?? owners[0] ?? this.actorForJob(s, state?.jobs) }, source: { plugin: found.plugin, toolSource: found.source.id }, definition: found.definition, safeToRepeat, point, openWorld: found.definition.hints?.openWorld ?? true,
				...(nested?.inherited ? { approvalCoveredBy: { toolCallId: nested.inherited.toolCallId, requestId: nested.inherited.requestId } } : {}),
				authorizers: owners.map((actorId) => ({ sessionId: s.id, actorId })), rights: this.workRights(s, owners, state?.jobs) } }], false, wait ? () => consent() : undefined);
		if (wait && (!start || !consent(start))) return denied();
		const current = this.findTool(s, call.name);
		if (!eligible(current)) return refused();
		this.checkWriter(s);
		if (signal.aborted) return { callId: call.id, status: "notStarted", content: [text("Cancelled before it ran")] };
		if (wait && !await this.approvals.approverStillAllows(s, wait)) return denied();
		await this.erasure.admitHistory(s);
		this.checkWriter(s);
		if (wait && !consent(start)) return denied();
		if (signal.aborted || !eligible(this.findTool(s, call.name))) return refused();
		const name = safeName(found.definition.name);
		const span = startOperation(name ? `execute_tool ${name}` : "execute_tool", {
			...conversation(s.id), "modular_agent.turn.id": turnId, "modular_agent.step.id": call.stepId,
			...toolAttributes(call), "gen_ai.agent.name": this.agentName,
		});
		state?.dispatched.add(call.id);
		return span.run(async () => {
			try {
				const result = await this.invokeTool(s, found, call, signal, turnId, state, nested?.depth ?? 0, nested?.inherited ?? allowance?.cover, owners, allowed, env, start);
				const status = isPending(result) ? "pending" : result.status;
				span.set("modular_agent.tool.status", status);
				if (status === "failed" || status === "outcomeUnknown") span.fail(status);
				return result;
			} finally { span.end(); }
		});
	}

	private async invokeTool(s: Session, found: NonNullable<ReturnType<Harness["findTool"]>>, call: ToolCall, signal: AbortSignal, turnId: string | undefined, state: TurnState | undefined,
		depth: number, cover: CoveringAllow | undefined, owners: string[], allowed: () => boolean, env: WorkingEnvironment | undefined, start: HistoryEntry): Promise<ToolResult | (ToolPending & { callId: string })> {
		this.emit(s, "tool.started", { call }, found.source.id, { turnId, toolCallId: call.id, stepId: call.stepId });
		const toolSpan = activeOperation();
		let asked = 0;
		const pendingQuestions: string[] = [];
		const children = new Set<Promise<ToolResult>>();
		const lifetime = new AbortController();
		let live = true;
		const check = () => {
			if (!live) throw Object.assign(new Error("There is no live parent"), { code: "invalid_request" });
			this.erasure.checkPending(s);
			if (signal.aborted) throw Object.assign(new Error("The parent was cancelled"), { code: "cancelled" });
			if (!allowed() || s.erasing || s.suspended) throw Object.assign(new Error("The parent cannot run tools"), { code: "invalid_request" });
			this.checkWriter(s);
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
					const job = this.jobWork.startJob(s, { kind, detail, key, actors: owners, toolCallId: call.id }, found.plugin);
					await job.ready;
					return job;
				} },
				progress: (content) => {
					try { check(); } catch { return; }
					this.emit(s, "tool.progress", { content }, found.source.id, { turnId, toolCallId: call.id });
				},
				environment: env && this.scopedEnvironment(env, check),
				tools: this.runtime()?.supports.nestedToolCalls === true ? {
					list: async () => {
						check();
						return structuredClone(this.toolDefinitions(s).filter(t => !t.callers || t.callers.includes("plugin")));
					},
					call: async (name, input, askingSignal) => {
						check();
						if (typeof name !== "string" || !name || !input || typeof input !== "object" || Array.isArray(input)) {
							throw Object.assign(new Error("A tool name and input object are required"), { code: "invalid_request" });
						}
						const childSignal = AbortSignal.any([signal, lifetime.signal, ...(askingSignal ? [askingSignal] : [])]);
						if (childSignal.aborted) throw Object.assign(new Error("The callback was cancelled"), { code: "cancelled" });
						const invoke = () => this.callNested(s, call, name, structuredClone(input), childSignal, depth + 1, turnId, state, start.id, cover);
						const work = toolSpan ? toolSpan.run(invoke) : invoke();
						children.add(work);
						try { return await work; } finally { children.delete(work); }
					},
				} : undefined,
				ask: (request, askingSignal) => {
					check();
					const n = ++asked;
					return this.ask(s, { ...request, toolCallId: call.id, key: request.key ?? `call:${call.id}:${n}` }, found.source.id, askingSignal ? AbortSignal.any([signal, askingSignal]) : signal)
						.then((answer) => { if (answer.pending) pendingQuestions.push(answer.requestId); return answer; });
				},
			}));
			await drain();
			if (isPending(result)) {
				if (depth) return { callId: call.id, status: "refused", content: [text("A nested call cannot be left open")] };
				if (!turnId || !pendingQuestions.length) return { callId: call.id, status: "failed", content: [text("No qualifying question for a pending result")] };
				await this.commit(s, [{ kind: "toolPending", writer: "harness", modelVisible: false, turnId, stepId: call.stepId, toolCallId: call.id, data: { requestIds: [...new Set(pendingQuestions)], toolStartedId: start.id } }]);
				this.emit(s, "tool.ended", { status: "open", reason: result.pending }, found.source.id, { turnId, toolCallId: call.id });
				return { callId: call.id, pending: result.pending };
			}
			const out: ToolResult = { ...result, callId: call.id };
			this.emit(s, "tool.ended", { status: out.status }, found.source.id, { turnId, toolCallId: call.id });
			return out;
		} catch (error) {
			await drain();
			const status = (error as { code?: string })?.code === "lost" ? "outcomeUnknown" : signal.aborted ? "cancelled" : "failed";
			const message = error instanceof Error ? error.message : String(error);
			this.emit(s, "tool.ended", { status }, found.source.id, { turnId, toolCallId: call.id });
			return { callId: call.id, status, content: [text(status === "cancelled" ? "Cancelled" : `Tool failed: ${message}`)] };
		}
	}

	/** Nested calls never use a model offer and are settled by the Harness, not the Runtime. */
	private async callNested(s: Session, parent: ToolCall, name: string, input: Record<string, unknown>,
		signal: AbortSignal, depth: number, turnId: string | undefined, state: TurnState | undefined, parentStart: string, inherited?: CoveringAllow): Promise<ToolResult> {
		const call: ToolCall = { id: this.newId(), name, input, startedBy: "tool", parentCallId: parent.id, actorId: parent.actorId, stepId: parent.stepId };
		const scope = { turnId, stepId: call.stepId, actorId: call.actorId, toolCallId: call.id };
		if (resourceBytes(call) + 2048 > this.reservations.limits.entryBytes || !this.reserveCall(s, call.id)) {
			throw failure("busy", "No capacity for nested call");
		}
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
					const coverage = this.newApprovalPass(call, inherited);
					const gate = await this.toolGate({ sessionId: s.id, turnId, call, definition: registration.definition }, signal, coverage);
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
					const ran = await this.executeTool(s, executed, signal, turnId, state, { depth, registration, approval, inherited });
					result = isPending(ran) ? stop("refused", "A nested call cannot be left open") : ran;
					break;
				}
			}
		} catch (error) {
			processingError = error;
			result = stop(signal.aborted ? "notStarted" : "failed", "Could not process the nested call");
		}
		if (!state?.dispatched.has(call.id) && (result.status === "refused" || result.status === "notStarted")) this.toolDisposition(call, result.status);
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

	private toolDisposition(call: Pick<ToolCall, "id" | "name" | "startedBy" | "parentCallId">, status: string): void {
		telemetryEvent("modular_agent.tool.disposition", { ...toolAttributes(call), "modular_agent.tool.status": status });
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
			this.emit(s, "input.request.closed", answer, "harness", { turnId: request.turnId, toolCallId: callId });
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

	/** A continuation inherits only calls with an intact question checkpoint. In
	 * particular, losing the waiting marker and its proof cannot buy live approval. */
	private intactInheritedCall(s: Session, turnId: string | undefined, call: ToolCall) {
		if (!turnId || call.startedBy !== "model") return true;
		const branch = s.branch();
		const origin = branch.find(e => e.kind === "turnStart" && e.turnId === turnId)?.continuesTurnId;
		if (!origin || branch.some(e => e.kind === "response" && e.turnId === turnId && e.stepId === call.stepId)) return true;
		return !!this.questionSettlement(s, branch, origin, call.id, call.stepId, true);
	}

	/** Return the last answer to the questions named by this call's host checkpoint. */
	private questionSettlement(s: Session, branch: HistoryEntry[], origin: string, callId: string, stepId?: string, dispatch = false) {
		const own = branch.filter(e => !e.erased && e.sessionId === s.id && !s.copied.has(e.id) && e.turnId === origin && e.toolCallId === callId);
		const checkpoints = own.filter(e => e.kind === "toolPending");
		const pending = checkpoints[0];
		const data = pending?.data as { requestIds?: string[]; toolStartedId?: string } | undefined;
		const ids = data?.requestIds;
		if (checkpoints.length !== 1 || !pending.stepId || stepId && stepId !== pending.stepId || !Array.isArray(ids) || !ids.length) return;
		const scope = own.filter(e => e.stepId === pending.stepId);
		if (data?.toolStartedId !== undefined && !scope.some(e => e.kind === "toolStarted" && e.id === data.toolStartedId)) return;
		for (const id of ids) {
			const entry = scope.find(e => e.kind === "inputRequest" && e.requestId === id);
			const request = (entry?.data as { request?: InputRequest })?.request;
			if (!request || request.id !== id || request.sessionId !== s.id || request.toolCallId !== callId ||
				dispatch && request.kind === "approval" && waitingApprovals(s).get(callId)?.entry !== entry ||
				!scope.some(e => e.kind === "inputAnswer" && e.requestId === id)) return;
		}
		return scope.findLast(e => e.kind === "inputAnswer" && !!e.requestId && ids.includes(e.requestId));
	}

	private async modelApprovalGate<T extends { call: ToolCall }>(s: Session, state: TurnState, turnId: string, payload: T): Promise<GateResult<T>> {
		const call = payload.call;
		const wait = waitingApprovals(s).get(call.id);
		const signal = s.running?.abort.signal;
		if (!this.intactInheritedCall(s, turnId, call)) return { value: payload, refused: "Missing continuation checkpoint" };
		this.dispatchAllowances.get(state)?.delete(call.id);
		const branch = s.branch();
		const parkable = this.approvals.maximum && s.settings.approvalWait === "untilDeadline" && call.startedBy === "model" && !call.parentCallId &&
			!branch.some(e => e.kind === "toolStarted" && e.toolCallId === call.id);
		if (!wait && !parkable && !this.coversNested()) return this.toolGate(payload, signal);
		const actorId = state.actors.values().next().value ?? this.actorForJob(s, state.jobs);
		// A continuation can also repeat a tool that left a non-approval question open.
		const currentStep = branch.some(e => e.kind === "response" && e.turnId === turnId && e.stepId === call.stepId);
		const origin = wait?.entry.turnId ?? (!currentStep && branch.find(e => e.kind === "turnStart" && e.turnId === turnId)?.continuesTurnId || turnId);
		const response = branch.find(e => e.kind === "response" && !e.erased && !s.copied.has(e.id) && e.turnId === origin && e.stepId === call.stepId &&
			e.message?.role === "assistant" && e.message.content.some(p => isToolCall(p) && p.id === call.id && p.name === call.name && sameJson(p.arguments, call.input)));
		const offered = branch.some(e => e.kind === "modelRequest" && !e.erased && e.turnId === origin && e.stepId === call.stepId && (e.data as { tools?: string[] })?.tools?.includes(call.name));
		const refuse = () => ({ value: payload, refused: "The waiting approval cannot authorize this call" });
		if (!actorId || !response || !offered || call.startedBy !== "model" || call.parentCallId || call.actorId && call.actorId !== actorId || !this.workRights(s, state.actors, state.jobs).includes("tools")) return refuse();
		if (wait && (!wait.end || !wait.proof || wait.start || wait.result || !this.approvals.validWait(s, wait) ||
			!branch.some(e => e.kind === "turnStart" && !e.erased && e.turnId === turnId && e.continuesTurnId === origin))) return refuse();
		const found = this.findTool(s, call.name);
		if (!found || found.definition.callers && !found.definition.callers.includes("model")) return refuse();
		const policy = s.settings.approval;
		const registration = structuredClone({ source: { plugin: found.plugin, toolSource: found.source.id }, definition: found.definition });
		const coverage = this.newApprovalPass(call);
		const run = () => this.toolGate({ ...payload, definition: found.definition }, signal, coverage);
		const result = wait || parkable ? await this.modelGate.run({ response, turnId, actorId, callId: call.id }, run) : await run();
		if (result.refused === undefined && !result.pending) {
			const final = { ...result.value.call, actorId };
			if (wait && (!this.approvals.matchesApproval(wait, final, s) || !await this.approvals.approverStillAllows(s, wait))) return refuse();
			const allowances = this.dispatchAllowances.get(state) ?? new Map();
			this.dispatchAllowances.set(state, allowances);
			const cover = wait ? this.coversNested() && wait.request.coversNested === true
				? { toolCallId: call.id, requestId: wait.request.id, actorId: wait.decision!.actorId! } : undefined : coverage?.allow;
			allowances.set(call.id, { call: structuredClone(final), binding: { ...registration, call: structuredClone(final) }, policy, cover });
		}
		return result;
	}

	private originalWorkAllows(s: Session, w: WaitingApproval) {
		const origin = w.entry.turnId!;
		const branch = s.branch();
		const work = branch.filter(e => e.turnId === origin && (e.kind === "input" || e.kind === "turnStart"));
		if (!work.some(e => e.kind === "turnStart") || work.some(e => e.erased) || !this.recordedTurnRights(branch, origin).includes("tools")) return false;
		return this.turnAuthority.exit(() => connectionRights.exit(() => {
			for (const e of work) {
				const contributors = (e.data as { authorizers?: {sessionId: string; actorId?: string; jobId?: string}[] }).authorizers;
				if (contributors !== undefined && (!Array.isArray(contributors) || contributors.some(ref => {
					const owner = ref && this.sessions.get(ref.sessionId);
					return !owner || owner.tenant !== s.tenant || Boolean(ref.actorId) === Boolean(ref.jobId) ||
						!this.workRights(owner, ref.actorId ? [ref.actorId] : [], ref.jobId ? [ref.jobId] : []).includes("tools");
				}))) return false;
			}
			return this.workRights(s, this.recordedTurnActors(branch, origin), this.recordedTurnJobs(branch, origin)).includes("tools");
		}));
	}

	private coversNested() { return this.approvalCoversNested && this.plugins().includes("approval"); }

	private newApprovalPass(call: ToolCall, inherited?: CoveringAllow): ApprovalPass | undefined {
		return this.coversNested() ? { callId: call.id, attempt: this.newId(), inherited } : undefined;
	}

	private async toolGate<T extends { call: ToolCall }>(payload: T, signal?: AbortSignal, coverage = this.newApprovalPass(payload.call)): Promise<GateResult<T>> {
		const { call } = payload;
		let changed = false;
		const pass = (p: T, second: boolean) => this.hooks.gate("tool.before", p, {
			invoke: (value, handler) => this.gateSignal.run(signal, () => this.toolWork.run(value.call, () => coverage ? this.approvalPass.run(coverage, handler) : handler())),
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
		if (!changed || first.refused !== undefined || first.pending !== undefined) return first;
		if (coverage) coverage.allow = undefined;
		return pass(first.value, true);
	}

	/** A tool call a UI or plugin starts. The same checks apply. */
	private async callTool(s: Session, call: ToolCall): Promise<ToolResult> {
		await this.erasure.reconcilePending(s);
		if (s.provisional) throw failure("invalid_request", "Session has not admitted its first input");
		if (s.closed) throw failure("not_open", "Session is closed");
		if (s.suspended) throw failure("lost", "Session has lost its writer");
		if (s.moving || s.closing || s.erasing) throw failure("busy", "Session cannot run tools right now");
		if (resourceBytes(call) + 2048 > this.reservations.limits.entryBytes || !this.reserveCall(s, call.id)) {
			throw failure("busy", "No capacity for tool call");
		}
		return untilAborted(s.interruption.signal, async () => {
			s.outsideTools++;
			try { return await this.callOutsideTurn(s, call); }
			finally {
				if (!s.interruption.signal.aborted) this.reservations.release(s, `call:${call.id}`);
				s.outsideTools--;
			}
		});
	}

	private async callOutsideTurn(s: Session, call: ToolCall): Promise<ToolResult> {
		const found = this.findTool(s, call.name);
		const definition = found?.definition;
		const coverage = this.newApprovalPass(call);
		const policy = s.settings.approval;
		const registration = found && structuredClone({ source: { plugin: found.plugin, toolSource: found.source.id }, definition: found.definition });
		const gate = call.actorId && !this.rightsOf(s, call.actorId).includes("tools")
			? { refused: "No tools right", value: { call } }
			: definition?.callers && call.startedBy !== "tool" && !definition.callers.includes(call.startedBy as "ui" | "plugin")
			? { refused: `${call.name} can't be called by a ${call.startedBy}`, value: { call } }
			: await this.toolGate({ sessionId: s.id, call, definition }, undefined, coverage);
		let result: ToolResult;
		if (gate.refused) {
			result = { callId: call.id, status: "refused", content: [text(gate.refused)] };
			this.toolDisposition(call, result.status);
		}
		else {
			const final = gate.value.call;
			const allowance = coverage && registration ? { call: final, binding: { ...registration, call: final }, policy, cover: coverage.allow } : undefined;
			const ran = await this.executeTool(s, final, s.interruption.signal, undefined, undefined, undefined, allowance);
			// Only a turn can carry an open call forward, so outside a turn it fails instead.
			result = isPending(ran) ? { callId: call.id, status: "failed", content: [text(`${call.name} can't wait for an answer outside a turn`)] } : ran;
		}
		const after = await this.toolAfter(s, { sessionId: s.id, call, result });
		result = after.result;
		await this.commit(s, [{ kind: "toolResult", writer: "harness", modelVisible: false, toolCallId: call.id, actorId: call.actorId, message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content, isError: result.status !== "completed" }, data: { status: result.status, value: result.value, call } }]);
		if (after.error) throw after.error;
		return result;
	}

	private async toolAfter(s: Session, payload: { sessionId: string; call: ToolCall; result: ToolResult }, fromInterface = false) {
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
			if (fromInterface && (!validReportContent(after.content) || after.value !== undefined && !isJson(after.value))) {
				throw new Error("Invalid Interface tool output");
			}
			const startId = s.order.findLast(id => {
				const e = s.entries.get(id)!;
				return e.kind === "toolStarted" && e.toolCallId === call.id;
			});
			const start = startId && s.entries.get(startId);
			const shape = ((start || undefined)?.data as { definition?: ToolDefinition } | undefined)?.definition?.returns;
			const violation = after.status === "completed" && shape ? shapeViolation(shape, after.value) : undefined;
			if (violation) throw new Error(`Invalid tool output: ${violation}`);
			if (resourceBytes(after) + 2048 > this.reservations.limits.settlementBytes) {
				const error = failure("result_too_large", "Tool result exceeds reserved capacity");
				return { error, result: { callId: after.callId, status: after.status === "completed" && shape ? "failed" as const : after.status,
					content: [text("result_too_large")] } };
			}
			return { result: after };
		} catch (cause) {
			const error = cause instanceof Error ? cause : new Error(String(cause));
			this.problem("harness", "tool result", error);
			return { error, result: { callId: result.callId, status: fromInterface ? "failed" as const : result.status, content: [text("Tool result could not be processed")] } };
		}
	}

	// ---------- asking actors ----------

	private connections = new Set<InterfaceCapability>();

	/** Attach a connection without adding a persistent plugin registration. */
	connectInterface(part: InterfaceCapability): () => void {
		this.connections.add(part);
		return () => { this.connections.delete(part); };
	}

	private interfaces(): InterfaceCapability[] {
		return [...this.useAll<InterfaceCapability>("interface"), ...this.connections];
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

	private hasQuestionRoute(s: Session, r: InputRequest) {
		return this.turnAuthority.exit(() => connectionRights.exit(() => r.approvalWait
			? [...s.actors.keys()].some(id => this.approvals.eligibleMember(s, r.answerers.length ? r.answerers : undefined, id))
			: this.hasAnswerer(s, r)));
	}

	private async closeUnanswerable(s: Session) {
		const closed = [];
		for (const { request, resolve } of s.requests.values()) {
			if (!this.hasQuestionRoute(s, request)) {
				closed.push(resolve({ requestId: request.id, actorId: "harness", declined: true, reason: request.kind === "approval" ? "refused" : "noLongerAnswerable",
					...(s.revokedQuestions.has(request.id) && {cause:"revoked" as const}) }));
			}
		}
		await Promise.all(closed);
	}

	private async closeRevokedWaits(s: Session) {
		await this.closeUnanswerable(s);
		for (const r of this.waitingRequests(s)) {
			if (r.approvalWait || !s.revokedQuestions.has(r.id) || this.hasQuestionRoute(s, r)) continue;
			s.lateAnswers.add(r.id);
			try {
				const answer: Answer = {requestId:r.id, actorId:"harness", declined:true, reason:"noLongerAnswerable", cause:"revoked"};
				await this.recordAnswer(s, r, answer);
				s.waiting.delete(r.id);
				this.emitAnswer(s, r, answer, true);
			} finally { s.lateAnswers.delete(r.id); }
			this.maybeContinueOpenCalls(s);
		}
	}

	private recordedOpenQuestionEntries(s: Session, branch: HistoryEntry[]) {
		const settled = new Set(s.order.map(id => s.entries.get(id)!).filter(e =>
			e.kind === "inputAnswer" || e.kind === "inputClosed" || e.kind === "secretAnswerAccepted").map(e => e.requestId));
		return branch.filter(e => e.kind === "inputRequest" && !s.copied.has(e.id) && !e.erased && e.requestId && !settled.has(e.requestId));
	}

	private recordedOpenRequests(s: Session): InputRequest[] {
		return this.recordedOpenQuestionEntries(s, s.branch()).map(readRequest);
	}

	/** A recorded answer to the question with this key, if it can still be used. */
	private recordedAnswer(s: Session, draft: BoundRequest, approval?: ApprovalBinding): { request: InputRequest; answer?: Answer } | undefined {
		const branch = s.branch();
		const entry = [...branch].reverse().find((e) => e.kind === "inputRequest" && !e.erased && readRequest(e).key === draft.key);
		if (!entry) return undefined;
		const request = readRequest(entry);
		if (request.approvalWait || request.kind !== draft.kind || request.question !== draft.question || request.details !== draft.details
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
		const answered = branch.find((e) => e.kind === "inputAnswer" && !e.erased && e.requestId === request.id);
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
			if (acceptSecret && !(await this.commit(s, [{ ...fields, kind: "secretAnswerAccepted" }])).length) throw failure("lost", "Secret acceptance did not commit");
			let outcome;
			try { outcome = await this.secretStore()!.activate(this.secretScope(s, request.id)); }
			catch { throw new Error("Could not confirm secret activation"); }
			kept = outcome === "activated" ? { requestId: request.id, actorId: answer.actorId, stored: request.credential }
				: { requestId: request.id, actorId: answer.actorId, declined: true, reason: "superseded" };
		}
		const record = async () => {
			const systemClosure = kept.actorId === "harness" && kept.declined;
			const [entry] = await this.commit(s, [{ ...fields, kind: "inputAnswer", actorId:systemClosure ? undefined : kept.actorId,
				data:systemClosure ? {requestId:kept.requestId, declined:true, reason:kept.reason, ...(kept.cause && {cause:kept.cause})} : kept }]);
			if (!entry) throw failure("lost", "Answer did not commit");
			const system = kept.actorId === "harness" && kept.reason &&
				["cancelled", "noLongerAnswerable", "restart", "timeLimit", "superseded", "refused", "erased"].includes(kept.reason) ? kept.reason : undefined;
			telemetryEvent("modular_agent.question.close", { "modular_agent.question.id": request.id,
				"modular_agent.question.kind": request.kind, "modular_agent.question.disposition": kept.declined ? system ?? "declined" : kept.stored ? "stored" : "answered" });
		};
		if (activeOperation()?.isOpen && activeOperation()?.spanContext) await record();
		else await startOperation("modular_agent.question.answer", { ...conversation(s.id), "modular_agent.turn.id": request.turnId, "modular_agent.step.id": stepId }).observe(record);
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
		const answers = new Map(entries.filter(e => e.kind === "inputAnswer").map(e => [e.requestId, e]));
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
		if ("approvalWait" in draft || "deadlineAt" in draft || "coversNested" in draft) throw failure("invalid_request", "Only the Harness sets the approval lifetime and coverage");
		const pass = this.approvalPass.getStore();
		const call = this.toolWork.getStore();
		if (pass && askedBy === "approval" && draft.kind === "approval" && call && call.id === draft.toolCallId && call.id === pass.callId) {
			if (call.parentCallId && pass.inherited) {
				return { requestId: pass.inherited.requestId, actorId: pass.inherited.actorId, value: "allow" };
			}
			if (!call.parentCallId) {
				// A repeated dispatch gets a fresh key. Only exact inputs within this gate pass can reuse the answer.
				const answer = await this.deliverQuestion(s, { ...draft, coversNested: true, key: draft.key + ":" + pass.attempt,
					question: draft.question + " This approval also covers its nested calls." }, askedBy, signal);
				if (!answer.declined && answer.value === "allow") pass.allow = { toolCallId: call.id, requestId: answer.requestId, actorId: answer.actorId };
				return answer;
			}
		}
		return this.deliverQuestion(s, draft, askedBy, signal);
	}

	private async deliverQuestion(s: Session, draft: BoundRequest, askedBy: string, signal?: AbortSignal): Promise<Answer> {
		const gateSignal = this.gateSignal.getStore();
		signal = signal && gateSignal ? AbortSignal.any([signal, gateSignal]) : signal ?? gateSignal;
		signal?.throwIfAborted();
		await this.erasure.admitHistory(s);
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
		const gate = this.modelGate.getStore();
		if (draft.kind === "approval" && askedBy === "approval" && gate && approval && draft.toolCallId === gate.callId && approval.call.id === gate.callId && approval.call.startedBy === "model" && !approval.call.parentCallId &&
			approval.source.plugin !== INTERFACE_SOURCE && (this.approvals.maximum && s.settings.approvalWait === "untilDeadline" || waitingApprovals(s).has(approval.call.id))) {
			return this.approvals.parkApproval(s, draft, approval, gate);
		}
		let reopened = false;
		if (draft.key) {
			// Changed input or registration needs a new approval identity, not a replay of the old one.
			let key = draft.coversNested || approval?.call.startedBy === "tool" ? draft.key + ":" + approvalKey(approval) : draft.key;
			if (draft.kind === "secret") {
				const branch = s.branch();
				for (const entry of branch) {
					if (entry.kind !== "inputRequest" || entry.erased) continue;
					const prior = readRequest(entry);
					if (prior.kind === "secret" && prior.key === key && branch.some(e => e.kind === "inputAnswer" &&
						e.requestId === prior.id && (e.data as Answer | undefined)?.reason === "restart")) key += ":" + prior.id;
				}
			}
			draft = { ...draft, key };
			request = { ...request, key };
			const recorded = this.recordedAnswer(s, draft, approval);
			if (recorded?.answer) {
				this.emit(s, "input.request.reused", { requestId: recorded.request.id, key: draft.key }, "harness", { toolCallId: request.toolCallId });
				return recorded.answer;
			}
			if (recorded) {
				request = { ...recorded.request, turnId: s.running?.turnId ?? recorded.request.turnId };
				reopened = true;
			}
		}
		const viewers = this.viewersFor(s, request);
		if (!reopened) {
			const data = { request: { ...request, answerable: viewers.length > 0 }, ...approval };
			const bytes = resourceBytes(data) + 2048;
			const key = `question:${request.id}`;
			const unit = this.reservations.limits.settlementBytes;
			if (bytes > this.reservations.limits.entryBytes || !this.reservations.reserve(s, key, { storageBytes: bytes + 3 * unit })) {
				throw failure("busy", "No capacity for the question and its closing records");
			}
			try {
				await this.commit(s, [{ kind: "inputRequest", writer: askedBy, modelVisible: false, turnId: request.turnId, stepId,
					requestId: request.id, toolCallId: request.toolCallId, data }]);
			} catch (error) {
				if (!s.interruption.signal.aborted) this.reservations.release(s, key);
				throw error;
			}
		}
		telemetryEvent("modular_agent.question.open", { "modular_agent.question.id": request.id, "modular_agent.question.kind": request.kind });
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
					if (s.suspended) { const declined = { ...answer, declined: true }; resolve(declined); return Promise.resolve(declined); }
					const work = this.recordAnswer(s, request, answer, stepId, request.kind === "secret" && !answer.declined).then(kept => {
						this.emitAnswer(s, request, kept);
						s.lateAnswers.delete(request.id);
						resolve(kept);
						return kept;
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
					this.emit(s, "input.request.waiting", { requestId: request.id }, "harness", { toolCallId: request.toolCallId });
					resolve({ requestId: request.id, actorId: "harness", pending: true });
				}, request.timeLimitMs);
			}
			s.requests.set(request.id, open);
			if (signal?.aborted) return cancel();
			signal?.addEventListener("abort", cancel, { once: true });
			this.emit(s, "input.request.opened", { request, reopened }, askedBy, { toolCallId: request.toolCallId });
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
			&& !s.requests.has(r.id) && !s.lateAnswers.has(r.id) && (r.approvalWait !== "untilDeadline" || !!waitingApprovals(s).get(r.toolCallId!)?.end));
	}

	/** Answer a question left open past its turn. The answer is recorded, then the open calls carry on if they can. */
	private async answerLate(s: Session, answer: Answer): Promise<{ accepted: boolean; reason?: string }> {
		const request = this.waitingRequests(s).find((r) => r.id === answer.requestId);
		if (!request || request.approvalWait) return { accepted: false, reason: "The request is closed or can no longer be answered" };
		if (!this.mayAnswer(s, request, answer.actorId)) return { accepted: false, reason: `${answer.actorId} may not answer this request` };
		s.lateAnswers.add(request.id);
		const previous = s.settling ?? Promise.resolve();
		const span = startOperation("modular_agent.question.answer", { ...conversation(s.id), "modular_agent.turn.id": request.turnId });
		const work = previous.then(() => span.observe(async () => {
			const kept = await this.recordAnswer(s, request, answer,
				s.order.map(id => s.entries.get(id)!).find(e => e.requestId === request.id)?.stepId,
				request.kind === "secret" && !answer.declined);
			s.lateAnswers.delete(request.id);
			for (const i of this.viewersFor(s, request)) i.onInputRequestClosed?.(request.id);
			this.emitAnswer(s, request, kept, true);
			s.waiting.delete(request.id);
			this.maybeContinueOpenCalls(s, currentSpan());
			return kept;
		}));
		s.settling = work.then(() => {}, error => this.problem("harness", "late answer", error)).finally(() => {
			if (s.settling === tracked) s.settling = undefined;
		});
		const tracked = s.settling;
		const kept = await work;
		return { accepted: !kept.declined || !!answer.declined };
	}

	/** Tool calls on the current branch that have no result and are not part of a running turn. */
	private openCalls(s: Session, origin?: string): InterruptedTurn["calls"] {
		const branch = s.branch();
		const kept = s.order.map((id) => s.entries.get(id)!);
		const results = new Set(kept.filter((e) => e.kind === "toolResult").map((e) => e.toolCallId));
		const continued = new Set(kept.filter((e) => e.kind === "turnStart").map((e) => e.continuesTurnId));
		const open = new Set(branch.flatMap((e) => e.kind === "turnEnd" && !e.erased && (origin ? e.turnId === origin : !continued.has(e.turnId)) ? (e.data as { result?: TurnOutcome["result"] }).result?.openToolCalls ?? [] : []));
		const calls: InterruptedTurn["calls"] = [];
		const handoffs = this.interfaceRecords(s);
		for (const e of branch) {
			if (e.message?.role !== "assistant") continue;
			for (const part of e.message.content.filter(isToolCall)) {
				if (open.has(part.id) && !results.has(part.id) && !handoffs.has(part.id)) calls.push({ id: part.id, name: part.name, input: part.arguments ?? {}, stepId: e.stepId, started: false, safeToRepeat: false });
			}
		}
		return calls;
	}

	/** Each ended turn has its own queue key. The last required decision fixes ready order. */
	private readyContinuations(s: Session) {
		const branch = s.branch();
		const visible = new Map(branch.map((e, index) => [e.id, { e, index }]));
		const used = new Set(s.order.map(id => s.entries.get(id)!).filter(e => e.kind === "turnStart").map(e => e.continuesTurnId));
		const handoffs = this.interfaceRecords(s);
		const requests = this.recordedOpenRequests(s);
		const ready: { origin: string; record: HistoryEntry; order: number; sources: string[] }[] = [];
		for (const end of branch) {
			if (!end.turnId || end.kind !== "turnEnd" || end.erased || used.has(end.turnId) || s.copied.has(end.id)) continue;
			const ids = (end.data as { result?: TurnOutcome["result"] })?.result?.openToolCalls ?? [];
			if (!ids.length || requests.some(r => r.toolCallId && ids.includes(r.toolCallId))) continue;
			const decisions = ids.map(id => {
				const item = handoffs.get(id);
				if (item) {
					if (!this.interfaceSources.size || this.runtime()?.supports.interfaceTools !== true || !item.data || !item.checkpoint || item.checkpoint.turnId !== end.turnId || !visible.has(item.checkpoint.id) || !item.result || item.result.erased || item.result.turnId !== end.turnId || item.result.stepId !== item.checkpoint.stepId) return undefined;
					return item.result && visible.get(item.result.id);
				}
				const answer = this.questionSettlement(s, branch, end.turnId!, id);
				return answer && visible.get(answer.id);
			});
			if (decisions.some(d => !d)) continue;
			const last = decisions.reduce((a,b) => a!.index > b!.index ? a : b)!;
			ready.push({ origin: end.turnId, record: last.e, order: Math.max(last.index, visible.get(end.id)!.index),
				sources: [end.id, ...new Set(decisions.map(d => d!.e.id))] });
		}
		return ready.sort((a,b) => a.order - b.order);
	}

	private maybeContinueOpenCalls(s: Session, trace?: ReturnType<typeof currentSpan>): void {
		if (s.closing || s.closed || s.suspended || s.erasing || s.moving || s.reopening) return;
		const branch = s.branch();
		for (const { origin, record, sources } of this.readyContinuations(s)) {
			if (s.followUps.some(q => q.continueTurnId === origin)) continue;
			const owners = this.recordedTurnActors(branch, origin);
			const jobs = this.recordedTurnJobs(branch, origin);
			const start = branch.find(e => e.kind === "turnStart" && e.turnId === origin && !e.erased);
			if (!start || !owners.length && !jobs.length) continue;
			const startedBy: QueuedInput["startedBy"] = record.kind === "toolResult" ? { kind: "toolResult", id: record.id }
				: { kind: "answer", id: (record.data as Answer).requestId };
			const queued: QueuedInput = { id: `continue:${origin}`, content: [], actorId: owners[0] ?? start.actorId ?? "harness",
				authorityActors: owners, authorityJobs: jobs, startingRights: this.recordedTurnRights(branch, origin),
				when: "after", startedBy, kind: "continue", continueTurnId: origin, trace, sources };
			const scope = this.offerScope.getStore();
			if (scope) this.queuedOffers.set(queued, scope);
			s.followUps.push(queued);
		}
		this.startQueued(s);
	}

	private emitAnswer(s: Session, request: InputRequest, answer: Answer, late = false): void {
		const ids = { actorId: answer.actorId, toolCallId: request.toolCallId, turnId: request.turnId };
		if (answer.reason === "noLongerAnswerable") this.emit(s, "input.request.unanswerable", { requestId: request.id }, "harness", ids);
		if (answer.actorId !== "harness") this.emit(s, "input.request.answered", { requestId: request.id, declined: answer.declined ?? false }, "harness", ids);
		this.emit(s, "input.request.closed", { requestId: request.id, declined: answer.declined ?? false, value: answer.value, late }, "harness", ids);
	}

	private async submitAnswer(s: Session, answer: Answer, handle?: object): Promise<{ accepted: boolean; reason?: string }> {
		await this.erasure.admitHistory(s);
		if (resourceBytes(answer) + 2048 > this.reservations.limits.settlementBytes) throw failure("result_too_large", "Answer exceeds reserved capacity");
		const find = () => s.requests.get(answer.requestId)?.request ?? this.waitingRequests(s).find(r => r.id === answer.requestId);
		const may = (request: InputRequest) => this.mayAnswer(s, request, answer.actorId) &&
			(!answer.delegatedBy || this.mayAnswer(s, { ...request, answerers: [] }, answer.delegatedBy));
		const request = find();
		if (!request || !may(request)) return { accepted: false };
		if (request.approvalWait) return this.approvals.decideWaiting(s, request, answer, handle);
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
		if (!open) return this.answerLate(s, answer);
		const kept = await open.resolve(answer);
		return { accepted: !kept.declined || !!answer.declined };
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

	// ---------- declarations ----------

	private recoveryPolicy() {
		const supports = this.runtime()?.supports;
		const input = supports?.queuedInputAfterRestart === "run" ? "run" : "handedBack";
		const jobs = supports?.queuedJobReportsAfterRestart ?? (supports?.queuedInputAfterRestart ? input : "run");
		return { input, jobs: jobs === "handedBack" ? "handedBack" : "run" };
	}

	enableWaitingApprovals(maximum: number): void {
		if (!Number.isSafeInteger(maximum) || maximum <= 0 || !this.questionsOutlastTurns || !this.plugins().includes("approval") ||
			this.runtime()?.supports.interfaceTools !== true) throw failure("invalid_composition", "Waiting approvals need a positive Duration and a Runtime that continues settled calls");
		this.approvals.maximum = maximum;
	}

	declaration(s?: Session): Declaration {
		const runtime = this.runtime();
		const store = this.use<HistoryStore>("history-store");
		const provider = s ? this.providerFor(s) : undefined;
		const env = this.use<WorkingEnvironment>("working-environment");
		const recovery = this.recoveryPolicy();
		return {
			inputDuringTurn: runtime?.supports.inputDuringTurn === true,
			...(this.interfaceSources.size > 0 && runtime?.supports.interfaceTools === true ? { interfaceTools: true } : {}),
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
			erasure: (!!this.erasure.pendingRegistry() || !!this.erasure.httpErasure()) && (!store || !!store.erase),
			inputKeys: true,
			resourceReservations: this.reservations.declaration(),
			telemetry: 1,
			portableSessions: true,
			nestedToolCalls: runtime?.supports.nestedToolCalls === true,
			mixedActorInput: "shared",
			erasureDuringTurn: "refused",
			questionsOutlastTurns: this.questionsOutlastTurns,
			...(this.approvals.maximum === undefined ? {} : { approvalsOutlastTurns: true, lateAnswersStartTurns: true }),
			...(this.coversNested() ? { approvalCoversNested: true } : {}),
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
export function parseModel(value: unknown): { provider: string; id: string } | undefined {
	if (typeof value === "string" && value.includes("/")) {
		const i = value.indexOf("/");
		return { provider: value.slice(0, i), id: value.slice(i + 1) };
	}
	if (value && typeof value === "object" && "provider" in value && "id" in value) return value as { provider: string; id: string };
	return undefined;
}

const PROVISIONAL_SETUP = new Set(["tenant", "actorJoined", "actorLeft", "setting", "limit", "plugins", "harness.parentAuthority"]);

const STANDARD_ENTRY_KINDS = new Set("limit tenant actorJoined actorLeft setting inputAccepted inputHandedBack input turnStart modelRequest response toolStarted toolPending modular-agent.interfaceHandoff toolResult inputRequest secretAnswerAccepted inputAnswer resultFeedback modular-agent.stepAfter turnEnd summary position erasure jobStarted jobCleanupUnconfirmed jobEnded plugins".split(" "));

function copyForkPrefix(branch: HistoryEntry[], sessionId: string, makeId: () => string): HistoryEntry[] {
	const kept = branch.filter((e) => !e.erased && e.kind !== "position" && e.kind !== TURN_TRACE);
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
		const e: HistoryEntry = { ...structuredClone(historyForPeer(old)), id: entries.get(old.id)!, parentId, sessionId, sources: [old.id] };
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

/** Wait for work against one writer generation, independently of event delivery. */
export async function untilAborted<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const subscription = addAbortListener(signal, () => reject(signal.reason));
		void Promise.resolve().then(() => {
			signal.throwIfAborted();
			return work();
		}).then(resolve, reject).finally(() => subscription[Symbol.dispose]());
	});
}

const turnLimit = (limit: string) => Object.assign(new Error(`Turn limit: ${limit}`), { code: "turn_limit", limit });

function approvalKey(binding?: ApprovalBinding): string {
	return createHash("sha256").update(JSON.stringify(binding ?? null, (_, value) =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value)).digest("hex");
}

type BoundRequest = InputRequestDraft & { coversNested?: true; boundCall?: Pick<ToolCall, "name" | "input"> };

function readRequest(entry: HistoryEntry): InputRequest {
	const request = (entry.data as { request: InputRequest }).request;
	if (!entry.requestId || entry.requestId !== request.id) throw failure("unavailable", "Question identity does not match its envelope");
	return { ...request, sessionId: entry.sessionId, answerers: request.answerers ?? [], toolCallId: entry.toolCallId ?? request.toolCallId ?? undefined, turnId: entry.turnId ?? request.turnId ?? undefined };
}

export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function thinkingLevels(model?: ModelInfo): string[] {
	return REASONING_LEVELS.filter(level => model?.thinking?.includes(level) === true);
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

function intersectRights(...ceilings: readonly Authority[][]): Authority[] {
	return ceilings.length ? ALL_AUTHORITY.filter(right => ceilings.every(ceiling => Array.isArray(ceiling) && ceiling.includes(right))) : [];
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
