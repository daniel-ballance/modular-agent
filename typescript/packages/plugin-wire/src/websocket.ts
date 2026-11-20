import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { isIP } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { MAX_MESSAGE } from "./wire.js";

export const PLUGIN_PROTOCOL = "modular-agent-plugin-1";
export const ACP_PROTOCOL = "modular-agent-acp-1";

export interface ListenOptions {
	listen: string;
	tls?: { certFile: string; keyFile: string };
}
export interface ServiceServer {
	readonly url: string;
	close(): Promise<void>;
}

function loopback(host: string): boolean {
	return host === "localhost" || host === "::1" || isIP(host) === 4 && host.startsWith("127.");
}
const hostOf = (url: URL) => url.hostname.replace(/^\[|\]$/g, "");
const digest = (text: string) => createHash("sha256").update(text).digest();

export function listenAddress({ listen, tls }: ListenOptions) {
	const scheme = tls ? "wss:" : "ws:";
	const raw = listen.includes("://") ? listen : `${scheme}//${listen}`;
	const url = new URL(raw);
	const port = /^[^/]+:\/\/(?:\[[^\]]+\]|[^/:?#]+):(\d+)(?:[/?#]|$)/.exec(raw)?.[1];
	if (url.protocol !== scheme || url.username || url.password || url.search || url.hash || port === undefined) {
		throw new Error("Expected HOST:PORT or a WebSocket listen URL matching the TLS options");
	}
	const host = hostOf(url);
	if (!tls && !loopback(host)) throw new Error("Plain WebSocket listeners must bind to loopback");
	return { url, port: Number(port), host: host === "localhost" ? "127.0.0.1" : host };
}

async function tokenFrom(file: string): Promise<string> {
	const fd = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = await fd.stat();
		if (!stat.isFile() || stat.mode & 0o077 || stat.size > 8192) throw new Error("Expected a regular, owner-only token file");
		const token = (await fd.readFile("utf8")).trim();
		// Entropy is an operator requirement; reject obviously too-short tokens and header delimiters.
		if (token.length < 16 || !/^[a-zA-Z0-9._~+/-]+=*$/.test(token)) throw new Error("Expected a bearer token with at least 128 bits of entropy");
		return token;
	} finally { await fd.close(); }
}

/** No redirects, no compression, and no authorization header on an unverified TLS connection. */
export async function connectWebSocket(url: string, tokenFile: string, protocol: string, controlMs: number): Promise<WebSocket> {
	const destination = new URL(url);
	if (!["ws:", "wss:"].includes(destination.protocol) || destination.username || destination.password || destination.hash) {
		throw new Error("Expected a ws: or wss: service URL without credentials or a fragment");
	}
	if (destination.protocol === "ws:") {
		if (!loopback(hostOf(destination))) throw new Error("Plain WebSocket destinations must be loopback");
		if (destination.hostname === "localhost") destination.hostname = "127.0.0.1";
	}
	const token = await tokenFrom(tokenFile);
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(destination, protocol, {
			headers: { Authorization: `Bearer ${token}` }, followRedirects: false, rejectUnauthorized: true,
			perMessageDeflate: false, maxPayload: MAX_MESSAGE, handshakeTimeout: controlMs,
		});
		ws.on("error", () => reject(new Error("Plugin WebSocket connection failed")));
		ws.once("open", () => resolve(ws));
	});
}

/** ws enforces UTF-8 and the whole-message cap before delivering a message. */
export function receiveMessages(ws: WebSocket, receive: (bytes: Buffer) => void): void {
	ws.binaryType = "nodebuffer";
	let rejected = false;
	ws.on("message", (data, binary) => {
		if (rejected || ws.readyState !== WebSocket.OPEN) return;
		if (binary) {
			rejected = true;
			ws.close(1003);
		} else receive(data as Buffer);
	});
}

export async function listenWebSocket<T>(options: ListenOptions, protocol: string,
	actors: readonly { tokenFile: string; value: T }[],
	connection: (ws: WebSocket, value: T, tokenKey: string) => Promise<void>,
): Promise<ServiceServer> {
	const { url, port, host } = listenAddress(options);
	const entries = await Promise.all(actors.map(async ({ tokenFile, value }) => ({ value, key: digest(`Bearer ${await tokenFrom(tokenFile)}`) })));
	if (!entries.length || new Set(entries.map(e => e.key.toString("hex"))).size !== entries.length) throw new Error("Expected distinct service tokens");
	const rejectHttp = (_: unknown, response: import("node:http").ServerResponse) => { response.writeHead(404).end(); };
	const server = options.tls ? httpsServer({ cert: await readFile(options.tls.certFile), key: await readFile(options.tls.keyFile) }, rejectHttp) : httpServer(rejectHttp);
	server.requestTimeout = 5_000;
	server.headersTimeout = 5_000;
	const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false,
		handleProtocols: offered => offered.has(protocol) ? protocol : false });
	const active = new Set<Promise<void>>();
	let stopping = false;
	server.on("upgrade", (request, socket, head) => {
		const presented = digest(request.headers.authorization ?? "");
		let selected: typeof entries[number] | undefined;
		for (const entry of entries) if (timingSafeEqual(presented, entry.key)) selected = entry;
		const refuse = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
		if (!selected) return refuse("401 Unauthorized");
		if (stopping) return refuse("503 Service Unavailable");
		const offered = request.headers["sec-websocket-protocol"];
		if (!offered?.split(",").some(p => p.trim() === protocol) || request.url !== url.pathname) return refuse("400 Bad Request");
		const { value, key } = selected;
		wss.handleUpgrade(request, socket, head, ws => {
			ws.on("error", () => {});
			const done = connection(ws, value, key.toString("hex")).catch(() => ws.close(1011));
			active.add(done);
			void done.then(() => active.delete(done));
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => { server.off("error", reject); resolve(); });
	});
	const bound = server.address();
	if (bound && typeof bound !== "string") url.port = String(bound.port);
	let closing: Promise<void> | undefined;
	return { url: url.href, close: () => closing ??= (async () => {
		stopping = true;
		const stopped = new Promise<void>(resolve => server.close(() => resolve()));
		const sockets = new Promise<void>(resolve => wss.close(() => resolve()));
		for (const ws of wss.clients) ws.close(1000);
		const timer = setTimeout(() => { for (const ws of wss.clients) ws.terminate(); }, 5_000);
		try { await Promise.all([stopped, sockets, ...active]); }
		finally { clearTimeout(timer); }
	})() };
}
