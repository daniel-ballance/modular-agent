import type { Configuration, CredentialStore, HistoryStore, Runtime, WorkingEnvironment, Plugin as BasePlugin, PluginApi } from "@modular-agent/harness";
import type { Agent } from "./agent.js";
import { AgentError } from "./errors.js";
import { toolSource, type Tool } from "./tool.js";
import { adaptProvider, type Provider } from "./provider.js";
import type {
  AssistantMessage, Content, HistoryEntry, ModelError, ModelRef, ModelRequest, Outcome, Settings,
  ToolCall, ToolDefinition, ToolStatus, TurnResult,
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
  input: [{ sessionId: string; actorId: string; content: Content; when: string }, { change: Content } | { handle: true }];
  "turn.before": [Observe & { input: Content; project?: string; tools?: ToolDefinition[] }, { add: { system?: string; context?: Content } }];
  "turn.start": [Observe, void];
  "step.before": [Observe & { stepId: string; request: ModelRequest }, { change: ModelRequest }];
  "step.after": [Observe & { stepId: string; response: AssistantMessage }, "continue" | { end: string }];
  "tool.before": [Before, "allow" | { refuse: string } | { change: ToolCall["input"] }];
  "tool.after": [After, { change: Partial<ResultFields> }];
  "model.failed": [Observe & { error: ModelError; request: ModelRequest }, "stop" | { retry: true | ModelRequest }];
  "turn.result": [Observe & { result: Pick<TurnResult, "text" | "value">; shape?: Record<string, unknown> }, "accept" | { refuse: string }];
  "turn.end": [Observe & { outcome: Outcome; result: TurnResult }, void];
  "provider.request": [{ sessionId: string | null; provider: string; model: ModelRef; request: ModelRequest }, { change: ModelRequest }];
  "provider.response": [{ sessionId: string | null; provider: string; model: ModelRef; message: AssistantMessage }, void];
};
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
  log(message: string): void;
  history(cursor?: string): Promise<{ entries: HistoryEntry[]; next?: string }>;
  emit(type: string, data: unknown): void;
}
export interface CommandContext extends CallContext { sessionId: string; actorId: string }
export type HookHandler<P extends HookPoint> =
  (payload: Readonly<Hooks[P][0]>, context: CallContext) => Awaitable<Hooks[P][1] | void>;
export type CommandHandler = (args: string, context: CommandContext) => Awaitable<string | void>;

export interface Registrar {
  config(): Settings;
  tool(tool: Tool): void;
  tools(source: ToolCatalog): void;
  environment(environment: WorkingEnvironment): void;
  runtime(runtime: Runtime): void;
  historyStore(store: HistoryStore): void;
  credentialStore(store: CredentialStore): void;
  configuration(source: Configuration): void;
  interface(part: AgentInterface): void;
  provider(provider: Provider): void;
  on<P extends HookPoint>(point: P, handler: HookHandler<P>, order?: HookOrder,
    options?: { inProcessOnly?: boolean }): void;
  command(name: string, description: string, handler: CommandHandler,
    options?: { usesModel?: boolean; inProcessOnly?: boolean }): void;
  defineHook(name: string, rule: "observe" | "gate" | "transform" | "collect" | "firstAnswer"): void;
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
      if (work?.history) return work.history(cursor);
      const all = api.history(ids.sessionId, { all: true });
      const at = cursor ? all.findIndex(e => e.id === cursor) : -1;
      if (cursor && at < 0) throw new AgentError("invalid_request", "Unknown history cursor");
      const entries = all.slice(at + 1, at + 101);
      return { entries: structuredClone(entries), next: all.length > at + 101 ? entries.at(-1)?.id : undefined };
    },
    emit(type, data) {
      assert();
      if (!ids.sessionId || !type.includes(".") || /^(session|actor|input|turn|step|model|tool|provider|job|history|setting|plugin|capability)\./.test(type)) {
        throw new AgentError("invalid_request", "Custom events need a non-standard dotted name and a session");
      }
      if (work?.emit) work.emit(type, data);
      else api.emit(ids.sessionId, type, structuredClone(data));
    },
  };
  return { cx, finish: () => { live = false; } };
}

const points = new Set("plugin.load session.start session.end input turn.before turn.start step.before step.after tool.before tool.after model.failed turn.result turn.end provider.request provider.response".split(" "));

