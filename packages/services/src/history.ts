import { randomUUID } from "node:crypto";
import type { HistoryEntry, HistoryStore, Plugin, StoredSession } from "@modular-agent/harness";
import { JsonlHistoryStore } from "@modular-agent/history-jsonl";
import { call, type ClientOptions, HttpError, serve } from "./http.js";

/**
 * The history store as a service. Several agents may use it at once, so "open
 * for writing" is a lease: an agent holds a session while it keeps renewing, and
 * a second writer is refused until the lease is released or runs out. Appends are
 * safe to send twice: a batch whose entries are already kept is not kept again.
 */
export async function historyService(options: { dir: string; token: string; port?: number; leaseMs?: number; dropAppendResponses?: number }) {
	const store = new JsonlHistoryStore(options.dir);
	const leaseMs = options.leaseMs ?? 15_000;
	const leases = new Map<string, { owner: string; expires: number }>();
	const kept = new Map<string, Set<string>>();
	let drop = options.dropAppendResponses ?? 0;

	const holder = (id: string) => {
		const lease = leases.get(id);
		return lease && lease.expires > Date.now() ? lease.owner : undefined;
	};
	const requireLease = (id: string, owner: string) => {
		if (holder(id) !== owner) throw new HttpError(409, `Session ${id} is not open for writing by this agent`);
		leases.set(id, { owner, expires: Date.now() + leaseMs });
	};
	const keptIds = async (id: string) => {
		let ids = kept.get(id);
		if (!ids) {
			ids = new Set((await store.load(id)).entries.map((e) => e.id));
			kept.set(id, ids);
		}
		return ids;
	};

	return serve(
		[
			["POST", /^\/sessions$/, async (req) => {
				await store.create(req.body as StoredSession);
				return {};
			}],
			["POST", /^\/sessions\/([^/]+)\/open$/, async (req) => {
				const [id] = req.params;
				const owner = req.body.owner as string;
				const current = holder(id);
				if (current && current !== owner) throw new HttpError(409, `Session ${id} is already open for writing by another agent`);
				leases.set(id, { owner, expires: Date.now() + leaseMs });
				await store.openForWriting(id);
				return { leaseMs };
			}],
			["POST", /^\/sessions\/([^/]+)\/renew$/, (req) => requireLease(req.params[0], req.body.owner)],
			["POST", /^\/sessions\/([^/]+)\/close$/, async (req) => {
				const [id] = req.params;
				if (holder(id) === req.body.owner) leases.delete(id);
				if (!holder(id)) {
					kept.delete(id);
					await store.close(id);
				}
				return {};
			}],
			["POST", /^\/sessions\/([^/]+)\/append$/, async (req, res) => {
				const [id] = req.params;
				requireLease(id, req.body.owner);
				const batch = req.body.batch as HistoryEntry[];
				const ids = await keptIds(id);
				if (batch.length && batch.every((e) => ids.has(e.id))) return { duplicate: true };
				await store.append(id, batch);
				for (const e of batch) ids.add(e.id);
				// For tests: keep the batch, then lose the answer, as a dropped connection would.
				if (drop > 0) {
					drop--;
					res.socket?.destroy();
					return;
				}
				return {};
			}],
			["GET", /^\/sessions\/([^/]+)$/, (req) => store.load(req.params[0])],
			["GET", /^\/sessions$/, (req) => store.list(req.query.get("project") ? { project: req.query.get("project")! } : undefined)],
			["POST", /^\/sessions\/([^/]+)\/erase$/, async (req) => {
				const [id] = req.params;
				requireLease(id, req.body.owner);
				await store.erase(id, req.body.entryIds);
				return {};
			}],
		],
		{ port: options.port, token: options.token },
	);
}

/** A history store that is a service. Every request is safe to send again, so each is retried when the network fails. */
export class HttpHistoryStore implements HistoryStore {
	readonly supports = { erasure: true, retention: false };
	/** This agent, as a writer the service can tell apart from others. */
	private owner = randomUUID();
	private renewals = new Map<string, NodeJS.Timeout>();

	constructor(private client: ClientOptions) {}

	async create(meta: StoredSession): Promise<void> {
		await call(this.client, "POST", "/sessions", { body: meta, retry: true });
	}

	async openForWriting(id: string): Promise<void> {
		const { leaseMs } = await call<{ leaseMs: number }>(this.client, "POST", `/sessions/${id}/open`, { body: { owner: this.owner }, retry: true });
		const timer = setInterval(() => void call(this.client, "POST", `/sessions/${id}/renew`, { body: { owner: this.owner }, retry: true }).catch(() => undefined), leaseMs / 3);
		timer.unref();
		this.renewals.set(id, timer);
	}

	async close(id: string): Promise<void> {
		clearInterval(this.renewals.get(id));
		this.renewals.delete(id);
		await call(this.client, "POST", `/sessions/${id}/close`, { body: { owner: this.owner }, retry: true });
	}

	async append(id: string, batch: HistoryEntry[]): Promise<void> {
		if (batch.length) await call(this.client, "POST", `/sessions/${id}/append`, { body: { owner: this.owner, batch }, retry: true });
	}

	load(id: string): Promise<{ meta: StoredSession; entries: HistoryEntry[] }> {
		return call(this.client, "GET", `/sessions/${id}`, { retry: true });
	}

	list(filter?: { project?: string }): Promise<StoredSession[]> {
		return call(this.client, "GET", `/sessions${filter?.project ? `?project=${encodeURIComponent(filter.project)}` : ""}`, { retry: true });
	}

	async erase(id: string, entryIds: string[]): Promise<void> {
		await call(this.client, "POST", `/sessions/${id}/erase`, { body: { owner: this.owner, entryIds }, retry: true });
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
