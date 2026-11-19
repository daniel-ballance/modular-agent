import { inputHandedBackIds, inputIdOf, isToolCall, textOf, type AgentEvent, type PluginApi, type TurnOutcome } from "@modular-agent/harness";
import { setTimeout as delay } from "node:timers/promises";
import type { Content, HistoryEntry, InputTiming, InputReceipt, Input, Outcome, QuestionHandler, Settings, ToolStatus, TurnResult, Usage } from "./data.js";
import { AgentError, checked, sdkError } from "./errors.js";

export interface ToolResult {
  callId: string;
  name: string;
  status: ToolStatus;
  content: Content;
  value?: unknown;
  text(): string;
}
export interface PromptResult {
  inputId: string;
  disposition: "turn" | "handled" | "handedBack";
  outcome?: Outcome;
  text: string;
  value?: unknown;
  turnId?: string;
  openToolCalls: string[];
  usage?: Usage;
  toolResults(): ToolResult[];
}

type Scope = { time: number; sessionId: string; turnId?: string; stepId?: string; toolCallId?: string; actorId?: string };
export type Event = Scope & (
  | { type: "text" | "reasoning" | "toolInput"; data: { delta: string } }
  | { type: "turnEnded"; data: { turnId: string; outcome: Outcome; result: TurnResult } }
  | { type: "entry"; data: HistoryEntry }
  | { type: StandardEvent | `${string}.${string}`; data: unknown }
);
type StandardEvent = "sessionStarted" | "sessionEnded" | "actorJoined" | "actorLeft" | "inputAccepted"
  | "inputWithdrawn" | "inputHandedBack" | "turnStarted" | "stepStarted" | "stepEnded" | "toolCall"
  | "toolStarted" | "toolOutput" | "toolResult" | "questionOpened" | "questionAnswered" | "questionClosed"
  | "questionNoLongerAnswerable" | "jobStarted" | "jobProgress" | "jobEnded" | "positionMoved"
  | "entriesErased" | "settingChanged" | "pluginLoaded" | "pluginReplaced" | "pluginUnloaded" | "audio";

const names: Record<string, StandardEvent> = {
  "session.started": "sessionStarted", "session.ended": "sessionEnded", "session.joined": "actorJoined",
  "session.left": "actorLeft", "input.accepted": "inputAccepted", "input.withdrawn": "inputWithdrawn",
  "turn.started": "turnStarted", "step.started": "stepStarted", "step.ended": "stepEnded",
  "tool.call": "toolCall", "tool.started": "toolStarted", "tool.progress": "toolOutput",
  "tool.result": "toolResult", "input.request.opened": "questionOpened", "input.request.closed": "questionClosed",
  "job.started": "jobStarted", "job.progress": "jobProgress", "job.ended": "jobEnded",
  "history.position": "positionMoved", "history.erased": "entriesErased", "setting.changed": "settingChanged",
  "plugin.loaded": "pluginLoaded", "plugin.replaced": "pluginReplaced", "plugin.unloaded": "pluginUnloaded",
};
function eventOf(e: AgentEvent): Event | undefined {
  const { type, time, sessionId, turnId, stepId, toolCallId, actorId, data } = e;
  const scope = { time, sessionId, turnId, stepId, toolCallId, actorId };
  if (type === "model.output") {
    const { type, ...piece } = data;
    return { ...scope, type, data: piece };
  }
  if (type === "entry" || type === "entry.added") return { ...scope, type: "entry", data };
  if (type === "turn.ended" && turnId) return { ...scope, type: "turnEnded", data: { turnId, outcome: data.outcome, result: data.result } };
  if (names[type]) return { ...scope, type: names[type], data };
  if (!["model.streamEnd", "tool.ended"].includes(type) && type.includes(".")) return { ...scope, type: type as `${string}.${string}`, data };
}

function readTurn(entries: HistoryEntry[], end: HistoryEntry): PromptResult {
  const { outcome, result, usage } = end.data as TurnOutcome;
  const turn = entries.filter(e => e.turnId === end.turnId);
  const order = new Map<string, number>();
  for (const e of turn) {
    if (e.message?.role === "assistant") {
      for (const part of e.message.content.filter(isToolCall)) order.set(part.id, order.size);
    }
  }
  const results = turn.flatMap(e => {
    if (e.erased || e.kind !== "toolResult" || e.message?.role !== "toolResult") return [];
    const { content, toolCallId: callId, toolName: name } = e.message;
    const { status, value } = e.data as { status: ToolStatus; value?: unknown };
    return [{ callId, name, content, status, value, text: () => textOf(content) }];
  }).sort((a, b) => (order.get(a.callId) ?? Infinity) - (order.get(b.callId) ?? Infinity));
  return {
    inputId: turn.find(e => e.kind === "input")?.inputId ?? "", disposition: "turn", turnId: end.turnId,
    text: result.text ?? "", value: result.value, openToolCalls: result.openToolCalls, outcome, usage,
    toolResults: () => results.slice(),
  };
}
const noTurn = (inputId: string, disposition: "handled" | "handedBack"): PromptResult =>
  ({ inputId, disposition, text: "", openToolCalls: [], toolResults: () => [] });

export interface PromptOptions { key?: string; actor?: string }
type Owner = { fork(entry?: string): Promise<Session>; close(): Promise<void>; handler(handler?: QuestionHandler): void };
const local = "user";
export let makeSession: (id: string, api: PluginApi, owner: Owner) => Session;

