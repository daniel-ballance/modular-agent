/**
 * One end of a JSON-RPC 2.0 connection that can pass more than data. A function,
 * an object with methods, or an AbortSignal sent to the other side becomes a
 * handle there: calling it, or aborting it, comes back over the connection. An
 * object the other side sent us comes back to it as itself.
 *
 * Every call across the connection is asynchronous. That is the one thing a
 * plugin in another process can't hide.
 */

const REMOTE = Symbol("remote");
interface Mark { peer: Peer; id: number }
type Marked = { [REMOTE]?: Mark };

interface Message {
	jsonrpc: "2.0";
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { message: string; name?: string };
}

export type RootMethods = Record<string, (...args: any[]) => unknown>;

const isPlain = (v: object) => {
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
};

function methodNames(v: object): string[] {
	const names = new Set<string>();
	for (const [k, x] of Object.entries(v)) if (typeof x === "function") names.add(k);
	for (let p = Object.getPrototypeOf(v); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
		for (const k of Object.getOwnPropertyNames(p)) if (k !== "constructor" && typeof (v as Record<string, unknown>)[k] === "function") names.add(k);
	}
	return [...names];
}

export class Peer {
	private exported = new Map<number, unknown>();
	private exportIds = new WeakMap<object, number>();
	private nextExport = 1;
	private calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private nextCall = 1;
	private controllers = new Map<number, AbortController>();
	private signalIds = new WeakMap<AbortSignal, number>();
	private proxies = new Map<number, unknown>();
	private closedWith?: Error;

	constructor(
		private write: (line: string) => void,
		private root: RootMethods,
		/** Told when this side starts or stops waiting for answers, so it can keep its process alive only while it waits. */
		private onWaiting?: (waiting: boolean) => void,
	) {}

	/** Ask the other side to run one of its root methods, and wait for the answer. */
	request(method: string, ...args: unknown[]): Promise<unknown> {
		return this.send(method, this.toWire(args));
	}

	/** Tell the other side something. No answer comes back. */
	notify(method: string, ...args: unknown[]): void {
		if (this.closedWith) return;
		this.post({ jsonrpc: "2.0", method, params: this.toWire(args) });
	}

	/** The connection ended: every call still waiting fails. */
	close(reason: Error): void {
		this.closedWith = reason;
		for (const c of this.calls.values()) c.reject(reason);
		if (this.calls.size) this.onWaiting?.(false);
		this.calls.clear();
		for (const c of this.controllers.values()) c.abort();
	}

	receive(line: string): void {
		if (!line.trim()) return;
		const m = JSON.parse(line) as Message;
		if (m.method) {
			void this.handle(m);
			return;
		}
		const call = m.id === undefined ? undefined : this.calls.get(m.id);
		if (!call) return;
		this.calls.delete(m.id!);
		if (this.calls.size === 0) this.onWaiting?.(false);
		if (m.error) call.reject(Object.assign(new Error(m.error.message), { name: m.error.name ?? "Error" }));
		else call.resolve(this.fromWire(m.result));
	}

	private send(method: string, params: unknown): Promise<unknown> {
		if (this.closedWith) return Promise.reject(this.closedWith);
		const id = this.nextCall++;
		const answer = new Promise<unknown>((resolve, reject) => this.calls.set(id, { resolve, reject }));
		if (this.calls.size === 1) this.onWaiting?.(true);
		// Nobody may be waiting, for example on an event listener's answer: don't let that crash the process.
		answer.catch(() => undefined);
		this.post({ jsonrpc: "2.0", id, method, params });
		return answer;
	}

	// A closed connection may have no stream left to write to, so a late answer is dropped.
	private post(m: Message): void {
		if (this.closedWith) return;
		this.write(JSON.stringify(m));
	}

	private async handle(m: Message): Promise<void> {
		if (m.method === "$abort") {
			this.controllers.get((m.params as { id: number }).id)?.abort();
			return;
		}
		try {
			let result: unknown;
			if (m.method === "$call") {
				const p = m.params as { target: number; method?: string; args: unknown };
				const target = this.exported.get(p.target) as Record<string, (...a: unknown[]) => unknown> | ((...a: unknown[]) => unknown) | undefined;
				if (target === undefined) throw new Error(`No object ${p.target} on this side`);
				const args = this.fromWire(p.args) as unknown[];
				if (p.method) {
					const fn = (target as Record<string, (...a: unknown[]) => unknown>)[p.method];
					if (typeof fn !== "function") throw new Error(`No method ${p.method}`);
					result = await fn.apply(target, args);
				} else result = await (target as (...a: unknown[]) => unknown)(...args);
			} else {
				const fn = this.root[m.method!];
				if (!fn) throw new Error(`Unknown method ${m.method}`);
				result = await fn(...(this.fromWire(m.params) as unknown[]));
			}
			if (m.id !== undefined) this.post({ jsonrpc: "2.0", id: m.id, result: this.toWire(result) });
		} catch (error) {
			const e = error instanceof Error ? error : new Error(String(error));
			if (m.id !== undefined) this.post({ jsonrpc: "2.0", id: m.id, error: { message: e.message, name: e.name } });
		}
	}

