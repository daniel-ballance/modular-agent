import { checkOutputSize, mapOutput } from "@modular-agent/harness";
import { customHistoryWriter, type LeasedHistoryStore } from "@modular-agent/services";
import type { Configuration, CredentialStore, ModelStreamEvent, OutputPayload, HistoryStore as WriterHistoryStore, Runtime, WorkingEnvironment, Plugin as BasePlugin, PluginApi } from "@modular-agent/harness";
import type { Agent } from "./agent.js";
import { AgentError, checked } from "./errors.js";
import { questionReply, toolSource, type Tool, type ToolEnvironment } from "./tool.js";
import { adaptProvider, type Provider } from "./provider.js";
import { sdkJob, type JobOwner, type JobRecovery, type JobStarter } from "./jobs.js";
import type {
  Actor, AssistantMessage, Content, HistoryEntry, ModelError, ModelInfo, ModelRef, ModelRequest, Outcome, QuestionDraft, QuestionReply, Settings,
  ToolCall, ToolDefinition, ToolStatus, TurnResult, Usage,
} from "./data.js";

type Awaitable<T> = T | Promise<T>;
type Observe = { sessionId: string; turnId: string };
type Before = Observe & { call: ToolCall; definition?: ToolDefinition };
type ResultFields = { content: Content; value?: unknown };
type After = Observe & { call: ToolCall; result: ResultFields & { status: ToolStatus; callId: string } };
type Hooks = {
  "plugin.load": [{ name: string; origin: string }, "allow" | { refuse: string }];
  "session.prepare": [{ sessionId: string; project: string; resumed: boolean }, void];
  "session.start": [{ sessionId: string; resumed: boolean }, void];
  "session.end": [{ sessionId: string }, void];
  "session.join": [{ sessionId: string; actorId: string; actor: Actor; grantedBy: string }, void];
  "session.leave": [{ sessionId: string; actorId: string; requestedBy?: string }, void];
  output: [Omit<OutputPayload, "events"> & { events: OutputEvent[] }, "block" | { redact: OutputEvent[] }];
  input: [{ sessionId: string; actorId: string; content: Content; when: string }, { change: Content } | { handle: true | { command: string } }];
  "turn.before": [Observe & { input: Content; project?: string; tools?: ToolDefinition[] }, { add: { system?: string; context?: Content } }];
  "turn.start": [Observe, void];
  "step.before": [Observe & { stepId: string; request: ModelRequest; model?: ModelInfo; history?: HistoryEntry[]; usage?: Usage }, { change: ModelRequest }];
  "step.after": [Observe & { stepId: string; response: AssistantMessage }, "continue" | { end: string }];
  "tool.before": [Before, "allow" | { refuse: string } | { change: ToolCall["input"] } | { pending: QuestionDraft }];
  "tool.after": [After, { change: Partial<ResultFields> }];
  "model.failed": [Observe & { error: ModelError; request: ModelRequest }, "stop" | { retry: true | ModelRequest }];
  "turn.result": [Observe & { result: Pick<TurnResult, "text" | "value">; shape?: Record<string, unknown> }, "accept" | { refuse: string }];
  "turn.end": [Observe & { outcome: Outcome; result: TurnResult }, void];
  "provider.request": [{ sessionId: string | null; provider: string; model: ModelRef; request: ModelRequest }, { change: ModelRequest }];
  "provider.piece": [{ sessionId: string; provider: string; model: ModelRef; turnId?: string; stepId: string; piece: ModelStreamEvent }, void];
  "provider.response": [{ sessionId: string | null; provider: string; model: ModelRef; message: AssistantMessage }, void];
};
export interface OutputEvent { type: string; data: unknown }
export type HookPoint = keyof Hooks;
export type HookOrder = "first" | "normal" | "last";
export interface CallContext {
  sessionId?: string;
  actorId?: string;
  turnId?: string;
  stepId?: string;
  callId?: string;
  cancelled: AbortSignal;
  /** In-process access to the current session's project and tool catalog. */
  session?(): { project: string; tools: ToolDefinition[] };
  /** Available to the job owner during session.start. */
  jobs?: JobRecovery;
  log(message: string): void;
  history(cursor?: string): Promise<{ entries: HistoryEntry[]; next?: string }>;
  emit(type: string, data: unknown): void;
}
export interface CommandContext extends Omit<CallContext, "jobs"> {
  sessionId: string;
  actorId: string;
  jobs: JobStarter;
  environment: ToolEnvironment;
  ask(question: QuestionDraft, wait?: { wait: number }): Promise<QuestionReply>;
  requestModel(request: ModelRequest): Promise<AssistantMessage>;
}
export type HookHandler<P extends HookPoint> =
  (payload: Readonly<Hooks[P][0]>, context: CallContext) => Awaitable<Hooks[P][1] | void>;
