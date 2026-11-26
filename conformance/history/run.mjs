#!/usr/bin/env node
// Disposable-service tests for docs/bindings/history-http.md.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isDeepStrictEqual as equal } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { runErasureRegistry } from "./erasure-registry.mjs";
import { tracedReply } from "./http-trace.mjs";
import { leaseFixtures } from "./lease-fixture.mjs";

const [url, tokenFile, ...options] = process.argv.slice(2);
const registryChecks = options[0] === "--erasure-registry-checks";
const [flag, ...extra] = registryChecks ? options.slice(1) : options;
const isolation = flag === "--isolation-checks";
const [otherUrl, otherTokenFile] = isolation ? extra : [];
const restartFlag = isolation ? undefined : flag;
const restartCommand = extra;
if (!url || !tokenFile || (registryChecks && !["--restart", "--restart-ttl"].includes(flag)) || (isolation && extra.length !== 2) || (restartFlag !== undefined && (!["--restart", "--restart-ttl"].includes(restartFlag) || restartCommand[0] !== "--" || !restartCommand[1]))) {
	console.error("Usage: node run.mjs <service url> <token file> [--restart|--restart-ttl -- <service command> [args...] | --isolation-checks <second URL> <second token file> | --erasure-registry-checks (--restart|--restart-ttl) -- <service command> [args...]]");
	process.exit(2);
}
const base = new URL(url);
const otherBase = isolation ? new URL(otherUrl) : undefined;
const safe = (u) => !u.username && !u.password && !u.search && !u.hash && (u.protocol === "https:" || (u.protocol === "http:" && (u.hostname.startsWith("127.") || u.hostname === "[::1]")));
if (!safe(base) || (isolation && (!safe(otherBase) || otherBase.origin === base.origin))) {
	console.error("Use a disposable service. Plain HTTP is allowed only on loopback.");
	process.exit(2);
}
const token = readFileSync(tokenFile, "utf8").trim();
const results = [];
let trace;
const check = (name, ok) => {
	results.push(!!ok);
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
	if (!ok && trace) {
		for (const request of trace) console.log(`      HTTP ${JSON.stringify(request)}`);
	}
};
const run = async (name, fn, requests) => {
	trace = requests;
	try { await fn(); } catch (e) { check(`${name}: ${e.message.replace(/\r?\n/g, "\\n")}`, false); }
	finally {
		await leases.close();
		trace = undefined;
	}
};
const req = async (method, path, body, { auth = token, raw = false, media = "application/json", endpoint = base, headers = {}, record = trace, signal = AbortSignal.timeout(15000) } = {}) => {
	const send = () => fetch(endpoint.href.replace(/\/$/, "") + path, {
		method, redirect: "error", signal,
		headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(body !== undefined ? { "content-type": media } : {}), ...headers },
		body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
	});
	if (record) return tracedReply(method, path, send, record);
	const res = await send();
	return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
};
// fetch normalizes dot segments before sending them. Send the request target verbatim.
const rawPath = (method, route) => new Promise((resolve, reject) => {
	const request = base.protocol === "https:" ? httpsRequest : httpRequest;
	const r = request(base, { method, path: base.pathname.replace(/\/+$/, "") + route, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }, (res) => {
		const chunks = [];
		res.on("data", (chunk) => chunks.push(chunk));
		res.on("error", reject);
		res.on("end", () => {
			let body;
			try { body = JSON.parse(Buffer.concat(chunks)); } catch { /* not JSON */ }
			resolve({ status: res.statusCode, headers: new Headers(res.headers), body });
		});
	});
	r.on("error", reject);
	r.end();
});
const ok = (r, expected) => r.status === 200 && equal(r.body, expected);
const err = (r, status, code) => r.status === status && r.body?.code === code && typeof r.body.error === "string" && r.headers.get("content-type")?.split(";")[0] === "application/json";
const positive = (x) => Number.isSafeInteger(x) && x > 0;
const held = (r, ttl = Infinity) => err(r, 409, "held") && positive(r.body.retryAfterMs) && r.body.retryAfterMs <= ttl;
const id = () => `kit-${randomUUID()}`;
const project = `/tmp/${id()}/+%`;
const path = (id) => `/v1/sessions/${encodeURIComponent(id)}`;
const put = (sid, meta) => req("PUT", path(sid), meta);
const acquire = (sid, owner) => req("POST", `${path(sid)}/lease`, { owner });
const renew = (sid, lease, signal) => req("POST", `${path(sid)}/lease/${encodeURIComponent(lease)}/renew`, undefined, { signal });
const leases = leaseFixtures(renew);
const keepAcquire = async (sid, owner) => {
	const sentAt = performance.now();
	const r = await acquire(sid, owner);
	if (r.status === 200 && typeof r.body?.lease === "string" && positive(r.body.ttlMs)) leases.keep(sid, r.body, sentAt);
	return r;
};
const release = async (sid, lease) => {
	await leases.stop(lease);
	return req("DELETE", `${path(sid)}/lease/${encodeURIComponent(lease)}`);
};
const append = async (sid, lease, entries) => {
	await leases.ready(lease);
	return req("POST", `${path(sid)}/entries`, { lease, entries });
};
const erase = async (sid, lease, entryIds) => {
	await leases.ready(lease);
	return req("POST", `${path(sid)}/erase`, { lease, entryIds });
};
const read = (sid, query = "") => req("GET", path(sid) + query);
const pageCap = 4 * 1024 * 1024;
let ttl, service;
async function startService(phase = "initial") {
	const child = spawn(restartCommand[1], restartCommand.slice(2), { stdio: "ignore", env: { ...process.env, MODULAR_AGENT_KIT_RESTART_PHASE: phase } });
	service = { child, stopped: new Promise((resolve) => {
		child.once("exit", resolve);
		child.once("error", resolve);
	}) };
	const probe = trace ? [] : undefined;
	for (let i = 0; i < 300; i++) {
		if (!child.pid || child.exitCode !== null || child.signalCode !== null) break;
		if (probe) probe.length = 0;
		const r = await req("GET", "/v1", undefined, { headers: { Connection: "close" }, record: probe }).catch(() => null);
		if (r?.status === 200) {
			if (probe) trace.push(...probe);
			return r;
		}
		await sleep(50);
	}
	if (probe) trace.push(...probe);
	throw Error("fixture service did not start");
}
async function stopService() {
	service.child.kill("SIGKILL");
	await service.stopped;
}
if (restartFlag) {
	try {
		const r = await startService();
		if (!positive(r.body?.ttlMs) || r.body.ttlMs > 60000) throw Error("restart fixture requires a positive TTL of at most 60 s");
		// A compliant service can hold all writes for a TTL after initial startup too.
		await sleep(r.body.ttlMs);
	} catch (e) {
		await stopService();
		console.error(e.message);
		process.exit(2);
	}
}

