import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { erasedEntry, type HistoryEntry, type HistoryStore, type Plugin, type StoredSession } from "@modular-agent/harness";
import { call, type ClientOptions, ServiceError } from "./http.js";
import { HISTORY_BINDING } from "./history-service.js";
export { HISTORY_BINDING, historyService } from "./history-service.js";

const segment = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const pathId = (value: string) => {
	if (!value || value === "." || value === "..") throw new Error("Invalid history path id");
	return segment(value);
};
const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const timeout = (ms: number) => AbortSignal.timeout(Math.max(1, Math.min(2 ** 31 - 1, Math.ceil(ms))));
const bodyCap = 64 * 1024 * 1024;

// Linux CLOCK_BOOTTIME (the first field in /proc/uptime) includes suspension.
// Add a tick when measuring against a deadline to cover its truncated precision.
function clock(): number {
	if (process.platform === "linux") return Number(readFileSync("/proc/uptime", "utf8").split(" ", 1)[0]) * 1000;
	return performance.now();
}
const guard = process.platform === "linux" ? 10 : 0;

export function historyClientOptions(url: string, token: string): ClientOptions {
	const address = new URL(url);
	const host = address.hostname.replace(/^\[|\]$/g, "");
	if (address.username || address.password || /[?#]/.test(url) || (address.protocol !== "https:" && (address.protocol !== "http:" ||
		!(host === "::1" || (isIP(host) === 4 && host.startsWith("127."))) || !/^http:\/\/(?:127\.(?:\d+\.){2}\d+|\[::1\])(?=[:/]|$)/.test(url)))) {
		throw new Error("Invalid history service URL (use HTTPS or numeric loopback HTTP)");
	}
	token = token.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
	if (!/^[A-Za-z0-9._~+/\-]+=*$/.test(token)) throw new Error("Invalid history bearer token configuration");
	return { url: address.href.replace(/\/+$/, ""), token };
}

type Lease = { value: string; ttl: number; cutoff: number; timer?: NodeJS.Timeout; abort: AbortController };
type Pending = { meta: StoredSession; entries: HistoryEntry[]; abort: AbortController };

export class HttpHistoryStore implements HistoryStore {
	readonly supports = { erasure: true, retention: false };
	private owner = randomUUID();
	private leases = new Map<string, Lease>();
	private unsent = new Map<string, Pending>();
	private client: ClientOptions;
	private ttl?: number;

