import type { SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage, ErrorKind, ModelError, ModelRef, Part, Stop, StreamEvent } from "./data.js";

type ApiEvent = SDKPartialAssistantMessage["event"];

/**
 * Builds one assistant message from the Anthropic stream events Claude Code relays, and
 * reports each piece as it arrives. A response usually spans a single API message. When
 * Claude Code continues a turn itself (it answers a call to a tool that does not exist),
 * the following API messages append to the same response.
 */
export class Response {
	readonly content: Part[] = [];
	readonly usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	/** Stop reason of the most recent API message, as Anthropic reported it. */
	rawStopReason: string | undefined;
	/** API block index -> index in `content`, for the API message being streamed. */
	private readonly open = new Map<number, number>();
	private readonly json = new Map<number, string>();
	/** Content indexes of tool calls whose arguments were not a JSON object. */
	private readonly broken = new Set<number>();
	private toolCalls: string[] = [];
	private earlierOutput = 0;

	constructor(
		private readonly model: ModelRef,
		private readonly emit: (event: StreamEvent) => void,
		/** The host's name for a tool the model called, or nothing for a call the host is not to be given. */
		private readonly hostName: (called: string) => string | undefined,
	) {}

	/** Ids of the tool calls in the API message that just ended. */
	get calledTools(): readonly string[] {
		return this.toolCalls;
	}

	/** Apply one stream event; true when it completes an API message. */
	apply(event: ApiEvent): boolean {
		const { content } = this;
		if (event.type === "message_start") {
			this.open.clear();
			this.toolCalls = [];
			this.rawStopReason = undefined;
			this.earlierOutput = this.usage.output;
			this.count(event.message.usage);
		} else if (event.type === "content_block_start") {
			const block = event.content_block;
			const at = content.length;
			if (block.type === "text") {
				content.push({ type: "text", text: block.text });
				if (block.text) this.emit({ type: "text", delta: block.text });
			} else if (block.type === "thinking") {
				content.push({ type: "reasoning", text: block.thinking });
				if (block.thinking) this.emit({ type: "reasoning", delta: block.thinking });
			} else if (block.type === "tool_use") {
				const name = this.hostName(block.name);
				// Claude Code answers a call for a tool it does not have and the turn goes on; the host sees none of it.
				if (name === undefined) return false;
				content.push({ type: "toolCall", id: block.id, name, arguments: {} });
				this.json.set(at, "");
				this.toolCalls.push(block.id);
			} else return false;
			this.open.set(event.index, at);
		} else if (event.type === "content_block_delta") {
			const at = this.open.get(event.index);
			const part = at === undefined ? undefined : content[at];
			if (at === undefined || !part) return false;
			const { delta } = event;
			if (delta.type === "text_delta" && part.type === "text") {
				part.text += delta.text;
				if (delta.text) this.emit({ type: "text", delta: delta.text });
			} else if (delta.type === "thinking_delta" && part.type === "reasoning") {
				part.text = (part.text ?? "") + delta.thinking;
				// Thinking whose text Claude withholds arrives as empty pieces; there is nothing to show.
				if (delta.thinking) this.emit({ type: "reasoning", delta: delta.thinking });
			} else if (delta.type === "input_json_delta" && part.type === "toolCall") {
				this.json.set(at, (this.json.get(at) ?? "") + delta.partial_json);
				if (delta.partial_json) this.emit({ type: "toolInput", delta: delta.partial_json, toolCallId: part.id });
			}
		} else if (event.type === "content_block_stop") {
			const at = this.open.get(event.index);
			const part = at === undefined ? undefined : content[at];
			if (at === undefined || !part) return false;
			this.open.delete(event.index);
			if (part.type === "toolCall") {
				const parsed = parseObject(this.json.get(at));
				this.json.delete(at);
				if (parsed) part.arguments = parsed;
				else this.broken.add(at);
			}
		} else if (event.type === "message_delta") {
			if (event.delta.stop_reason) this.rawStopReason = event.delta.stop_reason;
			this.count(event.usage);
		} else if (event.type === "message_stop") {
			return true;
		}
		return false;
	}

	private count(reported: {
		input_tokens?: number | null;
		output_tokens?: number | null;
		cache_read_input_tokens?: number | null;
		cache_creation_input_tokens?: number | null;
	}): void {
		const { usage } = this;
		// Input figures describe the latest API request, which already contains the earlier ones.
		if (reported.input_tokens != null) usage.input = reported.input_tokens;
		if (reported.cache_read_input_tokens != null) usage.cacheRead = reported.cache_read_input_tokens;
		if (reported.cache_creation_input_tokens != null) usage.cacheWrite = reported.cache_creation_input_tokens;
		if (reported.output_tokens != null) usage.output = this.earlierOutput + reported.output_tokens;
	}

	/**
	 * The complete message. Tool calls still open, or whose arguments never became a JSON
	 * object, are dropped: they happen when output is cut off. A `toolUse` stop with such a
	 * call fails instead, since the host must not dispatch a call it cannot read.
	 */
	finish(stop: Stop, error?: ModelError): AssistantMessage {
		const unfinished = new Set<number>([...this.open.values(), ...this.broken]);
		const dropped = this.content.some((part, at) => part.type === "toolCall" && unfinished.has(at));
		const content = this.content.filter((part, at) =>
			part.type === "toolCall" ? !unfinished.has(at) : part.type === "reasoning" ? !!part.text : part.type !== "text" || part.text !== "");
		if (stop === "toolUse" && (dropped || !content.some((part) => part.type === "toolCall"))) {
			stop = "failed";
			error = { kind: "other", message: "The model sent a tool call whose arguments were not a JSON object." };
		}
		return {
			role: "assistant",
			content,
			stop,
			usage: { ...this.usage },
			model: { provider: this.model.provider, id: this.model.id },
			...(error ? { error } : {}),
		};
	}
}

function parseObject(json: string | undefined): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(json?.trim() ? json : "{}");
		return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

/** The binding's stop for the stop reason of a turn that ended without tool calls. */
export function stopFor(raw: string | undefined): Stop {
	return raw === "max_tokens" || raw === "model_context_window_exceeded" ? "length" : raw === "refusal" ? "refused" : "finished";
}

const CREDENTIALS = ["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "cloud_credential_error"];
const TEMPORARY = ["rate_limit", "overloaded", "server_error"];

/** The binding's error kind for a failure, from Claude Code's own error name and the text that came with it. */
export function errorKind(sdkError: string | undefined, text: string): ErrorKind {
	if (sdkError && CREDENTIALS.includes(sdkError)) return "credentials";
	if (/prompt is too long|context (window|length)|too many tokens|exceeds? the (model'?s? )?(maximum )?context/i.test(text)) return "contextTooLarge";
	if (sdkError && TEMPORARY.includes(sdkError)) return "temporary";
	if (/not signed in|claude auth login|invalid api key|oauth token|401/i.test(text)) return "credentials";
	if (/overloaded|rate limit|\b(429|500|502|503|529)\b|timed? ?out|ECONNRESET|ETIMEDOUT/i.test(text)) return "temporary";
	return "other";
}

/** Text safe to put in an error: long token-like strings are cut out. */
export function scrub(text: string): string {
	return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]").replace(/\b[A-Za-z0-9_-]{60,}\b/g, "[redacted]").slice(0, 2_000);
}
