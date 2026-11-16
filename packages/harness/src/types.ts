/**
 * The contracts from docs/contracts.md, as TypeScript types.
 * Every part depends only on these types and the plugin API.
 */

// ---------- Content ----------

export interface TextPart { type: "text"; text: string; [key: string]: unknown }
export interface ImagePart { type: "image"; data: string; mimeType: string; [key: string]: unknown }
export interface ReasoningPart { type: "thinking"; thinking: string; [key: string]: unknown }
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
}

// ---------- Actors ----------

export type Authority = "watch" | "propose" | "input" | "answer" | "approve" | "settings" | "erase";
export interface Actor { id: string; kind: "user" | "agent" | "host" | "program"; tenant?: string; authority: Authority[] }

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
	/** The part or plugin that wrote it. */
	writer: string;
	actorId?: string;
	time: number;
	/** input, response, toolResult, summary, setting, position, approval, erasure, turnStart, turnEnd, toolStarted, plugin kinds, ... */
	kind: string;
	modelVisible: boolean;
	message?: ModelMessage;
	data?: unknown;
}

export type EntryDraft = Omit<HistoryEntry, "id" | "parentId" | "sessionId" | "time"> & { id?: string };

// ---------- Tools ----------

export interface ToolHints { readOnly?: boolean; destructive?: boolean; idempotent?: boolean; openWorld?: boolean }
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
export interface ToolContext {
	sessionId: string;
	signal: AbortSignal;
	call: ToolCall;
	/** Report progress while the call runs. */
	progress(content: ContentPart[]): void;
	/** The session's working environment, if one is provided. */
	environment?: WorkingEnvironment;
	/** Ask an actor something. */
	ask(request: InputRequestDraft): Promise<Answer>;
}
export interface ToolSource {
	id: string;
	tools(): ToolDefinition[];
	run(call: ToolCall, context: ToolContext): Promise<Omit<ToolResult, "callId">>;
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
export interface RequestOptions { signal: AbortSignal; sessionId?: string; onEvent?(event: ModelStreamEvent): void }

export interface Provider {
	id: string;
	supports: Declaration;
	models(): ModelInfo[];
	/** Make one model request. Never rejects for a model failure: the message says why. */
	request(model: ModelRef, request: ModelRequest, options: RequestOptions): Promise<AssistantMessage>;
	discardState?(sessionId: string): Promise<void>;
}

/** What the Runtime is given: the chosen model, without credentials. */
export interface ModelAccess {
	model: ModelInfo;
	supports: Declaration;
	request(request: ModelRequest, options: RequestOptions): Promise<AssistantMessage>;
}

// ---------- Credential store ----------

export interface CredentialStore {
	read(providerId: string, options?: { signal?: AbortSignal }): Promise<unknown | undefined>;
	list(options?: { signal?: AbortSignal }): Promise<readonly { providerId: string; type: string }[]>;
	modify(providerId: string, fn: (current: any) => Promise<any>, options?: { signal?: AbortSignal }): Promise<unknown | undefined>;
	delete(providerId: string, options?: { signal?: AbortSignal }): Promise<void>;
}

// ---------- Working environment ----------

export interface ExecResult { exitCode: number | null; output: string; timedOut: boolean }
export interface WorkingEnvironment {
	id: string;
	cwd: string;
	resolve(path: string): string;
	readFile(path: string): Promise<Buffer>;
	writeFile(path: string, data: string | Buffer): Promise<void>;
	exists(path: string): Promise<boolean>;
	exec(command: string, options: { signal: AbortSignal; timeoutMs?: number; onOutput?(chunk: string): void }): Promise<ExecResult>;
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
	openForWriting(sessionId: string): Promise<void>;
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
}
export type InputRequestDraft = Omit<InputRequest, "id" | "sessionId" | "askedBy" | "answerers" | "turnId"> & { answerers?: string[] };
export interface Answer { requestId: string; value?: string; declined?: boolean; actorId: string; reason?: string; /** The question is still open, past its turn. */ pending?: boolean }

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

/** What the Harness offers a Runtime during a turn. */
export interface RuntimeHost {
	newId(): string;
	/** Ask plugins to decide the model request for this step ("before each step"). */
	prepareStep(info: StepPreparation): Promise<ModelRequest>;
	/** Let plugins step in at a hook point. */
	hook<T = any>(name: string, payload: any): Promise<T>;
	/** Run this tool call. */
	runToolCall(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
	definition(toolName: string): ToolDefinition | undefined;
	/** Record entries in the session's history. */
	record(entry: EntryDraft): Promise<HistoryEntry>;
	/** Take input given for the running turn, and record it. */
	takeSteering(): Promise<HistoryEntry[]>;
	hasSteering(): boolean;
	report(type: string, data?: any, ids?: { stepId?: string; toolCallId?: string }): void;
}

/** A turn whose process stopped, as the history records it. */
export interface InterruptedTurn {
	turnId: string;
	/** Tool calls the model asked for that have no result. */
	calls: { id: string; name: string; input: Record<string, unknown>; stepId?: string; started: boolean }[];
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
export type TransformAnswer<T> = undefined | { value: T; stop?: boolean };
export interface GateResult<T> { refused?: string; pending?: string; value: T }

// ---------- Output gate ----------

export type OutputAnswer = { action: "pass"; events?: AgentEvent[] } | { action: "hold" } | { action: "block" } | undefined;
export interface OutputPayload { events: AgentEvent[]; recipient: string; final: boolean }
