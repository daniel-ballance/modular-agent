import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ALL_AUTHORITY, Harness, parseModel, type CredentialStore, type Runtime, type ListingViewer, type SessionSummary, type InterfaceToolSource, type InterfaceToolConnection, type InterfaceToolConnectionOptions as HarnessToolConnection, type PluginApi, type WorkingEnvironment, type InterfaceCapability, type HistoryStore, type Plugin as BasePlugin, type Provider as BaseProvider, type ReservationOptions, type ReservationLimits } from "@modular-agent/harness";
import { JsonlHistoryStore } from "@modular-agent/history-jsonl";
import { localEnvironment } from "@modular-agent/env-local";
import { contextCompaction } from "@modular-agent/context-compaction";
import { approval } from "@modular-agent/approval";
import { transientRuntime } from "@modular-agent/runtime-transient";
import { durableRuntime } from "@modular-agent/runtime-durable";
import { startExternalPlugin, startPluginService, pluginSpecsFromEnv, conformanceProvider, conformanceTools, ACP_PROTOCOL, listenWebSocket, receiveMessages, type ListenOptions, type ServiceServer, type ExternalPluginSpec, type PluginSpec, type ServicePluginSpec } from "@modular-agent/plugin-wire";
import { acpInterface, localAcpActor, unchangedAcpApproval } from "@modular-agent/interface-acp";
import { HistoryArchive, historyClientOptions, historyRelay, historyService, HttpHistoryStore, type HistoryServiceStore } from "@modular-agent/services";
import { interrupt, messages, pending as pendingFrontend, reply as aguiReply, type Principal } from "./agui-view.js";
import { createHash } from "node:crypto";
import { AguiBinding, type AguiProjectionOptions, type Target } from "./agui.js";
import { fail, same } from "./agui-wire.js";
import { AgentError, checked, messageOf } from "./errors.js";
import { collect, definePlugin, type AgentInterface, type Plugin } from "./plugin.js";
import { type Provider } from "./provider.js";
import type { Tool } from "./tool.js";
import { asWorkingEnvironment, MemoryEnvironment } from "./environment.js";
import { MemoryHistory, memoryArchive, memoryStore } from "./history.js";
import { wirePlugin } from "./serve.js";
import { environmentCredentials } from "./parts.js";
import { standardMcpTools, type McpServerConfig } from "./mcp.js";
import { exactLocalApproval, makeSession, questionOf, submitAnswer, type Session } from "./session.js";
import type { Actor, Declaration, ModelInfo, ModelRef, QuestionHandler, Right, Settings } from "./data.js";

export type Durability = "ephemeral" | "kept" | "durable";
export type Approval = "off" | "ask" | "all" | "never";
export type ProcessPlugin = ExternalPluginSpec;
export type ServicePlugin = ServicePluginSpec;
export interface AgentOptions {
  agentName?: string;
  project?: string;
  dataDir?: string;
  durability?: Durability;
  providers?: readonly Provider[];
  tools?: readonly Tool[];
  interfaceTools?: readonly InterfaceToolSource[];
  plugins?: readonly Plugin[];
  processPlugins?: readonly ProcessPlugin[];
  servicePlugins?: readonly ServicePlugin[];
  pluginHost?: boolean;
  severalActors?: boolean;
  sessionLimits?: boolean;
  tenants?: Record<string, { rights: Right[]; tokens?: number }>;
  model?: string | ModelRef;
  settings?: Settings;
  approval?: Approval;
  /** An explicit allow for a top-level call also approves its nested calls in this dispatch. */
  approvalCoversNested?: boolean;
  resourceReservations?: ReservationOptions;
  /** Enable the official context compaction plugin and /compact command. */
  compaction?: boolean;
  questionsOutlastTurns?: boolean;
  maxApprovalWaitMs?: number;
  jobReportsStartTurns?: boolean;
  settingsDuringTurn?: "nextTurn" | "refused";
  /** Former Provider ids to resolve when reopening saved model settings and attempts. */
  reopenModelAliases?: Readonly<Record<string, string>>;
  /** Offline fixtures for the ACP conformance kit; not for production use. */
  conformance?: boolean;
  onQuestion?: QuestionHandler;
  history?: MemoryHistory | FileHistory | HttpHistory;
  environment?: MemoryEnvironment | WorkingEnvironment;
  runtime?: Runtime;
  credentials?: CredentialStore;
}
export interface InterfaceToolConnectionOptions extends Omit<HarnessToolConnection, "actor"> {
  /** The principal authenticated by the embedding binding, not a claim in a report. */
  actor: Actor;
}
export interface SessionOptions { settings?: Settings; tenant?: string; actors?: Actor[] }
export interface ServeAcpOptions {
  /** Trusted operator identity; never taken from a client request. */
  actorId?: string;
  actor?: Actor;
  projects?: readonly string[];
  tenants?: readonly (string | null)[];
  rights?: readonly Right[];
  represents?: readonly string[];
  compose?(project: string, saved?: SessionInfo): Promise<Agent>;
  /** Start ordinary recovery before listening. Report only the session ID and disposition. */
  resumeOpen?: boolean;
  onResumeOpen?(sessionId: string, disposition: "resumed" | "skipped"): void;
  projectSettings?(project: string): Settings | Promise<Settings>;
  projectMcp?(project: string): Record<string, McpServerConfig> | Promise<Record<string, McpServerConfig>>;
  showApproval?: boolean;
  /** Permit client-supplied MCP servers. Defaults to stdio only. */
  hostMcpServers?: boolean;
  /** Accept trace context from the stdio peer (default true). */
  traceTrusted?: boolean;
}
export function defaultAcpActor(): Actor {
  const { id, kind, authority } = localAcpActor();
  return { id, kind, rights: authority };
}
export interface AcpActorToken {
  tokenFile: string;
  /** Opt this authenticated network peer into trace context. */
  traceTrusted?: boolean;
  actor: Actor;
  tenants?: readonly (string | null)[];
  projects?: readonly string[];
  represents?: readonly string[];
}
export interface ServeAcpServiceOptions extends ServeAcpOptions, ListenOptions {
  actors: readonly AcpActorToken[];
  controlTimeoutMs?: number;
}
export interface ServeAguiOptions extends ServeAcpServiceOptions, AguiProjectionOptions {
  actors: readonly (AcpActorToken & { clientId: string })[];
  acp?: boolean; tenant?: string; origins?: readonly string[];
}
export type SessionViewer = Omit<ListingViewer, "actor" | "allowJoin"> & { actor: Actor };
export interface SessionListEntry { id: string; project: string; updated: number; model?: ModelRef; title?: string }
export interface SessionInfo { id: string; project: string; created: number; updated: number; settings: Settings; tenant?: string }
const local = { id: "user", kind: "user" as const, authority: ALL_AUTHORITY };

