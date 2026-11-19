import type { Provider as BaseProvider } from "@modular-agent/harness";
import type { AssistantMessage, ModelError, ModelInfo, ModelRef, ModelRequest } from "./data.js";
import { AgentError } from "./errors.js";

export interface ProviderContext {
  sessionId?: string;
  stepId?: string;
  cancelled: AbortSignal;
  piece(type: "text" | "reasoning" | "toolInput", delta: string, toolCallId?: string): void;
  credential(): Promise<string | undefined>;
}
export interface Provider {
  id: string;
  models(): ModelInfo[];
  supports: { keepsState: boolean; safeToRepeat: boolean };
  inProcessOnly?: boolean;
  available?(): boolean | Promise<boolean>;
  request(model: ModelRef, request: ModelRequest, context: ProviderContext): AssistantMessage | Promise<AssistantMessage>;
  discardState?(sessionId: string): void | Promise<void>;
}

export class ModelFailure extends Error {
  constructor(readonly modelError: ModelError) { super(modelError.message); }
}

export function adaptProvider(p: Provider, credential: () => Promise<string | undefined> = async () => undefined): BaseProvider {
  return {
    id: p.id, models: () => structuredClone(p.models()),
    supports: { ...p.supports, runsTools: false, liveSessions: false },
    available: p.available && (async () => p.available!()),
    discardState: p.discardState && (async id => { await p.discardState!(id); }),
    async request(model, request, opts) {
      let active = true;
      const check = () => {
        if (!active) throw new AgentError("invalid_request", "Provider context has settled");
        opts.signal.throwIfAborted();
      };
      try {
        return await p.request(model, structuredClone(request), {
          sessionId: opts.sessionId, stepId: opts.stepId, cancelled: opts.signal,
          piece(type, delta, toolCallId) {
            check();
            opts.onEvent?.({ type, delta, ...(toolCallId ? { toolCallId } : {}) });
          },
          async credential() { check(); return credential(); },
        });
      } catch (error) {
        if (error instanceof ModelFailure) return { role: "assistant", stop: "failed", content: [], error: error.modelError };
        throw error;
      } finally { active = false; }
    },
  };
}
