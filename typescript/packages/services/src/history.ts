import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { erasedEntry, untilAborted, type ErasurePlan, type ErasurePublication, type HistoryErasureRegistry, type HistoryEntry, type HistoryStore, type Plugin, type StoredSession } from "@modular-agent/harness";
import { HistoryServiceError, historyStorageStatuses, type HistoryReadOptions } from "./history-backend.js";
import { call, type ClientOptions, ServiceError } from "./http.js";
import { HISTORY_BINDING, MAX_LEASE_BYTES, validLease } from "./history-service.js";
export { HISTORY_BINDING, historyService } from "./history-service.js";

const segment = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const pathId = (value: string) => {
	if (!value || value === "." || value === "..") throw new Error("Invalid history path id");
	return segment(value);
};
const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const timeout = (ms: number) => AbortSignal.timeout(Math.max(1, Math.min(2 ** 31 - 1, Math.ceil(ms))));
const bodyCap = 64 * 1024 * 1024;

// The first field in Linux /proc/uptime includes suspension and is truncated
// to centiseconds. Reserve a tick against local deadlines.
function bootClock(): number {
	const field = readFileSync("/proc/uptime", "utf8").split(" ", 1)[0];
	if (!/^\d+\.\d{2}$/.test(field)) throw new Error("Invalid boot clock");
	return Number(field) * 1000;
}
/**
 * A clock that keeps counting through suspension, built from a monotonic clock that stops
 * while the machine sleeps (performance.now() on macOS) and the wall clock, which does not.
 * Each reading advances by the larger of the two clocks' advances since the last reading, so a
 * sleep shows up at the next reading. If the wall clock moves back by more than the tolerance,
 * a sleep in that interval could be hidden, so the clock jumps a day ahead: every lease measured
 * before the jump has expired, and the writer treats it as lost rather than trusting it.
 * (docs/bindings/history-http.md, Writing: one writer at a time.)
 */
// Captured at load, so a replaced Date.now (as tests do to age records) cannot move lease deadlines.
const systemWallClock = Date.now.bind(Date);
export function sleepAwareClock(monotonic: () => number = () => performance.now(), wall: () => number = systemWallClock, tolerance = 50) {
	let lastMonotonic = monotonic(), lastWall = wall(), elapsed = 0;
	return {
		now(): number {
			const m = monotonic(), w = wall();
			const dm = Math.max(0, m - lastMonotonic), dw = w - lastWall;
			lastMonotonic = m; lastWall = w;
			elapsed += dw < dm - tolerance ? dm + 86_400_000 : Math.max(dm, dw);
			return elapsed;
		},
		// A backward step smaller than the tolerance can hide that much sleep; Date.now() has 1 ms resolution.
		margin: tolerance + 10,
	};
}
function writerClock(configuredMargin?: number) {
	if (process.platform === "linux") {
		try { bootClock(); return { now: bootClock, margin: 10 }; } catch { /* No usable boot clock. */ }
	}
	if (process.platform === "darwin") {
		// An operator margin, if set, is kept on top of the clock's own.
		const clock = sleepAwareClock();
		return positive(configuredMargin) ? { now: clock.now, margin: Math.max(clock.margin, configuredMargin) } : clock;
	}
	if (!positive(configuredMargin)) throw new Error("No suspension-aware clock is available to the history writer. Set MODULAR_AGENT_HISTORY_LEASE_MARGIN_MS to a positive integer (milliseconds) in the process environment. Choose a margin that covers expected suspension and scheduling delays, or prevent suspension while writing.");
	return { now: () => performance.now(), margin: configuredMargin };
}
type HistoryClientOptions = ClientOptions & { leaseMarginMs?: number };

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

type Lease = { value: string; ttl: number; cutoff: number; timer?: NodeJS.Timeout; abort: AbortController; watch?: Disposable };
type Pending = { meta: StoredSession; entries: HistoryEntry[]; abort: AbortController };

type Awaitable<T> = T | Promise<T>;
export type HistoryMetadata = Omit<StoredSession, "id">;
type ReadPage = { session: StoredSession; entries: HistoryEntry[]; next?: string };
type ListPage = { sessions: StoredSession[]; next?: string };
type ListOptions = HistoryReadOptions & { project?: string };

