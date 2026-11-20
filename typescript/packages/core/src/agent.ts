import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ALL_AUTHORITY, Harness, parseModel, type CredentialStore, type Runtime, type PluginApi, type WorkingEnvironment, type InterfaceCapability, type HistoryStore, type Plugin as BasePlugin, type Provider as BaseProvider } from "@modular-agent/harness";
import { JsonlHistoryStore } from "@modular-agent/history-jsonl";
import { localEnvironment } from "@modular-agent/env-local";
import { contextCompaction } from "@modular-agent/context-compaction";
import { approval } from "@modular-agent/approval";
import { transientRuntime } from "@modular-agent/runtime-transient";
import { durableRuntime } from "@modular-agent/runtime-durable";
import { startExternalPlugin, pluginSpecsFromEnv, conformanceProvider, conformanceTools } from "@modular-agent/plugin-wire";
import { acpInterface } from "@modular-agent/interface-acp";
import { HistoryArchive, historyClientOptions, historyRelay, historyService, HttpHistoryStore } from "@modular-agent/services";
import { AgentError, checked, messageOf } from "./errors.js";
import { collect, definePlugin, type AgentInterface, type Plugin } from "./plugin.js";
import { type Provider } from "./provider.js";
import type { Tool } from "./tool.js";
import { asWorkingEnvironment, MemoryEnvironment } from "./environment.js";
import { MemoryHistory, memoryArchive, memoryStore } from "./history.js";
import { wirePlugin } from "./serve.js";
import { environmentCredentials } from "./parts.js";
import { standardMcpTools, type McpServerConfig } from "./mcp.js";
import { makeSession, questionOf, submitAnswer, type Session } from "./session.js";
import type { Actor, Declaration, ModelInfo, ModelRef, QuestionHandler, Right, Settings } from "./data.js";

export type Durability = "ephemeral" | "kept" | "durable";
export type Approval = "off" | "ask" | "all" | "never";
export interface ProcessPlugin { command: string[]; env?: Record<string, string>; config?: Settings }
export interface AgentOptions {
  project?: string;
  dataDir?: string;
  durability?: Durability;
  providers?: readonly Provider[];
  tools?: readonly Tool[];
  plugins?: readonly Plugin[];
  processPlugins?: readonly ProcessPlugin[];
  pluginHost?: boolean;
  severalActors?: boolean;
  sessionLimits?: boolean;
  tenants?: Record<string, { rights: Right[]; tokens?: number }>;
  model?: string | ModelRef;
  settings?: Settings;
  approval?: Approval;
  /** Enable the official context compaction plugin and /compact command. */
  compaction?: boolean;
  questionsOutlastTurns?: boolean;
  jobReportsStartTurns?: boolean;
  settingsDuringTurn?: "nextTurn" | "refused";
  /** Offline fixtures for the ACP conformance kit; not for production use. */
  conformance?: boolean;
  onQuestion?: QuestionHandler;
  history?: MemoryHistory | FileHistory | HttpHistory;
  environment?: MemoryEnvironment | WorkingEnvironment;
  runtime?: Runtime;
  credentials?: CredentialStore;
}
export interface SessionOptions { settings?: Settings; tenant?: string; actors?: Actor[] }
export interface ServeAcpOptions {
  /** Trusted operator identity; never taken from a client request. */
  actorId?: string;
  compose?(project: string, saved?: SessionInfo): Promise<Agent>;
  projectSettings?(project: string): Settings | Promise<Settings>;
  projectMcp?(project: string): Record<string, McpServerConfig> | Promise<Record<string, McpServerConfig>>;
  showApproval?: boolean;
}
export interface SessionSummary { id: string; project: string; updated: number; model?: ModelRef; title?: string }
export interface SessionInfo { id: string; project: string; created: number; updated: number; settings: Settings }
const local = { id: "user", kind: "user" as const, authority: ALL_AUTHORITY };

