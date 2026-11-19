import { inputHandedBackIds, inputIdOf, isToolCall, textOf, type AgentEvent, type PluginApi, type TurnOutcome } from "@modular-agent/harness";
import { setTimeout as delay } from "node:timers/promises";
import type { Content, HistoryEntry, InputTiming, InputReceipt, Input, Outcome, QuestionHandler, Settings, ToolStatus, TurnResult, Usage } from "./data.js";
import { AgentError, checked, sdkError } from "./errors.js";
import { schema } from "./schema.js";

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
    if (e.kind === "response" && e.modelVisible && e.message?.role === "assistant") {
      for (const part of e.message.content.filter(isToolCall)) order.set(part.id, order.size);
    }
  }
  const results = turn.flatMap(e => {
    if (e.erased || e.kind !== "toolResult" || e.message?.role !== "toolResult") return [];
    const { content, toolCallId: callId, toolName: name } = e.message;
    if (!order.has(callId)) return [];
    const { status, value } = e.data as { status: ToolStatus; value?: unknown };
    return [{ callId, name, content, status, value, text: () => textOf(content) }];
  }).sort((a, b) => order.get(a.callId)! - order.get(b.callId)!);
  return {
    inputId: turn.find(e => e.kind === "input")?.inputId ?? "", disposition: "turn", turnId: end.turnId,
    text: result.text ?? "", value: result.value, openToolCalls: result.openToolCalls, outcome, usage,
    toolResults: () => results.slice(),
  };
}
const noTurn = (inputId: string, disposition: "handled" | "handedBack"): PromptResult =>
  ({ inputId, disposition, text: "", openToolCalls: [], toolResults: () => [] });

export interface PromptOptions { key?: string; actor?: string; result?: import("./schema.js").Schema }
type Owner = { interruption: AbortSignal; fork(entry?: string): Promise<Session>; close(): Promise<void>; handler(handler?: QuestionHandler): void };
const local = "user";
export let makeSession: (id: string, api: PluginApi, owner: Owner) => Session;

