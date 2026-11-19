import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Settings } from "@modular-agent/core";
import type { McpServerConfig } from "@modular-agent/tools-mcp/sdk";
import { discover } from "./skills.js";

export async function optionalJson(path: string): Promise<Settings> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
    return value as Settings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${path}: ${(error as Error).message}`);
  }
}
export const paths = (env: NodeJS.ProcessEnv = process.env, home = env.HOME ?? homedir()) => {
  if (env.MODULAR_AGENT_DATA_DIR) {
    const config = resolve(env.MODULAR_AGENT_DATA_DIR);
    return { config, state: join(config, "state"), home };
  }
  return { home, config: join(env.XDG_CONFIG_HOME || join(home, ".config"), "modular-agent"), state: join(env.XDG_STATE_HOME || join(home, ".local/state"), "modular-agent", "typescript") };
};
export type Paths = ReturnType<typeof paths>;
export function standardSettings(settings: Settings): Settings {
  const out: Settings = { reasoning: "medium", maxSteps: 500, maxOutput: 32000, modelTools: ["codemode"] };
  for (const [name, value] of Object.entries(settings)) {
    const key = ({ thinking: "reasoning", step_limit: "maxSteps", output_limit: "maxOutput", model_tools: "modelTools" } as Record<string, string>)[name] ?? name;
    if (["model", "reasoning", "maxSteps", "maxOutput", "modelTools"].includes(key)) out[key] = value;
  }
  return out;
}
export const settingsFor = async (locations: Paths, project: string) => ({ ...await optionalJson(join(locations.config, "settings.json")), ...await optionalJson(join(project, ".modular-agent.json")) });
export const skillsFor = async (locations: Paths, project: string) => {
  const { skill_folders } = await optionalJson(join(locations.config, "settings.json"));
  const extra = Array.isArray(skill_folders) ? skill_folders.filter((x): x is string => typeof x === "string").map(x => resolve(x.replace(/^~(?=\/|$)/, locations.home))) : [];
  return discover([join(locations.config, "skills"), join(locations.home, ".agents/skills"), ...extra, join(project, ".agents/skills"), join(project, ".modular-agent/skills")]);
};
const trustFile = (p: Paths) => join(p.config, "trusted-projects.json");
export async function trusted(p: Paths, project: string, grant = false) {
  const file = trustFile(p), saved = await optionalJson(file);
  if (grant && saved[project] !== true) {
    await mkdir(p.config, { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ ...saved, [project]: true }, null, 2), { mode: 0o600 });
  }
  return grant || saved[project] === true;
}
function expand(text: unknown): string {
  if (typeof text !== "string") throw new Error("expected a string");
  return text.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
    const value = process.env[name];
    if (value === undefined) throw new Error(`environment variable ${name} is not set`);
    return value;
  });
}
function pairs(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
}
export async function mcpServers(p: Paths, project: string, trust: boolean, warn = console.error) {
  const servers = new Map<string, McpServerConfig>();
  for (const file of [join(p.config, "mcp.json"), ...(trust ? [join(project, ".mcp.json")] : [])]) {
    try {
      const { mcpServers } = await optionalJson(file);
      if (mcpServers === undefined) continue;
      if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) throw new Error("mcpServers must be an object");
      for (const [name, spec] of Object.entries(mcpServers)) {
        try {
          if (spec?.disabled === true) continue;
          if (spec?.type === "sse") throw new Error("only stdio and Streamable HTTP MCP are supported");
          if (spec?.url !== undefined) servers.set(name, { url: expand(spec.url), headers: pairs(spec.headers) });
          else {
            if (spec?.args !== undefined && !Array.isArray(spec.args)) throw new Error("args must be an array");
            servers.set(name, { command: expand(spec?.command), args: spec?.args?.map(expand), env: pairs(spec?.env) });
          }
        } catch (error) { warn(`${file}: MCP server ${name}: ${(error as Error).message}`); }
      }
    } catch (error) { warn((error as Error).message); }
  }
  return Object.fromEntries(servers);
}
