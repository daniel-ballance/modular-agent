import { untilAborted, inputIdOf, isToolCall, textOf, type AgentEvent, type InputRequest, type PluginApi, type TurnOutcome } from "@modular-agent/harness";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { Actor, Answer, Content, Declaration, Question, Right, ToolCall, HistoryEntry, InputTiming, InputReceipt, Input, Outcome, QuestionHandler, Settings, ToolStatus, TurnResult, Usage } from "./data.js";
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

type Scope = { time: number; sessionId: string; turnId?: string; stepId?: string; toolCallId?: string; actorId?: string; jobId?: string };
type Empty = Record<string, never>;
export interface EventData {
  sessionStarted: { meta: { id: string; created: number; project: string }; resumed?: boolean };
  sessionEnded: Empty;
  sessionInterrupted: { reason: "commitFailed" | "writerLost" };
  actorJoined: { actor: Actor };
  actorLeft: { actorId: string };
  inputAccepted: { inputId: string; taken: InputReceipt["taken"] };
  inputWithdrawn: { inputId: string; content: Content; reason: string };
  inputHandedBack: { inputId: string; content: Content; reason: string };
  turnStarted: { startedBy: { kind: "actor" | "job" | "plugin" | "answer" | "toolResult"; id: string } };
  turnEnded: { turnId: string; outcome: Outcome; result: TurnResult };
  stepStarted: Empty;
  stepEnded: { usage?: Usage };
  text: { delta: string };
  reasoning: { delta: string };
  toolInput: { delta: string; toolCallId?: string };
  audio: { data: string; mimeType: string };
  toolCall: { call: ToolCall };
  toolStarted: { call: ToolCall };
  toolOutput: { toolCallId: string; chunk: string; content?: Content };
  toolResult: { status: ToolStatus; content: Content; value?: unknown };
  questionOpened: { request: InputRequest; waiting?: boolean };
  questionAnswered: { requestId: string; actorId: string; value?: string; stored?: string; declined?: boolean; reason?: string };
  questionClosed: EventData["questionAnswered"];
  questionNoLongerAnswerable: { requestId: string };
  jobStarted: { job: { id: string; kind: string; actorId: string; sessionId: string } };
  jobProgress: { content: Content };
  jobEnded: { state: string; result: Content };
  entry: HistoryEntry;
  positionMoved: { to: string | null };
  entriesErased: { count: number };
  settingChanged: { key: string; value: unknown; appliesFrom: string };
  pluginLoaded: { plugin: string };
  pluginReplaced: { plugin: string };
  pluginUnloaded: { plugin: string };
}
type StandardEvent = keyof EventData;
export type Event = Scope & ({ [K in StandardEvent]: { type: K; data: EventData[K] } }[StandardEvent]
  | { type: `${string}.${string}`; data: unknown });

