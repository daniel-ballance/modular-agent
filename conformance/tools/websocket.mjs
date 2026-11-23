// Client-side helpers shared by the two kits. No npm dependency.
import { randomBytes, randomUUID } from "node:crypto";
import { openSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export const PLUGIN_PROTOCOL = "modular-agent-plugin-1";
export const ACP_PROTOCOL = "modular-agent-acp-1";
export const MESSAGE_CAP = 64 * 1024 * 1024;
export const CONTROL_MS = 5000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const isLoopback = (hostname) => hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
export function endpoint(value) {
	const url = new URL(value);
	if (!(["ws:", "wss:"].includes(url.protocol)) || url.username || url.password || url.hash) {
		throw new Error("expected a ws: or wss: URL without credentials or fragment");
	}
	if (url.protocol === "ws:" && !isLoopback(url.hostname)) throw new Error("plain ws: needs a numeric loopback address");
	if (url.protocol === "wss:" && process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("wss: requires TLS verification");
	return url;
}

export function readToken(file) {
	const fd = openSync(file, "r");
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || (stat.mode & 0o077)) throw new Error("token file must be a regular file with owner-only permissions");
		const token = readFileSync(fd, "utf8").trim();
		if (!/^[a-zA-Z0-9._~+/-]+=*$/.test(token)) throw new Error("token file must contain one bearer token");
		return token;
	} finally { closeSync(fd); }
}

// Parse only runner options, not the command after --. Return null for stdio.
export function websocketOptions(args) {
	const value = (key) => {
		const i = args.indexOf(key);
		if (i < 0) return;
		if (!args[i + 1] || args[i + 1].startsWith("--") || args.lastIndexOf(key) !== i) throw new Error(`${key} needs one value`);
		return args[i + 1];
	};
	const url = value("--connect"), file = value("--token-file");
	if (!url && !file) return null;
	if (!url || !file) throw new Error("--connect and --token-file must be used together");
	return { url: endpoint(url), token: readToken(file), tokenFile: file };
}

// Node's WebSocket API deliberately hides failed-upgrade HTTP status. Use an
// actual HTTP/1.1 Upgrade request for the negative probes and destroy any socket
// a nonconforming server upgrades. Never follow HTTP redirects with credentials.
export function upgradeStatus(url, protocol, token) {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		target.protocol = url.protocol === "wss:" ? "https:" : "http:";
		const req = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, { agent: false, headers: {
			Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
			"Sec-WebSocket-Key": randomBytes(16).toString("base64"),
			...(protocol ? { "Sec-WebSocket-Protocol": protocol } : {}),
			...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
		} });
		const timer = setTimeout(() => req.destroy(new Error("WebSocket upgrade probe timed out")), CONTROL_MS);
		req.once("error", (error) => { clearTimeout(timer); reject(error); });
		req.once("response", (response) => { clearTimeout(timer); resolve({ status: response.statusCode, upgraded: false }); response.destroy(); });
		req.once("upgrade", (response, socket) => { clearTimeout(timer); resolve({ status: response.statusCode, upgraded: true }); socket.destroy(); });
		req.end();
	});
}

export async function checkUpgrades({ url, protocol, token }, check, attempt) {
	for (const [label, offer, bearer, status] of [
		["without a token", protocol, undefined, 401],
		["with a wrong token", protocol, randomBytes(32).toString("hex"), 401],
		["without the subprotocol", undefined, token, undefined],
	]) await attempt(`WebSocket: upgrade ${label}`, async () => {
		const result = await upgradeStatus(url, offer, bearer);
		check(`WebSocket: upgrade ${label} is refused${status ? ` with HTTP ${status}` : ""}`,
			!result.upgraded && (status ? result.status === status : result.status !== 101), `HTTP ${result.status}`);
	});
}

// One text message per send. The callback sees a whole message, including any
// embedded whitespace. For the kits' normal traffic, keep track of unanswered
// work so silent connections can be probed without imposing a work deadline.
export function socketPeer({ url, protocol, token, startup }, onText = () => {}) {
	const outstanding = new Set();
	let socket, stopping = false, idleTimer, controlTimer, pingId, rejectedFrame = false;
	let settle;
	const closed = new Promise((resolve) => { settle = resolve; });
	const end = () => { stopping = true; socket?.close(); };
	const idle = () => {
		clearTimeout(idleTimer);
		if (outstanding.size && !pingId) idleTimer = setTimeout(() => {
			pingId = `kit-ping-${randomUUID()}`;
			if (socket.readyState !== WebSocket.OPEN) return;
			socket.send(JSON.stringify({ jsonrpc: "2.0", id: pingId, method: "$/ping", params: {} }));
			controlTimer = setTimeout(lose, CONTROL_MS);
		}, 30000);
	};
	const lose = () => {
		clearTimeout(idleTimer);
		clearTimeout(controlTimer);
		end();
		settle({ code: 1006, rejectedFrame });
	};
	let exited = false;
	void startup?.exited.then(() => { exited = true; });
	const dial = async () => {
		const deadline = performance.now() + (startup?.watchdog ?? CONTROL_MS);
		while (!stopping && !exited) {
			const ws = socket = new WebSocket(url, { protocols: [protocol], headers: { Authorization: `Bearer ${token}` } });
			const finish = new Promise((resolve) => ws.addEventListener("close", resolve, { once: true }));
			const opened = await new Promise((resolve) => {
				const timer = setTimeout(() => { ws.close(); resolve(false); }, Math.max(1, deadline - performance.now()));
				const done = (ok) => { clearTimeout(timer); resolve(ok); };
				ws.addEventListener("open", () => done(true), { once: true });
				ws.addEventListener("error", () => done(false), { once: true });
				void finish.then(() => done(false));
			});
			if (opened) {
				void finish.then((event) => {
					clearTimeout(idleTimer);
					clearTimeout(controlTimer);
					settle({ code: event.code, rejectedFrame });
				});
				if (ws.protocol !== protocol) {
					end();
					throw new Error("WebSocket server did not select the required subprotocol");
				}
				ws.addEventListener("message", ({ data }) => {
					if (typeof data !== "string" || Buffer.byteLength(data) > MESSAGE_CAP || data.startsWith("\uFEFF")) {
						rejectedFrame = true;
						lose();
						return;
					}
					let rpc;
					try { rpc = JSON.parse(data); } catch { /* the binding adapter handles malformed JSON */ }
					if (pingId && rpc?.id === pingId && !rpc.method) {
						if (!rpc.result || typeof rpc.result !== "object" || Array.isArray(rpc.result) || Object.keys(rpc.result).length || rpc.error) return lose();
						clearTimeout(controlTimer);
						pingId = undefined;
					} else {
						if (rpc && !rpc.method) outstanding.delete(rpc.id);
						onText(data, rpc);
					}
					idle();
				});
				return ws;
			}
			if (!startup || exited || performance.now() >= deadline) break;
			await sleep(50);
		}
		settle({ code: 1006 });
		throw new Error("WebSocket connection failed");
	};
	const ready = dial();
	// Some callers attach their handlers after constructing the peer.
	void ready.catch(() => settle({ code: 1006 }));
	return { ready, closed, end, send(data, rpc) {
		if (stopping || socket.readyState !== WebSocket.OPEN) return false;
		socket.send(data);
		if (rpc?.method && Object.hasOwn(rpc, "id")) {
			const wasIdle = !outstanding.size;
			outstanding.add(rpc.id);
			if (wasIdle) idle();
		}
		return true;
	} };
}