// History HTTP: The basics; What the service declares.
await run("declaration and authentication", async () => {
	for (const [name, auth] of [["missing", null], ["invalid", id()]]) {
		const r = await req("GET", "/v1", undefined, { auth });
		check(`auth: ${name} token gets the bearer error envelope`, err(r, 401, "unauthorized") && /^Bearer(?: |$)/i.test(r.headers.get("www-authenticate") ?? ""));
	}
	const r = await req("GET", "/v1");
	ttl = r.body?.ttlMs;
	check("declaration: binding, positive ttlMs and optional retention", r.status === 200 && r.body?.binding === "modular-agent-history/1" && positive(ttl) && (r.body.retention == null || positive(r.body.retention)));
});

// History HTTP: Sessions; Entries; Erasure; Writing: one writer at a time.
await run("session lifecycle", async () => {
	const sid = id(), empty = id(), other = id(), newer = id();
	const meta = { project, created: Date.now(), parentSessionId: id(), forkedFrom: { sessionId: id(), entryId: id() }, fixture: { n: 1 } };
	const session = { ...meta, id: sid };
	check("session: create and resend identical metadata", ok(await put(sid, meta), {}) && ok(await put(sid, meta), {}));
	check("session: changed metadata conflicts", err(await put(sid, { ...meta, fixture: { n: 2 } }), 409, "conflict"));
	await put(empty, meta);
	const owner = id();
	const a = await keepAcquire(sid, owner);
	const lease = a.body?.lease;
	check("lease: acquire and same-owner resend", a.status === 200 && typeof lease === "string" && lease.length > 0 && a.body.ttlMs === ttl && ok(await acquire(sid, owner), a.body));
	check("Writing: one writer at a time: the lease uses 1 to 128 base64url characters", typeof lease === "string" && lease.length >= 1 && lease.length <= 128 && !/[^A-Za-z0-9_-]/.test(lease));
	await leases.ready(lease);
	check("lease: a different owner gets held with retryAfterMs", held(await acquire(sid, id()), ttl));
	await leases.ready(lease);
	check("lease: renewal reports the declared TTL", ok(await renew(sid, lease), { ttlMs: ttl }));
	const usage = { input: 5, output: 2, cacheRead: 0, cacheWrite: 1, cost: 0.25 };
	const batch = [
		{ id: id(), parentId: null, kind: "response", turnId: "turn", stepId: "step", toolCallId: "call", jobId: "job", inputId: "input", requestId: "question", continuesTurnId: "previous-turn", actorId: "not-an-association", sources: ["origin-1", "origin-2"], writer: "not-a-job-owner", message: { role: "private", usage: { ...usage, opaque: "remove" }, content: [{ type: "kit.unknown", nested: { b: 2, a: 1 }, value: null }] } },
		{ id: id(), parentId: "opaque-parent", kind: 42, inputId: 42, requestId: null, continuesTurnId: { invalid: true }, sources: ["one", 2], unknown: [true, null, { a: 1 }] },
		{ id: id(), parentId: "job-parent", kind: "jobStarted", writer: "kit-job-owner", jobId: "job", data: { key: "fixture-key", detail: "remove" } },
		{ id: id(), parentId: "end-parent", kind: "jobEnded", jobId: "job", data: { usage, result: "remove" } },
		{ id: id(), parentId: "turn-parent", kind: "turnEnd", turnId: "turn", data: { usage, result: "remove" } },
	];
	check("append: equal same-batch duplicates do not count twice", ok(await append(sid, lease, [batch[0], ...batch]), { kept: batch.length }));
	check("append: resend and empty batch keep nothing", ok(await append(sid, lease, batch), { kept: 0 }) && ok(await append(sid, lease, []), { kept: 0 }));
	const numeric = JSON.stringify({ lease, entries: [batch[0]] }).replace('"b":2,"a":1', '"a":1.0,"b":2');
	await leases.ready(lease);
	check("append: numbers compare by value and object order is ignored", ok(await req("POST", `${path(sid)}/entries`, numeric, { raw: true }), { kept: 0 }));
	const third = { id: id(), parentId: batch[1].id };
	check("append: conflicting staged duplicate rejects the entire batch", err(await append(sid, lease, [third, { ...third, unknown: false }]), 409, "conflict"));
	check("append: changed already-kept id rejects the batch", err(await append(sid, lease, [third, { ...batch[0], kind: "changed" }]), 409, "conflict"));
	check("append: malformed entry or supplied tombstone rejects the batch", err(await append(sid, lease, [third, { parentId: null }]), 400, "invalid_request") && err(await append(sid, lease, [{ ...third, erased: true }]), 400, "invalid_request"));
	check("read: full metadata and full ordered opaque entries round-trip", ok(await read(sid), { session, entries: batch }));
	check("read: page cursor and boundary", ok(await read(sid, "?limit=1"), { session, entries: [batch[0]], next: batch[0].id }) && ok(await read(sid, `?after=${batch[0].id}`), { session, entries: batch.slice(1) }) && err(await read(sid, "?after=nope"), 404, "unknown_entry"));
	check("read: bad and repeated query values are refused", err(await read(sid, "?limit=501"), 400, "invalid_request") && err(await read(sid, "?limit=1&limit=2"), 400, "invalid_request"));
	for (const [s, m] of [[other, { ...meta, project: `${project}-other` }], [newer, { ...meta, created: meta.created + 1 }]]) {
		await put(s, m);
		const l = (await keepAcquire(s, id())).body?.lease;
		await append(s, l, [{ id: id(), parentId: null }]);
		await release(s, l);
	}
	const filter = `?project=${encodeURIComponent(project)}`;
	const listed = await req("GET", `/v1/sessions${filter}`);
	check("list: exact project filter, newest first, unused absent", ok(listed, { sessions: [{ ...meta, created: meta.created + 1, id: newer }, session] }));
	check("list: filter precedes cursor selection", err(await req("GET", `/v1/sessions${filter}&after=${other}`), 404, "unknown_session"));
	const targets = [batch[1].id, id(), batch[0].id, batch[1].id, ...batch.slice(2).map((e) => e.id)];
	await leases.ready(lease);
	check("erase: held or wrong generation leaves payloads intact", held(await erase(sid, undefined, targets), ttl) && err(await erase(sid, id(), targets), 409, "lost") && ok(await read(sid), { session, entries: batch }));
	const erased = { erased: [...new Set(targets.filter((target) => batch.some((e) => e.id === target)))] };
	check("erase: ordered distinct known IDs, also on same-lease retry", ok(await erase(sid, lease, targets), erased) && ok(await erase(sid, lease, targets), erased));
	const tombstones = [
		{ id: batch[0].id, parentId: null, kind: "response", erased: true, turnId: "turn", stepId: "step", toolCallId: "call", jobId: "job", inputId: "input", requestId: "question", continuesTurnId: "previous-turn", sources: batch[0].sources, usage },
		{ id: batch[1].id, parentId: "opaque-parent", kind: null, erased: true },
		{ id: batch[2].id, parentId: "job-parent", kind: "jobStarted", erased: true, jobId: "job", writer: "kit-job-owner", jobKey: "fixture-key" },
		{ id: batch[3].id, parentId: "end-parent", kind: "jobEnded", erased: true, jobId: "job", usage },
		{ id: batch[4].id, parentId: "turn-parent", kind: "turnEnd", erased: true, turnId: "turn", usage },
	];
	check("Erasure / Entry fields and tombstones: exact associations, sources, usage and keyed job owner survive", ok(await read(sid), { session, entries: tombstones }));
	check("erase: an erased id cannot regain its payload", err(await append(sid, lease, batch), 409, "conflict"));
	check("lease: release and release retry", ok(await release(sid, lease), {}) && ok(await release(sid, lease), {}));
	const fresh = await keepAcquire(sid, owner);
	const l2 = fresh.body?.lease;
	check("lease: same owner gets a fresh generation after release", fresh.status === 200 && typeof l2 === "string" && l2 !== lease);
	const race = await Promise.all([release(sid, lease), append(sid, lease, [third]), erase(sid, lease, targets), renew(sid, lease), append(sid, l2, [third])]);
	check("lease: delayed stale release, append, erase and renew cannot fence the new writer", ok(race[0], {}) && race.slice(1, 4).every((r) => err(r, 409, "lost")) && ok(race[4], { kept: 1 }) && ok(await read(sid), { session, entries: [...tombstones, third] }));
	await release(sid, l2);
	check("erase: no lease is needed without a writer", ok(await erase(sid, undefined, [third.id]), { erased: [third.id] }));
}, []);

