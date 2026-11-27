/**
 * One end of a modular-agent-plugin/1 connection: JSON-RPC 2.0, one message per
 * line, requests in both directions, `$/cancel` and `$/ping` (docs/bindings/plugin.md).
 */

import { carrier, conversation, currentSpan, readTrace, safeName, SpanKind, startOperation, type Operation, withTrace } from "@modular-agent/harness/telemetry";

const workMethod = (method: string) => !method.startsWith("$/") && !method.startsWith("plugin/") && method !== "host/problem";
const objectParams = (params: unknown): params is Record<string, unknown> => !!params && typeof params === "object" && !Array.isArray(params);

export function execTimeout(value: unknown): number | undefined {
	if (value === undefined) return;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new WireError("invalid_request", "timeoutMs must be a positive safe integer");
	return value;
}

export const PLUGIN_BINDING = "modular-agent-plugin/1";
/** The largest message either side sends or accepts. */
export const MAX_MESSAGE = 64 * 1024 * 1024;

export type ErrorCode = "withheld" | "invalid_request" | "not_found" | "unknown_handler" | "cancelled" | "not_supported" | "result_too_large" | "lost" | "internal" | "method_not_found" | "parse_error" | "turn_limit" | "busy";

/** An error as the binding carries it: a JSON-RPC error with `data.code`. */
export class WireError extends Error {
	constructor(readonly code: ErrorCode, message: string, readonly rpcCode = code === "invalid_request" ? -32602 : -32000, readonly data?: Record<string, unknown>) {
		super(message);
	}
}

/** A `not_found` from the other side, as this build's code expects a missing file: an error with code ENOENT. */
export function notFoundAsEnoent(error: unknown, path: string): unknown {
	if (error instanceof WireError && error.code === "not_found") return Object.assign(new Error(`ENOENT: no such file or directory, ${path}`), { code: "ENOENT", path });
	return error;
}

/** An edition 3 peer can report a missing optional method as JSON-RPC method-not-found. */
export function optionalMethod(error: unknown): never {
	if (error instanceof WireError && (error.code === "method_not_found" || error.rpcCode === -32601)) {
		throw new WireError("not_supported", error.message);
	}
	throw error;
}

export async function listDirectory(env: import("@modular-agent/harness").WorkingEnvironment, path: unknown) {
	if (!env.list) throw new WireError("not_supported", "This environment does not list directories");
	if (typeof path !== "string" || !path || path.includes("\0")) throw new WireError("invalid_request", "Invalid directory path");
	try { return { entries: await env.list(path) }; }
	catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT" || code === "not_found") throw new WireError("not_found", "Directory does not exist");
		if (code === "ENOTDIR" || code === "EACCES" || code === "EPERM" || code === "invalid_request") {
			throw new WireError("invalid_request", "Not an accessible directory");
		}
		if (code === "not_supported") throw new WireError("not_supported", "This environment does not list directories");
		throw error;
	}
}

import type { Delivery, WriteLine } from "./outbound.js";

type CaptureDelivery = (method: string, params: any) => Delivery | undefined;
type Incoming = { abort: AbortController; gate?: Delivery; settled: boolean };
const withheld = () => new WireError("withheld", "Plugin delivery is no longer available");

