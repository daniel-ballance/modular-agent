import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ALL_AUTHORITY, Harness, parseModel, type InterfaceCapability, type HistoryStore, type Plugin as BasePlugin, type Provider as BaseProvider } from "@modular-agent/harness";
import { JsonlHistoryStore } from "@modular-agent/history-jsonl";
import { localEnvironment } from "@modular-agent/env-local";
import { approval } from "@modular-agent/approval";
import { transientRuntime } from "@modular-agent/runtime-transient";
import { durableRuntime } from "@modular-agent/runtime-durable";
import { startExternalPlugin, pluginSpecsFromEnv } from "@modular-agent/plugin-wire";
import { acpInterface } from "@modular-agent/interface-acp";
import { AgentError, checked, messageOf } from "./errors.js";
import { collect, definePlugin, type Plugin } from "./plugin.js";
import { type Provider } from "./provider.js";
import type { Tool } from "./tool.js";
import { asWorkingEnvironment, type MemoryEnvironment } from "./environment.js";
import { MemoryHistory } from "./history.js";
import { wirePlugin } from "./serve.js";
import { makeSession, type Session } from "./session.js";
import type { Declaration, ModelInfo, ModelRef, Question, QuestionHandler, Settings, ToolCall } from "./data.js";

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
  model?: string | ModelRef;
  settings?: Settings;
  approval?: Approval;
  onQuestion?: QuestionHandler;
  history?: MemoryHistory | FileHistory;
  environment?: MemoryEnvironment;
}
export interface SessionOptions { settings?: Settings }
export interface SessionInfo { id: string; project: string; created: number }
const local = { id: "user", kind: "user" as const, authority: ALL_AUTHORITY };

