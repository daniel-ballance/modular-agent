import type { ContentPart, Plugin, ToolCall, ToolContext, ToolDefinition, ToolResult, ToolSource } from "@modular-agent/harness";
import { text } from "@modular-agent/harness";

const MAX_OUTPUT = 50_000;

function truncate(value: string): string {
	return value.length <= MAX_OUTPUT ? value : `${value.slice(0, MAX_OUTPUT)}\n[... ${value.length - MAX_OUTPUT} more characters cut]`;
}
type Outcome = Omit<ToolResult, "callId">;
const ok = (content: string | ContentPart[], value?: unknown): Outcome => ({ status: "completed", content: typeof content === "string" ? [text(content)] : content, value });
const fail = (message: string): Outcome => ({ status: "failed", content: [text(message)] });

const DEFINITIONS: ToolDefinition[] = [
	{
		name: "read",
		description: "Read a file. Returns its text, or the requested lines.",
		parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number", description: "First line, from 1" }, limit: { type: "number" } }, required: ["path"] },
		hints: { readOnly: true, idempotent: true },
		parallel: true,
	},
	{
		name: "write",
		description: "Write a file, replacing it if it exists. Creates folders as needed.",
		parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
		hints: { destructive: true, idempotent: true },
	},
	{
		name: "edit",
		description: "Replace one exact, unique piece of text in a file.",
		parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"] },
		hints: { destructive: true },
	},
	{
		name: "bash",
		description: "Run a shell command in the working directory. Returns its output and exit code.",
		parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number", description: "Seconds" } }, required: ["command"] },
		hints: { destructive: true, openWorld: true },
	},
];

/** read, write, edit and bash, using the session's working environment. */
export class FileTools implements ToolSource {
	readonly id = "tools-files";
	tools(): ToolDefinition[] {
		return DEFINITIONS;
	}
	async run(call: ToolCall, ctx: ToolContext): Promise<Outcome> {
		const env = ctx.environment;
		if (!env) return fail("No working environment is available");
		const input = call.input as Record<string, any>;
		switch (call.name) {
			case "read": {
				if (!(await env.exists(input.path))) return fail(`File not found: ${input.path}`);
				const lines = (await env.readFile(input.path)).toString("utf8").split("\n");
				const start = Math.max(1, Number(input.offset ?? 1));
				const end = input.limit ? start - 1 + Number(input.limit) : lines.length;
				return ok(truncate(lines.slice(start - 1, end).join("\n")));
			}
			case "write":
				await env.writeFile(input.path, String(input.content));
				return ok(`Wrote ${String(input.content).length} characters to ${input.path}`);
			case "edit": {
				if (!(await env.exists(input.path))) return fail(`File not found: ${input.path}`);
				const current = (await env.readFile(input.path)).toString("utf8");
				const count = current.split(String(input.oldText)).length - 1;
				if (count === 0) return fail("oldText was not found in the file");
				if (count > 1) return fail(`oldText appears ${count} times; it must be unique`);
				await env.writeFile(input.path, current.replace(String(input.oldText), () => String(input.newText)));
				return ok(`Edited ${input.path}`);
			}
			case "bash": {
				const result = await env.exec(String(input.command), {
					signal: ctx.signal,
					timeoutMs: input.timeout ? Number(input.timeout) * 1000 : undefined,
					onOutput: (chunk) => ctx.progress([text(chunk)]),
				});
				if (ctx.signal.aborted) return { status: "cancelled", content: [text(truncate(result.output) + "\n[cancelled]")] };
				const status = result.timedOut ? "\n[timed out]" : `\n[exit code ${result.exitCode}]`;
				return { status: result.exitCode === 0 ? "completed" : "failed", content: [text(truncate(result.output) + status)], value: { exitCode: result.exitCode } };
			}
			default:
				return fail(`Unknown tool ${call.name}`);
		}
	}
}

export function fileTools(): Plugin {
	return {
		name: "tools-files",
		spawn: { module: "@modular-agent/tools-files", export: "fileTools" },
		setup(api) {
			api.provide("tool-source", new FileTools());
		},
	};
}