const names: Record<string, StandardEvent> = {
  "session.started": "sessionStarted", "session.ended": "sessionEnded", "session.joined": "actorJoined",
  "session.interrupted": "sessionInterrupted", "session.left": "actorLeft", "input.accepted": "inputAccepted", "input.withdrawn": "inputWithdrawn",
  "turn.started": "turnStarted", "step.started": "stepStarted", "step.ended": "stepEnded",
  "tool.call": "toolCall", "tool.started": "toolStarted", "tool.progress": "toolOutput",
  "tool.result.delivered": "toolResult", "input.request.opened": "questionOpened", "input.request.closed": "questionClosed",
  "input.request.answered": "questionAnswered", "input.request.unanswerable": "questionNoLongerAnswerable",
  "job.started": "jobStarted", "job.progress": "jobProgress", "job.ended": "jobEnded",
  "position.moved": "positionMoved", "entries.erased": "entriesErased", "setting.changed": "settingChanged", "input.handedBack": "inputHandedBack",
  "plugin.loaded": "pluginLoaded", "plugin.replaced": "pluginReplaced", "plugin.unloaded": "pluginUnloaded",
};
function eventOf(e: AgentEvent): Event | undefined {
  const { type, time, sessionId, turnId, stepId, toolCallId, actorId, jobId, data } = e;
  const scope = { time, sessionId, turnId, stepId, toolCallId, actorId, jobId };
  if (type === "model.output") {
    const { type, ...piece } = data;
    return { ...scope, type, data: piece };
  }
  if (type === "tool.progress" && toolCallId) return { ...scope, type: "toolOutput", data: { toolCallId, chunk: textOf(data.content), content: data.content } };
  if (type === "entry" || type === "entry.added") return { ...scope, type: "entry", data };
  if (type === "turn.ended" && turnId) return { ...scope, type: "turnEnded", data: { turnId, outcome: data.outcome, result: data.result } };
  if (type === "session.joined" && data.actor) {
    const { authority, ...actor } = data.actor;
    return { ...scope, type: "actorJoined", data: { actor: { ...actor, rights: authority } } };
  }
  if (Object.hasOwn(names, type)) return { ...scope, type: names[type], data } as Event;
  if (!/^(session|input|actor|turn|step|tool|model|provider|job|position|entries|plugin|capability)\./.test(type) && type.includes(".")) {
    return { ...scope, type: type as `${string}.${string}`, data };
  }
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
function structuredCloneResult(result: import("@modular-agent/harness").ToolResult, name: string): ToolResult {
  const saved = structuredClone(result);
  return { ...saved, name, text: () => textOf(saved.content) };
}

const noTurn = (inputId: string, disposition: "handled" | "handedBack"): PromptResult =>
  ({ inputId, disposition, text: "", openToolCalls: [], toolResults: () => [] });

export interface PromptOptions { key?: string; actor?: string; result?: import("./schema.js").Schema }
export interface Proposal { inputId: string; actorId: string; content: Content; time: number }
type Owner = { enabled: { severalActors: boolean; sessionLimits: boolean }; isOpen(): boolean; interruption: AbortSignal; fork(entry?: string): Promise<Session>; close(actor: string, delegatedBy?: string): Promise<void>; handler(handler?: QuestionHandler): void };
const local = "user";

export async function questionOf(api: PluginApi, request: InputRequest): Promise<Question> {
  const { id, kind, sessionId, question, details, options, timeLimitMs, answerers, credential } = request;
  const entry = (await api.readHistory(sessionId, { all: true })).findLast(e => e.kind === "inputRequest" && e.requestId === id);
  return structuredClone({ id, kind, sessionId, question, details, options, answerers, credential,
    ...(request.coversNested ? { coversNested: true as const } : {}),
    ...(request.approvalWait ? { approvalWait: request.approvalWait } : {}),
    call: (entry?.data as { call?: ToolCall } | undefined)?.call,
    deadline: timeLimitMs === undefined || !entry ? undefined : entry.time + timeLimitMs });
}

export async function exactLocalApproval(api: PluginApi, q: Question, actor: string) {
  return isDeepStrictEqual(await api.gateOutput(q.sessionId, actor, "input.request.opened", structuredClone(q)), q);
}

export async function submitAnswer(api: PluginApi, request: InputRequest, actorId: string, answer: Answer, delegatedBy?: string, handle?: object): Promise<void> {
  const { sessionId, id, kind } = request;
  const decline = answer === "decline" || (answer && typeof answer === "object" && "declined" in answer && answer.declined === true);
  const value = answer === "allow" ? "allow" : answer && typeof answer === "object" && "value" in answer ? answer.value : undefined;
  const reason = answer && typeof answer === "object" && "reason" in answer ? answer.reason : undefined;
  if (!decline && (kind === "approval" ? answer !== "allow" : typeof value !== "string" || answer === "allow") ||
      !decline && kind === "choice" && !request.options?.includes(value!)) {
    throw new AgentError("invalid_params", "Answer does not match the question");
  }
  const reply = { requestId: id, actorId, delegatedBy, ...(decline ? { declined: true, reason } : { value }) };
  const result = await api.submitAnswer(sessionId, reply, handle);
  if (!result.accepted) throw new AgentError("conflict", result.reason ?? "Question is already closed");
}
export let makeSession: (id: string, api: PluginApi, owner: Owner) => Session;

export class Session {
  static { makeSession = (id, api, owner) => new Session(id, api, owner); }
  #api: PluginApi;
  #owner: Owner;
  #deliveredCovered = new Set<string>();
  private constructor(readonly id: string, api: PluginApi, owner: Owner, private readonly actor = local) { this.#api = api; this.#owner = owner; }

  #require(right: Right, actor = this.actor) {
    this.#check();
    const actors = this.#api.session(this.id).actors;
    if (![local, this.actor, actor].every(id => actors.find(a => a.id === id)?.authority.includes(right))) {
      throw new AgentError("forbidden", `Actor ${actor} may not ${right}`);
    }
  }
  as(actorId: string): Session {
    this.#check();
    if (actorId === this.actor) return this;
    if (!this.#owner.enabled.severalActors) throw new AgentError("not_supported", "Several actors are disabled");
    if (this.actor !== local) throw new AgentError("forbidden", "Select actors from the local session");
    if (!this.#api.session(this.id).actors.some(a => a.id === actorId)) throw new AgentError("not_found", "Actor is not joined");
    return new Session(this.id, this.#api, this.#owner, actorId);
  }
  async join(actor: Actor, grantedBy = this.actor): Promise<void> {
    this.#check();
    if (!this.#owner.enabled.severalActors) throw new AgentError("not_supported", "Several actors are disabled");
    this.#require("grant", grantedBy);
    if (this.#api.session(this.id).actors.some(a => a.id === actor.id)) throw new AgentError("conflict", "Actor is already joined");
    const { rights, ...identity } = structuredClone(actor);
    const actors = this.#api.session(this.id).actors;
    if (!rights.every(right => [local, this.actor, grantedBy].every(id => actors.find(a => a.id === id)?.authority.includes(right)))) {
      throw new AgentError("forbidden", "Cannot grant a right outside shared authority");
    }
    await checked(() => this.#api.join(this.id, { ...identity, authority: rights }, grantedBy));
  }
  async leave(actorId: string): Promise<void> {
    this.#check();
    if (!this.#owner.enabled.severalActors) throw new AgentError("not_supported", "Several actors are disabled");
    if (actorId !== this.actor) this.#require("grant");
    if (!this.#api.session(this.id).actors.some(a => a.id === actorId)) throw new AgentError("not_found", "Actor is not joined");
    await checked(() => this.#api.leave(this.id, actorId, this.actor));
  }
  async setLimit(rights?: Right[]): Promise<void> {
    this.#check();
    if (!this.#owner.enabled.sessionLimits) throw new AgentError("not_supported", "Session limits are disabled");
    this.#require("administer");
    await checked(() => this.#api.setLimit(this.id, rights ? [...rights] : null, this.actor));
  }

  #check() {
    if (!this.#owner.isOpen() || this.#owner.interruption.aborted) throw new AgentError("not_open", `Session ${this.id} is closed`);
  }
  async send(input: Input, timing: InputTiming, options: PromptOptions = {}): Promise<InputReceipt> {
    this.#check();
    if (options.result !== undefined && timing !== "now") throw new AgentError("invalid_params", "Only a prompt can request a structured turn result");
    const actor = options.actor ?? this.actor;
    if (!this.#owner.enabled.severalActors && (actor !== local || timing === "propose")) {
      throw new AgentError("not_supported", "Several actors are disabled");
    }
    if (this.actor !== local && actor !== this.actor) throw new AgentError("forbidden", "This view is bound to one actor");
    if (!["now", "steer", "after", "propose"].includes(timing) || options.key !== undefined && typeof options.key !== "string" ||
      typeof input !== "string" && (!Array.isArray(input) || input.some(p => typeof p?.type !== "string"))) {
      throw new AgentError("invalid_params", "Invalid input, timing or key");
    }
    if (options.key === "") throw new AgentError("invalid_params", "Input key must not be empty");
    const resultShape = options.result === undefined ? undefined : await checked(() => schema(options.result!).parameters, "invalid_params");
    this.#require(timing === "propose" ? "propose" : "input", actor);
    return checked(() => this.#api.input(this.id, { content: structuredClone(input), when: timing, key: options.key,
      actorId: actor, delegatedBy: actor === local ? undefined : local, resultShape }));
  }

  async #run(input: Input, options: PromptOptions, stream?: { event(e: AgentEvent): void; admitted(id: string): void; lag(): void }): Promise<PromptResult> {
    this.#check();
    const view = options.actor === undefined ? this : this.as(options.actor);
    const signal = AbortSignal.any([this.#api.sessionInterruption(this.id), this.#owner.interruption]);
    let wake: () => void = () => {};
    const off = this.#api.follow(this.id, { recipient: view.actor, onLag: stream?.lag }, e => { stream?.event(e); wake(); });
    try { return await untilAborted(signal, async () => {
      const receipt = await this.send(input, "now", options) as InputReceipt & { handled?: boolean };
      const id = receipt.inputId;
      stream?.admitted(id);
      if (receipt.handled) return noTurn(id, "handled");
      if (receipt.erased) throw new AgentError("not_found", "Input key refers to erased input");
      for (;;) {
        signal.throwIfAborted();
        const changed = new Promise<void>(r => { wake = r; });
        const raw = await this.#api.readHistory(this.id, { all: true });
        const freshness = await this.#api.checkPending(this.id);
        const entries = await view.history();
        const turn = entries.find(e => e.kind === "input" && inputIdOf(e) === id)?.turnId;
        const end = turn && entries.find(e => e.kind === "turnEnd" && e.turnId === turn && !e.erased);
        if (end) { await off.idle(); const result = readTurn(entries, end); if (await this.#api.checkPending(this.id) !== freshness) throw new AgentError("unavailable", "Erasure changed the prompt result"); return result; }
        const rawTurn = raw.find(e => e.kind === "input" && inputIdOf(e) === id)?.turnId;
        if (rawTurn && raw.some(e => e.kind === "turnEnd" && e.turnId === rawTurn && !e.erased)) {
          throw new AgentError("withheld", "Turn result was withheld");
        }
        if (entries.some(e => e.kind === "inputHandedBack" && e.inputId === id)) return noTurn(id, "handedBack");
        if (!this.#api.session(this.id).busy && (await this.#api.readHistory(this.id, { all: true })).length === entries.length) {
          throw new AgentError("lost", "Input did not settle");
        }
        await Promise.race([changed, delay(25)]);
      }
    }); } finally { off(); }
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
    let terminal: Extract<Event, { type: "turnEnded" }> | undefined;
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
      if (admission && !turn) turn = (await this.#api.readHistory(this.id, { all: true }))
        .find(e => e.kind === "input" && inputIdOf(e) === admission)?.turnId;
      if (turn) {
        for (const e of queue.splice(0)) {
          if (e.turnId !== turn && !((e.type === "entry" || e.type === "entry.added") && e.data?.turnId === turn)) continue;
          const event = eventOf(e);
          if (overflow) throw new AgentError("lost", "Prompt event reader fell behind", { fromEntry: cursor });
          if (event?.type === "entry") cursor = event.data.id;
          if (event?.type === "turnEnded") terminal = event;
          else if (event) { await this.#api.checkPending(this.id); yield event; }
        }
      } else if (settled) break;
      if (!settled && (!turn || !queue.length)) await new Promise<void>(r => { wake = r; });
    }
    await run;
    if (failure) throw sdkError(failure);
    if (result?.turnId && result.outcome) {
      if (!terminal) throw new AgentError("withheld", "Turn outcome was withheld");
      await this.#api.checkPending(this.id);
      yield terminal;
    }
  }

  async *events(fromEntry?: string | null): AsyncIterable<Event> {
    this.#require("watch");
    const snapshot = this.#api.readHistory(this.id, { all: true });
    const entries = snapshot instanceof Promise ? await snapshot : snapshot;
    const index = fromEntry == null ? -1 : entries.findIndex(e => e.id === fromEntry);
    if (fromEntry != null && index < 0) throw new AgentError("not_found", "Unknown entry cursor");
    let wake = () => {};
    const queue: AgentEvent[] = [];
    let dropped = false;
    let cursor: string | null = null;
    const lag = () => { dropped = true; wake(); };
    // Snapshot the committed watermark and subscribe synchronously. Gate replay
    // on demand so a long history alone cannot make a new subscriber lag.
    const off = this.#api.follow(this.id, { recipient: this.actor, onLag: lag }, e => {
      if (queue.length >= 1024) {
        lag();
        off();
      } else queue.push(e);
      wake();
    });
    const writer = this.#api.sessionInterruption(this.id);
    let interrupted = writer.aborted;
    const stopFollowing = () => { void off.idle().then(() => { interrupted = true; wake(); }); };
    writer.addEventListener("abort", stopFollowing, { once: true });
    const interruption = () => wake();
    this.#owner.interruption.addEventListener("abort", interruption, { once: true });
    const check = () => {
      if (dropped || this.#owner.interruption.aborted) throw new AgentError("lost", "Session event stream disconnected", { fromEntry: cursor });
    };
    try {
      if (index >= 0 && !await this.#api.gateOutput(this.id, this.actor, "entry", entries[index])) {
        throw new AgentError("not_found", "Unknown entry cursor");
      }
      for (const entry of entries.slice(index + 1)) {
        check();
        const view = await this.#api.gateOutput(this.id, this.actor, "entry", entry);
        check();
        if (!view) continue;
        cursor = view.id;
        yield { type: "entry", time: view.time, sessionId: this.id, data: structuredClone(view) };
      }
      for (;;) {
        check();
        const next = queue.shift();
        if (!next) {
          if (interrupted) return;
          await new Promise<void>(r => { wake = r; });
          continue;
        }
        const event = eventOf(next);
        if (!event) continue;
        if (event.type === "entry") cursor = event.data.id;
        if (event.type !== "sessionEnded" && event.type !== "sessionInterrupted") await this.#api.checkPending(this.id);
        yield structuredClone(event);
        if (event.type === "sessionEnded" || event.type === "sessionInterrupted") return;
      }
    } finally {
      writer.removeEventListener("abort", stopFollowing);
      this.#owner.interruption.removeEventListener("abort", interruption);
      off();
    }
  }

  commands(): { name: string; description: string }[] {
    this.#require("watch");
    return this.#api.commands().map(({ name, description }) => ({ name, description }));
  }
  async runCommand(line: string): Promise<string | void> {
    this.#require("input");
    const name = /^\/(\S+)/.exec(line.trim())?.[1];
    if (!name) throw new AgentError("invalid_params", "A command starts with /");
    if (!this.commands().some(c => c.name === name)) throw new AgentError("not_found", `Unknown command /${name}`);
    const result = await checked(() => this.#api.runCommand(this.id, line, this.actor));
    if (result === undefined) return;
    const view = await this.#api.gateOutput(this.id, this.actor, "command.result", result);
    if (view === undefined) throw new AgentError("withheld", "Command result was withheld");
    return view;
  }

  declaration(): Declaration {
    this.#require("watch");
    const declaration = this.#api.declaration(this.id);
    return { ...declaration, lateAnswersStartTurns: declaration.questionsOutlastTurns === true };
  }

  async lastTurn(): Promise<PromptResult | undefined> {
    const entries = await this.history();
    const end = entries.findLast(e => e.kind === "turnEnd" && !e.erased);
    return end && readTurn(entries, end);
  }
  async history(options: { all?: boolean } = {}): Promise<HistoryEntry[]> {
    this.#require("watch");
    return checked(async () => structuredClone(await this.#api.gatedHistory(this.id, { recipient: this.actor, all: options.all ?? true })));
  }
  /** Wait for the current turn and its queued follow-up inputs to settle. */
  async waitIdle(): Promise<void> {
    this.#require("watch");
    await checked(() => this.#api.waitForIdle(this.id));
  }
  settings(): Settings { this.#require("watch"); return structuredClone(this.#api.session(this.id).settings); }
  async setSetting(key: string, value: unknown): Promise<void> {
    this.#require("settings");
    if (typeof key !== "string" || !key) throw new AgentError("invalid_params", "A setting key is required");
    await checked(() => this.#api.setSetting(this.id, key, structuredClone(value), this.actor), "invalid_params");
  }
  async erase(entryIds: string[]): Promise<{ erased: { sessionId: string; id: string }[]; pending: { sessionId: string; id: string }[]; outOfReach: string[] }> {
    this.#require("erase");
    if (this.#api.declaration(this.id).erasure !== true) throw new AgentError("not_supported", "This store does not support erasure");
    const report = await checked(() => this.#api.erase(this.id, entryIds, this.actor));
    return { erased: report.erasedPairs, pending: report.pendingPairs, outOfReach: report.outOfReach };
  }
  async proposals(): Promise<Proposal[]> {
    this.#require("watch");
    if (!this.#owner.enabled.severalActors) throw new AgentError("not_supported", "Several actors are disabled");
    const proposals = await this.#api.gateOutput(this.id, this.actor, "input.proposals", this.#api.proposals(this.id, this.actor));
    if (!proposals) throw new AgentError("withheld", "Proposals were withheld");
    return structuredClone(proposals);
  }
  async release(inputId: string, timing: Exclude<InputTiming, "propose"> = "now", options?: { declined?: boolean }): Promise<InputReceipt> {
    this.#require("input");
    if (!this.#owner.enabled.severalActors) throw new AgentError("not_supported", "Several actors are disabled");
    if (!inputId || !["now", "steer", "after"].includes(timing)) throw new AgentError("invalid_params", "Invalid proposal or timing");
    return checked(() => this.#api.releaseInput(this.id, inputId, timing, this.actor, options?.declined === true));
  }
  async withdraw(inputId: string): Promise<void> {
    this.#check();
    if (!this.#owner.enabled.severalActors) throw new AgentError("not_supported", "Several actors are disabled");
    if (!inputId) throw new AgentError("invalid_params", "A proposal id is required");
    await checked(() => this.#api.withdrawProposal(this.id, inputId, this.actor, this.actor === local ? undefined : local));
  }
  async cancel(): Promise<{ inputId: string; content: Content }[]> {
    this.#require("cancel");
    return checked(async () => (await this.#api.cancel(this.id)).map(q => ({ inputId: q.id, content: structuredClone(q.content) })));
  }
  async fork(entryId?: string): Promise<Session> {
    this.#require("settings");
    const fork = await this.#owner.fork(entryId);
    return this.actor === local ? fork : fork.as(this.actor);
  }
  async moveTo(entryId: string, options?: { rewind?: boolean }): Promise<{ outOfReach?: string[] }> {
    this.#require("settings");
    if (typeof entryId !== "string" || !entryId) throw new AgentError("invalid_params", "An entry id is required");
    return checked(() => this.#api.moveTo(this.id, entryId, { ...options, actorId: this.actor }));
  }
  async callTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    this.#require("tools");
    if (typeof name !== "string" || !name || !input || typeof input !== "object" || Array.isArray(input)) {
      throw new AgentError("invalid_params", "A tool name and input object are required");
    }
    if (!this.#api.tools(this.id).some(t => t.name === name)) throw new AgentError("not_found", `Unknown tool ${name}`);
    const result = await checked(() => this.#api.callTool(this.id, { name, input: structuredClone(input), startedBy: "ui", actorId: this.actor }));
    const view = await this.#api.gateOutput(this.id, this.actor, "tool.result", result);
    if (!view) throw new AgentError("withheld", "Tool result was withheld");
    return structuredCloneResult(view, name);
  }
  async questions(options: { present?: boolean } = {}): Promise<Question[]> {
    this.#require("watch");
    if (options.present && !this.#api.declaration(this.id).approvalsOutlastTurns) throw new AgentError("not_supported", "Polling as present requires waiting approvals");
    await this.#api.refreshApprovals(this.id);
    this.#deliveredCovered.clear();
    const visible = await Promise.all(this.#api.openRequests(this.id).map(async request => {
      const question = await questionOf(this.#api, request);
      if (options.present && request.approvalWait) {
        return await this.#api.presentApproval(this.id, request.id, { routeId: "sdk.local", handle: this, actorId: this.actor,
          submittedBy: local, present: () => this.#owner.isOpen() }) ? question : undefined;
      }
      if (request.coversNested && !request.approvalWait) {
        if (!await exactLocalApproval(this.#api, question, this.actor)) return;
        this.#deliveredCovered.add(request.id);
        return question;
      }
      return this.#api.gateOutput(this.id, this.actor, "input.request.opened", question);
    }));
    const open = new Set(this.#api.openRequests(this.id).map(request => request.id));
    return visible.flatMap(q => q && open.has(q.id) ? [structuredClone(q)] : []);
  }
  async answer(id: string, answer: Answer): Promise<void> {
    this.#check();
    const request = this.#api.openRequests(this.id).find(r => r.id === id);
    if (!request) throw new AgentError("not_found", "No such open question");
    this.#require(request.kind === "approval" ? "approve" : "answer");
    if (request.answerers.length && !request.answerers.includes(this.actor)) throw new AgentError("forbidden", "Actor is not an eligible answerer");
    if (request.coversNested && !request.approvalWait && (!this.#deliveredCovered.has(id) ||
        !await exactLocalApproval(this.#api, await questionOf(this.#api, request), this.actor))) throw new AgentError("forbidden", "No unchanged approval view on this route");
    await checked(() => submitAnswer(this.#api, request, this.actor, answer, this.actor === local ? undefined : local, this));
  }
  onQuestion(handler?: QuestionHandler): void {
    this.#check();
    if (this.actor !== local) throw new AgentError("forbidden", "Register a handler on the local session");
    this.#owner.handler(handler);
  }
  async close(): Promise<void> {
    if (!this.#owner.isOpen()) return;
    await this.#owner.close(this.actor, this.actor === local ? undefined : local);
  }
}
