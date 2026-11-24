import type { ServerResponse } from "node:http";
import { inputIdOf, isText, textOf, type AgentEvent, type HistoryEntry, type InputRequest, type InterfaceToolConnection, type ToolCall } from "@modular-agent/harness";
import type { Interrupt } from "@ag-ui/core";
import type { Route } from "./agui.js";
import { assistantId, content, displayEntry, toolId } from "./agui-view.js";
import { MAX, errorCode, fail, frame, object, same, sse, type WireEvent } from "./agui-wire.js";

export const callFrames = (call: ToolCall, parentMessageId?: string): WireEvent[] => [
  { type: "TOOL_CALL_START", toolCallId: call.id, toolCallName: call.name, ...(parentMessageId ? { parentMessageId } : {}) },
  { type: "TOOL_CALL_ARGS", toolCallId: call.id, delta: JSON.stringify(call.input) }, { type: "TOOL_CALL_END", toolCallId: call.id },
];
const custom = (name: string, value: unknown) => ({ type: "CUSTOM", name, value });
const snapshotFrames = (view: Awaited<ReturnType<Route["snapshot"]>>["view"]): WireEvent[] => [
  { type: "MESSAGES_SNAPSHOT", messages: view.messages }, custom("modular-agent.history", { cursor: view.cursor, lastMessageId: view.lastMessageId }),
];
const statePrefix = "modular-agent.agui.";
function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
export class Exchange {
  private opened = latch(); private finished = latch();
  done = this.finished.promise;
  private off?: (() => void) & { idle(): Promise<void> }; private observe?: () => void; private absent?: () => void; private beat?: NodeJS.Timeout;
  private closed = false; private failing = false; private finishedNormally = false; private endSeen = false;
  private steps = new Set<string>(); private streams = new Map<string, { text: string; reasoning: boolean }>();
  private pieces = new Map<string, number>(); private received = new Map<string, number>();
  private starts = new Map<string, ToolCall>(); private stateRevision?: string; private originals = new Map<string, unknown>();
  private firstEntry?: string;
  private initialState?: {revisionId: string; snapshot: unknown};
  private stateSerial = 0; private lastStateSerial = 0;
  inputId?: string; turn?: string; origin?: string; handled?: boolean;
  constructor(readonly r: Route, readonly res: ServerResponse, readonly runId: string, readonly connection: InterfaceToolConnection | undefined,
    readonly setDeliver: (fn: (call: ToolCall) => void) => void) {}
  get boundary() { return { threadId: this.r.id, runId: this.runId }; }
  eligible(q: InputRequest) { return this.turn !== undefined && q.turnId === this.turn; }
  private include = (e: AgentEvent) => {
    if (e.type === "model.output" && e.data?.type === "text" && e.stepId) this.pieces.set(e.stepId, 1 + (this.pieces.get(e.stepId) ?? 0));
    if (e.type.startsWith(statePrefix) && e.source === this.r.binding.host.statePlugin?.name && e.data?.revisionId) this.originals.set(e.data.revisionId, { data: e.data, serial: ++this.stateSerial });
    if (e.type === "entry.added") {
      this.firstEntry ??= e.data.id;
      if (e.data.kind === "input" && e.data.data?.key === "agui:" + JSON.stringify([this.r.p.clientId, this.runId]) && e.actorId === this.r.p.actor.id) this.turn = e.turnId;
      if (this.origin && e.data.kind === "turnStart" && e.data.continuesTurnId === this.origin) this.turn = e.turnId;
      return ["response", "input", "inputHandedBack", "toolStarted", "toolResult", "turnStart"].includes(e.data.kind) || this.extensionEntry(e.data);
    }
    // Optional plugin output that cannot fit on the wire must not disconnect a healthy follower.
    if (e.source !== "runtime" && e.source !== "harness" && Buffer.byteLength(JSON.stringify(e.data ?? null)) > MAX) return false;
    return true;
  };
  private extensionEntry(e: HistoryEntry) { return e.kind.includes(".") && !/^(?:modular-agent|harness)\./.test(e.kind) && !e.erased; }
  follow() {
    const { r } = this, { api, id, c } = r;
    const error = (e: unknown) => { void this.opened.promise.then(() => this.error(e)); };
    this.off = api.follow(id, { recipient: r.recipient, include: this.include, onLag: () => error({ code: "busy" }) }, async e => {
      await this.opened.promise; if (this.closed) return;
      try { await r.scoped(() => this.event(e)); } catch (e) { this.error(e); }
    });
    this.observe = api.onEvent(e => {
      if (e.sessionId !== id || this.closed) return;
      if (e.source === "harness" && e.type === "continuation.refused" && this.origin && e.turnId === this.origin) return error({ code: "busy" });
      if (e.type === "session.interrupted" || e.type === "session.ended") return error({ code: "unavailable" });
      if (e.type === "entries.erased" || e.type === "position.moved") return error({ code: "conflict" });
      if (e.type === "turn.ended" || e.type === "input.request.opened") {
        // A withheld end cannot turn into either a hang or an ungated successful end.
        queueMicrotask(() => { void this.off?.idle().then(async () => {
          if (this.closed || this.turn !== (e.turnId ?? e.data?.request?.turnId)) return;
          if (e.type === "turn.ended" && !this.endSeen) this.error({ code: "output_withheld" });
          if (e.type === "input.request.opened" && e.data?.request && c.presence?.questions.has(e.data.request.id)) {
            c.presence.questions.delete(e.data.request.id); c.presence.rejected.add(e.data.request.id); api.presenceChanged(id);
          }
        }).catch(error); });
      }
    }, { raw: true });
    this.absent = r.t.h.connectInterface({ id: `agui.run:${r.p.clientId}`, actorId: r.p.actor.id, present: (session, request) => session === id && !request && !this.closed && r.rights().includes("watch") });
    this.res.once("close", () => this.stop());
  }
  private async select() {
    if (!this.turn) {
      const entries = await this.r.records();
      this.turn = entries.find(e => this.inputId ? e.kind === "input" && inputIdOf(e) === this.inputId : this.origin && e.kind === "turnStart" && e.continuesTurnId === this.origin)?.turnId;
    }
  }
  async readState() { this.initialState = await this.r.binding.host.statePlugin?.snapshot(this.r.id); }
  async start() {
    const { r, res } = this;
    const start = await r.events([{ type: "RUN_STARTED", ...this.boundary, protocolVersion: "1.0" }]);
    if (res.destroyed) fail("unavailable"); sse(res); this.write(start);
    const snap = await r.snapshot(false, this.firstEntry);
    this.write(await r.events(snapshotFrames(snap.view))); r.remember(snap);
    if (this.initialState) {
      const view = await r.api.gateOutput(r.id, r.recipient, statePrefix + "stateSnapshot", this.initialState);
      if (view) await this.state("stateSnapshot", view, this.initialState);
    }
    await this.select(); this.opened.resolve();
    this.beat = setInterval(() => { void this.r.current().then(() => this.write(": waiting\n\n"), e => this.error(e)).catch(e => this.error(e)); }, 15_000).unref();
    if (this.handled) await this.finish("completed");
  }
  private write(data: string) {
    if (!data) return;
    if (this.closed || this.failing || this.res.destroyed || this.res.writableLength + Buffer.byteLength(data) > MAX * 2) fail("busy");
    this.res.write(data);
  }
  private error(error: unknown) {
    if (this.closed || this.failing) return;
    this.failing = true; this.r.c.cursor = undefined; this.r.c.needsSnapshot = true;
    const terminal = { type: "RUN_ERROR", code: errorCode(error), message: "Run could not be delivered." };
    void this.r.events([terminal]).catch(() => frame({ ...terminal, code: "output_withheld" })).then(frames => {
      if (this.res.headersSent && !this.res.destroyed && !this.res.writableEnded) this.res.end(frames);
    }).finally(() => this.stop());
  }
  stop() {
    if (this.closed) return; this.closed = true;
    const presence = this.r.c.presence;
    if (!this.finishedNormally && this.turn && presence) {
      for (const id of presence.questions) if (!this.r.c.delivered.has(id)) {
        presence.questions.delete(id); presence.rejected.add(id);
      }
      this.r.api.presenceChanged(this.r.id);
    }
    clearInterval(this.beat); this.off?.(); this.observe?.(); this.absent?.(); this.opened.resolve(); this.finished.resolve();
  }
  private async send(events: WireEvent[], required = true) { this.write(await this.r.events(events, required)); }
  private async state(kind: string, data: any, original: unknown) {
    if (typeof data?.revisionId !== "string") { this.stateRevision = undefined; return; }
    let event: WireEvent;
    if (kind === "stateSnapshot") event = { type: "STATE_SNAPSHOT", snapshot: data.snapshot };
    else if (data.baseRevisionId === this.stateRevision && this.stateRevision !== undefined && same(original, data)) event = { type: "STATE_DELTA", delta: data.delta };
    else { this.stateRevision = undefined; return; }
    const frames = await this.r.events([event], false); this.write(frames);
    this.stateRevision = frames && same(original, data) ? data.revisionId : undefined;
  }
  private async event(e: AgentEvent) {
    const { r } = this; await this.select();
    const turn = e.turnId ?? e.data?.request?.turnId;
    if (e.type === "entry.added" && e.data.kind === "inputHandedBack" && inputIdOf(e.data) === this.inputId) fail("conflict");
    if (!this.turn || turn && turn !== this.turn) return;
    const { stepId: step, data: d } = e;
    if (e.type.startsWith(statePrefix)) {
      if (e.type === statePrefix + "raw") {
        const sources = r.binding.host.rawSources;
        if (sources && Object.hasOwn(sources, e.source) && object(d) && Object.hasOwn(d, "event")) await this.send([{ type: "RAW", source: sources[e.source], event: d.event }], false);
      } else if (e.source === r.binding.host.statePlugin?.name) {
        const received = this.originals.get(d?.revisionId);
        if (!object(received) || received.serial !== this.lastStateSerial + 1) this.stateRevision = undefined;
        this.lastStateSerial = object(received) ? received.serial : 0;
        await this.state(e.type.slice(statePrefix.length), d, object(received) ? received.data : undefined); this.originals.delete(d?.revisionId);
      }
      return;
    }
    if (e.type === "step.started" && step && !this.steps.has(step)) { await this.send([{ type: "STEP_STARTED", stepName: step }]); this.steps.add(step); return; }
    if (e.type === "step.ended" && step) { await this.closeStep(step); return; }
    if (e.type === "model.output" && step) {
      if (d?.type === "text" && typeof d.delta === "string") { this.received.set(step, (this.received.get(step) ?? 0) + 1); await this.text(step, d.delta); }
      else if (d?.type === "reasoning" && typeof d.delta === "string" && d.delta) {
        const stream = this.stream(step), messageId = `ma:r:${step}`;
        await this.send([...(stream.reasoning ? [] : [{ type: "REASONING_START", messageId }, { type: "REASONING_MESSAGE_START", messageId, role: "reasoning" }]), { type: "REASONING_MESSAGE_CONTENT", messageId, delta: d.delta }]); stream.reasoning = true;
      } else if (d?.type?.startsWith("tool")) await this.notice("tool.requested", { stepId: step });
      return;
    }
    if (e.type === "entry.added") {
      const raw = (await r.records()).find(record => record.id === d.id);
      if (!raw || raw.erased || d.erased) return;
      const entry = await displayEntry(r.api, r.p, raw, d as HistoryEntry);
      if (!entry) return;
      const {message} = entry;
      if (entry.kind === "input" && inputIdOf(entry) === this.inputId) {
        const snap = await r.snapshot(false, undefined, undefined, entry.id);
        await this.send(snapshotFrames(snap.view)); r.remember(snap);
      }
      if (entry.kind === "response" && entry.modelVisible && step && message?.role === "assistant") {
        const streamed = this.stream(step).text, text = textOf(message.content);
        if ((this.received.get(step) ?? 0) < (this.pieces.get(step) ?? 0) || streamed && !text.startsWith(streamed)) r.c.hidden.add(step);
        if (!r.c.hidden.has(step) && text.startsWith(streamed)) await this.text(step, text.slice(streamed.length));
      }
      if (entry.kind === "toolStarted" && entry.toolCallId && object(entry.data) && entry.data.source?.plugin !== "sdk.interface-tools") this.starts.set(entry.toolCallId, entry.data.call);
      if (entry.kind === "toolResult" && message?.role === "toolResult" && entry.toolCallId) {
        const call = this.starts.get(entry.toolCallId);
        if (call) await this.send([...callFrames(call, step && this.streams.get(step)?.text ? assistantId(step) : undefined),
          { type: "TOOL_CALL_RESULT", toolCallId: call.id, messageId: toolId(call.id), content: content(message.content), role: "tool" }], false);
        await this.notice("tool.result", { toolCallId: entry.toolCallId, status: object(entry.data) ? entry.data.status : undefined });
      }
      if (this.extensionEntry(entry)) await this.send([custom("modular-agent.entry", { id: entry.id, kind: entry.kind, data: entry.data })], false);
      return;
    }
    if (e.type === "input.request.opened" && turn === this.turn) {
      const questions = (await r.questions(await r.records())).filter(q => q.request.turnId === this.turn);
      if (questions.length) await this.finish("interrupt", questions.map(q => q.wire));
      return;
    }
    if (e.type === "turn.ended" && turn === this.turn) { this.endSeen = true; await this.finish(d.outcome.kind); return; }
    if (e.type === "input.accepted" && d.inputId === this.inputId) await this.notice(e.type, { inputId: d.inputId, taken: d.taken });
    if (["input.request.answered", "input.request.closed", "input.request.unanswerable"].includes(e.type) && d.requestId) await this.notice(e.type, {requestId: d.requestId, declined: d.declined});
    if ((e.type === "tool.ended" || e.type === "tool.result") && d.status) await this.notice(e.type, {toolCallId: e.toolCallId, status: d.status});
    if (e.type === "tool.call" || e.type === "tool.started") await this.notice(e.type, { toolCallId: e.toolCallId, name: d.call?.name });
    else if (e.type === "tool.progress") await this.notice(e.type, { toolCallId: e.toolCallId, content: content(d.content) });
    else if (!/^(session|actor|input|turn|step|model|tool|provider|history|position|entries|setting|plugin|capability)\./.test(e.type) && e.type.includes(".")) await this.notice(e.type, d ?? null);
  }
  private notice(type: string, data: unknown) { return this.send([custom("modular-agent.event", { type, data })], false); }
  private stream(step: string) { let s = this.streams.get(step); if (!s) this.streams.set(step, s = { text: "", reasoning: false }); return s; }
  private async text(step: string, delta: string) {
    if (!delta) return; const stream = this.stream(step), messageId = assistantId(step);
    await this.send([...(stream.text ? [] : [{ type: "TEXT_MESSAGE_START", messageId, role: "assistant" }]), { type: "TEXT_MESSAGE_CONTENT", messageId, delta }]);
    stream.text += delta;
  }
  private async closeStep(step: string) {
    const stream = this.streams.get(step), messageId = `ma:r:${step}`;
    const group: WireEvent[] = [];
    if (stream?.reasoning) group.push({ type: "REASONING_MESSAGE_END", messageId }, { type: "REASONING_END", messageId });
    if (stream?.text) group.push({ type: "TEXT_MESSAGE_END", messageId: assistantId(step) });
    if (this.steps.has(step)) group.push({ type: "STEP_FINISHED", stepName: step });
    if (group.length) await this.send(group); this.steps.delete(step); this.streams.delete(step);
  }
  private async finish(kind: string, questions: Interrupt[] = []) {
    const { r } = this;
    for (const step of new Set([...this.steps, ...this.streams.keys()])) await this.closeStep(step);
    if (kind === "failed") fail("unavailable");
    const presence = r.c.presence;
    const records = await r.records();
    const owned = r.c.held?.turnId === this.turn ? r.c.held : undefined;
    const connection = owned?.connection ?? this.connection;
    const calls = kind === "completed" ? r.pending(records).filter(c => c.turnId === this.turn && c.ended) : [];
    // Check for a staged call even if a right was revoked between turn end and projection.
    const staged = records.filter(e => e.turnId === this.turn && e.kind === "modular-agent.interfaceHandoff" && !e.erased && object(e.data) && e.data.routeId === r.p.clientId && e.data.executorActorId === r.p.actor.id && !records.some(x => x.kind === "toolResult" && x.toolCallId === e.toolCallId));
    if (kind === "completed" && calls.length !== staged.length) fail("refused");
    if (kind === "completed") questions = (await r.questions(records)).filter(q => q.request.turnId === this.turn).map(q => q.wire);
    const outcome = questions.length ? { type: "interrupt", interrupts: questions } : kind === "completed" ? { type: "success", ...(calls.length ? { pendingToolCallIds: calls.map(c => c.toolCallId) } : {}) } : { type: "cancelled" };
    const snap = await r.snapshot(false);
    const terminal = [...snapshotFrames(snap.view), { type: "RUN_FINISHED", ...this.boundary, outcome }];
    const groups = calls.map(c => callFrames(c.call, c.call.stepId && snap.view.messages.some(m => m.id === assistantId(c.call.stepId!)) ? assistantId(c.call.stepId) : undefined));
    await r.events([...groups.flat(), ...terminal]); // Do not authorize a terminal or a subset in isolation.
    if (await r.branchGeneration() !== snap.cursor.branch) fail("conflict");
    await r.deliverApprovals(presence, questions);
    const tail = terminal.map(frame).join("");
    const frames = groups.map(group => group.map(frame).join(""));
    const end = () => {
      this.write(tail); this.finishedNormally = true; this.res.end(); r.remember(snap); r.c.delivered = new Set(questions.map(q => q.id)); this.stop();
    };
    if (kind === "interrupt" && connection && this.turn && !owned) r.c.held = { connection, turnId: this.turn, setDeliver: this.setDeliver };
    if (!calls.length) { if (owned && kind !== "interrupt") { owned.connection.disconnect(); r.c.held = undefined; } end(); return; }
    if (!connection) fail("conflict");
    let next = 0;
    (owned?.setDeliver ?? this.setDeliver)(call => {
      if (!same(call, calls[next]?.call) || !r.rights().includes("watch") || calls.some(c => Date.parse(c.expiresAt) <= Date.now())) fail("refused");
      this.write(frames[next++]); if (next === calls.length) end();
    });
    try {
      for (const [i, call] of calls.entries()) if (!await connection.release(call.toolCallId) || next !== i + 1) fail("refused");
    } finally { if (owned) { owned.connection.disconnect(); r.c.held = undefined; } }
  }
}
