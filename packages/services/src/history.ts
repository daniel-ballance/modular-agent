import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryEntry, HistoryStore, Plugin, StoredSession } from "@modular-agent/harness";
import { call, type ClientOptions, HttpError, serve, ServiceError } from "./http.js";

/** The history service binding this follows (docs/bindings/history-http.md). */
export const HISTORY_BINDING = "modular-agent-history/1";

type Json = Record<string, unknown>;
/** JSON with object keys sorted, so two entries with the same content compare equal. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value as Json).filter((k) => (value as Json)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Json)[k])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

class BindingError extends HttpError {
	constructor(status: number, readonly code: string, message: string) {
		super(status, message);
	}
}

interface SessionMeta { id: string; project: string; created: number; parentSessionId?: string; forkedFrom?: { sessionId: string; entryId: string } }

/**
 * What the service keeps: one file per session that has entries, holding its
 * metadata and its entries in the order they were kept. Entries are kept as
 * given; the service reads only `id`, `parentId` and, for erasure, `kind`.
 */
class EntryFiles {
	private meta = new Map<string, SessionMeta>();
	private entries = new Map<string, Json[]>();
	constructor(private dir: string) {
		mkdirSync(dir, { recursive: true });
		for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
			const lines = readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.trim());
			const meta = JSON.parse(lines[0]) as SessionMeta;
			this.meta.set(meta.id, meta);
			this.entries.set(meta.id, lines.slice(1).map((l) => JSON.parse(l)));
		}
	}
	private file(id: string): string {
		return join(this.dir, `${encodeURIComponent(id)}.jsonl`);
	}
	session(id: string): SessionMeta | undefined {
		return this.meta.get(id);
	}
	put(meta: SessionMeta): void {
		const known = this.meta.get(meta.id);
		if (known && known.project !== meta.project) throw new BindingError(409, "conflict", `Session ${meta.id} exists with another project`);
		if (!known) this.meta.set(meta.id, meta);
	}
	list(project?: string): SessionMeta[] {
		return [...this.meta.values()].filter((m) => (this.entries.get(m.id)?.length ?? 0) > 0 && (!project || m.project === project)).sort((a, b) => b.created - a.created);
	}
	get(id: string): Json[] {
		return this.entries.get(id) ?? [];
	}
	/** All or none: returns how many were new. */
	keep(id: string, batch: Json[]): number {
		const kept = this.get(id);
		const byId = new Map(kept.map((e) => [e.id as string, canonical(e)]));
		const fresh: Json[] = [];
		for (const e of batch) {
			if (typeof e.id !== "string" || !("parentId" in e)) throw new BindingError(400, "invalid_request", "Every entry needs an id and a parentId");
			const earlier = byId.get(e.id) ?? (fresh.find((f) => f.id === e.id) ? canonical(fresh.find((f) => f.id === e.id)) : undefined);
			if (earlier === undefined) fresh.push(e);
			else if (earlier !== canonical(e)) throw new BindingError(409, "conflict", `Entry ${e.id} was kept with other content`);
		}
		if (!fresh.length) return 0;
		const path = this.file(id);
		if (!existsSync(path)) writeFileSync(path, JSON.stringify(this.meta.get(id)) + "\n");
		appendFileSync(path, fresh.map((e) => JSON.stringify(e)).join("\n") + "\n");
		this.entries.set(id, [...kept, ...fresh]);
		return fresh.length;
	}
	erase(id: string, ids: string[]): string[] {
		const targets = new Set(ids);
		const erased: string[] = [];
		const next = this.get(id).map((e) => {
			if (!targets.has(e.id as string)) return e;
			erased.push(e.id as string);
			return { id: e.id, parentId: e.parentId, kind: e.kind ?? null, erased: true };
		});
		if (!erased.length) return [];
		this.entries.set(id, next);
		const tmp = `${this.file(id)}.${process.pid}.tmp`;
		writeFileSync(tmp, [JSON.stringify(this.meta.get(id)), ...next.map((e) => JSON.stringify(e))].join("\n") + "\n");
		renameSync(tmp, this.file(id));
		return erased;
	}
}

/**
 * The history store as a service, following modular-agent-history/1. Several
 * agents may use it at once. A writer holds a lease on a session while it keeps
 * renewing; a second owner is refused until the lease is released or runs out.
 * Every request is safe to send again.
 */
