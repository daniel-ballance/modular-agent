#!/usr/bin/env node
// Conformance kit for the history service binding, modular-agent-history/1 (docs/bindings/history-http.md).
// Usage: node run.mjs <service url> <token file>
// Checks a running service over plain HTTP. It creates sessions with random ids, so it can run against a shared service.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const [url, tokenFile] = process.argv.slice(2);
if (!url || !tokenFile) {
	console.error("Usage: node run.mjs <service url> <token file>");
	process.exit(2);
}
const token = readFileSync(tokenFile, "utf8").trim();
const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok: !!ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
}
async function req(method, path, body, auth = token) {
	const res = await fetch(url.replace(/\/$/, "") + path, {
		method,
		headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let json;
	try {
		json = text ? JSON.parse(text) : {};
	} catch {
		json = { raw: text };
	}
	return { status: res.status, body: json };
}
const id = `kit-${randomUUID()}`;
const empty = `kit-${randomUUID()}`;
const project = `/tmp/kit-project-${randomUUID()}`;
const e = (n, parentId, extra = {}) => ({ id: `${id}-e${n}`, parentId, kind: "input", message: { role: "user", content: [{ type: "text", text: `secret ${n}` }] }, data: { n, nested: { b: 2, a: 1 } }, ...extra });

let r = await req("GET", "/v1", undefined, null);
check("401 without a token", r.status === 401, `got ${r.status}`);
r = await req("GET", "/v1", undefined, "wrong-token");
check("401 with a wrong token", r.status === 401, `got ${r.status}`);
r = await req("GET", "/v1");
check("GET /v1 names the binding", r.status === 200 && r.body.binding === "modular-agent-history/1", JSON.stringify(r.body));

r = await req("PUT", `/v1/sessions/${id}`, { project, created: Date.now() });
check("PUT a session", r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
r = await req("PUT", `/v1/sessions/${id}`, { project, created: Date.now() });
check("PUT again is harmless", r.status === 200, `${r.status}`);
r = await req("PUT", `/v1/sessions/${id}`, { project: `${project}-other`, created: Date.now() });
check("PUT with another project is 409 conflict", r.status === 409 && r.body.code === "conflict", `${r.status} ${JSON.stringify(r.body)}`);
await req("PUT", `/v1/sessions/${empty}`, { project, created: Date.now() });

r = await req("POST", `/v1/sessions/${id}/lease`, { owner: "kit-a" });
const lease = r.body.lease;
check("take a lease", r.status === 200 && typeof lease === "string" && typeof r.body.ttlMs === "number", JSON.stringify(r.body));
r = await req("POST", `/v1/sessions/${id}/lease`, { owner: "kit-a" });
check("the same owner gets the same lease", r.status === 200 && r.body.lease === lease, JSON.stringify(r.body));
r = await req("POST", `/v1/sessions/${id}/lease`, { owner: "kit-b" });
check("another owner is 409 held", r.status === 409 && r.body.code === "held", `${r.status} ${JSON.stringify(r.body)}`);
r = await req("POST", `/v1/sessions/${id}/lease/${lease}/renew`);
check("renew a current lease", r.status === 200 && typeof r.body.ttlMs === "number", `${r.status}`);

const batch = [e(1, null, { turnId: "t-1", toolCallId: "c-1" }), e(2, `${id}-e1`)];
r = await req("POST", `/v1/sessions/${id}/entries`, { lease, entries: batch });
check("keep entries", r.status === 200 && r.body.kept === 2, `${r.status} ${JSON.stringify(r.body)}`);
r = await req("POST", `/v1/sessions/${id}/entries`, { lease, entries: batch });
check("resending is harmless: kept 0", r.status === 200 && r.body.kept === 0, `${r.status} ${JSON.stringify(r.body)}`);
const reordered = [{ ...batch[0], data: { nested: { a: 1, b: 2 }, n: 1 } }];
r = await req("POST", `/v1/sessions/${id}/entries`, { lease, entries: reordered });
check("key order doesn't change content", r.status === 200 && r.body.kept === 0, `${r.status} ${JSON.stringify(r.body)}`);
r = await req("POST", `/v1/sessions/${id}/entries`, { lease, entries: [e(3, `${id}-e2`), { ...batch[0], data: { n: 99 } }] });
check("same id, other content is 409 conflict", r.status === 409 && r.body.code === "conflict", `${r.status} ${JSON.stringify(r.body)}`);
r = await req("GET", `/v1/sessions/${id}`);
check("all or none: a conflicting batch kept nothing", r.status === 200 && r.body.entries.length === 2, `${r.body.entries?.length} entries`);
check("entries come back unchanged", r.status === 200 && JSON.stringify(r.body.entries[1]) === JSON.stringify(batch[1]) || (r.body.entries[1] && r.body.entries[1].data?.nested?.a === 1 && r.body.entries[1].message?.content?.[0]?.text === "secret 2"));
check("the session comes back with its project", r.body.session?.id === id && r.body.session?.project === project, JSON.stringify(r.body.session));
r = await req("POST", `/v1/sessions/${id}/entries`, { lease: "not-a-lease", entries: [e(3, `${id}-e2`)] });
check("a wrong lease is 409 lost", r.status === 409 && r.body.code === "lost", `${r.status} ${JSON.stringify(r.body)}`);

r = await req("GET", `/v1/sessions/${id}?after=${id}-e1`);
check("?after gives later entries", r.status === 200 && r.body.entries.length === 1 && r.body.entries[0].id === `${id}-e2`, JSON.stringify(r.body.entries?.map((x) => x.id)));
r = await req("GET", `/v1/sessions/${id}?after=nope`);
check("?after an unknown entry is 404 unknown_entry", r.status === 404 && r.body.code === "unknown_entry", `${r.status} ${JSON.stringify(r.body)}`);
r = await req("GET", `/v1/sessions/kit-${randomUUID()}`);
check("an unknown session is 404 unknown_session", r.status === 404 && r.body.code === "unknown_session", `${r.status} ${JSON.stringify(r.body)}`);

r = await req("GET", `/v1/sessions?project=${encodeURIComponent(project)}`);
const ids = (r.body.sessions ?? []).map((s) => s.id);
check("list shows the session with entries", ids.includes(id), ids.join(","));
check("list leaves out a session with no entries", !ids.includes(empty), ids.join(","));

r = await req("POST", `/v1/sessions/${id}/erase`, { entryIds: [`${id}-e1`] });
check("erase without the holder's lease is 409 held", r.status === 409 && r.body.code === "held", `${r.status} ${JSON.stringify(r.body)}`);
r = await req("POST", `/v1/sessions/${id}/erase`, { entryIds: [`${id}-e1`], lease });
check("erase with the lease", r.status === 200 && JSON.stringify(r.body.erased) === JSON.stringify([`${id}-e1`]), `${r.status} ${JSON.stringify(r.body)}`);
r = await req("GET", `/v1/sessions/${id}`);
const gone = r.body.entries?.[0] ?? {};
check("an erased entry is only id, parentId, kind, erased, and the identities it had", gone.erased === true && Object.keys(gone).sort().join() === "erased,id,kind,parentId,toolCallId,turnId" && gone.turnId === "t-1" && gone.toolCallId === "c-1" && !JSON.stringify(r.body).includes("secret 1"), JSON.stringify(gone));
r = await req("POST", `/v1/sessions/${id}/erase`, { entryIds: [`${id}-e1`], lease });
check("erasing again is harmless", r.status === 200, `${r.status}`);
r = await req("POST", `/v1/sessions/${id}/entries`, { lease, entries: [batch[0]] });
check("resending an erased entry's content is 409 conflict", r.status === 409 && r.body.code === "conflict", `${r.status} ${JSON.stringify(r.body)}`);
r = await req("POST", `/v1/sessions/${id}/entries`, { lease, entries: [{ parentId: null }] });
check("an entry without an id is 400 invalid_request", r.status === 400 && r.body.code === "invalid_request", `${r.status} ${JSON.stringify(r.body)}`);
r = await req("POST", `/v1/sessions/kit-${randomUUID()}/lease`, { owner: "kit-a" });
check("a lease on a session never PUT is 404 unknown_session", r.status === 404 && r.body.code === "unknown_session", `${r.status} ${JSON.stringify(r.body)}`);

r = await req("DELETE", `/v1/sessions/${id}/lease/${lease}`);
check("release the lease", r.status === 200, `${r.status}`);
r = await req("DELETE", `/v1/sessions/${id}/lease/${lease}`);
check("releasing twice is harmless", r.status === 200, `${r.status}`);
r = await req("POST", `/v1/sessions/${id}/lease/${lease}/renew`);
check("renewing a released lease is 409 lost", r.status === 409 && r.body.code === "lost", `${r.status} ${JSON.stringify(r.body)}`);
r = await req("POST", `/v1/sessions/${id}/lease`, { owner: "kit-b" });
check("another owner can take it once released", r.status === 200 && typeof r.body.lease === "string", `${r.status}`);
await req("DELETE", `/v1/sessions/${id}/lease/${r.body.lease}`);

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