let openFileHistory: (store: FileHistory) => HistoryStore;
export class FileHistory {
  #dir: string;
  constructor(dir: string) { this.#dir = resolve(dir); }
  static { openFileHistory = store => new JsonlHistoryStore(store.#dir); }
}
export const fileHistory = (dir: string): FileHistory => new FileHistory(dir);
export const memoryHistory = (): MemoryHistory => new MemoryHistory();

export let createAgent: (options?: AgentOptions) => Promise<Agent>;

export class Agent {
  #open = new Map<string, Session>();
  #opening = new Map<string, Promise<Session>>();
  #handlers = new Map<string, QuestionHandler>();
  #questions = new Map<string, AbortController>();
  #close?: Promise<void>;
  #hostEnabled = false;
  #specs: ProcessPlugin[] = [];
  #acp = false;
  #api;
  #scratch: string;
  #h: Harness;
  #defaultHandler?: QuestionHandler;

  private constructor(harness: Harness, scratch: string, onQuestion?: QuestionHandler) {
    this.#h = harness;
    this.#api = harness.api("sdk.host");
    this.#scratch = scratch;
    this.#defaultHandler = onQuestion;
  }
  static { createAgent = options => Agent.#create(options ?? {}); }

  static async #create(options: AgentOptions): Promise<Agent> {
    const durability = options.durability ?? "ephemeral";
    if (!["ephemeral", "kept", "durable"].includes(durability)) throw new AgentError("invalid_params", "Unknown durability");
    if (options.approval !== undefined && !["off", "ask", "all", "never"].includes(options.approval)) {
      throw new AgentError("invalid_params", "Unknown approval policy");
    }
    if (durability !== "ephemeral" && !options.dataDir && !(options.history instanceof FileHistory)) {
      throw new AgentError("invalid_composition", "Kept and durable agents need dataDir or persistent history");
    }
    if (durability !== "ephemeral" && options.history instanceof MemoryHistory) {
      throw new AgentError("invalid_composition", `A ${durability} agent cannot use memory history`);
    }
    const scratch = await checked(() => mkdtemp(join(tmpdir(), "ma-sdk-")), "invalid_composition");
    let agent: Agent | undefined;
    try {
      const project = await realpath(options.project ?? process.cwd());
      if (!(await stat(project)).isDirectory()) throw new Error("Project must be a directory");
      const home = options.dataDir ? resolve(options.dataDir) : scratch;
      await mkdir(home, { recursive: true });
      const h = new Harness({ project, home });
      agent = new Agent(h, scratch, options.onQuestion);
      const settings = structuredClone(options.settings ?? {});
      if (options.approval !== undefined) settings.approval = options.approval;
      const store = options.history instanceof FileHistory ? openFileHistory(options.history) : options.history ??
        (durability === "ephemeral" ? memoryHistory() : new JsonlHistoryStore(join(home, "history")));
      await store.list();
      const core: BasePlugin = { name: "sdk.core", setup(api) {
        api.provide("configuration", { get: (key: string) => key === "session" ? settings : undefined, plugin: () => ({}) });
        api.provide("history-store", store);
      } };
      await agent.#load(core);
      if (options.environment) {
        const env = asWorkingEnvironment(options.environment);
        // The public memory environment is rooted at its virtual root, not the host project.
        await agent.#load({ name: "memory", setup: api => api.provide("working-environment", { ...env, cwd: project }) });
      } else await agent.#load(localEnvironment({ cwd: project, confineFiles: true }));
      await agent.#load(durability === "durable" ? durableRuntime() : transientRuntime());
      await agent.#load(agent.#localInterface());
      if (options.approval !== undefined) await agent.#load(approval({ policy: options.approval }));
      for (const p of options.providers ?? []) await agent.#plugin(definePlugin({ name: `provider.${p.id}`, setup: r => r.provider(p) }));
      for (const t of options.tools ?? []) await agent.#plugin(definePlugin({ name: `tool.${t.definition.name}`, tools: [t] }));
      for (const p of options.plugins ?? []) await agent.#plugin(p);
      agent.#hostEnabled = options.pluginHost ?? options.processPlugins !== undefined;
      agent.#specs = [...options.processPlugins ?? []];
      await agent.#loadProcesses([...agent.#specs, ...(agent.#hostEnabled ? pluginSpecsFromEnv() : [])]);
      const models = agent.models();
      const selected = options.model ?? settings.model;
      if (selected !== undefined) {
        const ref = parseModel(selected);
        if (!ref || !models.some(m => m.provider === ref.provider && m.id === ref.id)) throw new Error("The selected model is not offered");
        settings.model = ref;
      } else if (models.length === 1) settings.model = { provider: models[0].provider, id: models[0].id };
      return agent;
    } catch (error) {
      if (agent) await agent.close().catch(() => {});
      else await rm(scratch, { recursive: true, force: true });
      if (error instanceof AgentError && error.code === "not_supported") throw error;
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
      const { items, base } = await collect(plugin, plugin.config ?? {});
      const replaces = plugin.replaces ?? [];
      for (const key of items) {
        if (this.#h.hasItem(key) && !replaces.includes(key)) throw new Error(`${key} is already registered`);
      }
      for (const key of replaces) this.#h.replacements.set(key, plugin.name);
      await this.#load(base);
      loaded = true;
    } finally {
      if (!loaded && !this.#h.plugins().includes(plugin.name)) await Promise.resolve(plugin.stop?.()).catch(() => {});
    }
  }
  #external = new Set<string>();
  async #loadProcesses(specs: ProcessPlugin[]) {
    for (const spec of specs) {
      if (!spec.command?.length || spec.command.some(a => typeof a !== "string" || !a || a.includes("\0"))) {
        throw new Error("Process plugin needs a nonempty command vector");
      }
      await this.#loadExternal(await startExternalPlugin(spec, this.#h));
    }
  }
  async #loadExternal(ext: Awaited<ReturnType<typeof startExternalPlugin>>) {
      try {
        const refusal = ext.refusal(this.#h, this.#external);
        if (refusal) throw new Error(refusal);
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
        present: id => !!(this.#handlers.get(id) ?? this.#defaultHandler),
        onInputRequest: request => {
          const handler = this.#handlers.get(request.sessionId) ?? this.#defaultHandler;
          if (!handler) return;
          const controller = new AbortController();
          this.#questions.set(request.id, controller);
          const { kind, id, question, sessionId, details, options, timeLimitMs } = request;
          if (kind === "secret") return;
          const recorded = api.history(sessionId, { all: true }).findLast(e => e.kind === "inputRequest" && e.requestId === id);
          const call = (recorded?.data as { call?: ToolCall } | undefined)?.call;
          const q: Question = { kind, id, sessionId, question, details, options, call, deadline: timeLimitMs === undefined ? undefined : Date.now() + timeLimitMs };
          void Promise.resolve().then(() => handler(structuredClone(q), { sessionId, actorId: local.id, cancelled: controller.signal }))
            .catch(() => undefined).then(async answer => {
              if (controller.signal.aborted) return;
              const value = answer === "allow" ? "allow" : answer && typeof answer === "object" && "value" in answer ? answer.value : undefined;
              const reason = answer && typeof answer === "object" && "reason" in answer ? answer.reason : undefined;
              const granted = kind === "approval" ? answer === "allow" : typeof value === "string";
              const reply = api.answer(sessionId, { requestId: id, actorId: local.id,
                ...(granted ? { value } : { declined: true, reason }) });
              if (!reply.accepted) api.answer(sessionId, { requestId: id, actorId: local.id, declined: true });
            }).catch(async () => {
              if (!controller.signal.aborted) api.answer(sessionId, { requestId: id, actorId: local.id, declined: true });
            }).finally(() => { this.#questions.delete(request.id); });
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
      fork: async entry => {
        this.#check();
        const at = entry ?? this.#api.session(id).position;
        if (!at || !this.#api.history(id, { all: true }).some(e => e.id === at)) throw new AgentError("not_found", "No entry to fork");
        const fork = await checked(() => this.#api.forkSession(id, at), "busy");
        return this.openSession(fork);
      },
      close: async () => {
        await checked(() => this.#api.closeSession(id, local.id));
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
    return checked(async () => this.#session(await this.#h.startSession({ actor: local, settings: structuredClone(options.settings) })));
  }
  async openSession(id: string): Promise<Session> {
    this.#check();
    if (typeof id !== "string" || !id || !/^[\w-]+$/.test(id)) throw new AgentError("invalid_params", "Invalid session id");
    let pending = this.#opening.get(id);
    if (!pending) {
      pending = checked(async () => {
        await this.#h.openSession(id, local);
        await this.#api.waitForIdle(id);
        return this.#session(id);
      });
      this.#opening.set(id, pending);
    }
    try { return await pending; }
    finally { this.#opening.delete(id); }
  }
  async sessions(filter?: { project?: string }): Promise<SessionInfo[]> {
    this.#check();
    return checked(() => this.#api.listSessions(filter?.project ?? null));
  }
  models(): ModelInfo[] {
    this.#check();
    return structuredClone(this.#h.useAll<BaseProvider>("provider").flatMap(p => p.models()));
  }
  declaration(): Declaration {
    this.#check();
    return { ...this.#api.declaration(), nestedToolCalls: false, questionsOutlastTurns: false, lateAnswersStartTurns: false, severalActors: false, tenants: false, sessionLimits: false, confinesFiles: true };
  }
  async serveAcp(): Promise<void> {
    this.#check();
    if (this.#acp || this.#open.size || this.#opening.size) throw new AgentError("busy", "ACP must start before opening sessions");
    this.#acp = true;
    try {
      if (!this.#hostEnabled) await this.#loadProcesses(pluginSpecsFromEnv());
      const binding = acpInterface();
      await this.#load(binding);
      await binding.acp.serveStdio();
    } catch (error) { throw new AgentError("invalid_composition", messageOf(error), undefined, error); }
    finally { await this.close(); }
  }
  close(): Promise<void> {
    return this.#close ??= (async () => {
      await Promise.allSettled(this.#opening.values());
      for (const s of [...this.#open.values()]) await s.close().catch(() => {});
      await this.#h.stop();
      await rm(this.#scratch, { recursive: true, force: true });
    })();
  }
}
