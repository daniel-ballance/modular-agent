import { AgentError, defineProvider, type Provider } from "@modular-agent/core";
import type { ModelEnrollment } from "@modular-agent/subscription";
import { ClaudeProvider, type ProviderOptions } from "./provider.js";
import { installedSdkVersion } from "./sdk.js";

export interface ClaudeOptions {
  models?: readonly ModelEnrollment[];
  project?: string;
  log?: (message: string) => void;
  /** Offline fixtures only. A supplied query replaces the Agent SDK. */
  test?: Pick<ProviderOptions, "loginVisible" | "query" | "env">;
}

/** Use the Claude Code plan sign-in. This Provider never signs in. */
export function claude(options: ClaudeOptions = {}) {
  const impl = new ClaudeProvider({
    version: "0.1.0", sdkVersion: options.test ? "fixture" : installedSdkVersion(),
    env: process.env, ...options.test, models: options.models, log: options.log,
    checkApiRouting: true, onChange: () => provider.changed(),
  });
  if (options.project) impl.project(options.project);
  const provider = defineProvider({
    id: "claude", supports: { keepsState: false, safeToRepeat: false },
    models: () => impl.catalog(),
    available: () => impl.ready(),
    unavailableReason: () => impl.unavailableReason(),
    close: () => impl.close(),
    async request(ref, request, cx) {
      const model = impl.model(ref.id);
      if (ref.provider !== "claude" || !model) throw new AgentError("invalid_request", "Claude does not offer that model");
      return impl.infer(model, request, cx.cancelled, e => cx.piece(e.type, e.delta, "toolCallId" in e ? e.toolCallId : undefined));
    },
  } satisfies Provider & { unavailableReason(): string | undefined; close(): void });
  return provider;
}