// History HTTP: Erasure; Shared data: Entry fields and tombstones. Opaque rows isolate the projection.
await run("envelope associations", async () => {
	const sid = id(), meta = { project, created: Date.now() };
	await put(sid, meta);
	const { body: { lease } } = await keepAcquire(sid, id());
	const cases = [
		[{ kind: "input", inputId: "input" }, { inputId: "input" }],
		[{ kind: "inputAccepted", data: { inputId: "nested" } }, {}],
		[{ kind: "inputHandedBack", inputIds: ["plural"], data: { inputIds: ["nested"] } }, {}],
		[{ kind: "inputHandedBack", inputId: "first" }, { inputId: "first" }],
		[{ kind: "inputHandedBack", inputId: "second" }, { inputId: "second" }],
		[{ kind: "inputRequest", data: { requestId: "nested", request: { id: "also-nested" } } }, {}],
		[{ kind: "inputRequest", requestId: "asked", data: { request: { id: "asked" } } }, { requestId: "asked" }],
		[{ kind: "inputAnswer", data: { requestId: "nested" } }, {}],
		[{ kind: "inputAnswer", requestId: "answered", data: { requestId: "ignored" } }, { requestId: "answered" }],
		[{ kind: "turnStart", data: { continuesTurnId: "nested" } }, {}],
		[{ kind: "turnStart", continuesTurnId: "origin" }, { continuesTurnId: "origin" }],
	];
	const rows = cases.map(([entry]) => ({ id: id(), parentId: null, ...entry }));
	const expected = cases.map(([, projected], i) => ({ id: rows[i].id, parentId: null, kind: rows[i].kind, erased: true, ...projected }));
	const targets = rows.map((e) => e.id);
	check("Erasure: only envelope identities survive", ok(await append(sid, lease, rows), { kept: rows.length }) &&
		ok(await erase(sid, lease, targets), { erased: targets }) && ok(await read(sid), { session: { id: sid, ...meta }, entries: expected }));
	await release(sid, lease);
	const next = (await acquire(sid, id())).body.lease;
	check("Erasure: a new writer sees the same identities", !!next && ok(await read(sid), { session: { id: sid, ...meta }, entries: expected }));
	await release(sid, next);
}, []);

