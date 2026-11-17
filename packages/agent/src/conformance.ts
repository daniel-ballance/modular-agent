import { randomUUID } from "node:crypto";
import type { AssistantMessage, ContentPart, ModelInfo, ModelRef, ModelRequest, Plugin, Provider, RequestOptions } from "@modular-agent/harness";
import { text, textOf } from "@modular-agent/harness";

/**
 * The ACP host binding's conformance model, `conformance/echo` (docs/bindings/acp.md).
 * No network, no credentials, and fully predictable, so a conformance kit can drive
 * any build the same way. It reads the latest input, ignoring tool results:
 * "tool:<name> <json>" asks for that tool call, then replies "done: <result>";
 * anything else gets "echo: <text>".
 */
export class ConformanceProvider implements Provider {
	readonly id = "conformance";
	readonly supports = { keepsState: false, runsTools: false, liveSessions: false, lateAnswers: false };
	models(): ModelInfo[] {
		return [{ provider: "conformance", id: "echo", name: "Conformance echo", contextWindow: 1_000_000, maxOutput: 4096, reasoning: false, input: ["text"] }];
	}
	async request(_model: ModelRef, request: ModelRequest, options: RequestOptions): Promise<AssistantMessage> {
		const messages = request.messages;
		const lastUser = [...messages].reverse().find((m) => m.role === "user");
		const latest = lastUser ? textOf(lastUser.content as ContentPart[]).trim() : "";
		const after = lastUser ? messages.slice(messages.lastIndexOf(lastUser) + 1) : [];
		const result = after.filter((m) => m.role === "toolResult").at(-1);
		const reply = (t: string): AssistantMessage => {
			options.onEvent?.({ type: "text", delta: t });
			return { role: "assistant", content: [text(t)], stop: "finished", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
		};
		const tool = /^tool:(\S+)\s+([\s\S]*)$/.exec(latest);
		if (tool && !result) {
			let input: Record<string, unknown> = {};
			try {
				input = JSON.parse(tool[2]);
			} catch {
				return reply(`echo: ${latest}`);
			}
			return { role: "assistant", content: [{ type: "toolCall", id: `call-${randomUUID()}`, name: tool[1], arguments: input }], stop: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
		}
		if (tool && result) return reply(`done: ${textOf(result.content as ContentPart[]).slice(0, 200)}`);
		return reply(`echo: ${latest}`);
	}
}

export function conformanceProvider(): Plugin {
	return {
		name: "provider-conformance",
		setup(api) {
			api.provide("provider", new ConformanceProvider());
		},
	};
}
