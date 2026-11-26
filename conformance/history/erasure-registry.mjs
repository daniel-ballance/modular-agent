import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual as equal } from "node:util";
import { tracedReply } from "./http-trace.mjs";
import { leaseFixtures } from "./lease-fixture.mjs";

const id = () => `kit-${randomUUID()}`;
const path = (sid) => `/v1/sessions/${encodeURIComponent(sid)}`;
const registry = (sid) => `${path(sid)}/pending-erasure`;
const revisionOK = (rev) => typeof rev === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(rev);
const json = (r) => r.headers.get("content-type")?.split(";")[0] === "application/json";
const ok = (r, body) => r.status === 200 && json(r) && equal(r.body, body);
const err = (r, status, code) => r.status === status && json(r) && r.body?.code === code && typeof r.body.error === "string";
const need = (condition, reason) => { if (!condition) throw Error(reason); };

function client(req) {
	const leases = leaseFixtures((sid, lease, signal) =>
		req("POST", `${path(sid)}/lease/${encodeURIComponent(lease)}/renew`, undefined, { signal }));
	return {
		read: (sid) => req("GET", path(sid)),
		plans: (sid, query = "") => req("GET", registry(sid) + query),
		async acquire(sid) {
			const sentAt = performance.now();
			const r = await req("POST", `${path(sid)}/lease`, { owner: id() });
			need(r.status === 200 && revisionOK(r.body?.lease) && Number.isSafeInteger(r.body.ttlMs) && r.body.ttlMs > 0,
				"could not acquire fixture lease");
			leases.keep(sid, r.body, sentAt);
			return r.body.lease;
		},
		async release(sid, lease) {
			await leases.stop(lease);
			return req("DELETE", `${path(sid)}/lease/${encodeURIComponent(lease)}`);
		},
		async append(sid, lease, entries, revision) {
			await leases.ready(lease);
			return req("POST", `${path(sid)}/entries`, { lease, entries }, { headers: { "History-Revision": revision } });
		},
		async publish(sid, body) {
			await leases.ready(body.lease);
			return req("POST", registry(sid), body);
		},
		async erase(sid, lease, entryIds) {
			await leases.ready(lease);
			return req("POST", `${path(sid)}/erase`, { lease, entryIds });
		},
		async complete(sid, intent, lease, entryIds) {
			await leases.ready(lease);
			return req("POST", `${registry(sid)}/${encodeURIComponent(intent)}/complete`, { lease, entryIds });
		},
		ready: leases.ready,
		close: leases.close,
	};
}

async function withClient(connection, trace, work) {
	const child = fork(new URL(import.meta.url), ["--fixture-client"], { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] });
	const stopped = new Promise((resolve) => {
		child.once("exit", resolve);
		child.once("error", resolve);
	});
	try {
		await work(async (action, args) => {
			const reply = once(child, "message");
			child.send({ connection, action, args });
			const [response] = await Promise.race([
				reply,
				stopped.then(() => { throw Error("registry fixture client exited without replying"); }),
			]);
			for (const request of response.trace) trace.push({ action, ...request });
			if (response.error) throw Error(response.error);
			return response.result;
		});
	} finally {
		if (child.connected) child.disconnect();
		await stopped;
	}
}

export async function runErasureRegistry(options) {
	const c = client(options.req);
	try { await verifyRegistry(options, c); }
	finally { await c.close(); }
}

