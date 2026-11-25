import type { TenantInfo } from "./authority.js";
import type { JobStart, KeptJob } from "./jobs.js";
import type { InputReceipt, InputTiming, QueuedInput } from "./session.js";
import type { Operation } from "./telemetry.js";
import type {
	Actor, AgentEvent, Answer, AssistantMessage, Authority, ContentPart, Declaration, EntryDraft,
	HandlerOrder, HistoryEntry, HookRule, InputRequest, InputRequestDraft, Job, JobState,
	ModelAccess, ModelRequest, StoredSession, ToolCall, ToolDefinition, ToolResult, WorkingEnvironment,
} from "./types.js";
import type { ApprovalDelivery, ApprovalRoute } from "./waiting-approval.js";

export interface Plugin {
	name: string;
	/** Global plugins load; project plugins load only once the project is trusted. */
	origin?: "global" | "project";
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

export interface PluginApi {
	readonly name: string;
	readonly project: string;
	readonly home: string;
	/** The project a session works on: its "cwd" setting, or the Harness's project. */
	projectOf(sessionId: string): string;
	provide(capability: string, implementation: unknown): void;
	use<T>(capability: string): T | undefined;
	useAll<T>(capability: string): T[];
	defineHook(name: string, rule: HookRule): void;
	on(hook: string, handler: (payload: any) => unknown, order?: HandlerOrder, options?: { stream?: boolean }): () => void;
	/** Run a hook point this plugin owns, by its rule. */
	runHook<T = any>(hook: string, payload: any): Promise<T>;
	/** Report a problem that didn't stop this plugin, such as a server it couldn't reach. Hosts and Interfaces see it. */
	reportProblem(where: string, error: unknown): void;
	onEvent(listener: (event: AgentEvent) => void, options?: { raw?: boolean }): () => void;
	emit(sessionId: string, type: string, data?: any, ids?: Partial<AgentEvent>): void;
	registerCommand(name: string, command: Command): void;
	commands(): { name: string; description: string; plugin: string }[];
	runCommand(sessionId: string, line: string, actorId: string): Promise<string | void>;
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
	tools(sessionId?: string): ToolDefinition[];
	callTool(sessionId: string, call: Omit<ToolCall, "id"> & { id?: string }): Promise<ToolResult>;
	ask(sessionId: string, request: InputRequestDraft): Promise<Answer>;
	deferTool(sessionId: string, turnId: string | undefined, question: InputRequestDraft): Promise<{ pending: string } | { refuse: string } | undefined>;
	refreshApprovals(sessionId: string): Promise<void>;
	registerApprovalRoute(policy: ApprovalRoute): () => void;
	presentApproval(sessionId: string, requestId: string, delivery: ApprovalDelivery): Promise<boolean>;
	submitAnswer(sessionId: string, answer: Answer, handle?: object): Promise<{ accepted: boolean; reason?: string }>;
	openRequests(sessionId: string): InputRequest[];
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
	follow(sessionId: string, options: FollowOptions, listener: (event: AgentEvent) => unknown): (() => void) & { idle(): Promise<void> };
	flushOutput(sessionId: string, recipient: string): Promise<void>;
	gateOutput<T>(sessionId: string, recipient: string, type: string, data: T, ids?: Pick<AgentEvent, "turnId" | "stepId" | "toolCallId">): Promise<T | undefined>;
	declaration(sessionId?: string): Declaration;
	modelAccess(sessionId: string): ModelAccess | undefined;
	config(): Record<string, unknown>;
}
