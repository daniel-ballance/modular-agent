import { TurnExecution, recordedSnapshot, tokenCount, inputActors } from "./turn-execution.js";
import { TurnModelAccess } from "./model-access.js";
import { ToolDispatch } from "./tool-dispatch.js";
import type { TurnState } from "./turn-state.js";
import { shapeViolation } from "./result-shape.js";
import { InterfaceToolRoutes, type InterfaceConnection } from "./interface-tool-routes.js";
import { connectionRights, intersectConnectionRights, type ConnectionRights } from "./connection-authority.js";
import { InputRequests, readRequest } from "./input-requests.js";
import { Jobs, type JobStart, type KeptJob } from "./jobs.js";
import { SessionErasure } from "./session-erasure.js";
import { ApprovalReconciliation } from "./approval-reconciliation.js";
import { failure, turnLimit } from "./failure.js";
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
/**
 * The Harness: hosts plugins, offers the plugin API, keeps sessions.
 * It runs no turns, calls no models and runs no tools itself.
 */
export class Harness {
	private readonly turns: TurnExecution = new TurnExecution({
		intersectRights,
		commit: (...args) => this.commit(...args),
		newId: (...args) => this.newId(...args),
		problem: (...args) => this.problem(...args),
		reservations: () => this.reservations,
		emit: (...args) => this.emit(...args),
		runtime: (...args) => this.runtime(...args),
		modelAccess: (...args) => this.modelAccess(...args),
		interfaceTools: () => this.interfaceTools,
		toolDefinitions: (...args) => this.toolDefinitions(...args),
		turnAuthority: () => this.turnAuthority,
		tenantBudgetReached: (...args) => this.tenantBudgetReached(...args),
		environmentFor: (...args) => this.environmentFor(...args),
		projectOf: (...args) => this.projectOf(...args),
		checkScopedWork: (...args) => this.checkScopedWork(...args),
		erasure: () => this.erasure,
		hooks: () => this.hooks,
		use: (...args) => this.use(...args),
		turnModels: () => this.turnModels,
		agentName: () => this.agentName,
		now: (...args) => this.now(...args),
		approvals: () => this.approvals,
		questions: () => this.questions,
		admit: (...args) => this.admit(...args),
		findTool: (...args) => this.findTool(...args),
		workRights: (...args) => this.workRights(...args),
		actorForJob: (...args) => this.actorForJob(...args),
		tools: () => this.tools,
		providerFor: (...args) => this.providerFor(...args),
	});

	private readonly turnModels: TurnModelAccess = new TurnModelAccess({
		newId: (...args) => this.newId(...args),
		turnAuthority: () => this.turnAuthority,
		tenantBudgetReached: (...args) => this.tenantBudgetReached(...args),
		erasure: () => this.erasure,
		reservations: () => this.reservations,
		checkScopedWork: (...args) => this.checkScopedWork(...args),
		checkWriter: (...args) => this.checkWriter(...args),
		hooks: () => this.hooks,
		commit: (...args) => this.commit(...args),
		emit: (...args) => this.emit(...args),
		reserveCall: (...args) => this.reserveCall(...args),
		step: (...args) => this.turns.step(...args),
	});

	private readonly tools: ToolDispatch = new ToolDispatch({
		now: (...args) => this.now(...args),
		interfaceTools: () => this.interfaceTools,
		approvals: () => this.approvals,
		intactInheritedCall: (...args) => this.turns.intactInheritedCall(...args),
		findTool: (...args) => this.findTool(...args),
		actorForJob: (...args) => this.actorForJob(...args),
		workRights: (...args) => this.workRights(...args),
		environmentFor: (...args) => this.environmentFor(...args),
		projectOf: (...args) => this.projectOf(...args),
		checkWriter: (...args) => this.checkWriter(...args),
		commit: (...args) => this.commit(...args),
		erasure: () => this.erasure,
		agentName: () => this.agentName,
		emit: (...args) => this.emit(...args),
		jobWork: () => this.jobWork,
		scopedEnvironment: (...args) => this.scopedEnvironment(...args),
		runtime: (...args) => this.runtime(...args),
		toolDefinitions: (...args) => this.toolDefinitions(...args),
		questions: () => this.questions,
		newId: (...args) => this.newId(...args),
		reservations: () => this.reservations,
		reserveCall: (...args) => this.reserveCall(...args),
		problem: (...args) => this.problem(...args),
		approvalCoversNested: () => this.approvalCoversNested,
		plugins: (...args) => this.plugins(...args),
		hooks: () => this.hooks,
		rightsOf: (...args) => this.rightsOf(...args),
	});

