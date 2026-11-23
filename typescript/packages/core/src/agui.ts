import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Interrupt, Message, RunAgentInput } from "@ag-ui/core";
import { readTrace, withTrace } from "@modular-agent/harness/telemetry";
import type { Actor, Declaration, Harness, HistoryEntry, InputRequest, InterfaceToolConnection, InterfaceToolSource, PluginApi, ToolCall } from "@modular-agent/harness";
import type { Agent } from "./agent.js";
import { PATH, body, encode, errorCode, fail, frame, hash, httpError, json, object, parts, runInput, same, sse, type Code, type WireEvent } from "./agui-wire.js";
import { current, interrupt, messages, pending, reply, rights, watch, type InterruptView, type Principal } from "./agui-view.js";
import { Exchange } from "./agui-exchange.js";

export interface AguiProjectionOptions {
  /** Read the current document from its owner. The binding keeps no document store. */
  statePlugin?: { name: string; snapshot(threadId: string): { revisionId: string; snapshot: unknown } | undefined | Promise<{ revisionId: string; snapshot: unknown } | undefined> };
  /** Plugin name to source label for explicit modular-agent.agui.raw events. */
  rawSources?: Readonly<Record<string, string>>;
  /** Vendor keys to retain locally, only for traceTrusted principals. */
  traceStateVendors?: readonly string[];
  onWarning?(field: string): void;
}
export interface Target { h: Harness; api: PluginApi; agent: Agent; sources: readonly InterfaceToolSource[] }
interface Host extends AguiProjectionOptions {
  principalScope<T>(actor: Actor, work: () => T): T;
  root: Target; project: string; tenant?: string; origins?: readonly string[]; tls?: unknown;
  locate(p: Principal, id?: string): Promise<Target>; associate(id: string, agent: Agent): void;
}
export interface Presence { response: ServerResponse; questions: Set<string>; rejected: Set<string> }
export interface Client {
  cursor?: { id: string; digest: string; branch: string; http: boolean }; active?: Exchange; busy?: boolean; presence?: Presence;
  held?: { connection: InterfaceToolConnection; turnId: string; setDeliver(fn: (call: ToolCall) => void): void };
  needsSnapshot?: boolean; delivered: Set<string>; runs: Set<string>; hidden: Set<string>;
}
export class AguiBinding {
  clients = new Map<string, Client>();
  streams = new Set<ServerResponse>();
  constructor(readonly host: Host) {}
  warn = (key: string) => { if (this.host.onWarning) this.host.onWarning(key); else console.warn(`AG-UI: ${key}`); };
  allowOrigin = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    return origin === undefined || origin === `${this.host.tls ? "https" : "http"}://${req.headers.host}` || this.host.origins?.includes(origin) === true;
  };
  request = (req: IncomingMessage, res: ServerResponse, p?: Principal) => {
    res.on("error", () => res.destroy());
    const work = async () => {
      if (req.method === "OPTIONS" && req.headers.origin && this.allowOrigin(req) && /^\/agui\/v1(?:\/|$)/.test(req.url ?? "")) {
        res.writeHead(204, { "cache-control": "no-store", vary: "Origin", "access-control-allow-origin": req.headers.origin,
          "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "Authorization, Content-Type, MA-History-Cursor, traceparent, tracestate" }).end(); return;
      }
      if (!p) fail("unauthenticated");
      if (!this.allowOrigin(req)) fail("refused");
      if (req.headers.origin) { res.setHeader("access-control-allow-origin", req.headers.origin); res.setHeader("vary", "Origin"); }
      const path = req.url, method = req.method;
      if (path === PATH && method === "GET") {
        const data = await reply(this.host.root.api, "", p, "discovery", { binding: "modular-agent-agui/1", protocolVersion: "1.0", declaration: this.host.root.agent.declaration() });
        return json(res, 200, data);
      }
      if (path === PATH + "/threads" && method === "POST") {
        if (Object.keys(await body(req)).length) fail("invalid_request");
        if (!p.actor.authority.includes("input") || !p.actor.authority.includes("watch") || !p.allowProject(this.host.project) || !p.allowTenant(this.host.tenant ?? null)) fail("refused");
        const t = await this.host.locate(p);
        const threadId = await t.api.startSession({ actor: p.actor, tenant: this.host.tenant });
        this.host.associate(threadId, t.agent);
        watch(t.api, threadId, p);
        const out = await reply(t.api, threadId, p, "create", { threadId, declaration: t.agent.declaration() });
        await current(t.api, threadId, p);
        return json(res, 201, out);
      }
      const input = path === PATH + "/run" && method === "POST" ? runInput(await body(req), this.warn) : undefined;
      const match = method === "GET" && /^\/agui\/v1\/threads\/([\w-]+)(\/presence)?$/.exec(path ?? "");
      const id = input?.threadId ?? (match && match[1]);
      if (!id || !/^[\w-]+$/.test(id)) fail("not_found");
      const t = await this.host.locate(p, id);
      const recovered = !t.h.liveSessionInfo(id);
      await t.h.openSession(id, p.actor);
      if (recovered) await t.api.waitForIdle(id);
      await current(t.api, id, p);
      const key = JSON.stringify([p.clientId, id]);
      let client = this.clients.get(key);
      if (!client) {
        if (this.clients.size >= 4096) {
          const discard = [...this.clients].find(([, c]) => !c.busy && !c.presence && !c.held && !c.hidden.size);
          if (!discard) fail("busy"); this.clients.delete(discard[0]);
        }
        client = { delivered: new Set(), runs: new Set(), hidden: new Set() }; this.clients.set(key, client);
      }
      const route = new Route(this, t, id, p, client);
      if (input) return route.run(res, input, req);
      if (match && match[2]) return route.presence(res);
      try {
        const snap = await route.snapshot(true);
        json(res, 200, snap.view); route.remember(snap);
      } catch (e) { client.cursor = undefined; client.needsSnapshot = true; throw e; }
    };
    void withTrace(undefined, () => p ? this.host.principalScope(p.actor, work) : work()).catch(async e => {
      let code = errorCode(e);
      if (p && !res.headersSent) try {
        const out = await reply(this.host.root.api, "", p, "error", { code });
        if (out.code !== code) code = "output_withheld";
      } catch { code = "output_withheld"; }
      if (!res.headersSent && !res.destroyed) httpError(res, code);
      else if (!res.writableEnded && !res.destroyed) res.end(frame({ type: "RUN_ERROR", code, message: "Run could not be delivered." }));
    });
  };
  track(res: ServerResponse) { this.streams.add(res); res.once("close", () => this.streams.delete(res)); }
  close() { for (const res of this.streams) res.destroy(); for (const c of this.clients.values()) c.held?.connection.disconnect(); this.clients.clear(); }
}

export class Route {
  readonly api; readonly recipient;
  constructor(readonly binding: AguiBinding, readonly t: Target, readonly id: string, readonly p: Principal, readonly c: Client) { this.api = t.api; this.recipient = p.actor.id; }
  scoped<T>(fn: () => T) { return this.t.h.withConnectionActor(this.p.actor, fn); }
  async current() { await this.scoped(() => current(this.api, this.id, this.p)); }
  async records() { return this.scoped(() => this.api.readHistory(this.id)); }
  rights() { return this.scoped(() => rights(this.api, this.id, this.p)); }
  pending(records: HistoryEntry[]) { return this.rights().includes("tools") ? pending(records, this.p) : []; }
  async questions(records: HistoryEntry[]): Promise<InterruptView[]> {
    const result: InterruptView[] = [];
    for (const request of this.api.openRequests(this.id)) {
      const e = records.find(e => e.kind === "inputRequest" && !e.erased && e.requestId === request.id);
      const inTurn = !records.some(e => e.kind === "turnEnd" && e.turnId === request.turnId);
      if (!e || inTurn && !this.c.presence?.questions.has(request.id) || request.kind === "approval" && !inTurn) continue;
      const view = await interrupt(this.api, this.id, this.p, request, e, inTurn);
      if (view) result.push(view);
      else if (inTurn && this.c.presence) {
        this.c.presence.questions.delete(request.id); this.c.presence.rejected.add(request.id); this.api.presenceChanged(this.id);
      }
    }
    return result.filter(q => this.api.openRequests(this.id).some(r => r.id === q.wire.id));
  }
  async snapshot(http: boolean, through?: string, cursor = randomUUID() as string, inclusive?: string) {
    const branch = await this.branchGeneration();
    const records = await this.records();
    const copy = await messages(this.api, this.id, this.p, inclusive ? records.slice(0, records.findIndex(e => e.id === inclusive) + 1) : records, this.c.hidden, through);
    const view = { threadId: this.id, declaration: this.t.agent.declaration(), messages: copy, cursor, lastMessageId: copy.at(-1)?.id ?? null,
      waiting: { questions: (await this.questions(records)).map(q => q.wire), toolCalls: this.pending(records).filter(c => c.ended).map(({toolCallId, expiresAt}) => ({ toolCallId, expiresAt })) } };
    const gated = http ? await reply(this.api, this.id, this.p, "snapshot", view) : view;
    encode(gated);
    // Message redaction takes place at entry and agui.messages. A wrapper cannot change identities or grant an interrupt.
    if (!same(view, gated)) fail("output_withheld");
    if (await this.branchGeneration() !== branch) fail("conflict");
    await this.current();
    return { view: gated, cursor: { id: cursor, digest: hash(copy), branch, http } };
  }
  async branchGeneration() {
    const all = await this.scoped(() => this.api.readHistory(this.id, { all: true }));
    return hash(all.filter(e => e.kind === "position" || e.erased).map(e => e.id));
  }
  remember(snap: Awaited<ReturnType<Route["snapshot"]>>) { this.c.cursor = snap.cursor; this.c.needsSnapshot = false; }
  presence(res: ServerResponse) {
    const { c, id, api, p } = this;
    if (c.presence) fail("conflict");
    const presence: Presence = { response: res, questions: new Set(), rejected: new Set() };
    c.presence = presence;
    // In-turn offers belong to this exact live route. A replacement never inherits them.
    const off = this.t.h.connectInterface({ id: `agui:${p.clientId}`, actorId: p.actor.id,
      present: (session, q) => session === id && !res.destroyed && this.rights().includes("watch") && (!q || q.kind !== "secret" && !presence.rejected.has(q.id) && this.rights().includes(q.kind === "approval" ? "approve" : "answer") &&
        (presence.questions.has(q.id) || !!c.active && c.active.eligible(q))),
      onInputRequest: q => { if (!presence.rejected.has(q.id)) presence.questions.add(q.id); },
      onInputRequestClosed: q => { presence.questions.delete(q); presence.rejected.delete(q); } });
    this.binding.track(res); sse(res); res.write(": present\n\n");
    const beat = setInterval(() => { void this.current().then(() => { if (!res.write(": present\n\n")) res.destroy(); }, () => res.destroy()); }, 15_000).unref();
    res.once("close", () => { clearInterval(beat); off(); c.presence = undefined; api.presenceChanged(id); if (!c.active) { c.held?.connection.disconnect(); c.held = undefined; } });
  }
  async events(group: WireEvent[], required = true) {
    try {
      const result = await reply(this.api, this.id, this.p, "events", group);
      if (!same(result, group)) fail("output_withheld");
      const frames = result.map(frame).join(""); await this.current(); return frames;
    } catch (e) { if (required || !["result_too_large", "output_withheld"].includes(errorCode(e))) throw e; return ""; }
  }
  async run(res: ServerResponse, input: RunAgentInput, req: IncomingMessage) {
    const { c, api, p, id } = this;
    if (c.busy) fail("conflict");
    c.busy = true;
    let conn: InterfaceToolConnection | undefined, exchange: Exchange | undefined;
    const scope = Symbol("AG-UI offer");
    try { await this.t.h.withInterfaceOffer(scope, async () => {
      if (c.needsSnapshot) fail("cursor_expired");
      const seen = c.cursor;
      const echoed = req.headers["ma-history-cursor"];
      if (echoed !== undefined && echoed !== seen?.id) fail("cursor_expired");
      const snap = await this.snapshot(seen?.http ?? false, undefined, seen?.id);
      const known = snap.view.messages;
      if (seen ? seen.digest !== snap.cursor.digest || seen.branch !== snap.cursor.branch : known.length !== 0) fail("conflict");
      if (seen !== c.cursor || !same(input.messages.slice(0, known.length), known) || c.runs.has(input.runId)) fail("conflict");
      const suffix = input.messages.slice(known.length);
      if (suffix.some(m => !m.id || m.id.startsWith("ma:")) || new Set(suffix.map(m => m.id)).size !== suffix.length) fail("invalid_request");
      const user = suffix.find(m => m.role === "user");
      if (user && (suffix.length !== 1 || input.resume?.length) || suffix.some(m => m.role !== "user" && m.role !== "tool")) fail("invalid_request");
      if (!suffix.length && !input.resume?.length) fail("invalid_request");
      const records = await this.records(), calls = this.pending(records), questions = await this.questions(records);
      const reports = suffix.flatMap(m => {
        if (m.role !== "tool") return [];
        const call = calls.find(c => c.toolCallId === m.toolCallId && c.ended);
        if (!call) fail("conflict");
        let content = parts(m, this.binding.warn);
        if (!content.length || m.error !== undefined && content.every(p => p.type === "text" && !p.text)) content = [{ type: "text", text: m.error ?? "" }];
        return [{ call, report: { callId: call.toolCallId, status: m.error === undefined ? "completed" as const : "failed" as const, content } }];
      });
      const answers = (input.resume ?? []).flatMap(a => {
        const q = questions.find(q => q.wire.id === a.interruptId && (c.delivered.has(a.interruptId) || !q.inTurn));
        if (!q) {
          if (records.some(e => e.kind === "inputRequest" && e.requestId === a.interruptId)) fail("conflict");
          this.binding.warn("resume.interruptId"); return [];
        }
        const v = a.payload, r = q.request; let declined = a.status === "cancelled", value: string | undefined;
        if (!declined) {
          if (r.kind === "approval") { if (!object(v) || Object.keys(v).length !== 1 || typeof v.allow !== "boolean") fail("invalid_request"); declined = !v.allow; value = declined ? undefined : "allow"; }
          else { if (typeof v !== "string" || r.kind === "choice" && !r.options?.includes(v)) fail("invalid_request"); value = v; }
        }
        return [{ q, answer: { requestId: r.id, actorId: p.actor.id, declined, ...(value === undefined ? {} : { value }) } }];
      });
      if (new Set(answers.map(a => a.q.wire.id)).size !== answers.length || new Set(reports.map(r => r.report.callId)).size !== reports.length) fail("invalid_request");
      if (questions.some(q => c.delivered.has(q.wire.id) && !answers.some(a => a.q.wire.id === q.wire.id)) || !user && !answers.length && !reports.length) fail("conflict");
      const origins = new Set([...answers.map(a => a.q.request.turnId), ...reports.map(r => r.call.turnId)]);
      if (origins.size > 1 || calls.some(c => c.ended && (user || origins.has(c.turnId) && !reports.some(r => r.report.callId === c.toolCallId)))) fail("conflict");
      const content = user && parts(user, this.binding.warn);
      if (content && !this.rights().includes("input")) fail("refused");
      const sources = this.t.sources.filter(s => s.actorId === p.actor.id && s.routeId === p.clientId);
      const offers = (input.tools ?? []).map(offer => {
        const def = sources.flatMap(s => s.tools).find(t => t.name === offer.name && t.returns === undefined && t.description === offer.description && same(t.parameters, offer.parameters ?? {}));
        if (!def) fail("refused"); return def;
      });
      if (new Set(offers.map(t => t.name)).size !== offers.length || offers.length && !this.rights().includes("tools")) fail("refused");
      if (seen !== c.cursor || res.destroyed || await this.branchGeneration() !== snap.cursor.branch) fail("conflict");
      let deliver: (call: ToolCall) => void = () => fail("conflict");
      if (sources.length) {
        conn = this.t.agent.connectInterfaceTools(id, { actor: { id: p.actor.id, kind: p.actor.kind as "user", rights: p.actor.authority }, routeId: p.clientId, defer: true, onHandoff: request => deliver(request.call) });
        conn.advertise(offers);
      }
      const x = exchange = new Exchange(this, res, input.runId, conn, fn => { deliver = fn; });
      c.active = x; this.binding.track(res); x.follow(); await x.readState();
      const parent = p.traceTrusted ? readTrace(req.headers, this.binding.host.traceStateVendors) : undefined;
      await withTrace(parent, async () => {
        if (content) {
          // The binding has no command or administration route, even for a direct operator.
          const text = content.filter(p => p.type === "text").map(p => p.text).join("").trim();
          if (text.startsWith("/") && api.commands().some(command => text.split(/\s/, 1)[0] === "/" + command.name)) fail("refused");
          const receipt = await api.input(id, { content, key: "agui:" + JSON.stringify([p.clientId, input.runId]), when: "now", actorId: p.actor.id });
          if (receipt.duplicate) fail("conflict"); x.inputId = receipt.inputId; x.handled = receipt.handled;
        } else {
          const origin = [...origins][0];
          if (answers.some(a => a.q.inTurn)) x.turn = origin; else x.origin = origin;
          for (const { q, answer } of answers) {
            if (q.inTurn && !c.presence?.questions.has(q.wire.id) || !(await api.submitAnswer(id, answer)).accepted) fail("conflict");
          }
          for (const { report } of reports) if ((await conn?.reportInterfaceToolResult(report))?.status !== "accepted") fail("conflict");
        }
      });
      c.runs.add(input.runId); if (c.runs.size > 2048) c.runs.delete(c.runs.values().next().value!);
      await x.start(); await x.done;
    }); } finally {
      exchange?.stop(); c.active = undefined; c.busy = false;
      if (c.held?.connection !== conn) conn?.disconnect();
    }
  }
}
