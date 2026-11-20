#!/usr/bin/env node
// Disposable, loopback-only stdio adapter for the binding kits. Not a service host.
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { TextDecoder } from "node:util";
import { WebSocketServer } from "ws";
import { ACP_PROTOCOL, CONTROL_MS, MESSAGE_CAP, PLUGIN_PROTOCOL, endpoint, readToken } from "./websocket.mjs";

const args = process.argv.slice(2);
const dash = args.indexOf("--");
const options = args.slice(0, dash);
const command = args.slice(dash + 1);
const option = (name) => options[options.indexOf(name) + 1];
const get = (name) => options.includes(name) ? option(name) : undefined;
const digest = (s) => createHash("sha256").update(s).digest();
let url, protocol, auth, childEnv;
try {
	if (dash < 0 || !command.length || options.length % 2 || options.some((x, i) => !(i % 2) && !["--listen", "--token-file", "--binding", "--actor"].includes(x))) {
		throw new Error("Usage: ws-bridge.mjs --binding plugin|acp [--listen ws://127.0.0.1:PORT/PATH] [--token-file FILE] [--actor ID] -- <stdio command> [args...]");
	}
	const binding = get("--binding");
	protocol = { plugin: PLUGIN_PROTOCOL, acp: ACP_PROTOCOL }[binding];
	if (![PLUGIN_PROTOCOL, ACP_PROTOCOL].includes(protocol)) throw new Error("--binding must be plugin or acp");
	url = endpoint(get("--listen") ?? process.env.MODULAR_AGENT_CONFORMANCE_URL);
	if (url.protocol !== "ws:") throw new Error("bridge only supports loopback ws:");
	auth = digest(`Bearer ${readToken(get("--token-file") ?? process.env.MODULAR_AGENT_CONFORMANCE_TOKEN_FILE)}`);
	// One operator-configured token and, for ACP, one operator-configured fixture actor.
	childEnv = { ...process.env };
	delete childEnv.MODULAR_AGENT_ACTOR;
	delete childEnv.MODULAR_AGENT_CONFORMANCE_TOKEN_FILE;
	if (binding === "acp" && get("--actor")) childEnv.MODULAR_AGENT_ACTOR = get("--actor");
} catch (e) {
	console.error(e.message);
	process.exit(2);
}

const server = createServer((_, response) => { response.writeHead(404).end(); });
const wss = new WebSocketServer({ noServer: true, maxPayload: MESSAGE_CAP, handleProtocols: () => protocol });
const refuse = (socket, status) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
server.on("upgrade", (req, socket, head) => {
	if (!timingSafeEqual(digest(req.headers.authorization ?? ""), auth)) return refuse(socket, "401 Unauthorized");
	if (req.url !== url.pathname + url.search) return refuse(socket, "404 Not Found");
	if (!req.headers["sec-websocket-protocol"]?.split(",").map((part) => part.trim()).includes(protocol)) return refuse(socket, "400 Bad Request");
	wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encode = (m) => JSON.stringify({ jsonrpc: "2.0", ...m });
wss.on("connection", (ws) => {
	const child = spawn(command[0], command.slice(1), { env: childEnv, stdio: ["pipe", "pipe", "inherit"] });
	let stopped = false, shutdown, killTimer, badOutput = false;
	let parts = [], size = 0;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		child.stdin.end(); // Let the child apply its own stdio loss and containment rules.
		killTimer = setTimeout(() => { child.kill("SIGKILL"); ws.terminate(); }, CONTROL_MS).unref();
	};
	ws.on("close", stop);
	ws.on("error", stop); // ws sends 1009 (and 1007 for invalid UTF-8) itself.
	child.stdin.on("error", () => {});
	child.on("error", () => { ws.close(1011); stop(); });
	child.on("close", (code) => {
		clearTimeout(killTimer);
		ws.close(code === 0 && !badOutput ? 1000 : 1011);
	});
	ws.on("message", (data, binary) => {
		if (stopped) return;
		if (binary) { ws.close(1003); stop(); return; }
		let text = decoder.decode(data), rpc;
		try { rpc = JSON.parse(text); } catch { /* let the stdio peer report parse_error */ }
		if (protocol === ACP_PROTOCOL && rpc?.method === "$/ping" && Object.hasOwn(rpc, "id")) {
			// The network binding adds a liveness exchange that stdio ACP does not offer.
			ws.send(encode({ id: rpc.id, result: {} }));
			return;
		}
		if (protocol === PLUGIN_PROTOCOL && rpc?.method === "plugin/shutdown" && Object.hasOwn(rpc, "id")) shutdown = rpc.id;
		// A text message can be pretty-printed. Don't split it or reserialize it
		// (which would silently accept duplicate JSON keys).
		if (/[\r\n]/.test(text)) text = rpc === undefined ? "{" : text.replace(/[\r\n]/g, " ");
		if (!child.stdin.write(text + "\n")) {
			ws.pause();
			child.stdin.once("drain", () => ws.resume());
		}
	});
	child.stdout.on("data", (chunk) => {
		for (let start = 0; !stopped && start < chunk.length;) {
			const lf = chunk.indexOf(10, start);
			const part = chunk.subarray(start, lf < 0 ? chunk.length : lf);
			size += part.length;
			if (size > MESSAGE_CAP + 1) { badOutput = true; ws.close(1009); stop(); return; }
			if (part.length) parts.push(part);
			if (lf < 0) break;
			const line = Buffer.concat(parts, size);
			const bytes = line.at(-1) === 13 ? line.subarray(0, -1) : line;
			parts = []; size = 0; start = lf + 1;
			try {
				if (bytes.length > MESSAGE_CAP) { badOutput = true; ws.close(1009); stop(); return; }
				const text = decoder.decode(bytes);
				const rpc = JSON.parse(text);
				if (!rpc || typeof rpc !== "object" || Array.isArray(rpc)) throw new Error("expected an object");
				child.stdout.pause();
				ws.send(text, (error) => { if (error) stop(); else child.stdout.resume(); });
				if (shutdown !== undefined && rpc.id === shutdown && Object.hasOwn(rpc, "result") && !rpc.method) {
					ws.close(1000);
					stop();
				}
			} catch { badOutput = true; ws.close(1011); stop(); }
		}
	});
});
server.on("error", (error) => { console.error(`bridge listener: ${error.code ?? "failed"}`); process.exitCode = 1; });
server.listen(Number(url.port || 80), url.hostname.replace(/^\[|\]$/g, ""));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
	server.close();
	for (const ws of wss.clients) ws.terminate();
});
