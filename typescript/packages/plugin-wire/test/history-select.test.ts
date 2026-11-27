import assert from "node:assert/strict";
import { test } from "node:test";
import type { HistoryEntry, PluginApi } from "@modular-agent/harness";
import { registerExternalPlugin } from "../src/host.js";
import { WirePeer } from "../src/wire.js";

test("history selectors page the fresh authorized view with trace projection and tombstones", async () => {
	let fresh = true;
	const row = (id: string, props: Partial<HistoryEntry>): HistoryEntry => ({
		id, parentId: null, time: 0, sessionId: "session", writer: "fixture", kind: "fixture.custom", modelVisible: false, ...props,
	});
	const start = row("start", { kind: "turnStart", turnId: "origin", data: { traceContext: { traceparent: "private" } } });
	const unrelated = row("unrelated", { data: { turnId: "origin", toolCallId: "call" } });
	const trace = row("trace", { kind: "modular-agent.turnTrace", turnId: "origin", toolCallId: "call", data: { traceparent: "private" } });
	const tombstone = { id: "settled", parentId: "trace", erased: true, kind: "toolResult", turnId: "later", toolCallId: "call" } as HistoryEntry;
	const kept = [start, unrelated, trace, tombstone, row("tail", {})];
	let branch = kept.slice(0, 3);
	const api = {
		session(id: string) { if (id !== "session") throw Error("Session is closed"); },
		onJobCancel() {},
		workMay: () => true,
		deliveryWitness: (id: string) => async () => id === "session" && fresh,
		readHistory(_id: string, options: { all?: boolean }) {
			if (!fresh) throw Error("Pending-erasure registry unavailable");
			return options.all ? kept : branch;
		},
	} as unknown as PluginApi;
	const peers: WirePeer[] = [];
	const connect = async (accepted: boolean) => {
		const host = new WirePeer(line => queueMicrotask(() => plugin.feed(line)));
		const plugin = new WirePeer(line => queueMicrotask(() => host.feed(line)));
		peers.push(host, plugin);
		plugin.handle("plugin/initialize", p => {
			assert.equal(p.historySelect, 1);
			return { binding: p.binding, name: "selector", ...(accepted ? { historySelect: 1 } : {}) };
		});
		const registered = await registerExternalPlugin(host, { project: "/", home: "/" }, {}, async () => {});
		await registered.plugin.setup(api);
		return (params: object) => plugin.request("host/history", { sessionId: "session", ...params });
	};
	try {
		const selected = await connect(true);
		const fallback = await connect(false);
		const select = { turnId: "origin", toolCallIds: ["call"] };
		assert.deepEqual((await fallback({ all: true }) as { entries: HistoryEntry[] }).entries.map(e => e.id), kept.map(e => e.id));
		await assert.rejects(fallback({ select }), { code: "invalid_request" });
		const page = await selected({ all: true, select, limit: 1 });
		assert.deepEqual(page, { entries: [{ ...start, data: {} }], next: "start" });
		const { data: _trace, ...traceEnvelope } = trace;
		assert.deepEqual(await selected({ all: true, select, after: "start" }), { entries: [traceEnvelope, tombstone] });
		await assert.rejects(selected({ all: true, select, after: "unrelated" }), { code: "invalid_request" });
		const empty = { select: { turnId: "missing" } };
		assert.deepEqual(await selected(empty), { entries: [] });
		await assert.rejects(selected({ ...empty, sessionId: "unopened" }), { code: "invalid_request" });
		fresh = false;
		await assert.rejects(selected({ select, after: "start" }), { code: "internal" });
		await assert.rejects(selected(empty), { code: "internal" });
		fresh = true;
		branch = [unrelated];
		await assert.rejects(selected({ select, after: "start" }), { code: "invalid_request" });

		// An entry that fits alone can still overflow with its required cursor.
		const wide = row("wide", { turnId: "wide", data: { blob: "" } });
		wide.data = { blob: "x".repeat(4 * 1024 * 1024 - Buffer.byteLength(JSON.stringify({ entries: [wide] }))) };
		branch = [wide, row("later-match", { turnId: "wide" })];
		await assert.rejects(selected({ select: { turnId: "wide" } }), { code: "result_too_large" });
		branch.pop();
		assert.deepEqual(await selected({ select: { turnId: "wide" } }), { entries: [wide] });
	} finally {
		for (const peer of peers) peer.close();
	}
});