let fileArchive: (store: FileHistory) => HistoryArchive;
let openHttpHistory: (store: HttpHistory) => Promise<HistoryStore>;
let httpUpstream: (store: HttpHistory) => Promise<{ url: string; token: string }>;
export class FileHistory {
  #archive: HistoryArchive;
  constructor(dir: string) { this.#archive = new HistoryArchive(resolve(dir)); }
  static { fileArchive = store => store.#archive; }
}
export class HttpHistory {
  #url: string;
  #tokenFile: string;
  constructor(url: string, tokenFile: string) { this.#url = url; this.#tokenFile = tokenFile; }
  static {
    httpUpstream = async store => historyClientOptions(store.#url, await tokenFrom(store.#tokenFile)) as { url: string; token: string };
    openHttpHistory = async store => {
      const client = new HttpHistoryStore(await httpUpstream(store));
      await client.initialize();
      return client;
    };
  }
}
async function tokenFrom(file: string): Promise<string> {
  const info = await stat(file);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new AgentError("invalid_params", "The token file must be private");
  return (await readFile(file, "utf8")).trim();
}
export const httpHistory = (url: string, tokenFile: string): HttpHistory => new HttpHistory(url, tokenFile);
export async function serveHistory(store: FileHistory | MemoryHistory | HttpHistory, options: { address: string; tokenFile: string; testOnly?: boolean }) {
  return checked(async () => {
    if (!(store instanceof FileHistory || store instanceof MemoryHistory || store instanceof HttpHistory)) {
      const name = (store as object | null)?.constructor?.name ?? typeof store;
      throw new AgentError("not_supported", `History store ${name} does not expose a history binding archive`);
    }
    if (store instanceof MemoryHistory && options.testOnly !== true) {
      throw new AgentError("not_supported", "MemoryHistory cannot commit durably; serve it only with testOnly: true");
    }
    const match = /^127\.0\.0\.1:(\d+)$/.exec(options.address);
    if (!match || Number(match[1]) > 65535) throw new AgentError("invalid_params", "Use a numeric loopback address: 127.0.0.1:port");
    const binding = { port: Number(match[1]), token: await tokenFrom(options.tokenFile) };
    const service = store instanceof HttpHistory
      ? await historyRelay({ ...binding, upstream: await httpUpstream(store) })
      : await historyService({ ...binding, archive: store instanceof FileHistory ? fileArchive(store) : memoryArchive(store) });
    return { url: service.url, close: () => new Promise<void>((resolve, reject) =>
      service.server.close(error => error ? reject(error) : resolve())) };
  });
}
export const fileHistory = (dir: string): FileHistory => new FileHistory(dir);
export const memoryHistory = (): MemoryHistory => new MemoryHistory();

export let createAgent: (options?: AgentOptions) => Promise<Agent>;
export let restart: (agent: Agent) => Promise<Agent>;

export class Agent {
  #open = new Map<string, Session>();
  #opening = new Map<string, Promise<Session>>();
  #handlers = new Map<string, QuestionHandler>();
  #questions = new Map<string, AbortController>();
  #close?: Promise<void>;
  #hostEnabled = false;
  #acp = false;
  #project: string;
  #conformance = false;
  #approval = false;
  #interfaces: AgentInterface[] = [];
  #startedInterfaces: AgentInterface[] = [];
  #api;
  #scratch: string;
  #h: Harness;
  #defaultHandler?: QuestionHandler;
  #portable = false;
  #interruption = new AbortController();
  #rebuild?: () => Promise<Agent>;

  private constructor(harness: Harness, scratch: string, project: string, onQuestion?: QuestionHandler) {
    this.#h = harness;
    this.#api = harness.api("sdk.host");
    this.#scratch = scratch;
    this.#project = project;
    this.#defaultHandler = onQuestion;
  }
  static {
    createAgent = options => Agent.#create(options ?? {});
    restart = async agent => {
      agent.#check();
      if (!agent.#rebuild || agent.#hostEnabled || agent.#acp || agent.#external.size || agent.#startedInterfaces.length) {
        throw new AgentError("not_supported", "restart requires an in-process agent");
      }
      const rebuild = agent.#rebuild;
      agent.#close = (async () => {
        agent.#interruption.abort();
        await Promise.allSettled(agent.#opening.values());
        for (const q of agent.#questions.values()) q.abort();
        await agent.#h.interrupt();
        await rm(agent.#scratch, { recursive: true, force: true });
      })();
      await agent.#close;
      return rebuild();
    };
  }

  static async #create(options: AgentOptions): Promise<Agent> {
    const durability = options.durability ?? "ephemeral";
    if (options.pluginHost === false && options.processPlugins !== undefined) {
      throw new AgentError("invalid_composition", "Loading processPlugins requires a plugin host");
    }
    if (!["ephemeral", "kept", "durable"].includes(durability)) throw new AgentError("invalid_params", "Unknown durability");
    if (options.approval !== undefined && !["off", "ask", "all", "never"].includes(options.approval)) {
      throw new AgentError("invalid_params", "Unknown approval policy");
    }
    const scratch = await checked(() => mkdtemp(join(tmpdir(), "ma-sdk-")), "invalid_composition");
    let agent: Agent | undefined;
    let modelError: AgentError | undefined;
    try {
      const project = await realpath(options.project ?? process.cwd());
      if (!(await stat(project)).isDirectory()) throw new Error("Project must be a directory");
      const home = options.dataDir ? resolve(options.dataDir) : scratch;
      await mkdir(home, { recursive: true });
      const h = new Harness({ project, home, questionsOutlastTurns: options.questionsOutlastTurns ?? false,
        jobReportsStartTurns: options.jobReportsStartTurns ?? false, settingsDuringTurn: options.settingsDuringTurn ?? "nextTurn",
        rejectUnknownModel: true, tenants: options.tenants ?? (options.conformance ? undefined : null) });
      agent = new Agent(h, scratch, project, options.onQuestion);
      agent.#authority = { severalActors: options.severalActors ?? false, sessionLimits: options.sessionLimits ?? false, tenants: options.tenants !== undefined };
      agent.#conformance = options.conformance ?? false;
      agent.#approval = options.approval !== undefined || agent.#conformance;
      const settings = structuredClone(options.settings ?? {});
      if (options.approval !== undefined) settings.approval = options.approval;
      const history = options.history ?? (durability === "ephemeral" || !options.dataDir ? memoryHistory() : undefined);
      agent.#rebuild = () => Agent.#create({ ...options, history });
      const store = history instanceof FileHistory ? fileArchive(history).store()
        : history instanceof HttpHistory ? await openHttpHistory(history)
        : history ? memoryStore(history) : new JsonlHistoryStore(join(home, "history"));
      await store.list();
      agent.#portable = !(history instanceof MemoryHistory);
      const core: BasePlugin = { name: "sdk.core", setup(api) {
        api.provide("configuration", { get: (key: string) => key === "session" ? settings : undefined, plugin: () => ({}) });
        api.provide("history-store", store);
        api.provide("credential-store", options.credentials ?? environmentCredentials());
      } };
      await agent.#load(core);
      let defaultEnvironment: WorkingEnvironment | undefined;
      if (options.environment) {
        const env = options.environment instanceof MemoryEnvironment
          ? { ...asWorkingEnvironment(options.environment), cwd: project } : options.environment;
        // The public memory environment is rooted at its virtual root, not the host project.
        await agent.#load({ name: "sdk.environment", setup: api => api.provide("working-environment", env) });
      } else {
        await agent.#load(localEnvironment({ cwd: project }));
        defaultEnvironment = h.use<WorkingEnvironment>("working-environment");
      }
      const explicitRuntime = options.runtime;
      await agent.#load(explicitRuntime ? { name: "sdk.runtime", setup: api => api.provide("runtime", explicitRuntime) }
        : durability === "durable" ? durableRuntime() : transientRuntime());
      await agent.#load(agent.#localInterface());
      if (options.approval !== undefined || options.conformance) await agent.#load(approval({ policy: options.approval ?? "off" }));
      if (options.compaction) await agent.#load(contextCompaction());
      if (options.conformance) {
        await agent.#load(conformanceProvider());
      }
      for (const p of options.providers ?? []) await agent.#plugin(definePlugin({ name: `provider.${p.id}`, setup: r => r.provider(p) }));
      for (const t of options.tools ?? []) await agent.#plugin(definePlugin({ name: `tool.${t.definition.name}`, tools: [t] }));
      for (const p of options.plugins ?? []) await agent.#plugin(p);
      if (options.conformance) await agent.#load(conformanceTools(false, agent.#api.tools().map(t => t.name)));
      agent.#hostEnabled = options.pluginHost ?? options.processPlugins !== undefined;
      await agent.#loadProcesses([...options.processPlugins ?? [], ...(agent.#hostEnabled ? pluginSpecsFromEnv() : [])]);
      const effectiveRuntime = h.use<Runtime>("runtime");
      // The ACP kit substitutes its own Runtime to exercise the remote bridge.
      if (durability === "durable" && effectiveRuntime?.supports.continuesAfterRestart !== true &&
          !(options.conformance && agent.#external.has("runtime"))) {
        throw new Error("Durable agents need a Runtime that continues after restart");
      }
      const effectiveStore = h.use<HistoryStore>("history-store");
      const persistent = effectiveStore === store
        ? !(history instanceof MemoryHistory)
        : effectiveStore?.supports.persistent === true || effectiveStore?.supports.portableSessions === true;
      if ((durability !== "ephemeral" || effectiveRuntime?.supports.continuesAfterRestart === true) && !persistent) {
        throw new Error("Kept history or a durable Runtime needs a persistent history store");
      }
      if (effectiveStore !== store) {
        await effectiveStore?.list();
        agent.#portable = effectiveStore?.supports.portableSessions === true;
      }
      const env = h.use<WorkingEnvironment>("working-environment");
      if (!options.dataDir && (env?.requiresDataDir || effectiveRuntime?.supports.requiresDataDir === true ||
          (durability !== "ephemeral" && defaultEnvironment && env === defaultEnvironment))) {
        throw new Error("Local recovery bookkeeping requires dataDir");
      }
      const models = agent.models();
      const selected = options.model ?? settings.model;
      if (selected !== undefined) {
        const ref = parseModel(selected);
        if (!ref || !models.some(m => m.provider === ref.provider && m.id === ref.id)) {
          throw modelError = new AgentError("invalid_request", "The selected model is not offered");
        }
        settings.model = ref;
      } else if (models.length === 1) settings.model = { provider: models[0].provider, id: models[0].id };
      for (const part of agent.#interfaces) {
        agent.#startedInterfaces.push(part);
        await part.start(agent);
      }
      return agent;
    } catch (error) {
      if (agent) await agent.close().catch(() => {});
      else await rm(scratch, { recursive: true, force: true });
      if ((modelError !== undefined && error === modelError) || error instanceof AgentError && error.code === "not_supported") throw error;
      throw new AgentError("invalid_composition", messageOf(error), undefined, error);
    }
  }

  async #load(plugin: BasePlugin) {
    if (this.#h.plugins().includes(plugin.name)) throw new Error(`Duplicate plugin ${plugin.name}`);
    const at = this.#h.problems.length;
    await this.#h.load([plugin]);
    if (!this.#h.plugins().includes(plugin.name)) throw new Error(this.#h.problems[at]?.error ?? `Plugin ${plugin.name} was refused`);
    if (this.#h.problems.length > at) throw new Error(this.#h.problems[at].error);
  }
  async #plugin(plugin: Plugin) {
    if (!plugin.name || this.#h.plugins().includes(plugin.name)) throw new Error(`Invalid or duplicate plugin ${plugin.name}`);
    const wire = wirePlugin(plugin, this.#h);
    if (wire) { await this.#loadExternal(await wire); return; }
    let loaded = false;
    try {
      const { items, base, interfaces } = await collect(plugin, plugin.config ?? {});
      const replaces = plugin.replaces ?? [];
      for (const key of items) {
        if (this.#h.hasItem(key) && !replaces.includes(key)) throw new Error(`${key} is already registered`);
      }
      for (const key of replaces) this.#h.replacements.set(key, plugin.name);
      await this.#load(base);
      this.#interfaces.push(...interfaces);
      loaded = true;
    } finally {
      if (!loaded && !this.#h.plugins().includes(plugin.name)) await Promise.resolve(plugin.stop?.()).catch(() => {});
    }
  }
  #external = new Set<string>();
  #authority = { severalActors: false, sessionLimits: false, tenants: false };
  async #loadProcesses(specs: ProcessPlugin[]) {
    for (const spec of specs) {
      if (!spec.command?.length || spec.command.some(a => typeof a !== "string" || !a || a.includes("\0"))) {
        throw new Error("Process plugin needs a nonempty command vector");
      }
      await this.#loadExternal(await startExternalPlugin(spec, this.#h));
    }
  }
  async #loadExternal(ext: Awaited<ReturnType<typeof startExternalPlugin>>) {
    const refusal = ext.refusal(this.#h, this.#external);
    if (refusal) {
      await ext.stop("refused", refusal);
      throw new Error(refusal);
    }
    try {
      for (const key of ext.replacements) {
        if (!(ext.registration.replaces ?? []).includes(key) && this.#h.hasItem(key)) throw new Error(`${key} is already registered`);
        this.#h.replacements.set(key, ext.registration.name);
      }
      await this.#load(ext.plugin);
      for (const key of ext.items) this.#external.add(key);
    } catch (error) {
      if (!this.#h.plugins().includes(ext.plugin.name)) await ext.stop("refused", messageOf(error));
      throw error;
    }
  }
  #localInterface(): BasePlugin {
    return { name: "sdk.local", setup: api => {
      const capability: InterfaceCapability = {
        id: "sdk.local", actorId: local.id,
        present: id => !this.#acp && !!(this.#handlers.get(id) ?? this.#defaultHandler),
        onInputRequest: request => {
          const handler = this.#handlers.get(request.sessionId) ?? this.#defaultHandler;
          if (!handler) return;
          const { id, sessionId } = request;
          if (!api.session(sessionId).actors.find(a => a.id === local.id)?.authority.includes(request.kind === "approval" ? "approve" : "answer") ||
              request.answerers.length && !request.answerers.includes(local.id)) return;
          const controller = new AbortController();
          this.#questions.set(request.id, controller);
          const q = questionOf(api, request);
          void Promise.resolve().then(() => handler(q, { sessionId, actorId: local.id, cancelled: controller.signal }))
            .catch(() => undefined).then(async answer => {
              if (!controller.signal.aborted) await submitAnswer(api, request, local.id, answer ?? "decline");
            }).catch(async () => {
              if (!controller.signal.aborted) await submitAnswer(api, request, local.id, "decline").catch(() => {});
            }).finally(() => { this.#questions.delete(id); });
        },
        onInputRequestClosed: id => this.#questions.get(id)?.abort(),
      };
      api.provide("interface", capability);
    } };
  }
  #check() { if (this.#close) throw new AgentError("not_open", "Agent is closed"); }
  #session(id: string): Session {
    const existing = this.#open.get(id);
    if (existing) return existing;
    const s = makeSession(id, this.#api, {
      interruption: this.#interruption.signal,
      enabled: this.#authority,
      isOpen: () => this.#open.has(id),
      fork: async entry => {
        this.#check();
        const at = entry ?? this.#api.session(id).position;
        if (!at || !this.#api.history(id, { all: true }).some(e => e.id === at)) throw new AgentError("not_found", "No entry to fork");
        const fork = await checked(() => this.#api.forkSession(id, at), "busy");
        return this.openSession(fork);
      },
      close: async (actor, delegatedBy) => {
        await checked(() => this.#api.closeSession(id, actor, delegatedBy));
        this.#open.delete(id);
        this.#handlers.delete(id);
      },
      handler: handler => {
        if (handler) this.#handlers.set(id, handler);
        else this.#handlers.delete(id);
        this.#api.presenceChanged(id);
      },
    });
    this.#open.set(id, s);
    return s;
  }
  async session(options: SessionOptions = {}): Promise<Session> {
    this.#check();
    if (options.tenant !== undefined && !this.#authority.tenants) throw new AgentError("not_supported", "Tenants are disabled");
    if (options.actors?.length && !this.#authority.severalActors) throw new AgentError("not_supported", "Several actors are disabled");
    const session = await checked(async () => this.#session(await this.#h.startSession({
      actor: local, settings: structuredClone(options.settings), tenant: options.tenant,
    })));
    try {
      for (const actor of options.actors ?? []) await session.join(actor);
      return session;
    } catch (error) { await session.close().catch(() => {}); throw error; }
  }
  async openSession(id: string): Promise<Session> {
    this.#check();
    if (typeof id !== "string" || !id || !/^[\w-]+$/.test(id)) throw new AgentError("invalid_params", "Invalid session id");
    let pending = this.#opening.get(id);
    if (!pending) {
      pending = checked(async () => {
        await this.#h.openSession(id, local);
        return this.#session(id);
      });
      this.#opening.set(id, pending);
    }
    let session: Session;
    try { session = await pending; }
    finally { if (this.#opening.get(id) === pending) this.#opening.delete(id); }
    await checked(() => this.#api.waitForIdle(id));
    return session;
  }
  async sessions(filter?: { project?: string }): Promise<SessionSummary[]> {
    this.#check();
    return checked(async () => {
      const stored = await this.#api.listSessions(filter?.project ? await realpath(filter.project) : null);
      return Promise.all(stored.map(async ({ id }) => {
        const { project, settings, updated } = await this.sessionInfo(id);
        return { id, project, updated, model: parseModel(settings.model), title: typeof settings.title === "string" ? settings.title : undefined };
      }));
    });
  }
  /** Read saved session metadata without opening it or starting recovery. */
  async sessionInfo(id: string): Promise<SessionInfo> {
    this.#check();
    if (!/^[\w-]+$/.test(id)) throw new AgentError("invalid_params", "Invalid session id");
    return checked(async () => {
      const store = this.#h.use<HistoryStore>("history-store")!;
      const { meta, entries } = await store.load(id);
      const settings: Settings = {};
      for (const entry of entries) if (!entry.erased && entry.kind === "setting") {
        const change = entry.data as { key: string; value: unknown };
        settings[change.key] = change.value;
      }
      return { ...meta, updated: entries.at(-1)?.time ?? meta.created, settings };
    });
  }
  /** Refresh served catalogs; /1 has a query, not a catalog-change notification. */
  async refreshModels(): Promise<ModelInfo[]> {
    this.#check();
    await checked(() => Promise.all(this.#h.useAll<BaseProvider>("provider").map(p => p.refreshModels?.())));
    return this.models();
  }
  onModelsChanged(handler: () => void): () => void {
    this.#check();
    const off = this.#h.useAll<BaseProvider>("provider").flatMap(p => p.onChange ? [p.onChange(handler)] : []);
    return () => { for (const remove of off) remove(); };
  }
  models(): ModelInfo[] {
    this.#check();
    return structuredClone(this.#h.useAll<BaseProvider>("provider").flatMap(p => p.models()));
  }
  declaration(): Declaration {
    this.#check();
    const base = this.#api.declaration();
    const providers = this.#h.useAll<BaseProvider>("provider");
    return {
      ...base,
      keepsStateAtProvider: providers.some(p => p.supports.keepsState === true),
      runsToolsAtProvider: providers.some(p => p.supports.runsTools === true),
      liveSessions: providers.some(p => p.supports.liveSessions === true),
      portableSessions: this.#portable && !providers.some(p => p.supports.runsTools === true || p.supports.keepsState === true),
      nestedToolCalls: base.nestedToolCalls === true, lateAnswersStartTurns: base.questionsOutlastTurns === true,
      ...this.#authority, holdsOutput: false, mixedActorInput: "refused",
      startsTurnsUnasked: base.startsTurnsUnasked === "never" ? "never" : "jobReports",
    };
  }
  async serveAcp(options: ServeAcpOptions = {}): Promise<void> {
    this.#check();
    if (this.#acp || this.#open.size || this.#opening.size) throw new AgentError("busy", "ACP must start before opening sessions");
    this.#acp = true;
    const agents = new Map<string, Promise<Agent>>();
    const sessions = new Map<string, Agent>();
    const attachments = new Map<PluginApi, ReturnType<typeof standardMcpTools>>();
    const installMcp = async (agent: Agent) => {
      const mcp = standardMcpTools({ servers: async project => await options.projectMcp?.(project) ?? {} });
      await agent.#plugin(mcp);
      attachments.set(agent.#api, mcp);
    };
    try {
      const binding = acpInterface({
        actorId: options.actorId ?? process.env.MODULAR_AGENT_ACTOR,
        showApproval: options.showApproval ?? this.#approval,
        declaration: id => (id && sessions.get(id) || this).declaration(),
        projectSettings: options.projectSettings ? async project => await options.projectSettings!(project) : undefined,
        project: async (cwd, id) => {
          const project = await checked(() => realpath(cwd), "invalid_params");
          if (!(await stat(project)).isDirectory()) throw new AgentError("invalid_params", "Project must be a directory");
          const saved = id && !sessions.has(id) ? await this.sessionInfo(id) : undefined;
          if (saved && saved.project !== project || !options.compose && project !== this.#project) {
            throw new AgentError("invalid_params", "Session belongs to a different project");
          }
          const ref = parseModel(saved?.settings.model);
          const key = JSON.stringify([project, ref?.provider]);
          let selected = id ? sessions.get(id) : undefined;
          if (!selected && options.compose) {
            let pending = agents.get(key);
            if (!pending) {
              pending = (async () => {
                const agent = await options.compose!(project, saved);
                if (agent === this) return agent;
                try {
                  if (agent.#project !== project || agent.#open.size || agent.#acp) throw new AgentError("invalid_composition", "Factory must return a fresh agent for this project");
                  agent.#acp = true;
                  await installMcp(agent);
                  await agent.#load({ name: binding.name, setup(api) {
                    binding.acp.attach(api, false);
                    api.provide("interface", binding.acp);
                  } });
                  return agent;
                } catch (error) { await agent.close(); throw error; }
              })();
              agents.set(key, pending);
              void pending.catch(() => { if (agents.get(key) === pending) agents.delete(key); });
            }
            selected = await pending;
          }
          selected ??= this;
          if (id) sessions.set(id, selected);
          return { api: selected.#api, cwd: project };
        },
        async attachMcp(id, project, servers, api) {
          if (Object.values(servers).some(s => "command" in s && !isAbsolute(s.command))) {
            throw new AgentError("invalid_params", "ACP MCP executable paths must be absolute");
          }
          await attachments.get(api)?.attach(id, project, servers);
        },
      });
      await installMcp(this);
      await this.#load(binding);
      await binding.acp.serveStdio();
    } catch (error) { throw new AgentError("invalid_composition", messageOf(error), undefined, error); }
    finally {
      await Promise.allSettled([...agents.values()].map(async pending => {
        const agent = await pending;
        if (agent !== this) await agent.close();
      }));
      await this.close();
    }
  }
  close(): Promise<void> {
    return this.#close ??= (async () => {
      await Promise.allSettled(this.#opening.values());
      for (const s of [...this.#open.values()]) await s.close().catch(() => {});
      for (const part of this.#startedInterfaces.reverse()) await Promise.resolve().then(() => part.stop?.()).catch(() => {});
      await this.#h.stop();
      await rm(this.#scratch, { recursive: true, force: true });
    })();
  }
}
