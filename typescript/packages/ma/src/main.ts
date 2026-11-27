#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createAgent, defaultAcpActor, httpHistory, definePlugin, type Agent, type Approval, type Settings } from "@modular-agent/core";
import { paths, settingsFor, skillsFor, standardSettings, mcpServers, optionalJson, trusted } from "./configuration.js";
import { standardPlugins } from "./compose.js";
import { loadScript } from "./script.js";
import { startTelemetry } from "./telemetry.js";
import { line, print } from "./terminal.js";
import { HELP } from "./help.js";
import { loadPolicy } from "./policy.js";
import { AuthFile, expired } from "./auth.js";
import { claude } from "@modular-agent/claude";
import { chatgpt, grok, resolveClientIdentity, signIn, signOut, type ClientIdentityOptions, type SignInStep } from "@modular-agent/subscription";
import { subscriptionModelOverrides } from "./subscription-model-overrides.js";

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

function modelRef(value: unknown): string | undefined {
  return typeof value === "string" ? value : value && typeof value === "object" && "provider" in value && "id" in value ? `${value.provider}/${value.id}` : undefined;
}

function approvalPolicy(value: unknown, source: string): Approval {
  if (value === "off" || value === "ask" || value === "all" || value === "never") return value;
  throw new Error(source + ": approval must be off, ask, all or never");
}

