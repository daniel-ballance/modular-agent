import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readTrace, withTrace } from "@modular-agent/harness/telemetry";
import { BindingError, UncertainCommit, HISTORY_BINDING, id, validLease, invalid, unavailable, maxBody } from "./history-binding.js";
import type { HistoryArchive } from "./history-archive.js";
import { RenewalLeases, leaseClock } from "./history-leases.js";
import type { HistoryTestControls } from "./history-records.js";
import { historyRequest, type HistoryReply } from "./history-request.js";
import { HistoryThread } from "./history-thread.js";
import { HistoryServiceError, historyStorageStatuses, type HistoryServiceStore } from "./history-backend.js";
import { checkSettings } from "./settings.js";

export { HISTORY_BINDING, MAX_LEASE_BYTES, validLease } from "./history-binding.js";
export { historyTombstone } from "./history-records.js";
export { HistoryArchive } from "./history-archive.js";
const bytes = Buffer.byteLength;

const routes = [
	[/^\/v1$/, ["GET"], "version"],
	[/^\/v1\/sessions$/, ["GET"], "list"],
	[/^\/v1\/sessions\/([^/]+)$/, ["GET", "PUT"], "session"],
	[/^\/v1\/sessions\/([^/]+)\/lease$/, ["POST"], "acquire"],
	[/^\/v1\/sessions\/([^/]+)\/lease\/([^/]+)\/renew$/, ["POST"], "renew"],
	[/^\/v1\/sessions\/([^/]+)\/lease\/([^/]+)$/, ["DELETE"], "release"],
	[/^\/v1\/sessions\/([^/]+)\/entries$/, ["POST"], "append"],
	[/^\/v1\/sessions\/([^/]+)\/erase$/, ["POST"], "erase"],
	[/^\/v1\/sessions\/([^/]+)\/pending-erasure$/, ["GET", "POST"], "plans"],
	[/^\/v1\/sessions\/([^/]+)\/pending-erasure\/([^/]+)\/complete$/, ["POST"], "complete"],
] as const;

const digest = (s: string) => createHash("sha256").update(s).digest();
function decode(segment: string) {
	try { return decodeURIComponent(segment); } catch { return invalid("Invalid URL encoding"); }
}
function query(raw: string | undefined, allowed: string[]) {
	const q = new Map<string, string>();
	if (raw) for (const part of raw.split("&")) {
		const eq = part.indexOf("=");
		if (eq === -1) return invalid("Invalid query");
		const name = decode(part.slice(0, eq)), value = decode(part.slice(eq + 1));
		if (!allowed.includes(name) || q.has(name)) return invalid("Unknown or repeated query parameter");
		q.set(name, value);
	}
	const after = q.get("after"), l = q.get("limit");
	const limit = l === undefined ? 500 : Number(l);
	if ((after !== undefined && !id(after)) || (l !== undefined && !/^\d+$/.test(l)) || limit < 1 || limit > 500) return invalid("Invalid cursor or page limit");
	return { after, limit, project: q.get("project") };
}

async function bodyBytes(req: IncomingMessage) {
	const tooLarge = () => new BindingError(413, "request_too_large", "Request body exceeds 64 MiB");
	if (Number(req.headers["content-length"]) > maxBody) throw tooLarge();
	const chunks: Buffer[] = [];
	let size = 0;
	// Destroying the async iterator would tear down the socket before the 413.
	for await (const chunk of req.iterator({ destroyOnReturn: false })) {
		size += chunk.length;
		if (size > maxBody) throw tooLarge();
		chunks.push(chunk);
	}
	const raw = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
	return raw;
}

export interface HistoryServiceOptions {
	dir?: string; restoreWitness?: string; archive?: HistoryArchive; store?: HistoryServiceStore; token: string; port?: number; leaseTtl?: number; retention?: number | null;
	/** Permanent ID reservations count toward this operator-supplied limit. */
	maxSessions?: number;
	/** Fault injection for the history client tests. */
	dropAppendResponses?: number;
}

/** A single loopback HTTP listener. The operator must trust every local account,
 * provision a random bearer token, and keep this directory on durable local storage. */
