import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { HistoryEntry, InputRequest } from "@modular-agent/harness";
import type { Target } from "./agui.js";
import { encode, fail, object, same, sse } from "./agui-wire.js";
import { interrupt, watch, type Principal } from "./agui-view.js";

export class HostRead {
  constructor(readonly t: Target, readonly id: string, readonly p: Principal) {}
  view() { return this.t.h.withConnectionActor(this.p.actor, () => this.t.h.hostView(this.id, this.p.actor,
    (project, tenant) => this.p.allowProject(project) && this.p.allowTenant(tenant))); }
  gate<T>(type: string, data: T, e?: HistoryEntry) {
    return this.t.api.gateOutput(this.id, this.p.actor.id, type, structuredClone(data),
      e && {turnId:e.turnId, stepId:e.stepId, toolCallId:e.toolCallId});
  }
  async entry(e: HistoryEntry) {
    if (e.erased) return;
    const gated = await this.gate("entry", e, e);
    if (gated?.id === e.id && gated.kind === e.kind && !gated.erased && gated.turnId === e.turnId && gated.toolCallId === e.toolCallId && gated.requestId === e.requestId) return gated;
  }
  async question(e: HistoryEntry) {
    if (!object(e.data) || !object(e.data.request)) return;
    const request = {...e.data.request, id:e.requestId, answerers:e.data.request.answerers ?? [], turnId:e.turnId, toolCallId:e.toolCallId} as InputRequest;
    if (request.kind === "secret" || request.answerers.length && !request.answerers.includes(this.p.actor.id)) return;
    const open = await this.entry(e);
    if (!open || !same(open.data, e.data)) return;
    // Gate the view, but never deliver it or register this reader as an answer route.
    return (await interrupt(this.t.api, this.id, this.p, request, e, false, true))?.wire;
  }
  async handoff(entries: HistoryEntry[], callId: string) {
    const checkpoint = entries.find(e => e.kind === "modular-agent.interfaceHandoff" && e.toolCallId === callId);
    const d = checkpoint?.data;
    if (!checkpoint || checkpoint.erased || checkpoint.writer !== "harness" || !object(d) || d.routeId !== this.p.clientId || d.executorActorId !== this.p.actor.id) return;
    const start = entries.find(e => e.id === d.toolStartedId && e.kind === "toolStarted" && e.toolCallId === callId);
    if (!start || !object(start.data) || start.data.source?.plugin !== "sdk.interface-tools" || !start.data.call) return;
    const open = await this.entry(start);
    if (!open || !object(open.data) || !same(open.data.call, start.data.call)) return;
    const started = await this.gate("tool.started",{call:start.data.call},start);
    if (!same(started?.call,start.data.call)) return;
    const request = {sessionId:this.id, turnId:start.turnId, deadline:d.deadline, call:start.data.call};
    if (!same(request, await this.gate("tool.handoff", request, start))) return;
    return start.data.call;
  }
  async closure(records: HistoryEntry[], close: HistoryEntry) {
    if (close.erased) return;
    if (close.kind === "inputAnswer" && close.requestId) {
      const requestId = close.requestId;
      if (records.find(e => e.kind === "inputAnswer" && e.requestId === requestId)?.id !== close.id) return;
      const open = records.find(e => e.kind === "inputRequest" && e.requestId === requestId);
      if (!open || !await this.question(open)) return;
      const decision = await this.entry(close);
      const d = decision?.data, raw = close.data;
      if (!object(d) || !object(raw) || d.actorId !== raw.actorId || d.declined !== raw.declined || d.cause !== raw.cause || d.reason !== raw.reason) return;
      if (!d.declined && typeof d.value === "string") return {requestId, reason:"answered"};
      if (d.declined !== true) return;
      if (d.actorId && d.actorId !== "harness") return {requestId, reason:"declined"};
      if (d.reason === "timeLimit") return {requestId, reason:"expired"};
      if (["cancelled","noLongerAnswerable","refused","superseded"].includes(d.reason)) {
        return {requestId, reason:d.cause === "revoked" && ["refused","noLongerAnswerable"].includes(d.reason) ? "revoked" : d.reason as string};
      }
    } else if (close.kind === "toolResult" && close.toolCallId) {
      if (!await this.handoff(records, close.toolCallId)) return;
      const result = await this.entry(close);
      if (!object(result?.data) || !object(close.data) || result.data.status !== close.data.status || close.message?.role !== "toolResult") return;
      const {status, value} = close.data;
      const out = await this.gate("tool.result.delivered", {status, content:close.message.content, ...(value !== undefined && {value})}, close);
      if (out?.status === status) return {toolCallId:close.toolCallId, reason:"settled", status};
    }
  }
}