// History HTTP: The basics (path segments are validated before normalization).
await run("dot segments", async () => {
	const sid = id();
	for (const [label, segments] of [["raw", [".", ".."]], ["encoded", ["%2e", "%2E%2e", ".%2e", "%2E."]]]) {
		const replies = await Promise.all(segments.flatMap((segment) => [
			rawPath("GET", `/v1/sessions/${segment}`),
			rawPath("POST", `/v1/sessions/${sid}/lease/${segment}/renew`),
		]));
		check(`The basics: ${label} dot segments in session ids and leases are rejected before normalization`, replies.every((r) => err(r, 400, "invalid_request")));
	}
});

// History HTTP: The basics (validation and error order); Sessions (paging bounds); Entries (entry fit).
await run("validation and paging", async () => {
	const sid = id(), missing = id(), meta = { project, created: Date.now() };
	check("validation: malformed JSON and wrong media type", err(await req("PUT", path(sid), "{", { raw: true }), 400, "invalid_request") && err(await req("PUT", path(sid), meta, { media: "text/plain" }), 415, "unsupported_media_type"));
	check("validation: unknown session on read, append, erase, renew and release", (await Promise.all([read(missing), append(missing, id(), []), erase(missing, undefined, []), renew(missing, id()), release(missing, id())])).every((r) => err(r, 404, "unknown_session")));
	await put(sid, meta);
	const lease = (await keepAcquire(sid, id())).body?.lease;
	const entry = (i, payload) => ({ id: `${sid}-${i}`, parentId: null, ...(payload === undefined ? {} : { payload }) });
	const tooBig = entry("oversize", "x".repeat(pageCap));
	check("paging: oversized entry rejects the whole append", err(await append(sid, lease, [entry("staged"), tooBig]), 413, "entry_too_large") && ok(await read(sid), { session: { id: sid, ...meta }, entries: [] }));
	const entries = Array.from({ length: 501 }, (_, i) => entry(i));
	entries.push(entry(501, "😀".repeat(550000)), entry(502, "😀".repeat(550000)));
	check("paging: a 503-entry append of about 4.4 MB is kept whole", ok(await append(sid, lease, entries), { kept: entries.length }));
	const pages = [];
	for (let i = 0, after; i < 5; i++) {
		const r = await read(sid, after ? `?after=${encodeURIComponent(after)}` : "");
		pages.push(r);
		if (!r.body?.next) break;
		after = r.body.next;
	}
	check("paging: longest nonempty prefixes respect 500 entries and 4 MiB", pages.length === 3 && equal(pages.map((r) => r.body?.entries.length), [500, 2, 1]) && pages.every((r, i) => r.status === 200 && Buffer.byteLength(JSON.stringify(r.body)) <= pageCap && r.body.next === (i < pages.length - 1 ? r.body.entries.at(-1)?.id : undefined)));
	check("paging: walking cursors returns the complete ordered batch", equal(pages.flatMap((r) => r.body?.entries ?? []), entries));
	await release(sid, lease);
});

