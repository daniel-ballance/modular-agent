/**
 * One end of a modular-agent-plugin/1 connection: JSON-RPC 2.0, one message per
 * line, requests in both directions, `$/cancel` and `$/ping` (docs/bindings/plugin.md).
 */

export const PLUGIN_BINDING = "modular-agent-plugin/1";
export const DATA_BINDING = "modular-agent-data/1";
/** The largest message either side sends or accepts. */
export const MAX_MESSAGE = 64 * 1024 * 1024;

export type ErrorCode = "invalid_request" | "not_found" | "unknown_handler" | "cancelled" | "not_supported" | "result_too_large" | "lost" | "internal";

/** An error as the binding carries it: a JSON-RPC error with `data.code`. */
export class WireError extends Error {
	constructor(readonly code: ErrorCode, message: string, readonly rpcCode = code === "invalid_request" ? -32602 : -32000) {
		super(message);
	}
}

/** A `not_found` from the other side, as this build's code expects a missing file: an error with code ENOENT. */
export function notFoundAsEnoent(error: unknown, path: string): unknown {
	if (error instanceof WireError && error.code === "not_found") return Object.assign(new Error(`ENOENT: no such file or directory, ${path}`), { code: "ENOENT", path });
	return error;
}

/** What handles one incoming request: its params, an abort signal for `$/cancel`, and the request's id. */
export type Handler = (params: any, ctx: { signal: AbortSignal; id: number | string }) => unknown | Promise<unknown>;
export type NoteHandler = (params: any) => void;

interface Message {
	jsonrpc: "2.0";
	id?: number | string;
	method?: string;
	params?: any;
	result?: unknown;
	error?: { code: number; message: string; data?: { code?: string } };
}

export class WirePeer {
	private handlers = new Map<string, Handler>();
	private notes = new Map<string, NoteHandler>();
	private waiting = new Map<number | string, { resolve(v: unknown): void; reject(e: Error): void }>();
	private running = new Map<number | string, AbortController>();
	private nextId = 1;
	private closedWith?: Error;
	private buffer = "";

	constructor(private write: (line: string) => void) {
		this.handle("$/ping", () => ({}));
		this.onNotification("$/cancel", (p) => this.running.get(p?.id)?.abort());
	}

	handle(method: string, handler: Handler): void {
		this.handlers.set(method, handler);
	}

	onNotification(method: string, handler: NoteHandler): void {
		this.notes.set(method, handler);
	}

	/** Send a request. The returned promise carries `id`, so the request can be cancelled or named as a parent. */
	request<T = any>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> & { id: number } {
		const id = this.nextId++;
		const promise = new Promise<T>((resolve, reject) => {
			if (this.closedWith) return reject(this.closedWith);
			this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
			try {
				this.send({ jsonrpc: "2.0", id, method, params });
			} catch (error) {
				this.waiting.delete(id);
				reject(error);
			}
		}) as Promise<T> & { id: number };
		promise.id = id;
		promise.catch(() => undefined);
		if (signal) {
			if (signal.aborted) this.cancel(id);
			else {
				const cancel = () => this.cancel(id);
				signal.addEventListener("abort", cancel, { once: true });
				const cleanup = () => signal.removeEventListener("abort", cancel);
				void promise.then(cleanup, cleanup);
			}
		}
		return promise;
	}

	notify(method: string, params?: unknown): void {
		if (!this.closedWith) this.send({ jsonrpc: "2.0", method, params });
	}

	cancel(id: number | string): void {
		if (this.waiting.has(id)) this.notify("$/cancel", { id });
	}

	/** The connection ended: everything still waiting fails as lost, and running work is cancelled. */
	close(reason = "the other side of the connection ended"): void {
		if (this.closedWith) return;
		this.closedWith = new WireError("lost", reason);
		for (const w of this.waiting.values()) w.reject(this.closedWith);
		this.waiting.clear();
		for (const c of this.running.values()) c.abort();
	}

	/** True only up to the moment the answer is received, even within one input chunk. */
	isWaiting(id: number | string): boolean {
		return this.waiting.has(id);
	}

	get closed(): boolean {
		return !!this.closedWith;
	}

	/** Feed raw bytes as they arrive. */
	feed(chunk: string): void {
		this.buffer += chunk;
		for (let i = this.buffer.indexOf("\n"); i >= 0; i = this.buffer.indexOf("\n")) {
			const line = this.buffer.slice(0, i);
			this.buffer = this.buffer.slice(i + 1);
			if (line.trim()) this.receive(line);
		}
		if (Buffer.byteLength(this.buffer) > MAX_MESSAGE) {
			this.buffer = "";
			this.close("a message was larger than the binding allows");
		}
	}

	private send(m: Message): void {
		let line = JSON.stringify(m);
		if (Buffer.byteLength(line) > MAX_MESSAGE) {
			if (m.id === undefined || !("result" in m)) throw new WireError("result_too_large", "The message is too large to send");
			line = JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "The result is too large to send", data: { code: "result_too_large" } } });
		}
		this.write(line + "\n");
	}

	private receive(line: string): void {
		if (Buffer.byteLength(line) > MAX_MESSAGE) return this.close("a message was larger than the binding allows");
		let m: Message;
		try {
			m = JSON.parse(line);
		} catch {
			return;
		}
		if (m.method !== undefined && m.id !== undefined) {
			void this.serve(m);
			return;
		}
		if (m.method !== undefined) {
			try {
				this.notes.get(m.method)?.(m.params);
			} catch {
				/* a notification has no answer to carry an error */
			}
			return;
		}
		const w = m.id !== undefined ? this.waiting.get(m.id) : undefined;
		if (!w) return;
		this.waiting.delete(m.id!);
		if (m.error) {
			const code = (m.error.data?.code ?? (m.error.code === -32601 ? "not_supported" : "internal")) as ErrorCode;
			w.reject(new WireError(code, m.error.message, m.error.code));
		} else w.resolve(m.result ?? null);
	}

	private async serve(m: Message): Promise<void> {
		const handler = this.handlers.get(m.method!);
		if (!handler) {
			this.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}`, data: { code: "not_supported" } } });
			return;
		}
		const abort = new AbortController();
		this.running.set(m.id!, abort);
		try {
			const result = await handler(m.params ?? {}, { signal: abort.signal, id: m.id! });
			this.send({ jsonrpc: "2.0", id: m.id, result: result === undefined ? null : result });
		} catch (error) {
			const e = abort.signal.aborted && !(error instanceof WireError) ? new WireError("cancelled", "Cancelled") : error;
			const code = e instanceof WireError ? e.code : "internal";
			this.send({ jsonrpc: "2.0", id: m.id, error: { code: e instanceof WireError ? e.rpcCode : -32000, message: e instanceof Error ? e.message : String(e), data: { code } } });
		} finally {
			this.running.delete(m.id!);
		}
	}
}
