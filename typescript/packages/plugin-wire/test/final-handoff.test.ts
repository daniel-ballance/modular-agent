import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import type { PluginApi } from "@modular-agent/harness";
import { configureHostDelivery } from "../src/host-delivery.js";
import { socketWriter, streamWriter } from "../src/outbound.js";
import { WirePeer } from "../src/wire.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

for (const placement of ["stdio", "websocket"] as const) {
	test(`queued session frames are fenced before ${placement} handoff`, { timeout: 5000 }, async t => {
		for (const change of ["revoke", "lease loss", "erase"] as const) await t.test(change, async t => {
			const frames: string[] = [];
			const remote = new WirePeer(line => host.feed(line));
			const receive = (line: string) => { frames.push(line); remote.feed(line); };
			const stream = new PassThrough();
			stream.on("data", bytes => receive(bytes.toString()));
			let transport = streamWriter(stream);
			if (placement === "websocket") {
				const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
				await once(server, "listening");
				const addr = server.address();
				assert(addr && typeof addr !== "string");
				const connected = once(server, "connection");
				const client = new WebSocket(`ws://127.0.0.1:${addr.port}`);
				t.after(() => { client.terminate(); server.close(); });
				client.on("message", data => receive(data.toString() + "\n"));
				const [socket] = await connected as [WebSocket];
				transport = socketWriter(socket);
			}
			const first = deferred(), release = deferred(), prepared = deferred();
			let holding = true;
			const host = new WirePeer(async line => {
				await transport(line);
				if (holding) { holding = false; first.resolve(); await release.promise; }
			});
			let allowed = true, lease = true, erasure = 0;
			const api = {
				workActors: () => ["member"], workJobs: () => [], workMay: () => allowed,
				deliveryWitness: () => { const stamp = erasure; return async () => lease && erasure === stamp; },
			} as unknown as PluginApi;
			configureHostDelivery(host, api, new Map());
			host.handle("host/history", () => { prepared.resolve(); return { content: "private history" }; });
			host.notify("barrier");
			await first.promise;
			const params = { sessionId: "test-session" };
			const reply = remote.request("host/history", params);
			await prepared.promise;
			const request = host.request("tools/call", { ...params, input: "private tool input" });
			host.notify("host/emit", { ...params, content: "private event" });
			const refused = Promise.all([assert.rejects(reply, { code: "withheld" }), assert.rejects(request, { code: "withheld" })]);
			if (change === "revoke") allowed = false;
			else if (change === "lease loss") lease = false;
			else erasure++;
			release.resolve();
			await refused;
			assert.deepEqual(await host.request("$/ping"), {});
			assert.doesNotMatch(frames.join(""), /private|tools\/call|host\/emit/);
		});
	});
}