/** In-process Registrar history port. The store owns atomicity and lease fencing. */
export interface LeasedHistoryStore {
	readonly ttlMs: number;
	readonly persistent: boolean;
	create(id: string, metadata: HistoryMetadata): Awaitable<void>;
	read(id: string, options: HistoryReadOptions): Awaitable<ReadPage>;
	list(options: ListOptions): Awaitable<ListPage>;
	acquire(id: string, owner: string): Awaitable<string>;
	renew(id: string, lease: string): Awaitable<void>;
	release(id: string, lease: string): Awaitable<void>;
	append(id: string, lease: string, entries: HistoryEntry[]): Awaitable<number>;
	erase?(id: string, entryIds: string[], lease?: string): Awaitable<string[]>;
	/** Abort as soon as this lease is known to be lost, including while idle. */
	writerSignal?(id: string, lease: string): AbortSignal | undefined;
}

type Grant = { lease: string; ttlMs: number };
type Caps = { ttlMs: number; retention?: number | null; pendingErasure?: unknown };
interface HistoryPort {
	readonly remote?: boolean;
	initialize(signal: AbortSignal): Promise<Caps>;
	create(id: string, meta: HistoryMetadata, signal: AbortSignal): Promise<unknown>;
	acquire(id: string, owner: string, signal: AbortSignal): Promise<Grant>;
	renew(id: string, lease: string, signal: AbortSignal): Promise<{ ttlMs: number }>;
	release(id: string, lease: string, signal: AbortSignal): Promise<unknown>;
	append(id: string, lease: string, entries: HistoryEntry[], signal: AbortSignal, revision?: string): Promise<unknown>;
	plans?(id: string, after: string | undefined, signal: AbortSignal): Promise<unknown>;
	publish?(id: string, lease: string, intent: ErasurePublication, signal: AbortSignal): Promise<unknown>;
	complete?(id: string, lease: string, intentId: string, entryIds: string[], signal: AbortSignal): Promise<unknown>;
	erase?(id: string, entryIds: string[], lease: string | undefined, signal: AbortSignal): Promise<unknown>;
	writerSignal?: LeasedHistoryStore["writerSignal"];
	read(id: string, options: HistoryReadOptions, signal: AbortSignal): Promise<ReadPage>;
	list(options: ListOptions, signal: AbortSignal): Promise<ListPage>;
}

class HistoryWriter implements HistoryStore {
	readonly supports: { erasure: boolean; retention: boolean; persistent: boolean };
	historyErasure?: HistoryErasureRegistry;
	private owner = randomUUID();
	private leases = new Map<string, Lease>();
	private unsent = new Map<string, Pending>();
	private ttl?: number;
	private clock: ReturnType<typeof writerClock>;

