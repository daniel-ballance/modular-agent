export interface ReservationCounts { inputs: number; calls: number; jobs: number }
export interface ReservationBounds extends ReservationCounts { bufferedBytes: number; storageBytes: number; controlBytes: number }
export interface ReservationLimits {
	session: ReservationBounds;
	tenant: ReservationBounds;
	agent: ReservationBounds;
	entryBytes: number;
	batchBytes: number;
	settlementBytes: number;
}
export type ReservationOptions = { [K in keyof ReservationLimits]?: Partial<ReservationLimits[K]> };
export type ReservationDeclaration = Record<"session" | "tenant" | "agent", ReservationCounts>;

const MiB = 1024 * 1024;
const defaults: ReservationLimits = {
	session: { inputs: 128, calls: 128, jobs: 64, bufferedBytes: 32 * MiB, storageBytes: 512 * MiB, controlBytes: MiB },
	tenant: { inputs: 512, calls: 512, jobs: 256, bufferedBytes: 128 * MiB, storageBytes: 2048 * MiB, controlBytes: 4 * MiB },
	agent: { inputs: 2048, calls: 2048, jobs: 1024, bufferedBytes: 512 * MiB, storageBytes: 8192 * MiB, controlBytes: 16 * MiB },
	entryBytes: 4 * MiB - 14, batchBytes: 64 * MiB - 4096,
	settlementBytes: 128 * 1024,
};
const scopes = ["session", "tenant", "agent"] as const;
const keys = ["inputs", "calls", "jobs", "bufferedBytes", "storageBytes"] as const;
type Usage = Omit<ReservationBounds, "controlBytes">;
const empty = (): Usage => ({ inputs: 0, calls: 0, jobs: 0, bufferedBytes: 0, storageBytes: 0 });
const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value);
export function reservationLimits(options: ReservationOptions = {}): ReservationLimits {
	if (!object(options) || Object.keys(options).some(k => !Object.hasOwn(defaults, k))) throw new Error("Invalid resource reservations");
	const out = structuredClone(defaults);
	for (const scope of scopes) {
		const bounds = options[scope];
		if (bounds === undefined) continue;
		if (!object(bounds) || Object.keys(bounds).some(k => !Object.hasOwn(defaults[scope], k))) throw new Error(`Invalid ${scope} reservation bounds`);
		Object.assign(out[scope], bounds);
	}
	for (const key of ["entryBytes", "batchBytes", "settlementBytes"] as const) {
		if (options[key] !== undefined) out[key] = options[key];
		if (!Number.isSafeInteger(out[key]) || out[key] <= 0) throw new Error(`Invalid ${key} reservation bound`);
	}
	for (const scope of scopes) {
		for (const key of [...keys, "controlBytes"] as const) {
			if (!Number.isSafeInteger(out[scope][key]) || out[scope][key] < 0) throw new Error(`Invalid ${scope}.${key} reservation bound`);
		}
		if (out[scope].controlBytes > out[scope].storageBytes) throw new Error(`Invalid ${scope} control headroom`);
	}
	if (out.settlementBytes < 4096 || out.entryBytes < out.settlementBytes || out.batchBytes < out.entryBytes ||
		out.entryBytes > defaults.entryBytes || out.batchBytes > defaults.batchBytes) throw new Error("Invalid storage and settlement sizes");
	return out;
}

export function resourceBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? "");
}

export function retainedHistoryBytes({ meta, entries }: { meta: unknown; entries: readonly unknown[] }): number {
	return entries.reduce<number>((total, entry) => total + resourceBytes(entry), resourceBytes(meta));
}

export interface ReservationOwner { id: string; tenant?: string }
type Charge = Partial<Usage>;
interface Account { tenant: string | null; usage: Usage; work: Map<string, Charge>; retained: number }

