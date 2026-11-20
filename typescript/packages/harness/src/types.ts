/**
 * The contracts from docs/contracts.md, as TypeScript types.
 * Every part depends only on these types and the plugin API.
 */

// ---------- Content ----------

export interface TextPart { type: "text"; text: string; [key: string]: unknown }
export interface ImagePart { type: "image"; data: string; mimeType: string; [key: string]: unknown }
export interface ReasoningPart { type: "reasoning"; text?: string; providerData?: unknown; [key: string]: unknown }
export interface ToolCallPart { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; [key: string]: unknown }
/** Any other part. The record keeps it intact even if nobody understands it. */
export interface OtherPart { type: string; [key: string]: unknown }
export type ContentPart = TextPart | ImagePart | ReasoningPart | ToolCallPart | OtherPart;

export function text(value: string): TextPart {
	return { type: "text", text: value };
}
export function isText(part: ContentPart): part is TextPart {
	return part.type === "text" && typeof (part as TextPart).text === "string";
}
export function isToolCall(part: ContentPart): part is ToolCallPart {
	return part.type === "toolCall";
}
export function textOf(parts: ContentPart[]): string {
	return parts.filter(isText).map((p) => p.text).join("");
}

// ---------- Model messages ----------

export type StopReason = "finished" | "toolUse" | "length" | "refused" | "failed" | "aborted";
export interface ModelError { kind: "temporary" | "contextTooLarge" | "credentials" | "refused" | "other"; message: string }
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
/**
 * The stand-in result for a tool call the process stopped. Written for the model:
 * an unknown outcome must not read like success, or like "still running".
 */
export function interruptedNote(started: boolean): string {
	return started
		? "Interrupted: the agent's process stopped while this call was running, and it did not finish. Its outcome is unknown: it may have done all, part or none of its work. Don't report it as done or as still running. Check the current state before relying on it or running it again."
		: "Not run: the agent's process stopped before this call started. Nothing it would have done has happened.";
}

export const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
export function addUsage(a: Usage, b: Usage | undefined): Usage {
	if (!b) return a;
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
	};
}

export interface UserMessage { role: "user"; content: ContentPart[] }
export interface AssistantMessage {
	role: "assistant";
	content: ContentPart[];
	stop: StopReason;
	usage?: Usage;
	model?: ModelRef;
	error?: ModelError;
	/** The Provider's own form of the message, kept intact so it can be replayed exactly. */
	providerData?: unknown;
}
export interface ToolResultMessage { role: "toolResult"; toolCallId: string; toolName: string; content: ContentPart[]; isError: boolean }
export type ModelMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface ModelRef { provider: string; id: string }
export interface ModelInfo extends ModelRef {
	name?: string;
	contextWindow: number;
	maxOutput: number;
	input: string[];
	reasoning: boolean;
	/** Explicit levels, if the model accepts only a subset. */
	thinking?: string[];
}

// ---------- Actors ----------

export type Authority = "watch" | "propose" | "input" | "answer" | "approve" | "tools" | "cancel" | "settings" | "erase" | "grant" | "jobs" | "delegate" | "administer";
export interface Actor { id: string; kind: "user" | "agent" | "host" | "plugin" | "program"; tenant?: string; authority: Authority[] }

// ---------- History ----------

export interface HistoryEntry {
	id: string;
	/** History is a tree. An entry follows one earlier entry. */
	parentId: string | null;
	sessionId: string;
	turnId?: string;
	stepId?: string;
	toolCallId?: string;
	jobId?: string;
	inputId?: string;
	inputIds?: string[];
	requestId?: string;
	continuesTurnId?: string;
	usage?: Usage;
	jobKey?: string;
	/** Entries whose content this one copies, such as those a summary summarizes. Erasing a source erases this entry too. */
	sources?: string[];
	/** The part or plugin that wrote it. */
	writer: string;
	actorId?: string;
	time: number;
	/** input, response, toolResult, summary, setting, position, approval, erasure, turnStart, turnEnd, toolStarted, plugin kinds, ... */
	kind: string;
	modelVisible: boolean;
	erased?: true;
	message?: ModelMessage;
	data?: unknown;
}

