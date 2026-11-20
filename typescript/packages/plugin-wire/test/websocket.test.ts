import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setDefaultCACertificates, getCACertificates } from "node:tls";
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { servePluginService } from "../src/serve.js";
import { MAX_MESSAGE, PLUGIN_BINDING, WirePeer } from "../src/wire.js";
import { connectWebSocket, PLUGIN_PROTOCOL, receiveMessages } from "../src/websocket.js";

async function fixture(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "plugin-websocket-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const token = randomBytes(32).toString("hex");
	const tokenFile = join(dir, "token");
	await writeFile(tokenFile, token + "\n", { mode: 0o600 });
	let started = 0, stopped = 0;
	const make = () => ({ name: "fixture", plugins: [{ name: "fixture", setup() { started++; }, stop() { stopped++; } }] });
	return { dir, token, tokenFile, make, counts: () => [started, stopped] };
}

function peerOf(socket: WebSocket) {
	const peer = new WirePeer(line => socket.send(line.slice(0, -1)), () => socket.close());
	receiveMessages(socket, bytes => peer.message(bytes));
	socket.once("close", () => peer.close());
	return peer;
}

async function refuse(url: string, protocol?: string, token?: string) {
	const socket = new WebSocket(url, protocol, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
	socket.on("error", () => {});
	return new Promise<number>((resolve, reject) => {
		socket.on("unexpected-response", (_, res) => { res.resume(); socket.terminate(); resolve(res.statusCode!); });
		socket.on("open", () => { socket.terminate(); reject(new Error("Unexpected upgrade")); });
	});
}

const init = (dir: string) => ({ binding: PLUGIN_BINDING, data: "modular-agent-data/1", project: dir, home: dir });

test("plugin service authenticates, isolates instances and closes only the instance on shutdown", async t => {
	const f = await fixture(t);
	await assert.rejects(servePluginService(f.make, { listen: "0.0.0.0:0", tokenFile: f.tokenFile }), /loopback/);
	const service = await servePluginService(f.make, { listen: "127.0.0.1:0", tokenFile: f.tokenFile });
	try {
		assert.notEqual(new URL(service.url).port, "0");
		assert.equal(await refuse(service.url, PLUGIN_PROTOCOL), 401);
		assert.equal(await refuse(service.url, PLUGIN_PROTOCOL, randomBytes(32).toString("hex")), 401);
		assert.equal(await refuse(service.url, undefined, f.token), 400);
		const first = await connectWebSocket(service.url, f.tokenFile, PLUGIN_PROTOCOL, 5_000);
		const second = await connectWebSocket(service.url, f.tokenFile, PLUGIN_PROTOCOL, 5_000);
		const a = peerOf(first), b = peerOf(second);
		const [registered] = await Promise.all([a.request("plugin/initialize", init(f.dir)), b.request("plugin/initialize", init(f.dir))]);
		assert.equal(registered.name, "fixture");
		const closed = once(first, "close");
		await a.request("plugin/shutdown", {});
		assert.equal((await closed)[0], 1000);
		assert.deepEqual(f.counts(), [2, 1]);
		assert.deepEqual(await b.request("$/ping", {}), {});
		const serviceClosed = once(second, "close");
		await service.close();
		assert.equal((await serviceClosed)[0], 1000);
		assert.deepEqual(f.counts(), [2, 2]);
	} finally { await service.close(); }
});

test("plugin service handles one complete text message and rejects binary and oversized frames", async t => {
	const f = await fixture(t);
	const service = await servePluginService(f.make, { listen: "127.0.0.1:0", tokenFile: f.tokenFile });
	try {
		const socket = await connectWebSocket(service.url, f.tokenFile, PLUGIN_PROTOCOL, 5_000);
		let reply = once(socket, "message");
		socket.send('{\n"jsonrpc":"2.0",\n"id":1,"method":"$/ping"\n}');
		assert.deepEqual(JSON.parse(String((await reply)[0])), { jsonrpc: "2.0", id: 1, result: {} });
		reply = once(socket, "message");
		socket.send('[{"jsonrpc":"2.0","id":2,"method":"$/ping"}]');
		assert.equal(JSON.parse(String((await reply)[0])).error.data.code, "invalid_request");
		const closed = once(socket, "close");
		socket.send(Buffer.from("{}"));
		assert.equal((await closed)[0], 1003);

		const large = await connectWebSocket(service.url, f.tokenFile, PLUGIN_PROTOCOL, 5_000);
		const largeClosed = once(large, "close");
		large.send(Buffer.alloc(MAX_MESSAGE + 1, 32), { binary: false });
		assert.equal((await largeClosed)[0], 1009);
	} finally { await service.close(); }
});

test("plugin service uses wss and the client verifies the certificate", async t => {
	const f = await fixture(t);
	const certFile = join(f.dir, "cert.pem"), keyFile = join(f.dir, "key.pem");
	execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
		"-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
	const service = await servePluginService(f.make, { listen: "127.0.0.1:0", tokenFile: f.tokenFile, tls: { certFile, keyFile } });
	const ca = getCACertificates("default");
	try {
		assert.equal(new URL(service.url).protocol, "wss:");
		await assert.rejects(connectWebSocket(service.url, f.tokenFile, PLUGIN_PROTOCOL, 5_000));
		setDefaultCACertificates([...ca, readFileSync(certFile, "utf8")]);
		const socket = await connectWebSocket(service.url, f.tokenFile, PLUGIN_PROTOCOL, 5_000);
		assert.equal((await peerOf(socket).request("plugin/initialize", init(f.dir))).name, "fixture");
	} finally { setDefaultCACertificates(ca); await service.close(); }
});
