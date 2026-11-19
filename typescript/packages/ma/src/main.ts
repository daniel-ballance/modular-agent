#!/usr/bin/env node
import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent, fileHistory, httpHistory, type Agent, type ProcessPlugin, type Settings } from "@modular-agent/core";
import { standardFileTools } from "@modular-agent/tools-files/sdk";
import { standardMcpTools } from "@modular-agent/tools-mcp/sdk";
import { paths, settingsFor, skillsFor, standardSettings, mcpServers, trusted, type Paths } from "./configuration.js";
import { standardPrompt } from "./prompt.js";
import { codemode } from "./codemode.js";
import { loadScript } from "./script.js";
import { line, print } from "./terminal.js";
import { HELP } from "./help.js";

function parse(argv: string[]) {
  const opts: { command?: string; project: string; runtime: "durable" | "transient"; session?: string; prompt?: string;
    resume?: boolean; verbose?: boolean; json?: boolean; history?: boolean; declaration?: boolean; acp?: boolean;
    trust?: boolean; all?: boolean; help?: boolean; version?: boolean; settings: Settings } = { project: process.cwd(), runtime: "durable", settings: {} };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => { const item = argv[++i]; if (item === undefined) throw new Error(`${flag} needs a value`); return item; };
    switch (flag) {
      case "-h": case "--help": opts.help = true; break;
      case "-V": case "--version": opts.version = true; break;
      case "-p": case "--print": opts.prompt = value(); break;
      case "-c": case "--continue": opts.resume = true; break;
      case "-v": case "--verbose": opts.verbose = true; break;
      case "--json": opts.json = true; break;
      case "--history": opts.history = true; break;
      case "--declaration": opts.declaration = true; break;
      case "--trust-project": opts.trust = true; break;
      case "--acp": opts.acp = true; break;
      case "--all": opts.all = true; break;
      case "--project": opts.project = value(); break;
      case "--session": opts.session = value(); break;
      case "--model": opts.settings.model = value(); break;
      case "--thinking": {
        const level = value();
        if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(level)) throw new Error("thinking must be off, minimal, low, medium, high or xhigh");
        opts.settings.reasoning = level;
        break;
      }
      case "--runtime": {
        const kind = value();
        if (kind !== "durable" && kind !== "transient") throw new Error("runtime must be transient or durable");
        opts.runtime = kind;
        break;
      }
      case "models": case "skills": case "mcp": case "sessions":
        if (!opts.command) { opts.command = flag; break; }
        // fall through
      default: throw new Error(`unknown argument ${flag}; use --help`);
    }
  }
  return opts;
}
export async function claudeLaunch(p: Paths): Promise<ProcessPlugin | undefined> {
  const candidates = [process.env.MODULAR_AGENT_CLAUDE_SIDECAR, fileURLToPath(new URL("../../../../sidecars/claude/dist/main.js", import.meta.url)),
    join(p.home, ".local/share/modular-agent/sidecars/claude/dist/main.js")];
  for (const candidate of candidates) if (candidate && (await stat(candidate).catch(() => undefined))?.isFile()) {
    const env: Record<string, string> = {};
    for (const name of ["HOME", "PATH", "CLAUDE_CONFIG_DIR"]) if (process.env[name] !== undefined) env[name] = process.env[name];
    return { command: [process.execPath, resolve(candidate)], env };
  }
}
const noModel = "no model is available. Sign in with `ma login openai-codex`, `ma login xai` or `ma login claude`, or pass --model. See `ma models`.";
const modelRef = (v: unknown): string | undefined => typeof v === "string" ? v :
  v && typeof v === "object" && "provider" in v && "id" in v ? `${v.provider}/${v.id}` : undefined;

