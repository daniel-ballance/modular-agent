#!/usr/bin/env node
// Disposable-service tests for docs/bindings/history-http.md.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual as equal } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const [url, tokenFile] = process.argv.slice(2);
if (!url || !tokenFile) {
	console.error("Usage: node run.mjs <service url> <token file>");
	process.exit(2);
}
const base = new URL(url);
if (base.username || base.password || base.search || base.hash || (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))) {
	console.error("Use a disposable service. Plain HTTP is allowed only on loopback.");
	process.exit(2);
}
const token = readFileSync(tokenFile, "utf8").trim();
const results = [];
const check = (name, ok) => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); };
const run = async (name, fn) => {
	try { await fn(); } catch (e) { check(`${name}: ${e.name}`, false); }
};
const req = async (method, path, body, { auth = token, raw = false, media = "application/json" } = {}) => {
	const res = await fetch(base.href.replace(/\/$/, "") + path, {
		method, redirect: "error", signal: AbortSignal.timeout(15000),
		headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(body !== undefined ? { "content-type": media } : {}) },
		body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
	});
	return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
};
const ok = (r, expected) => r.status === 200 && equal(r.body, expected);
const err = (r, status, code) => r.status === status && r.body?.code === code && typeof r.body.error === "string" && r.headers.get("content-type")?.split(";")[0] === "application/json";
const positive = (x) => Number.isSafeInteger(x) && x > 0;
const held = (r, ttl) => err(r, 409, "held") && positive(r.body.retryAfterMs) && r.body.retryAfterMs <= ttl;
const id = () => `kit-${randomUUID()}`;
const project = `/tmp/${id()}/+%`;
const path = (id) => `/v1/sessions/${encodeURIComponent(id)}`;
const put = (sid, meta) => req("PUT", path(sid), meta);
const acquire = (sid, owner) => req("POST", `${path(sid)}/lease`, { owner });
const renew = (sid, lease) => req("POST", `${path(sid)}/lease/${encodeURIComponent(lease)}/renew`);
const release = (sid, lease) => req("DELETE", `${path(sid)}/lease/${encodeURIComponent(lease)}`);
const append = (sid, lease, entries) => req("POST", `${path(sid)}/entries`, { lease, entries });
const erase = (sid, lease, entryIds) => req("POST", `${path(sid)}/erase`, { lease, entryIds });
const read = (sid, query = "") => req("GET", path(sid) + query);
const pageCap = 4 * 1024 * 1024;
let ttl;

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
	const a = await acquire(sid, owner);
	const lease = a.body?.lease;
	check("lease: acquire and same-owner resend", a.status === 200 && typeof lease === "string" && lease.length > 0 && a.body.ttlMs === ttl && ok(await acquire(sid, owner), a.body));
	check("lease: a different owner gets held with retryAfterMs", held(await acquire(sid, id()), ttl));
	check("lease: renewal reports the declared TTL", ok(await renew(sid, lease), { ttlMs: ttl }));
	const batch = [
		{ id: id(), parentId: null, kind: "response", turnId: "turn", stepId: "step", toolCallId: "call", jobId: "job", message: { role: "private", content: [{ type: "kit.unknown", nested: { b: 2, a: 1 }, value: null }] } },
		{ id: id(), parentId: "opaque-parent", kind: 42, unknown: [true, null, { a: 1 }] },
	];
	check("append: equal same-batch duplicates do not count twice", ok(await append(sid, lease, [batch[0], batch[0], batch[1]]), { kept: 2 }));
	check("append: resend and empty batch keep nothing", ok(await append(sid, lease, batch), { kept: 0 }) && ok(await append(sid, lease, []), { kept: 0 }));
	const numeric = JSON.stringify({ lease, entries: [batch[0]] }).replace('"b":2,"a":1', '"a":1.0,"b":2');
	check("append: numbers compare by value and object order is ignored", ok(await req("POST", `${path(sid)}/entries`, numeric, { raw: true }), { kept: 0 }));
	const third = { id: id(), parentId: batch[1].id };
	check("append: conflicting staged duplicate rejects the entire batch", err(await append(sid, lease, [third, { ...third, unknown: false }]), 409, "conflict"));
	check("append: changed already-kept id rejects the batch", err(await append(sid, lease, [third, { ...batch[0], kind: "changed" }]), 409, "conflict"));
	check("append: malformed entry or supplied tombstone rejects the batch", err(await append(sid, lease, [third, { parentId: null }]), 400, "invalid_request") && err(await append(sid, lease, [{ ...third, erased: true }]), 400, "invalid_request"));
	check("read: full metadata and full ordered opaque entries round-trip", ok(await read(sid), { session, entries: batch }));
	check("read: page cursor and boundary", ok(await read(sid, "?limit=1"), { session, entries: [batch[0]], next: batch[0].id }) && ok(await read(sid, `?after=${batch[0].id}`), { session, entries: [batch[1]] }) && err(await read(sid, "?after=nope"), 404, "unknown_entry"));
	check("read: bad and repeated query values are refused", err(await read(sid, "?limit=501"), 400, "invalid_request") && err(await read(sid, "?limit=1&limit=2"), 400, "invalid_request"));
	for (const [s, m] of [[other, { ...meta, project: `${project}-other` }], [newer, { ...meta, created: meta.created + 1 }]]) {
		await put(s, m);
		const l = (await acquire(s, id())).body?.lease;
		await append(s, l, [{ id: id(), parentId: null }]);
		await release(s, l);
	}
	const filter = `?project=${encodeURIComponent(project)}`;
	const listed = await req("GET", `/v1/sessions${filter}`);
	check("list: exact project filter, newest first, unused absent", ok(listed, { sessions: [{ ...meta, created: meta.created + 1, id: newer }, session] }));
	check("list: filter precedes cursor selection", err(await req("GET", `/v1/sessions${filter}&after=${other}`), 404, "unknown_session"));
	const targets = [batch[1].id, id(), batch[0].id, batch[1].id];
	check("erase: held or wrong generation leaves payloads intact", held(await erase(sid, undefined, targets), ttl) && err(await erase(sid, id(), targets), 409, "lost") && ok(await read(sid), { session, entries: batch }));
	const erased = { erased: [batch[1].id, batch[0].id] };
	check("erase: ordered distinct known IDs, also on same-lease retry", ok(await erase(sid, lease, targets), erased) && ok(await erase(sid, lease, targets), erased));
	const tombstones = [
		{ id: batch[0].id, parentId: null, kind: "response", erased: true, turnId: "turn", stepId: "step", toolCallId: "call", jobId: "job" },
		{ id: batch[1].id, parentId: "opaque-parent", kind: null, erased: true },
	];
	check("erase: exact tombstones replace payloads in kept order", ok(await read(sid), { session, entries: tombstones }));
	check("erase: an erased id cannot regain its payload", err(await append(sid, lease, batch), 409, "conflict"));
	check("lease: release and release retry", ok(await release(sid, lease), {}) && ok(await release(sid, lease), {}));
	const fresh = await acquire(sid, owner);
	const l2 = fresh.body?.lease;
	check("lease: same owner gets a fresh generation after release", fresh.status === 200 && typeof l2 === "string" && l2 !== lease);
	const race = await Promise.all([release(sid, lease), append(sid, lease, [third]), erase(sid, lease, targets), renew(sid, lease), append(sid, l2, [third])]);
	check("lease: delayed stale release, append, erase and renew cannot fence the new writer", ok(race[0], {}) && race.slice(1, 4).every((r) => err(r, 409, "lost")) && ok(race[4], { kept: 1 }) && ok(await read(sid), { session, entries: [...tombstones, third] }));
	await release(sid, l2);
	check("erase: no lease is needed without a writer", ok(await erase(sid, undefined, [third.id]), { erased: [third.id] }));
});