export function erasedEntry(entry: HistoryEntry): HistoryEntry {
	if (entry.erased) return entry;
	const { id, parentId, kind } = entry;
	const tomb = { id, parentId, kind, erased: true } as HistoryEntry;
	const d = entry.data as { inputId?: string; inputIds?: string[]; requestId?: string; request?: { id?: string }; continuesTurnId?: string; key?: string; usage?: Usage } | undefined;
	const valid = (v: unknown): v is string => typeof v === "string" && v !== "";
	for (const key of ["turnId", "stepId", "toolCallId", "jobId", "inputId", "requestId", "continuesTurnId"] as const) {
		const value = entry[key];
		if (valid(value)) tomb[key] = value;
	}
	if (entry.sources?.every(valid)) tomb.sources = entry.sources;
	if (["input", "inputAccepted", "inputHandedBack"].includes(kind) && !Object.hasOwn(entry, "inputId") && valid(d?.inputId)) tomb.inputId = d.inputId;
	if (kind === "inputHandedBack" && !Object.hasOwn(entry, "inputId") && !(d && Object.hasOwn(d, "inputId")) && d?.inputIds?.length && d.inputIds.every(valid)) tomb.inputIds = d.inputIds;
	if (["inputRequest", "inputAnswer"].includes(kind) && !Object.hasOwn(entry, "requestId")) {
		const requestId = valid(d?.requestId) ? d.requestId : kind === "inputRequest" ? d?.request?.id : undefined;
		if (valid(requestId)) tomb.requestId = requestId;
	}
	if (kind === "turnStart" && !Object.hasOwn(entry, "continuesTurnId") && valid(d?.continuesTurnId)) tomb.continuesTurnId = d.continuesTurnId;
	if (kind === "jobStarted" && valid(entry.writer) && valid(d?.key)) { tomb.writer = entry.writer; tomb.jobKey = d.key; }
	const usage = kind === "response" && entry.message?.role === "assistant" ? entry.message.usage : kind === "jobEnded" || kind === "turnEnd" ? d?.usage : undefined;
	if (usage && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every((n) => Number.isSafeInteger(n) && n >= 0) && Number.isFinite(usage.cost) && usage.cost >= 0) {
		const { input, output, cacheRead, cacheWrite, cost } = usage;
		tomb.usage = { input, output, cacheRead, cacheWrite, cost };
	}
	return tomb;
}

export type EntryDraft = Omit<HistoryEntry, "id" | "parentId" | "sessionId" | "time"> & { id?: string };

// ---------- Tools ----------

export interface ToolHints { readOnly?: boolean; destructive?: boolean; safeToRepeat?: boolean; openWorld?: boolean }
export type ToolCaller = "model" | "ui" | "plugin";
export interface ToolDefinition {
	name: string;
	description: string;
	/** JSON Schema for the input. */
	parameters: Record<string, unknown>;
	returns?: Record<string, unknown>;
	hints?: ToolHints;
	/** Whether the tool may run alongside other calls. */
	parallel?: boolean;
	callers?: ToolCaller[];
	display?: unknown;
}
export interface ToolCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
	startedBy: "model" | "provider" | "ui" | "plugin" | "tool";
	actorId?: string;
	stepId?: string;
	parentCallId?: string;
}
export type ToolStatus = "completed" | "failed" | "refused" | "cancelled" | "notStarted" | "outcomeUnknown";
export interface ToolResult {
	callId: string;
	status: ToolStatus;
	content: ContentPart[];
	value?: unknown;
	display?: unknown;
}
/** A call left open past its turn. It gets its one result later. */
export interface ToolPending { pending: string }
export function isPending(value: object): value is ToolPending {
	return typeof (value as ToolPending).pending === "string";
}

