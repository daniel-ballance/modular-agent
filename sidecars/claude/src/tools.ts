import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition } from "./data.js";

/** MCP server name; Claude Code shows its tools to the model as `mcp__host__<name>`. */
export const SERVER_NAME = "host";
const PREFIX = `mcp__${SERVER_NAME}__`;
/** The API allows 64 characters in a tool name, and the model sees these with the prefix. */
const WIRE_LIMIT = 64 - PREFIX.length;

/**
 * One MCP name per host tool. Claude Code rewrites characters outside this set, which would
 * break the way back to the host's name, so they are replaced here. A name that is already
 * valid is kept; one that had to change, or that collides after changing, is told apart by a
 * digest of the original, so two host tools never share an MCP name. The result depends only
 * on the names, so every request for the same tools gives the model the same names.
 */
export function wireNames(names: readonly string[]): Map<string, string> {
	const valid = (name: string): boolean => /^[a-zA-Z0-9_-]+$/.test(name) && name.length <= WIRE_LIMIT;
	const wires = new Map<string, string>();
	const taken = new Set(names.filter(valid));
	for (const name of names) {
		if (wires.has(name)) continue;
		if (valid(name)) {
			wires.set(name, name);
			continue;
		}
		const clean = name.replace(/[^a-zA-Z0-9_-]/g, "_");
		let wire = clean.slice(0, WIRE_LIMIT);
		for (let salt = 0; taken.has(wire); salt++) {
			const mark = createHash("sha256").update(`${salt}:${name}`).digest("hex").slice(0, 8);
			wire = `${clean.slice(0, WIRE_LIMIT - mark.length - 1)}_${mark}`;
		}
		taken.add(wire);
		wires.set(name, wire);
	}
	return wires;
}

/** The input schema MCP requires: an object schema. The host's schema is passed through unchanged otherwise. */
function inputSchema(parameters: unknown): Record<string, unknown> & { type: "object" } {
	const schema = typeof parameters === "object" && parameters !== null && !Array.isArray(parameters) ? parameters as Record<string, unknown> : {};
	return { ...schema, type: "object" };
}

/**
 * Shows the host's tool definitions to Claude Code as an in-process MCP server that cannot
 * run anything. This sidecar has no tool implementations: the host owns tool execution. A
 * call that reaches the server is only held until the request ends, which happens as soon
 * as the model's tool-use message is complete, and is then answered with a refusal that no
 * model ever reads because the Claude Code process is closed.
 */
export class ToolBridge {
	readonly config: McpSdkServerConfigWithInstance;
	/** Permission rule and model-facing aliases for the options of the owning query. */
	readonly allowedTools = [`mcp__${SERVER_NAME}`];
	readonly aliases: Record<string, string> = {};
	/** How many calls Claude Code tried to make through the server. None of them ran anything. */
	held = 0;
	private readonly names = new Map<string, string>();
	private readonly wires: Map<string, string>;
	private readonly release = new Set<() => void>();

	constructor(tools: readonly ToolDefinition[]) {
		this.wires = wireNames(tools.map((tool) => tool.name));
		const listed = tools.map((tool) => {
			const wire = this.wires.get(tool.name) ?? tool.name;
			this.names.set(wire, tool.name);
			this.aliases[tool.name] = `${PREFIX}${wire}`;
			return {
				name: wire,
				description: tool.description,
				inputSchema: inputSchema(tool.parameters),
				// The host already chose this tool set; never hide part of it behind Claude Code's tool search.
				_meta: { "anthropic/alwaysLoad": true },
			};
		});
		const instance = new McpServer({ name: SERVER_NAME, version: "1.0.0" });
		instance.server.registerCapabilities({ tools: {} });
		instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));
		instance.server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
			this.held++;
			await new Promise<void>((settle) => {
				this.release.add(settle);
				extra.signal.addEventListener("abort", () => settle(), { once: true });
			});
			return { content: [{ type: "text", text: "This tool is run by the host, not here." }], isError: true } satisfies CallToolResult;
		});
		this.config = { type: "sdk", name: SERVER_NAME, instance };
	}

	/**
	 * The host's name for a tool the model called, or nothing when the call names no tool of
	 * this request. With the prefix it is a wire name. Without it, it is the host's own name,
	 * which Claude Code resolves through the alias it was given.
	 */
	hostName(called: string): string | undefined {
		if (called.startsWith(PREFIX)) return this.names.get(called.slice(PREFIX.length));
		return called in this.aliases ? called : undefined;
	}

	/** Let every held call return. Called when the request is over. */
	close(): void {
		for (const settle of this.release) settle();
		this.release.clear();
	}
}