	private exportValue(v: object): number {
		let id = this.exportIds.get(v);
		if (id === undefined) {
			id = this.nextExport++;
			this.exportIds.set(v, id);
			this.exported.set(id, v);
		}
		return id;
	}

	private own(v: unknown): number | undefined {
		const mark = (v as Marked | null)?.[REMOTE];
		return mark?.peer === this ? mark.id : undefined;
	}

	toWire(v: unknown): unknown {
		if (v === undefined) return { $u: 1 };
		if (v === null || typeof v !== "object" && typeof v !== "function") return v;
		const own = this.own(v);
		if (own !== undefined) return { $own: own };
		if (typeof v === "function") return { $fn: this.exportValue(v) };
		if (Array.isArray(v)) return v.map((x) => this.toWire(x));
		if (ArrayBuffer.isView(v)) return { $bytes: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") };
		if (v instanceof AbortSignal) return this.signal(v);
		if (v instanceof Error) return { $error: { message: v.message, name: v.name } };
		if (v instanceof Date) return v.toISOString();
		if (isPlain(v)) {
			const out: Record<string, unknown> = {};
			for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = this.toWire(x);
			return out;
		}
		// An object with methods: a handle, plus a copy of its data.
		const props: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) if (typeof x !== "function" && x !== undefined) props[k] = this.toWire(x);
		return { $obj: this.exportValue(v), props, methods: methodNames(v) };
	}

	private signal(s: AbortSignal): unknown {
		let id = this.signalIds.get(s);
		if (id === undefined) {
			id = this.nextExport++;
			this.signalIds.set(s, id);
			const sid = id;
			s.addEventListener("abort", () => this.notifyAbort(sid), { once: true });
		}
		return { $signal: id, aborted: s.aborted };
	}

	private notifyAbort(id: number): void {
		if (!this.closedWith) this.post({ jsonrpc: "2.0", method: "$abort", params: { id } });
	}

	fromWire(v: unknown): unknown {
		if (v === null || typeof v !== "object") return v;
		if (Array.isArray(v)) return v.map((x) => this.fromWire(x));
		const o = v as Record<string, unknown>;
		if ("$u" in o) return undefined;
		if ("$own" in o) return this.exported.get(o.$own as number);
		if ("$fn" in o) return this.proxy(o.$fn as number, () => this.remoteFunction(o.$fn as number));
		if ("$obj" in o) return this.proxy(o.$obj as number, () => this.remoteObject(o.$obj as number, o.props as Record<string, unknown>, o.methods as string[]));
		if ("$signal" in o) {
			const id = o.$signal as number;
			let c = this.controllers.get(id);
			if (!c) {
				c = new AbortController();
				this.controllers.set(id, c);
			}
			if (o.aborted) c.abort();
			return c.signal;
		}
		if ("$bytes" in o) return Buffer.from(o.$bytes as string, "base64");
		if ("$error" in o) {
			const e = o.$error as { message: string; name?: string };
			return Object.assign(new Error(e.message), { name: e.name ?? "Error" });
		}
		const out: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(o)) out[k] = this.fromWire(x);
		return out;
	}

	private proxy(id: number, make: () => unknown): unknown {
		let p = this.proxies.get(id);
		if (!p) {
			p = make();
			Object.defineProperty(p, REMOTE, { value: { peer: this, id } satisfies Mark });
			this.proxies.set(id, p);
		}
		return p;
	}

	private remoteFunction(id: number): (...args: unknown[]) => Promise<unknown> {
		return (...args) => this.send("$call", { target: id, args: this.toWire(args) });
	}

	private remoteObject(id: number, props: Record<string, unknown>, methods: string[]): unknown {
		const o = (this.fromWire(props) ?? {}) as Record<string, unknown>;
		for (const name of methods) o[name] = (...args: unknown[]) => this.send("$call", { target: id, method: name, args: this.toWire(args) });
		return o;
	}
}

/** Read newline-delimited messages from a stream. */
export function lines(stream: NodeJS.ReadableStream, onLine: (line: string) => void, onEnd: () => void): void {
	let buffer = "";
	stream.setEncoding?.("utf8");
	stream.on("data", (chunk: string) => {
		buffer += chunk;
		for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
			onLine(buffer.slice(0, i));
			buffer = buffer.slice(i + 1);
		}
	});
	stream.on("end", onEnd);
	stream.on("close", onEnd);
}
