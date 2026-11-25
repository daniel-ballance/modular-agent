import { failure } from "./failure.js";
import type { HookRegistry } from "./hooks.js";
import { INTERFACE_HANDOFF } from "./interface-tools.js";
import { mapOutput, OUTPUT_SEGMENT_BYTES } from "./output.js";
import { resourceBytes } from "./reservations.js";
import { historyForPeer } from "./telemetry.js";
import type { AgentEvent, HistoryEntry, ModelRequest, OutputAnswer } from "./types.js";
import { withoutProviderData } from "./view.js";

/** One recipient of agent events through the output gate, such as a session follower or a plugin's event subscription. */
export class Follower {
	private pending = 0;
	private bytes = 0;
	private charges = new Map<AgentEvent, () => void>();
	private disconnected = false;
	private held: AgentEvent[] = [];
	private streams = new Map<string, AgentEvent[]>();
	private chain: Promise<void> = Promise.resolve();
	constructor(
		private hooks: HookRegistry,
		readonly recipient: string,
		private raw: boolean,
		private listener: (event: AgentEvent) => unknown,
		private onError: (e: unknown) => void,
		private onLag?: () => void,
		private reserve?: (bytes: number) => (() => void) | undefined,
		private admit?: (event: AgentEvent) => Promise<void> | undefined,
		private include?: (event: AgentEvent) => boolean,
	) {}

	get closed() { return this.disconnected; }

	private drop(events: Iterable<AgentEvent>) {
		for (const event of events) {
			this.charges.get(event)?.();
			this.charges.delete(event);
		}
	}

	disconnect(): void {
		this.disconnected = true;
		this.drop(this.charges.keys());
		this.held = [];
		this.streams.clear();
	}

	push(event: AgentEvent): void {
		if (this.disconnected || this.include && !this.include(event)) return;
		const nativeSize = resourceBytes(event);
		const size = !this.raw && this.hooks.raw("output").some(h => h.stream) && ["model.output","tool.progress"].includes(event.type)
			? Math.max(nativeSize, resourceBytes(mapOutput(event).wire) + 2) : nativeSize;
		const lease = this.reserve?.(size);
		if (this.pending >= 1024 || this.bytes + size > 64 * 1024 * 1024 || this.reserve && !lease) {
			lease?.();
			this.disconnect();
			this.onLag?.();
			return;
		}
		this.bytes += size;
		this.charges.set(event, () => { lease?.(); this.bytes -= size; });
		this.pending++;
		this.chain = this.chain.then(() => this.disconnected ? undefined : this.deliver(event)).catch(this.onError).finally(() => {
			this.pending--;
			if (!this.held.includes(event) && ![...this.streams.values()].some(items => items.includes(event))) this.drop([event]);
		});
	}

	/** Resolves once each event pushed so far has been delivered, blocked, or kept in a stream buffer until its stream ends. */
	idle(): Promise<void> {
		return this.chain;
	}

