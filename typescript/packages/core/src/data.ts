// Shared data shapes are also used by the edition 3 base. No base objects are exposed.
export type {
  AssistantMessage, ContentPart, Declaration, HistoryEntry, ModelError, ModelInfo, ModelMessage,
  ModelRef, ModelRequest, Outcome, ToolCall, ToolCaller, ToolDefinition, ToolStatus, TurnResult, Usage,
} from "@modular-agent/harness";

import type { ContentPart, ToolCall } from "@modular-agent/harness";

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
export interface QuestionDraft {
  kind: "approval" | "choice" | "text" | "link";
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
export type QuestionHandler = (question: Question, context: {
  sessionId: string; actorId: string; cancelled: AbortSignal;
}) => Answer | void | Promise<Answer | void>;
