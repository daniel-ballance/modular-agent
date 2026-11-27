// Disposable history client and write-batch observation for the ACP kit.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

const digest = (value) => createHash("sha256").update(value).digest();

function heldRetryAfter(bytes) {
	try {
		const { code, retryAfterMs } = JSON.parse(bytes);
		if (code === "held" && Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0) return retryAfterMs;
	} catch { return undefined; }
}

export function historyService(raw, tokenFile) {
	if (!raw || !tokenFile) throw new Error("set MODULAR_AGENT_HISTORY_URL and MODULAR_AGENT_HISTORY_TOKEN_FILE to disposable service settings");
	const url = new URL(raw);
	if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname.startsWith("127.") || url.hostname === "[::1]")))) throw new Error("use a disposable service with HTTPS or loopback HTTP");
	const token = readFileSync(tokenFile, "utf8").trim();
	const path = (id) => `/v1/sessions/${encodeURIComponent(id)}`;
	const request = (route, init = {}) => fetch(url.href.replace(/\/$/, "") + route, { ...init, redirect: "error", signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
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
		async grantRecordedActor(id, granter, actor) {
			const base = path(id), writer = randomUUID();
			const { lease } = await this.json(base + "/lease", "POST", { owner: writer });
			try {
				const last = (await this.pages(id)).at(-1);
				if (!last) throw Error("cannot grant membership in an empty fixture");
				const parentId = last.kind === "position" ? last.data.to : last.id;
				await this.json(base + "/entries", "POST", { lease, entries: [{
					id: randomUUID(), sessionId: id, parentId, time: Date.now(), writer, modelVisible: false,
					kind: "actorJoined", actorId: granter, data: { actor },
				}] });
			} finally { await this.json(base + "/lease/" + encodeURIComponent(lease), "DELETE"); }
		},
		// Shared data: Job reports. Observe actual append boundaries, not just two adjacent records.
		async observe({ onRequest, beforeReply, fixtureReply, onTrace } = {}) {
			const batches = [];
			const server = createServer(async (req, res) => {
				const info = { method: req.method, path: req.url };
				const trace = onTrace && { ...info, start: performance.now(), upstreamStatus: null,
					upstreamMs: null, replyMs: null, sent: false };
				if (trace) {
					onTrace(trace);
					res.once("finish", () => {
						trace.replyMs = performance.now() - trace.start;
						trace.sent = true;
					});
					res.once("close", () => { trace.replyMs ??= performance.now() - trace.start; });
				}
				try {
					if (!timingSafeEqual(digest(req.headers.authorization ?? ""), digest(`Bearer ${token}`))) return res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" }).end(JSON.stringify({ error: "Unauthorized", code: "unauthorized" }));
					onRequest?.(info);
					const chunks = [];
					let size = 0;
					for await (const chunk of req) {
						size += chunk.length;
						if (size > 64 * 1024 * 1024) return res.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: "Too large", code: "request_too_large" }));
						chunks.push(chunk);
					}
					const body = chunks.length ? Buffer.concat(chunks) : undefined;
					const fixture = fixtureReply?.(info);
					if (fixture) return res.writeHead(fixture.status, { "content-type": "application/json" }).end(JSON.stringify(fixture.body));
					// Pass the pending-erasure profile's revision through unchanged, so appends stay fenced (history-http.md).
					const revision = req.headers["history-revision"];
					const r = await request(req.url, { method: req.method, body, ...(revision === undefined ? {} : { headers: { "history-revision": revision } }) });
					if (trace) trace.upstreamStatus = r.status;
					const entries = r.ok && req.method === "POST" && req.url.endsWith("/entries") && body ? JSON.parse(body).entries : undefined;
					if (entries) {
						const events = entries.filter((e) => (e.kind === "jobEnded" && e.data?.report === true) || (e.kind === "inputAccepted" && e.data?.key?.startsWith("job:"))).map((e) => ({ kind: e.kind, jobId: e.jobId, key: e.data?.key }));
						if (events.length) batches.push(events);
					}
					const headers = Object.fromEntries(["content-type", "www-authenticate", "cache-control"].flatMap((k) => r.headers.has(k) ? [[k, r.headers.get(k)]] : []));
					const bytes = Buffer.from(await r.arrayBuffer());
					if (trace) {
						trace.upstreamMs = performance.now() - trace.start;
						if (r.status === 409 && req.method === "POST" && req.url.endsWith("/lease")) {
							trace.retryAfterMs = heldRetryAfter(bytes);
						}
					}
					await beforeReply?.({ method: req.method, path: req.url, ok: r.ok, entries,
						lease: r.ok && req.method === "POST" && req.url.endsWith("/lease") ? JSON.parse(bytes).lease : undefined });
					res.writeHead(r.status, headers).end(bytes);
				} catch { res.destroy(); }
			});
			await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
			return { url: `http://127.0.0.1:${server.address().port}`, batches, stop: () => server.close() };
		},
	};
}
