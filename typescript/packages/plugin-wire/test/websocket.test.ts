import assert from "node:assert/strict";
import { Harness, type WorkingEnvironment } from "@modular-agent/harness";
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
import { connectWebSocket, listenWebSocket, PLUGIN_PROTOCOL, receiveMessages } from "../src/websocket.js";
import { startPluginService } from "../src/host.js";
import { localEnvironment } from "@modular-agent/env-local";

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

test("client pings only while work is pending and a missed ping loses the connection", async t => {
	const f = await fixture(t);
	let pinged = 0;
	const service = await listenWebSocket({ listen: "127.0.0.1:0" }, PLUGIN_PROTOCOL, [{ tokenFile: f.tokenFile, value: null }],
		(socket) => new Promise<void>(resolve => {
			socket.once("close", resolve);
			receiveMessages(socket, bytes => {
				const msg = JSON.parse(bytes.toString());
				if (msg.method === "plugin/initialize") socket.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id,
					result: { name: "silent", binding: PLUGIN_BINDING, workingEnvironment: { containment: "none" } } }));
				if (msg.method === "$/ping") pinged++;
			});
		}));
	try {
		const info = { project: f.dir, home: f.dir };
		const external = await startPluginService({ url: service.url, tokenFile: f.tokenFile, pingIntervalMs: 10, controlTimeoutMs: 500 }, info);
		const harness = new Harness(info);
		try {
			await harness.load([external.plugin]);
			const env = harness.use<WorkingEnvironment>("working-environment")!;
			await assert.rejects(env.exists("pending"), { code: "lost", message: "Plugin ping deadline expired" });
			assert.equal(pinged, 1);
		} finally { await external.stop(); }
	} finally { await service.close(); }
});

test("a remote diagnostic passes through the reporting plugin's output gate", { timeout: 5000 }, async t => {
	const f = await fixture(t);
	let report!: () => void;
	const service = await servePluginService(() => ({ name: "reporter", plugins: [{ name: "reporter", setup(api) {
		report = () => api.reportProblem("test", new Error("original"));
		api.on("output", ({ events }: { events: { type: string; data: { error: string } }[] }) => ({
			action: "pass", events: events.map(event => event.type === "plugin.problem"
				? { ...event, data: { ...event.data, error: "gated" } } : event),
		}));
	} }] }), { listen: "127.0.0.1:0", tokenFile: f.tokenFile });
	try {
		const info = { project: f.dir, home: f.dir };
		const external = await startPluginService({ url: service.url, tokenFile: f.tokenFile }, info);
		const harness = new Harness(info);
		try {
			let deliver!: (data: unknown) => void;
			const delivered = new Promise<unknown>(resolve => { deliver = resolve; });
			await harness.load([external.plugin, { name: "diagnostics", setup(api) {
				api.onEvent(event => {
					if (event.type === "plugin.problem" && event.data.where === "test") deliver(event.data);
				});
			} }]);
			report();
			assert.deepEqual(await delivered, { plugin: "reporter", where: "test", error: "gated" });
		} finally { await harness.stop(); }
	} finally { await service.close(); }
});

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

test("a served command works in its session's project, which it learns from host/session", async t => {
	const f = await fixture(t);
	const other = await mkdtemp(join(tmpdir(), "plugin-session-project-"));
	t.after(() => rm(other, { recursive: true, force: true }));
	await writeFile(join(f.dir, "where.txt"), "the project given at plugin/initialize");
	await writeFile(join(other, "where.txt"), "the session's project");
	const make = () => ({ name: "where", plugins: [{ name: "where", setup(api: any) {
		api.registerCommand("where", { description: "Read where.txt", async run(_: string, cx: any) { return String(await (await cx.environment()).readFile("where.txt")); } });
	} }] });
	const service = await servePluginService(make, { listen: "127.0.0.1:0", tokenFile: f.tokenFile });
	try {
		const info = { project: f.dir, home: f.dir };
		const external = await startPluginService({ url: service.url, tokenFile: f.tokenFile }, info);
		const harness = new Harness(info);
		try {
			await harness.load([localEnvironment({ cwd: f.dir }), external.plugin]);
			const api = harness.api("test");
			const sessionId = await api.startSession({ settings: { cwd: other } });
			assert.equal(await api.runCommand(sessionId, "/where", "user"), "the session's project");
		} finally { await external.stop(); await harness.stop(); }
	} finally { await service.close(); }
});