	constructor(private port: HistoryPort, persistent: boolean, margin?: number) {
		this.supports = { erasure: false, retention: false, persistent };
		const configured = process.env.MODULAR_AGENT_HISTORY_LEASE_MARGIN_MS;
		this.clock = writerClock(margin ?? (configured === undefined ? undefined : Number(configured)));
	}
	async initialize() {
		const caps = await this.port.initialize(timeout(10_000));
		if (!positive(caps.ttlMs) || (caps.retention != null && !positive(caps.retention))) throw new Error("Unsupported history store declaration");
		this.ttl = caps.ttlMs;
		this.supports.retention = caps.retention != null;
		if (caps.pendingErasure === 1 && this.port.plans && this.port.publish && this.port.complete) {
			this.historyErasure = {
				read: id => this.plans(id),
				publish: async (id, intent) => {
					const lease = this.leases.get(id);
					if (!lease) throw new ServiceError(409, "Erasure requires a source lease", "lost");
					let reply: unknown;
					await this.mutate(id, async signal => { reply = await this.port.publish!(id, lease.value, intent, signal); }, lease);
					if (!shape(reply, ["intentId", "sessionIds"]) || !pathName(reply.intentId) ||
						!Array.isArray(reply.sessionIds) || !reply.sessionIds.every(pathName) ||
						!reply.sessionIds.includes(id) || new Set(reply.sessionIds).size !== reply.sessionIds.length) {
						throw unavailable("Invalid erasure publication reply");
					}
					return { intentId: reply.intentId, sessionIds: reply.sessionIds };
				},
				complete: async (id, intentId, entryIds) => {
					const lease = this.leases.get(id);
					if (!lease) throw new ServiceError(409, "Erasure requires a destination lease", "lost");
					await this.mutate(id, async signal => {
						if (!shape(await this.port.complete!(id, lease.value, intentId, entryIds, signal), [])) throw unavailable("Invalid erasure completion reply");
					}, lease);
				},
			};
			this.supports.erasure = true;
		}
	}
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
		if (!lease) throw new ServiceError(409, "Session is not open for writing", "lost");
		try { if (this.clock.now() >= lease.cutoff) this.lose(lease); } catch { this.lose(lease); }
		if (lease.abort.signal.aborted) throw lease.abort.signal.reason;
	}
	private lose(lease: Lease) {
		clearTimeout(lease.timer);
		lease.watch?.[Symbol.dispose]();
		lease.abort.abort(new ServiceError(409, "Session is not open for writing: its lease is lost", "lost"));
	}
	private async takeLease(id: string, wait = false, abort = new AbortController()): Promise<void> {
		if (this.ttl === undefined) await this.initialize();
		let budget = Infinity;
		let lastHeld: ServiceError | undefined;
		let lostReply = false;
		for (;;) {
			const sent = this.clock.now();
			const remaining = budget - sent;
			if (lastHeld && remaining <= 0) throw lastHeld;
			const signal = timeout(Math.min(remaining, 10_000));
			let grant: Grant;
			try {
				grant = await this.port.acquire(id, this.owner, signal);
			} catch (error) {
				if (wait && error instanceof ServiceError && error.code === "held" && positive(error.retryAfterMs)) {
					const now = this.clock.now();
					if (!lastHeld) budget = now + this.ttl! + 1000;
					lastHeld = error;
					if (now + error.retryAfterMs >= budget) throw error;
					await sleep(error.retryAfterMs);
					continue;
				}
				if (lastHeld && (this.clock.now() >= budget || (signal.aborted && remaining <= 10_000))) throw lastHeld;
				if (this.port.remote && !(error instanceof ServiceError) && !lostReply) { lostReply = true; continue; }
				throw error;
			}
			if (lastHeld && this.clock.now() >= budget) throw lastHeld;
			if (!validLease(grant.lease) || !positive(grant.ttlMs)) throw new ServiceError(409, "Invalid history lease grant", "lost");
			const lease: Lease = { value: grant.lease, ttl: grant.ttlMs, cutoff: sent + grant.ttlMs / 2 - this.clock.margin, abort };
			this.leases.set(id, lease);
			const writer = this.port.writerSignal?.(id, grant.lease);
			if (writer?.aborted) this.lose(lease);
			else if (writer) lease.watch = addAbortListener(writer, () => this.lose(lease));
			this.checkWriter(id);
			if (lostReply) await this.renew(id, lease);
			else this.schedule(id, lease, sent);
			return;
		}
	}
	private schedule(id: string, lease: Lease, sent: number) {
		lease.timer = setTimeout(() => { void this.renew(id, lease).catch(() => this.lose(lease)); }, Math.max(1, Math.min(2 ** 31 - 1, sent + lease.ttl / 3 - this.clock.margin - this.clock.now())));
		lease.timer.unref();
	}
	private async renew(id: string, lease: Lease) {
		this.checkWriter(id);
		const sent = this.clock.now();
		const reply = await this.port.renew(id, lease.value, AbortSignal.any([lease.abort.signal, timeout(lease.cutoff - sent)]));
		const cutoff = sent + reply.ttlMs / 2 - this.clock.margin;
		if (!positive(reply.ttlMs) || this.clock.now() >= Math.min(lease.cutoff, cutoff) || lease.abort.signal.aborted) {
			this.lose(lease);
			throw lease.abort.signal.reason;
		}
		lease.ttl = reply.ttlMs;
		lease.cutoff = cutoff;
		this.schedule(id, lease, sent);
	}
	async close(id: string): Promise<void> {
		this.unsent.delete(id);
		const lease = this.leases.get(id);
		if (!lease) return;
		this.lose(lease);
		this.leases.delete(id);
		await this.port.release(id, lease.value, timeout(1000)).catch(() => undefined);
	}
	async append(id: string, batch: HistoryEntry[], options?: { forkErasureView?: string }): Promise<void> {
		if (!batch.length) return;
		const pending = this.unsent.get(id);
		if (pending) {
			pending.entries.push(...batch);
			if (!pending.meta.forkedFrom && !batch.some((e) => e.kind === "inputAccepted")) return;
			const { id: _id, ...body } = pending.meta;
			// Use the append encoding and the largest possible unescaped lease.
			if (Buffer.byteLength(JSON.stringify({ lease: "x".repeat(MAX_LEASE_BYTES), entries: pending.entries })) > bodyCap) {
				this.unsent.delete(id);
				throw new ServiceError(413, "Initial history batch is too large", "result_too_large");
			}
			try {
				await this.port.create(id, body, timeout(10_000));
				await this.takeLease(id, false, pending.abort);
			} catch (e) { pending.abort.abort(e); throw e; }
			this.unsent.delete(id);
			batch = pending.entries;
		}
		const lease = this.leases.get(id);
		this.checkWriter(id);
		if (this.historyErasure) await this.guardedAppend(id, lease!, batch, pending?.meta.forkedFrom?.sessionId, options?.forkErasureView);
		else await this.mutate(id, signal => this.port.append(id, lease!.value, batch, signal), lease);
	}
	private async plans(id: string) {
		try {
			let revision: string | undefined, after: string | undefined;
			const plans: ErasurePlan[] = [];
			const seen = new Set<string>();
			do {
				const page = await this.port.plans!(id, after, timeout(10_000));
				if (!shape(page, ["revision", "plans"], ["next"]) || !validLease(page.revision) ||
					(revision !== undefined && revision !== page.revision) || !Array.isArray(page.plans) || page.plans.length > 500 || (after !== undefined && page.plans.length === 0)) throw unavailable("Invalid erasure plan page");
				revision = page.revision;
				for (const plan of page.plans) {
					if (!isPlan(plan) || seen.has(plan.intentId)) throw unavailable("Invalid erasure plan");
					seen.add(plan.intentId);
					plans.push(plan);
				}
				if (Object.hasOwn(page, "next") && (!pathName(page.next) || page.next === after || page.next !== page.plans.at(-1)?.intentId)) throw unavailable("Invalid erasure plan cursor");
				after = page.next as string | undefined;
			} while (after !== undefined);
			return { revision: revision!, plans };
		} catch (error) { throw unavailable("Pending erasure state is unavailable", error); }
	}
	private async guardedAppend(id: string, lease: Lease, batch: HistoryEntry[], forkSource?: string, forkErasureView?: string) {
		const sources = new Set(batch.flatMap(entry => entry.sources ?? []));
		const isBookkeeping = batch.every(entry => entry.kind === "erasure");
		for (;;) {
			this.checkWriter(id);
			const dest = await this.plans(id);
			const sourceId = forkSource ?? id;
			const source = forkSource === undefined ? dest : await this.plans(sourceId);
			if (source.revision !== dest.revision) continue; // Read both scopes again before checking the data.
			if (forkSource !== undefined && forkErasureView !== JSON.stringify(source.plans.map(p => p.intentId))) throw unavailable("Erasure changed the fork source");
			if (!isBookkeeping && [...dest.plans, ...(forkSource === undefined ? [] : source.plans)].some(p => p.copies.some(c => !c.complete))) {
				throw unavailable("Cannot append to or copy from history with pending erasure");
			}
			if (sources.size) {
				const kept = new Map((await this.readAll(sourceId)).entries.map(e => [e.id, e]));
				for (const entry of batch) kept.set(entry.id, entry);
				if ([...sources].some(id => !kept.has(id) || kept.get(id)!.erased)) throw unavailable("Append would copy erased or unknown history");
			}
			this.checkWriter(id);
			try {
				await this.port.append(id, lease.value, batch, AbortSignal.any([lease.abort.signal, timeout(lease.cutoff - this.clock.now())]), dest.revision);
				this.checkWriter(id);
				return;
			} catch (error) {
				if (error instanceof ServiceError) {
					if (error.code === "stale_revision") continue;
					if (error.code === "lost") this.lose(lease);
					throw error;
				}
				// A committed append moves the revision. Reconcile the exact batch, rather than
				// treating the stale revision on an identical resend as proof of failure.
				try {
					this.checkWriter(id);
					const kept = new Map((await this.readAll(id)).entries.map(e => [e.id, e]));
					this.checkWriter(id);
					if (batch.every(e => isDeepStrictEqual(JSON.parse(JSON.stringify(e)), kept.get(e.id)))) return;
					if (batch.every(e => !kept.has(e.id))) continue;
				} catch (failure) { this.lose(lease); throw failure; }
				this.lose(lease);
				throw error;
			}
		}
	}
	private async mutate(id: string, work: (signal: AbortSignal) => Promise<unknown>, lease?: Lease) {
		for (let attempt = 0; ; attempt++) {
			if (lease) this.checkWriter(id);
			try {
				await work(lease ? AbortSignal.any([lease.abort.signal, timeout(lease.cutoff - this.clock.now())]) : timeout(10_000));
				if (lease) this.checkWriter(id);
				return;
			} catch (error) {
				if (error instanceof ServiceError && error.code !== "lost" && attempt === 0) throw error;
				// Retry an identical mutation only if this generation is still proven current.
				if (this.port.remote && !(error instanceof ServiceError) && lease && attempt < 4 && !lease.abort.signal.aborted && this.clock.now() < lease.cutoff) continue;
				if (lease) this.lose(lease);
				throw error;
			}
		}
	}
	async load(id: string): Promise<{ meta: StoredSession; entries: HistoryEntry[] }> {
		const pending = this.unsent.get(id);
		if (pending) return { meta: pending.meta, entries: [...pending.entries] };
		const result = await this.readAll(id);
		if (!result.entries.length) throw new ServiceError(404, "Session was not published", "unknown_session");
		return result;
	}
	private async readAll(id: string) {
		const entries: HistoryEntry[] = [];
		let meta!: StoredSession, after: string | undefined;
		do {
			const r = await this.port.read(id, { after, limit: 500 }, timeout(10_000));
			meta ??= r.session;
			entries.push(...r.entries);
			after = this.next(r.entries, r.next, after);
		} while (after !== undefined);
		return { meta, entries };
	}
	async list(filter?: { project?: string }): Promise<StoredSession[]> {
		if (this.ttl === undefined) await this.initialize();
		const sessions: StoredSession[] = [];
		let after: string | undefined;
		do {
			const r = await this.port.list({ ...filter, after, limit: 500 }, timeout(10_000));
			sessions.push(...r.sessions);
			after = this.next(r.sessions, r.next, after);
		} while (after !== undefined);
		return sessions;
	}
	private next(rows: { id: string }[], next?: string, previous?: string) {
		if (next !== undefined && (typeof next !== "string" || next === previous || next !== rows.at(-1)?.id)) throw new ServiceError(503, "Invalid history page cursor", "lost");
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
		const erase = this.port.erase;
		if (!erase) throw new ServiceError(405, "The history store does not support erasure", "not_supported");
		await this.mutate(id, signal => erase(id, entryIds, lease?.value, signal), lease);
	}
}