export async function historyService(options: { dir: string; token: string; port?: number; leaseMs?: number; dropAppendResponses?: number }) {
	const files = new EntryFiles(options.dir);
	const ttlMs = options.leaseMs ?? 15_000;
	const leases = new Map<string, { owner: string; lease: string; expires: number }>();
	let drop = options.dropAppendResponses ?? 0;
	const current = (id: string) => {
		const l = leases.get(id);
		return l && l.expires > Date.now() ? l : undefined;
	};
	const requireLease = (id: string, lease: unknown) => {
		const l = current(id);
		if (!l || l.lease !== lease) throw new BindingError(409, "lost", `Lease ${String(lease)} on session ${id} is not current`);
		return l;
	};
	const known = (id: string) => {
		if (!files.session(id)) throw new BindingError(404, "unknown_session", `No session ${id}`);
	};
	const started = await serve(
		[
			["GET", /^\/v1$/, () => ({ binding: HISTORY_BINDING, ttlMs, retention: null })],
			["PUT", /^\/v1\/sessions\/([^/]+)$/, (req) => {
				const b = (req.body ?? {}) as Partial<SessionMeta>;
				if (typeof b.project !== "string") throw new BindingError(400, "invalid_request", "project is required");
				files.put({ id: req.params[0], project: b.project, created: typeof b.created === "number" ? b.created : Date.now(), ...(b.parentSessionId ? { parentSessionId: b.parentSessionId } : {}), ...(b.forkedFrom ? { forkedFrom: b.forkedFrom } : {}) });
				return {};
			}],
			["GET", /^\/v1\/sessions$/, (req) => ({ sessions: files.list(req.query.get("project") ?? undefined) })],
			["GET", /^\/v1\/sessions\/([^/]+)$/, (req) => {
				const [id] = req.params;
				known(id);
				let entries = files.get(id);
				const after = req.query.get("after");
				if (after) {
					const at = entries.findIndex((e) => e.id === after);
					if (at < 0) throw new BindingError(404, "unknown_entry", `No entry ${after}`);
					entries = entries.slice(at + 1);
				}
				return { session: files.session(id), entries };
			}],
			["POST", /^\/v1\/sessions\/([^/]+)\/lease$/, (req) => {
				const [id] = req.params;
				known(id);
				const owner = String(req.body?.owner ?? "");
				if (!owner) throw new BindingError(400, "invalid_request", "owner is required");
				const l = current(id);
				if (l && l.owner !== owner) throw new BindingError(409, "held", `Session ${id} is held by another owner`);
				const lease = l?.lease ?? randomUUID();
				leases.set(id, { owner, lease, expires: Date.now() + ttlMs });
				return { lease, ttlMs };
			}],
			["POST", /^\/v1\/sessions\/([^/]+)\/lease\/([^/]+)\/renew$/, (req) => {
				const [id, lease] = req.params;
				const l = requireLease(id, lease);
				l.expires = Date.now() + ttlMs;
				return { ttlMs };
			}],
			["DELETE", /^\/v1\/sessions\/([^/]+)\/lease\/([^/]+)$/, (req) => {
				const [id, lease] = req.params;
				if (leases.get(id)?.lease === lease) leases.delete(id);
				return {};
			}],
			["POST", /^\/v1\/sessions\/([^/]+)\/entries$/, (req, res) => {
				const [id] = req.params;
				known(id);
				requireLease(id, req.body?.lease);
				const kept = files.keep(id, (req.body?.entries ?? []) as Json[]);
				// For tests: keep the entries, then lose the answer, as a dropped connection would.
				if (drop > 0) {
					drop--;
					res.socket?.destroy();
					return;
				}
				return { kept };
			}],
			["POST", /^\/v1\/sessions\/([^/]+)\/erase$/, (req) => {
				const [id] = req.params;
				known(id);
				const l = current(id);
				if (l && l.lease !== req.body?.lease) throw new BindingError(409, "held", `Session ${id} is held by another owner`);
				return { erased: files.erase(id, (req.body?.entryIds ?? []) as string[]) };
			}],
		],
		{ port: options.port, token: options.token },
	);
	return started;
}

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

	async openForWriting(id: string): Promise<void> {
		const pending = this.unsent.get(id);
		if (pending) {
			pending.writing = true;
			return;
		}
		await this.takeLease(id);
	}

	private async takeLease(id: string): Promise<void> {
		const { lease, ttlMs } = await call<{ lease: string; ttlMs: number }>(this.client, "POST", this.path(id, "/lease"), { body: { owner: this.owner }, retry: true });
		const held = { lease, lost: false, timer: undefined as unknown as NodeJS.Timeout };
		held.timer = setInterval(() => {
			call(this.client, "POST", this.path(id, `/lease/${lease}/renew`), { retry: true }).catch((error) => {
				// A lost lease is final: this agent stops writing rather than quietly taking a new one.
				if (error instanceof ServiceError && error.status === 409) {
					held.lost = true;
					clearInterval(held.timer);
				}
			});
		}, Math.max(50, Math.floor(ttlMs / 3)));
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
			if (batch.some((e) => e.kind !== "setting" && e.kind !== "actorJoined")) await this.send(id);
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
		// An erased entry comes back as { id, parentId, kind, erased: true }: shape it as this agent records erasures.
		const entries = r.entries.map((e) => ((e as unknown as { erased?: boolean }).erased ? ({ ...e, data: { erased: true }, modelVisible: false } as HistoryEntry) : e));
		return { meta: r.session, entries };
	}

	async list(filter?: { project?: string }): Promise<StoredSession[]> {
		const r = await call<{ sessions: StoredSession[] }>(this.client, "GET", `/v1/sessions${filter?.project ? `?project=${encodeURIComponent(filter.project)}` : ""}`, { retry: true });
		return r.sessions;
	}

	async erase(id: string, entryIds: string[]): Promise<void> {
		const pending = this.unsent.get(id);
		if (pending) {
			const targets = new Set(entryIds);
			pending.batches = pending.batches.map((b) => b.map((e) => (targets.has(e.id) ? ({ ...e, message: undefined, data: { erased: true }, modelVisible: false } as HistoryEntry) : e)));
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
