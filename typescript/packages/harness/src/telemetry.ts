import { AsyncLocalStorage } from "node:async_hooks";
import { context, isSpanContextValid, metrics, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace,
	type Attributes, type Context, type Span, type SpanContext } from "@opentelemetry/api";
import type { AssistantMessage, HistoryEntry, ToolCall } from "./types.js";
import { INTERFACE_HANDOFF } from "./interface-tools.js";

export { SpanKind };
export interface TraceContext { traceparent: string }
export const TURN_TRACE = "modular-agent.turnTrace";
export const conversation = (id: string): Attributes => ({ "gen_ai.conversation.id": id });
const scopeKeys = ["gen_ai.conversation.id", "modular_agent.turn.id", "modular_agent.step.id"] as const;
const scope = new AsyncLocalStorage<{ context: Context; attributes: Attributes; operation: Operation }>();

// Only IDs and flags are carried. There is no configured allowlist for vendor state.
export function readTrace(value: unknown): SpanContext | undefined {
	const header = (value as { traceparent?: unknown } | null)?.traceparent;
	if (typeof header !== "string" || header.length > 512) return;
	const parts = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(.*)$/.exec(header);
	if (!parts || parts[0] !== header || parts[1] === "ff" || (parts[5] && (parts[1] === "00" || !parts[5].startsWith("-")))) return;
	const candidate = { traceId: parts[2], spanId: parts[3], traceFlags: Number.parseInt(parts[4], 16), isRemote: true };
	if (isSpanContextValid(candidate)) return candidate;
}

export function carrier(parent: SpanContext | undefined): TraceContext | undefined {
	if (!parent || !isSpanContextValid(parent)) return;
	return { traceparent: `00-${parent.traceId}-${parent.spanId}-${(parent.traceFlags & 255).toString(16).padStart(2, "0")}` };
}

function withoutState({ traceId, spanId, traceFlags, isRemote }: SpanContext): SpanContext {
	return { traceId, spanId, traceFlags, isRemote };
}

export function currentSpan(): SpanContext | undefined {
	return trace.getSpanContext(scope.getStore()?.context ?? context.active());
}

export function withTrace<T>(parent: SpanContext | undefined, work: () => T): T {
	const ctx = parent ? trace.setSpanContext(ROOT_CONTEXT, parent) : ROOT_CONTEXT;
	return new Operation(undefined, undefined, ctx, {}).run(work);
}

export function safeName(value: unknown): string | undefined {
	return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value) ? value : undefined;
}

export function startOperation(name: string, attributes: Attributes = {}, options: {
	kind?: SpanKind; parent?: SpanContext | null; links?: SpanContext[];
} = {}) {
	const active = scope.getStore();
	const candidate = options.parent === undefined ? currentSpan() : options.parent;
	const parent = candidate && isSpanContextValid(candidate) ? withoutState(candidate) : undefined;
	const parentContext = parent ? trace.setSpanContext(ROOT_CONTEXT, parent) : ROOT_CONTEXT;
	const inherited = active && (options.parent === undefined || (parent && trace.getSpanContext(active.context)?.traceId === parent.traceId)) ? active.attributes : {};
	const all = { ...inherited, ...attributes };
	let span: Span | undefined;
	let sc: SpanContext | undefined;
	try {
		span = trace.getTracer("modular-agent").startSpan(name, { kind: options.kind, attributes: all, links: options.links?.map(context => ({ context: withoutState(context) })) }, parentContext);
		const candidate = span.spanContext();
		if (isSpanContextValid(candidate) && candidate.spanId !== parent?.spanId) sc = candidate;
	} catch { /* The application's instrumentation must not affect work. */ }
	return new Operation(span, sc, parentContext, all);
}

export class Operation {
	private ended = false;
	private readonly ctx: Context;
	private readonly scopeAttributes: Attributes = {};
	constructor(private readonly span: Span | undefined, readonly spanContext: SpanContext | undefined, parent: Context, attributes: Attributes) {
		this.ctx = span && spanContext ? trace.setSpan(ROOT_CONTEXT, span) : parent;
		for (const key of scopeKeys) if (attributes[key] !== undefined) this.scopeAttributes[key] = attributes[key];
	}
	get isOpen(): boolean { return !this.ended; }
	run<T>(work: () => T): T {
		return scope.run({ context: this.ctx, operation: this, attributes: this.scopeAttributes }, () => context.with(this.ctx, work));
	}
	set(key: string, value: string | number | boolean | string[] | undefined): void {
		if (value === undefined || this.ended) return;
		if (scopeKeys.some(k => k === key)) this.scopeAttributes[key] = value;
		try { this.span?.setAttribute(key, value); } catch { /* best effort */ }
	}
	event(name: string, attributes: Attributes): void {
		if (this.ended) return;
		try { this.span?.addEvent(name, { ...this.scopeAttributes, ...attributes }); } catch { /* best effort */ }
	}
	fail(code: string): void {
		try { this.set("error.type", code); this.span?.setStatus({ code: SpanStatusCode.ERROR }); } catch { /* best effort */ }
	}
	end(): void {
		if (this.ended) return;
		this.ended = true;
		try { this.span?.end(); } catch { /* best effort */ }
	}
	async observe<T>(work: () => Promise<T>, type = "failed"): Promise<T> {
		try { return await this.run(work); }
		catch (error) { this.fail(type); throw error; }
		finally { this.end(); }
	}
}