export type CommandHandler = (args: string, context: CommandContext) => Awaitable<string | void>;

export interface Registrar {
  config(): Settings;
  tool(tool: Tool): void;
  tools(source: ToolCatalog): void;
  environment(environment: WorkingEnvironment): void;
  runtime(runtime: Runtime): void;
  historyStore(store: LeasedHistoryStore | WriterHistoryStore): void;
  credentialStore(store: CredentialStore): void;
  configuration(source: ProjectConfiguration | Configuration): void;
  interface(part: AgentInterface): void;
  provider(provider: Provider): void;
  jobs(owner: JobOwner): void;
  on<P extends HookPoint>(point: P, handler: HookHandler<P>, order?: HookOrder,
    options?: { inProcessOnly?: boolean }): void;
  command(name: string, description: string, handler: CommandHandler,
    options?: { usesModel?: boolean; inProcessOnly?: boolean }): void;
  onHook<P, A>(hook: CustomHook<P, A, unknown>, handler: (payload: P) => Awaitable<A | void>, order?: HookOrder): void;
  defineHook<P = unknown, A = unknown, R = unknown>(name: string, rule: "observe" | "gate" | "transform" | "collect" | "firstAnswer"): CustomHook<P, A, R>;
}

export interface CustomHook<P, A, R> {
  on(handler: (payload: P) => Awaitable<A | void>, order?: HookOrder): void;
  call(payload: P): Promise<R>;
}

const customHooks = new WeakMap<object, string>();

export interface ProjectConfiguration {
  settings(project: string): Awaitable<Settings>;
  trusted(project: string): Awaitable<boolean>;
}

export interface AgentInterface {
  start(agent: Agent): Awaitable<void>;
  stop?(): Awaitable<void>;
}

export interface ToolCatalog {
  id: string;
  tools(sessionId?: string): readonly Tool[];
  onChange?(handler: () => void): () => void;
}

