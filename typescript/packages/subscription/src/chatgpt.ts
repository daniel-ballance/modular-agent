import { AgentError, ModelFailure, type AssistantMessage, type ContentPart, type ModelError, type ModelRequest, type Provider, type ProviderContext } from "@modular-agent/core";
import { chatgptAccount, chatgptOAuth, loopback, type OAuthTestOptions } from "./oauth.js";
import type { Login, SubscriptionLogins } from "./logins.js";
import { resolveClientIdentity, type ClientIdentityOptions } from "./client-identity.js";
import { modelInfo, reasoningFields, subscriptionModels, type ModelEnrollment, type SubscriptionModel } from "./models.js";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const textOf = (content: ContentPart[]) => content.filter(p => p.type === "text").map(p => p.text).join("");
const images = (parts: ContentPart[]) => parts.flatMap(p => p.type === "image" && typeof p.mimeType === "string" && typeof p.data === "string"
  ? [{ type: "input_image", image_url: `data:${p.mimeType};base64,${p.data}` }] : []);
export function requestBody(model: SubscriptionModel, request: ModelRequest, session: string) {
  const input: unknown[] = [];
  for (const message of request.messages) {
    const text = textOf(message.content), attachments = images(message.content);
    if (message.role === "assistant") {
      const calls = message.content.filter(p => p.type === "toolCall");
      const opaque = message.providerData;
      if (object(opaque) && opaque.provider === "chatgpt" && Array.isArray(opaque.output)) {
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
  const fields = reasoningFields(model, request.settings.reasoning);
  if (fields?.reasoning) body.reasoning = { ...(fields.reasoning as object), summary: "auto" };
  body.instructions = request.systemPrompt || "You are a helpful assistant.";
  body.text = { verbosity: "low" };
  body.prompt_cache_key = session;
  body.input = input;
  return body;
}
const failure = (kind: ModelError["kind"], message: string) => new ModelFailure({ kind, message });
function apiFailure(status: number | undefined, error: unknown) {
  const e = object(error) ? error : {};
  const code = typeof e.code === "string" ? e.code : typeof e.type === "string" ? e.type : "";
  let kind: ModelError["kind"] = "other";
  if (["context_length_exceeded", "context_window_exceeded"].includes(code)) kind = "contextTooLarge";
  else if (["usage_limit_reached", "usage_not_included", "insufficient_quota"].includes(code)) kind = "other";
  else if (["invalid_api_key", "authentication_error", "token_expired"].includes(code) || status === 401 || status === 403) kind = "credentials";
  else if (["rate_limit_exceeded", "server_error", "overloaded"].includes(code) || status === 429 || (status && status >= 500)) kind = "temporary";
  else if (code === "content_policy_violation") kind = "refused";
  return failure(kind, kind === "credentials" ? "ChatGPT refused the login. Sign in again."
    : status ? `The ChatGPT request failed (HTTP ${status}).` : "The ChatGPT stream reported a failure.");
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
      case "response.reasoning_summary_text.delta": if (typeof event.delta === "string") ctx.piece("reasoning", event.delta); break;
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
      if (done) { consume(buffer.replace(/\r$/, "")); consume(""); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!completed) throw failure("temporary", "the model stream ended before a complete response");
  if ((!Array.isArray(completed.output) || !completed.output.length) && items.length) completed.output = items;
  return completed;
}
function message(raw: Record<string, unknown>): AssistantMessage {
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
        catch { throw new Error("the model sent tool arguments that are not JSON"); }
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
    providerData: { provider: "chatgpt", output: raw.output }, usage: { input: usage?.input_tokens ?? 0, output: usage?.output_tokens ?? 0,
      cacheRead: usage?.input_tokens_details?.cached_tokens ?? 0, cacheWrite: 0, cost: 0 } };
}

export interface ChatGPTOptions extends ClientIdentityOptions {
  logins: SubscriptionLogins;
  models?: readonly ModelEnrollment[];
  /** Explicit catalog replacements, used by ma's operator-owned models.json. */
  modelOverrides?: readonly Omit<SubscriptionModel, "provider">[];
  /** Offline fixtures only. Use only with test credentials. */
  test?: { endpoint: string; oauth?: OAuthTestOptions };
}

export function chatgpt({ logins, models: enrolled, modelOverrides, clientIdentity, test }: ChatGPTOptions): Provider & {
  available(): Promise<boolean>;
} {
  let identity: string;
  try { identity = resolveClientIdentity(clientIdentity); }
  catch (error) { throw new AgentError("invalid_composition", (error as Error).message); }
  const models = new Map(subscriptionModels("chatgpt", enrolled).map(model => [model.id, model]));
  for (const model of modelOverrides ?? []) models.set(model.id, { ...structuredClone(model), provider: "chatgpt" });
  const tokenService = chatgptOAuth(identity, test ? test.oauth ?? { endpoints: {} } : undefined);
  const endpoint = test ? loopback(test.endpoint) : "https://chatgpt.com/backend-api/codex/responses";
  return {
    id: "chatgpt", supports: { keepsState: false, safeToRepeat: true },
    async available() { return !!await logins.login("chatgpt"); },
    models: () => Array.from(models.values(), modelInfo),
    async request(ref, request, ctx) {
      const model = models.get(ref.id);
      if (ref.provider !== "chatgpt" || !model) throw new AgentError("invalid_request", "ChatGPT does not offer that model");
      const session = ctx.sessionId ?? "", body = JSON.stringify(requestBody(model, request, session));
      const login = async (rejected?: Login) => logins.current("chatgpt", old => tokenService.refresh(old, ctx.cancelled), rejected, ctx.cancelled)
        .catch(err => {
          ctx.cancelled.throwIfAborted();
          if (err instanceof ModelFailure) throw err;
          throw failure("credentials", "Could not use the ChatGPT login file. Check its permissions and sign in again.");
        });
      let credential = await login();
      for (let attempt = 0; ; attempt++) {
        const bearer = credential.type === "oauth" ? credential.access : credential.key;
        let account: string;
        try { account = (credential.type === "oauth" ? credential.account : undefined) ?? chatgptAccount(bearer); }
        catch { throw failure("credentials", "The ChatGPT login names no account. Sign in again."); }
        const headers = { authorization: `Bearer ${bearer}`, accept: "text/event-stream", "content-type": "application/json",
          "chatgpt-account-id": account, "OpenAI-Beta": "responses=experimental", originator: identity, "session-id": session, "x-client-request-id": session };
        const res = await fetch(endpoint, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.any([ctx.cancelled, AbortSignal.timeout(300_000)]) })
          .catch(() => { throw failure("temporary", "Could not reach the ChatGPT subscription endpoint."); });
        if (res.ok) {
          try { return message(await readStream(res, ctx)); }
          catch (error) {
            ctx.cancelled.throwIfAborted();
            if (error instanceof ModelFailure) throw error;
            throw failure("other", "The ChatGPT response was not valid.");
          }
        }
        if (res.status === 401 && attempt === 0 && credential.type === "oauth") {
          await res.body?.cancel();
          credential = await login(credential);
          continue;
        }
        const data: unknown = await res.json().catch(() => undefined);
        throw apiFailure(res.status, object(data) ? object(data.error) ? data.error : data : undefined);
      }
    },
  };
}