// Shared data: General rules; History HTTP: The basics. Count the root object as level 1.
await run("The basics: JSON nesting", async () => {
	const sid = id(), meta = { project, created: Date.now() };
	await put(sid, meta);
	const { body: { lease } } = await keepAcquire(sid, id());
	try {
		const opaque = Array.from({ length: 61 }).reduce((inner) => [inner], 1);
		const entry = { id: id(), parentId: null, kind: "kit.depth", opaque };
		check("The basics: accepts and returns an append with 64 levels of JSON nesting", ok(await append(sid, lease, [entry]), { kept: 1 }) &&
			ok(await read(sid), { session: { id: sid, ...meta }, entries: [entry] }));
		const deeper = { ...entry, id: id(), parentId: entry.id, opaque: [opaque] };
		const r = await append(sid, lease, [deeper]);
		check("The basics: one level beyond 64 is either accepted or refused as invalid_request", err(r, 400, "invalid_request") || ok(r, { kept: 1 }));
	} finally { await release(sid, lease); }
});

// History HTTP: Writing: one writer at a time (expiry is a different transition from release).
if (positive(ttl) && ttl <= 60000) await run("expiry", async () => {
	const sid = id(), owner = id();
	await put(sid, { project, created: Date.now() });
	const first = await acquire(sid, owner);
	await sleep(ttl + 25);
	const next = await acquire(sid, owner);
	check("lease: expiry grants a distinct generation and fences the expired one", first.status === 200 && next.status === 200 && first.body?.lease !== next.body?.lease && err(await append(sid, first.body?.lease, []), 409, "lost") && ok(await append(sid, next.body?.lease, []), { kept: 0 }));
	await release(sid, next.body?.lease);
});
else console.log("SKIP  lease expiry (positive TTL of at most 60 s required by this fixture)");

