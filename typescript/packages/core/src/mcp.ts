import { McpClient, normalizeMcpInputSchema, StdioTransport, StreamableHttpTransport, toLlmContent, limitMcpContent } from "@earendil-works/pi-mcp";
import { definePlugin } from "./plugin.js";
import { tool, type Tool } from "./tool.js";
import type { Content } from "./data.js";
import type { JSONSchema } from "./schema.js";
import { pathToFileURL } from "node:url";
export type McpServerConfig =
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { url: string; headers?: Record<string, string> };

interface Connection { client: McpClient; tools: Tool[]; unsubscribe?: () => void }
interface Options {
  /** Resolve the servers independently for each session's actual project. */
  servers(project: string): Promise<Record<string, McpServerConfig>>;
  warn?: (message: string) => void;
}

/** Publish valid catalogs for each session, and close peers when it closes. */
export function standardMcpTools(options: Options) {
  const connections = new Map<string, Connection[]>();
  const listeners = new Set<() => void>();
  const warn = options.warn ?? console.error;
  const changed = () => { for (const listener of listeners) listener(); };
  const detach = async (id: string) => {
    const list = connections.get(id);
    connections.delete(id);
    if (list) {
      changed();
      await Promise.allSettled(list.map(c => { c.unsubscribe?.(); return c.client.close(); }));
    }
  };
  async function attach(id: string, project: string, servers: Record<string, McpServerConfig>) {
    let current = connections.get(id);
    if (!current) connections.set(id, current = []);
    for (const [server, config] of Object.entries(servers)) {
      const client = new McpClient({ name: "modular-agent", version: "0.1.0", roots: [{ uri: pathToFileURL(project).href, name: "project" }] });
      try {
        await client.connect("url" in config ? new StreamableHttpTransport({ url: config.url, headers: config.headers })
          : new StdioTransport({ command: config.command, args: config.args, env: config.env, cwd: config.cwd ?? project, stderr: "pipe" }));
        const connection: Connection = { client, tools: [] };
        const refresh = async () => {
          const entries = await client.listTools();
          if (connections.get(id) !== current) return;
          const names = new Set(current!.filter(c => c !== connection).flatMap(c => c.tools.map(t => t.definition.name)));
          const pending = new Map<string, Tool>();
          for (const entry of entries) {
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
          connection.tools = [...pending.values()];
        };
        await refresh();
        if (connections.get(id) !== current) { await client.close(); return; }
        current.push(connection);
        let refreshes = Promise.resolve();
        connection.unsubscribe = client.onNotification("notifications/tools/list_changed", () => {
          refreshes = refreshes.then(async () => {
            if (connections.get(id) !== current || !current!.includes(connection)) return;
            try { await refresh(); }
            catch (error) {
              warn(`MCP server ${server}: ${error instanceof Error ? error.message : String(error)}`);
              current!.splice(current!.indexOf(connection), 1);
              connection.unsubscribe?.();
              await client.close().catch(() => {});
            }
            changed();
          });
        });
        changed();
      } catch (error) {
        warn(`MCP server ${server}: ${error instanceof Error ? error.message : String(error)}`);
        await client.close().catch(() => {});
      }
    }
  }
  const plugin = definePlugin({ name: "tools.mcp.standard", setup(r) {
    r.tools({ id: "tools.mcp.standard", tools: id => id ? (connections.get(id) ?? []).flatMap(c => c.tools) : [],
      onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); } });
    r.on("session.prepare", async ({ sessionId, project }) => {
      await attach(sessionId, project, await options.servers(project));
    }, "normal", { inProcessOnly: true });
    r.on("session.end", ({ sessionId }) => detach(sessionId));
  }, async stop() { await Promise.all([...connections.keys()].map(detach)); } });
  return { ...plugin, attach };
}
