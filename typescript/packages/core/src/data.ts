// SDK-facing shared shapes (docs/bindings/data.md).
export interface TextPart { type: "text"; text: string; [key: string]: unknown }
export interface ImagePart { type: "image"; data: string; mimeType: string; [key: string]: unknown }
export interface ReasoningPart { type: "reasoning"; text?: string; providerData?: unknown; [key: string]: unknown }
export interface ToolCallPart { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; [key: string]: unknown }
/** Any other part. The record keeps it intact even if nobody understands it. */
export interface OtherPart { type: string; [key: string]: unknown }
export type ContentPart = TextPart | ImagePart | ReasoningPart | ToolCallPart | OtherPart;

export type StopReason = "finished" | "toolUse" | "length" | "refused" | "failed" | "aborted";
export interface ModelError { kind: "temporary" | "contextTooLarge" | "credentials" | "refused" | "other"; message: string }
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }

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

export type Outcome =
  | { kind: "completed" }
  | { kind: "cancelled" }
  | { kind: "failed"; error: string }
  | { kind: "limit"; limit: string };

export interface TurnResult { text?: string; value?: unknown; openToolCalls: string[] }
export type Content = ContentPart[];
export type Input = string | Content;
export type Settings = Record<string, unknown>;
export type InputTiming = "now" | "steer" | "after" | "propose";
export interface InputReceipt {
  inputId: string;
  taken: "now" | "inTurn" | "after" | "proposed" | "handedBack";
  duplicate?: boolean;
  erased?: true;
}
export type Right = import("@modular-agent/harness").Authority;
export interface Actor { id: string; kind: "user" | "agent" | "host" | "program"; rights: Right[] }

export interface QuestionDraft {
  kind: "approval" | "choice" | "text" | "link" | "secret";
  credential?: string;
  answerers?: string[];
  question: string;
  details?: string;
  options?: string[];
  timeLimitMs?: number;
}
export interface Question extends QuestionDraft {
  id: string;
  sessionId: string;
  call?: ToolCall;
  deadline?: number;
}
export type Answer = "allow" | "decline" | { value: string } | { declined: true; reason?: string };
export type QuestionReply = Answer | { stored: string };
export type QuestionHandler = (question: Question, context: {
  sessionId: string; actorId: string; cancelled: AbortSignal;
}) => Answer | void | Promise<Answer | void>;