	private readonly interfaceTools: InterfaceToolRoutes = new InterfaceToolRoutes({
		runtime: (...args) => this.runtime(...args),
		plugins: (...args) => this.plugins(...args),
		useAll: (...args) => this.useAll(...args),
		now: (...args) => this.now(...args),
		hasItem: (...args) => this.hasItem(...args),
		replacements: () => this.replacements,
		intersectRights,
		load: (...args) => this.load(...args),
		session: (...args) => this.session(...args),
		withConnectionActor: (...args) => this.withConnectionActor(...args),
		actorRights: (...args) => this.actorRights(...args),
		sessions: () => this.sessions,
		hooks: () => this.hooks,
		problem: (...args) => this.problem(...args),
		findTool: (...args) => this.findTool(...args),
		erasure: () => this.erasure,
		admit: (...args) => this.admit(...args),
		checkWriter: (...args) => this.checkWriter(...args),
		newId: (...args) => this.newId(...args),
		commit: (...args) => this.commit(...args),
		workRights: (...args) => this.workRights(...args),
		agentName: () => this.agentName,
		maybeContinueOpenCalls: (...args) => this.turns.maybeContinueOpenCalls(...args),
		approvals: () => this.approvals,
		recordedTurnActors: (...args) => this.turns.recordedTurnActors(...args),
		recordedTurnJobs: (...args) => this.turns.recordedTurnJobs(...args),
		recordedTurnRights: (...args) => this.turns.recordedTurnRights(...args),
		turnAuthority: () => this.turnAuthority,
		toolAfter: (...args) => this.tools.toolAfter(...args),
		commitNow: (...args) => this.commitNow(...args),
		emit: (...args) => this.emit(...args),
	});

	private readonly questions: InputRequests = new InputRequests({
		useAll: (...args) => this.useAll(...args),
		actorRights: (...args) => this.actorRights(...args),
		turnAuthority: () => this.turnAuthority,
		approvals: () => this.approvals,
		maybeContinueOpenCalls: (...args) => this.turns.maybeContinueOpenCalls(...args),
		use: (...args) => this.use(...args),
		home: () => this.home,
		commit: (...args) => this.commit(...args),
		toolWork: () => this.tools.toolWork,
		questionsOutlastTurns: () => this.questionsOutlastTurns,
		approvalPass: () => this.tools.approvalPass,
		gateSignal: () => this.tools.gateSignal,
		erasure: () => this.erasure,
		newId: (...args) => this.newId(...args),
		findTool: (...args) => this.findTool(...args),
		modelGate: () => this.tools.modelGate,
		emit: (...args) => this.emit(...args),
		reservations: () => this.reservations,
		problem: (...args) => this.problem(...args),
		openCalls: (...args) => this.turns.openCalls(...args),
	});