async function verifyRegistry({ url, tokenFile, project, req, check, ttl, restart, trace }, c) {
	const declare = (r) => r.status === 200 && r.body?.pendingErasure === 1;
	const supported = declare(await req("GET", "/v1"));
	check("registry: GET /v1 declares pendingErasure: 1", supported);
	if (!supported) return;

	// The base restart probe has just restarted the service. Its exclusion can last a TTL.
	await sleep(ttl);
	const connection = { url, tokenFile };
	const source = id(), dest = id(), intentId = id();
	const original = { id: id(), parentId: null, kind: "summary", data: { text: id() } };
	const copy = { ...original, id: id(), sources: [original.id] };
	const intervening = { id: id(), parentId: copy.id };
	const record = { id: id(), parentId: intervening.id, kind: "erasure", data: { entryIds: [copy.id] } };
	const meta = { project, created: Date.now() };
	const copies = [
		{ sessionId: source, recordId: id(), entryIds: [original.id] },
		{ sessionId: dest, recordId: record.id, entryIds: [copy.id] },
	];
	const publish = { intentId, entryIds: [original.id], copies };
	const plan = (complete) => ({ intentId, sourceSessionId: source, recordId: record.id, copies: [{ entryId: copy.id, complete }] });
	const hasPlan = (r, expected) => revisionOK(r.body?.revision) && ok(r, { revision: r.body.revision, plans: expected });
	const seed = async (sid, entry) => {
		need(ok(await req("PUT", path(sid), meta), {}), "could not create registry fixture session");
		const lease = await c.acquire(sid);
		const read = await c.plans(sid);
		need(hasPlan(read, []) && ok(await c.append(sid, lease, [entry], read.body.revision), { kept: 1 }), "could not seed registry fixture session");
		return lease;
	};
	const sourceLease = await seed(source, original);
	const destLease = await seed(dest, copy);
	const before = await c.plans(source);
	check("registry: authenticated, uncached reads share one revision across sessions",
		hasPlan(before, []) && before.headers.get("cache-control")?.split(/\s*,\s*/).includes("no-store") &&
		ok(await c.plans(dest), before.body) && err(await req("GET", registry(dest), undefined, { auth: null }), 401, "unauthorized"));
	const oldRevision = before.body.revision;
	need(ok(await c.append(dest, destLease, [intervening], oldRevision), { kept: 1 }), "could not change history after discovery");
	check("registry: stale discovery revision cannot publish marks",
		err(await c.publish(source, { ...publish, lease: sourceLease, revision: oldRevision }), 409, "stale_revision") && hasPlan(await c.plans(dest), []));
	check("registry: invalid copy set and unknown lookup are refused",
		err(await c.publish(source, { ...publish, copies: [], lease: sourceLease, revision: oldRevision }), 400, "invalid_request") &&
		err(await c.plans(id()), 404, "unknown_session"));
	need(ok(await c.release(source, sourceLease), {}), "could not release source fixture lease");

	await withClient(connection, trace, async (reader) => {
		check("registry: independent reader can serve the copy before publication", await reader("prepare", { dest, copy }));
		const snapshot = await c.plans(dest);
		check("registry: publication requires a current source lease",
			err(await c.publish(source, { ...publish, lease: sourceLease, revision: snapshot.body.revision }), 409, "lost"));
		await c.ready(destLease);
		let mark;
		await withClient(connection, trace, async (writerA) => { mark = await writerA("mark", { source, dest, copy, publish }); });
		await c.ready(destLease);
		check("registry: writer A marks the copy while its destination lease is held", mark.published);
		const marked = await c.plans(dest);
		check("registry: pending plan has the stable record and copy IDs; raw reads are unchanged",
			hasPlan(marked, [plan(false)]) && marked.body.revision !== snapshot.body.revision && (await c.read(dest)).body?.entries?.some(e => equal(e, copy)));
		check("registry: independent reader refuses its cached copy after publication", await reader("cached-refused", { dest }));
		check("registry: stale guarded append is fenced even with the current destination lease",
			err(await c.append(dest, destLease, [{ id: id(), parentId: null, sources: [copy.id] }], snapshot.body.revision), 409, "stale_revision"));
		check("registry: duplicate publication finds the same intent; unknown plan cursor fails",
			mark.duplicate && err(await c.plans(dest, `?after=${encodeURIComponent(id())}`), 404, "unknown_intent"));
		check("registry: completion needs bookkeeping and a tombstone",
			err(await c.complete(dest, intentId, destLease, [copy.id]), 409, "conflict") && hasPlan(await c.plans(dest), [plan(false)]));
		need(ok(await c.release(dest, destLease), {}), "could not release destination fixture lease");

		const restarted = await restart();
		check("registry: pending mark survives a service restart and still blocks the reader",
			declare(restarted) && hasPlan(await c.plans(dest), [plan(false)]) && await reader("cached-refused", { dest }));
		await sleep(ttl); // The restart exclusion is a protocol wait, not a retry.
		await withClient(connection, trace, async (writerB) => {
			const result = await writerB("complete", { dest, intentId, record, copy, destLease });
			check("registry: writer B's new lease fences completion by the old writer", result.fenced);
			check("registry: a matching erasure record alone does not confirm deletion", result.bookOnlyRefused);
			check("registry: writer B completes with a tombstone; repeat completion is harmless", result.completed);
		});
		check("registry: completed plan still refuses a stale view; fresh view has no copy payload",
			hasPlan(await c.plans(dest), [plan(true)]) && await reader("cached-refused", { dest }) && await reader("fresh-tombstone", { dest, copy }));
		check("registry: completion and the tombstone also survive restart",
			declare(await restart()) && hasPlan(await c.plans(dest), [plan(true)]) && await reader("fresh-tombstone", { dest, copy }));
	});
}