/** The check and the charge do not yield. All compositions of one serving Agent share this ledger. */
export class Reservations {
	private readonly sessions = new Map<string, Account>();
	private readonly tenants = new Map<string | null, Usage>();
	private readonly agent = empty();
	constructor(readonly limits: ReservationLimits) {}
	declaration(): ReservationDeclaration {
		const project = ({ inputs, calls, jobs }: ReservationCounts) => ({ inputs, calls, jobs });
		return { session: project(this.limits.session), tenant: project(this.limits.tenant), agent: project(this.limits.agent) };
	}
	private accounts(owner: ReservationOwner) {
		const tenant = owner.tenant ?? null;
		if (!this.sessions.has(owner.id)) this.sessions.set(owner.id, { tenant, usage: empty(), work: new Map(), retained: 0 });
		const session = this.sessions.get(owner.id)!;
		if (session.tenant !== tenant) throw new Error("Session changed tenant in the reservation ledger");
		if (!this.tenants.has(tenant)) this.tenants.set(tenant, empty());
		return { session, usage: [session.usage, this.tenants.get(tenant)!, this.agent] };
	}
	private adjust(accounts: Usage[], charge: Charge, direction: 1 | -1) {
		for (const usage of accounts) for (const key of keys) usage[key] += (charge[key] ?? 0) * direction;
	}
	reserve(owner: ReservationOwner, id: string, charge: Charge, rebuild = false): boolean {
		const { session, usage } = this.accounts(owner);
		if (session.work.has(id)) return true;
		if (!rebuild && scopes.some((scope, index) => keys.some(key => {
			const added = charge[key] ?? 0;
			const limit = this.limits[scope][key] - (key === "storageBytes" ? this.limits[scope].controlBytes : 0);
			return added !== 0 && usage[index][key] + added > limit;
		}))) return false;
		this.adjust(usage, charge, 1);
		session.work.set(id, charge);
		return true;
	}
	/** Update an obligation without leaving a gap in the synchronous ledger. */
	resize(owner: ReservationOwner, id: string, charge: Charge): boolean {
		const { session } = this.accounts(owner);
		const previous = session.work.get(id);
		if (!previous) return this.reserve(owner, id, charge);
		this.release(owner, id);
		if (this.reserve(owner, id, charge)) return true;
		this.reserve(owner, id, previous, true);
		return false;
	}

	/** Moving reserved write space to retained storage never needs another free slot. */
	write(owner: ReservationOwner, bytes: number, keys: string[], control: boolean): boolean {
		return this.writeBatch(owner, [{ bytes, keys, control }]);
	}

	/** An ordinary entry in a mixed batch cannot draw on its neighbor's reservation. */
	writeBatch(owner: ReservationOwner, records: { bytes: number; keys: string[]; control: boolean }[]): boolean {
		const { session, usage } = this.accounts(owner);
		const transfers = new Map<Charge, number>();
		let ordinary = 0, control = 0, retained = 0;
		for (const record of records) {
			let left = record.bytes;
			retained += left;
			for (const id of new Set(record.keys)) {
				const charge = session.work.get(id);
				if (!charge?.storageBytes || !left) continue;
				const already = transfers.get(charge) ?? 0;
				const used = Math.min(charge.storageBytes - already, left);
				transfers.set(charge, already + used);
				left -= used;
			}
			if (record.control) control += left; else ordinary += left;
		}
		if (scopes.some((scope, index) => {
			const stored = usage[index].storageBytes;
			const limit = this.limits[scope];
			return ordinary > 0 && stored + ordinary > limit.storageBytes - limit.controlBytes ||
				control > 0 && stored + ordinary + control > limit.storageBytes;
		})) return false;
		for (const [charge, used] of transfers) charge.storageBytes! -= used;
		this.adjust(usage, { storageBytes: ordinary + control }, 1);
		session.retained += retained;
		return true;
	}

	has(owner: ReservationOwner, id: string): boolean { return this.sessions.get(owner.id)?.work.has(id) ?? false; }
	release(owner: ReservationOwner, id: string) {
		if (!this.has(owner, id)) return;
		const { session, usage } = this.accounts(owner);
		this.adjust(usage, session.work.get(id)!, -1);
		session.work.delete(id);
	}
	transfer(owner: ReservationOwner, id: string, next: string, keep: Charge) {
		this.release(owner, id);
		this.reserve(owner, next, keep, true);
	}
	retain(owner: ReservationOwner, bytes: number, absolute = false) {
		const { session, usage } = this.accounts(owner);
		const delta = absolute ? bytes - session.retained : bytes;
		session.retained += delta;
		this.adjust(usage, { storageBytes: delta }, 1);
	}
	adopt(other: Reservations) {
		for (const [id, account] of other.sessions) {
			if (this.sessions.has(id)) continue;
			const owner = { id, tenant: account.tenant ?? undefined };
			this.retain(owner, account.retained);
			for (const [key, charge] of account.work) this.reserve(owner, key, charge, true);
		}
	}
}
