import { AgentError, type Provider } from "@modular-agent/core";
import { apiKeyModelAdapter } from "@modular-agent/provider-pi-ai";

export interface OpenAIOptions {
  /** Override the default service address, for example for a loopback test. */
  baseUrl?: string;
}

/** OpenAI Responses API with `OPENAI_API_KEY` from the agent's credential store. */
export function openai({ baseUrl }: OpenAIOptions = {}): Provider {
  const { models, provider } = apiKeyModelAdapter("openai");
  return {
    id: "openai", models: () => structuredClone(models),
    supports: { keepsState: false, safeToRepeat: true },
    available: () => !!process.env.OPENAI_API_KEY,
    async request(model, request, cx) {
      if (model.provider !== "openai" || !models.some(m => m.id === model.id)) throw new AgentError("invalid_request", "Model is not offered");
      const key = await cx.credential();
      if (!key) return { role: "assistant", content: [], stop: "failed", error: { kind: "credentials", message: "OPENAI_API_KEY is not set" } };
      return provider.request(model, request, {
        baseUrl, apiKey: key, signal: cx.cancelled, sessionId: cx.sessionId, requestPrepared: true,
        onEvent: e => cx.piece(e.type, e.delta),
      });
    },
  };
}
