import type { AssistantMessage, ModelInfo, ModelRef, ModelRequest, Provider, ProviderAvailability, RequestOptions } from "@modular-agent/harness";
import { fromWire, toWire, wireEqual } from "./translate.js";
import { WireError, type WirePeer } from "./wire.js";

export interface ProviderAttempt {
	model: ModelRef;
	request: unknown;
	prepare?: () => Promise<ModelRequest>;
	handoff?: RequestOptions["handoff"];
	begun?: boolean;
	committed?: boolean;
	response?: unknown;
	failure?: unknown;
}

type TrackProvider = <T>(p: Promise<T> & { id: number }, parent: {
	provider: ProviderAttempt; sessionId?: string; signal: AbortSignal;
}) => Promise<T>;

export class WireProvider implements Provider {
	readonly prepareOnWire = true;
	constructor(private peer: WirePeer, readonly id: string, readonly supports: Provider["supports"], private list: ModelInfo[], private track: TrackProvider) {}
	models(): ModelInfo[] {
		return this.list;
	}
	private refresh?: Promise<void>;
	private changed = new Set<() => void>();
	onChange(handler: () => void): () => void {
		this.changed.add(handler);
		return () => { this.changed.delete(handler); };
	}
	refreshModels(): Promise<void> {
		return this.refresh ??= this.peer.request<{ models: ModelInfo[] }>("provider/models", { provider: this.id }).then(reply => {
			const models = fromWire(reply.models) as ModelInfo[];
			if (!wireEqual(models, this.list)) {
				this.list = models;
				for (const handler of this.changed) handler();
			}
		}).finally(() => { this.refresh = undefined; });
	}
	async availability(signal?: AbortSignal): Promise<ProviderAvailability> {
		const status = await this.peer.request<{ available?: unknown; reason?: unknown }>("provider/available", { provider: this.id }, signal);
		if (status?.available === true) return { available: true };
		if (status?.available === false) {
			return typeof status.reason === "string" && status.reason.trim()
				? { available: false, reason: status.reason } : { available: false };
		}
		throw new WireError("invalid_request", "Invalid provider/available reply: expected a boolean available field");
	}
	async request(model: ModelRef, request: ModelRequest, options: RequestOptions): Promise<AssistantMessage> {
		const status = await this.availability(options.signal);
		if (!status.available) throw new Error(status.reason ?? "Provider is not available");
		const attempt: ProviderAttempt = { model, request: toWire(request), prepare: options.prepareDispatch, handoff: options.handoff };
		const req = this.peer.request("provider/request", { provider: this.id, model, request: attempt.request, sessionId: options.sessionId }, options.signal);
		const onEvent = (p: { parentRequestId: number; event: { type: "text" | "reasoning" | "toolInput"; delta: string } }) => {
			if (p.parentRequestId === req.id && attempt.committed && !attempt.response && !options.signal.aborted) options.onEvent?.(p.event);
		};
		WireProvider.listen(this.peer, req.id, onEvent);
		try {
			const answer = await this.track(req, { provider: attempt, sessionId: options.sessionId, signal: options.signal });
			if (!attempt.committed || !attempt.response || !wireEqual(answer, attempt.response)) throw new WireError("invalid_request", "Provider did not settle the committed attempt consistently");
			return fromWire(answer) as AssistantMessage;
		} catch (error) {
			if (attempt.failure) throw attempt.failure;
			if (!attempt.committed && options.prepareDispatch) throw error;
			if (options.signal.aborted) return { role: "assistant", content: [], stop: "aborted" };
			return { role: "assistant", content: [], stop: "failed", error: { kind: "temporary", message: error instanceof Error ? error.message : String(error) } };
		} finally {
			WireProvider.listeners.get(this.peer)?.delete(req.id);
		}
	}
	async discardState(sessionId: string, options?: { erase?: boolean; entryIds?: string[] }): Promise<{ pending?: string[]; outOfReach?: string[] }> {
		return this.peer.request("provider/discard", { provider: this.id, sessionId, erase: options?.erase, entryIds: options?.entryIds });
	}
	static listeners = new WeakMap<WirePeer, Map<number, (p: any) => void>>();
	static listen(peer: WirePeer, id: number, fn: (p: any) => void): void {
		let m = WireProvider.listeners.get(peer);
		if (!m) {
			m = new Map();
			WireProvider.listeners.set(peer, m);
			const all = m;
			peer.onNotification("provider/event", (p) => all.get(p?.parentRequestId)?.(p));
		}
		m.set(id, fn);
	}
}
