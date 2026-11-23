import type { Interrupt, Message } from "@ag-ui/core";
import { MessageSchema } from "@ag-ui/core/schemas";
import { inputIdOf, isText, textOf, type Actor, type ContentPart, type HistoryEntry, type InputRequest, type PluginApi, type ToolCall } from "@modular-agent/harness";
import { cleanMessage, encode, fail, object, same } from "./agui-wire.js";

export interface Principal {
  actor: Actor; clientId: string; traceTrusted?: boolean;
  allowProject(project: string): boolean; allowTenant(tenant: string | null): boolean;
}
export type InterruptView = { wire: Interrupt; request: InputRequest; inTurn: boolean };
export type Pending = { toolCallId: string; expiresAt: string; turnId: string; ended: boolean; call: ToolCall };
export const assistantId = (step: string) => `ma:a:${step}`;
export const toolId = (call: string) => `ma:t:${call}`;
export function content(parts: ContentPart[]): string | Exclude<Extract<Message, {role:"user"}>["content"], string> {
  const visible = parts.flatMap<Exclude<Extract<Message, {role:"user"}>["content"], string>[number]>(p => isText(p) ? [{ type: "text", text: p.text }]
    : p.type === "image" && typeof p.data === "string" && typeof p.mimeType === "string" ? [{ type: "image", source: { type: "data", value: p.data, mimeType: p.mimeType } }] : []);
  return visible.every(p => p.type === "text") ? visible.map(p => p.text).join("") : visible;
}
export async function reply<T>(api: PluginApi, id: string, p: Principal, method: string, result: T): Promise<T> {
  const out = await api.gateOutput(id, p.actor.id, "reply", { method: `agui.${method}`, clientId: p.clientId, result });
  if (!out || out.method !== `agui.${method}` || out.clientId !== p.clientId) fail("output_withheld");
  return out.result;
}
export function rights(api: PluginApi, id: string, p: Principal) {
  const s = api.session(id);
  return p.allowProject(s.project) && p.allowTenant(s.tenant ?? null) ? s.actors.find(a => a.id === p.actor.id)?.authority.filter(r => p.actor.authority.includes(r)) ?? [] : [];
}
export function watch(api: PluginApi, id: string, p: Principal) { if (!rights(api, id, p).includes("watch")) fail("not_found"); }
export async function current(api: PluginApi, id: string, p: Principal) { await api.checkPending(id); watch(api, id, p); }