// History HTTP: Writing: one writer at a time. Distinguish preserved leases from global exclusion.
if (restartFlag) {
	await run("restart", async () => {
		const sid = id(), unheld = id(), owner = id();
		const meta = { project, created: Date.now() };
		const seed = async (session) => {
			const entry = { id: id(), parentId: null };
			await put(session, meta);
			const lease = (await acquire(session, owner)).body?.lease;
			if (!lease || !ok(await append(session, lease, [entry]), { kept: 1 })) throw Error("could not seed restart sessions");
			return { entry, lease };
		};
		const free = await seed(unheld);
		if (!ok(await release(unheld, free.lease), {})) throw Error("could not release restart fixture lease");
		const current = await seed(sid);
		const renewedAt = performance.now();
		if (!ok(await renew(sid, current.lease), { ttlMs: ttl })) throw Error("could not renew restart fixture lease");
		await stopService();
		const restarted = await startService("restart");
		const newTtl = restarted.body?.ttlMs;
		const decreased = restartFlag === "--restart-ttl";
		check("Writing: one writer at a time: restarted service advertises the fixture TTL", positive(newTtl) && (decreased ? newTtl < ttl : newTtl === ttl));
		if (decreased && positive(newTtl) && newTtl < ttl) await sleep(newTtl + 25);
		// Empty append tests the old lease without extending it at the new TTL.
		const keptLease = await append(sid, current.lease, []);
		if (ok(keptLease, { kept: 0 })) {
			check("Writing: one writer at a time: a preserved lease still excludes another owner", held(await acquire(sid, id())));
		} else {
			// Separate sessions for acquire and erase: an unintended acquire must not mask a missing hold.
			const [a, e] = await Promise.all([acquire(sid, owner), erase(unheld, undefined, [free.entry.id])]);
			if (performance.now() - renewedAt >= ttl) console.log("SKIP  restart hold (restart and probes exceeded the TTL)");
			else check(`Writing: one writer at a time: restart holds acquire and unleased erase${decreased ? " beyond the decreased TTL" : ""}`, err(keptLease, 409, "lost") && held(a) && held(e) && ok(await read(unheld), { session: { id: unheld, ...meta }, entries: [free.entry] }));
		}
		check("Writing: one writer at a time: acknowledged entries survive restart", ok(await read(sid), { session: { id: sid, ...meta }, entries: [current.entry] }));
	});
	if (registryChecks) {
		await run("pending-erasure registry", () => runErasureRegistry({
			url: base.href, tokenFile, project, check, ttl, trace,
			req: (method, path, body, opts) => req(method, path, body, {
				...opts, headers: { ...opts?.headers, Connection: "close" },
			}),
			restart: async () => {
				await stopService();
				return await startService("restart");
			},
		}), []);
	}
	await stopService();
} else console.log("SKIP  restart hold (use --restart with a disposable service command)");