// These are small wire clients, not SDK/Harness conformance tests.
if (process.argv[2] === "--fixture-client" && process.send) {
	let cached;
	process.on("message", async ({ connection: { url, tokenFile }, action, args }) => {
		const trace = [];
		let c, response;
		try {
			const token = readFileSync(tokenFile, "utf8").trim();
			c = client((method, route, body, opts) =>
				tracedReply(method, route, () => fetch(url.replace(/\/+$/, "") + route, {
					method, redirect: "error", cache: "no-store", signal: opts?.signal ?? AbortSignal.timeout(15000),
					headers: { authorization: `Bearer ${token}`, Connection: "close", ...(body === undefined ? {} : { "content-type": "application/json" }), ...opts?.headers },
					body: body === undefined ? undefined : JSON.stringify(body),
				}), trace, { strict: true }));
			const view = async (sid, entries) => {
				// Prepare first, then consult the authoritative plans before answering.
				const r = await c.plans(sid);
				if (r.status !== 200 || !revisionOK(r.body?.revision) || r.body.next || !Array.isArray(r.body.plans)) throw Error("invalid registry fixture page");
				if (r.body.plans.some(p => p.copies.some(copy => !copy.complete || !entries.some(e => e.id === copy.entryId && e.erased === true)))) return undefined;
				return entries;
			};
			const { source, publish, dest, intentId, record, copy, destLease } = args;
			let result;
			if (action === "prepare") {
				cached = (await c.read(dest)).body.entries;
				result = !!(await view(dest, cached))?.some(e => equal(e, copy));
			} else if (action === "cached-refused") {
				result = await view(dest, cached) === undefined;
			} else if (action === "fresh-tombstone") {
				const entries = await view(dest, (await c.read(dest)).body.entries);
				result = !!entries?.some(e => e.id === copy.id && e.erased === true && !Object.hasOwn(e, "data"));
			} else if (action === "mark") {
				const lease = await c.acquire(source);
				const { revision } = (await c.plans(source)).body;
				need((await c.read(source)).body.entries.some(e => e.id === publish.entryIds[0]) &&
					(await c.read(dest)).body.entries.some(e => equal(e, copy)), "writer A could not discover the copy");
				const request = { ...publish, revision, lease };
				const expected = { intentId: publish.intentId, sessionIds: [source, dest] };
				result = { published: ok(await c.publish(source, request), expected), duplicate: ok(await c.publish(source, request), expected) };
				need(ok(await c.release(source, lease), {}), "writer A could not release its lease");
			} else if (action === "complete") {
				const lease = await c.acquire(dest);
				const { revision, plans } = (await c.plans(dest)).body;
				need(plans.find(p => p.intentId === intentId)?.recordId === record.id, "writer B could not recover the plan");
				const entryIds = [copy.id];
				const fenced = lease !== destLease && err(await c.complete(dest, intentId, destLease, entryIds), 409, "lost");
				need(ok(await c.append(dest, lease, [record], revision), { kept: 1 }), "writer B could not write erasure bookkeeping");
				const bookOnlyRefused = err(await c.complete(dest, intentId, lease, entryIds), 409, "conflict");
				need(ok(await c.erase(dest, lease, entryIds), { erased: entryIds }), "writer B could not erase the copy");
				const entries = (await c.read(dest)).body.entries;
				const completed = entries.some(e => e.id === copy.id && e.erased === true) &&
					ok(await c.complete(dest, intentId, lease, entryIds), {}) && ok(await c.complete(dest, intentId, lease, entryIds), {});
				result = { fenced, bookOnlyRefused, completed };
				need(ok(await c.release(dest, lease), {}), "writer B could not release its lease");
			} else throw Error("unknown registry fixture action");
			response = { result };
		} catch (error) {
			response = { error: error.message };
		} finally {
			await c?.close();
		}
		process.send({ ...response, trace });
	});
}
