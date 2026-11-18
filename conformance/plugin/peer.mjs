// Stdio peer for the kit's probe and jobs fixtures. See Plugin binding: Transport.
import { TextDecoder } from "node:util";

const CAP = 64 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const rpcId = (id) => typeof id === "string" || Number.isSafeInteger(id);
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const has = (x, k) => Object.hasOwn(x, k);
const errors = { parse_error: -32700, method_not_found: -32601, invalid_request: -32602 };
export function rpcError(code, message = code) {
	return { code: errors[code] ?? -32000, message, data: { code } };
}
export const outcome = (p) => p.then((result) => ({ result }), (error) => ({ error }));
export const codeOf = (e) => e?.data?.code;

export function serve(prefix, handler) {
	let nextId = 1;
	const pending = new Map(), live = new Map(), seen = new Set(), recent = [];
	let parts = [], size = 0;
	const close = () => process.exit(0);
	const send = (m) => {
		let frame = JSON.stringify({ jsonrpc: "2.0", ...m });
		if (Buffer.byteLength(frame) > CAP) {
			if (!has(m, "result") && !has(m, "error")) throw rpcError("internal", "oversize request");
			const error = has(m, "result") ? rpcError("result_too_large") : rpcError(codeOf(m.error));
			frame = JSON.stringify({ jsonrpc: "2.0", id: m.id, error });
		}
		process.stdout.write(frame + "\n");
	};
	const request = (method, params, signal) => {
		const id = `${prefix}-${nextId++}`;
		const promise = new Promise((resolve, reject) => {
			if (signal?.aborted) return reject(rpcError("cancelled"));
			const cancel = () => send({ method: "$/cancel", params: { id } });
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", cancel);
				pending.delete(id);
			};
			// A fixture watchdog, not a general work timeout. An unanswered callback loses the connection.
			const timer = setTimeout(close, 15000);
			pending.set(id, { resolve, reject, cleanup });
			signal?.addEventListener("abort", cancel, { once: true });
			send({ id, method, params });
		});
		return { id, promise, cancel: () => send({ method: "$/cancel", params: { id } }) };
	};
	const read = (line) => {
		let m;
		try { m = JSON.parse(decoder.decode(line)); }
		catch { send({ id: null, error: rpcError("parse_error") }); return; }
		if (object(m) && m.jsonrpc === "2.0" && typeof m.method === "string" && !has(m, "result") && !has(m, "error")) {
			if (!has(m, "id")) {
				if (m.method === "$/cancel") live.get(m.params?.id)?.abort();
				return;
			}
			if (!rpcId(m.id)) return send({ id: null, error: { ...rpcError("invalid_request"), code: -32600 } });
			if (seen.has(m.id)) return close();
			seen.add(m.id);
			const ctl = new AbortController();
			const deadline = () => setTimeout(close, 5000).unref();
			let timer;
			ctl.signal.addEventListener("abort", () => { timer = deadline(); }, { once: true });
			live.set(m.id, ctl);
			Promise.resolve().then(() => handler(m, {
				signal: ctl.signal,
				ask: (method, params) => request(method, params, ctl.signal).promise,
				request: (method, params) => request(method, params, ctl.signal),
				notify: (method, params) => { if (!ctl.signal.aborted) send({ method, params }); },
				recent,
			})).then(
				(result) => ctl.signal.aborted ? { error: rpcError("cancelled") } : { result },
				(error) => ({ error: ctl.signal.aborted ? rpcError("cancelled") : codeOf(error) ? error : rpcError("internal", error?.message) }),
			).then((reply) => {
				clearTimeout(timer);
				live.delete(m.id);
				recent.push(m.id);
				if (recent.length > 16) recent.shift();
				send({ id: m.id, ...reply });
			});
		} else if (object(m) && (has(m, "result") || has(m, "error"))) {
			const p = pending.get(m.id);
			if (!p || m.jsonrpc !== "2.0" || has(m, "result") === has(m, "error") || (has(m, "error") && (!object(m.error) || typeof codeOf(m.error) !== "string" || !Number.isInteger(m.error.code) || typeof m.error.message !== "string"))) return close();
			p.cleanup();
			if (m.error) p.reject(m.error);
			else p.resolve(m.result);
		} else send({ id: rpcId(m?.id) ? m.id : null, error: { ...rpcError("invalid_request"), code: -32600 } });
	};
	process.stdin.on("data", (chunk) => {
		for (let start = 0; start < chunk.length;) {
			const lf = chunk.indexOf(10, start);
			const part = chunk.subarray(start, lf < 0 ? chunk.length : lf);
			size += part.length;
			if (size > CAP + 1 || (size === CAP + 1 && (part.length ? part.at(-1) : parts.at(-1)?.at(-1)) !== 13)) return close();
			if (part.length) parts.push(part);
			if (lf < 0) break;
			const frame = Buffer.concat(parts, size);
			read(frame.at(-1) === 13 ? frame.subarray(0, -1) : frame);
			parts = [];
			size = 0;
			start = lf + 1;
		}
	});
	process.stdin.on("end", close);
	return { ask: (method, params) => request(method, params).promise };
}
