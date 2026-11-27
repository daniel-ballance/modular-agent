import { isDeepStrictEqual } from "node:util";
import type { Actor, Authority, ContentPart, HistoryEntry, ToolCall, ToolDefinition } from "./types.js";

export const INTERFACE_HANDOFF = "modular-agent.interfaceHandoff";
export const INTERFACE_SOURCE = "sdk.interface-tools";

export interface InterfaceToolSource {
	sourceId: string;
	actorId: string;
	routeId: string;
	resultTimeoutMs: number;
	tools: readonly ToolDefinition[];
}

/** The embedding binding supplies the independently authenticated principal. */
export interface InterfaceToolConnectionOptions {
	actor: Actor;
	routeId: string;
	/** A synchronous delivery boundary. Do not buffer executable requests here. */
	onHandoff(request: InterfaceToolHandoff): void;
	/** Stage without delivering executable content. Use release() at the delivery boundary. */
	defer?: boolean;
}

export interface InterfaceToolHandoff {
	sessionId: string;
	turnId: string;
	deadline: number;
	call: ToolCall;
}

export interface InterfaceToolReport {
	callId: string;
	status: "completed" | "failed";
	content: ContentPart[];
	value?: unknown;
}

export type InterfaceToolReceipt = { status: "accepted" | "alreadySettled" } |
	{ status: "refused"; reason?: "notReady" };

export interface InterfaceToolConnection {
	advertise(tools: readonly ToolDefinition[]): void;
	release(callId: string): Promise<boolean>;
	reportInterfaceToolResult(report: InterfaceToolReport): Promise<InterfaceToolReceipt>;
	disconnect(): void;
}

/** Internal delivery boundary for the trusted AG-UI adapter. */
export interface AdapterInterfaceToolConnectionOptions extends InterfaceToolConnectionOptions {
	/** Return `"withheld"` only before attempting any executable write. A throw does not prove non-delivery. */
	onHandoff(request: InterfaceToolHandoff): void | "withheld";
}

export interface AdapterInterfaceToolConnection extends InterfaceToolConnection {
	/** Abandon this handle's still-staged calls for the turn. */
	withholdStaged(turnId: string): Promise<void>;
}

export interface HandoffData {
	toolStartedId: string;
	executorActorId: string;
	routeId: string;
	rights: Authority[];
	deadline: number;
}

interface StartData { call: ToolCall; definition: ToolDefinition; source: { plugin: string; toolSource: string }; safeToRepeat: boolean; openWorld: boolean }
export interface HandoffRecord {
	id: string;
	checkpoint?: HistoryEntry;
	start?: HistoryEntry;
	data?: HandoffData;
	dispatch?: StartData;
	result?: HistoryEntry;
}

/** Fold append order, including tombstones. A terminal result consumes identity even off branch. */
export function handoffRecords(kept: HistoryEntry[]): Map<string, HandoffRecord> {
	const records = new Map<string, HandoffRecord>();
	const record = (id: string) => {
		let item = records.get(id);
		if (!item) records.set(id, item = { id });
		return item;
	};
	for (const [i, entry] of kept.entries()) {
		const id = entry.toolCallId;
		if (!id) continue;
		if (entry.kind === "toolStarted" && (entry.data as StartData | undefined)?.source?.plugin === INTERFACE_SOURCE) {
			const item = record(id);
			if (item.start || item.checkpoint) { item.data = undefined; item.dispatch = undefined; }
			else { item.start = entry; item.dispatch = entry.data as StartData; }
		} else if (entry.kind === INTERFACE_HANDOFF) {
			const item = record(id);
			const duplicate = !!item.checkpoint;
			item.checkpoint = entry;
			const start = kept[i - 1];
			const data = entry.data as (HandoffData & { toolCallId?: string; turnId?: string; stepId?: string }) | undefined;
			if (start?.kind === "toolStarted" && start.toolCallId === id) item.start ??= start;
			item.data = !duplicate && entry.writer === "harness" && !entry.erased && !!item.dispatch && item.start === start && !start?.erased && start?.writer === "harness" && entry.parentId === start?.id &&
				item.dispatch.definition?.name === item.dispatch.call?.name &&
				item.dispatch.safeToRepeat === false && item.dispatch.openWorld === true && item.dispatch.call?.id === id &&
				item.dispatch.call.startedBy === "model" && item.dispatch.call.stepId === entry.stepId && !!entry.turnId && !!entry.stepId &&
				start?.turnId === entry.turnId && start?.stepId === entry.stepId && data?.toolStartedId === start?.id &&
				data?.toolCallId === id && data?.turnId === entry.turnId && data?.stepId === entry.stepId &&
				!!data.executorActorId && !!data.routeId && Array.isArray(data.rights) && data.rights.includes("watch") && data.rights.includes("tools") &&
				Number.isSafeInteger(data.deadline) && data.deadline > entry.time ? data : undefined;
		}
	}
	for (const e of kept) {
		const item = e.toolCallId && records.get(e.toolCallId);
		if (item && e.kind === "toolResult") item.result ??= e;
	}
	return records;
}

/** JSON structural equality ignores object key order, not missing fields or array order. */
export function sameDefinition(a: ToolDefinition, b: ToolDefinition): boolean {
	return isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
}

export function isJson(value: unknown, ancestors = new Set<object>()): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return true;
	if (typeof value !== "object" || ancestors.has(value) || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) return false;
	ancestors.add(value);
	const valid = (Array.isArray(value) ? Array.from(value) : Object.values(value)).every(part => isJson(part, ancestors));
	ancestors.delete(value);
	return valid;
}

export function validReportContent(content: unknown): content is ContentPart[] {
	return Array.isArray(content) && isJson(content) && content.every(part => {
		if (!part || Array.isArray(part) || typeof part !== "object") return false;
		switch (part.type) {
			case "text": return typeof part.text === "string";
			case "image": return typeof part.mimeType === "string" && /^image\/[\w!#$&^.+-]+$/i.test(part.mimeType) &&
				typeof part.data === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.data);
			case "toolCall": return typeof part.id === "string" && !!part.id && typeof part.name === "string" && !!part.name &&
				!!part.arguments && typeof part.arguments === "object" && !Array.isArray(part.arguments) &&
				(part.providerCallId === undefined || typeof part.providerCallId === "string" && !!part.providerCallId);
			case "reasoning": return (part.text !== undefined || part.providerData !== undefined) &&
				(part.text === undefined || typeof part.text === "string");
			default: return typeof part.type === "string" && !!part.type;
		}
	});
}
