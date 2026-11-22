import { ModelFailure, type AssistantMessage, type ContentPart, type ModelError, type ModelRequest, type Provider, type ProviderContext, type Settings } from "@modular-agent/core";
import defaults from "./models.json" with { type: "json" };
import { type AuthFile, type Login } from "./auth.js";
import { chatgptAccount, labels, loopback, oauth, type Vendor } from "./oauth.js";
import { resolveClientIdentity, type ClientIdentityOptions } from "./client-identity.js";

const endpoints = { "openai-codex": "https://chatgpt.com/backend-api/codex/responses", xai: "https://api.x.ai/v1/responses" };
const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
interface Model { id: string; name: string; contextWindow: number; maxTokens: number; effort: Record<string, string> }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function catalogModels(vendor: Vendor, overrides: Settings): Model[] {
  const entries = new Map<string, Model>(defaults[vendor].map(m => [m.id, m as Model]));
  const extra = overrides[vendor];
  if (extra !== undefined && !Array.isArray(extra)) throw new Error(`models.json: ${vendor} must be an array`);
  for (const m of extra ?? []) {
    if (!object(m) || typeof m.id !== "string" || typeof m.name !== "string" || !Number.isSafeInteger(m.contextWindow) || !Number.isSafeInteger(m.maxTokens) ||
        (m.contextWindow as number) <= 0 || (m.maxTokens as number) <= 0 || !object(m.effort) || Object.values(m.effort).some(e => typeof e !== "string"))
      throw new Error(`models.json: invalid ${vendor} model`);
    entries.set(m.id, m as unknown as Model);
  }
  return [...entries.values()];
}
const textOf = (content: ContentPart[]) => content.filter(p => p.type === "text").map(p => p.text).join("");
const images = (parts: ContentPart[]) => parts.flatMap(p => p.type === "image" && typeof p.mimeType === "string" && typeof p.data === "string"
  ? [{ type: "input_image", image_url: `data:${p.mimeType};base64,${p.data}` }] : []);
export function requestBody(vendor: Vendor, model: Model, request: ModelRequest, session: string) {
  const input: unknown[] = [];
  for (const message of request.messages) {
    const text = textOf(message.content), attachments = images(message.content);
    if (message.role === "assistant") {
      const calls = message.content.filter(p => p.type === "toolCall");
      const opaque = message.providerData;
      if (object(opaque) && opaque.provider === vendor && Array.isArray(opaque.output)) {
        let index = 0;
        for (const item of opaque.output) input.push(item.type === "function_call" && calls[index] ? { ...item, call_id: calls[index++].id } : item);
      } else {
        if (text) input.push({ role: "assistant", content: text });
        for (const call of calls) input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
      }
    } else if (message.role === "toolResult") {
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: text });
      if (attachments.length) input.push({ role: "user", content: attachments });
    } else input.push({ role: message.role, content: attachments.length ? [{ type: "input_text", text }, ...attachments] : text });
  }
  const body: Record<string, unknown> = { model: model.id, stream: true, store: false, include: ["reasoning.encrypted_content"], tool_choice: "auto", parallel_tool_calls: true };
  if (request.tools.length) body.tools = request.tools.map(t => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false }));
  const asked = levels.indexOf(request.settings.reasoning ?? "");
  const level = levels.slice(0, asked + 1).findLast(l => Object.hasOwn(model.effort, l));
  if (level) body.reasoning = { effort: model.effort[level], summary: "auto" };
  if (vendor === "openai-codex") {
    body.instructions = request.systemPrompt || "You are a helpful assistant.";
    body.text = { verbosity: "low" };
    body.prompt_cache_key = session;
  } else {
    if (request.systemPrompt) input.unshift({ role: "system", content: request.systemPrompt });
    const cap = request.settings.maxOutput;
    if (cap && cap > 0) body.max_output_tokens = Math.min(cap, model.maxTokens);
  }
  body.input = input;
  return body;
}
const failure = (kind: ModelError["kind"], message: string) => new ModelFailure({ kind, message });
function apiFailure(status: number | undefined, error: unknown, vendor?: Vendor) {
  const e = object(error) ? error : {};
  const code = typeof e.code === "string" ? e.code : typeof e.type === "string" ? e.type : "";
  const message = [e.message, e.detail, error].find((m): m is string => typeof m === "string") ?? "the model service refused the request";
  let kind: ModelError["kind"] = "other";
  if (["context_length_exceeded", "context_window_exceeded"].includes(code)) kind = "contextTooLarge";
  else if (["usage_limit_reached", "usage_not_included", "insufficient_quota"].includes(code)) kind = "other";
  else if (["invalid_api_key", "authentication_error", "token_expired"].includes(code) || status === 401 || status === 403) kind = "credentials";
  else if (["rate_limit_exceeded", "server_error", "overloaded"].includes(code) || status === 429 || (status && status >= 500)) kind = "temporary";
  else if (code === "content_policy_violation") kind = "refused";
  return failure(kind, message + (code ? ` (${code})` : status ? ` (HTTP ${status})` : "") + (vendor && kind === "credentials" ? ` Run \`ma login ${vendor}\` to sign in again.` : ""));
}

