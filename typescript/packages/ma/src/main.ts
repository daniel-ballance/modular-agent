#!/usr/bin/env node
import { realpath, stat } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createAgent, httpHistory, type Agent, type ProcessPlugin, type Settings } from "@modular-agent/core";
import { standardFileTools } from "@modular-agent/tools-files/sdk";
import { standardMcpTools } from "@modular-agent/tools-mcp/sdk";
import { paths, settingsFor, skillsFor, standardSettings, mcpServers, optionalJson, trusted, type Paths } from "./configuration.js";
import { standardPrompt } from "./prompt.js";
import { codemode } from "./codemode.js";
import { loadScript } from "./script.js";
import { line, print } from "./terminal.js";
import { HELP } from "./help.js";
import { AuthFile, expired } from "./auth.js";
import { labels, oauth, vendors, type Step, type Vendor } from "./oauth.js";
import { responses } from "./responses.js";

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
async function claudeLaunch(p: Paths): Promise<ProcessPlugin | undefined> {
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

function claudeSignedIn() {
  return spawnSync("claude", ["auth", "status"], { stdio: "ignore", timeout: 10_000 });
}
function show(step: Step) {
  if (step.kind === "note") { console.error(step.message); return; }
  if (step.kind === "open-and-paste") console.error(`Open this address in a browser, on this machine or any other:\n\n  ${step.address}\n`);
  else if (step.kind === "code") console.error(`Open this address in a browser:\n\n  ${step.address}\n\nand enter the code: ${step.code}\n`);
  else console.error(`Open this address in a browser to sign in:\n\n  ${step.address}\n`);
  const { MA_NO_BROWSER, SSH_CONNECTION, SSH_TTY, DISPLAY, WAYLAND_DISPLAY } = process.env;
  if (step.address.startsWith("https://") && MA_NO_BROWSER === undefined &&
      SSH_CONNECTION === undefined && SSH_TTY === undefined && (DISPLAY !== undefined || WAYLAND_DISPLAY !== undefined)) {
    const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [step.address], { stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  }
  if (step.kind === "open-and-paste") {
    console.error("After you sign in, the browser goes to a localhost address. If the browser is on this\n" +
      "machine, that finishes the sign-in. Otherwise the page will not load: copy the whole\n" +
      "address from the browser's address bar and paste it here.\n");
    process.stderr.write("Paste the address (or the code): ");
  } else console.error("Waiting for the sign-in to finish...");
}
async function authCommand(argv: string[], p: Paths, auth: AuthFile) {
  const [cmd, provider, ...rest] = argv;
  const isVendor = (name: string): name is Vendor => (vendors as readonly string[]).includes(name);
  if (cmd === "auth") {
    for (const vendor of vendors) {
      const login = await auth.login(vendor);
      console.log(`${vendor.padEnd(13)} ${labels[vendor].padEnd(22)} ${!login ? "not signed in" : expired(login) ? "signed in (token will refresh on next use)" : "signed in"}`);
    }
    const claude = claudeSignedIn();
    console.log(`${"claude".padEnd(13)} ${"Claude subscription".padEnd(22)} ${claude.error ? "Claude Code is not installed" : claude.status === 0 ? "signed in through Claude Code" : "not signed in (run `ma login claude`)"}`);
    if (!await claudeLaunch(p)) console.log("              the Claude sidecar is not installed (build typescript/sidecars/claude)");
    return 0;
  }
  if (!provider) throw new Error(cmd === "login" ? "which provider? openai-codex, xai or claude" : "which provider?");
  const bad = rest.find((a, i) => cmd !== "login" || a !== "--device" || i > 0);
  if (bad) throw new Error(`unknown argument ${bad}`);
  if (provider === "claude") {
    if (cmd === "logout") throw new Error("Claude Code holds that sign-in; run `claude auth logout`");
    console.error("Claude signs in through Claude Code. Running `claude auth login`.");
    const result = spawnSync("claude", ["auth", "login"], { stdio: "inherit" });
    if (result.error) throw new Error(`could not run claude: ${result.error.message}. Install Claude Code, then run \`claude auth login\`.`);
    if (result.status !== 0) throw new Error("claude auth login did not complete");
    return 0;
  }
  if (!isVendor(provider)) throw new Error(`unknown provider ${provider}${cmd === "login" ? "; use openai-codex, xai or claude" : ""}`);
  if (cmd === "logout") { await auth.setLogin(provider); console.error(`Signed out of ${labels[provider]}.`); }
  else {
    const pasted = process.stdin.isTTY ? (onLine: (line: string) => void) => {
      const reader = createInterface({ input: process.stdin });
      reader.on("line", onLine);
      return () => { reader.off("line", onLine); reader.close(); };
    } : undefined;
    await auth.setLogin(provider, await oauth().login(provider, rest[0] === "--device", show, pasted));
    console.error(`Signed in to ${labels[provider]} (${provider}).`);
  }
  return 0;
}
async function main(argv: string[]) {
  const p = paths(), auth = new AuthFile(p.config);
  if (["login", "logout", "auth"].includes(argv[0])) return authCommand(argv, p, auth);
  const opts = parse(argv);
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
  const conformance = opts.acp && process.env.MODULAR_AGENT_CONFORMANCE === "1";
  const history = process.env.MODULAR_AGENT_HISTORY_URL ? httpHistory(process.env.MODULAR_AGENT_HISTORY_URL, process.env.MODULAR_AGENT_HISTORY_TOKEN_FILE ?? "") : undefined;
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
        sessions.sort((a, b) => b.updated - a.updated);
        opts.session = sessions[0]?.id;
        if (!opts.session) throw new Error("this folder has no saved session to continue");
      }
      const saved = await index.sessionInfo(opts.session!);
      project = saved.project;
      savedModel = modelRef(saved.settings.model);
    } finally { await index.close(); }
  }
  const inspecting = opts.history || opts.declaration || opts.command === "models";
  const launch = !script && !conformance ? await claudeLaunch(p) : undefined;
  const overrides = script || conformance ? {} : await optionalJson(join(p.config, "models.json"));
  const projectMcp = async (cwd: string) => mcpServers(p, cwd, await trusted(p, cwd));
  if (opts.trust) await trusted(p, project, true);
  let defaultModel: string | undefined;
  if (!script && !conformance && !inspecting) {
    if (await auth.login("openai-codex")) defaultModel = "openai-codex/gpt-6.1-sol";
    else if (await auth.login("xai")) defaultModel = "xai/grok-4.7";
  }
  const build = async (cwd: string, saved?: string) => {
    const settings = { ...standardSettings(await settingsFor(p, cwd)), ...opts.settings };
    let model = script ? "scripted/script" : conformance ? "conformance/echo" :
      saved ?? modelRef(settings.model) ?? defaultModel;
    if (!model && !inspecting && launch && claudeSignedIn().status === 0) model = "claude/claude-sonnet-5-5";
    if (!model && !inspecting && !opts.acp) throw new Error(noModel);
    if (conformance) settings.modelTools = null;
    delete settings.model;
    const claude = model?.startsWith("claude/") || opts.command === "models" ? launch : undefined;
    if (model?.startsWith("claude/") && !claude) throw new Error("the Claude sidecar is not installed; build typescript/sidecars/claude or set MODULAR_AGENT_CLAUDE_SIDECAR");
    const providers = script ? [script] : conformance ? [] : vendors.map(v => responses(v, auth, overrides));
    const plugins = [standardFileTools({ spill: join(p.state, "output") }), codemode(), standardPrompt(p)];
    if (!opts.acp) plugins.push(standardMcpTools({ servers: projectMcp }));
    return createAgent({ ...base, project: cwd, settings, credentials: auth.credentials(), model: opts.command === "models" ? undefined : model, providers, plugins,
      compaction: !conformance, conformance, questionsOutlastTurns: true, jobReportsStartTurns: true, settingsDuringTurn: "refused",
      pluginHost: opts.acp || !!claude, ...(claude ? { processPlugins: [claude] } : {}) });
  };
  const agent = await build(project, modelRef(opts.settings.model) ?? savedModel);
  try { return await run(agent); } finally { await agent.close(); }

  async function run(agent: Agent) {
    if (opts.command === "models") {
      for (const m of agent.models()) console.log(`${`${m.provider}/${m.id}`.padEnd(34)} context ${String(m.contextWindow).padStart(7)}  thinking ${(m.thinking ?? (m.reasoning ? ["off", "minimal", "low", "medium", "high", "xhigh"] : ["off"])).join(",")}`);
      return 0;
    }
    if (opts.declaration) { console.log(JSON.stringify(agent.declaration(), null, 2)); return 0; }
    if (opts.acp) {
      await agent.serveAcp({ projectMcp, compose: (cwd, saved) => {
        if (cwd === project && (!saved || agent.models().some(m => `${m.provider}/${m.id}` === modelRef(saved.settings.model)))) {
          return Promise.resolve(agent);
        }
        return build(cwd, modelRef(saved?.settings.model));
      } });
      return 0;
    }
    const session = opts.session ? await agent.openSession(opts.session) : await agent.session();
    if (opts.history) { console.log(JSON.stringify(await session.history(), null, 2)); return 0; }
    if (opts.session) {
      if (opts.settings.model !== undefined) await session.setSetting("model", script ? "scripted/script" : opts.settings.model);
      if (opts.settings.reasoning !== undefined) await session.setSetting("thinking", opts.settings.reasoning);
    }
    return opts.prompt === undefined ? line(agent, session, !!opts.json, !!opts.verbose) : print(session, opts.prompt, !!opts.json, !!opts.verbose);
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