/** What handles one incoming request: its params, an abort signal for `$/cancel`, and the request's id. */
export type Handler = (params: any, ctx: { signal: AbortSignal; id: number | string; atReply(fence: (send: () => void) => Promise<void>): void }) => unknown | Promise<unknown>;
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
	private trace?: { name: string; callbackScope?: (params: any) => Operation | undefined };
	private sent = new Map<number | string, Operation>();
	private running = new Map<number | string, Incoming>();
	private outbound: (() => Promise<void>)[] = [];
	private writing = false;
	private captureRequest?: CaptureDelivery;
	private captureReply?: CaptureDelivery;
	private nextId = 1;
	private closedWith?: Error;
	private fragments: Buffer[] = [];
	private frameBytes = 0;
	private received = new Set<number | string>();

	constructor(private write: WriteLine, private onClose?: () => void,
		private afterReply?: (method: string) => void, private allowRequest?: (method: string) => boolean) {
		this.handle("$/ping", () => ({}));
		this.onNotification("$/cancel", p => {
			const request = this.running.get(p?.id);
			if (request && !request.settled) request.abort.abort();
		});
	}

	configureDelivery(request: CaptureDelivery, reply: CaptureDelivery): void {
		this.captureRequest = request;
		this.captureReply = reply;
	}

	private delivery(method: string, params: any, signal?: AbortSignal): Delivery | undefined {
		const parent = method === "tools/changed" ? undefined : this.running.get(params?.parentRequestId);
		const gate = parent?.gate ?? this.captureRequest?.(method, params);
		const settles = method === "host/runtime/record" || method === "host/runtime/hook" && params?.hook === "turn.end" || /^(host\/(history|session|declaration|tools\/list|env\/(read|list|exists)))$/.test(method);
		if (!parent && !gate && !signal) return;
		return async send => {
			const live = () => {
				if (signal?.aborted || !settles && parent?.abort.signal.aborted) throw new WireError("cancelled", "Cancelled before transport handoff");
				send();
			};
			if (gate) await gate(live); else live();
		};
	}

	configureTracing(name: string, callbackScope?: (params: any) => Operation | undefined): void {
		this.trace = { name, callbackScope };
	}

	requestTrace(id: number | string): Operation | undefined { return this.isWaiting(id) ? this.sent.get(id) : undefined; }

	private workSpan(method: string, params: unknown, kind: SpanKind, parent?: ReturnType<typeof readTrace> | null) {
		const p = objectParams(params) ? params : {};
		const turn = objectParams(p.turn) ? p.turn : {};
		const id = kind === SpanKind.SERVER && this.trace?.callbackScope ? undefined : safeName(p.sessionId ?? turn.sessionId);
		const span = startOperation("modular_agent.plugin.request", { ...(id ? conversation(id) : {}),
			"modular_agent.plugin.name": safeName(this.trace?.name), "modular_agent.plugin.method": method,
		}, { kind, parent });
		if (kind === SpanKind.CLIENT || !this.trace?.callbackScope) span.set("modular_agent.turn.id", safeName(turn.turnId));
		return span;
	}

	private paramsWithTrace(method: string, params: unknown): unknown {
		const traceContext = this.trace && workMethod(method) && method !== "host/credentials/read" ? carrier(currentSpan()) : undefined;
		if (!objectParams(params)) return params;
		if (!traceContext && !Object.hasOwn(params, "traceContext")) return params;
		const { traceContext: _discard, ...clean } = params;
		return traceContext ? { ...clean, traceContext } : clean;
	}

	private incoming<T>(method: string, params: any, work: (clean: any, parent: ReturnType<typeof readTrace> | null) => T): T {
		const tracked = workMethod(method) && method !== "host/credentials/read" ? this.trace?.callbackScope?.(params) : undefined;
		const received = this.trace && workMethod(method) && method !== "host/credentials/read" ? readTrace(params?.traceContext) : undefined;
		const clean = objectParams(params) && Object.hasOwn(params, "traceContext") ? (({ traceContext: _discard, ...rest }) => rest)(params) : params;
		const run = () => {
			const authorized = tracked ? currentSpan() : undefined;
			const parent = this.trace?.callbackScope ? (received && received.traceId === authorized?.traceId ? received : authorized) : received;
			return work(clean, parent ?? null);
		};
		return tracked ? tracked.run(run) : run();
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
		const span = this.trace && workMethod(method) ? this.workSpan(method, params, SpanKind.CLIENT) : undefined;
		const promise = new Promise<T>((resolve, reject) => {
			if (this.closedWith) return reject(this.closedWith);
			this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
			try {
				if (span) this.sent.set(id, span);
				const gate = this.delivery(method, params, signal);
				const send = () => void this.send({ jsonrpc: "2.0", id, method, params: this.paramsWithTrace(method, params) }, gate).catch(error => {
					const waiter = this.waiting.get(id);
					this.waiting.delete(id);
					waiter?.reject(error);
				});
				if (span) span.run(send); else send();
			} catch (error) {
				this.waiting.delete(id);
				reject(error);
			}
		}) as Promise<T> & { id: number };
		promise.id = id;
		const end = () => { this.sent.delete(id); span?.end(); };
		void promise.then(end, (error: WireError) => { if (error?.code !== "cancelled" && error?.code !== "busy") span?.fail("failed"); end(); });
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
		if (!this.closedWith) void this.send({ jsonrpc: "2.0", method, params: this.paramsWithTrace(method, params) },
			this.delivery(method, params)).catch(() => {});
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
		for (const c of this.running.values()) c.abort.abort();
		this.fragments = [];
		this.frameBytes = 0;
		this.onClose?.();
	}

	/** True only up to the moment the answer is received, even within one input chunk. */
	isWaiting(id: number | string): boolean {
		return this.waiting.has(id);
	}

	get closed(): boolean {
		return !!this.closedWith;
	}

	get pending(): boolean { return this.waiting.size > 0; }

	abortRunning(except?: number | string): void {
		for (const [id, controller] of this.running) if (id !== except) controller.abort.abort();
	}

	/** Receive exactly one WebSocket text message, including any embedded JSON whitespace. */
	message(bytes: Buffer): void {
		if (!this.closed && bytes.length <= MAX_MESSAGE) this.receive(bytes);
	}

	/** Feed raw bytes as they arrive. */
	feed(chunk: Buffer | string): void {
		const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		for (let from = 0; from < data.length && !this.closed;) {
			const newline = data.indexOf(10, from);
			const part = data.subarray(from, newline < 0 ? undefined : newline);
			this.frameBytes += part.length;
			if (this.frameBytes > MAX_MESSAGE + 1) return this.close("An oversized plugin frame");
			this.fragments.push(part);
			if (newline < 0) return;
			const raw = Buffer.concat(this.fragments, this.frameBytes);
			const line = raw.at(-1) === 13 ? raw.subarray(0, -1) : raw;
			this.fragments = [];
			this.frameBytes = 0;
			if (line.length > MAX_MESSAGE) return this.close("An oversized plugin frame");
			this.receive(line);
			from = newline + 1;
		}
	}

	private send(m: Message, gate?: Delivery): Promise<void> {
		if (this.closedWith) return Promise.reject(this.closedWith);
		let line = JSON.stringify(m);
		if (Buffer.byteLength(line) > MAX_MESSAGE) {
			if (m.id === undefined || !("result" in m || "error" in m)) throw new WireError("result_too_large", "The message is too large to send");
			const code = m.error?.data?.code ?? "result_too_large";
			line = JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: m.error?.code ?? -32000, message: code, data: { code } } });
			if (Buffer.byteLength(line) > MAX_MESSAGE) {
				this.close("Plugin response ID cannot fit the line limit");
				return Promise.reject(this.closedWith);
			}
		}
		return this.enqueue(line + "\n", gate);
	}

	private enqueue(line: string, gate?: Delivery): Promise<void> {
		return new Promise((resolve, reject) => {
			this.outbound.push(async () => {
				let written: Promise<void> | undefined;
				const send = () => {
					if (this.closedWith) throw this.closedWith;
					try {
						written = Promise.resolve(this.write(line)).then(() => {});
						void written.catch(() => this.close("Plugin transport write failed"));
					} catch (error) {
						this.close("Plugin transport write failed");
						throw error;
					}
				};
				try {
					if (this.closedWith) throw this.closedWith;
					if (gate) await gate(send); else send();
					if (!written) throw withheld();
					await written;
					resolve();
				} catch (error) { reject(error); }
			});
			if (!this.writing) {
				this.writing = true;
				queueMicrotask(async () => {
					for (let item; (item = this.outbound.shift());) await item();
					this.writing = false;
				});
			}
		});
	}

	private receive(line: Buffer): void {
		const validId = (id: unknown) => typeof id === "string" || typeof id === "number" && Number.isSafeInteger(id);
		const fail = (id: unknown, rpc: number, code: string) => {
			void this.enqueue(JSON.stringify({ jsonrpc: "2.0", id: validId(id) ? id : null, error: { code: rpc, message: code, data: { code } } }) + "\n").catch(() => {});
		};
		let m: Message;
		try {
			m = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(line));
		} catch {
			return fail(null, -32700, "parse_error");
		}
		if (!m || typeof m !== "object" || Array.isArray(m)) return fail(null, -32600, "invalid_request");
		const response = Object.hasOwn(m, "result") || Object.hasOwn(m, "error");
		if (response) {
			if (m.jsonrpc !== "2.0" || "method" in m || !validId(m.id) || !this.waiting.has(m.id!) ||
				(Object.hasOwn(m, "result") === Object.hasOwn(m, "error")) ||
				("error" in m && (!Number.isInteger(m.error?.code) || typeof m.error?.message !== "string"))) return this.close("Invalid or unsolicited plugin reply");
		} else if (m.jsonrpc !== "2.0" || typeof m.method !== "string" || ("id" in m && !validId(m.id))) {
			return fail(m.id, -32600, "invalid_request");
		}
		if (m.method !== undefined && m.id !== undefined) {
			if (this.received.has(m.id) || this.received.size >= 1_000_000) return this.close("Reused plugin request ID or exhausted connection budget");
			this.received.add(m.id);
			void this.serve(m);
			return;
		}
		if (m.method !== undefined) {
			try {
				const handler = this.notes.get(m.method);
				if (handler) this.incoming(m.method, m.params, (params, parent) => withTrace(parent ?? undefined, () => handler(params)));
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
			w.reject(new WireError(code, m.error.message, m.error.code, m.error.data));
		} else w.resolve(m.result ?? null);
	}

	private async serve(m: Message): Promise<void> {
		const handler = this.handlers.get(m.method!);
		if (!handler) {
			await this.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}`, data: { code: "method_not_found" } } }).catch(() => {});
			return;
		}
		const abort = new AbortController();
		const running: Incoming = { abort, settled: false };
		this.running.set(m.id!, running);
		try {
			await Promise.resolve();
			if (abort.signal.aborted) throw new WireError("cancelled", "Cancelled");
			if (this.allowRequest && !this.allowRequest(m.method!)) throw new WireError("invalid_request", "The plugin is not registered");
			let fence: Delivery | undefined;
			running.gate = this.captureReply?.(m.method!, m.params);
			await this.incoming(m.method!, m.params, (params, parent) => {
				const work = async () => {
					let result: unknown;
					try { result = await handler(params ?? {}, { signal: abort.signal, id: m.id!, atReply: guard => { fence = guard; } }); }
					finally { running.settled = true; }
					// Provider preparation supplies its own final check and orders it with erasure.
					await this.send({ jsonrpc: "2.0", id: m.id, result: result === undefined ? null : result }, fence ?? running.gate);
				};
				if (!this.trace || !workMethod(m.method!)) return withTrace(undefined, work);
				const span = this.workSpan(m.method!, params, SpanKind.SERVER, parent);
				return span.run(async () => {
					try { await work(); }
					catch (error) { if (!(error instanceof WireError) || !["cancelled", "busy", "invalid_request"].includes(error.code)) span.fail("failed"); throw error; }
					finally { span.end(); }
				});
			});
			if (!this.closed) this.afterReply?.(m.method!);
		} catch (error) {
			running.settled = true;
			const e = abort.signal.aborted && !(error instanceof WireError) ? new WireError("cancelled", "Cancelled") : error;
			const code = e instanceof WireError ? e.code : "internal";
			const errorReply = { code: e instanceof WireError ? e.rpcCode : -32000, message: e instanceof Error ? e.message : String(e), data: { ...(e instanceof WireError ? e.data : {}), code } };
			const reply = (error: Message["error"], gate?: Delivery) => this.send({ jsonrpc: "2.0", id: m.id, error }, gate);
			try { await reply(errorReply, running.gate); }
			catch {
				// Preserve an ordinary rejection's code, but never its message or data
				// when the work is now outside the delivery view.
				await reply({ code: errorReply.code, message: code, data: { code } }).catch(() => {});
			}
		} finally {
			this.running.delete(m.id!);
		}
	}
}
