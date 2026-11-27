import { isAbsolute } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import type * as acp from "@agentclientprotocol/sdk";

/** The "mcp-servers" capability, as the tools-mcp plugin provides it. */
export type AcpMcpServer = { command: string; args?: string[]; env?: Record<string, string> } | { url: string; headers?: Record<string, string> };
export interface McpServers { attach(sessionId: string, servers: Record<string, AcpMcpServer>, cwd?: string): Promise<string[]> }

export function parseHostServers(servers: acp.McpServer[], absoluteCommands: boolean): Record<string, AcpMcpServer> {
	return Object.fromEntries(servers.map((s): [string, AcpMcpServer] => {
		if ("command" in s) {
			if (absoluteCommands && !isAbsolute(s.command)) throw new RequestError(-32602, "ACP MCP executable paths must be absolute", { code: "invalid_params" });
			return [s.name, { command: s.command, args: s.args, env: Object.fromEntries(s.env.map(e => [e.name, e.value])) }];
		}
		if (s.type === "http") return [s.name, { url: s.url, headers: Object.fromEntries(s.headers.map(h => [h.name, h.value])) }];
		throw new RequestError(-32602, "Only stdio and Streamable HTTP MCP are supported", { code: "not_supported" });
	}));
}
