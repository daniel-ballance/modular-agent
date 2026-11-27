import assert from "node:assert/strict";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { Writable } from "node:stream";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { socketWriter, streamWriter, type WriteLine } from "../src/outbound.js";
import { MAX_MESSAGE, OUTBOUND_BYTES, OUTBOUND_FRAMES, WirePeer } from "../src/wire.js";

for (const placement of ["stdio", "websocket"] as const) {
	test(`a stalled ${placement} writer closes at the outbound queue cap`, { timeout: 5000 }, async t => {
		// Hold the physical write callback, independent of OS socket/pipe sizes.
		let write: WriteLine, abort: () => void, closed: Promise<unknown>;
		if (placement === "stdio") {
			const output = new Writable({ write() {} });
			write = streamWriter(output);
			abort = () => { output.destroy(); };
			closed = once(output, "close");
		} else {
			const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
			await once(server, "listening");
			const address = server.address();
			assert(address && typeof address !== "string");
			const connected = once(server, "connection");
			const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
			t.after(() => { client.terminate(); server.close(); });
			await once(client, "open");
			const [socket, request] = await connected as [WebSocket, IncomingMessage];
			request.socket.cork();
			write = socketWriter(socket);
			abort = () => socket.terminate();
			closed = once(socket, "close");
		}
		let enter!: () => void;
		const entered = new Promise<void>(resolve => { enter = resolve; });
		let writes = 0;
		const peer = new WirePeer(line => { writes++; const sent = write(line); enter(); return sent; }, hard => {
			assert.equal(hard, true);
			abort();
		});
		const held = assert.rejects(peer.request("test/held"), { code: "lost" });
		await entered;
		const cancel = new AbortController();
		const queued = assert.rejects(peer.request("test/queued", {}, cancel.signal), { code: "lost" });
		for (let i = 1; i < OUTBOUND_FRAMES; i++) peer.notify("test/output");
		assert.equal(peer.closed, false);
		assert.equal(writes, 1);

		// Cancellation is the first frame over budget. It cannot wait for the writer.
		cancel.abort();
		assert.equal(peer.closed, true);
		assert.equal(peer.pending, false);
		await Promise.all([held, queued, closed]);
		await assert.rejects(peer.request("plugin/shutdown"), { code: "lost" });
		assert.equal(writes, 1);
	});
}

test("outbound bytes can fill before message slots", () => {
	const method = "test/large";
	const overhead = Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", method, params: "" }) + "\n");
	const payload = "é".repeat(Math.floor((MAX_MESSAGE - overhead) / 2)) + "a".repeat((MAX_MESSAGE - overhead) % 2);
	const peer = new WirePeer(() => assert.fail("closed queue must not write"));
	for (let bytes = 0; bytes < OUTBOUND_BYTES; bytes += MAX_MESSAGE) {
		peer.notify(method, payload);
		assert.equal(peer.closed, false);
	}
	peer.notify("test/one-more");
	assert.equal(peer.closed, true);
});
