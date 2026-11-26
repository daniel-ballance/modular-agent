// A leased history request under a slow service (#153): the request's deadline follows the
// lease, so a commit slower than half a TTL succeeds while renewals keep the lease, and a
// request that fails on the way reports a binding code rather than a bare timeout.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type { HistoryEntry } from "@modular-agent/harness";
import { HttpHistoryStore } from "@modular-agent/services";

const ttlMs = 600; // The writer renews about every 190 ms and loses the lease about 290 ms after a renewal is sent.
const token = "lease-deadline-token";
const sid = "slow-session";
const entry = (id: string, kind: string, parentId: string | null): HistoryEntry =>
	({ id, parentId, sessionId: sid, kind, time: 0, writer: "harness", modelVisible: false, data: { key: id } }) as unknown as HistoryEntry;

type Behaviour = { commitMs?: number; renew?: "answer" | "hang"; read?: "answer" | "drop"; commit?: "answer" | "drop"; pendingErasure?: true };

async function fakeService(t: TestContext, behaviour: Behaviour) {
	const seen = { commits: 0, renewals: 0 };
	const hung: ServerResponse[] = [];
	const reply = (res: ServerResponse, body: unknown, status = 200) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		req.resume();
		req.on("end", () => {
			const path = req.url ?? "";
			if (path === "/v1") return reply(res, { binding: "modular-agent-history/1", ttlMs, ...(behaviour.pendingErasure && { pendingErasure: 1 }) });
			if (path.includes("/pending-erasure")) return reply(res, { revision: "revision-1", plans: [] });
			if (req.method === "PUT") return reply(res, {});
			if (path.endsWith("/lease")) return reply(res, { lease: "lease-1", ttlMs });
			if (path.endsWith("/renew")) {
				seen.renewals++;
				if (behaviour.renew === "hang") { hung.push(res); return; }
				return reply(res, { ttlMs });
			}
			if (path.endsWith("/entries")) {
				seen.commits++;
				if (behaviour.commit === "drop") { res.destroy(); return; }
				setTimeout(() => { if (!res.destroyed) reply(res, {}); }, behaviour.commitMs ?? 0);
				return;
			}
			if (req.method === "DELETE") return reply(res, {});
			if (req.method === "GET" && behaviour.read === "drop") { res.destroy(); return; }
			reply(res, { session: { id: sid, created: 0, project: "/project" }, entries: [] });
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>(resolve => {
		for (const res of hung) res.destroy();
		server.closeAllConnections();
		server.close(() => resolve());
	}));
	const store = new HttpHistoryStore({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token });
	await store.initialize();
	return { store, seen };
}

/** Publish the session, which takes its lease, then commit one more entry. */
async function publishAndCommit(store: HttpHistoryStore) {
	await store.create({ id: sid, created: 0, project: "/project" });
	await store.append(sid, [entry("admitted", "inputAccepted", null)]);
	return store.append(sid, [entry("next", "message", "admitted")]);
}

test("a leased commit slower than half a TTL succeeds while renewals keep the lease", async t => {
	const { store, seen } = await fakeService(t, { commitMs: 3 * ttlMs / 2 });
	try {
		await publishAndCommit(store);
		assert.equal(seen.commits, 2, "each commit is sent once, not aborted and repeated at a superseded cutoff");
		assert.ok(seen.renewals >= 3, `renewals continued during the commit (${seen.renewals})`);
		store.checkWriter(sid);
	} finally { await store.close(sid); }
});

test("a leased commit whose renewal misses the cutoff fails as lost writer access", async t => {
	const { store } = await fakeService(t, { commitMs: 10 * ttlMs, renew: "hang" });
	try {
		const started = performance.now();
		await assert.rejects(publishAndCommit(store), (error: { code?: unknown }) => error.code === "lost");
		const elapsed = performance.now() - started;
		assert.ok(elapsed < 2 * ttlMs, `the commit ends when the lease is lost, not at the commit's reply (${Math.round(elapsed)} ms)`);
	} finally { await store.close(sid); }
});

test("a history read that fails on the way is reported as unavailable", async t => {
	const { store } = await fakeService(t, { read: "drop" });
	await assert.rejects(store.load(sid), (error: { code?: unknown; message?: string }) =>
		error.code === "unavailable" && /History service request failed/.test(error.message ?? ""));
});

test("a guarded append whose reconciliation read fails reports lost writer access, with the read failure as its cause", async t => {
	const { store, seen } = await fakeService(t, { pendingErasure: true, commit: "drop", read: "drop" });
	try {
		await assert.rejects(publishAndCommit(store), (error: { code?: unknown; cause?: { code?: unknown } }) =>
			error.code === "lost" && error.cause?.code === "unavailable");
		assert.ok(seen.renewals >= 1, "renewals continued, so only the failed reconciliation ended writer access");
		assert.throws(() => store.checkWriter(sid), (error: { code?: unknown }) => error.code === "lost");
	} finally { await store.close(sid); }
});
