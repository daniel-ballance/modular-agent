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
}

const ALL: Reasoning[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const without = (...drop: Reasoning[]): Reasoning[] => ALL.filter((level) => !drop.includes(level));

function adaptive(id: string, name: string, thinking: Reasoning[]): CatalogModel {
	return { id, name, contextWindow: 1_000_000, maxOutput: 128_000, adaptive: true, thinking };
}
function budgeted(id: string, name: string): CatalogModel {
	return { id, name, contextWindow: 200_000, maxOutput: 64_000, adaptive: false, thinking: without("xhigh") };
}

/**
 * The built-in list: the same models, limits and accepted levels as Pi's Claude catalog,
 * which the reference package (claude-subscription) starts from. What the account really
 * offers, and its real context windows, replace this once Claude Code has reported them.
 */
export function baselineModels(): CatalogModel[] {
	return [
		adaptive("claude-fable-5", "Claude Fable 5", without("off")),
		adaptive("claude-fable-5-1", "Claude Fable 5.1", without("off")),
		adaptive("claude-fable-5-2", "Claude Fable 5.2", without("off")),
		budgeted("claude-haiku-4-5", "Claude Haiku 4.5 (latest)"),
		budgeted("claude-haiku-4-5-20251001", "Claude Haiku 4.5"),
		adaptive("claude-haiku-5-5", "Claude Haiku 5.5", without("minimal")),
		budgeted("claude-opus-4-5", "Claude Opus 4.5 (latest)"),
		budgeted("claude-opus-4-5-20251101", "Claude Opus 4.5"),
		adaptive("claude-opus-4-6", "Claude Opus 4.6", without("xhigh")),
		adaptive("claude-opus-4-7", "Claude Opus 4.7", ALL),
		adaptive("claude-opus-4-8", "Claude Opus 4.8", ALL),
		adaptive("claude-opus-5", "Claude Opus 5", ALL),
		adaptive("claude-opus-5-5", "Claude Opus 5.5", without("off", "minimal")),
		budgeted("claude-sonnet-4-5", "Claude Sonnet 4.5 (latest)"),
		budgeted("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"),
		adaptive("claude-sonnet-4-6", "Claude Sonnet 4.6", without("xhigh")),
		adaptive("claude-sonnet-5", "Claude Sonnet 5", ALL),
		adaptive("claude-sonnet-5-5", "Claude Sonnet 5.5", without("off", "minimal")),
	];
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
		input: ["text", "image"],
		reasoning: model.thinking.some((level) => level !== "off"),
		...(model.thinking.length ? { thinking: [...model.thinking] } : {}),
	};
}

/** What the Agent SDK is told about thinking. Empty means Claude Code's own default. */
export interface Thinking {
	thinking?: ThinkingConfig;
	effort?: EffortLevel;
}

const BUDGETS: Record<Exclude<Reasoning, "off">, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 16384 };

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
export function thinkingFor(model: CatalogModel, level: Reasoning | undefined): Thinking {
	if (level === undefined) return {};
	const use = nearestLevel(model, level);
	if (use === undefined) return {};
	if (use === "off") return { thinking: { type: "disabled" } };
	if (model.adaptive) return { thinking: { type: "adaptive", display: "summarized" }, effort: use === "minimal" ? "low" : use };
	return { thinking: { type: "enabled", budgetTokens: BUDGETS[use], display: "summarized" } };
}