async function readStream(res: Response, ctx: ProviderContext) {
  if (!res.body) throw failure("temporary", "the model stream ended before a complete response");
  const reader = res.body.getReader(), decoder = new TextDecoder("utf8", { fatal: true });
  let buffer = "", data = "", completed: Record<string, unknown> | undefined;
  const items: unknown[] = [];
  const limit = 16 * 1024 * 1024;
  const consume = (line: string) => {
    if (line.startsWith("data:")) {
      data += (data ? "\n" : "") + line.slice(5).trimStart();
      if (Buffer.byteLength(data) >= limit) throw new Error("model event too large");
    }
    if (line || !data) return;
    const event = data === "[DONE]" ? {} : JSON.parse(data);
    data = "";
    switch (event.type) {
      case "response.output_text.delta": if (typeof event.delta === "string") ctx.piece("text", event.delta); break;
      case "response.output_item.done": items.push(event.item); break;
      case "response.completed": case "response.incomplete": case "response.done": completed = event.response; break;
      case "response.failed": throw apiFailure(undefined, event.response?.error);
      case "error": throw apiFailure(undefined, object(event.error) ? event.error : event);
    }
  };
  try {
    for (;;) {
      ctx.cancelled.throwIfAborted();
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let at: number;
      while ((at = buffer.indexOf("\n")) !== -1) {
        if (at >= limit) throw new Error("model event too large");
        consume(buffer.slice(0, at).replace(/\r$/, ""));
        buffer = buffer.slice(at + 1);
      }
      if (Buffer.byteLength(buffer) >= limit) throw new Error("model event too large");
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!completed) throw failure("temporary", "the model stream ended before a complete response");
  if ((!Array.isArray(completed.output) || !completed.output.length) && items.length) completed.output = items;
  return completed;
}
function message(vendor: Vendor, raw: Record<string, unknown>): AssistantMessage {
  const content: ContentPart[] = [];
  if (!Array.isArray(raw.output)) throw new Error("the model response has no output");
  for (const item of raw.output) {
    switch (item.type) {
      case "message":
        for (const p of item.content ?? []) content.push(p.type === "output_text" ? { type: "text", text: p.text ?? "" }
          : p.type === "refusal" ? { type: "text", text: p.refusal ?? "model refused" } : p);
        break;
      case "function_call": {
        let args: unknown;
        try { args = JSON.parse(item.arguments?.trim() || "{}"); }
        catch (err) { throw new Error(`the model sent tool arguments that are not JSON: ${(err as Error).message}`); }
        if (!object(args)) throw new Error("the model sent tool arguments that are not an object");
        if (typeof item.call_id !== "string") throw new Error("missing tool call id");
        if (typeof item.name !== "string") throw new Error("missing tool name");
        content.push({ type: "toolCall", id: item.call_id, name: item.name, arguments: args });
        break;
      }
      case "reasoning": content.push({ type: "reasoning", providerData: item }); break;
      default: content.push(item);
    }
  }
  const usage = raw.usage as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } | undefined;
  return { role: "assistant", stop: raw.status === "incomplete" ? "length" : content.some(p => p.type === "toolCall") ? "toolUse" : "finished", content,
    providerData: { provider: vendor, output: raw.output }, usage: { input: usage?.input_tokens ?? 0, output: usage?.output_tokens ?? 0,
      cacheRead: usage?.input_tokens_details?.cached_tokens ?? 0, cacheWrite: 0, cost: 0 } };
}