export async function customHistoryWriter(store: LeasedHistoryStore): Promise<HistoryStore> {
	const { ttlMs, persistent } = store;
	if (typeof persistent !== "boolean") throw new Error("The history store must declare persistence");
	const run = async <T>(signal: AbortSignal, work: () => Awaitable<T>): Promise<T> => {
		try { return await untilAborted(signal, async () => work()); }
		catch (error) {
			if (error instanceof HistoryServiceError) throw new ServiceError(historyStorageStatuses[error.code], error.message, error.code, error.retryAfterMs);
			throw error;
		}
	};
	const writer = new HistoryWriter({
		initialize: async () => ({ ttlMs }),
		create: (id, meta, signal) => run(signal, () => store.create(id, structuredClone(meta))),
		acquire: async (id, owner, signal) => ({ lease: await run(signal, () => store.acquire(id, owner)), ttlMs }),
		renew: async (id, lease, signal) => { await run(signal, () => store.renew(id, lease)); return { ttlMs }; },
		release: (id, lease, signal) => run(signal, () => store.release(id, lease)),
		append: (id, lease, entries, signal) => run(signal, () => store.append(id, lease, structuredClone(entries))),
		erase: store.erase && ((id, ids, lease, signal) => run(signal, () => store.erase!(id, [...ids], lease))),
		writerSignal: store.writerSignal?.bind(store),
		read: (id, options, signal) => run(signal, async () => structuredClone(await store.read(id, options))),
		list: (options, signal) => run(signal, async () => structuredClone(await store.list(options))),
	}, persistent);
	await writer.initialize();
	return writer;
}