	private originals = new WeakMap<AgentEvent, AgentEvent>();
	private async deliver(event: AgentEvent): Promise<void> {
		const original = event;
		const admission = this.admit?.(original);
		if (admission) await admission;
		if (!this.raw && (event.type === "entry" || event.type === "entry.added")) {
			const originalEntry = event.data as HistoryEntry;
			const entry = originalEntry.kind === "inputAnswer" ? historyForPeer(originalEntry) : originalEntry;
			if (entry.kind === INTERFACE_HANDOFF) return;
			const data = entry.data as { request?: ModelRequest } | undefined;
			event = { ...event, data: { ...entry,
				...(entry.message ? { message: withoutProviderData(entry.message) } : {}),
				...(entry.kind === "modelRequest" && data?.request && Array.isArray(data.request.messages) ? { data: { ...data, request: {
					...data.request, messages: data.request.messages.map(withoutProviderData),
				} } } : {}),
			} };
		}
		if (event !== original) this.originals.set(event, original);
		const handlers = this.raw ? [] : this.hooks.raw("output");
		if (event.type === "session.interrupted") {
			// An incomplete stream must not be released because its writer stopped.
			this.drop(this.held);
			for (const pieces of this.streams.values()) this.drop(pieces);
			this.held = [];
			this.streams.clear();
		}
		const modelEnd = event.type === "model.streamEnd";
		if (handlers.some((h) => h.stream)) {
			const stream = event.type === "model.output" || modelEnd
				? ["model", event.sessionId, event.turnId, event.stepId]
				: event.type === "tool.progress" || event.type === "tool.ended"
					? ["tool", event.sessionId, event.toolCallId] : undefined;
			if (stream) {
				const key = JSON.stringify(stream);
				const pieces = this.streams.get(key) ?? [];
				if (!modelEnd && event.type !== "tool.ended") {
					pieces.push(event);
					this.streams.set(key, pieces);
					return;
				}
				this.streams.delete(key);
				try { if (pieces.length) await this.gate(pieces, true, handlers); }
				finally { this.drop(pieces); }
			}
			if (!modelEnd) await this.gate([event], true, handlers);
			return;
		}
		const events = this.held.splice(0);
		if (!modelEnd) events.push(event);
		try { if (events.length) await this.gate(events, event.type !== "model.output", handlers); }
		finally { this.drop(events.filter(event => !this.held.includes(event))); }
	}

	private async gate(initial: AgentEvent[], final: boolean, handlers: ReturnType<HookRegistry["raw"]>): Promise<void> {
		const heldStream = handlers.some(h => h.stream);
		const bytes = (e: AgentEvent) => resourceBytes(mapOutput(e).wire);
		const overflow = () => failure("result_too_large", "Output exceeds the gate or buffer limit");
		const accepted: AgentEvent[] = [], charges: Array<() => void> = [];
		try {
			for (let start = 0; start < initial.length;) {
				let end = start, charged = 2;
				if (heldStream) {
					for (; end < initial.length; ++end) {
						const size = bytes(initial[end]);
						if (size + 2 > OUTPUT_SEGMENT_BYTES) throw overflow();
						const next = charged + size + Number(end > start);
						if (next > OUTPUT_SEGMENT_BYTES) break;
						charged = next;
					}
				} else end = initial.length;
				let events = initial.slice(start,end);
				for (const h of handlers) {
					const answer = await h.handler({sessionId: initial[0].sessionId, events, recipient:this.recipient, final}) as OutputAnswer;
					if (!answer) continue;
					if (answer.action === "block") return;
					if (answer.action === "hold") {
						if (!final && events.every(e => this.charges.has(e))) this.held = events;
						return;
					}
					if (!answer.events) continue;
					events = answer.events;
					if (heldStream) {
						const n = events.reduce((sum,e,i) => sum + bytes(e) + Number(i>0), 2);
						if (n > OUTPUT_SEGMENT_BYTES) throw overflow();
						if (n > charged) {
							const delta = n-charged;
							if (this.bytes+delta > 64*1024*1024) throw overflow();
							const lease = this.reserve?.(delta);
							if (this.reserve && !lease) throw overflow();
							this.bytes += delta;
							charges.push(() => {this.bytes -= delta; lease?.()});
							charged = n;
						}
					}
				}
				for (const event of events) accepted.push(event);
				start = end;
			}
			// No segment may escape before all segments pass all gates.
			for (const e of accepted) if (!this.disconnected) {
				for (const original of initial) {
					const admission = this.admit?.(this.originals.get(original) ?? original);
					if (admission) await admission;
				}
				if (!this.disconnected) await this.listener(e);
			}
		} catch (e) {
			if (heldStream && this.onLag && ["model.output","tool.progress"].includes(initial[0].type) &&
				(e as {code?:string})?.code === "result_too_large") {
				this.disconnect(); this.onLag(); return;
			}
			throw e;
		} finally { for (const release of charges) release(); }
	}
}