/** A tool source supplies a new snapshot after each changed() notification. */
export function defineToolSource<T extends ToolCatalog>(source: T): T & { changed(): void } {
  const listeners = new Set<() => void>();
  return Object.assign(source, {
    changed() { for (const listener of listeners) listener(); },
    onChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
}

export interface Plugin {
  name: string;
  replaces?: string[];
  config?: Settings;
  setup(registrar: Registrar): Awaitable<void>;
  stop?(): Awaitable<void>;
}

const staticTools = new WeakMap<Plugin, readonly Tool[]>();
export const unservableTool = (plugin: Plugin) => staticTools.get(plugin)?.find(t => t.inProcessOnly);

export function definePlugin(options: Omit<Plugin, "setup"> & {
  tools?: readonly Tool[];
  hooks?: { [P in HookPoint]?: HookHandler<P> };
  setup?: Plugin["setup"];
}): Plugin {
  const { tools, hooks, setup, ...plugin } = options;
  const built: Plugin = { ...plugin, async setup(r) {
    for (const t of tools ?? []) r.tool(t);
    for (const [point, handler] of Object.entries(hooks ?? {})) {
      r.on(point as HookPoint, handler as HookHandler<HookPoint>);
    }
    await setup?.(r);
  } };
  staticTools.set(built, [...tools ?? []]);
  return built;
}

function change(point: HookPoint, payload: Record<string, unknown>, answer: Record<string, unknown>) {
  if (point === "turn.before" && answer.add) return answer.add;
  if (point === "step.after" && typeof answer.end === "string") return { refuse: answer.end };
  if (point === "input" && answer.handle === true) return { value: payload, stop: true };
  if (point === "model.failed" && answer.retry) return answer.retry === true ? { retry: true } : { retry: true, request: answer.retry };
  if ("refuse" in answer && typeof answer.refuse === "string" &&
      ["tool.before", "plugin.load", "turn.result"].includes(point)) return { refuse: answer.refuse };
  if ("change" in answer) {
    const update = answer.change;
    if (point === "tool.before") {
      if (!update || typeof update !== "object" || Array.isArray(update)) throw new AgentError("invalid_request", "Tool input must be an object");
      return { change: { ...payload, call: { ...(payload.call as ToolCall), input: update } } };
    }
    if (point === "tool.after") {
      const { content, value } = update as Partial<ResultFields>;
      return { value: { ...payload, result: { ...(payload.result as After["result"]),
        ...(content === undefined ? {} : { content }), ...("value" in (update as object) ? { value } : {}),
      } } };
    }
    if (point === "input") return { value: { ...payload, content: update } };
    if (point === "step.before" || point === "provider.request") return { value: { ...payload, request: update } };
  }
  throw new AgentError("invalid_request", `Invalid answer to ${point}`);
}

// The base server provides these callbacks through the current wire request.
export interface Work {
  signal?: AbortSignal;
  history?: CallContext["history"];
  emit?: CallContext["emit"];
  startJob?(kind: string, detail: unknown, key?: string): Promise<import("@modular-agent/harness").JobHandle>;
}

import { historyForPeer } from "@modular-agent/harness/telemetry";

function emitCustom(sessionId: string | undefined, type: string, data: unknown, send: (sessionId: string, type: string, data: unknown) => void) {
  if (!sessionId || typeof type !== "string" || !type.includes(".") || /^(session|actor|input|turn|step|model|tool|provider|job|history|position|entries|setting|plugin|capability)\./.test(type)) {
    throw new AgentError("invalid_request", "Custom events need a non-standard dotted name and a session");
  }
  send(sessionId, type, structuredClone(data));
}

function context(api: PluginApi, ids: Pick<CallContext, "sessionId" | "actorId" | "turnId" | "stepId" | "callId">, work?: Work, inProcessOnly = false) {
  let live = true;
  const assert = () => {
    if (!live) throw new AgentError("invalid_request", "Call context has settled");
    if (work?.signal?.aborted) throw new AgentError("cancelled", "Call was cancelled");
  };
  const cx: CallContext = {
    ...ids, cancelled: work?.signal ?? new AbortController().signal,
    ...(inProcessOnly && ids.sessionId ? { session() {
      assert();
      const id = ids.sessionId!;
      return { project: api.session(id).project, tools: structuredClone(api.tools(id)) };
    } } : {}),
    log(message) { assert(); console.error(message); },
    async history(cursor) {
      assert();
      if (!ids.sessionId) throw new AgentError("invalid_request", "Call has no session");
      if (work?.history) {
        const page = await checked(() => work.history!(cursor));
        assert();
        return page;
      }
      const all = await api.readHistory(ids.sessionId, { all: true });
      const at = cursor === undefined ? -1 : all.findIndex(e => e.id === cursor);
      if (cursor !== undefined && at < 0) throw new AgentError("invalid_request", "Unknown history cursor");
      const entries = all.slice(at + 1, at + 101);
      return { entries: structuredClone(entries.map(historyForPeer)), next: all.length > at + 101 ? entries.at(-1)?.id : undefined };
    },
    emit(type, data) {
      assert();
      emitCustom(ids.sessionId, type, data, work?.emit ? (_, type, data) => work.emit!(type, data) : api.emit);
    },
  };
  return { cx, assert, finish: () => { live = false; } };
}

export function capabilityForItem(item: string): string {
  if (item === "history") return "history-store";
  if (item === "credentials") return "credential-store";
  return item;
}

async function readCredential(api: PluginApi, name: string, signal?: AbortSignal): Promise<string | undefined> {
  if (typeof name !== "string" || !name) throw new AgentError("invalid_request", "A credential name is required");
  const value = await api.use<CredentialStore>("credential-store")?.read(name, { signal });
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "key" in value && typeof value.key === "string") return value.key;
}

const inProcessPoints = new Set<HookPoint>(["session.prepare", "session.join", "session.leave", "provider.piece"]);
const points = new Set("plugin.load session.start session.end input turn.before turn.start step.before step.after tool.before tool.after model.failed turn.result turn.end provider.request provider.response output".split(" "));

export async function collect(plugin: Plugin, config: Settings, served = false) {
  const tools: Tool[] = [];
  const interfaces: AgentInterface[] = [];
  const items = new Set<string>();
  const registrations: ((api: PluginApi) => unknown)[] = [];
  let settingUp = true;
  let jobOwner: JobOwner | undefined;
  const resumedJobs = new Set<string>();
  const jobRecovery = (api: PluginApi, sessionId: string, assert: () => void): JobRecovery => ({
    async unfinished() {
      assert();
      const jobs = await api.unfinishedJobs(sessionId);
      return jobs.map(({ job, key, detail }) => structuredClone({ id: job.id, kind: job.kind, actorId: job.actorId, key, detail }));
    },
    async resume(job) {
      assert();
      if (resumedJobs.has(job.id)) throw new AgentError("invalid_request", "Job was already resumed");
      resumedJobs.add(job.id);
      try { return sdkJob(await api.resumeJob(sessionId, job.id)); }
      catch (error) { resumedJobs.delete(job.id); throw error; }
    },
  });
  const check = () => {
    if (!settingUp) throw new AgentError("invalid_request", "Registrar has settled");
  };
  const add = (key: string) => {
    check();
    if (items.has(key)) throw new AgentError("invalid_composition", `${plugin.name} registers ${key} twice`);
    items.add(key);
  };
  const unavailable = (item: string) => {
    throw new AgentError("not_supported", `${plugin.name}: cannot serve ${item}`);
  };
  const part = (item: string, value: unknown, servable: boolean) => {
    add(item);
    if (served && !servable) unavailable(item);
    registrations.push(api => api.provide(capabilityForItem(item), value));
  };
  const toolsAt = (api: PluginApi, id: string, tools: Tool[]) => toolSource(id, tools, base => {
    const { cx, assert, finish } = context(api, { sessionId: base.sessionId }, base);
    return { history: cx.history, emit: cx.emit, finish, async credential(name) {
      assert();
      if (served) throw new AgentError("not_supported", "Named credentials are in-process only");
      const key = await checked(() => readCredential(api, name, base.signal));
      assert();
      return key;
    } };
  });
  const r: Registrar = {
    environment: env => part("working-environment", env, true),
    runtime: runtime => part("runtime", runtime, true),
    historyStore(store) {
      add("history");
      if (served) unavailable("history");
      registrations.push(async api => {
        api.provide("history-store", "ttlMs" in store ? await customHistoryWriter(store) : store);
      });
    },
    credentialStore: store => part("credentials", store, false),
    configuration(source) {
      add("configuration");
      if (served) unavailable("configuration");
      registrations.push(async api => {
        if ("get" in source) { api.provide("configuration", source); return; }
        const defaults = await source.trusted(api.project) ? structuredClone(await source.settings(api.project)) : {};
        const adapter: Configuration = { get: <T>(key: string) => key === "session" ? defaults as T : undefined, plugin: () => ({}) };
        api.provide("configuration", adapter);
      });
    },
    interface(part) {
      check();
      if (served) unavailable("interface");
      interfaces.push(part);
    },
    config() { check(); return structuredClone(config); },
    tool(t) {
      add(`tool:${t.definition.name}`);
      if (served && t.inProcessOnly) unavailable(`tool ${t.definition.name}`);
      tools.push(t);
    },
    tools(catalog) {
      for (const t of catalog.tools()) {
        add(`tool:${t.definition.name}`);
        if (served && t.inProcessOnly) unavailable(`tool ${t.definition.name}`);
      }
      const at = (api: PluginApi, id?: string) => {
        const current = [...catalog.tools(id)];
        const blocked = served && current.find(t => t.inProcessOnly);
        if (blocked) unavailable(`tool ${blocked.definition.name}`);
        return toolsAt(api, catalog.id, current);
      };
      registrations.push(api => api.provide("tool-source", {
        id: catalog.id, tools: (id?: string) => at(api, id).tools(),
        run: (call: Parameters<ReturnType<typeof toolSource>["run"]>[0], cx: Parameters<ReturnType<typeof toolSource>["run"]>[1]) =>
          at(api, cx.sessionId).run(call, cx),
        onChange: catalog.onChange?.bind(catalog),
      }));
    },
    provider(p) {
      add(`provider:${p.id}`);
      if (served && p.inProcessOnly) unavailable(`provider ${p.id}`);
      registrations.push(api => api.provide("provider", adaptProvider(p, async name => {
        if (served && name !== undefined) throw new AgentError("not_supported", "Named credentials are in-process only");
        return readCredential(api, name === undefined ? p.id : name);
      }, (sessionId, type, data) => emitCustom(sessionId, type, data, api.emit))));
    },
    jobs(owner) {
      check();
      if (jobOwner) throw new AgentError("invalid_composition", "Plugin registers two job owners");
      jobOwner = owner;
    },
    on(point, handler, order, options) {
      check();
      if (served && (options?.inProcessOnly || inProcessPoints.has(point) || !points.has(point))) unavailable(`hook ${point}`);
      if (!inProcessPoints.has(point) && !points.has(point)) throw new AgentError("not_supported", `Hook ${point} is not supported`);
      if (order !== undefined && !["first", "normal", "last"].includes(order)) throw new AgentError("invalid_composition", "Unknown hook order");
      registrations.push(api => api.on(point, async (payload: Hooks[typeof point][0], work?: Work) => {
        const p = payload as Observe & { actorId?: string; stepId?: string; call?: ToolCall };
        const { cx, finish, assert } = context(api, {
          sessionId: p.sessionId, actorId: p.actorId ?? p.call?.actorId,
          turnId: p.turnId, stepId: p.stepId ?? p.call?.stepId, callId: p.call?.id,
        }, work, options?.inProcessOnly);
        if (point === "session.start" && jobOwner) cx.jobs = jobRecovery(api, p.sessionId, assert);
        try {
          const snapshot = structuredClone(payload);
          if (!served && point === "turn.before" && p.sessionId) Object.assign(snapshot, {
            project: api.session(p.sessionId).project, tools: structuredClone(api.tools(p.sessionId)),
          });
          if (point === "session.join") {
            const actor = (snapshot as unknown as { actor: { authority: Actor["rights"]; kind: string } }).actor;
            Object.assign(actor, { rights: actor.authority, kind: actor.kind === "plugin" ? "program" : actor.kind });
            Reflect.deleteProperty(actor, "authority");
          }
          const mapped = point === "output" && !served ? (payload as unknown as OutputPayload).events.map(mapOutput) : undefined;
          if (mapped) Object.assign(snapshot, { events: mapped.map(m => structuredClone(m.wire)) });
          const answer = await handler(snapshot, cx);
          if (answer === undefined || answer === null) return;
          if (point === "output") {
            if (answer === "block") return { action: "block" };
            if (typeof answer === "object" && "redact" in answer) {
              if (!mapped) return { action: "pass", events: answer.redact };
              checkOutputSize(answer.redact);
              if (mapped.length !== answer.redact.length) throw new AgentError("invalid_request", "Invalid output gate answer");
              return { action: "pass", events: mapped.map((m, i) => m.restore(answer.redact[i])) };
            }
          }
          if (point === "tool.before" && typeof answer === "object" && "pending" in answer) {
            if (served) throw new AgentError("not_supported", "A served tool gate cannot leave a call open");
            return api.deferTool(p.sessionId, p.turnId, answer.pending);
          }
          if (point === "input" && typeof answer === "object" && "handle" in answer && typeof answer.handle === "object") {
            if (served) throw new AgentError("not_supported", "A served input hook cannot dispatch a command");
            if (!/^\/\S/.test(answer.handle.command)) throw new AgentError("invalid_request", "An input hook command starts with /");
            return { value: payload, stop: true, command: answer.handle.command };
          }
          if ((point === "tool.before" || point === "plugin.load") && answer === "allow" ||
              point === "step.after" && answer === "continue" || point === "turn.result" && answer === "accept") return;
          if (point === "model.failed" && answer === "stop") return { retry: false };
          return change(point, payload as unknown as Record<string, unknown>, answer as Record<string, unknown>);
        } finally { finish(); }
      }, order, point === "output" ? { stream: true } : undefined));
    },
    command(name, description, handler, options) {
      add(`command:${name}`);
      if (served && (options?.usesModel || options?.inProcessOnly)) unavailable(`command ${name}`);
      if (options?.usesModel && !options.inProcessOnly) throw new AgentError("invalid_composition", `Model-using command ${name} must declare inProcessOnly`);
      registrations.push(api => api.registerCommand(name, { description, usesModel: options?.usesModel, async run(args, ids) {
        const { cx, finish, assert } = context(api, { sessionId: ids.sessionId, actorId: ids.actorId, stepId: ids.stepId }, ids as Work, options?.inProcessOnly);
        const jobs: JobStarter = { async start(kind, detail, key) {
          assert();
          const handle = served
            ? await (ids as Work).startJob!(kind, detail, key)
            : api.startJob(ids.sessionId, { kind, detail: structuredClone(detail), key, actorId: ids.actorId });
          await handle.ready;
          return sdkJob(handle);
        } };
        const env = async () => {
          assert();
          if (!ids.environment) throw new AgentError("not_supported", "The host does not provide a command environment");
          return ids.environment();
        };
        const environment: ToolEnvironment = {
          read: path => checked(async () => (await env()).readFile(path)),
          exists: path => checked(async () => (await env()).exists(path)),
          write: (path, data) => checked(async () => (await env()).writeFile(path, typeof data === "string" ? data : Buffer.from(data))),
          list: path => checked(async () => {
            const scoped = await env();
            if (!scoped.list) throw new AgentError("not_supported", "The environment does not list directories");
            return scoped.list(path);
          }),
          exec: (command, opts) => checked(async () => (await env()).exec(command, { signal: cx.cancelled, timeoutMs: opts?.timeout })),
        };
        const command: CommandContext = { ...cx, sessionId: ids.sessionId, actorId: ids.actorId, jobs, environment,
          async ask(question, wait) {
            assert();
            if (served) throw new AgentError("not_supported", "A served command cannot ask questions");
            if (wait && (!Number.isSafeInteger(wait.wait) || wait.wait < 0)) throw new AgentError("invalid_request", "Invalid question wait");
            const answer = await checked(() => ids.ask({ ...question, timeLimitMs: wait?.wait ?? question.timeLimitMs }));
            assert();
            return questionReply(question.kind, answer);
          },
          async requestModel(request) {
            assert();
            if (served || !options?.usesModel) throw new AgentError("not_supported", "Command did not declare usesModel");
            return checked(() => ids.requestModel(request));
          },
        };
        try { return await handler(args, command); }
        finally { finish(); }
      } }));
    },
    onHook<P, A>(hook: CustomHook<P, A, unknown>, handler: (payload: P) => Awaitable<A | void>, order?: HookOrder) {
      check();
      const name = customHooks.get(hook);
      if (!name) throw new AgentError("invalid_composition", "Expected a hook returned by defineHook");
      if (served) unavailable(`hook ${name}`);
      registrations.push(api => api.on(name, payload => handler(structuredClone(payload)), order));
    },
    defineHook<P, A, R>(name: string, rule: Parameters<Registrar["defineHook"]>[1]): CustomHook<P, A, R> {
      check();
      if (served) unavailable(`hook ${name}`);
      let defined: PluginApi | undefined;
      registrations.push(api => { api.defineHook(name, rule === "firstAnswer" ? "first" : rule); defined = api; });
      const hook: CustomHook<P, A, R> = {
        on(handler, order) { r.onHook(hook, handler, order); },
        async call(payload) {
          if (!defined) throw new AgentError("invalid_request", `Hook ${name} is not installed`);
          return defined.runHook<R>(name, structuredClone(payload));
        },
      };
      customHooks.set(hook, name);
      return hook;
    },
  };
  try { await plugin.setup(r); }
  finally { settingUp = false; }
  const replaces = plugin.replaces ?? [];
  if (new Set(replaces).size !== replaces.length || replaces.some(key => !items.has(key))) {
    throw new AgentError("invalid_composition", `Invalid replacements in ${plugin.name}`);
  }
  const base: BasePlugin = { name: plugin.name, stop: plugin.stop?.bind(plugin), async setup(api) {
    if (tools.length) api.provide("tool-source", toolsAt(api, plugin.name, tools));
    for (const register of registrations) await register(api);
    if (jobOwner) {
      const owner = jobOwner;
      api.onJobCancel(async id => {
        const found = await api.findJob(id);
        if (!found) throw new AgentError("invalid_request", `No job ${id} of this plugin`);
        const job = (await jobRecovery(api, found.sessionId, () => {}).unfinished()).find(job => job.id === id);
        if (!job) throw new AgentError("invalid_request", `Job ${id} is not unfinished`);
        await owner.cancel(job, { job: sdkJob(await api.resumeJob(found.sessionId, id, true)) });
      });
      api.on("session.start", async ({ sessionId, resumed }: { sessionId: string; resumed: boolean }) => {
        if (!resumed || !owner.resume) return;
        const recovery = jobRecovery(api, sessionId, () => {});
        for (const job of await recovery.unfinished()) await owner.resume(job, { job: await recovery.resume(job) });
      }, "first");
    }
  } };
  return { items, base, interfaces };
}