export interface ToolContext {
	sessionId: string;
	signal: AbortSignal;
	call: ToolCall;
	tools?: {
		list(): Promise<ToolDefinition[]>;
		call(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
	};
	/** Report progress while the call runs. */
	progress(content: ContentPart[]): void;
	/** The session's working environment, if one is provided. */
	environment?: WorkingEnvironment;
	/**
	 * Ask an actor something. Questions are keyed by their order in this run. A tool
	 * that leaves its call open (returns { pending }) runs again from the top when
	 * the answer arrives, so it must ask the same questions in the same order;
	 * asking again then returns the recorded answer.
	 */
	ask(request: InputRequestDraft, signal?: AbortSignal): Promise<Answer>;
}
export interface ToolSource {
	id: string;
	/** The tools offered. With a session, include any that only that session has, such as an ACP client's MCP servers. */
	tools(sessionId?: string): ToolDefinition[];
	/** Run a call. Return { pending } to leave the call open past its turn, after asking a question that was left open. */
	run(call: ToolCall, context: ToolContext): Promise<Omit<ToolResult, "callId"> | ToolPending>;
	/** Tell the Harness when the list of tools changes. */
	onChange?(listener: () => void): () => void;
}

// ---------- Declarations ----------

/** What a part, or the session as set up, supports. */
export type Declaration = Record<string, boolean | string>;

// ---------- Providers and model access ----------

export interface ModelSettings { reasoning?: string; maxOutput?: number; [key: string]: unknown }
export interface ModelRequest {
	systemPrompt: string;
	messages: ModelMessage[];
	tools: ToolDefinition[];
	/** Tools the Provider may run itself: "none" or a list of names. */
	providerTools?: "none" | string[];
	settings: ModelSettings;
}
export type ModelStreamEvent =
	| { type: "text"; delta: string }
	| { type: "reasoning"; delta: string }
	| { type: "toolInput"; delta: string };
export interface RequestOptions {
	signal: AbortSignal; sessionId?: string; stepId?: string;
	onEvent?(event: ModelStreamEvent): void;
	/** Host and adapter controls. These do not cross the wire. */
	prepareDispatch?(): Promise<ModelRequest>;
	requestPrepared?: boolean;
	exactReplay?: boolean;
	onEffectiveRequest?(request: ModelRequest): void;
}

export interface Provider {
	id: string;
	readonly prepareOnWire?: boolean;
	supports: Declaration;
	models(): ModelInfo[];
	onChange?(handler: () => void): () => void;
	/** A served Provider may refresh its cached catalog using provider/models. */
	refreshModels?(): Promise<void>;
	/** Whether this Provider can be used now, for example because it has credentials. */
	available?(): Promise<boolean>;
	/** Make one model request. Never rejects for a model failure: the message says why. */
	request(model: ModelRef, request: ModelRequest, options: RequestOptions): Promise<AssistantMessage>;
	discardState?(sessionId: string, options?: { erase?: boolean; entryIds?: string[] }): Promise<void | { pending?: string[]; outOfReach?: string[] }>;
}

/** What the Runtime is given: the chosen model, without credentials. */
export interface ModelAccess {
	model: ModelInfo;
	readonly prepareOnWire?: boolean;
	supports: Declaration;
	request(request: ModelRequest, options: RequestOptions): Promise<AssistantMessage>;
}

// ---------- Credential store ----------

export interface SecretScope { deployment: string; sessionId: string; requestId: string }
export interface SecretSubmission extends SecretScope { credential: string; actorId: string }
export interface SecretReceipt extends SecretSubmission { receipt: string }

export interface CredentialStore {
	stage?(scope: SecretSubmission, value: string): Promise<SecretReceipt | undefined>;
	lookupStaged?(scope: SecretScope): Promise<SecretReceipt | undefined>;
	activate?(scope: SecretScope): Promise<"activated" | "superseded">;
	discard?(scope: SecretScope): Promise<void>;
	read(providerId: string, options?: { signal?: AbortSignal }): Promise<unknown | undefined>;
	list(options?: { signal?: AbortSignal }): Promise<readonly { providerId: string; type: string }[]>;
	modify(providerId: string, fn: (current: any) => Promise<any>, options?: { signal?: AbortSignal }): Promise<unknown | undefined>;
	delete(providerId: string, options?: { signal?: AbortSignal }): Promise<void>;
}

// ---------- Working environment ----------

export interface DirEntry { name: string; kind: "file" | "directory" | "other" }
export interface ExecResult { exitCode: number | null; output: string; timedOut: boolean }
export interface WorkingEnvironment {
	id: string;
	cwd: string;
	/** Nothing from an interrupted attempt is still running when recovery begins. */
	safeToRepeat?: boolean;
	containment?: string;
	confinesFiles?: boolean;
	/** This part needs a state directory that survives agent restart. */
	requiresDataDir?: boolean;
	points?: boolean;
	/** Whether points are available in a specific project; defaults to points. */
	keepsPoints?(project: string): boolean;
	save?(): Promise<string>;
	/** Check a point without touching project files, if the environment can. */
	hasPoint?(point: string): Promise<boolean>;
	restore?(point: string): Promise<void>;
	forSession?(sessionId: string): WorkingEnvironment | Promise<WorkingEnvironment>;
	sessionEnded?(sessionId: string): Promise<void> | void;
	readFile(path: string): Promise<Buffer>;
	writeFile(path: string, data: string | Buffer): Promise<void>;
	exists(path: string): Promise<boolean>;
	list?(path: string): Promise<DirEntry[]>;
	exec(command: string, options: { signal: AbortSignal; timeoutMs?: number; onOutput?(chunk: string): void }): Promise<ExecResult>;
	/** The same environment, working in another directory. */
	at?(cwd: string): WorkingEnvironment | Promise<WorkingEnvironment>;
}

// ---------- History store ----------

export interface StoredSession {
	id: string;
	created: number;
	project: string;
	forkedFrom?: { sessionId: string; entryId: string };
	parentSessionId?: string;
}
export interface HistoryStore {
	supports: Declaration;
	create(meta: StoredSession): Promise<void>;
	/** Refuses if the session is already open for writing elsewhere. */
	openForWriting(sessionId: string, options?: { wait?: boolean }): Promise<void>;
	checkWriter?(sessionId: string): void;
	writerSignal?(sessionId: string): AbortSignal | undefined;
	close(sessionId: string): Promise<void>;
	/** Keep these entries. All of them are kept, or none are. */
	append(sessionId: string, batch: HistoryEntry[]): Promise<void>;
	load(sessionId: string): Promise<{ meta: StoredSession; entries: HistoryEntry[] }>;
	list(filter?: { project?: string }): Promise<StoredSession[]>;
	erase?(sessionId: string, entryIds: string[]): Promise<void>;
}

// ---------- Configuration ----------

export interface Configuration {
	get<T = unknown>(key: string): T | undefined;
	/** A plugin's own settings. */
	plugin(name: string): Record<string, unknown>;
}

// ---------- Interfaces ----------

export interface InterfaceCapability {
	id: string;
	actorId: string;
	/** Whether this Interface declares its actor present for the session. */
	present?(sessionId: string, request?: InputRequest): boolean;
	/** Other actors whose presence this connection declares. */
	presentActors?(sessionId: string): string[];
	/** Told about input requests this Interface's actor may see. */
	onInputRequest?(request: InputRequest): void;
	onInputRequestClosed?(requestId: string): void;
}

// ---------- Input requests ----------

export type InputRequestKind = "approval" | "choice" | "text" | "link" | "secret";
export interface InputRequest {
	id: string;
	sessionId: string;
	kind: InputRequestKind;
	question: string;
	details?: string;
	options?: string[];
	toolCallId?: string;
	askedBy: string;
	/** Actor ids that may answer. Empty means any actor with "answer" authority. */
	answerers: string[];
	timeLimitMs?: number;
	/** A stable key. Asking again with the same key reopens the same question, or reuses its recorded answer. */
	key?: string;
	/** When the time limit passes: decline (the default), or leave the question open past its turn. */
	whenTimeLimit?: "decline" | "leaveOpen";
	/** The turn that asked, if any. */
	turnId?: string;
	/** Secret requests only: the name the credential store keeps the answer under. The asker never sees the value. */
	credential?: string;
}
export type InputRequestDraft = Omit<InputRequest, "id" | "sessionId" | "askedBy" | "answerers" | "turnId"> & { answerers?: string[] };
export interface Answer {
	requestId: string;
	delegatedBy?: string;
	value?: string;
	declined?: boolean;
	actorId: string;
	reason?: string;
	/** The question is still open, past its turn. */
	pending?: boolean;
	/** A secret's answer: the credential it was stored as. The value itself goes only to the credential store. */
	stored?: string;
}

// ---------- Events ----------

export interface AgentEvent {
	type: string;
	time: number;
	sessionId: string;
	turnId?: string;
	stepId?: string;
	toolCallId?: string;
	jobId?: string;
	source: string;
	actorId?: string;
	data?: any;
}

// ---------- Turns and the Runtime ----------

export type Outcome =
	| { kind: "completed" }
	| { kind: "cancelled" }
	| { kind: "failed"; error: string }
	| { kind: "limit"; limit: string };

export interface TurnSnapshot { model: ModelRef | null; system: string; context?: ContentPart[]; tools: ToolDefinition[]; settings: TurnSettings }

export interface TurnSettings { maxSteps?: number; reasoning?: string; maxOutput?: number }
export interface TurnInput {
	sessionId: string;
	turnId: string;
	startedBy: { kind: "actor" | "job" | "plugin" | "answer"; id: string };
	model: ModelAccess;
	settings: TurnSettings;
	resultShape?: Record<string, unknown>;
}
export interface TurnResult { text?: string; value?: unknown; openToolCalls: string[] }
export interface TurnOutcome { outcome: Outcome; result: TurnResult; entries: string[]; usage: Usage }

export interface StepPreparation { stepId: string; usage: Usage }

/**
 * What the Harness offers a Runtime during a turn. Everything that asks the Harness
 * is asynchronous, so a Runtime can run in another process.
 */
export interface RuntimeHost {
	/** The plugin wire host commits terminal tool results before replying. */
	readonly hostSettlesTools?: boolean;
	/** Authenticated attribution for model work, not supplied by a Runtime. */
	callActor?(): string | undefined;
	newId(): Promise<string>;
	/** Ask plugins to decide the model request for this step ("before each step"). */
	prepareStep(info: StepPreparation): Promise<ModelRequest>;
	/** Let plugins step in at a hook point. */
	hook<T = any>(name: string, payload: any): Promise<T>;
	/** Run this tool call. */
	runToolCall(call: ToolCall, signal: AbortSignal): Promise<ToolResult | (ToolPending & { callId: string })>;
	definition(toolName: string): Promise<ToolDefinition | undefined>;
	/** Record entries in the session's history. */
	record(entry: EntryDraft): Promise<HistoryEntry>;
	history(options?: { all?: boolean }): Promise<HistoryEntry[]>;
	/** Take input given for the running turn, and record it. */
	takeSteering(final?: boolean): Promise<HistoryEntry[]>;
	registration?(name: string): { source: { plugin: string; toolSource: string }; definition: ToolDefinition } | undefined;
	hasSteering(): Promise<boolean>;
	report(type: string, data?: any, ids?: { stepId?: string; toolCallId?: string }): void;
}

export type StepAfterDecision = null | { refuse: string };
export interface ResumedStep { stepId: string; decision?: StepAfterDecision }

/** A turn whose process stopped, as the history records it. */
export interface InterruptedTurn {
	turnId: string;
	lastStep?: ResumedStep;
	/** Unresolved calls eligible for dispatch after recovery. */
	calls: { id: string; name: string; input: Record<string, unknown>; stepId?: string; started: boolean; safeToRepeat: boolean }[];
}

export interface Runtime {
	id: string;
	supports: Declaration;
	runTurn(input: TurnInput, host: RuntimeHost, signal: AbortSignal): Promise<TurnOutcome>;
	/**
	 * Decide what happens to a turn whose process stopped. A transient Runtime
	 * ends it; a durable one carries on. Every pending tool call ends with one result.
	 */
	resumeTurn(input: TurnInput, host: RuntimeHost, signal: AbortSignal, interrupted: InterruptedTurn): Promise<TurnOutcome>;
	/** Carry on from tool calls that were left open past an earlier turn and now have their answers. */
	continueOpenCalls(input: TurnInput, host: RuntimeHost, signal: AbortSignal, calls: InterruptedTurn["calls"]): Promise<TurnOutcome>;
}

// ---------- Jobs ----------

export type JobState = "running" | "completed" | "failed" | "cancelled" | "outcomeUnknown";
export interface Job {
	id: string;
	kind: string;
	sessionId: string;
	plugin: string;
	actorId?: string;
	turnId?: string;
	state: JobState;
	result?: ContentPart[];
	usage: Usage;
}

// ---------- Hook points ----------

export type HookRule = "observe" | "gate" | "transform" | "first" | "collect";
export type HandlerOrder = "first" | "normal" | "last";

/** A gate handler's answer. */
export type GateAnswer<T> = undefined | { refuse: string } | { change: T } | { pending: string };
/** A transform handler's answer. */
export type TransformAnswer<T> = undefined | { value: T; stop?: boolean; command?: string };
export interface GateResult<T> { refused?: string; pending?: string; value: T }

// ---------- Output gate ----------

export type OutputAnswer = { action: "pass"; events?: AgentEvent[] } | { action: "hold" } | { action: "block" } | undefined;
export interface OutputPayload { sessionId?: string; events: AgentEvent[]; recipient: string; final: boolean }