// History HTTP: The basics (validation and error order); Sessions (paging bounds); Entries (entry fit).
await run("validation and paging", async () => {
	const sid = id(), missing = id(), meta = { project, created: Date.now() };
	check("validation: malformed JSON and wrong media type", err(await req("PUT", path(sid), "{", { raw: true }), 400, "invalid_request") && err(await req("PUT", path(sid), meta, { media: "text/plain" }), 415, "unsupported_media_type"));
	check("validation: unknown session on read, append, erase, renew and release", (await Promise.all([read(missing), append(missing, id(), []), erase(missing, undefined, []), renew(missing, id()), release(missing, id())])).every((r) => err(r, 404, "unknown_session")));
	await put(sid, meta);
	const lease = (await acquire(sid, id())).body?.lease;
	const entry = (i, payload) => ({ id: `${sid}-${i}`, parentId: null, ...(payload === undefined ? {} : { payload }) });
	const tooBig = entry("oversize", "x".repeat(pageCap));
	check("paging: oversized entry rejects the whole append", err(await append(sid, lease, [entry("staged"), tooBig]), 413, "entry_too_large") && ok(await read(sid), { session: { id: sid, ...meta }, entries: [] }));
	const entries = Array.from({ length: 501 }, (_, i) => entry(i));
	entries.push(entry(501, "😀".repeat(550000)), entry(502, "😀".repeat(550000)));
	await append(sid, lease, entries);
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

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exitCode = passed === results.length ? 0 : 1;
