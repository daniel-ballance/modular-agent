// TEST ONLY. A scripted stand-in for the Agent SDK's `query()`. It starts no process and
// reaches no model. What it answers is chosen by a marker in the prompt text:
//   [fake:tool]   thinking, then a call to the first offered tool with {"city":"Paris"}
//   [fake:slow]   one text piece, then nothing until the query is closed
//   [fake:auth]   Claude Code's report of a rejected login
//   [fake:length] text cut off at the output limit
//   [fake:exit]   the process ends without a result
//   otherwise     thinking, then text that repeats the model, effort, system prompt and prompt
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentQuery, QueryFunction } from "../sdk.js";

export interface FakeLog {
	/** Options of every query started. */
	started: Options[];
	/** Prompt text of every query that was given one. */
	prompts: string[];
	closed: number;
}

const USAGE = { input_tokens: 11, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 };

function promptText(message: SDKUserMessage): string {
	const { content } = message.message;
	if (typeof content === "string") return content;
	return content.map((block) => block.type === "text" ? block.text : `(${block.type})`).join("\n");
}

export function createFake(account: Record<string, unknown> = { subscriptionType: "max", email: "fake@example.invalid" }, beforeContextUsage?: () => Promise<void>): { query: QueryFunction; log: FakeLog } {
	const log: FakeLog = { started: [], prompts: [], closed: 0 };
	const query: QueryFunction = ({ prompt, options }) => {
		log.started.push(options);
		let closed = false;
		let wake: (() => void) | undefined;
		const untilClosed = new Promise<void>((settle) => { wake = settle; });
		const event = (e: unknown): SDKMessage => ({ type: "stream_event", event: e, parent_tool_use_id: null, uuid: "00000000-0000-4000-8000-000000000000", session_id: "fake" }) as unknown as SDKMessage;
		const result = (fields: Record<string, unknown>): SDKMessage => ({
			type: "result", subtype: "success", is_error: false, result: "", session_id: "fake",
			modelUsage: { [String(options.model)]: { contextWindow: 200_000, maxOutputTokens: 32_000 } }, ...fields,
		}) as unknown as SDKMessage;
		async function* run(): AsyncGenerator<SDKMessage, void> {
			const first = await Promise.race([prompt[Symbol.asyncIterator]().next(), untilClosed.then(() => undefined)]);
			if (closed || !first || first.done) return;
			const text = promptText(first.value);
			log.prompts.push(text);
			yield { type: "system", subtype: "init", claude_code_version: "fake", model: options.model, tools: [], mcp_servers: Object.keys(options.mcpServers ?? {}).map((name) => ({ name, status: "connected" })), agents: [], skills: [], plugins: [], slash_commands: [] } as unknown as SDKMessage;
			if (text.includes("[fake:exit]")) return;
			if (text.includes("[fake:auth]")) {
				yield { type: "assistant", error: "authentication_failed", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Invalid authentication credentials" }] } } as unknown as SDKMessage;
				yield result({ is_error: true, result: "Invalid authentication credentials" });
				return;
			}
			yield event({ type: "message_start", message: { id: "msg_fake", model: options.model, usage: USAGE } });
			if (text.includes("[fake:slow]")) {
				yield event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
				yield event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "working" } });
				await untilClosed;
				return;
			}
			yield event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
			yield event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "pondering" } });
			yield event({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } });
			yield event({ type: "content_block_stop", index: 0 });
			const tool = Object.values(options.toolAliases ?? {})[0];
			if (text.includes("[fake:tool]") && tool) {
				yield event({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_fake_1", name: tool, input: {} } });
				yield event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"city\":" } });
				yield event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"Paris\"}" } });
				yield event({ type: "content_block_stop", index: 1 });
				yield event({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 21 } });
				yield event({ type: "message_stop" });
				// The real Claude Code would now try the tool and wait for it.
				await untilClosed;
				return;
			}
			const said = `model=${options.model} effort=${options.effort ?? "default"} system=${String(options.systemPrompt)} said=${text}`;
			yield event({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
			yield event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: said.slice(0, 8) } });
			yield event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: said.slice(8) } });
			yield event({ type: "content_block_stop", index: 1 });
			yield event({ type: "message_delta", delta: { stop_reason: text.includes("[fake:length]") ? "max_tokens" : "end_turn" }, usage: { output_tokens: 34 } });
			yield event({ type: "message_stop" });
			yield result({ result: said });
		}
		const messages = run();
		const fake: AgentQuery = {
			[Symbol.asyncIterator]: () => messages,
			initializationResult: async () => ({
				account,
				models: [
					{ value: "default", resolvedModel: "claude-sonnet-5-5", displayName: "Default", description: "" },
					{ value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku", description: "" },
					{ value: "claude-nova-9", displayName: "Nova 9", description: "", supportedEffortLevels: ["low", "high"] },
				],
			}) as never,
			setModel: async () => {},
			getContextUsage: async () => {
				await beforeContextUsage?.();
				return { rawMaxTokens: 200_000 } as never;
			},
			close: () => {
				if (closed) return;
				closed = true;
				log.closed++;
				wake?.();
				if (process.env.CLAUDE_SIDECAR_TEST_FAKE_SDK) process.stderr.write(`[fake-sdk] ${options.model ? "query" : "probe"} closed\n`);
			},
		};
		return fake;
	};
	return { query, log };
}

/** The fake `main.ts` loads under CLAUDE_SIDECAR_TEST_FAKE_SDK. */
export const fakeQuery: QueryFunction = createFake(process.env.CLAUDE_SIDECAR_TEST_FAKE_SDK === "api-key" ? { apiKeySource: "user" } : undefined).query;
