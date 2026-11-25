import type { HistoryEntry, ModelInfo } from "./types.js";

export function parseModel(value: unknown): { provider: string; id: string } | undefined {
	if (typeof value === "string" && value.includes("/")) {
		const i = value.indexOf("/");
		return { provider: value.slice(0, i), id: value.slice(i + 1) };
	}
	if (value && typeof value === "object" && "provider" in value && "id" in value) return value as { provider: string; id: string };
	return undefined;
}

export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function thinkingLevels(model?: ModelInfo): string[] {
	return REASONING_LEVELS.filter(level => model?.thinking?.includes(level) === true);
}

export function lowerReasoning(value: unknown, model?: ModelInfo): string | undefined {
	if (typeof value !== "string" || value === "default") return undefined;
	if (!model) return value;
	const index = REASONING_LEVELS.findIndex((level) => level === value);
	return thinkingLevels(model).findLast((level) => REASONING_LEVELS.findIndex((known) => known === level) <= index);
}

export function validateRecordedApproval(entry: HistoryEntry): void {
	if (entry.erased) return;
	const data = entry.data as { key?: string; value?: unknown; settings?: unknown } | undefined;
	if (!data) return;
	const patch = entry.kind === "turnStart" ? data.settings :
		entry.kind !== "setting" ? undefined :
		data.key === "settings" ? data.value : { [data.key ?? ""]: data.value };
	if (!patch || typeof patch !== "object") return;
	for (const key of ["approval", "approvalPolicy"] as const) {
		if (Object.hasOwn(patch, key) && typeof (patch as Record<string, unknown>)[key] !== "string") {
			throw new Error("Recorded approval must be a string");
		}
	}
}

export function recordedApproval(value: unknown): "off" | "ask" | "all" | "never" {
	return value === "off" || value === "ask" || value === "all" ? value : "never";
}

export function normalizeSetting({ key, value }: { key: string; value: unknown }): { key: string; value: unknown } {
	if (key === "approvalPolicy" || key === "approval") return { key: "approval", value: recordedApproval(value) };
	if (key === "thinking") return { key: "reasoning", value };
	if (key === "model") return { key, value: parseModel(value) ?? null };
	if (key === "settings" && value && typeof value === "object") {
		return { key, value: Object.fromEntries(Object.entries(value).map(([key, value]) => {
			const setting = normalizeSetting({ key, value });
			return [setting.key, setting.value];
		})) };
	}
	return { key, value: value ?? null };
}