export function activeOperation(): Operation | undefined { return scope.getStore()?.operation; }
export function telemetryEvent(name: string, attributes: Attributes = {}): void { activeOperation()?.event(name, attributes); }

export function toolAttributes(call: Pick<ToolCall, "id" | "name" | "startedBy" | "parentCallId">): Attributes {
	return { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": safeName(call.name),
		"gen_ai.tool.call.id": call.startedBy === "model" ? safeName(call.id) : undefined,
		"modular_agent.tool.call.id": safeName(call.id), "modular_agent.tool.parent_call.id": safeName(call.parentCallId) };
}

export function historyForPeer(entry: HistoryEntry): HistoryEntry {
	if (entry.kind === TURN_TRACE || entry.kind === INTERFACE_HANDOFF) { const { data: _data, ...envelope } = entry; return envelope; }
	if (entry.kind !== "turnStart" || !entry.data || typeof entry.data !== "object") return entry;
	const { traceContext: _traceContext, ...data } = entry.data as Record<string, unknown>;
	return { ...entry, data };
}

const providerNames: Record<string, string> = {
	"anthropic": "anthropic", "claude": "anthropic", "openai": "openai", "openai-codex": "openai",
	"google": "gcp.gemini", "google-vertex": "gcp.vertex_ai", "amazon-bedrock": "aws.bedrock",
	"azure-openai-responses": "azure.ai.openai", "xai": "x_ai",
};

export async function observeInference(providerId: string, model: string, attributes: Attributes,
	stream: boolean, work: () => Promise<AssistantMessage>, remote = true): Promise<AssistantMessage> {
	const name = safeName(model);
	const dimensions: Attributes = { "gen_ai.operation.name": "chat", "gen_ai.provider.name": Object.hasOwn(providerNames, providerId)
		? providerNames[providerId] : safeName(providerId) ?? "unknown", "gen_ai.request.model": name };
	const operation = startOperation(name ? `chat ${name}` : "chat", {
		...dimensions, ...attributes, "modular_agent.provider.id": safeName(providerId), "gen_ai.request.stream": stream,
	}, { kind: remote ? SpanKind.CLIENT : SpanKind.INTERNAL });
	const start = performance.now();
	let errorType: string | undefined;
	let reply: AssistantMessage | undefined;
	try {
		reply = await operation.run(work);
		if (reply.stop === "failed") {
			const kind = reply.error?.kind;
			errorType = kind === "temporary" || kind === "contextTooLarge" || kind === "credentials" || kind === "refused" ? kind : "failed";
		}
		operation.set("gen_ai.response.model", reply.model?.id === model ? name : undefined);
		if (["finished", "length", "toolUse", "aborted", "refused", "failed"].includes(reply.stop)) operation.set("gen_ai.response.finish_reasons", [reply.stop]);
		return reply;
	} catch (error) {
		if ((error as { name?: unknown; code?: unknown })?.name !== "AbortError" && (error as { code?: unknown })?.code !== "cancelled") errorType = "failed";
		throw error;
	} finally {
		const elapsed = (performance.now() - start) / 1000;
		if (errorType) operation.fail(errorType);
		try {
			const meter = metrics.getMeter("modular-agent");
			meter.createHistogram("gen_ai.client.inference.duration", { unit: "s" }).record(elapsed,
				errorType ? { ...dimensions, "error.type": errorType } : dimensions);
			const usage = reply?.usage;
			if (usage) {
				const tokens = (n: number) => Number.isSafeInteger(n) && n >= 0 ? n : 0;
				const cacheRead = tokens(usage.cacheRead);
				const cacheWrite = tokens(usage.cacheWrite);
				if (cacheRead) operation.set("gen_ai.usage.cache_read.input_tokens", cacheRead);
				if (cacheWrite) operation.set("gen_ai.usage.cache_write.input_tokens", cacheWrite);
				for (const [label, count] of [["input", tokens(usage.input) + cacheRead + cacheWrite], ["output", tokens(usage.output)]] as const) {
					if (!Number.isSafeInteger(count)) continue;
					operation.set(`gen_ai.usage.${label}_tokens`, count);
					if (count) meter.createCounter(`gen_ai.client.inference.usage.${label}_tokens`, { unit: "{token}" })
						.add(count, { ...dimensions, "gen_ai.token.modality": "unknown" });
				}
			}
		} catch { /* A meter or exporter failure must not affect work. */ }
		operation.end();
	}
}
