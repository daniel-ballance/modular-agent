import type { Settings } from "@modular-agent/core";
import type { SubscriptionModel } from "@modular-agent/subscription";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const positiveInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

// Keep the operator's existing models.json format while using the SDK catalog.
export function subscriptionModelOverrides(provider: string, overrides: Settings): Omit<SubscriptionModel, "provider">[] {
  const extra = overrides[provider];
  if (extra !== undefined && !Array.isArray(extra)) throw new Error(`models.json: ${provider} must be an array`);
  return (extra ?? []).map(m => {
    if (!object(m) || typeof m.id !== "string" || typeof m.name !== "string" ||
        !positiveInt(m.contextWindow) || !positiveInt(m.maxTokens) ||
        !object(m.effort) || Object.values(m.effort).some(e => typeof e !== "string"))
      throw new Error(`models.json: invalid ${provider} model`);
    return { id: m.id, name: m.name, contextWindow: m.contextWindow, maxOutput: m.maxTokens, input: ["text", "image"],
      reasoning: Object.keys(m.effort).some(level => level !== "off"),
      levels: Object.fromEntries(Object.entries(m.effort).map(([level, effort]) => [level, { reasoning: { effort } }])) };
  });
}