	private readonly jobWork: Jobs = new Jobs({
		erasure: () => this.erasure,
		workActors: (...args) => this.workActors(...args),
		turnAuthority: () => this.turnAuthority,
		workRights: (...args) => this.workRights(...args),
		reservations: () => this.reservations,
		newId: (...args) => this.newId(...args),
		reserveJob: (...args) => this.reserveJob(...args),
		commit: (...args) => this.commit(...args),
		toolWork: () => this.tools.toolWork,
		emit: (...args) => this.emit(...args),
		problem: (...args) => this.problem(...args),
		admit: (...args) => this.admit(...args),
		jobReportsStartTurns: () => this.jobReportsStartTurns,
		startQueued: (...args) => this.turns.startQueued(...args),
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
		interfaces: () => this.questions.interfaces(),
		emitAnswer: (...args) => this.questions.emitAnswer(...args),
		toolDisposition: (...args) => this.tools.toolDisposition(...args),
		maybeContinueOpenCalls: (...args) => this.turns.maybeContinueOpenCalls(...args),
		problem: (...args) => this.problem(...args),
		intersectRights,
	});
	private readonly settingsDuringTurn?: "nextTurn" | "refused";
	private readonly jobReportsStartTurns: boolean;
	private readonly rejectUnknownModel: boolean;
	private readonly agentName?: string;
	private newId: () => string;
	private refusedTools = new Set<string>();
	private turnAuthority = new AsyncLocalStorage<{ sessionId: string; actors: Set<string>; jobs: Set<string>; state?: Pick<TurnState, "connectionRights" | "startingRights"> }>();
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
			invalidateErasedHandoffs: (...args) => this.interfaceTools.invalidateErasedHandoffs(...args),
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
				await this.questions.closeRevokedWaits(s);
				await this.approvals.reconcileApprovals(s);
			},
			presentActors: (id) => this.questions.presentActors(this.session(id)),
			presenceChanged: (id) => { const s = this.sessions.get(id); if (s) {
				this.approvals.presenceChanged(s);
				void this.questions.closeUnanswerable(s).catch(e => this.problem("harness", "close unanswerable wait", e));
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
			callTool: (sessionId, call) => this.tools.callTool(this.session(sessionId), { ...call, id: call.id ?? this.newId() }),
			ask: (sessionId, request) => this.questions.ask(this.session(sessionId), request, pluginName),
			deferTool: (id, turnId, question) => this.questions.deferTool(this.session(id), turnId, question, pluginName),
			refreshApprovals: id => this.approvals.reconcileApprovals(this.session(id)),
			registerApprovalRoute: policy => this.approvals.registerRoute(policy),
			presentApproval: (id, requestId, delivery) => this.approvals.presentApproval(this.session(id), requestId, delivery),
			submitAnswer: (sessionId, answer, handle) => this.questions.submitAnswer(this.session(sessionId), answer, handle),
			openRequests: (sessionId) => {
				const s = this.session(sessionId);
				return [...[...s.requests.values()].map((r) => r.request), ...this.questions.waitingRequests(s)];
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
						const tools = snapshot.tools.filter(tool => (!tool.callers || tool.callers.includes("model")) && !this.interfaceTools.interfaceSources.has(tool.name) &&
							(offered == null || Array.isArray(offered) && offered.includes(tool.name)) && allowed.some(t => isDeepStrictEqual(t, tool)));
						const settings = this.turns.turnSettings(session, model.model);
						const maxOutput = Math.min(settings.maxOutput ?? Infinity, snapshot.settings.maxOutput ?? Infinity);
						const request = { ...snapshot, tools, providerTools: "none" as const, settings: { ...snapshot.settings,
							reasoning: snapshot.settings.reasoning ?? settings.reasoning, maxOutput: Number.isFinite(maxOutput) ? maxOutput : undefined } };
						return this.turnModels.turnModel(session, undefined, { ...authority, sources: new Map(), actors: scope.actors, jobs: scope.jobs }, model, live)
							.request(request, { signal, stepId });
					});
					tail = pending.then(() => {}, () => {});
					return pending;
				},
				ask: async request => { live(); return this.questions.ask(session, request, command.plugin, signal); },
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
			await this.questions.recoverSecrets(s);
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
		await this.tools.recoverNestedCalls(s);
		await this.interfaceTools.recoverInterfaceCalls(s);
		await this.approvals.reconcileApprovals(s, true);
		await this.recoverInterruptedTurn(s);
		await this.recoverReports(s);
		s.reopening = false;
		this.turns.startQueued(s);
		this.emit(s, "session.started", { meta: s.meta, resumed: true }, "harness");
		// Questions left open past their turn are still answerable after a restart.
		for (const request of this.questions.waitingRequests(s)) {
			this.emit(s, "input.request.opened", { request, waiting: true }, "harness", { toolCallId: request.toolCallId });
			for (const i of this.questions.viewersFor(s, request)) i.onInputRequest?.(request);
		}
		this.turns.maybeContinueOpenCalls(s);
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
		const questions = this.questions.recordedOpenQuestionEntries(s, branch).filter(e => {
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
		const toolCalls = !viewer.routeId || !rights.includes("tools") ? 0 : this.interfaceTools.unsettledHandoffs(s).filter(({data, checkpoint}) => {
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
		const pending = new Map((lastStart.continuesTurnId ? this.turns.openCalls(s, lastStart.continuesTurnId) : []).map((c) => [c.id, c]));
		for (const c of interruptedCalls(branch, lastStart.turnId)) pending.set(c.id, c);
		// This host has no restart-time cleanup confirmation from its environments.
		const settled = new Set(s.order.map((id) => s.entries.get(id)!).filter((e) => e.kind === "toolResult").map((e) => e.toolCallId));
		const calls = [...pending.values()].filter((c) => !settled.has(c.id)).map((c) => ({ ...c, safeToRepeat: false }));
		const interrupted: InterruptedTurn = { turnId: lastStart.turnId, calls };
		this.emit(s, "turn.interrupted", { pending: interrupted.calls.length }, "harness", { turnId: interrupted.turnId });
		// Not awaited: the resumed turn may wait for an answer that only an Interface opened after this can give.
		void connectionRights.exit(() => this.turns.launch(s, interrupted.turnId, (signal) => this.turns.resumeTurn(s, interrupted, snapshot, signal)));
	}

	async forkSession(sessionId: string, entryId: string): Promise<string> {
		const s = this.session(sessionId);
		await this.erasure.admitHistory(s);
		if (s.erasing) throw failure("busy", "Erasure is in progress");
		// Forking at unfinished work would copy work that is still running: refused.
		if (s.running || this.jobWork.runningJobs(s).length || this.questions.waitingRequests(s).length || this.turns.openCalls(s).length || this.interfaceTools.unsettledHandoffs(s).length) throw failure("busy", "Can't fork while the session has unfinished work: a running turn, a job, or a call waiting for an answer");
		const target = s.entries.get(entryId);
		if (!target) throw Object.assign(new Error("Unknown fork target"), { code: "not_found" });
		if (target.kind === "position") throw Object.assign(new Error("Cannot fork a position record"), { code: "conflict" });
		const id = await this.startSession({ forkFrom: { sessionId, entryId }, actor: [...s.actors.values()][0] });
		await this.suspendSession(id);
		return id;
	}

	private stopSessionWork(s: Session): void {
		s.suspended = true;
		this.interfaceTools.clearInterfaceWork(s);
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
			const needsCancel = !!s.running || this.jobWork.runningJobs(s).length > 0 || this.interfaceTools.unsettledHandoffs(s).length > 0;
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
		this.interfaceTools.clearInterfaceWork(s);
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
				? this.questions.recordedOpenRequests(s).map(r => [r,this.questions.hasQuestionRoute(s,r)] as const) : [];
			s.apply(e);
			for (const [r, previouslyEligible] of routes) {
				if (this.questions.hasQuestionRoute(s,r)) s.revokedQuestions.delete(r.id);
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
			if (s.isBusy() || s.outsideTools || s.erasing || s.settling || s.requests.size || this.questions.waitingRequests(s).length || this.turns.openCalls(s).length || this.interfaceTools.unsettledHandoffs(s).length || this.jobWork.runningJobs(s).length) {
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
		await this.questions.closeRevokedWaits(s);
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
			await this.questions.closeRevokedWaits(s);
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
		const offerScope = this.interfaceTools.offerScope.getStore();
		if (offerScope) this.interfaceTools.queuedOffers.set(q, offerScope);
		const receipt: InputReceipt = { inputId: q.id, taken };
		if (q.when !== "propose") {
			if (taken === "now") this.turns.startTurn(s, q);
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
			for (const handoff of this.interfaceTools.unsettledHandoffs(s)) await this.interfaceTools.settleInterfaceCall(s, handoff);
			for (const r of [...s.requests.values()]) r.resolve({ requestId: r.request.id, declined: true, actorId: "harness", reason: "cancelled" });
			await recorded;
			return { handedBack, running };
		});
		await running?.done;
		if (this.interfaceTools.interfaceSources.size || s.hasWaitingApprovals) this.turns.maybeContinueOpenCalls(s);
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
	withInterfaceOffer<T>(scope: symbol, work: () => T): T {
		return this.interfaceTools.withInterfaceOffer(scope, work);
	}

	registerInterfaceTools(sources: readonly InterfaceToolSource[]): Promise<void> {
		return this.interfaceTools.registerInterfaceTools(sources);
	}

	connectInterfaceTools(sessionId: string, options: InterfaceToolConnectionOptions): InterfaceToolConnection {
		return this.interfaceTools.connectInterfaceTools(sessionId, options);
	}

	private findTool(s: Session | undefined, name: string): { plugin: string; source: ToolSource; definition: ToolDefinition } | undefined {
		for (const { plugin, impl } of this.caps.get("tool-source") ?? []) {
			if (this.interfaceTools.interfaceSources.has(name) && plugin !== INTERFACE_SOURCE) continue;
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
				if (this.interfaceTools.interfaceSources.has(t.name) && plugin !== INTERFACE_SOURCE) continue;
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

	private originalWorkAllows(s: Session, w: WaitingApproval) {
		const origin = w.entry.turnId!;
		const branch = s.branch();
		const work = branch.filter(e => e.turnId === origin && (e.kind === "input" || e.kind === "turnStart"));
		if (!work.some(e => e.kind === "turnStart") || work.some(e => e.erased) || !this.turns.recordedTurnRights(branch, origin).includes("tools")) return false;
		return this.turnAuthority.exit(() => connectionRights.exit(() => {
			for (const e of work) {
				const contributors = (e.data as { authorizers?: {sessionId: string; actorId?: string; jobId?: string}[] }).authorizers;
				if (contributors !== undefined && (!Array.isArray(contributors) || contributors.some(ref => {
					const owner = ref && this.sessions.get(ref.sessionId);
					return !owner || owner.tenant !== s.tenant || Boolean(ref.actorId) === Boolean(ref.jobId) ||
						!this.workRights(owner, ref.actorId ? [ref.actorId] : [], ref.jobId ? [ref.jobId] : []).includes("tools");
				}))) return false;
			}
			return this.workRights(s, this.turns.recordedTurnActors(branch, origin), this.turns.recordedTurnJobs(branch, origin)).includes("tools");
		}));
	}

	/** Attach a connection without adding a persistent plugin registration. */
	connectInterface(part: InterfaceCapability): () => void {
		return this.questions.connectInterface(part);
	}


	// ---------- jobs ----------

	private workActors(s: Session): string[] {
		const context = this.turnAuthority.getStore();
		if (context?.sessionId === s.id) return [...new Set([...context.actors, ...[...context.jobs].flatMap((id) => {
			const actor = s.order.map((id) => s.entries.get(id)!).find((e) => e.kind === "jobStarted" && e.jobId === id)?.actorId;
			return actor ? [actor] : [];
		})])];
		const actorId = this.tools.toolWork.getStore()?.actorId;
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
			...(this.interfaceTools.interfaceSources.size > 0 && runtime?.supports.interfaceTools === true ? { interfaceTools: true } : {}),
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
			...(this.tools.coversNested() ? { approvalCoversNested: true } : {}),
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

export type { GateResult };
