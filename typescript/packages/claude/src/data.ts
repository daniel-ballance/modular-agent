/** The shapes of modular-agent-data/1 this Provider reads and writes (docs/bindings/data.md). */

export const PROVIDER_ID = "claude";

export type Reasoning = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export const REASONING_LEVELS: readonly Reasoning[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export interface ModelRef {
	provider: string;
	id: string;
}

export interface ModelInfo extends ModelRef {
	name?: string;
	contextWindow: number;
	maxOutput: number;
	input: string[];
	reasoning: boolean;
	thinking?: Reasoning[];
}

export type Part =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "reasoning"; text?: string; providerData?: unknown }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; providerCallId?: string };

/** Content as it arrives: known parts, and extension parts this Provider cannot represent. */
export type Content = readonly (Part | { type: string; [key: string]: unknown })[];

export type Stop = "finished" | "toolUse" | "length" | "refused" | "failed" | "aborted";
export type ErrorKind = "temporary" | "contextTooLarge" | "credentials" | "refused" | "other";
export interface ModelError {
	kind: ErrorKind;
	message: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: Part[];
	stop: Stop;
	usage?: Usage;
	model?: ModelRef;
	error?: ModelError;
}

export type Message =
	| { role: "user"; content: Content }
	| { role: "assistant"; content: Content; stop: Stop; providerData?: unknown }
	| { role: "toolResult"; toolCallId: string; toolName: string; content: Content; isError: boolean };

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: unknown;
}

export interface ModelRequest {
	systemPrompt: string;
	messages: Message[];
	tools: ToolDefinition[];
	settings: { reasoning?: string; maxOutput?: number; [key: string]: unknown };
}

export type StreamEvent =
	| { type: "text" | "reasoning"; delta: string }
	| { type: "toolInput"; delta: string; toolCallId: string };
