import { randomUUID } from "node:crypto";
import type { AssistantMessage, ContentPart, ModelInfo, ModelRef, ModelRequest, Plugin, PluginApi, Provider, RequestOptions, ToolCall, ToolContext, ToolDefinition, ToolResult, ToolSource } from "@modular-agent/harness";
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
	constructor(private api?: PluginApi) {}
	models(): ModelInfo[] {
		return [{ provider: "conformance", id: "echo", name: "Conformance echo", contextWindow: 1_000_000, maxOutput: 4096, reasoning: false, input: ["text"] }];
	}
	async request(model: ModelRef, request: ModelRequest, options: RequestOptions): Promise<AssistantMessage> {
		const scope = { sessionId: options.sessionId, provider: this.id, model: { provider: this.id, id: model.id } };
		const prepared = options.requestPrepared ? undefined : await this.api?.runHook<{ request: ModelRequest }>("provider.request", { ...scope, request });
		const message = this.echo(prepared?.request ?? request, options);
		if (!options.requestPrepared) await this.api?.runHook("provider.response", { sessionId: scope.sessionId, provider: scope.provider, model: scope.model, message });
		return message;
	}
	private echo(request: ModelRequest, options: RequestOptions): AssistantMessage {
		const messages = request.messages;
		const lastUser = [...messages].reverse().find((m) => m.role === "user");
		const latest = lastUser ? lastUser.content.filter((p) => p.type === "text").map((p) => p.text).join("") : "";
		const after = lastUser ? messages.slice(messages.lastIndexOf(lastUser) + 1) : [];
		const result = after.find((m) => m.role === "toolResult");
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		const reply = (t: string): AssistantMessage => {
			options.onEvent?.({ type: "text", delta: t });
			return { role: "assistant", content: [text(t)], stop: "finished", usage };
		};
		if (latest.startsWith("fail:")) return { role: "assistant", content: [], stop: "failed", error: { kind: "other", message: latest.slice(5) }, usage };
		if (latest.startsWith("tool:")) {
			const tool = /^tool:([^ ]+) ([\s\S]*)$/.exec(latest);
			const invalid: AssistantMessage = { role: "assistant", content: [], stop: "failed", error: { kind: "other", message: "Invalid tool directive" }, usage };
			if (!tool || !request.tools.some((t) => t.name === tool[1])) return invalid;
			let input: Record<string, unknown>;
			try { input = JSON.parse(tool[2]); } catch { return invalid; }
			if (!input || typeof input !== "object" || Array.isArray(input)) return invalid;
			if (result) return reply(`done: ${[...result.content.filter((p) => p.type === "text").map((p) => p.text).join("")].slice(0, 200).join("")}`);
			return { role: "assistant", content: [{ type: "toolCall", id: `call-${randomUUID()}`, name: tool[1], arguments: input }], stop: "toolUse", usage };
		}
		return reply(`echo: ${latest}`);
	}
}

export function conformanceProvider(): Plugin {
	return { name: "provider-conformance", setup: (api) => api.provide("provider", new ConformanceProvider(api)) };
}

const TOOLS: ToolDefinition[] = [
	{ name: "nest", description: "Run a nested tool call", parameters: { type: "object", properties: { name: { type: "string" }, input: { type: "object" } }, required: ["name", "input"] } },
	{ name: "bash", description: "Run a shell command in the working environment", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }, hints: { destructive: true, openWorld: true } },
	{ name: "read", description: "Read a file in the working environment", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, hints: { readOnly: true, safeToRepeat: true } },
];

/** The conformance plugin's tools: bash and read, using only the session's working environment. */
export class ConformanceTools implements ToolSource {
	readonly id = "conformance-tools";
	constructor(private nestedOnly = false, private exclude: readonly string[] = []) {}
	tools(): ToolDefinition[] {
		return TOOLS.filter(t => (!this.nestedOnly || t.name === "nest") && !this.exclude.includes(t.name));
	}
	async run(call: ToolCall, ctx: ToolContext): Promise<Omit<ToolResult, "callId">> {
		if (call.name === "nest") {
			try {
				if (!ctx.tools) return { status: "failed", content: [text("not_supported")] };
				return await ctx.tools.call(String(call.input.name), call.input.input as Record<string, unknown>);
			} catch (error) {
				return { status: "failed", content: [text((error as { code?: string }).code ?? "internal")] };
			}
		}
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

export function conformanceTools(nestedOnly = false, exclude?: readonly string[]): Plugin {
	return { name: "conformance-tools", setup: (api) => api.provide("tool-source", new ConformanceTools(nestedOnly, exclude)) };
}

const SECRET = "conformance-secret";

/** Replace a marker even when it straddles events. Keep each piece's place in the stream. */
function redactPieces(pieces: { object: Record<string, any>; key: string }[]): void {
	const joined = pieces.map(({ object, key }) => object[key]).join("");
	const matches = [...joined.matchAll(/conformance-secret/g)].map((m) => m.index);
	let start = 0;
	let match = 0;
	for (const { object, key } of pieces) {
		const value = object[key] as string;
		const end = start + value.length;
		let cursor = start;
		let out = "";
		while (match < matches.length && matches[match] < end) {
			const at = matches[match];
			if (at >= start) out += value.slice(cursor - start, at - start) + "[redacted]";
			cursor = at + SECRET.length;
			if (cursor > end) break;
			match++;
		}
		object[key] = out + value.slice(cursor - start);
		start = end;
	}
}

function redactStrings(value: unknown): unknown {
	if (typeof value === "string") return value.replaceAll(SECRET, "[redacted]");
	if (Array.isArray(value)) return value.map(redactStrings);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactStrings(child)]));
	return value;
}

/** The conformance plugin's hook handlers. */
export function conformanceHooks(): Plugin {
	return {
		name: "conformance-hooks",
		setup(api) {
			api.on("tool.before", (p: { call: { input: unknown } }) => (JSON.stringify(p.call.input ?? {}).includes("conformance-forbidden") ? { refuse: "refused by the conformance plugin" } : undefined));
			api.on("turn.before", () => ({ system: "The conformance plugin is loaded." }));
			api.on("output", (p: { events: { type: string; data: any }[] }) => {
				const events = structuredClone(p.events);
				for (const type of ["text", "reasoning", "toolInput"]) {
					redactPieces(events.flatMap(({ type: name, data }) =>
						(name === type || (name === "model.output" && data?.type === type)) && typeof data?.delta === "string" ? [{ object: data, key: "delta" }] : []));
				}
				redactPieces(events.flatMap(({ type, data }) => type === "toolOutput" && typeof data?.chunk === "string" ? [{ object: data, key: "chunk" }] : []));
				redactPieces(events.flatMap(({ type, data }) => type === "tool.progress" && Array.isArray(data?.content)
					? data.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => ({ object: part, key: "text" })) : []));
				return { action: "pass", events: events.map((event) => ({ ...event, data: redactStrings(event.data) })) };
			});
		},
	};
}