async function main(argv: string[]) {
  const opts = parse(argv), p = paths();
  if (opts.help) { console.log(HELP); return 0; }
  if (opts.version) { console.log("ma 0.1.0 (typescript)"); return 0; }
  if (opts.acp && (opts.prompt !== undefined || opts.session || opts.trust || opts.resume)) throw new Error("with --acp the client creates sessions and grants trust");
  let project = await realpath(opts.project);
  if (opts.command === "skills") {
    const { skills, problems } = await skillsFor(p, project);
    for (const s of skills) console.log(`${s.name.padEnd(28)} ${s.description}\n${" ".repeat(29)}${s.file}`);
    for (const problem of problems) console.error(`skipped ${problem}`);
    return 0;
  }
  if (opts.command === "mcp") {
    for (const [name, config] of Object.entries(await mcpServers(p, project, await trusted(p, project, opts.trust))))
      console.log(`${name.padEnd(20)} ${"url" in config ? `http   ${config.url}` : `stdio  ${config.command} ${(config.args ?? []).join(" ")}`}`);
    return 0;
  }
  const history = process.env.MODULAR_AGENT_HISTORY_URL ? httpHistory(process.env.MODULAR_AGENT_HISTORY_URL, process.env.MODULAR_AGENT_HISTORY_TOKEN_FILE ?? "") : fileHistory(join(p.state, "sessions"));
  const base = { durability: opts.runtime === "durable" ? "durable" as const : "kept" as const, history, dataDir: p.state };
  const script = await loadScript(process.env.MODULAR_AGENT_SCRIPT, process.env.MODULAR_AGENT_SCRIPT_LOG);
  let savedModel: string | undefined;
  if (opts.command === "sessions" || opts.session || opts.resume) {
    const index = await createAgent({ ...base, project });
    try {
      const sessions = await index.sessions({ project: opts.all ? undefined : project });
      if (opts.command === "sessions") {
        for (const s of sessions) console.log(`${s.id}  ${s.project}`);
        return 0;
      }
      if (opts.resume && !opts.session) {
        const candidates = await Promise.all(sessions.map(s => index.savedSession(s.id)));
        candidates.sort((a, b) => b.updated - a.updated);
        opts.session = candidates[0]?.id;
        if (!opts.session) throw new Error("this folder has no saved session to continue");
      }
      const saved = await index.savedSession(opts.session!);
      project = saved.project;
      savedModel = modelRef(saved.settings.model);
    } finally { await index.close(); }
  }
  const settings = { ...standardSettings(await settingsFor(p, project)), ...opts.settings };
  const conformance = opts.acp && process.env.MODULAR_AGENT_CONFORMANCE === "1";
  const model = script ? "scripted/script" : conformance ? "conformance/echo" : modelRef(opts.settings.model) ?? savedModel ?? modelRef(settings.model);
  if (conformance) settings.modelTools = null;
  delete settings.model;
  const inspecting = opts.history || opts.declaration || opts.command === "models";
  const claude = !script && !conformance && (opts.acp || opts.command === "models" || model?.startsWith("claude/")) ? await claudeLaunch(p) : undefined;
  if (model?.startsWith("claude/") && !claude) throw new Error("the Claude sidecar is not installed; build typescript/sidecars/claude or set MODULAR_AGENT_CLAUDE_SIDECAR");
  if (!model && !inspecting && !opts.acp) throw new Error(noModel);
  const projectTrust = await trusted(p, project, opts.trust);
  const plugins = [standardFileTools({ spill: join(p.state, "output") }), codemode(), standardPrompt(p)];
  const servers = opts.declaration || opts.command === "models" ? {} : await mcpServers(p, project, projectTrust);
  if (Object.keys(servers).length) plugins.push(standardMcpTools({ project, servers }));
  const agent = await createAgent({ ...base, project, settings, model: opts.command === "models" ? undefined : model, providers: script ? [script] : [], plugins,
    compaction: !conformance, conformance, pluginHost: opts.acp || !!claude, ...(claude ? { processPlugins: [claude] } : {}) });
  try { return await run(agent); } finally { await agent.close(); }

  async function run(agent: Agent) {
    if (opts.command === "models") {
      for (const m of agent.models()) console.log(`${`${m.provider}/${m.id}`.padEnd(34)} context ${String(m.contextWindow).padStart(7)}  thinking ${(m.thinking ?? (m.reasoning ? ["off", "minimal", "low", "medium", "high", "xhigh"] : ["off"])).join(",")}`);
      return 0;
    }
    if (opts.declaration) { console.log(JSON.stringify(agent.declaration(), null, 2)); return 0; }
    if (opts.acp) { await agent.serveAcp(); return 0; }
    const session = opts.session ? await agent.openSession(opts.session) : await agent.session();
    if (opts.history) { console.log(JSON.stringify(await session.history(), null, 2)); return 0; }
    if (opts.session) {
      if (opts.settings.model !== undefined) await session.setSetting("model", model);
      if (opts.settings.reasoning !== undefined) await session.setSetting("thinking", opts.settings.reasoning);
    }
    return opts.prompt === undefined ? line(agent, session, !!opts.json, !!opts.verbose) : print(session, opts.prompt, !!opts.json, !!opts.verbose);
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