// Select committed calls, never model drafts. Checkpoint contents are routing metadata, not output.
export function pending(entries: HistoryEntry[], p: Principal): Pending[] {
  const results = new Set(entries.filter(e => e.kind === "toolResult").map(e => e.toolCallId));
  const ends = new Map(entries.filter(e => e.kind === "turnEnd").map(e => [e.turnId, e]));
  return entries.flatMap((e, i) => {
    if (e.erased || e.kind !== "modular-agent.interfaceHandoff" || !e.toolCallId || !e.turnId || e.writer !== "harness" || results.has(e.toolCallId)) return [];
    const d = e.data, start = entries[i - 1], sd = start?.data, end = ends.get(e.turnId);
    if (!object(d) || d.executorActorId !== p.actor.id || d.routeId !== p.clientId || !d.rights?.includes("tools") || !(d.deadline > Date.now()) ||
      !start || start.erased || d.toolStartedId !== start.id || start.kind !== "toolStarted" || start.toolCallId !== e.toolCallId || !object(sd) || !sd.call ||
      end && (end.erased || !object(end.data) || !end.data.result.openToolCalls.includes(e.toolCallId))) return [];
    return [{ toolCallId: e.toolCallId, expiresAt: new Date(d.deadline).toISOString(), turnId: e.turnId, ended: !!end, call: sd.call }];
  });
}
export async function interrupt(api: PluginApi, id: string, p: Principal, r: InputRequest, entry: HistoryEntry, inTurn: boolean): Promise<InterruptView | undefined> {
  if (r.kind === "secret" || !rights(api, id, p).includes(r.kind === "approval" ? "approve" : "answer") || r.answerers.length && !r.answerers.includes(p.actor.id)) return;
  const call = object(entry.data) ? entry.data.call as ToolCall | undefined : undefined;
  if (r.kind === "approval" && (!call || call.id !== r.toolCallId)) return;
  const wire: Interrupt = { id: r.id, reason: r.kind, message: r.kind === "approval" ? `${r.question}\n${call!.name} ${JSON.stringify(call!.input)}` : r.question,
    ...(r.toolCallId ? { toolCallId: r.toolCallId } : {}), ...(r.timeLimitMs === undefined || r.whenTimeLimit === "leaveOpen" ? {} : { expiresAt: new Date(entry.time + r.timeLimitMs).toISOString() }),
    ...(r.kind === "link" && r.details ? { metadata: { "modular-agent.link": r.details } } : {}),
    responseSchema: r.kind === "approval" ? { type: "object", properties: { allow: { type: "boolean" } }, required: ["allow"], additionalProperties: false }
      : r.kind === "choice" ? { type: "string", enum: r.options } : { type: "string" } };
  const gated = await api.gateOutput(id, p.actor.id, "request", { method: "agui.interrupt", clientId: p.clientId, interrupt: wire });
  if (!gated || !same(gated.interrupt, wire)) return;
  return { wire, request: r, inTurn };
}
// A reply and a live stream can be subject to different gates. A more restrictive
// view wins; if two redactions disagree there is no safe common copy to project.
function common<T>(original: T, a: T, b: T) {
  if (same(a,b) || same(a,original)) return b;
  if (same(b,original)) return a;
}
export async function displayEntry(api: PluginApi, p: Principal, raw: HistoryEntry, entry: HistoryEntry) {
  const { sessionId: id, stepId, turnId, toolCallId } = entry, ids = { stepId, turnId, toolCallId };
  const {message} = entry;
  if (entry.kind === "response" && message?.role === "assistant" && raw.message?.role === "assistant") {
    const original = textOf(raw.message.content);
    const rendered = original && await api.gateOutput(id, p.actor.id, "model.output", {type:"text", delta:original}, ids);
    const text = rendered ? common(original, textOf(message.content), rendered.delta) ?? "" : "";
    return { ...entry, message: { ...message, content: [...message.content.filter(p=>p.type!=="text"), {type:"text",text}] } };
  }
  if (entry.kind === "toolStarted" && object(entry.data) && object(raw.data) && entry.data.source?.plugin !== "sdk.interface-tools") {
    const data = await api.gateOutput(id, p.actor.id, "tool.started", {call:raw.data.call}, ids);
    const call = data && common(raw.data.call,entry.data.call,data.call);
    return call ? {...entry,data:{...entry.data,call}} : undefined;
  }
  if (entry.kind === "toolResult" && message?.role === "toolResult" && raw.message?.role === "toolResult" && object(raw.data)) {
    const data = await api.gateOutput(id, p.actor.id, "tool.result.delivered", {status:raw.data.status, content:raw.message.content,
      ...(raw.data.value === undefined ? {} : {value:raw.data.value})}, ids);
    const content = data && common(raw.message.content, message.content, data.content);
    return content ? {...entry, message:{...message,content}} : undefined;
  }
  return entry;
}
export async function messages(api: PluginApi, id: string, p: Principal, entries: HistoryEntry[], hidden: ReadonlySet<string>, through?: string): Promise<Message[]> {
  const visible: HistoryEntry[] = [];
  for (const entry of entries) {
    if (through === entry.id) break;
    if (entry.erased || !["input", "response", "toolStarted", "toolResult"].includes(entry.kind)) continue;
    const out = await api.gateOutput(id, p.actor.id, "entry", entry);
    if (out?.id === entry.id && out.kind === entry.kind && !out.erased) {
      const projected = await displayEntry(api, p, entry, out);
      if (projected) visible.push(projected);
    }
  }
  const starts = new Map(visible.filter(e => e.kind === "toolStarted").map(e => [e.toolCallId, e]));
  const results = new Set(visible.filter(e => e.kind === "toolResult" && e.message?.role === "toolResult").map(e => e.toolCallId));
  const out: Message[] = [];
  for (const entry of visible) {
    const { message } = entry;
    if (entry.kind === "input" && message?.role === "user" && inputIdOf(entry)) out.push({ id: `ma:u:${inputIdOf(entry)}`, role: "user", content: content(message.content) });
    if (entry.kind === "response" && entry.modelVisible && message?.role === "assistant" && entry.stepId) {
      const calls = message.content.flatMap(part => {
        if (part.type !== "toolCall" || typeof part.id !== "string" || !results.has(part.id)) return [];
        const data = starts.get(part.id)?.data;
        // Even after settlement, a snapshot is not an Interface handoff.
        if (!object(data) || data.source?.plugin === "sdk.interface-tools" || !data.call) return [];
        return [{ type: "function" as const, id: part.id, function: { name: data.call.name, arguments: JSON.stringify(data.call.input) } }];
      });
      const text = hidden.has(entry.stepId) ? "" : textOf(message.content);
      if (text || calls.length) out.push({ id: assistantId(entry.stepId), role: "assistant", ...(text ? { content: text } : {}), ...(calls.length ? { toolCalls: calls } : {}) });
    }
    if (entry.kind === "toolResult" && message?.role === "toolResult" && entry.toolCallId) {
      out.push({ id: toolId(entry.toolCallId), role: "tool", toolCallId: entry.toolCallId, content: content(message.content),
        ...(message.isError ? { error: textOf(message.content) || "Tool failed." } : {}) });
    }
  }
  const candidate = await reply(api, id, p, "messages", out);
  encode(candidate);
  if (!Array.isArray(candidate) || candidate.length !== out.length || candidate.some((m, i) => !MessageSchema.safeParse(m).success || m.id !== out[i].id || m.role !== out[i].role)) fail("output_withheld");
  return candidate.map(cleanMessage);
}