let fileArchive: (store: FileHistory) => HistoryArchive;
let openHttpHistory: (store: HttpHistory) => Promise<HistoryStore>;
let httpUpstream: (store: HttpHistory) => Promise<{ url: string; token: string }>;
export class FileHistory {
  #archive: HistoryArchive;
  constructor(dir: string, options?: { pendingErasureDir?: string }) {
    this.#archive = new HistoryArchive(resolve(dir), options?.pendingErasureDir === undefined ? undefined : resolve(options.pendingErasureDir));
  }
  static { fileArchive = store => store.#archive; }
}
export class HttpHistory {
  #url: string;
  #tokenFile: string;
  constructor(url: string, tokenFile: string) {
    this.#url = url;
    this.#tokenFile = tokenFile;
  }
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
const historyMethods = ["create", "list", "read", "acquire", "renew", "release", "append", "erase"] as const;

export async function serveHistory(store: FileHistory | MemoryHistory | HttpHistory | HistoryServiceStore,
  options: { address: string; tokenFile: string; leaseTtl?: number; testOnly?: boolean }) {
  return checked(async () => {
    const { leaseTtl } = options;
    if (leaseTtl !== undefined && (!Number.isSafeInteger(leaseTtl) || leaseTtl < 1)) {
      throw new AgentError("invalid_params", "leaseTtl must be a whole number of milliseconds, at least 1");
    }
    const builtIn = store instanceof FileHistory || store instanceof MemoryHistory || store instanceof HttpHistory;
    if (!builtIn && (!store || !historyMethods.every(name => typeof store[name] === "function"))) {
      const name = (store as object | null)?.constructor?.name ?? typeof store;
      throw new AgentError("not_supported", `History store ${name} does not implement HistoryServiceStore`);
    }
    if (!builtIn && (!Number.isSafeInteger(store.ttlMs) || store.ttlMs < 1 ||
        (store.retention != null && (!Number.isSafeInteger(store.retention) || store.retention < 1)))) {
      throw new AgentError("invalid_params", "Invalid history service TTL or retention");
    }
    if (store instanceof MemoryHistory && options.testOnly !== true) {
      throw new AgentError("not_supported", "MemoryHistory cannot commit durably; serve it only with testOnly: true");
    }
    const match = /^127\.0\.0\.1:(\d+)$/.exec(options.address);
    if (!match || Number(match[1]) > 65535) throw new AgentError("invalid_params", "Use a numeric loopback address: 127.0.0.1:port");
    const binding = { port: Number(match[1]), token: await tokenFrom(options.tokenFile) };
    const service = store instanceof HttpHistory
      ? await historyRelay({ ...binding, upstream: await httpUpstream(store) })
      : await historyService({ ...binding, leaseTtl, ...(store instanceof FileHistory ? { archive: fileArchive(store) }
        : store instanceof MemoryHistory ? { archive: memoryArchive(store) } : { store }) });
    return { url: service.url, close: () => new Promise<void>((resolve, reject) =>
      service.server.close(error => error ? reject(error) : resolve())) };
  });
}
export const fileHistory = (dir: string, options?: { pendingErasureDir?: string }): FileHistory => new FileHistory(dir, options);
export const memoryHistory = (): MemoryHistory => new MemoryHistory();

export let createAgent: (options?: AgentOptions) => Promise<Agent>;
export let restart: (agent: Agent) => Promise<Agent>;
export let cliAgentFromHarness: (harness: Harness, project: string) => Promise<Agent>;

export class Agent {
  #open = new Map<string, Session>();
  #opening = new Map<string, Promise<Session>>();
  #handlers = new Map<string, QuestionHandler>();
  #questions = new Map<string, AbortController>();
  #close?: Promise<void>;
  #hostEnabled = false;
  #defaults: Settings;
  #acp = false;
  #agui = false;
  #stopAcp?: () => Promise<void>;
  #project: string;
  #conformance = false;
  #approval = false;
  #interfaces: AgentInterface[] = [];
  #startedInterfaces: AgentInterface[] = [];
  #api;
  #scratch: string;
  #h: Harness;
  #defaultHandler?: QuestionHandler;
  #sources: readonly InterfaceToolSource[] = [];
  #portable = false;
  #interruption = new AbortController();
  #rebuild?: () => Promise<Agent>;