export async function collect(plugin: Plugin, config: Settings, served = false) {
  const tools: Tool[] = [];
  const interfaces: AgentInterface[] = [];
  const items = new Set<string>();
  const registrations: ((api: PluginApi) => unknown)[] = [];
  let settingUp = true;
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
  const part = (name: string, value: unknown, servable: boolean) => {
    add(name);
    if (served && !servable) unavailable(name);
    registrations.push(api => api.provide(name, value));
  };
  const r: Registrar = {
    environment: env => part("working-environment", env, true),
    runtime: runtime => part("runtime", runtime, true),
    historyStore: store => part("history-store", store, false),
    credentialStore: store => part("credential-store", store, false),
    configuration: source => part("configuration", source, false),
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
      const at = (id?: string) => {
        const current = [...catalog.tools(id)];
        const blocked = served && current.find(t => t.inProcessOnly);
        if (blocked) unavailable(`tool ${blocked.definition.name}`);
        return toolSource(catalog.id, current);
      };
      registrations.push(api => api.provide("tool-source", {
        id: catalog.id, tools: (id?: string) => at(id).tools(),
        run: (call: Parameters<ReturnType<typeof toolSource>["run"]>[0], cx: Parameters<ReturnType<typeof toolSource>["run"]>[1]) =>
          at(cx.sessionId).run(call, cx),
        onChange: catalog.onChange?.bind(catalog),
      }));
    },
    provider(p) {
      add(`provider:${p.id}`);
      if (served && p.inProcessOnly) unavailable(`provider ${p.id}`);
      registrations.push(api => api.provide("provider", adaptProvider(p, async () => {
        const value = await api.use<CredentialStore>("credential-store")?.read(p.id);
        if (typeof value === "string") return value;
        if (value && typeof value === "object" && "key" in value && typeof value.key === "string") return value.key;
      })));
    },
    on(point, handler, order, options) {
      check();
      if (served && (options?.inProcessOnly || !points.has(point))) unavailable(`hook ${point}`);
      if (point !== "session.prepare" && !points.has(point)) throw new AgentError("not_supported", `Hook ${point} is not supported`);
      if (order !== undefined && !["first", "normal", "last"].includes(order)) throw new AgentError("invalid_composition", "Unknown hook order");
      registrations.push(api => api.on(point, async (payload: Hooks[typeof point][0], work?: Work) => {
        const p = payload as Observe & { actorId?: string; stepId?: string; call?: ToolCall };
        const { cx, finish } = context(api, {
          sessionId: p.sessionId, actorId: p.actorId ?? p.call?.actorId,
          turnId: p.turnId, stepId: p.stepId ?? p.call?.stepId, callId: p.call?.id,
        }, work, options?.inProcessOnly);
        try {
          const snapshot = structuredClone(payload);
          if (!served && point === "turn.before" && p.sessionId) Object.assign(snapshot, {
            project: api.session(p.sessionId).project, tools: structuredClone(api.tools(p.sessionId)),
          });
          const answer = await handler(snapshot, cx);
          if (answer === undefined || answer === null) return;
          if ((point === "tool.before" || point === "plugin.load") && answer === "allow" ||
              point === "step.after" && answer === "continue" || point === "turn.result" && answer === "accept") return;
          if (point === "model.failed" && answer === "stop") return { retry: false };
          return change(point, payload as unknown as Record<string, unknown>, answer as Record<string, unknown>);
        } finally { finish(); }
      }, order));
    },
    command(name, description, handler, options) {
      add(`command:${name}`);
      if (served && (options?.usesModel || options?.inProcessOnly)) unavailable(`command ${name}`);
      if (options?.usesModel) throw new AgentError("not_supported", `Model-using command ${name}`);
      registrations.push(api => api.registerCommand(name, { description, async run(args, ids) {
        const { cx, finish } = context(api, { sessionId: ids.sessionId, actorId: ids.actorId }, ids as Work, options?.inProcessOnly);
        try { return await handler(args, cx as CommandContext); }
        finally { finish(); }
      } }));
    },
    defineHook(name, rule) {
      check();
      if (served) unavailable(`hook ${name}`);
      registrations.push(api => api.defineHook(name, rule === "firstAnswer" ? "first" : rule));
    },
  };
  try { await plugin.setup(r); }
  finally { settingUp = false; }
  const replaces = plugin.replaces ?? [];
  if (new Set(replaces).size !== replaces.length || replaces.some(key => !items.has(key))) {
    throw new AgentError("invalid_composition", `Invalid replacements in ${plugin.name}`);
  }
  const base: BasePlugin = { name: plugin.name, stop: plugin.stop?.bind(plugin), setup(api) {
    if (tools.length) api.provide("tool-source", toolSource(plugin.name, tools));
    for (const register of registrations) register(api);
  } };
  return { items, base, interfaces };
}