export class Session {
  static { makeSession = (id, api, owner) => new Session(id, api, owner); }
  #api: PluginApi;
  #owner: Owner;
  #open = true;
  private constructor(readonly id: string, api: PluginApi, owner: Owner) { this.#api = api; this.#owner = owner; }

  #check() {
    if (!this.#open || this.#owner.interruption.aborted) throw new AgentError("not_open", `Session ${this.id} is closed`);
  }
  async send(input: Input, timing: InputTiming, options: PromptOptions = {}): Promise<InputReceipt> {
    this.#check();
    if (options.result !== undefined && timing !== "now") throw new AgentError("invalid_params", "Only a prompt can request a structured turn result");
    if (options.actor !== undefined && options.actor !== local) throw new AgentError("forbidden", "Only the local actor is supported");
    if (!["now", "steer", "after", "propose"].includes(timing) || options.key !== undefined && typeof options.key !== "string" ||
      typeof input !== "string" && (!Array.isArray(input) || input.some(p => typeof p?.type !== "string"))) {
      throw new AgentError("invalid_params", "Invalid input, timing or key");
    }
    if (options.key === "") throw new AgentError("invalid_params", "Input key must not be empty");
    const resultShape = options.result === undefined ? undefined : await checked(() => schema(options.result!).parameters, "invalid_params");
    return checked(() => this.#api.input(this.id, { content: structuredClone(input), when: timing, key: options.key, actorId: local, resultShape }));
  }

  async #run(input: Input, options: PromptOptions, stream?: { event(e: AgentEvent): void; admitted(id: string): void; lag(): void }): Promise<PromptResult> {
    this.#check();
    let wake: () => void = () => {};
    const off = this.#api.follow(this.id, { recipient: local, onLag: stream?.lag }, e => { stream?.event(e); wake(); });
    try {
      const receipt = await this.send(input, "now", options) as InputReceipt & { handled?: boolean };
      const id = receipt.inputId;
      stream?.admitted(id);
      if (receipt.handled) return noTurn(id, "handled");
      if (receipt.erased) throw new AgentError("not_found", "Input key refers to erased input");
      for (;;) {
        if (this.#owner.interruption.aborted) throw new AgentError("lost", "Agent was interrupted");
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
    let cursor: string | null = null;
    let admission: string | undefined;
    let turn: string | undefined;
    const run = this.#run(input, options, {
      event(e) {
        if (queue.length >= 1024) overflow = true;
        else queue.push(e);
        wake();
      },
      admitted(id) { admission = id; wake(); },
      lag() { overflow = true; wake(); },
    }).then(r => { result = r; }, e => { failure = e; }).finally(() => { settled = true; wake(); });
    while (!settled || queue.length) {
      if (overflow) throw new AgentError("lost", "Prompt event reader fell behind", { fromEntry: cursor });
      if (settled) turn ??= result?.turnId;
      if (admission && !turn) turn = this.#api.history(this.id, { all: true })
        .find(e => e.kind === "input" && inputIdOf(e) === admission)?.turnId;
      if (turn) {
        for (const e of queue.splice(0)) {
          if (e.turnId !== turn && !((e.type === "entry" || e.type === "entry.added") && e.data?.turnId === turn)) continue;
          const event = eventOf(e);
          if (overflow) throw new AgentError("lost", "Prompt event reader fell behind", { fromEntry: cursor });
          if (event?.type === "entry") cursor = event.data.id;
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

  async *events(fromEntry?: string | null): AsyncIterable<Event> {
    this.#check();
    const entries = this.#api.history(this.id, { all: true });
    const index = fromEntry == null ? -1 : entries.findIndex(e => e.id === fromEntry);
    if (fromEntry != null && index < 0) throw new AgentError("not_found", "Unknown entry cursor");
    let wake = () => {};
    const queue: AgentEvent[] = [];
    let dropped = false;
    let cursor: string | null = null;
    const lag = () => { dropped = true; wake(); };
    // Snapshot the committed watermark and subscribe synchronously. Gate replay
    // on demand so a long history alone cannot make a new subscriber lag.
    const off = this.#api.follow(this.id, { recipient: local, onLag: lag }, e => {
      if (queue.length >= 1024) {
        lag();
        off();
      } else queue.push(e);
      wake();
    });
    const interruption = () => wake();
    this.#owner.interruption.addEventListener("abort", interruption, { once: true });
    const check = () => {
      if (dropped || this.#owner.interruption.aborted) throw new AgentError("lost", "Session event stream disconnected", { fromEntry: cursor });
    };
    try {
      if (index >= 0 && !await this.#api.gateOutput(this.id, local, "entry", entries[index])) {
        throw new AgentError("not_found", "Unknown entry cursor");
      }
      for (const entry of entries.slice(index + 1)) {
        check();
        const view = await this.#api.gateOutput(this.id, local, "entry", entry);
        check();
        if (!view) continue;
        cursor = view.id;
        yield { type: "entry", time: view.time, sessionId: this.id, data: structuredClone(view) };
      }
      for (;;) {
        check();
        const next = queue.shift();
        if (!next) { await new Promise<void>(r => { wake = r; }); continue; }
        const event = eventOf(next);
        if (!event) continue;
        if (event.type === "entry") cursor = event.data.id;
        yield structuredClone(event);
        if (event.type === "sessionEnded") return;
      }
    } finally {
      this.#owner.interruption.removeEventListener("abort", interruption);
      off();
    }
  }

  commands(): { name: string; description: string }[] {
    this.#check();
    return this.#api.commands().map(({ name, description }) => ({ name, description }));
  }
  async runCommand(line: string): Promise<string | void> {
    this.#check();
    const name = /^\/(\S+)/.exec(line.trim())?.[1];
    if (!name) throw new AgentError("invalid_params", "A command starts with /");
    if (!this.commands().some(c => c.name === name)) throw new AgentError("not_found", `Unknown command /${name}`);
    return checked(() => this.#api.runCommand(this.id, line, local));
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
  /** Wait for the current turn and its queued follow-up inputs to settle. */
  async waitIdle(): Promise<void> {
    this.#check();
    await checked(() => this.#api.waitForIdle(this.id));
  }
  settings(): Settings { this.#check(); return structuredClone(this.#api.session(this.id).settings); }
  async setSetting(key: string, value: unknown): Promise<void> {
    this.#check();
    if (typeof key !== "string" || !key) throw new AgentError("invalid_params", "A setting key is required");
    await checked(() => this.#api.setSetting(this.id, key, structuredClone(value), local), "invalid_params");
  }
  async erase(entryIds: string[]): Promise<import("@modular-agent/harness").ErasureReport> {
    this.#check();
    if (this.#api.declaration(this.id).erasure !== true) throw new AgentError("not_supported", "This store does not support erasure");
    return checked(() => this.#api.erase(this.id, entryIds, local));
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