type ResponsesOptions = ClientIdentityOptions & { test?: { endpoint: string; oauth: ReturnType<typeof oauth> } };
export function responses(vendor: Vendor, auth: Pick<AuthFile, "login" | "current">, overrides: Settings = {},
  { clientIdentity: identity, test }: ResponsesOptions = {}): Provider {
  const clientIdentity = resolveClientIdentity(identity);
  const models = catalogModels(vendor, overrides), tokenService = test?.oauth ?? oauth({ clientIdentity });
  const endpoint = test ? loopback(test.endpoint) : endpoints[vendor];
  return {
    id: vendor, supports: { keepsState: false, safeToRepeat: true }, inProcessOnly: true,
    async available() { return !!await auth.login(vendor); },
    models: () => models.map(m => ({ provider: vendor, id: m.id, name: m.name, contextWindow: m.contextWindow, maxOutput: m.maxTokens,
      thinking: levels.filter(l => Object.hasOwn(m.effort, l)), reasoning: Object.keys(m.effort).some(l => l !== "off"), input: ["text", "image"] })),
    async request(ref, request, ctx) {
      const model = models.find(m => m.id === ref.id);
      if (!model) throw new Error(`${vendor} does not offer ${ref.id}`);
      const session = ctx.sessionId ?? "", body = JSON.stringify(requestBody(vendor, model, request, session));
      const login = async (rejected?: Login) => auth.current(vendor, old => tokenService.refresh(vendor, old, ctx.cancelled), rejected, ctx.cancelled)
        .catch(err => { throw failure("credentials", (err as Error).message); });
      let credential = await login();
      for (let attempt = 0; ; attempt++) {
        const bearer = credential.type === "oauth" ? credential.access : credential.key;
        const headers: Record<string, string> = { authorization: `Bearer ${bearer}`, accept: "text/event-stream", "content-type": "application/json" };
        if (vendor === "openai-codex") {
          try { headers["chatgpt-account-id"] = (credential.type === "oauth" ? credential.account : undefined) ?? chatgptAccount(bearer); }
          catch (err) { throw failure("credentials", (err as Error).message); }
          Object.assign(headers, { "OpenAI-Beta": "responses=experimental", originator: clientIdentity, "session-id": session, "x-client-request-id": session });
        }
        const res = await fetch(endpoint, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.any([ctx.cancelled, AbortSignal.timeout(300_000)]) })
          .catch(err => { throw failure("temporary", `could not reach ${labels[vendor]}: ${(err as Error).message}`); });
        if (res.ok) return message(vendor, await readStream(res, ctx));
        if (res.status === 401 && attempt === 0 && credential.type === "oauth") {
          await res.body?.cancel();
          credential = await login(credential);
          continue;
        }
        const text = await res.text().catch(() => "");
        let data: unknown;
        try { data = JSON.parse(text); } catch { data = undefined; }
        throw apiFailure(res.status, object(data) ? object(data.error) ? data.error : data : { message: [...text].slice(0, 500).join("") }, vendor);
      }
    },
  };
}
