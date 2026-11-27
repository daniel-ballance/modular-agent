import { type HistoryEntry, type HistorySelector } from "@modular-agent/harness";
import { historyForPeer } from "@modular-agent/harness/telemetry";
import { toWire } from "./translate.js";
import { WireError } from "./wire.js";

const invalid = (message: string) => new WireError("invalid_request", message);
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function selector(value: unknown, agreed: boolean): HistorySelector {
	if (!agreed) throw invalid("History selectors were not negotiated");
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("select must be an object");
	const keys = Object.keys(value);
	if (!keys.length || keys.some(key => key !== "turnId" && key !== "toolCallIds")) throw invalid("select must contain turnId or toolCallIds");
	if ("turnId" in value && !isId(value.turnId)) throw invalid("turnId must be a nonempty string");
	if ("toolCallIds" in value) {
		const ids = value.toolCallIds;
		if (!Array.isArray(ids) || !ids.length || ids.length > 64 || !ids.every(isId) || new Set(ids).size !== ids.length) {
			throw invalid("toolCallIds must contain 1 to 64 distinct IDs");
		}
	}
	return value as HistorySelector;
}

export function historyPage(view: HistoryEntry[], params: { all?: boolean; after?: string; limit?: number; select?: unknown }, agreed: boolean) {
	if (params.all != null && typeof params.all !== "boolean") throw invalid("all must be a boolean");
	if (params.select !== undefined) {
		const { turnId, toolCallIds } = selector(params.select, agreed);
		const calls = new Set(toolCallIds);
		view = view.filter(e => (turnId !== undefined && e.turnId === turnId) || (e.toolCallId !== undefined && calls.has(e.toolCallId)));
	}
	let from = 0;
	if (params.after != null || (params.select !== undefined && params.after !== undefined)) {
		from = view.findIndex(e => e.id === params.after) + 1;
		if (from === 0) throw invalid("Unknown history cursor");
	}
	const limit = params.limit ?? 500;
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw invalid("limit must be an integer from 1 to 500");
	const max = 4 * 1024 * 1024;
	const entries: HistoryEntry[] = [];
	let bytes = Buffer.byteLength('{"entries":[]}');
	for (let i = from; i < view.length && entries.length < limit; i++) {
		const entry = toWire(historyForPeer(view[i]));
		const size = Buffer.byteLength(JSON.stringify(entry));
		const nextBytes = i + 1 < view.length ? Buffer.byteLength(JSON.stringify(entry.id)) + 8 : 0;
		if (bytes + size + Number(entries.length > 0) + nextBytes > max) {
			if (!entries.length) throw new WireError("result_too_large", "One entry and its cursor do not fit in a page");
			break;
		}
		bytes += size + Number(entries.length > 0);
		entries.push(entry);
	}
	return { entries, ...(from + entries.length < view.length ? { next: entries.at(-1)!.id } : {}) };
}