function parse(argv: string[]) {
  const opts: { command?: string; project: string; runtime: "durable" | "transient"; session?: string; prompt?: string;
    resume?: boolean; resumeOpen?: boolean; verbose?: boolean; json?: boolean; history?: boolean; declaration?: boolean; acp?: boolean; agui?: boolean;
    listen?: string; tokenFile?: string; policy?: string; approval?: Approval;
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
      case "--agui": opts.agui = true; break;
      case "--resume-open": opts.resumeOpen = true; break;
      case "--listen": opts.listen = value(); break;
      case "--token-file": opts.tokenFile = value(); break;
      case "--approval": opts.approval = approvalPolicy(value(), flag); break;
      case "--policy": opts.policy = value(); break;
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
const noModel = "no model is available. Sign in with `ma login chatgpt`, `ma login grok` or `ma login claude`, or pass --model. See `ma models`.";
const labels = { chatgpt: "ChatGPT subscription", grok: "Grok subscription" } as const;

function show(step: SignInStep) {
  if (step.kind === "waiting") { console.error("Waiting for the sign-in to finish..."); return; }
  if (step.kind === "openAndPaste") console.error(`Open this address in a browser, on this machine or any other:\n\n  ${step.url}\n`);
  else console.error(`Open this address in a browser:\n\n  ${step.url}\n\nand enter the code: ${step.code}\n`);
  const { MA_NO_BROWSER, SSH_CONNECTION, SSH_TTY, DISPLAY, WAYLAND_DISPLAY } = process.env;
  if (step.url.startsWith("https://") && MA_NO_BROWSER === undefined &&
      SSH_CONNECTION === undefined && SSH_TTY === undefined && (DISPLAY !== undefined || WAYLAND_DISPLAY !== undefined)) {
    const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [step.url], { stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  }
  if (step.kind === "openAndPaste" && process.stdin.isTTY) {
    console.error("After you sign in, the browser goes to a localhost address. If the browser is on this\n" +
      "machine, that finishes the sign-in. Otherwise the page will not load: copy the whole\n" +
      "address from the browser's address bar and paste it here.\n");
  }
}
async function authCommand(argv: string[], auth: AuthFile, identity: ClientIdentityOptions) {
  const [cmd, provider, ...rest] = argv;
  if (cmd === "auth") {
    for (const vendor of ["chatgpt", "grok"] as const) {
      const login = await auth.login(vendor);
      console.log(`${vendor.padEnd(13)} ${labels[vendor].padEnd(22)} ${!login ? "not signed in" : expired(login) ? "signed in (token will refresh on next use)" : "signed in"}`);
    }
    const p = claude();
    try {
      const readiness = await p.availability();
      const status = readiness.available ? "signed in through Claude Code" : readiness.reason ?? "not signed in";
      console.log(`${"claude".padEnd(13)} ${"Claude subscription".padEnd(22)} ${status}`);
    } finally { p.close(); }
    return 0;
  }
  if (!provider) throw new Error(cmd === "login" ? "which provider? chatgpt, grok or claude" : "which provider?");
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
  if (provider !== "chatgpt" && provider !== "grok") throw new Error(`unknown provider ${provider}${cmd === "login" ? "; use chatgpt, grok or claude" : ""}`);
  if (cmd === "logout") {
    await signOut(provider, auth);
    console.error(`Signed out of ${labels[provider]}.`);
  } else {
    let reader: ReturnType<typeof createInterface> | undefined;
    let lines: AsyncIterator<string> | undefined;
    try {
      await signIn(provider, auth, { ...identity, device: rest[0] === "--device", onStep: show,
        paste: process.stdin.isTTY ? async (signal, problem) => {
          if (problem) console.error(problem);
          if (!reader) {
            reader = createInterface({ input: process.stdin });
            lines = reader[Symbol.asyncIterator]();
            signal.addEventListener("abort", () => reader?.close(), { once: true });
          }
          process.stderr.write("Paste the address (or the code): ");
          return (await lines!.next()).value;
        } : undefined,
      });
    } finally { reader?.close(); }
    console.error(`Signed in to ${labels[provider]} (${provider}).`);
  }
  return 0;
}
async function main(argv: string[]) {
  const identity = { clientIdentity: resolveClientIdentity(process.env.MA_CLIENT_IDENTITY, "MA_CLIENT_IDENTITY") };
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("ma supports only Linux and macOS");
  const p = paths(), auth = new AuthFile(p.config);
  if (["login", "logout", "auth"].includes(argv[0])) return authCommand(argv, auth, identity);
  const opts = parse(argv);
  if (opts.help) { console.log(HELP); return 0; }
  if (opts.version) { console.log(`ma ${version} (typescript)`); return 0; }
  const serving = opts.acp || opts.agui;
  if (opts.agui && !opts.listen) throw new Error("--agui requires --listen");
  if (opts.listen !== undefined && (!serving || !opts.listen || opts.command || opts.declaration)) throw new Error("--listen requires --acp or --agui");
  if (opts.tokenFile !== undefined && !opts.listen) throw new Error("--token-file requires --listen");
  const policy = await loadPolicy(p.config, opts);
  if (serving && (opts.prompt !== undefined || opts.session || opts.trust || opts.resume)) throw new Error("when serving, the client creates sessions and the operator grants trust");
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
  const history = process.env.MODULAR_AGENT_HISTORY_URL ? httpHistory(process.env.MODULAR_AGENT_HISTORY_URL,
    process.env.MODULAR_AGENT_HISTORY_TOKEN_FILE ?? "") : undefined;
  const base = { agentName: "ma", durability: opts.runtime === "durable" ? "durable" as const : "kept" as const, history, dataDir: p.state,
    resourceReservations: policy.resourceReservations };
  const settingsPath = join(p.config, "settings.json");
  const global = await optionalJson(settingsPath);
  const approval = opts.approval ?? (global.approval === undefined ? undefined : approvalPolicy(global.approval, settingsPath));
  const wait = global.approval_wait === undefined ? "live" : global.approval_wait;
  if (wait !== "live" && wait !== "untilDeadline") throw new Error(settingsPath + ": approval_wait must be live or untilDeadline");
  const maxApprovalWaitMs = approval === undefined ? undefined : policy.approvalWaitMaxMs;
  const script = await loadScript(process.env.MODULAR_AGENT_SCRIPT, process.env.MODULAR_AGENT_SCRIPT_LOG);
  let savedModel: string | undefined;
  if (opts.command === "sessions" || opts.session || opts.resume) {
    const index = await createAgent({ ...base, project });
    try {
      const sessions = (await index.sessions({ project: opts.all ? undefined : project }))
        .sort((a, b) => b.updated - a.updated || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (opts.command === "sessions") {
        for (const s of sessions) console.log(`${s.id}  ${s.project}`);
        return 0;
      }
      if (opts.resume && !opts.session) {
        opts.session = sessions[0]?.id;
        if (!opts.session) throw new Error("this folder has no saved session to continue");
      }
      const saved = await index.sessionInfo(opts.session!);
      project = saved.project;
      savedModel = modelRef(saved.settings.model);
    } finally { await index.close(); }
  }
  const inspecting = opts.history || opts.declaration || opts.command === "models";
  const overrides = script || conformance ? {} : await optionalJson(join(p.config, "models.json"));
  const chatgptOverrides = subscriptionModelOverrides("chatgpt", overrides);
  const grokOverrides = subscriptionModelOverrides("grok", overrides);
  const projectMcp = async (cwd: string) => mcpServers(p, cwd, await trusted(p, cwd));
  if (opts.trust) await trusted(p, project, true);
  let defaultModel: string | undefined;
  if (!script && !conformance && !inspecting) {
    if (await auth.login("chatgpt")) defaultModel = "chatgpt/gpt-6.1-sol";
    else if (await auth.login("grok")) defaultModel = "grok/grok-4.7";
  }
  const build = async (cwd: string, saved?: string, projectSettings = true) => {
    const source = projectSettings ? await settingsFor(p, cwd) : global;
    const settings = { ...standardSettings(source), ...opts.settings };
    if (maxApprovalWaitMs !== undefined) settings.approvalWait = opts.prompt === undefined ? wait : "live";
    let model = script ? "scripted/script" : conformance ? "conformance/echo" :
      saved ?? modelRef(settings.model) ?? defaultModel;
    const claudeProvider = !script && !conformance && (model?.startsWith("claude/") || !model && !inspecting || opts.command === "models")
      ? claude({ project: cwd }) : undefined;
    const claudeReady = claudeProvider && (await claudeProvider.availability()).available;
    if (!model && !inspecting && claudeReady) model = "claude/claude-sonnet-5-5";
    if (!model && !inspecting && !serving) throw new Error(noModel);
    if (conformance) settings.modelTools = null;
    delete settings.model;
    const providers = script ? [script] : conformance ? [] : [
      chatgpt({ logins: auth, ...identity, modelOverrides: chatgptOverrides }),
      grok({ logins: auth, ...identity, modelOverrides: grokOverrides }),
    ];
    const plugins = standardPlugins({ paths: p, serving, projectMcp, script });
    if (claudeProvider && (model?.startsWith("claude/") || opts.command === "models")) plugins.push(definePlugin({
      name: "provider.claude", setup: r => r.provider(claudeProvider), stop: claudeProvider.close,
    }));
    else claudeProvider?.close();
    const printMode = !serving && !inspecting && opts.prompt !== undefined;
    return createAgent({ ...base, project: cwd, settings, credentials: auth.credentials(), model: opts.command === "models" ? undefined : model, providers, plugins,
      compaction: !conformance, conformance, questionsOutlastTurns: true, jobReportsStartTurns: true, settingsDuringTurn: "refused",
      approval, approvalCoversNested: approval !== undefined, maxApprovalWaitMs,
      onQuestion: printMode ? async (question, { cancelled }) => {
        if (question.approvalWait) {
          await new Promise<void>(resolve => cancelled.addEventListener("abort", () => resolve(), { once: true }));
          return;
        }
        return { declined: true, reason: "print mode cannot answer questions" };
      } : undefined,
      pluginHost: serving });
  };
  const scoped = opts.listen ? policy.actors?.some(actor => actor.projects !== undefined) : policy.stdio?.projects !== undefined;
  const agent = await build(project, modelRef(opts.settings.model) ?? savedModel, !serving || !scoped);
  try { return await run(agent); } finally { await agent.close(); }

  async function run(agent: Agent) {
    if (opts.command === "models") {
      for (const m of agent.models()) console.log(`${`${m.provider}/${m.id}`.padEnd(34)} context ${String(m.contextWindow).padStart(7)}  thinking ${(m.thinking ?? (m.reasoning ? ["off", "minimal", "low", "medium", "high", "xhigh"] : ["off"])).join(",")}`);
      return 0;
    }
    if (opts.declaration) {
      const { session, tenant, agent: overall } = agent.resourceLimits();
      console.log(JSON.stringify({ ...agent.declaration(), limits: { session, tenant, agent: overall } }, null, 2));
      return 0;
    }
    if (serving) {
      const {resume_open} = global;
      if (resume_open !== undefined && typeof resume_open !== "boolean") throw new Error(`${settingsPath}: resume_open must be a boolean`);
      const acp = { projectMcp, resumeOpen:opts.resumeOpen || resume_open === true,
        onResumeOpen: (id: string, disposition: "resumed" | "skipped") => console.error(`ma: ${disposition} ${id}`),
        compose: (cwd: string, saved?: import("@modular-agent/core").SessionInfo) => {
        if (!scoped && cwd === project && (!saved || agent.models().some(m => `${m.provider}/${m.id}` === modelRef(saved.settings.model)))) {
          return Promise.resolve(agent);
        }
        return build(cwd, modelRef(saved?.settings.model));
      } };
      if (opts.listen) {
        const actors = policy.actors ?? [{ tokenFile: opts.tokenFile!, actor: defaultAcpActor(), clientId: "ma-local" }];
        const server = opts.agui ? await agent.serveAgui({ ...acp, listen: opts.listen, actors: actors.map(a => ({ ...a, clientId: a.clientId! })), acp: !!opts.acp })
          : await agent.serveAcp({ ...acp, listen: opts.listen, actors });
        process.stdout.write(server.url + "\n");
        await new Promise<void>((resolve, reject) => {
          const stop = () => {
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
            void server.close().then(resolve, reject);
          };
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
      } else await agent.serveAcp({ ...acp, ...policy.stdio });
      return 0;
    }
    const session = opts.session ? await agent.openSession(opts.session) : await agent.session();
    if (opts.history) { console.log(JSON.stringify(await session.history(), null, 2)); return 0; }
    if (opts.session) {
      if (opts.settings.model !== undefined) await session.setSetting("model", script ? "scripted/script" : opts.settings.model);
      if (opts.settings.reasoning !== undefined) await session.setSetting("thinking", opts.settings.reasoning);
    }
    if (opts.prompt === undefined) return line(agent, session, !!opts.json, !!opts.verbose);
    if (maxApprovalWaitMs !== undefined && session.settings().approvalWait === "untilDeadline") {
      if ((await session.questions()).some(q => q.approvalWait)) throw new Error("This session has a waiting approval. Answer it before using print mode.");
      await session.setSetting("approvalWait", "live");
      try { return await print(session, opts.prompt, !!opts.json, !!opts.verbose); }
      finally { await session.waitIdle(); await session.setSetting("approvalWait", "untilDeadline"); }
    }
    return print(session, opts.prompt, !!opts.json, !!opts.verbose);
  }
}

async function runFromCli() {
  const stop = await startTelemetry();
  try { return await main(process.argv.slice(2)); } finally { await stop(); }
}

runFromCli().then(code => { process.exitCode = code; }, error => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
