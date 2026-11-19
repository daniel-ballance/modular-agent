import { McpClient, normalizeMcpInputSchema, StdioTransport, StreamableHttpTransport, toLlmContent, limitMcpContent } from "@earendil-works/pi-mcp";
import { definePlugin, tool, type Content, type JSONSchema, type Tool } from "@modular-agent/core";
import { pathToFileURL } from "node:url";
import type { McpServerConfig } from "./index.js";
export type { McpServerConfig };

/** Connect at setup, publish only valid catalogs, and close peers at agent shutdown. */
export function standardMcpTools(options: { project: string; servers: Record<string, McpServerConfig>; warn?: (message: string) => void }) {
  const clients: McpClient[] = [];
  const warn = options.warn ?? console.error;
  return definePlugin({ name: "tools.mcp.standard", async setup(r) {
    const names = new Set<string>();
    for (const [server, config] of Object.entries(options.servers)) {
      const client = new McpClient({ name: "modular-agent", version: "0.1.0", roots: [{ uri: pathToFileURL(options.project).href, name: "project" }] });
      try {
        await client.connect("url" in config ? new StreamableHttpTransport({ url: config.url, headers: config.headers })
          : new StdioTransport({ command: config.command, args: config.args, env: config.env, cwd: config.cwd ?? options.project, stderr: "pipe" }));
        const pending = new Map<string, Tool>();
        for (const entry of await client.listTools()) {
          const name = `mcp_${server}__${entry.name}`;
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || !entry.name || names.has(name) || pending.has(name)) throw new Error(`invalid MCP tool name ${name}`);
          const a = entry.annotations;
          pending.set(name, tool({ name, description: entry.description ?? entry.name,
            input: normalizeMcpInputSchema(entry.inputSchema) as Exclude<JSONSchema, boolean>, readOnly: a?.readOnlyHint, destructive: a?.destructiveHint,
            openWorld: a?.openWorldHint, inProcessOnly: true,
            async run(input, ctx) {
              const res = await client.callTool(entry.name, input as Record<string, unknown>, { signal: ctx.cancelled });
              const limited = await limitMcpContent(toLlmContent(res));
              return { status: res.isError ? "failed" : "completed", content: limited.content as Content, value: res.structuredContent };
            } }));
        }
        for (const [name, item] of pending) { names.add(name); r.tool(item); }
        clients.push(client);
      } catch (error) {
        warn(`MCP server ${server}: ${error instanceof Error ? error.message : String(error)}`);
        await client.close().catch(() => {});
      }
    }
  }, async stop() { await Promise.allSettled(clients.splice(0).map(c => c.close())); } });
}
