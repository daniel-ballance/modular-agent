import { createMcpToolName, limitMcpContent, McpClient, normalizeMcpInputSchema, StdioTransport, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import type { ContentPart, Plugin, PluginApi, ToolCall, ToolContext, ToolDefinition, ToolResult, ToolSource } from "@modular-agent/harness";
import { text } from "@modular-agent/harness";

/** An MCP server: a program to start (stdio), or a URL (Streamable HTTP). The same shape as Pi's and Claude's mcpServers. */
export type McpServerConfig =
	| { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
	| { url: string; headers?: Record<string, string> };

interface Connection { server: string; client: McpClient; tools: { definition: ToolDefinition; mcpName: string }[] }

/** What another plugin, such as an Interface, uses to give one session its own MCP servers. */
export interface McpServers {
	attach(sessionId: string, servers: Record<string, McpServerConfig>, cwd?: string): Promise<string[]>;
	detach(sessionId: string): Promise<void>;
}

/**
 * Tools from MCP servers. Servers in the plugin's settings serve every session;
 * servers attached to a session, as an ACP client passes them, serve only it.
 * A server that fails to start is reported as a problem, and the rest carry on.
 */
export class McpTools implements ToolSource, McpServers {
	readonly id = "tools-mcp";
	private everywhere: Connection[] = [];
	private bySession = new Map<string, Connection[]>();
	private listeners = new Set<() => void>();

	constructor(private api: PluginApi) {}

	tools(sessionId?: string): ToolDefinition[] {
		return this.connections(sessionId).flatMap((c) => c.tools.map((t) => t.definition));
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private connections(sessionId?: string): Connection[] {
		return [...(sessionId ? (this.bySession.get(sessionId) ?? []) : []), ...this.everywhere];
	}

	async run(call: ToolCall, ctx: ToolContext): Promise<Omit<ToolResult, "callId">> {
		for (const c of this.connections(ctx.sessionId)) {
			const tool = c.tools.find((t) => t.definition.name === call.name);
			if (!tool) continue;
			const result = await c.client.callTool(tool.mcpName, call.input, { signal: ctx.signal });
			const limited = await limitMcpContent(toLlmContent(result));
			const content = limited.content.map((p) => (p.type === "text" ? text(p.text) : (p as ContentPart)));
			// MCP reports a tool's failure in its result, not as a protocol error.
			return { status: result.isError ? "failed" : "completed", content, value: result.structuredContent };
		}
		return { status: "failed", content: [text(`No MCP server offers ${call.name}`)] };
	}

	async connect(server: string, config: McpServerConfig, cwd?: string): Promise<Connection | undefined> {
		const client = new McpClient({ name: "modular-agent", version: "0.1.0", ...(cwd ? { roots: [{ uri: `file://${cwd}`, name: "project" }] } : {}) });
		try {
			const transport =
				"url" in config
					? new StreamableHttpTransport({ url: config.url, headers: config.headers })
					: new StdioTransport({ command: config.command, args: config.args, env: config.env, cwd: config.cwd ?? cwd, stderr: "pipe" });
			await client.connect(transport);
			const taken = new Set(this.connections().flatMap((c) => c.tools.map((t) => t.definition.name)));
			const tools = (await client.listTools()).map((tool) => {
				const name = createMcpToolName(server, tool.name, (n) => taken.has(n));
				taken.add(name);
				const a = tool.annotations ?? {};
				const definition: ToolDefinition = {
					name,
					description: tool.description ?? tool.title ?? tool.name,
					parameters: normalizeMcpInputSchema(tool.inputSchema),
					...(tool.outputSchema ? { returns: tool.outputSchema } : {}),
					// MCP's annotations are hints, as ours are: the approval plugin and the durable Runtime read them.
					hints: { readOnly: a.readOnlyHint, destructive: a.destructiveHint, openWorld: a.openWorldHint },
					callers: ["model", "ui", "plugin"],
				};
				return { definition, mcpName: tool.name };
			});
			return { server, client, tools };
		} catch (error) {
			this.api.reportProblem(`MCP server ${server}`, error);
			await client.close().catch(() => undefined);
			return undefined;
		}
	}

	async start(servers: Record<string, McpServerConfig>): Promise<void> {
		const connected = await Promise.all(Object.entries(servers).map(([name, config]) => this.connect(name, config, this.api.project)));
		this.everywhere.push(...connected.filter((c): c is Connection => !!c));
		this.changed();
	}

	async attach(sessionId: string, servers: Record<string, McpServerConfig>, cwd?: string): Promise<string[]> {
		const connected = (await Promise.all(Object.entries(servers).map(([name, config]) => this.connect(name, config, cwd)))).filter((c): c is Connection => !!c);
		this.bySession.set(sessionId, [...(this.bySession.get(sessionId) ?? []), ...connected]);
		this.changed();
		return connected.map((c) => c.server);
	}

	async detach(sessionId: string): Promise<void> {
		const list = this.bySession.get(sessionId) ?? [];
		this.bySession.delete(sessionId);
		await Promise.all(list.map((c) => c.client.close().catch(() => undefined)));
		if (list.length) this.changed();
	}

	async stop(): Promise<void> {
		for (const id of [...this.bySession.keys()]) await this.detach(id);
		await Promise.all(this.everywhere.map((c) => c.client.close().catch(() => undefined)));
		this.everywhere = [];
	}

	private changed(): void {
		for (const l of this.listeners) l();
	}
}

/** Settings: "servers", a map of name to server, as in Pi's or Claude's mcpServers. */
export function mcpTools(options: { servers?: Record<string, McpServerConfig> } = {}): Plugin {
	let tools: McpTools | undefined;
	return {
		name: "tools-mcp",
		spawn: { module: "@modular-agent/tools-mcp", export: "mcpTools", options },
		async setup(api) {
			tools = new McpTools(api);
			api.provide("tool-source", tools);
			api.provide("mcp-servers", tools);
			api.on("session.end", (p: { sessionId: string }) => tools!.detach(p.sessionId));
			const servers = { ...((api.config().servers as Record<string, McpServerConfig> | undefined) ?? {}), ...(options.servers ?? {}) };
			await tools.start(servers);
		},
		stop: () => tools?.stop(),
	};
}
