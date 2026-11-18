// Disposable history client and write-batch observation for the ACP kit.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value) => createHash("sha256").update(value).digest();

export function historyService(raw, tokenFile) {
	if (!raw || !tokenFile) throw new Error("set MODULAR_AGENT_HISTORY_URL and MODULAR_AGENT_HISTORY_TOKEN_FILE to disposable service settings");
	const url = new URL(raw);
	if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname.startsWith("127.") || url.hostname === "[::1]")))) throw new Error("use a disposable service with HTTPS or loopback HTTP");
	const token = readFileSync(tokenFile, "utf8").trim();
	const path = (id) => `/v1/sessions/${encodeURIComponent(id)}`;
	const request = (route, init = {}) => fetch(url.href.replace(/\/$/, "") + route, { ...init, redirect: "error", signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) } });
	return {
		async json(route, method = "GET", body) {
			const r = await request(route, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
			if (!r.ok) throw new Error(`History fixture ${method}: HTTP ${r.status}`);
			return r.json();
		},
		path,
		async pages(id) {
			const entries = [];
			for (let cursor, page = 0; page < 100; page++) {
				const r = await this.json(path(id) + (cursor ? `?after=${encodeURIComponent(cursor)}` : ""));
				entries.push(...r.entries);
				if (!r.next) return entries;
				if (cursor === r.next) throw new Error("history service repeated its cursor");
				cursor = r.next;
			}
			throw new Error("history fixture exceeded the page watchdog");
		},
		// Shared data: Job reports. Observe actual append boundaries, not just two adjacent records.
		async observe({ onRequest, beforeReply } = {}) {
			const batches = [];
			const server = createServer(async (req, res) => {
				try {
					if (!timingSafeEqual(digest(req.headers.authorization ?? ""), digest(`Bearer ${token}`))) return res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" }).end(JSON.stringify({ error: "Unauthorized", code: "unauthorized" }));
					onRequest?.({ method: req.method, path: req.url });
					const chunks = [];
					let size = 0;
					for await (const chunk of req) {
						size += chunk.length;
						if (size > 64 * 1024 * 1024) return res.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: "Too large", code: "request_too_large" }));
						chunks.push(chunk);
					}
					const body = chunks.length ? Buffer.concat(chunks) : undefined;
					const r = await request(req.url, { method: req.method, body });
					if (r.ok && req.method === "POST" && req.url.endsWith("/entries") && body) {
						const events = JSON.parse(body).entries.filter((e) => (e.kind === "jobEnded" && e.data?.report === true) || (e.kind === "inputAccepted" && e.data?.key?.startsWith("job:"))).map((e) => ({ kind: e.kind, jobId: e.jobId, key: e.data?.key }));
						if (events.length) batches.push(events);
					}
					const headers = Object.fromEntries(["content-type", "www-authenticate"].flatMap((k) => r.headers.has(k) ? [[k, r.headers.get(k)]] : []));
					const bytes = Buffer.from(await r.arrayBuffer());
					await beforeReply?.({ method: req.method, path: req.url, ok: r.ok });
					res.writeHead(r.status, headers).end(bytes);
				} catch { res.destroy(); }
			});
			await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
			return { url: `http://127.0.0.1:${server.address().port}`, batches, stop: () => server.close() };
		},
	};
}