export class Session {
  static { makeSession = (id, api, owner) => new Session(id, api, owner); }
  #api: PluginApi;
  #owner: Owner;
  #open = true;
  private constructor(readonly id: string, api: PluginApi, owner: Owner) { this.#api = api; this.#owner = owner; }

  #check() {
    if (!this.#open) throw new AgentError("not_open", `Session ${this.id} is closed`);
  }
  async send(input: Input, timing: InputTiming, options: PromptOptions = {}): Promise<InputReceipt> {
    this.#check();
    if (options.actor !== undefined && options.actor !== local) throw new AgentError("forbidden", "Only the local actor is supported");
    if (!["now", "steer", "after", "propose"].includes(timing) || options.key !== undefined && typeof options.key !== "string" ||
      typeof input !== "string" && (!Array.isArray(input) || input.some(p => typeof p?.type !== "string"))) {
      throw new AgentError("invalid_params", "Invalid input, timing or key");
    }
    if (options.key === "") throw new AgentError("invalid_params", "Input key must not be empty");
    return checked(() => this.#api.input(this.id, { content: structuredClone(input), when: timing, key: options.key, actorId: local }));
  }

  async #run(input: Input, options: PromptOptions, stream?: { event(e: AgentEvent): void; admitted(id: string): void }): Promise<PromptResult> {
    this.#check();
    let wake: () => void = () => {};
    const off = this.#api.follow(this.id, { recipient: local }, e => { stream?.event(e); wake(); });
    try {
      const receipt = await this.send(input, "now", options) as InputReceipt & { handled?: boolean };
      const id = receipt.inputId;
      stream?.admitted(id);
      if (receipt.handled) return noTurn(id, "handled");
      if (receipt.erased) throw new AgentError("not_found", "Input key refers to erased input");
      for (;;) {
        const changed = new Promise<void>(r => { wake = r; });
        const entries = await this.history();
        const turn = entries.find(e => e.kind === "input" && inputIdOf(e) === id)?.turnId;
        const end = turn && entries.find(e => e.kind === "turnEnd" && e.turnId === turn && !e.erased);
        if (end) { await off.idle(); return readTurn(entries, end); }
        if (entries.some(e => e.kind === "inputHandedBack" && inputHandedBackIds(e).includes(id))) return noTurn(id, "handedBack");
        if (!this.#api.session(this.id).busy && this.#api.history(this.id, { all: true }).length === entries.length) {
          throw new AgentError("lost", "Input did not settle");
        }
        await Promise.race([changed, delay(25)]);
      }
    } finally { off(); }
  }

  async prompt(input: Input, options: PromptOptions = {}): Promise<PromptResult> {
    return checked(() => this.#run(input, options));
  }

  async *promptStream(input: Input, options: PromptOptions = {}): AsyncIterable<Event> {
    const queue: AgentEvent[] = [];
    let wake = () => {};
    let settled = false;
    let result: PromptResult | undefined;
    let failure: unknown;
    let overflow = false;
    let admission: string | undefined;
    let turn: string | undefined;
    const run = this.#run(input, options, {
      event(e) {
        if (queue.length >= 1024) overflow = true;
        else queue.push(e);
        wake();
      },
      admitted(id) { admission = id; wake(); },
    }).then(r => { result = r; }, e => { failure = e; }).finally(() => { settled = true; wake(); });
    while (!settled || queue.length) {
      if (overflow) throw new AgentError("lost", "Prompt event reader fell behind");
      if (settled) turn ??= result?.turnId;
      if (admission && !turn) turn = this.#api.history(this.id, { all: true })
        .find(e => e.kind === "input" && inputIdOf(e) === admission)?.turnId;
      if (turn) {
        for (const e of queue.splice(0)) {
          if (e.turnId !== turn && !((e.type === "entry" || e.type === "entry.added") && e.data?.turnId === turn)) continue;
          const event = eventOf(e);
          if (event && event.type !== "turnEnded") yield event;
        }
      } else if (settled) break;
      if (!settled && (!turn || !queue.length)) await new Promise<void>(r => { wake = r; });
    }
    await run;
    if (failure) throw sdkError(failure);
    if (result?.turnId && result.outcome) yield {
      type: "turnEnded", time: Date.now(), sessionId: this.id, turnId: result.turnId,
      data: { turnId: result.turnId, outcome: result.outcome, result: {
        text: result.text, value: result.value, openToolCalls: result.openToolCalls,
      } },
    };
  }

  async lastTurn(): Promise<PromptResult | undefined> {
    const entries = await this.history();
    const end = entries.findLast(e => e.kind === "turnEnd" && !e.erased);
    return end && readTurn(entries, end);
  }
  async history(options: { all?: boolean } = {}): Promise<HistoryEntry[]> {
    this.#check();
    return checked(async () => structuredClone(await this.#api.gatedHistory(this.id, { recipient: local, all: options.all ?? true })));
  }
  settings(): Settings { this.#check(); return structuredClone(this.#api.session(this.id).settings); }
  async setSetting(key: string, value: unknown): Promise<void> {
    this.#check();
    if (typeof key !== "string" || !key) throw new AgentError("invalid_params", "A setting key is required");
    await checked(() => this.#api.setSetting(this.id, key, structuredClone(value), local), "invalid_params");
  }
  async cancel(): Promise<{ inputId: string; content: Content }[]> {
    this.#check();
    return checked(async () => (await this.#api.cancel(this.id)).map(q => ({ inputId: q.id, content: structuredClone(q.content) })));
  }
  async fork(entryId?: string): Promise<Session> { this.#check(); return this.#owner.fork(entryId); }
  onQuestion(handler?: QuestionHandler): void { this.#check(); this.#owner.handler(handler); }
  async close(): Promise<void> {
    if (!this.#open) return;
    await this.#owner.close();
    this.#open = false;
  }
}
