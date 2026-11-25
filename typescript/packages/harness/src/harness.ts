import { WorkReservations } from "./work-reservations.js";
import { HistoryCommit } from "./history-commit.js";
import { SessionLifecycle, actorJoined } from "./session-lifecycle.js";
import { InputAdmission } from "./input-admission.js";
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
	private readonly workReservations: WorkReservations = new WorkReservations({
		use: (...args) => this.use(...args),
		lifecycle: () => this.lifecycle,
		reservations: () => this.reservations,
		jobWork: () => this.jobWork,
	});

	private readonly historyCommit: HistoryCommit = new HistoryCommit({
		erasure: () => this.erasure,
		receiptOperation: () => this.receiptOperation,
		receipts: () => this.receipts,
		newId: (...args) => this.newId(...args),
		now: (...args) => this.now(...args),
		approvals: () => this.approvals,
		reservations: () => this.reservations,
		lifecycle: () => this.lifecycle,
		use: (...args) => this.use(...args),
		questions: () => this.questions,
		emit: (...args) => this.emit(...args),
		admission: () => this.admission,
	});

	private readonly lifecycle: SessionLifecycle = new SessionLifecycle({
		sessions: () => this.sessions,
		rebuildReservations: (...args) => this.workReservations.rebuildReservations(...args),
		use: (...args) => this.use(...args),
		erasure: () => this.erasure,
		tenants: () => this.tenants,
		newId: (...args) => this.newId(...args),
		now: (...args) => this.now(...args),
		project: () => this.project,
		workActors: (...args) => this.workActors(...args),
		turnAuthority: () => this.turnAuthority,
		workRights: (...args) => this.workRights(...args),
		activePlugins: (...args) => this.activePlugins(...args),
		observeCommit: (...args) => this.historyCommit.observeCommit(...args),
		commit: (...args) => this.historyCommit.commit(...args),
		hooks: () => this.hooks,
		emit: (...args) => this.emit(...args),
		questions: () => this.questions,
		recoveryPolicy: (...args) => this.recoveryPolicy(...args),
		admission: () => this.admission,
		tools: () => this.tools,
		interfaceTools: () => this.interfaceTools,
		approvals: () => this.approvals,
		turns: () => this.turns,
		actorRights: (...args) => this.actorRights(...args),
		withinLimits: (...args) => this.withinLimits(...args),
		jobWork: () => this.jobWork,
		problem: (...args) => this.problem(...args),
		rightsOf: (...args) => this.rightsOf(...args),
		requireAuthority: (...args) => this.requireAuthority(...args),
		environmentFor: (...args) => this.environmentFor(...args),
		projectOf: (...args) => this.projectOf(...args),
		findTool: (...args) => this.findTool(...args),
		providerFor: (...args) => this.providerFor(...args),
	});

	private readonly admission: InputAdmission = new InputAdmission({
		intersectRights,
		session: (...args) => this.lifecycle.session(...args),
		erasure: () => this.erasure,
		checkWriter: (...args) => this.lifecycle.checkWriter(...args),
		checkScopedWork: (...args) => this.checkScopedWork(...args),
		requireAuthority: (...args) => this.requireAuthority(...args),
		commandTable: () => this.commandTable,
		runCommand: (...args) => this.runCommand(...args),
		newId: (...args) => this.newId(...args),
		hooks: () => this.hooks,
		receiptOperation: () => this.receiptOperation,
		commit: (...args) => this.historyCommit.commit(...args),
		rightsOf: (...args) => this.rightsOf(...args),
		rejectUnknownModel: () => this.rejectUnknownModel,
		providerFor: (...args) => this.providerFor(...args),
		modelAccess: (...args) => this.modelAccess(...args),
		workRights: (...args) => this.workRights(...args),
		runtime: (...args) => this.runtime(...args),
		reserveInput: (...args) => this.workReservations.reserveInput(...args),
		reservations: () => this.reservations,
		interfaceTools: () => this.interfaceTools,
		turns: () => this.turns,
		emit: (...args) => this.emit(...args),
		problem: (...args) => this.problem(...args),
		approvals: () => this.approvals,
	});

	private readonly turns: TurnExecution = new TurnExecution({
		intersectRights,
		commit: (...args) => this.historyCommit.commit(...args),
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
		admit: (...args) => this.admission.admit(...args),
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
		checkWriter: (...args) => this.lifecycle.checkWriter(...args),
		hooks: () => this.hooks,
		commit: (...args) => this.historyCommit.commit(...args),
		emit: (...args) => this.emit(...args),
		reserveCall: (...args) => this.workReservations.reserveCall(...args),
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
		checkWriter: (...args) => this.lifecycle.checkWriter(...args),
		commit: (...args) => this.historyCommit.commit(...args),
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
		reserveCall: (...args) => this.workReservations.reserveCall(...args),
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
		session: (...args) => this.lifecycle.session(...args),
		withConnectionActor: (...args) => this.withConnectionActor(...args),
		actorRights: (...args) => this.actorRights(...args),
		sessions: () => this.sessions,
		hooks: () => this.hooks,
		problem: (...args) => this.problem(...args),
		findTool: (...args) => this.findTool(...args),
		erasure: () => this.erasure,
		admit: (...args) => this.admission.admit(...args),
		checkWriter: (...args) => this.lifecycle.checkWriter(...args),
		newId: (...args) => this.newId(...args),
		commit: (...args) => this.historyCommit.commit(...args),
		workRights: (...args) => this.workRights(...args),
		agentName: () => this.agentName,
		maybeContinueOpenCalls: (...args) => this.turns.maybeContinueOpenCalls(...args),
		approvals: () => this.approvals,
		recordedTurnActors: (...args) => this.turns.recordedTurnActors(...args),
		recordedTurnJobs: (...args) => this.turns.recordedTurnJobs(...args),
		recordedTurnRights: (...args) => this.turns.recordedTurnRights(...args),
		turnAuthority: () => this.turnAuthority,
		toolAfter: (...args) => this.tools.toolAfter(...args),
		commitNow: (...args) => this.historyCommit.commitNow(...args),
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
		commit: (...args) => this.historyCommit.commit(...args),
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
		reserveJob: (...args) => this.workReservations.reserveJob(...args),
		commit: (...args) => this.historyCommit.commit(...args),
		toolWork: () => this.tools.toolWork,
		emit: (...args) => this.emit(...args),
		problem: (...args) => this.problem(...args),
		admit: (...args) => this.admission.admit(...args),
		jobReportsStartTurns: () => this.jobReportsStartTurns,
		startQueued: (...args) => this.turns.startQueued(...args),
		acceptInput: (...args) => this.admission.acceptInput(...args),
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
	private readonly tenants: Map<string, Tenant>;
	private reservations: Reservations;
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
		commit: (...args) => this.historyCommit.commit(...args),
		commitNow: (...args) => this.historyCommit.commitNow(...args),
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
			checkWriter: s => this.lifecycle.checkWriter(s),
			hasUnfinishedJobs: s => this.jobWork.runningJobs(s).length > 0,
			invalidateErasedHandoffs: (...args) => this.interfaceTools.invalidateErasedHandoffs(...args),
			commitNow: (...args) => this.historyCommit.commitNow(...args),
			write: (s, write) => this.lifecycle.write(s, write),
			emit: (...args) => this.emit(...args),
			loadInto: id => this.lifecycle.loadInto(id),
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
		await Promise.all([...this.sessions.keys()].map(id => this.lifecycle.suspendSession(id)));
	}

	async stop(): Promise<void> {
		for (const id of [...this.sessions.keys()]) await this.lifecycle.suspendSession(id).catch(() => undefined);
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
			projectOf: (sessionId) => this.projectOf(this.lifecycle.session(sessionId)),
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
			startSession: (options) => this.lifecycle.startSession(options),
			openSession: (id, actor, prepare, operation) => this.lifecycle.openSession(id, actor, prepare, operation),
			join: (sessionId, actor, grantedBy) => this.join(this.lifecycle.session(sessionId), actor, grantedBy, pluginName),
			leave: async (sessionId, actorId, requestedBy) => {
				const s = this.lifecycle.session(sessionId);
				if (requestedBy && requestedBy !== actorId) this.requireAuthority(s, requestedBy, "grant");
				if (!s.actors.has(actorId)) throw new Error(`Actor ${actorId} is not part of this session`);
				await this.historyCommit.commit(s, [{ kind: "actorLeft", writer: pluginName, actorId, modelVisible: false, data: { actorId } }]);
				await this.hooks.observe("session.leave", { sessionId, actorId, requestedBy });
				this.emit(s, "session.left", { actorId }, pluginName, { actorId });
				await this.questions.closeRevokedWaits(s);
				await this.approvals.reconcileApprovals(s);
			},
			presentActors: (id) => this.questions.presentActors(this.lifecycle.session(id)),
			presenceChanged: (id) => { const s = this.sessions.get(id); if (s) {
				this.approvals.presenceChanged(s);
				void this.questions.closeUnanswerable(s).catch(e => this.problem("harness", "close unanswerable wait", e));
			} },
			listSessions: async (project) => (await this.use<HistoryStore>("history-store")?.list(project === null ? undefined : { project: project ?? this.project })) ?? [],
			sessionSummary: (id, viewer) => this.lifecycle.sessionSummary(id, viewer),
			forkSession: (sessionId, entryId) => this.lifecycle.forkSession(sessionId, entryId),
			closeSession: (id, actorId, delegatedBy, authority) => this.lifecycle.closeSession(id, actorId, delegatedBy, authority),
			session: (id) => {
				const s = this.lifecycle.session(id);
				return { id: s.id, project: s.meta.project, tenant: s.tenant, settings: { ...s.settings }, position: s.position, busy: s.isBusy(), actors: [...s.actors.values()].map((a) => ({ ...a, authority: this.rightsOf(s, a.id) })), ephemeral: s.ephemeral };
			},
			input: (sessionId, options) => this.admission.input(sessionId, options),
			withdraw: (sessionId, inputId) => this.admission.withdraw(sessionId, inputId),
			proposals: (id, actorId) => {
				const s = this.lifecycle.session(id);
				this.requireAuthority(s, actorId, "watch");
				return [...s.proposals.values()].map((q) => ({ inputId: q.id, actorId: q.actorId, content: q.content, time: q.time! }));
			},
			withdrawProposal: (id, inputId, actorId, delegatedBy) => this.admission.withdrawProposal(this.lifecycle.session(id), inputId, actorId, delegatedBy),
			cancel: (sessionId) => this.admission.cancel(sessionId),
			releaseInput: (id, inputId, when, actorId, declined) => this.admission.releaseInput(this.lifecycle.session(id), inputId, when, actorId, declined),
			recoveredInput: (id) => this.lifecycle.session(id).recoveredInput,
			waitForIdle: (sessionId) => this.admission.waitForIdle(sessionId),
			moveTo: (sessionId, entryId, options) => this.lifecycle.moveTo(sessionId, entryId, options ?? {}, pluginName),
			setSetting: (sessionId, key, value, actorId) => this.setSetting(this.lifecycle.session(sessionId), key, value, pluginName, actorId),
			setLimit: (id, rights, actorId) => this.setLimit(this.lifecycle.session(id), rights, actorId, pluginName),
			tenant: (id) => this.tenantInfo(this.lifecycle.session(id)),
			checkPending: id => this.erasure.admitHistory(this.lifecycle.session(id)),
			readHistory: (id, options) => this.inspectHistory(id, options ?? {}, entries => entries),
			inspectHistory: (id, options, inspect) => this.inspectHistory(id, options, inspect),
			history: (sessionId, options) => {
				const s = this.lifecycle.session(sessionId);
				this.checkScopedWork(s, "watch");
				if (this.erasure.httpErasure() && !s.provisional) throw failure("unavailable", "HTTP history requires asynchronous readHistory");
				this.erasure.checkPending(s);
				return options?.all ? s.order.map((id) => s.entries.get(id)!) : s.branch();
			},
			append: async (sessionId, draft) => (await this.historyCommit.commit(this.lifecycle.session(sessionId), [{ ...draft, writer: draft.writer ?? pluginName }], true))[0],
			transaction: (sessionId, fn) => this.historyCommit.transaction(this.lifecycle.session(sessionId), pluginName, fn),
			erase: (sessionId, ids, actorId) => this.erasure.erase(this.lifecycle.session(sessionId), ids, actorId, pluginName),
			tools: (sessionId) => this.toolDefinitions(sessionId ? this.lifecycle.session(sessionId) : undefined),
			callTool: (sessionId, call) => this.tools.callTool(this.lifecycle.session(sessionId), { ...call, id: call.id ?? this.newId() }),
			ask: (sessionId, request) => this.questions.ask(this.lifecycle.session(sessionId), request, pluginName),
			deferTool: (id, turnId, question) => this.questions.deferTool(this.lifecycle.session(id), turnId, question, pluginName),
			refreshApprovals: id => this.approvals.reconcileApprovals(this.lifecycle.session(id)),
			registerApprovalRoute: policy => this.approvals.registerRoute(policy),
			presentApproval: (id, requestId, delivery) => this.approvals.presentApproval(this.lifecycle.session(id), requestId, delivery),
			submitAnswer: (sessionId, answer, handle) => this.questions.submitAnswer(this.lifecycle.session(sessionId), answer, handle),
			openRequests: (sessionId) => {
				const s = this.lifecycle.session(sessionId);
				return [...[...s.requests.values()].map((r) => r.request), ...this.questions.waitingRequests(s)];
			},
			startJob: (sessionId, options) => this.jobWork.startJob(this.lifecycle.session(sessionId), options, pluginName),
			workActors: (id) => this.workActors(this.lifecycle.session(id)),
			workJobs: (id) => { const work = this.turnAuthority.getStore(); return work?.sessionId === id ? [...work.jobs] : []; },
			workMay: (id, right, actors, jobs) => this.workRights(this.lifecycle.session(id), actors, jobs).includes(right),
			jobTrace: (id, jobId) => {
				const s = this.lifecycle.session(id);
				return s.jobs.get(jobId)?.job.plugin === pluginName ? this.jobWork.jobSpans.get(s)?.get(jobId) : undefined;
			},
			findJob: (jobId) => {
				for (const s of this.sessions.values()) {
					if (s.order.some((id) => { const e = s.entries.get(id)!; return e.kind === "jobStarted" && e.jobId === jobId && e.writer === pluginName; })) return { sessionId: s.id };
				}
				return undefined;
			},
			onJobCancel: (handler) => this.jobWork.jobCancels.set(pluginName, handler),
			unfinishedJobs: (id) => this.jobWork.runningJobs(this.lifecycle.session(id)).filter(({ job }) => job.plugin === pluginName),
			resumeJob: (id, jobId) => {
				const s = this.lifecycle.session(id);
				const found = this.jobWork.runningJobs(s).find((j) => j.job.id === jobId && j.job.plugin === pluginName);
				if (!found) throw new Error(`No unfinished job ${jobId} of ${pluginName}`);
				return s.jobs.get(jobId)?.handle ?? this.jobWork.jobHandle(s, found);
			},
			jobs: (id) => {
				const s = this.lifecycle.session(id);
				const cleanup = new Set(s.order.map((eid) => s.entries.get(eid)!).filter((e) => e.kind === "jobCleanupUnconfirmed").map((e) => e.jobId));
				return this.jobWork.runningJobs(s).map(({ job }) => ({ ...job, state: cleanup.has(job.id) ? "cleanupUnconfirmed" as const : s.jobs.has(job.id) ? "running" as const : "unfinished" as const }));
			},
			cancelJob: (sessionId, jobId) => this.jobWork.cancelJob(this.lifecycle.session(sessionId), jobId),
			sessionInterruption: id => this.lifecycle.session(id).interruption.signal,
			follow: (sessionId, options, listener) => this.follow(this.lifecycle.session(sessionId), options, listener),
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
			declaration: (sessionId) => this.declaration(sessionId ? this.lifecycle.session(sessionId) : undefined),
			gatedHistory: async (sessionId, options) => {
				const s = this.lifecycle.session(sessionId);
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
			modelAccess: (sessionId) => this.modelAccess(this.lifecycle.session(sessionId)),
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
		const session = this.lifecycle.session(sessionId);
		await this.erasure.reconcilePending(session);
		this.requireAuthority(session, actorId, "input");
		this.lifecycle.checkWriter(session);
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
			this.lifecycle.checkWriter(session);
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
		return this.workReservations.rebuildReservations();
	}

	session(id: string): Session {
		return this.lifecycle.session(id);
	}

	/** Live metadata for another connection attaching to a session in this process. */
	liveSessionInfo(id: string) {
		return this.lifecycle.liveSessionInfo(id);
	}

	startSession(options: SessionStartOptions = {}): Promise<string> {
		return this.lifecycle.startSession(options);
	}

	openSession(id: string, actor?: Actor, prepare?: SessionPrepare, operation: "load" | "resume" = "resume"): Promise<string> {
		return this.lifecycle.openSession(id, actor, prepare, operation);
	}

	/** Startup recovery never waits for a writer and rechecks the record under the lease. */
	resumeInterruptedSession(id: string, actor: Actor): Promise<boolean> {
		return this.lifecycle.resumeInterruptedSession(id, actor);
	}

	/** Check the operator's creation ceiling before allocating a provisional session. */
	tenantAllows(tenant: string | undefined, right: Authority): boolean {
		return tenant === undefined || this.tenants.get(tenant)?.rights.includes(right) === true;
	}

	/** Discovery is the open authority check without joining or taking a writer lease. */
	canDiscoverSession(id: string, actor: Actor, severalActors: boolean): Promise<boolean> {
		return this.lifecycle.canDiscoverSession(id, actor, severalActors);
	}

	/** A host read never joins the viewer, takes a writer or starts recovery. Capture the
	 * branch, the commit offset and effective rights without yielding between them. */
	hostView(id: string, actor: Actor, scope: (project: string, tenant: string | null) => boolean) {
		return this.lifecycle.hostView(id, actor, scope);
	}

	private activePlugins() { return this.loaded.map(({ plugin: { name, origin } }) => ({ name, ...(origin ? { origin } : {}) })); }

	forkSession(sessionId: string, entryId: string): Promise<string> {
		return this.lifecycle.forkSession(sessionId, entryId);
	}

	closeSession(id: string, actorId?: string, delegatedBy?: string, authority?: readonly Authority[]): Promise<void> {
		return this.lifecycle.closeSession(id, actorId, delegatedBy, authority);
	}

	// ---------- the record ----------

	/** Commit drafts to the session. All are kept, or none are. */
	commit(s: Session, drafts: EntryDraft[], pluginRecord = false, guard?: () => boolean | Promise<boolean>): Promise<HistoryEntry[]> {
		return this.historyCommit.commit(s, drafts, pluginRecord, guard);
	}

	private async setSetting(s: Session, key: string, value: unknown, writer: string, actorId?: string): Promise<void> {
		if (actorId) this.requireAuthority(s, actorId, "settings");
		if (this.settingsDuringTurn === "refused" && s.isBusy()) throw Object.assign(new Error("Cannot change settings during a turn"), { code: "busy" });
		await this.historyCommit.commit(s, [{ kind: "setting", writer, actorId, modelVisible: false, data: { key, value } }]);
		if (s.hasWaitingApprovals) await this.approvals.reconcileApprovals(s);
		this.emit(s, "setting.changed", { key, value, appliesFrom: this.settingsDuringTurn === "nextTurn" ? "next turn" : "next step" }, writer, { actorId });
	}

	private inspectHistory<T>(id: string, options: { all?: boolean }, inspect: (entries: HistoryEntry[]) => T): T | Promise<T> {
		const s = this.lifecycle.session(id);
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
		await this.historyCommit.commit(s, [actorJoined(actor, writer, grantedBy)]);
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
		return this.admission.admit(s, async () => {
			this.requireAuthority(s, actorId, "administer");
			const effective = (s.actors.get(actorId)?.authority ?? []).filter((r) => s.tenant === undefined || this.tenants.get(s.tenant)?.rights.includes(r));
			if ((rights ?? ALL_AUTHORITY).some((right) => !effective.includes(right))) throw Object.assign(new Error("A limit cannot give a right the administrator lacks"), { code: "forbidden" });
			await this.historyCommit.commit(s, [{ kind: "limit", writer, actorId, modelVisible: false, data: { rights: rights === null ? null : [...new Set(rights)] } }]);
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
