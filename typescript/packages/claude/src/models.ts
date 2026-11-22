import { subscriptionModels, type ModelEnrollment } from "@modular-agent/subscription";
import type { EffortLevel, ModelInfo as SdkModelInfo, ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";
import { PROVIDER_ID, REASONING_LEVELS, type ModelInfo, type Reasoning } from "./data.js";

/**
 * A Claude model as this Provider lists it. `thinking` holds the shared reasoning levels the
 * model accepts. `adaptive` models think adaptively and are steered by effort; the others take
 * a thinking token budget.
 */
export interface CatalogModel {
	id: string;
	name: string;
	contextWindow: number;
	maxOutput: number;
	adaptive: boolean;
	thinking: Reasoning[];
	input?: string[];
	reasoning?: boolean;
}

const baseline = subscriptionModels("claude");
const sharedLevels = new Map(baseline.map(model => [model.id, model.levels]));

export function baselineModels(enrolled?: readonly ModelEnrollment[]): CatalogModel[] {
	return subscriptionModels("claude", enrolled).map(model => ({
		id: model.id, name: model.name ?? model.id, contextWindow: model.contextWindow, maxOutput: model.maxOutput,
		adaptive: Object.values(model.levels).some(level => (level.thinking as ThinkingConfig | undefined)?.type === "adaptive"),
		thinking: REASONING_LEVELS.filter(level => Object.hasOwn(model.levels, level)),
		...(model.input.join(",") !== "text,image" ? { input: model.input } : {}),
		...(!model.reasoning ? { reasoning: false } : {}),
	}));
}

/**
 * Models the signed-in account offers, as Claude Code reported them. The built-in list
 * supplies the details for models it knows; an unknown model gets conservative limits and
 * the effort levels Claude Code named for it.
 */
export function discoveredModels(reported: readonly SdkModelInfo[], baseline: readonly CatalogModel[]): CatalogModel[] {
	const known = new Map(baseline.map((model) => [model.id, model]));
	const models = new Map<string, CatalogModel>();
	for (const info of reported) {
		// Aliases such as "opus" resolve to a concrete id; the bare "default" row repeats one of them.
		const id = info.resolvedModel ?? info.value;
		if (typeof id !== "string" || !id.startsWith("claude-") || models.has(id)) continue;
		const match = known.get(id);
		if (match) {
			models.set(id, { ...match, thinking: [...match.thinking] });
			continue;
		}
		const efforts = info.supportedEffortLevels ?? [];
		const name = typeof info.displayName === "string" && info.displayName ? info.displayName : id;
		models.set(id, {
			id,
			name: name.startsWith("Claude") ? name : `Claude ${name}`,
			contextWindow: 200_000,
			maxOutput: 32_000,
			// A model that reports effort levels takes adaptive thinking, which cannot be switched off.
			adaptive: true,
			thinking: (["low", "medium", "high", "xhigh"] as const).filter((level) => efforts.includes(level)),
		});
	}
	// Explicit enrollments remain available even if Claude Code does not list them.
	for (const model of baseline) if (!sharedLevels.has(model.id)) models.set(model.id, model);
	return [...models.values()];
}

/** The binding's ModelInfo for a catalog model. */
export function modelInfo(model: CatalogModel): ModelInfo {
	return {
		provider: PROVIDER_ID,
		id: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		maxOutput: model.maxOutput,
		input: model.input ?? ["text", "image"],
		reasoning: model.reasoning ?? model.thinking.some((level) => level !== "off"),
		...(model.thinking.length ? { thinking: [...model.thinking] } : {}),
	};
}

/** What the Agent SDK is told about thinking. Empty means Claude Code's own default. */
export interface Thinking {
	thinking?: ThinkingConfig;
	effort?: EffortLevel;
}

/**
 * The level to use for one asked for: itself if listed, otherwise the nearest listed level
 * below it. Never a higher one. Undefined means no reasoning setting (shared data, Models).
 */
export function nearestLevel(model: CatalogModel, level: Reasoning): Reasoning | undefined {
	if (model.thinking.includes(level)) return level;
	const at = REASONING_LEVELS.indexOf(level);
	return REASONING_LEVELS.slice(0, Math.max(at, 0)).reverse().find((l) => model.thinking.includes(l));
}

/**
 * Translate a shared reasoning level for one Claude Code process. No level means the
 * Provider default: nothing is set and Claude Code decides. `off` disables thinking.
 * Adaptive models take the effort of the same name (`minimal` runs at `low`); the older
 * models take a token budget.
 */
export function thinkingFor(model: CatalogModel, level: Reasoning | undefined, maxOutput = model.maxOutput): Thinking {
	if (level === undefined) return {};
	const use = nearestLevel(model, level);
	if (use === undefined) return {};
	const levels = sharedLevels.get(model.id);
	if (levels) {
		const fields = levels[use] as Thinking;
		if (fields.thinking?.type !== "enabled") return structuredClone(fields);
		const budgetTokens = Math.min(fields.thinking.budgetTokens ?? 1024, maxOutput - 1);
		return budgetTokens < 1024 ? structuredClone(levels.off as Thinking) : { ...fields, thinking: { ...fields.thinking, budgetTokens } };
	}
	if (model.adaptive && use !== "off") return { thinking: { type: "adaptive", display: "summarized" }, effort: use === "minimal" ? "low" : use };
	return {};
}
