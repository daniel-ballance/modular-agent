import type { Provider as BaseProvider, ProviderAvailability } from "@modular-agent/harness";
import type { AssistantMessage, ModelError, ModelInfo, ModelRef, ModelRequest } from "./data.js";
import { AgentError, checked, messageOf } from "./errors.js";

export interface ProviderContext {
  sessionId?: string;
  stepId?: string;
  cancelled: AbortSignal;
  piece(type: "text" | "reasoning" | "toolInput", delta: string, toolCallId?: string): void;
  log(message: string): void;
  emit(type: string, data: unknown): void;
  /** An explicit name is in-process only. Declare inProcessOnly when using it. */
  credential(name?: string): Promise<string | undefined>;
}
export type { ProviderAvailability } from "@modular-agent/harness";

export interface Provider {
  id: string;
  models(): ModelInfo[];
  supports: { keepsState: boolean; safeToRepeat: boolean };
  inProcessOnly?: boolean;
  inProcessInference?: boolean;
  availability?(context: Pick<ProviderContext, "credential">): ProviderAvailability | Promise<ProviderAvailability>;
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

export function adaptProvider(p: Provider, read: (name?: string) => Promise<string | undefined>,
  emit: (sessionId: string | undefined, type: string, data: unknown) => void): BaseProvider {
  const credential = (check: () => void): ProviderContext["credential"] => async name => {
    check();
    const key = await checked(() => read(name));
    check();
    return key;
  };
  const availability = p.availability?.bind(p);
  const checkAvailability = availability && (async () => {
    let active = true;
    try {
      return await availability({ credential: credential(() => {
        if (!active) throw new AgentError("invalid_request", "Provider availability check has settled");
      }) });
    } finally { active = false; }
  });
  return {
    id: p.id, inProcessInference: p.inProcessInference, models: () => structuredClone(p.models()),
    supports: { ...p.supports, runsTools: false, liveSessions: false },
    availability: checkAvailability,
    onChange: p.onChange?.bind(p),
    discardState: p.discardState && (async id => { await p.discardState!(id); }),
    async request(model, request, opts) {
      let active = true;
      const check = () => {
        if (!active) throw new AgentError("invalid_request", "Provider context has settled");
        if (opts.signal.aborted) throw new AgentError("cancelled", "Provider request was cancelled");
      };
      try {
        return await p.request(model, structuredClone(request), {
          sessionId: opts.sessionId, stepId: opts.stepId, cancelled: opts.signal,
          piece(type, delta, toolCallId) {
            check();
            opts.onEvent?.({ type, delta, ...(toolCallId ? { toolCallId } : {}) });
          },
          credential: credential(check),
          log(message) { check(); console.error(message); },
          emit(type, data) { check(); emit(opts.sessionId, type, data); },
        });
      } catch (error) {
        opts.signal.throwIfAborted();
        return { role: "assistant", stop: "failed", content: [],
          error: error instanceof ModelFailure ? error.modelError : { kind: "other", message: messageOf(error) } };
      } finally { active = false; }
    },
  };
}