type View = Awaited<ReturnType<HostRead["view"]>>;
type Position = { scope:string; generation:string; offset:number };
export class WaitClosures {
  private cursors = new Map<string, Position>();
  private scope(r: HostRead) { return JSON.stringify([r.id, r.p.actor.id, r.p.clientId]); }
  remember(cursor: string, read: HostRead, view: View, offset: number) {
    if (this.cursors.size >= 8192) this.cursors.delete(this.cursors.keys().next().value!);
    this.cursors.set(cursor, {scope:this.scope(read), generation:view.generation, offset});
  }
  async serve(r: HostRead, res: ServerResponse, params: URLSearchParams) {
    const basis = await r.view();
    if (params.getAll("after").length !== 1) fail("invalid_request");
    const at = this.cursors.get(params.get("after")!);
    if (!at || at.scope !== this.scope(r) || at.generation !== basis.generation || !basis.live || at.offset > basis.order.length) fail("cursor_expired");
    const current = async () => {
      const v = await r.view();
      if (!v.live || v.generation !== at.generation) fail("cursor_expired");
      return v;
    };
    const disconnect = () => { res.destroy(); };
    sse(res);
    const open = () => !res.destroyed && !res.writableEnded;
    const deliver = async (id:string) => {
      try {
        if (!open()) return;
        const v = await current();
        const close = v.records.find(entry => entry.id === id);
        if (!close) return;
        const fact = await r.closure(v.records, close);
        if (!fact) return;
        const item = {cursor:randomUUID(), ...fact};
        if (!same(item, await r.gate("modular-agent.waitClosed", item, close))) return;
        // A gate can suspend. Re-read its sources and membership before releasing any bytes.
        if (!same(fact, await r.closure((await current()).records, close))) return;
        if (!same(item, await r.gate("modular-agent.waitClosed", item, close))) return;
        await current();
        if (!open()) return;
        this.remember(item.cursor, r, v, v.order.indexOf(close.id) + 1);
        if (!res.write(`data: ${encode(item)}\n\n`)) disconnect();
      } catch { if (open()) res.end(); }
    };
    // A fast reader can have more old closures than the live queue capacity. Replay
    // one by one; reserve that queue for commits after the single cutover watermark.
    const prefix = new Set(basis.order.slice(at.offset));
    const ids = basis.records.filter(e=>prefix.has(e.id) && ["inputAnswer","toolResult"].includes(e.kind)).map(e=>e.id);
    const replay = Promise.resolve().then(async () => { for (const id of ids) { if (!open()) break; await deliver(id); } });
    const off = r.t.api.follow(r.id, {fromEntry:basis.order.length, recipient:r.p.actor.id, raw:true, onLag:disconnect, include:e => {
      if (["session.ended","session.interrupted","entries.erased","position.moved"].includes(e.type)) disconnect();
      if (e.type === "entry.added" && ["actorJoined","actorLeft","limit","tenant"].includes(e.data.kind)) {
        try { r.t.h.withConnectionActor(r.p.actor,()=>watch(r.t.api,r.id,r.p)); } catch { if (open()) res.end(); }
      }
      return ["entry","entry.added"].includes(e.type) && ["inputAnswer","toolResult"].includes(e.data.kind);
    }}, async e => { await replay; await deliver(e.data.id); });
    const beat = setInterval(() => { void current().then(() => { if (!res.write(": waiting\n\n")) disconnect(); }, disconnect); }, 15_000).unref();
    res.once("close", () => { clearInterval(beat); off(); });
  }
}