export async function historyService(options: HistoryServiceOptions, controls?: HistoryTestControls) {
	checkSettings("history", options, "dir", "restoreWitness", "archive", "store", "token", "port", "leaseTtl", "retention", "maxSessions", "dropAppendResponses");
	const { leaseTtl } = options;
	if (options.restoreWitness !== undefined && (options.dir === undefined || options.archive || options.store)) {
		throw new Error("Configure restoreWitness on the built-in directory store");
	}
	if (leaseTtl !== undefined && (!Number.isSafeInteger(leaseTtl) || leaseTtl < 1)) {
		throw new RangeError("leaseTtl must be a whole number of milliseconds, at least 1");
	}
	const ttlMs = options.store?.ttlMs ?? leaseTtl ?? 15_000;
	const retention = (options.store ? options.store.retention : options.retention) ?? null;
	const quota = options.maxSessions ?? 100_000;
	for (const n of [ttlMs, quota, ...(retention === null ? [] : [retention])]) if (!Number.isSafeInteger(n) || n < 1) throw new Error("Invalid history service limit");
	if (!/^[A-Za-z0-9._~+/\-]+=*$/.test(options.token)) throw new Error("Invalid history bearer token configuration");
	const token = digest(`Bearer ${options.token}`);
	const leases = new RenewalLeases(ttlMs, leaseClock(controls?.leaseClock));
	let drop = options.dropAppendResponses ?? 0;
	let pendingBodies = 0;
	if (options.archive && retention !== null) throw new Error("An attached SDK archive does not support service retention");
	const profile = !options.store && (options.archive?.persistent ?? options.dir !== undefined);
	const attached = await options.archive?.attach(leases, ttlMs, controls);
	const thread = options.store ? undefined : attached?.thread ?? new HistoryThread({
		archive: false, dir: options.dir, restoreWitness: options.restoreWitness, ttl: ttlMs, retention, quota, profile, controls,
	});
	if (thread && !attached) {
		try { await thread.run({ kind: "ready" }); }
		catch (error) { await thread.terminate(); throw error; }
	}
	const closeRecords = async () => {
		leases.clear();
		if (attached) return attached.detach();
		if (thread) {
			try { if (thread.available) await thread.run({ kind: "close" }); }
			finally { await thread.terminate(); }
		}
	};
	function send(res: ServerResponse, status: number, json: string) {
		res.writeHead(status, { "content-type": "application/json", "content-length": bytes(json) });
		res.end(json);
	}
	const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, async (req, res) => {
		let bodySlot = false;
		try {
			if (!timingSafeEqual(digest(req.headers.authorization ?? ""), token)) {
				res.setHeader("WWW-Authenticate", "Bearer");
				throw new BindingError(401, "unauthorized", "A valid service token is required");
			}
			return await withTrace(readTrace(req.headers), async () => {
				const target = req.url ?? "/";
				const q = target.indexOf("?");
				const path = q < 0 ? target : target.slice(0, q);
				const rawQuery = q < 0 ? undefined : target.slice(q + 1);
				// Do not use a URL parser that normalizes dot segments or backslashes.
				if (path.split("/").some((s) => [".", ".."].includes(decode(s)))) invalid("Dot path segments are forbidden");
				const route = routes.find(([re, , op]) => (profile || (op !== "plans" && op !== "complete")) && re.test(path));
				if (!route) throw new BindingError(404, "not_found", "Unknown path");
				const [re, methods, op] = route;
				if (!(methods as readonly string[]).includes(req.method ?? "")) {
					res.setHeader("Allow", methods.join(", "));
					throw new BindingError(405, "method_not_allowed", "Method is not allowed on this path");
				}
				if (req.headers["transfer-encoding"] || Number(req.headers["content-length"]) > 0 && Number(req.headers["content-length"]) <= maxBody) {
					if (pendingBodies >= 8) throw unavailable();
					pendingBodies++;
					bodySlot = true;
				}
				const raw = await bodyBytes(req);
				if (bodySlot && !thread) { pendingBodies--; bodySlot = false; }
				if (req.headers["content-encoding"] !== undefined) throw new BindingError(415, "unsupported_media_type", "Content-Encoding must be omitted");
				if (raw.length && req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new BindingError(415, "unsupported_media_type", "Expected application/json");
				const method = req.method ?? "";
				const reading = method === "GET";
				const [sid, param] = re.exec(path)!.slice(1).map(decode);
				if ((op === "renew" || op === "release") && !validLease(param)) return invalid("Invalid lease");
				const { after, limit, project } = query(rawQuery, op === "list" ? ["after", "limit", "project"] : (op === "session" || op === "plans") && reading ? ["after", "limit"] : []);
				if (op === "version") {
					if (raw.length) return invalid("This operation takes no body");
					return send(res, 200, JSON.stringify({ binding: HISTORY_BINDING, ttlMs, retention, ...(profile && { pendingErasure: 1 }) }));
				}
				if (thread && !thread.available) { leases.clear(); throw unavailable(); }
				if (thread && op === "renew") {
					if (raw.length) return invalid("This operation takes no body");
					if (leases.renew(sid, param)) {
						if (!thread.available) { leases.clear(); throw unavailable(); }
						return send(res, 200, JSON.stringify({ ttlMs }));
					}
				}
				const request = { op, method, sid, param, raw, after, limit, project, revisionHeaders: req.headersDistinct["history-revision"] };
				const reply = thread ? await thread.run<HistoryReply>({ kind: "http", request })
					: await historyRequest(request, ttlMs, profile, options.store);
				if (reply.grant) leases.grant(sid, reply.grant);
				if (op === "release") leases.release(sid, param);
				if (op === "append" && drop > 0) { drop--; res.destroy(); return; }
				if (reply.noStore) res.setHeader("Cache-Control", "no-store");
				send(res, 200, reply.json);
			});
		} catch (e) {
			if (e instanceof UncertainCommit || res.headersSent) { res.destroy(); return; }
			if (!req.complete) { res.setHeader("Connection", "close"); req.resume(); }
			const failure = e instanceof BindingError ? e : e instanceof HistoryServiceError && Object.hasOwn(historyStorageStatuses, e.code)
				? new BindingError(historyStorageStatuses[e.code], e.code, e.message,
					e.code === "held" ? Math.max(1, Math.ceil(e.retryAfterMs ?? ttlMs) || ttlMs) : undefined)
				: unavailable();
			send(res, failure.status, JSON.stringify({ error: failure.message, code: failure.code, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) }));
		} finally { if (bodySlot) pendingBodies--; }
	});
	server.maxConnections = 64;
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
		});
	} catch (error) { await closeRecords(); throw error; }
	let closed: Promise<void>;
	server.once("close", () => {
		closed = closeRecords();
		void closed.catch(() => {});
	});
	// Report closure only after SQLite has released the store's process lock.
	const close = server.close.bind(server);
	server.close = callback => close(error => {
		if (error) callback?.(error);
		else void closed.then(() => callback?.(), error => callback?.(error));
	});
	const port = (server.address() as AddressInfo).port;
	return { server, port, url: `http://127.0.0.1:${port}` };
}
