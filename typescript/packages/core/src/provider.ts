import type { Provider as BaseProvider } from "@modular-agent/harness";
import type { AssistantMessage, ModelError, ModelInfo, ModelRef, ModelRequest } from "./data.js";
import { AgentError, messageOf } from "./errors.js";

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
  available?(context: Pick<ProviderContext, "credential">): boolean | Promise<boolean>;
  /** Subscribe to local catalog invalidation. Use defineProvider to publish it. */
  onChange?(handler: () => void): () => void;
  request(model: ModelRef, request: ModelRequest, context: ProviderContext): AssistantMessage | Promise<AssistantMessage>;
  discardState?(sessionId: string): void | Promise<void>;
}

export function defineProvider<P extends Provider>(provider: P): P & { changed(): void } {
  const listeners = new Set<() => void>();
  return Object.assign(provider, {
    changed() { for (const listener of listeners) listener(); },
    onChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
}

export class ModelFailure extends Error {
  constructor(readonly modelError: ModelError) { super(modelError.message); }
}

export function adaptProvider(p: Provider, credential: () => Promise<string | undefined> = async () => undefined): BaseProvider {
  return {
    id: p.id, models: () => structuredClone(p.models()),
    supports: { ...p.supports, runsTools: false, liveSessions: false },
    available: p.available && (async () => p.available!({ credential })),
    onChange: p.onChange?.bind(p),
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
          async credential() { check(); const key = await credential(); check(); return key; },
        });
      } catch (error) {
        opts.signal.throwIfAborted();
        return { role: "assistant", stop: "failed", content: [],
          error: error instanceof ModelFailure ? error.modelError : { kind: "other", message: messageOf(error) } };
      } finally { active = false; }
    },
  };
}
