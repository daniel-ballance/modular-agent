import { randomUUID } from "node:crypto";
import { erasedEntry, type HistoryEntry, type HistoryStore, type Plugin, type StoredSession } from "@modular-agent/harness";
import { call, type ClientOptions, ServiceError } from "./http.js";
export { HISTORY_BINDING, historyService } from "./history-service.js";

/**
 * A history store that is a modular-agent-history/1 service, in any language.
 * Every request is safe to resend, so each is retried when the network fails.
 */
export class HttpHistoryStore implements HistoryStore {
	readonly supports = { erasure: true, retention: false };
	/** This agent, as a writer the service can tell apart from others. */
	private owner = randomUUID();
	private leases = new Map<string, { lease: string; timer: NodeJS.Timeout; lost: boolean }>();
	/**
	 * New sessions not yet sent: a session is sent only once something happens in it
	 * beyond setup, so one started just to look leaves nothing in the service.
	 */
	private unsent = new Map<string, { meta: StoredSession; batches: HistoryEntry[][]; writing: boolean }>();

	constructor(private client: ClientOptions) {}

	private path(id: string, rest = ""): string {
		return `/v1/sessions/${encodeURIComponent(id)}${rest}`;
	}

	async create(meta: StoredSession): Promise<void> {
		this.unsent.set(meta.id, { meta, batches: [], writing: false });
	}

	private async send(id: string): Promise<void> {
		const pending = this.unsent.get(id)!;
		this.unsent.delete(id);
		const { id: _id, ...body } = pending.meta;
		await call(this.client, "PUT", this.path(id), { body, retry: true });
		if (pending.writing) await this.takeLease(id);
		for (const batch of pending.batches) await this.post(id, batch);
	}

	async openForWriting(id: string, options?: { wait?: boolean }): Promise<void> {
		const existing = this.leases.get(id);
		if (existing?.lost) throw new Error(`Session ${id} is not open for writing: its lease is lost`);
		if (existing) return;
		const pending = this.unsent.get(id);
		if (pending) {
			pending.writing = true;
			return;
		}
		await this.takeLease(id, options?.wait);
	}

	private async takeLease(id: string, wait = false): Promise<void> {
		const acquire = () => call<{ lease: string; ttlMs: number }>(this.client, "POST", this.path(id, "/lease"), { body: { owner: this.owner }, retry: true });
		let deadline: number | undefined;
		let grant;
		for (;;) {
			try { grant = await acquire(); break; } catch (error) {
				if (!wait || !(error instanceof ServiceError) || error.code !== "held"
					|| !Number.isFinite(error.retryAfterMs) || error.retryAfterMs! < 0) throw error;
				if (deadline === undefined) {
					const caps = await call<{ ttlMs?: number }>(this.client, "GET", "/v1");
					deadline = Date.now() + (caps.ttlMs ?? error.retryAfterMs!);
				}
				const delay = Math.max(1, error.retryAfterMs!);
				if (Date.now() + delay > deadline) throw error;
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
		const { lease, ttlMs } = grant;
		const held = { lease, lost: false, timer: undefined as unknown as NodeJS.Timeout };
		held.timer = setInterval(() => {
			call(this.client, "POST", this.path(id, `/lease/${lease}/renew`), { retry: true }).catch((error) => {
				// A lost lease is final: this agent stops writing rather than quietly taking a new one.
				if (error instanceof ServiceError && error.status === 409) {
					held.lost = true;
					clearInterval(held.timer);
				}
			});
		}, Math.max(1, Math.floor(ttlMs / 3)));
		held.timer.unref();
		this.leases.set(id, held);
	}

	async close(id: string): Promise<void> {
		// Closed before anything happened in it: nothing to send.
		if (this.unsent.delete(id)) return;
		const held = this.leases.get(id);
		if (!held) return;
		clearInterval(held.timer);
		this.leases.delete(id);
		await call(this.client, "DELETE", this.path(id, `/lease/${held.lease}`), { retry: true }).catch(() => undefined);
	}

	async append(id: string, batch: HistoryEntry[]): Promise<void> {
		if (!batch.length) return;
		const pending = this.unsent.get(id);
		if (pending) {
			pending.batches.push(batch);
			if (batch.some((e) => e.kind !== "setting" && e.kind !== "actorJoined" && e.kind !== "plugins")) await this.send(id);
			return;
		}
		await this.post(id, batch);
	}

	private async post(id: string, batch: HistoryEntry[]): Promise<void> {
		const held = this.leases.get(id);
		if (!held || held.lost) throw new Error(`Session ${id} is not open for writing: its lease is lost`);
		await call(this.client, "POST", this.path(id, "/entries"), { body: { lease: held.lease, entries: batch }, retry: true });
	}

	async load(id: string): Promise<{ meta: StoredSession; entries: HistoryEntry[] }> {
		const pending = this.unsent.get(id);
		if (pending) return { meta: pending.meta, entries: pending.batches.flat() };
		const r = await call<{ session: StoredSession; entries: HistoryEntry[] }>(this.client, "GET", this.path(id), { retry: true });
		return { meta: r.session, entries: r.entries };
	}

	async list(filter?: { project?: string }): Promise<StoredSession[]> {
		const r = await call<{ sessions: StoredSession[] }>(this.client, "GET", `/v1/sessions${filter?.project ? `?project=${encodeURIComponent(filter.project)}` : ""}`, { retry: true });
		return r.sessions;
	}

	async erase(id: string, entryIds: string[]): Promise<void> {
		const pending = this.unsent.get(id);
		if (pending) {
			const targets = new Set(entryIds);
			pending.batches = pending.batches.map((b) => b.map((e) => (targets.has(e.id) ? erasedEntry(e) : e)));
			return;
		}
		const held = this.leases.get(id);
		await call(this.client, "POST", this.path(id, "/erase"), { body: { entryIds, ...(held ? { lease: held.lease } : {}) }, retry: true });
	}
}

export function historyHttp(client: ClientOptions): Plugin {
	return {
		name: "history-http",
		replaces: "history-jsonl",
		setup(api) {
			api.provide("history-store", new HttpHistoryStore(client));
		},
	};
}