const name = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const pathName = (v: unknown): v is string => name(v) && v !== "." && v !== "..";
const shape = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> =>
	!!v && typeof v === "object" && !Array.isArray(v) && required.every(key => Object.hasOwn(v, key)) && Object.keys(v).every(key => required.includes(key) || optional.includes(key));
const unavailable = (message: string, cause?: unknown) => Object.assign(new ServiceError(503, message, "unavailable"), { cause });
function isPlan(p: unknown): p is ErasurePlan {
	return shape(p, ["intentId", "sourceSessionId", "recordId", "copies"]) && pathName(p.intentId) && pathName(p.sourceSessionId) && name(p.recordId) &&
		Array.isArray(p.copies) && p.copies.length > 0 && p.copies.every(c => shape(c, ["entryId", "complete"]) && name(c.entryId) && typeof c.complete === "boolean") &&
		new Set(p.copies.map(c => c.entryId)).size === p.copies.length;
}

export class HttpHistoryStore extends HistoryWriter {
	constructor(options: HistoryClientOptions) {
		const client = historyClientOptions(options.url, options.token);
		const path = (id: string, rest = "") => `/v1/sessions/${pathId(id)}${rest}`;
		const query = ({ project, after, limit }: ListOptions) => {
			const params: string[] = [];
			if (project !== undefined) params.push(`project=${segment(project)}`);
			if (after !== undefined) params.push(`after=${segment(after)}`);
			if (limit !== 500) params.push(`limit=${limit}`);
			return params.length ? `?${params.join("&")}` : "";
		};
		super({
			remote: true,
			async initialize(signal) {
				const caps = await call<Caps & { binding: string }>(client, "GET", "/v1", { signal });
				if (caps.binding !== HISTORY_BINDING) throw new Error("Unsupported history service binding");
				return caps;
			},
			create: (id, body, signal) => call(client, "PUT", path(id), { body, retry: true, signal }),
			acquire: (id, owner, signal) => call(client, "POST", path(id, "/lease"), { body: { owner }, signal }),
			renew: (id, lease, signal) => call(client, "POST", path(id, `/lease/${pathId(lease)}/renew`), { signal }),
			release: (id, lease, signal) => call(client, "DELETE", path(id, `/lease/${pathId(lease)}`), { signal }),
			append: (id, lease, entries, signal, historyRevision) => call(client, "POST", path(id, "/entries"), { body: { lease, entries }, signal, historyRevision }),
			plans: (id, after, signal) => call(client, "GET", path(id, "/pending-erasure") + query({ after, limit: 500 }), { signal, noStore: true }),
			publish: (id, lease, intent, signal) => call(client, "POST", path(id, "/pending-erasure"), { body: { ...intent, lease }, signal }),
			complete: (id, lease, intentId, entryIds, signal) => call(client, "POST", path(id, `/pending-erasure/${pathId(intentId)}/complete`), { body: { lease, entryIds }, signal }),
			erase: (id, entryIds, lease, signal) => call(client, "POST", path(id, "/erase"), { body: { entryIds, ...(lease ? { lease } : {}) }, signal }),
			read: (id, opts, signal) => call(client, "GET", path(id) + query(opts), { retry: true, signal }),
			list: (opts, signal) => call(client, "GET", "/v1/sessions" + query(opts), { retry: true, signal }),
		}, true, options.leaseMarginMs);
	}
}

export function historyHttp(client: ClientOptions, initialized?: HttpHistoryStore): Plugin {
	return { name: "history-http", replaces: "history-jsonl", async setup(api) {
		const store = initialized ?? new HttpHistoryStore(client);
		if (!initialized) await store.initialize();
		api.provide("history-store", store);
	} };
}
