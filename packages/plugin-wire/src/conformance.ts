import { randomUUID } from "node:crypto";
import type { AssistantMessage, ContentPart, ModelInfo, ModelRef, ModelRequest, Plugin, Provider, RequestOptions, ToolCall, ToolContext, ToolDefinition, ToolResult, ToolSource } from "@modular-agent/harness";
import { text, textOf } from "@modular-agent/harness";

/**
 * The conformance model, `conformance/echo` (docs/bindings/acp.md#conformance-mode).
 * No network, no credentials, fully predictable. It reads the latest input, ignoring
 * tool results: "tool:<name> <json>" asks for that tool call, then replies
 * "done: <result>"; anything else gets "echo: <text>".
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
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		const reply = (t: string): AssistantMessage => {
			options.onEvent?.({ type: "text", delta: t });
			return { role: "assistant", content: [text(t)], stop: "finished", usage };
		};
		const tool = /^tool:(\S+)\s+([\s\S]*)$/.exec(latest);
		if (tool && !result) {
			let input: Record<string, unknown>;
			try {
				input = JSON.parse(tool[2]);
			} catch {
				return reply(`echo: ${latest}`);
			}
			return { role: "assistant", content: [{ type: "toolCall", id: `call-${randomUUID()}`, name: tool[1], arguments: input }], stop: "toolUse", usage };
		}
		// 200 Unicode code points, not UTF-16 units.
		if (tool && result) return reply(`done: ${[...textOf(result.content as ContentPart[])].slice(0, 200).join("")}`);
		return reply(`echo: ${latest}`);
	}
}

export function conformanceProvider(): Plugin {
	return { name: "provider-conformance", setup: (api) => api.provide("provider", new ConformanceProvider()) };
}

const TOOLS: ToolDefinition[] = [
	{ name: "bash", description: "Run a shell command in the working environment", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }, hints: { destructive: true, openWorld: true } },
	{ name: "read", description: "Read a file in the working environment", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, hints: { readOnly: true, idempotent: true } },
];

/** The conformance plugin's tools: bash and read, using only the session's working environment. */
export class ConformanceTools implements ToolSource {
	readonly id = "conformance-tools";
	tools(): ToolDefinition[] {
		return TOOLS;
	}
	async run(call: ToolCall, ctx: ToolContext): Promise<Omit<ToolResult, "callId">> {
		const env = ctx.environment;
		if (!env) return { status: "failed", content: [text("There is no working environment")] };
		if (call.name === "read") {
			try {
				return { status: "completed", content: [text((await env.readFile(String(call.input.path))).toString("utf8"))] };
			} catch (error) {
				return { status: "failed", content: [text(`Can't read ${call.input.path}: ${error instanceof Error ? error.message : String(error)}`)] };
			}
		}
		if (call.name === "bash") {
			const r = await env.exec(String(call.input.command), { signal: ctx.signal, onOutput: (chunk) => ctx.progress([text(chunk)]) });
			if (ctx.signal.aborted) return { status: "cancelled", content: [text(`${r.output}\n[cancelled]`)] };
			return { status: r.exitCode === 0 ? "completed" : "failed", content: [text(`${r.output}\n[exit code ${r.exitCode}]`)], value: { exitCode: r.exitCode } };
		}
		return { status: "failed", content: [text(`No tool ${call.name}`)] };
	}
}

export function conformanceTools(): Plugin {
	return { name: "conformance-tools", setup: (api) => api.provide("tool-source", new ConformanceTools()) };
}

/** The conformance plugin's hooks: a gate on a marker string, and a system line. */
export function conformanceHooks(): Plugin {
	return {
		name: "conformance-hooks",
		setup(api) {
			api.on("tool.before", (p: { call: { input: unknown } }) => (JSON.stringify(p.call.input ?? {}).includes("conformance-forbidden") ? { refuse: "refused by the conformance plugin" } : undefined));
			api.on("turn.before", () => ({ system: "The conformance plugin is loaded." }));
		},
	};
}
