import { AgentError, type Provider } from "@modular-agent/core";
import { apiKeyModelAdapter, type ApiKeyModelEnrollment } from "@modular-agent/provider-pi-ai";

export interface AnthropicOptions {
  /** Override the default service address, for example for a loopback test. */
  baseUrl?: string;
  /** Additional model IDs with explicit limits and input types; no reasoning levels. */
  models?: readonly ApiKeyModelEnrollment[];
}

/** Anthropic Messages API with `ANTHROPIC_API_KEY` from the agent's credential store. */
export function anthropic({ baseUrl, models: enrolled }: AnthropicOptions = {}): Provider {
  const { models, provider } = apiKeyModelAdapter("anthropic", enrolled);
  return {
    id: "anthropic", models: () => structuredClone(models),
    supports: { keepsState: false, safeToRepeat: true },
    available: async cx => !!(await cx.credential()),
    async request(model, request, cx) {
      if (model.provider !== "anthropic" || !models.some(m => m.id === model.id)) throw new AgentError("invalid_request", "Model is not offered");
      const key = await cx.credential();
      if (!key) return { role: "assistant", content: [], stop: "failed", error: { kind: "credentials", message: "ANTHROPIC_API_KEY is not set" } };
      return provider.request(model, request, {
        baseUrl, apiKey: key, signal: cx.cancelled, sessionId: cx.sessionId, requestPrepared: true,
        onEvent: e => cx.piece(e.type, e.delta),
      });
    },
  };
}
