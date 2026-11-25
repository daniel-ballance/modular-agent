import { randomBytes } from "node:crypto";
import { held, lost } from "./history-binding.js";

const usPerMs = 1_000n;
const monotonicUs = () => process.hrtime.bigint() / 1_000n;
export type Lease = { token: string; until: BigInt64Array<SharedArrayBuffer> };

// The storage thread orders grants and releases with writes. Only the HTTP
// thread extends deadlines. CAS orders a renewal against expiry or release.
function update(lease: Lease, nowUs: () => bigint, ttl?: bigint): bigint {
	for (;;) {
		const until = Atomics.load(lease.until, 0);
		if (until === 0n) return 0n;
		const now = nowUs();
		const next = now >= until ? 0n : ttl === undefined ? until : now + ttl;
		if (Atomics.compareExchange(lease.until, 0, until, next) === until) return next;
	}
}

export class HistoryLeases {
	private leases = new Map<string, Lease & { owner: string }>();
	private ttl: bigint;
	constructor(ttlMs: number, private nowUs: () => bigint) { this.ttl = BigInt(ttlMs) * usPerMs; }
	current(id: string) {
		const lease = this.leases.get(id);
		if (!lease) return;
		const until = update(lease, this.nowUs);
		if (until === 0n) { this.leases.delete(id); return; }
		return { lease, remaining: Number(until - this.nowUs()) / Number(usPerMs) };
	}
	acquire(id: string, owner: string): Lease {
		const current = this.current(id);
		if (current) {
			if (current.lease.owner !== owner) throw held(performance.now() + current.remaining);
			return current.lease;
		}
		const until = new BigInt64Array(new SharedArrayBuffer(8));
		const token = randomBytes(16).toString("hex");
		Atomics.store(until, 0, this.nowUs() + this.ttl);
		this.leases.set(id, { owner, token, until });
		return { token, until };
	}
	require(id: string, token: string) {
		if (this.current(id)?.lease.token !== token) throw lost();
	}
	release(id: string, token: string) {
		const current = this.leases.get(id);
		if (current?.token !== token) return;
		Atomics.store(current.until, 0, 0n);
		this.leases.delete(id);
	}
}

export class RenewalLeases {
	private leases = new Map<string, Lease>();
	private ttl: bigint;
	constructor(ttlMs: number, private nowUs: () => bigint) { this.ttl = BigInt(ttlMs) * usPerMs; }
	grant(id: string, lease: Lease) { this.leases.set(id, lease); }
	release(id: string, token: string) { if (this.leases.get(id)?.token === token) this.leases.delete(id); }
	clear() { this.leases.clear(); }
	current(id: string) {
		const lease = this.leases.get(id);
		if (lease && update(lease, this.nowUs) === 0n) { this.leases.delete(id); return; }
		return lease;
	}
	renew(id: string, token: string) {
		const lease = this.current(id);
		return lease?.token === token && update(lease, this.nowUs, this.ttl) !== 0n;
	}
}

export function leaseClock(control?: BigInt64Array<SharedArrayBuffer>) {
	return control ? () => Atomics.load(control, 0) : monotonicUs;
}