  private constructor(harness: Harness, scratch: string, project: string, settings: Settings, onQuestion?: QuestionHandler) {
    this.#h = harness;
    this.#api = harness.api("sdk.host");
    this.#scratch = scratch;
    this.#project = project;
    this.#defaults = settings;
    this.#defaultHandler = onQuestion;
  }
  static {
    createAgent = options => Agent.#create(options ?? {});
    cliAgentFromHarness = async (harness, project) => {
      const agent = new Agent(harness, await mkdtemp(join(tmpdir(), "ma-cli-acp-")), project, {});
      agent.#hostEnabled = true; // The base composition owns plugin loading.
      agent.#approval = true;
      agent.#portable = harness.use<HistoryStore>("history-store") !== undefined;
      agent.#authority = { severalActors: true, sessionLimits: true, tenants: true };
      return agent;
    };
    restart = async agent => {
      agent.#check();
      if (!agent.#rebuild || agent.#hostEnabled || agent.#acp || agent.#external.size || agent.#startedInterfaces.length) {
        throw new AgentError("not_supported", "restart requires an in-process agent");
      }
      const rebuild = agent.#rebuild;
      agent.#close = (async () => {
        agent.#interruption.abort(new AgentError("lost", "Agent was interrupted"));
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
    const configuredHost = !!(options.processPlugins?.length || options.servicePlugins?.length);
    if (options.pluginHost === false && configuredHost) {
      throw new AgentError("invalid_composition", "Loading processPlugins or servicePlugins requires a plugin host");
    }
    if (!["ephemeral", "kept", "durable"].includes(durability)) throw new AgentError("invalid_params", "Unknown durability");
    if (durability === "ephemeral" && (options.history instanceof FileHistory || options.history instanceof HttpHistory)) {
      throw new AgentError("invalid_composition", "Persistent history requires durability: kept or durable");
    }
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
      const receiptDir = options.dataDir ? home : options.history instanceof FileHistory ? fileArchive(options.history).dir :
        join(process.env.XDG_STATE_HOME ?? join(homedir(),".local","state"), "modular-agent", "receipts");
      const h = new Harness({ project, home, receiptDir, agentName: options.agentName, approvalCoversNested: options.approvalCoversNested, questionsOutlastTurns: options.questionsOutlastTurns ?? false,
        jobReportsStartTurns: options.jobReportsStartTurns ?? false, settingsDuringTurn: options.settingsDuringTurn ?? "nextTurn",
        rejectUnknownModel: true, reopenModelAliases: options.reopenModelAliases, resourceReservations: options.resourceReservations, tenants: options.tenants ?? (options.conformance ? undefined : null) });
      const settings = structuredClone(options.settings ?? {});
      agent = new Agent(h, scratch, project, settings, options.onQuestion);
      agent.#authority = { severalActors: options.severalActors ?? false, sessionLimits: options.sessionLimits ?? false, tenants: options.tenants !== undefined };
      agent.#conformance = options.conformance ?? false;
      agent.#approval = options.approval !== undefined || agent.#conformance;
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
        await agent.#load(localEnvironment({ cwd: project, stateDir: durability === "ephemeral" ? scratch : undefined }));
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
      agent.#hostEnabled = options.pluginHost ?? configuredHost;
      await agent.#loadRemotes([...options.processPlugins ?? [], ...options.servicePlugins ?? [], ...(agent.#hostEnabled ? pluginSpecsFromEnv() : [])]);
      agent.#sources = structuredClone(options.interfaceTools ?? []);
      await h.registerInterfaceTools(agent.#sources);
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
      if (durability === "ephemeral" && persistent) throw new Error("Persistent history requires durability: kept or durable");
      if ((durability !== "ephemeral" || effectiveRuntime?.supports.continuesAfterRestart === true) && !persistent) {
        throw new Error("Kept history or a durable Runtime needs a persistent history store");
      }
      if (effectiveStore !== store) {
        await effectiveStore?.list();
        agent.#portable = effectiveStore?.supports.portableSessions === true;
      }
      if (options.maxApprovalWaitMs !== undefined) {
        if (!agent.#approval || !agent.declaration().portableSessions || durability === "ephemeral" || !options.questionsOutlastTurns) {
          throw new AgentError("invalid_composition", "Waiting approvals need approval, portable kept history and late-answer continuations");
        }
        h.enableWaitingApprovals(options.maxApprovalWaitMs);
      }
      await h.rebuildReservations();
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
  async #loadRemotes(specs: PluginSpec[]) {
    for (const spec of specs) {
      if ("url" in spec) {
        await this.#loadExternal(await startPluginService(spec, this.#h));
        continue;
      }
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
      api.registerApprovalRoute({ id: "sdk.local", ceiling: (id, actor, principal) =>
        api.session(id).project === this.#project && principal === local.id && (actor === local.id || this.#authority.severalActors) ? ALL_AUTHORITY : [],
        unchanged: async (entry, actor) => {
          const request = (entry.data as { request: import("@modular-agent/harness").InputRequest }).request;
          const q = await questionOf(api, { ...request, answerers: request.answerers ?? [] });
          const view = await api.gateOutput(entry.sessionId, actor, "input.request.opened", structuredClone(q));
          return isDeepStrictEqual(view, q);
        } });
      const withheld = new Set<string>();
      const capability: InterfaceCapability = {
        id: "sdk.local", actorId: local.id,
        present: (id, request) => !withheld.has(request?.id ?? "") && (!this.#acp || this.#agui) && !!(this.#handlers.get(id) ?? this.#defaultHandler),
        onInputRequest: request => {
          const handler = this.#handlers.get(request.sessionId) ?? this.#defaultHandler;
          if (!handler || this.#questions.has(request.id)) return;
          const { id, sessionId } = request;
          if (!api.session(sessionId).actors.find(a => a.id === local.id)?.authority.includes(request.kind === "approval" ? "approve" : "answer") ||
              request.answerers.length && !request.answerers.includes(local.id)) return;
          const controller = new AbortController();
          this.#questions.set(request.id, controller);
          void questionOf(api, request).then(async q => {
            await api.checkPending(sessionId);
            if (request.approvalWait && !await api.presentApproval(sessionId, id, { routeId: "sdk.local", handle: controller,
              actorId: local.id, submittedBy: local.id, present: () => !controller.signal.aborted && (this.#handlers.get(sessionId) ?? this.#defaultHandler) === handler })) return;
            if (!controller.signal.aborted && request.coversNested && !request.approvalWait && !await exactLocalApproval(api, q, local.id)) {
              withheld.add(id); api.presenceChanged(sessionId); return;
            }
            if (!controller.signal.aborted) return handler(q, { sessionId, actorId: local.id, cancelled: controller.signal });
          })
            .catch(() => undefined).then(async answer => {
              if (!controller.signal.aborted && !withheld.has(id)) await submitAnswer(api, request, local.id, answer ?? "decline", undefined, controller);
            }).catch(async () => {
              if (!controller.signal.aborted) await submitAnswer(api, request, local.id, "decline", undefined, controller).catch(() => {});
            }).finally(() => { this.#questions.delete(id); });
        },
        onInputRequestClosed: id => { withheld.delete(id); this.#questions.get(id)?.abort(); },
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
      isOpen: () => this.#open.get(id) === s,
      fork: async entry => {
        this.#check();
        const at = entry ?? this.#api.session(id).position;
        if (!at || !(await this.#api.readHistory(id, { all: true })).some(e => e.id === at)) throw new AgentError("not_found", "No entry to fork");
        const fork = await checked(() => this.#api.forkSession(id, at));
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
        if (handler) for (const r of this.#api.openRequests(id)) if (r.approvalWait) this.#h.useAll<InterfaceCapability>("interface").find(i => i.id === "sdk.local")?.onInputRequest?.(r);
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
  /** Attach an independently authenticated executor to an already open session. */
  connectInterfaceTools(sessionId: string, options: InterfaceToolConnectionOptions): InterfaceToolConnection {
    this.#check();
    const { rights, ...actor } = options.actor;
    const connection = this.#h.connectInterfaceTools(sessionId, { ...options, actor: { ...actor, authority: [...rights] } });
    return { ...connection,
      release: id => checked(() => connection.release(id)),
      reportInterfaceToolResult: report => checked(() => connection.reportInterfaceToolResult(report)),
    };
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
  async sessions(filter?: { project?: string }): Promise<SessionListEntry[]> {
    this.#check();
    return checked(async () => {
      const stored = await this.#api.listSessions(filter?.project ? await realpath(filter.project) : null);
      return Promise.all(stored.map(async ({ id }) => {
        const { project, settings, updated } = await this.sessionInfo(id);
        return { id, project, updated, model: parseModel(settings.model), title: typeof settings.title === "string" ? settings.title : undefined };
      }));
    });
  }
  /** Inspect committed waits without opening a session, joining an actor or supplying presence. */
  async sessionSummary(id: string, viewer: SessionViewer): Promise<SessionSummary | undefined> {
    this.#check();
    if (!/^[\w-]+$/.test(id)) throw new AgentError("invalid_params", "Invalid session id");
    const { rights, ...actor } = viewer.actor;
    return checked(() => this.#api.sessionSummary(id, { ...viewer, actor:{...actor, authority:rights}, allowJoin:this.#authority.severalActors }));
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
      const tenant = (entries.find(e => e.kind === "tenant" && !e.erased)?.data as { tenant?: string } | undefined)?.tenant;
      return { ...meta, updated: entries.at(-1)?.time ?? meta.created, settings, ...(tenant === undefined ? {} : { tenant }) };
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
  resourceLimits(): ReservationLimits { this.#check(); return this.#h.resourceLimits(); }
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
      ...this.#authority, mixedActorInput: "refused",
      startsTurnsUnasked: base.startsTurnsUnasked === "never" ? "never" : "jobReports",
    };
  }
  serveAcp(options?: ServeAcpOptions & { listen?: never }): Promise<void>;
  serveAcp(options: ServeAcpServiceOptions): Promise<ServiceServer>;
  async serveAcp(options: (ServeAcpOptions & { listen?: never }) | ServeAcpServiceOptions = {}): Promise<void | ServiceServer> {
    return this.#serve(options);
  }
  async serveAgui(options: ServeAguiOptions): Promise<ServiceServer> {
    if (!options?.listen) throw new AgentError("invalid_composition", "AG-UI requires a service listener");
    return await this.#serve(options, options) as ServiceServer;
  }
  async #serve(options: (ServeAcpOptions & { listen?: never }) | ServeAcpServiceOptions, agui?: ServeAguiOptions): Promise<void | ServiceServer> {
    this.#check();
    if (this.#acp || this.#open.size || this.#opening.size) throw new AgentError("busy", "ACP must start before opening sessions");
    this.#acp = true;
    this.#agui = !!agui;
    const agents = new Map<string, Promise<Agent>>();
    const sessions = new Map<string, Agent>();
    const attachments = new Map<PluginApi, ReturnType<typeof standardMcpTools>>();
    const installMcp = async (agent: Agent) => {
      if (!agent.#hostEnabled) {
        await agent.#loadRemotes(pluginSpecsFromEnv());
        agent.#hostEnabled = true;
        const models = agent.models();
        if (agent.#defaults.model == null && models.length === 1) {
          const { id, provider } = models[0];
          agent.#defaults.model = { id, provider };
        }
      }
      const mcp = standardMcpTools({ servers: async project => await options.projectMcp?.(project) ?? {} });
      await agent.#plugin(mcp);
      attachments.set(agent.#api, mcp);
    };
    const disposeProjects = async () => {
      await Promise.allSettled([...agents.values()].map(async pending => {
        const agent = await pending;
        if (agent !== this) await agent.close();
      }));
    };
    const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0;
    const list = <T>(items: readonly T[] | undefined, valid: (item: T) => boolean, name: string) => {
      if (items === undefined) return undefined;
      if (!Array.isArray(items) || !Array.from(items).every(valid)) throw new AgentError("invalid_composition", `Invalid ACP ${name}`);
      return [...items];
    };
    const makeScope = async (actor: Actor, config: Pick<ServeAcpOptions, "tenants" | "projects" | "represents" | "traceTrusted">, ceiling: boolean) => {
      if (!actor || !isId(actor.id) || !["host", "user", "agent", "program"].includes(actor.kind) || !actor.rights) {
        throw new AgentError("invalid_composition", "Invalid ACP actor");
      }
      const rights = list(actor.rights, r => ALL_AUTHORITY.includes(r), "rights")!;
      const tenants = new Set(list(config.tenants, t => t === null || isId(t), "tenants") ?? [null]);
      const represents = new Set(list(config.represents, isId, "representation"));
      const paths = list(config.projects, p => isId(p) && isAbsolute(p), "projects");
      const projects = paths && new Set(await Promise.all(paths.map(async path => {
        const canonical = await realpath(path);
        if (!(await stat(canonical)).isDirectory()) throw new AgentError("invalid_composition", "ACP project must be a directory");
        return canonical;
      })));
      return { scopeKey: JSON.stringify([actor.id, actor.kind, [...rights].sort(), [...tenants].sort(), projects && [...projects].sort(), config.traceTrusted ?? false]), actor: { id: actor.id, kind: actor.kind, authority: rights }, ceiling, represents, traceTrusted: config.traceTrusted,
        allowTenant: (tenant: string | null) => tenants.has(tenant),
        allowProject: (project: string) => (!!options.compose || project === this.#project) && (!projects || projects.has(project)) };
    };
    const installers: ((agent: Agent) => void)[] = [];
    const cleanRoutes: (() => void)[] = [];
    const acpRouteId = (scope: Awaited<ReturnType<typeof makeScope>>) => "acp:" + createHash("sha256").update(JSON.stringify([scope.scopeKey, [...scope.represents].sort()])).digest("hex");
    const installRoutes = (scope: Awaited<ReturnType<typeof makeScope>> & { clientId?: string }) => {
      const install = (agent: Agent) => {
        if (!agent.declaration().approvalsOutlastTurns) return;
        const api = agent.#api;
        const ceiling = (id: string, actor: string, principal: string) => {
          const session = api.session(id);
          return principal === scope.actor.id && (actor === principal || scope.represents.has(actor)) &&
            scope.allowProject(session.project) && scope.allowTenant(session.tenant ?? null) ? scope.actor.authority : [];
        };
        if (!agui || agui.acp) cleanRoutes.push(api.registerApprovalRoute({ id: acpRouteId(scope), ceiling,
          unchanged: entry => unchangedAcpApproval(api, entry, scope.actor.id) }));
        if (agui && scope.clientId) {
          const p = scope as Principal;
          for (const surface of ["run", "snapshot"] as const) cleanRoutes.push(api.registerApprovalRoute({ id: "agui:" + surface + ":" + p.clientId, ceiling: (id, actor, principal) =>
            actor === principal ? ceiling(id, actor, principal) : [],
            unchanged: async entry => {
              const raw = (entry.data as { request: import("@modular-agent/harness").InputRequest }).request;
              const request = { ...raw, answerers: raw.answerers ?? [], turnId: entry.turnId };
              const id = entry.sessionId, view = await interrupt(api, id, p, request, entry, false);
              if (!view) return false;
              // Check the binding envelope too, even when the old stream is gone. Compare
              // the approval content, not the set of currently open requests.
              if (surface === "snapshot") {
                const records = await api.readHistory(id);
                const copy = await messages(api, id, p, records, new Set());
                const snapshot = { threadId:id, declaration:agent.declaration(), cursor:"approval-recheck", messages:copy,
                  lastMessageId:copy.at(-1)?.id ?? null, waiting:{questions:[view.wire],
                    toolCalls:pendingFrontend(records,p).filter(c=>c.ended).map(({toolCallId,expiresAt})=>({toolCallId,expiresAt}))} };
                const out = await aguiReply(api,id,p,"snapshot",structuredClone(snapshot));
                return out.threadId === id && same(out.waiting?.questions,[view.wire]);
              }
              const terminal = [{ type:"RUN_FINISHED", threadId:id, runId:"approval-recheck", outcome:{type:"interrupt",interrupts:[view.wire]} }];
              return same(await aguiReply(api,id,p,"events",structuredClone(terminal)),terminal);
            } }));
        }
      };
      installers.push(install); install(this);
    };
    const selectProject = async (project: string, id?: string, saved?: SessionInfo) => {
      const key = JSON.stringify([project, saved?.id]);
      let selected = id ? sessions.get(id) : undefined;
      if (!selected && options.compose) {
        let pending = agents.get(key);
        if (!pending) {
          pending = (async () => {
            const agent = await options.compose!(project, saved);
            if (agent === this) return agent;
            try {
              if (agent.#project !== project || agent.#open.size || agent.#acp) throw new AgentError("invalid_composition", "Factory must return a fresh agent for this project");
              agent.#h.shareReservations(this.#h);
              agent.#acp = true;
              await installMcp(agent);
              for (const install of installers) install(agent);
              return agent;
            } catch (error) { await agent.close(); throw error; }
          })();
          agents.set(key, pending);
          void pending.catch(() => { if (agents.get(key) === pending) agents.delete(key); });
        }
        selected = await pending;
      }
      selected ??= this;
      return selected;
    };
    const prepareConnection = (scope: Awaited<ReturnType<typeof makeScope>>, network: boolean) => {
      const attached = new Map<PluginApi, { detach(): void; agent: Agent }>();
      let disconnected = false;
      const attach = (agent: Agent) => {
        if (disconnected) throw new AgentError("lost", "The ACP connection ended");
        if (attached.has(agent.#api)) return;
        const remove = agent.#h.connectInterface(binding.acp);
        const off = binding.acp.attach(agent.#api, agent === this);
        attached.set(agent.#api, { agent, detach() { off(); remove(); } });
      };
      const { actor } = scope;
      const inaccessible = () => new AgentError("forbidden", "Session is inaccessible");
      const authorize = async (id: string) => {
        const owner = sessions.get(id) ?? this;
        const saved = owner.#h.liveSessionInfo(id) ?? await this.sessionInfo(id).catch(error => {
          if (error instanceof AgentError && error.code === "not_found") throw inaccessible();
          throw error;
        });
        if (!scope.allowProject(saved.project) || !scope.allowTenant(saved.tenant ?? null) ||
            !await owner.#h.canDiscoverSession(id, actor, !network || owner.#authority.severalActors)) throw inaccessible();
        return saved;
      };
      const binding = acpInterface({
        actor,
        represents: scope.represents, approvalRouteId: acpRouteId(scope),
        connectionScope: run => scope.ceiling ? this.#h.withConnectionActor(actor, run) : run(),
        allowTenant: scope.allowTenant,
        allowAttached: (project, tenant) => !disconnected && scope.allowProject(project) && scope.allowTenant(tenant ?? null),
        authorizeSession: authorize,
        listOwner: id => {
          const owner = sessions.get(id) ?? this;
          return { api:owner.#api, allowJoin:!network || owner.#authority.severalActors };
        },
        listProject: cwd => realpath(cwd),
        showApproval: options.showApproval ?? this.#approval,
        hostMcpServers: options.hostMcpServers ?? !network,
        traceTrusted: scope.traceTrusted ?? !network,
        declaration: id => (id && sessions.get(id) || this).declaration(),
        projectSettings: options.projectSettings ? async project => await options.projectSettings!(project) : undefined,
        associate: (id, api) => { sessions.set(id, attached.get(api)?.agent ?? this); },
        project: async (cwd, id) => {
          const saved = id ? await authorize(id) : undefined;
          const project = await checked(() => realpath(cwd), "invalid_params");
          if (!(await stat(project)).isDirectory()) throw new AgentError("invalid_params", "Project must be a directory");
          if (!scope.allowProject(project)) throw inaccessible();
          if (saved && saved.project !== project) throw new AgentError("wrong_project", "Session belongs to a different project");
          const selected = await selectProject(project, id, saved);
          attach(selected);
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
      attach(this);
      return { binding, detach: () => {
        disconnected = true;
        for (const part of attached.values()) part.detach();
        attached.clear();
      } };
    };
    const resumeOpen = async (scope?: Pick<Awaited<ReturnType<typeof makeScope>>, "allowProject" | "allowTenant">) => {
      if (!options.resumeOpen || scope && !scope.allowProject(this.#project)) return;
      // The embedded local opener is not a token or a future stdio connection.
      // Its prospective grant is watch only. The turn keeps its own recorded authority.
      const actor = { ...local, authority:["watch" as const] };
      for (const {id, project} of await this.#api.listSessions(this.#project)) {
        if (project !== this.#project) continue;
        const row = await this.#api.sessionSummary(id, {actor, allowJoin:true});
        if (!row || row.waiting.turn === "none" || !(scope?.allowTenant(row.tenant ?? null) ?? (row.tenant === undefined))) continue;
        if (row.waiting.turn === "running") { options.onResumeOpen?.(id, "skipped"); continue; }
        const agent = await selectProject(project, id, await this.sessionInfo(id));
        let resumed: boolean;
        try { resumed = await agent.#h.withConnectionActor(actor, () => agent.#h.resumeInterruptedSession(id, actor)); }
        catch (error) { if ((error as {code?: string}).code !== "held") throw error; resumed = false; }
        if (resumed) sessions.set(id, agent);
        options.onResumeOpen?.(id, resumed ? "resumed" : "skipped");
      }
    };
    let serving = false;
    try {
      if (options.listen === undefined) {
        if (options.actor !== undefined && (options.actorId !== undefined || options.rights !== undefined)) {
          throw new AgentError("invalid_composition", "ACP actor cannot be combined with actorId or rights");
        }
        const localActor = options.actor ?? { ...defaultAcpActor(), id: options.actorId ?? process.env.MODULAR_AGENT_ACTOR ?? "acp-user",
          rights: list(options.rights, r => ALL_AUTHORITY.includes(r), "rights") ?? [...ALL_AUTHORITY] };
        const scope = await makeScope(localActor, options, options.actor !== undefined || options.rights !== undefined);
        await installMcp(this);
        installRoutes(scope);
        await resumeOpen(scope);
        const { binding, detach } = prepareConnection(scope, false);
        try { await binding.acp.serveStdio(); } finally { detach(); }
        return;
      }
      const controlTimeoutMs = options.controlTimeoutMs ?? 5000;
      if (!Number.isSafeInteger(controlTimeoutMs) || controlTimeoutMs <= 0) throw new AgentError("invalid_params", "Invalid control timeout");
      const actors = await Promise.all(options.actors.map(async entry => ({
        tokenFile: entry.tokenFile, value: { ...await makeScope(entry.actor, entry, true), clientId: (entry as { clientId?: string }).clientId ?? "" },
      })));
      let http: AguiBinding | undefined;
      if (agui) {
        const keys = new Map<string, string>();
        for (const { value } of actors) {
          if (!isId(value.clientId) || keys.has(value.clientId) && keys.get(value.clientId) !== value.scopeKey ||
              this.#sources.some(s => s.routeId === value.clientId && s.actorId !== value.actor.id)) {
            throw new AgentError("invalid_composition", "AG-UI needs a stable clientId unique to the actor and scope");
          }
          keys.set(value.clientId, value.scopeKey);
        }
        if (agui.origins && (!Array.isArray(agui.origins) || !agui.origins.every(o => { const u = new URL(o); return /^https?:$/.test(u.protocol) && o === u.origin; }))) {
          throw new AgentError("invalid_composition", "Invalid browser origin");
        }
        const target = (agent: Agent): Target => ({ h: agent.#h, api: agent.#api, agent, sources: agent.#sources });
        http = new AguiBinding({ ...agui, root: target(this), project: this.#project, owner: id => target(sessions.get(id) ?? this), principalScope: (actor, fn) => this.#h.withConnectionActor(actor, fn),
          associate: (id, agent) => sessions.set(id, agent),
          locate: async (p, id, memberOnly) => {
            if (!id && !p.allowProject(this.#project)) fail("not_found");
            const owner = id && sessions.get(id) || this;
            const live = id ? owner.#h.liveSessionInfo(id) : undefined;
            const saved = id && !live ? await owner.sessionInfo(id).catch(e => {
              if (e.code === "not_found" || e.cause?.code === "ENOENT") fail("not_found"); throw e;
            }) : undefined;
            const info = live ?? saved;
            if (info && (!p.allowProject(info.project) || !p.allowTenant(info.tenant ?? null))) fail("not_found");
            if (id && !await owner.#h.canDiscoverSession(id, p.actor, !memberOnly && owner.#authority.severalActors)) fail("not_found");
            const agent = await selectProject(info?.project ?? this.#project, id, saved);
            if (id) sessions.set(id, agent);
            return target(agent);
          } });
      }
      for (const { value } of actors) installRoutes(value);
      await installMcp(this);
      const server = await listenWebSocket(options, ACP_PROTOCOL, actors, agui && !agui.acp ? undefined : async (ws, scope) => {
        const { binding, detach } = prepareConnection(scope, true);
        try {
          await binding.acp.serveMessages({
            receive: receive => receiveMessages(ws, receive),
            closed: close => { ws.once("close", close); ws.once("error", close); },
            send: text => new Promise((resolve, reject) => ws.send(text, error => error ? reject(error) : resolve())),
            controlTimeoutMs, lose: () => ws.terminate(),
          });
        } finally { detach(); if (ws.readyState === ws.OPEN) ws.close(1000); }
      }, http, options.resumeOpen ? () => resumeOpen() : undefined);
      const stopListener = async () => { for (const off of cleanRoutes.splice(0)) off(); http?.close(); await server.close(); };
      this.#stopAcp = async () => { await stopListener(); await disposeProjects(); };
      if (agui) { serving = true; return { url: new URL(server.url.replace(/^ws/, "http")).origin, close: stopListener }; }
      serving = true;
      return { url: server.url, close: () => this.close() };
    } catch (error) { throw new AgentError("invalid_composition", messageOf(error), undefined, error); }
    finally {
      if (!serving) { await disposeProjects(); await this.close(); }
    }
  }
  close(): Promise<void> {
    return this.#close ??= (async () => {
      await this.#stopAcp?.();
      await Promise.allSettled(this.#opening.values());
      for (const s of [...this.#open.values()]) await s.close().catch(() => {});
      for (const part of this.#startedInterfaces.reverse()) await Promise.resolve().then(() => part.stop?.()).catch(() => {});
      await this.#h.stop();
      await rm(this.#scratch, { recursive: true, force: true });
    })();
  }
}
