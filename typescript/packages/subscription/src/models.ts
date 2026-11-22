import { readFileSync } from "node:fs";
import type { ModelInfo } from "@modular-agent/core";

export type ModelEnrollment = Pick<ModelInfo, "id" | "name" | "contextWindow" | "maxOutput" | "input"> & { reasoning?: boolean };
export type SubscriptionModel = Omit<ModelInfo, "thinking"> & { levels: Record<string, Record<string, unknown>> };
export const reasoningLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
const table: { models: SubscriptionModel[] } = JSON.parse(readFileSync(new URL("../../subscription-models.json", import.meta.url), "utf8"));

export function subscriptionModels(provider: "chatgpt" | "claude", enrolled: readonly ModelEnrollment[] = []): SubscriptionModel[] {
  const catalog = new Map(table.models.filter(m => m.provider === provider).map(m => [m.id, structuredClone(m)]));
  for (const m of enrolled) if (!catalog.has(m.id)) catalog.set(m.id, {
    ...structuredClone(m), provider, reasoning: m.reasoning ?? false, levels: {},
  });
  return [...catalog.values()];
}

export function modelInfo({ levels, ...info }: SubscriptionModel): ModelInfo {
  const thinking = reasoningLevels.filter(level => Object.hasOwn(levels, level));
  return { ...structuredClone(info), ...(thinking.length ? { thinking } : {}) };
}

export function reasoningFields(model: SubscriptionModel, requested?: string): Record<string, unknown> | undefined {
  const index = reasoningLevels.indexOf(requested ?? "");
  const level = reasoningLevels.slice(0, index + 1).findLast(level => Object.hasOwn(model.levels, level));
  return level === undefined ? undefined : model.levels[level];
}
