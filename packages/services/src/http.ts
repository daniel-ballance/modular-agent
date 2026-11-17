import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A route answers a request. Throw an HttpError to answer with a status. */
export type Route = (req: IncomingMessage & { body?: any; query: URLSearchParams; params: string[] }, res: ServerResponse) => Promise<unknown> | unknown;

export class HttpError extends Error {
	constructor(readonly status: number, message: string, readonly details?: Record<string, unknown>) {
		super(message);
	}
}

/**
 * A small JSON service. Every request must carry the service's bearer token: each
 * service knows who may call it. A route returns a value to send as JSON, or
 * writes the response itself, for example to stream.
 */
export async function serve(routes: [method: string, pattern: RegExp, route: Route][], options: { port?: number; token: string }): Promise<{ server: Server; port: number; url: string }> {
	const server = createServer(async (req, res) => {
		try {
			if (req.headers.authorization !== `Bearer ${options.token}`) throw new HttpError(401, "A valid service token is required");
			const url = new URL(req.url ?? "/", "http://service");
			const found = routes.map(([m, p, r]) => ({ m, match: p.exec(url.pathname), r })).find((x) => x.m === req.method && x.match);
			if (!found) throw new HttpError(404, `No route for ${req.method} ${url.pathname}`);
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk as Buffer);
			const raw = Buffer.concat(chunks).toString("utf8");
			let body: unknown;
			try { body = raw ? JSON.parse(raw) : undefined; } catch { throw new HttpError(400, "Malformed JSON"); }
			const r = Object.assign(req, { body, query: url.searchParams, params: found.match!.slice(1).map(decodeURIComponent) });
			const result = await found.r(r, res);
			if (!res.headersSent) send(res, 200, result ?? {});
		} catch (error) {
			const status = error instanceof HttpError ? error.status : 500;
			const code = (error as { code?: unknown }).code;
			if (!res.headersSent) send(res, status, { error: error instanceof Error ? error.message : String(error), ...(typeof code === "string" ? { code } : status === 400 ? { code: "invalid_request" } : {}), ...(error instanceof HttpError ? error.details : {}) });
			else res.end();
		}
	});
	await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return { server, port, url: `http://127.0.0.1:${port}` };
}

export function send(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

/** Start a stream of JSON lines. */
export function ndjson(res: ServerResponse): (value: unknown) => void {
	res.writeHead(200, { "content-type": "application/x-ndjson" });
	return (value) => res.write(JSON.stringify(value) + "\n");
}

export interface ClientOptions { url: string; token: string }

/** A failure the service reported, as opposed to one on the way to it. */
export class ServiceError extends Error {
	constructor(readonly status: number, message: string, readonly code?: string, readonly retryAfterMs?: number) {
		super(message);
	}
}

/**
 * Call a service. With retry, a request that failed on the way (a refused
 * connection, a dropped response) is sent again, a few times, with a growing
 * wait. Only requests that are safe to send twice may set retry.
 */
export async function call<T>(client: ClientOptions, method: string, path: string, options: { body?: unknown; signal?: AbortSignal; retry?: boolean } = {}): Promise<T> {
	const waits = options.retry ? [50, 200, 500, 1000] : [];
	for (let attempt = 0; ; attempt++) {
		let res: Response;
		try {
			res = await fetch(client.url + path, {
				method,
				headers: { authorization: `Bearer ${client.token}`, ...(options.body !== undefined ? { "content-type": "application/json" } : {}) },
				body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
				signal: options.signal,
			});
			const text = await res.text();
			const body = text ? JSON.parse(text) : {};
			if (!res.ok) throw new ServiceError(res.status, body.error ?? res.statusText, body.code, body.retryAfterMs);
			return body as T;
		} catch (error) {
			if (error instanceof ServiceError || options.signal?.aborted || attempt >= waits.length) throw error;
			await new Promise((r) => setTimeout(r, waits[attempt]));
		}
	}
}

/** Call a service that answers with a stream of JSON lines, handing each line over as it arrives. */
export async function stream(client: ClientOptions, path: string, body: unknown, onLine: (value: any) => void, signal?: AbortSignal): Promise<void> {
	const res = await fetch(client.url + path, {
		method: "POST",
		headers: { authorization: `Bearer ${client.token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok || !res.body) {
		const text = await res.text();
		throw new ServiceError(res.status, (text && JSON.parse(text).error) || res.statusText);
	}
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
		buffer += decoder.decode(chunk, { stream: true });
		for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
			const line = buffer.slice(0, i);
			buffer = buffer.slice(i + 1);
			if (line.trim()) onLine(JSON.parse(line));
		}
	}
}