	constructor(client: ClientOptions) { this.client = historyClientOptions(client.url, client.token); }
	async initialize() {
		const caps = await call<{ binding: string; ttlMs: number; retention?: number | null }>(this.client, "GET", "/v1", { signal: timeout(10_000) });
		if (caps.binding !== HISTORY_BINDING || !positive(caps.ttlMs) || (caps.retention != null && !positive(caps.retention))) throw new Error("Unsupported history service declaration");
		this.ttl = caps.ttlMs;
		this.supports.retention = caps.retention != null;
	}
	private path(id: string, rest = ""): string { return `/v1/sessions/${pathId(id)}${rest}`; }
	async create(meta: StoredSession): Promise<void> {
		this.unsent.set(meta.id, { meta, entries: [], abort: new AbortController() });
	}
	async openForWriting(id: string, options?: { wait?: boolean }): Promise<void> {
		if (this.unsent.has(id)) return;
		if (this.leases.has(id)) { this.checkWriter(id); return; }
		await this.takeLease(id, options?.wait);
	}
	writerSignal(id: string): AbortSignal | undefined { return this.leases.get(id)?.abort.signal ?? this.unsent.get(id)?.abort.signal; }
	checkWriter(id: string): void {
		const lease = this.leases.get(id);
		if (!lease && this.unsent.has(id)) return;
		if (!lease) throw new Error("Session is not open for writing");
		if (clock() + guard >= lease.cutoff) this.lose(lease);
		if (lease.abort.signal.aborted) throw lease.abort.signal.reason;
	}
	private lose(lease: Lease) {
		clearTimeout(lease.timer);
		lease.abort.abort(new Error("Session is not open for writing: its lease is lost"));
	}
	private async takeLease(id: string, wait = false, abort = new AbortController()): Promise<void> {
		if (this.ttl === undefined) await this.initialize();
		let budget: number | undefined;
		let lostReply = false;
		for (;;) {
			const sent = clock();
			const remaining = (budget ?? Infinity) - sent;
			if (remaining <= guard) throw new Error("History lease open budget exhausted");
			let grant: { lease: string; ttlMs: number };
			try {
				grant = await call(this.client, "POST", this.path(id, "/lease"), { body: { owner: this.owner }, signal: timeout(Math.min(remaining, 10_000)) });
			} catch (error) {
				if (!(error instanceof ServiceError) && !lostReply) { lostReply = true; continue; }
				if (!wait || !(error instanceof ServiceError) || error.code !== "held" || !positive(error.retryAfterMs)) throw error;
				budget ??= clock() + this.ttl! + 1000;
				if (clock() + error.retryAfterMs + guard >= budget) throw error;
				await sleep(error.retryAfterMs);
				continue;
			}
			if (typeof grant.lease !== "string" || !positive(grant.ttlMs)) throw new Error("Invalid history lease grant");
			pathId(grant.lease);
			const lease: Lease = { value: grant.lease, ttl: grant.ttlMs, cutoff: sent + grant.ttlMs / 2, abort };
			this.leases.set(id, lease);
			this.checkWriter(id);
			if (lostReply) await this.renew(id, lease);
			else this.schedule(id, lease, sent);
			return;
		}
	}
	private schedule(id: string, lease: Lease, sent: number) {
		lease.timer = setTimeout(() => { void this.renew(id, lease).catch(() => this.lose(lease)); }, Math.max(1, Math.min(2 ** 31 - 1, sent + lease.ttl / 3 - clock())));
		lease.timer.unref();
	}
	private async renew(id: string, lease: Lease) {
		this.checkWriter(id);
		const sent = clock();
		const reply = await call<{ ttlMs: number }>(this.client, "POST", this.path(id, `/lease/${pathId(lease.value)}/renew`), { signal: AbortSignal.any([lease.abort.signal, timeout(lease.cutoff - sent - guard)]) });
		if (!positive(reply.ttlMs) || clock() + guard >= Math.min(lease.cutoff, sent + reply.ttlMs / 2) || lease.abort.signal.aborted) {
			this.lose(lease);
			throw lease.abort.signal.reason;
		}
		lease.ttl = reply.ttlMs;
		lease.cutoff = sent + lease.ttl / 2;
		this.schedule(id, lease, sent);
	}
	async close(id: string): Promise<void> {
		this.unsent.delete(id);
		const lease = this.leases.get(id);
		if (!lease) return;
		this.lose(lease);
		this.leases.delete(id);
		await call(this.client, "DELETE", this.path(id, `/lease/${pathId(lease.value)}`), { signal: timeout(1000) }).catch(() => undefined);
	}
	async append(id: string, batch: HistoryEntry[]): Promise<void> {
		if (!batch.length) return;
		const pending = this.unsent.get(id);
		if (pending) {
			pending.entries.push(...batch);
			if (!pending.meta.forkedFrom && !batch.some((e) => e.kind === "inputAccepted")) return;
			const { id: _id, ...body } = pending.meta;
			// Forks currently use the reference deployment's 32-character lease;
			// reserve considerably more for deployments with configured longer IDs.
			if (Buffer.byteLength(JSON.stringify({ lease: "x".repeat(1024), entries: pending.entries })) > bodyCap) {
				this.unsent.delete(id);
				throw new ServiceError(413, "Initial history batch is too large", "result_too_large");
			}
			try {
				await call(this.client, "PUT", this.path(id), { body, retry: true, signal: timeout(10_000) });
				await this.takeLease(id, false, pending.abort);
			} catch (e) { pending.abort.abort(e); throw e; }
			this.unsent.delete(id);
			batch = pending.entries;
		}
		const lease = this.leases.get(id);
		this.checkWriter(id);
		await this.mutate(id, "/entries", { lease: lease!.value, entries: batch }, lease);
	}
	private async mutate(id: string, path: string, body: unknown, lease?: Lease) {
		for (let attempt = 0; ; attempt++) {
			if (lease) this.checkWriter(id);
			try {
				await call(this.client, "POST", this.path(id, path), { body, signal: lease ? AbortSignal.any([lease.abort.signal, timeout(lease.cutoff - clock() - guard)]) : timeout(10_000) });
				if (lease) this.checkWriter(id);
				return;
			} catch (error) {
				if (error instanceof ServiceError && error.code !== "lost" && attempt === 0) throw error;
				// Retry an identical mutation only if this generation is still proven current.
				if (!(error instanceof ServiceError) && lease && attempt < 4 && !lease.abort.signal.aborted && clock() + guard < lease.cutoff) continue;
				if (lease) this.lose(lease);
				throw error;
			}
		}
	}
	async load(id: string): Promise<{ meta: StoredSession; entries: HistoryEntry[] }> {
		const pending = this.unsent.get(id);
		if (pending) return { meta: pending.meta, entries: [...pending.entries] };
		const entries: HistoryEntry[] = [];
		let meta!: StoredSession, after: string | undefined;
		do {
			const r: { session: StoredSession; entries: HistoryEntry[]; next?: string } = await call(this.client, "GET", this.path(id) + (after === undefined ? "" : `?after=${segment(after)}`), { retry: true, signal: timeout(10_000) });
			meta ??= r.session;
			entries.push(...r.entries);
			after = this.next(r.entries, r.next, after);
		} while (after !== undefined);
		if (!entries.length) throw new ServiceError(404, "Session was not published", "unknown_session");
		return { meta, entries };
	}
	async list(filter?: { project?: string }): Promise<StoredSession[]> {
		if (this.ttl === undefined) await this.initialize();
		const sessions: StoredSession[] = [];
		let after: string | undefined;
		do {
			const q: string[] = [];
			if (filter?.project !== undefined) q.push(`project=${segment(filter.project)}`);
			if (after !== undefined) q.push(`after=${segment(after)}`);
			const r: { sessions: StoredSession[]; next?: string } = await call(this.client, "GET", "/v1/sessions" + (q.length ? `?${q.join("&")}` : ""), { retry: true, signal: timeout(10_000) });
			sessions.push(...r.sessions);
			after = this.next(r.sessions, r.next, after);
		} while (after !== undefined);
		return sessions;
	}
	private next(rows: { id: string }[], next?: string, previous?: string) {
		if (next !== undefined && (typeof next !== "string" || next === previous || next !== rows.at(-1)?.id)) throw new Error("Invalid history page cursor");
		return next;
	}
	async erase(id: string, entryIds: string[]): Promise<void> {
		const pending = this.unsent.get(id);
		if (pending) {
			const targets = new Set(entryIds);
			pending.entries = pending.entries.map((e) => targets.has(e.id) ? erasedEntry(e) : e);
			return;
		}
		const lease = this.leases.get(id);
		await this.mutate(id, "/erase", { entryIds, ...(lease ? { lease: lease.value } : {}) }, lease);
	}
}

export function historyHttp(client: ClientOptions, initialized?: HttpHistoryStore): Plugin {
	return { name: "history-http", replaces: "history-jsonl", async setup(api) {
		const store = initialized ?? new HttpHistoryStore(client);
		if (!initialized) await store.initialize();
		api.provide("history-store", store);
	} };
}