if (isolation) await run("deployment isolation", async () => {
	const otherToken = readFileSync(otherTokenFile, "utf8").trim();
	if (token === otherToken) throw Error("deployment isolation needs distinct credentials");
	const second = (method, route, body) => req(method, route, body, { endpoint: otherBase, auth: otherToken });
	const sid = id(), entry = { id: id(), parentId: null, payload: id() };
	const isolatedProject = `/tmp/${id()}`;
	const meta = { project: isolatedProject, created: Date.now() };
	const route = path(sid);
	if (!ok(await second("PUT", route, meta), {}) ||
		!await second("POST", route + "/lease", { owner: id() }).then(async ({ body }) => {
			const lease = body?.lease;
			return lease && ok(await second("POST", route + "/entries", { lease, entries: [entry] }), { kept: 1 }) &&
				ok(await second("DELETE", `${route}/lease/${encodeURIComponent(lease)}`), {});
		})) throw Error("could not seed isolated namespace");
	check("deployment isolation: credentials are refused by the other service",
		err(await req("GET", "/v1", undefined, { auth: otherToken }), 401, "unauthorized") &&
		err(await req("GET", "/v1", undefined, { endpoint: otherBase }), 401, "unauthorized"));
	const filter = `/v1/sessions?project=${encodeURIComponent(isolatedProject)}`;
	check("deployment isolation: project and foreign ID do not route reads to the other service",
		ok(await req("GET", filter), { sessions: [] }) &&
		ok(await second("GET", filter), { sessions: [{ id: sid, ...meta }] }) &&
		err(await read(sid), 404, "unknown_session"));
	check("deployment isolation: acquire, append and erase in the wrong store cannot affect the foreign session",
		err(await acquire(sid, id()), 404, "unknown_session") &&
		err(await append(sid, id(), [{ id: id(), parentId: null }]), 404, "unknown_session") &&
		err(await erase(sid, undefined, [entry.id]), 404, "unknown_session") &&
		ok(await second("GET", route), { session: { id: sid, ...meta }, entries: [entry] }));
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exitCode = passed === results.length ? 0 : 1;
