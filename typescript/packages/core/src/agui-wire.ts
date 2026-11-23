// Wire rules: docs/bindings/agui.md and https://docs.ag-ui.com/spec/1.0/basic/run-input
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { EventSchema, RunAgentInputSchema } from "@ag-ui/core/schemas";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { parseHistoryJson } from "@modular-agent/services";
import type { ContentPart } from "@modular-agent/harness";

export const MAX = 64 * 1024 * 1024;
export const PATH = "/agui/v1";
const status = { invalid_request: 400, not_supported: 400, unauthenticated: 401, refused: 403, output_withheld: 403,
  not_found: 404, conflict: 409, cursor_expired: 409, result_too_large: 413, busy: 503, unavailable: 503 };
export type Code = keyof typeof status;
export function fail(code: Code): never { throw Object.assign(new Error(code), { code }); }
export function errorCode(error: unknown): Code {
  const c = (error as { code?: string })?.code;
  return c && Object.hasOwn(status, c) ? c as Code : c === "forbidden" ? "refused" : c === "invalid_params" ? "invalid_request" : "unavailable";
}
export function httpError(res: ServerResponse, code: Code) { json(res, status[code], { code }); }
export function json(res: ServerResponse, code: number, body: unknown) {
  const bytes = encode(body);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }).end(bytes);
}
export function encode(value: unknown) {
  const data = JSON.stringify(value);
  if (!data || Buffer.byteLength(data) > MAX) fail("result_too_large");
  return data;
}
export function frame(event: WireEvent) {
  const encoded = encode(event);
  if (!EventSchema.safeParse(event).success) fail("output_withheld");
  return `data: ${encoded}\n\n`;
}
export function sse(res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
  res.flushHeaders();
}
export type WireEvent = { type: string; [key: string]: unknown };
export const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
export const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);
export const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export async function body(req: IncomingMessage) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")) fail("invalid_request");
  if (Number(req.headers["content-length"]) > MAX) fail("result_too_large");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    if ((size += chunk.length) > MAX) fail("result_too_large");
    chunks.push(chunk);
  }
  try {
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
    parseHistoryJson(raw); // Shared duplicate-member, Unicode and nesting checks, before JSON.parse discards evidence.
    const value = JSON.parse(raw, (_, v) => { if (typeof v === "number" && !Number.isFinite(v)) fail("invalid_request"); return v === 0 ? 0 : v; });
    if (object(value)) return value;
  } catch { /* do not include the parser diagnostic */ }
  return fail("invalid_request");
}
const pick = (value: Record<string, any>, fields: string) => Object.fromEntries(fields.split(" ").filter(k => Object.hasOwn(value, k)).map(k => [k, value[k]]));
// The upstream decoder checks known fields but preserves unknown fields for middleware.
// Reconciliation compares only members of the negotiated schema (including open metadata).
export function cleanMessage(m: Message): Message {
  const result = pick(m, "role id metadata encryptedValue subagentRunId");
  if (m.role !== "tool") Object.assign(result, pick(m, "name"));
  if ("content" in m) result.content = Array.isArray(m.content) ? m.content.map(p => ({ ...pick(p, "type id metadata"),
    ...(p.type === "text" ? { text: p.text } : { source: pick(p.source, "type value mimeType provider") }) })) : m.content;
  if (m.role === "assistant" && m.toolCalls) result.toolCalls = m.toolCalls.map(c => ({ ...pick(c, "id type encryptedValue metadata"), function: pick(c.function, "name arguments") }));
  if (m.role === "tool") Object.assign(result, pick(m, "toolCallId error"));
  return result as Message;
}
export function runInput(raw: Record<string, any>, warn: (field: string) => void): RunAgentInput {
  if (typeof raw.protocolVersion !== "string") fail("invalid_request");
  const version = /^(\d+)\.(\d+)$/.exec(raw.protocolVersion);
  if (version && Number(version[1]) !== 1) fail("not_supported");
  if (raw.protocolVersion !== "1.0") warn("protocolVersion");
  if (raw.forwardedProps === null) delete raw.forwardedProps;
  const parsed = RunAgentInputSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.threadId || !parsed.data.runId) fail("invalid_request");
  const data = parsed.data as RunAgentInput;
  if (data.context?.length) warn("context");
  data.messages = data.messages.filter(m => m.role !== "activity" && m.role !== "reasoning").map(cleanMessage);
  return data;
}
export function parts(message: Extract<Message, { role: "user" | "tool" }>, warn: (field: string) => void): ContentPart[] {
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  return message.content.flatMap<ContentPart>(p => {
    if (p.type === "text") return [{ type: "text", text: p.text }];
    if (p.type === "image" && p.source.type === "data") {
      const { value, mimeType } = p.source;
      if (!/^image\/[\w!#$&^.+-]+$/i.test(mimeType) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail("invalid_request");
      return [{ type: "image", data: value, mimeType }];
    }
    warn("messages.content"); return [];
  });
}
