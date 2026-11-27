import { isDeepStrictEqual } from "node:util";
import { memoryPendingErasure, type ErasureIntent, type ErasurePlan, type HistoryErasureRegistry, type PendingErasure } from "./erasure.js";
import { failure } from "./failure.js";
import type { ErasureReport } from "./plugin-api.js";
import { handoffRecords } from "./interface-tools.js";
import { retainedHistoryBytes, type Reservations } from "./reservations.js";
import type { RunReceipts } from "./run-receipts.js";
import { inputIdOf, type Session } from "./session.js";
import { isToolCall, type AgentEvent, type Authority, type EntryDraft, type HistoryEntry, type HistoryStore, type StoredSession, type Provider } from "./types.js";

interface ErasureOperations {
	sessions: ReadonlyMap<string, Session>;
	receipts: RunReceipts;
	reservations(): Reservations;
	store(): HistoryStore | undefined;
	providers(): Provider[];
	checkWriter(s: Session): void;
	settleJobs(s: Session): Promise<boolean>;
	invalidateErasedHandoffs(s: Session, ids: string[]): Promise<void>;
	commitNow(s: Session, drafts: EntryDraft[]): Promise<unknown>;
	write(s: Session, write: () => Promise<void> | undefined): Promise<void>;
	emit(s: Session, kind: string, data: unknown, source: string, ids?: Partial<AgentEvent>): void;
	loadInto(id: string): Promise<Session | undefined>;
	requireAuthority(s: Session, actor: string, right: Authority): void;
	newId(): string;
	problem(source: string, where: string, error: unknown): void;
	actorRights(s: Session, actor: string): Authority[];
}

export class SessionErasure {
	private readonly ephemeralErasure = memoryPendingErasure();
	private readonly erasureEpoch = new WeakMap<Session, number>();
	private readonly storedTombstones = new WeakMap<Session, ReadonlySet<string>>();

	constructor(private readonly operations: ErasureOperations) {}

	epoch(s: Session): number { return this.erasureEpoch.get(s) ?? 0; }

	loadTombstones(s: Session, entries: ReadonlySet<string>): void {
		this.storedTombstones.set(s, entries);
	}

	pendingRegistry(): PendingErasure | undefined {
		const store = this.operations.store();
		return store ? store.pendingErasure : this.ephemeralErasure;
	}

	checkPending(s: Session): string {
		const intents = this.pendingRegistry()?.intents().filter(intent => intent.copies.some(copy => copy.sessionId === s.id)) ?? [];
		if (intents.some(intent => intent.copies.some(copy =>
			copy.sessionId === s.id && (!copy.erased || s.entries.get(copy.id)?.erased !== true)))) {
			throw Object.assign(failure("unavailable", "Session has unresolved pending erasure"), {pendingErasure:true});
		}
		return JSON.stringify(intents.map(intent => intent.id));
	}

	httpErasure(): HistoryErasureRegistry | undefined { return this.operations.store()?.historyErasure; }

	async admitHistory(s: Session): Promise<string> {
		const registry = this.httpErasure();
		if (!registry || s.provisional) return this.checkPending(s);
		// Compare completed marks with the view as prepared, not a view updated during the request.
		const view = new Map(s.entries);
		const stored = this.storedTombstones.get(s);
		const { plans } = await registry.read(s.id);
		if (plans.some(p => p.copies.some(c => !c.complete || view.get(c.entryId)?.erased !== true || !stored?.has(c.entryId)))) {
			throw Object.assign(failure("unavailable", "Session has unresolved pending erasure"), {pendingErasure:true});
		}
		return JSON.stringify(plans.map(plan => plan.intentId));
	}

	deliveryWitness(current: () => Session): () => Promise<boolean> {
		let s: Session;
		try { s = current(); } catch { return async () => false; }
		const freshness = this.admitHistory(s).catch(() => undefined);
		return async () => {
			const expected = await freshness;
			if (expected === undefined || current() !== s || await this.admitHistory(s) !== expected || current() !== s) return false;
			this.operations.checkWriter(s);
			return true;
		};
	}

	private readonly httpProviderReset = new WeakMap<Session, Map<string, string>>();

	async ensureHttpProviderReset(s: Session, providerId: string, freshness: string): Promise<void> {
		const registry = this.httpErasure();
		if (!registry || freshness === "[]" || this.httpProviderReset.get(s)?.get(providerId) === freshness) return;
		const provider = this.operations.providers().find(p => p.id === providerId);
		if (!provider?.discardState) throw failure("unavailable", "Provider state cannot be discarded");
		this.operations.checkWriter(s);
		const { plans } = await registry.read(s.id);
		if (JSON.stringify(plans.map(p => p.intentId)) !== freshness || plans.some(p => p.copies.some(c => !c.complete))) {
			throw failure("unavailable", "Erasure changed the Provider view");
		}
		const reply = await provider.discardState(s.id, { erase: true, entryIds: [...new Set(plans.flatMap(p => p.copies.map(c => c.entryId)))] });
		if (reply?.pending?.length || reply?.outOfReach?.length) throw failure("unavailable", "Provider deletion is unconfirmed");
		this.operations.checkWriter(s);
		const reset = this.httpProviderReset.get(s) ?? new Map();
		reset.set(providerId, freshness);
		this.httpProviderReset.set(s, reset);
	}

	async reconcilePending(s: Session): Promise<string> {
		const remote = this.httpErasure();
		if (remote && !s.provisional) {
			const { plans } = await remote.read(s.id);
			for (const plan of plans) if (plan.copies.some(c => !c.complete)) await this.completeHttpErasure(s, plan);
			return this.admitHistory(s);
		}
		for (const intent of this.pendingRegistry()?.intents() ?? []) {
			if (intent.copies.some(copy => copy.sessionId === s.id && !copy.erased)) {
				await this.reconcileErasure(s, intent.id);
			}
		}
		return this.checkPending(s);
	}

	checkProviderErasure(s: Session, provider: string): void {
		if (this.pendingRegistry()?.intents().some(intent =>
			intent.providers?.some(copy => copy.sessionId === s.id && copy.provider === provider && !copy.confirmed))) {
			throw failure("unavailable", "Provider deletion is unconfirmed");
		}
	}

	async reconcileProviderErasure(s: Session, providerId?: string, observe?: (provider: string, reply: { pending?: string[]; outOfReach?: string[] }) => void): Promise<void> {
		const registry = this.pendingRegistry();
		if (!registry) return;
		const providers = this.operations.providers();
		for (const intent of registry.intents()) {
			for (const copy of intent.providers ?? []) {
				if (copy.sessionId !== s.id || copy.confirmed || providerId !== undefined && copy.provider !== providerId) continue;
				const provider = providers.find(p => p.id === copy.provider);
				if (!provider?.discardState) continue;
				try {
					this.operations.checkWriter(s);
					const entryIds = intent.copies.filter(c => c.sessionId === s.id).map(c => c.id);
					const reply = await provider.discardState(s.id, { erase: true, entryIds });
					if (reply) observe?.(copy.provider, reply);
					if (reply?.pending?.length || reply?.outOfReach?.length) continue;
					this.operations.checkWriter(s);
					await registry.exclusive(async () => {
						const current = registry.intents().find(i => i.id === intent.id);
						const mark = current?.providers?.find(m => m.sessionId === s.id && m.provider === copy.provider);
						if (mark && current) { mark.confirmed = true; registry.keep(current); }
					});
				} catch (error) { this.operations.problem("harness", `erase at ${copy.provider}`, error); }
			}
		}
	}

	private async reconcileErasure(s: Session, operation: string, observe?: Parameters<SessionErasure["reconcileProviderErasure"]>[2]): Promise<void> {
		const registry = this.pendingRegistry()!;
		const store = this.operations.store();
		if (s.erasing || s.moving || s.outsideTools) return;
		s.erasing = true;
		try {
			if (s.running) {
				s.running.abort.abort();
				await s.running.done;
			}
			await s.committing;
			if (!await this.operations.settleJobs(s)) return;
			await this.reconcileProviderErasure(s, undefined, observe);
			await registry.exclusive(async () => {
				const intent = registry.intents().find(i => i.id === operation);
				if (!intent) return;
				const unresolved = intent.copies.filter(c => c.sessionId === s.id && !c.erased);
				if (!unresolved.length || intent.providers?.some(copy => copy.sessionId === s.id && !copy.confirmed)) return;
				const existing = s.order.map(id => s.entries.get(id)!).find(e => e.kind === "erasure" &&
					(e.data as { operation?: string })?.operation === operation);
				if (!existing) {
					const entryIds = unresolved.map(copy => copy.id).filter(id => s.entries.has(id));
					if (!entryIds.length) return;
					await this.operations.invalidateErasedHandoffs(s, entryIds);
					const keys = entryIds.flatMap(id => {
						const e = s.entries.get(id)!;
						const d = e.data as { key?: string; submittedBy?: string; delegatedBy?: string } | undefined;
						const inputId = inputIdOf(e);
						return e.kind === "inputAccepted" && inputId && d?.key ? [{ inputId, key: d.key, actorId: e.actorId, submittedBy: d.submittedBy ?? d.delegatedBy ?? e.actorId }] : [];
					});
					const inputKeys = [...new Map(keys.map(k => [k.inputId, k])).values()];
					await this.operations.commitNow(s, [{ kind: "erasure", writer: "harness", actorId: intent.actorId, modelVisible: false,
						data: { operation, entryIds, ...(inputKeys.length ? { inputKeys } : {}) } }]);
				}
				const book = existing ?? s.order.map(id => s.entries.get(id)!).find(e => e.kind === "erasure" &&
					(e.data as { operation?: string })?.operation === operation);
				const recorded = new Set((book?.data as { entryIds?: string[] } | undefined)?.entryIds);
				this.operations.receipts.erase(s.id, recorded, [...s.entries.values()]);
				if (!s.ephemeral) await this.operations.write(s, () => store!.erase!(s.id, [...recorded]));
				const kept = s.ephemeral ? { meta: s.meta, entries: [...s.entries.values()] } : await store!.load(s.id);
				this.operations.reservations().retain(s, retainedHistoryBytes(kept), true);
				const tombstones = new Set(kept.entries.filter(e => e.erased).map(e => e.id));
				let confirmed = 0;
				for (const copy of unresolved) if (recorded.has(copy.id) && tombstones.has(copy.id)) { copy.erased = true; confirmed++; }
				registry.keep(intent);
				s.recent.length = 0;
				if (confirmed) this.operations.emit(s, "entries.erased", { count: confirmed }, "harness", { actorId: intent.actorId });
			});
		} finally { s.erasing = false; }
	}

	private async completeHttpErasure(s: Session, plan: ErasurePlan, actorId = "harness"): Promise<void> {
		const store = this.operations.store()!;
		if (s.erasing || s.moving || s.outsideTools) return;
		s.erasing = true;
		try {
			if (s.running) { s.running.abort.abort(); await s.running.done; }
			await s.committing;
			if (!await this.operations.settleJobs(s)) return;
			this.operations.checkWriter(s);
			const pending = plan.copies.filter(copy => !copy.complete).map(copy => copy.entryId);
			if (!pending.length) return;
			for (const provider of this.operations.providers().filter(p => p.supports.keepsState)) {
				if (!provider.discardState) return;
				const reply = await provider.discardState(s.id, { erase: true, entryIds: plan.copies.map(c => c.entryId) });
				if (reply?.pending?.length || reply?.outOfReach?.length) return;
				this.operations.checkWriter(s);
			}
			if (!s.entries.has(plan.recordId)) {
				const entryIds = plan.copies.map(copy => copy.entryId);
				if (entryIds.some(id => !s.entries.has(id))) throw failure("unavailable", "Erasure plan names missing history");
				await this.operations.invalidateErasedHandoffs(s, entryIds);
				const keys = entryIds.flatMap(id => {
					const e = s.entries.get(id)!;
					const d = e.data as { key?: string; submittedBy?: string; delegatedBy?: string } | undefined;
					const inputId = inputIdOf(e);
					return e.kind === "inputAccepted" && inputId && d?.key ? [{ inputId, key: d.key, actorId: e.actorId, submittedBy: d.submittedBy ?? d.delegatedBy ?? e.actorId }] : [];
				});
				const inputKeys = [...new Map(keys.map(k => [k.inputId, k])).values()];
				await this.operations.commitNow(s, [{ id: plan.recordId, kind: "erasure", writer: "harness", actorId, modelVisible: false,
					data: { operation: plan.intentId, entryIds, ...(inputKeys.length ? { inputKeys } : {}) } }]);
			}
			const book = s.entries.get(plan.recordId);
			const recorded = new Set((book?.data as { entryIds?: string[] } | undefined)?.entryIds);
			if (!book || book.erased || book.kind !== "erasure" || pending.some(id => !recorded.has(id))) throw failure("unavailable", "Erasure bookkeeping does not match the plan");
			this.operations.receipts.erase(s.id, recorded, [...s.entries.values()]);
			await this.operations.write(s, () => store.erase!(s.id, pending));
			const kept = await store.load(s.id);
			this.operations.reservations().retain(s, retainedHistoryBytes(kept), true);
			const tombstones = new Set(kept.entries.filter(e => e.erased === true).map(e => e.id));
			this.storedTombstones.set(s, tombstones);
			if (pending.some(id => !tombstones.has(id))) throw failure("unavailable", "Erasure has no matching tombstones");
			this.erasureEpoch.set(s, this.epoch(s) + 1);
			await store.historyErasure!.complete(s.id, plan.intentId, pending);
			s.recent.length = 0;
			this.operations.emit(s, "entries.erased", { count: pending.length }, "harness", { actorId });
		} finally { s.erasing = false; }
	}

	private async eraseHttp(s: Session, entryIds: string[], actorId: string, writer: string, store: HistoryStore, registry: HistoryErasureRegistry): Promise<ErasureReport> {
		const requested = [...new Set(entryIds)].sort();
		if (!requested.length) throw failure("invalid_request", "Erasure requires at least one entry");
		let publication: Awaited<ReturnType<HistoryErasureRegistry["publish"]>>;
		let sessions: Map<string, CopyHistory>;
		for (;;) {
			this.operations.checkWriter(s);
			const { revision } = await registry.read(s.id);
			// Use stored rows rather than open views; another writer may have added
			// copies, and an erasure record alone is not a verified tombstone.
			sessions = await this.copyHistories(store);
			if (!sessions.has(s.id)) throw failure("unavailable", "Cannot discover the full erasure scope");
			const targets = eraseCopies(sessions.get(s.id)!, requested, sessions);
			this.operations.requireAuthority(s, actorId, "erase");
			try {
				publication = await registry.publish(s.id, { revision, intentId: this.operations.newId(), entryIds: requested,
					copies: [...targets].map(([view, ids]) => ({ sessionId: view.id, recordId: this.operations.newId(), entryIds: [...ids] })) });
				break;
			} catch (error) {
				if ((error as { code?: string }).code !== "stale_revision") throw error;
			}
		}
		const report: ErasureReport = { erased: [], pending: [], erasedPairs: [], pendingPairs: [], outOfReach: [] };
		const note = (value: string) => { if (!report.outOfReach.includes(value)) report.outOfReach.push(value); };
		const { intentId, sessionIds } = publication;
		const readPlan = async (id: string) => {
			const plan = (await registry.read(id)).plans.find(p => p.intentId === intentId && p.sourceSessionId === s.id);
			if (!plan) throw failure("unavailable", "Published erasure plan is missing");
			return plan;
		};
		for (const id of sessionIds) {
			let plan = await readPlan(id);
			// Retention can remove the history, but not its plan. Without the
			// history we cannot verify the actor's right to see its copy IDs.
			let session = this.operations.sessions.get(id);
			let view = session;
			let acquired = false;
			try {
				view ??= await this.operations.loadInto(id);
				if (view && plan.copies.some(c => !c.complete)) {
					if (!session) {
						await store.openForWriting(id);
						acquired = true;
						session = await this.operations.loadInto(id);
					}
					if (session) await this.completeHttpErasure(session, plan, actorId);
				}
			} catch (error) {
				const code = (error as { code?: string }).code;
				if (code !== "held" && code !== "unknown_session") this.operations.problem(writer, "reconcile erasure", error);
			} finally { if (acquired) await store.close(id); }
			s.interruption.signal.throwIfAborted();
			plan = await readPlan(id);
			if (id !== s.id && (!view || !this.operations.actorRights(view, actorId).includes("watch"))) { note("copies in other sessions"); continue; }
			for (const copy of plan.copies) {
				(copy.complete ? report.erased : report.pending).push(copy.entryId);
				(copy.complete ? report.erasedPairs : report.pendingPairs).push({ sessionId: id, id: copy.entryId });
			}
			for (const provider of this.operations.providers()) if (provider.supports.keepsState) note(`Unconfirmed deletion at ${provider.id}`);
		}
		if (report.erased.length) note("Output already delivered and copies beyond the agent");
		return report;
	}

	private async copyHistories(store: HistoryStore | undefined): Promise<Map<string, CopyHistory>> {
		const histories = new Map<string, CopyHistory>();
		for (const [id, session] of this.operations.sessions) {
			if (session.ephemeral) histories.set(id, session);
		}
		for (const { id } of await store?.list() ?? []) {
			const { meta, entries } = await store!.load(id);
			const copied = new Set<string>();
			if (meta.forkedFrom) {
				for (const entry of entries) {
					if (!entry.sources?.length && !entry.erased) break;
					copied.add(entry.id);
				}
			}
			histories.set(id, { id, meta, copied, entries: new Map(entries.map(entry => [entry.id, entry])) });
		}
		return histories;
	}

	async erase(s: Session, entryIds: string[], actorId: string, writer: string): Promise<ErasureReport> {
		this.operations.requireAuthority(s, actorId, "erase");
		if (s.provisional) throw failure("invalid_request", "Session has not admitted its first input");
		const store = this.operations.store();
		const registry = this.pendingRegistry();
		const remote = this.httpErasure();
		if ((!registry && !remote) || !s.ephemeral && !store?.erase) throw failure("not_supported", "This history has no shared erasure coordination");
		if (s.running || s.erasing || s.moving) throw failure("busy", "Cannot erase during work");
		if (remote) return this.eraseHttp(s, entryIds, actorId, writer, store!, remote);
		if (!registry) throw failure("not_supported", "Missing local erasure coordination");
		const requested = [...new Set(entryIds)].sort();
		const operation = await registry.exclusive(async () => {
			this.operations.requireAuthority(s, actorId, "erase");
			const earlier = registry.intents().find(i => i.sessionId === s.id && isDeepStrictEqual(i.targets, requested));
			if (earlier) return earlier;
			const sessions = await this.copyHistories(store);
			const origin = sessions.get(s.id);
			if (!origin) throw failure("unavailable", "Cannot discover the full erasure scope");
			const targets = eraseCopies(origin, requested, sessions);
			const stateful = new Set(this.operations.providers().filter(p => p.supports.keepsState).map(p => p.id));
			const providers = [...targets.keys()].flatMap(session => {
				// A kept-state Provider may have retained data not named in a request record.
				const used = new Set(stateful);
				for (const entry of session.entries.values()) {
					const data = entry?.data as { model?: { provider?: string }; keepsState?: boolean } | undefined;
					const provider = data?.model?.provider;
					if (entry?.kind === "modelRequest" && provider && (data?.keepsState === true || stateful.has(provider))) used.add(provider);
				}
				return [...used].map(provider => ({ sessionId: session.id, provider, confirmed: false }));
			});
			const intent: ErasureIntent = { id: this.operations.newId(), sessionId: s.id, targets: requested, actorId, providers,
				copies: [...targets].flatMap(([session, ids]) =>
					[...ids].map(id => ({ sessionId: session.id, id, erased: false }))) };
			registry.keep(intent);
			return intent;
		});
		const report: ErasureReport = { erased: [], pending: [], erasedPairs: [], pendingPairs: [], outOfReach: [] };
		const add = (description: string) => { if (!report.outOfReach.includes(description)) report.outOfReach.push(description); };
		for (const id of new Set(operation.copies.map(copy => copy.sessionId))) {
			let session = this.operations.sessions.get(id);
			const replies = new Map<string, { pending?: string[]; outOfReach?: string[] }>();
			let acquired = false;
			try {
				if (!session && store) {
					await store.openForWriting(id);
					acquired = true;
					session = await this.operations.loadInto(id);
				}
				if (session) {
					await this.reconcileErasure(session, operation.id, (provider, reply) => replies.set(provider, reply));
				}
			} catch (error) {
				if ((error as { code?: string }).code !== "held") this.operations.problem(writer, "reconcile erasure", error);
			} finally { if (acquired) await store!.close(id); }
			s.interruption.signal.throwIfAborted();
			const view = session ?? await this.operations.loadInto(id).catch(() => undefined);
			const marks = registry.intents().find(intent => intent.id === operation.id)!.copies.filter(copy => copy.sessionId === id);
			const visible = id === s.id || !!view && this.operations.actorRights(view, actorId).includes("watch");
			for (const mark of marks) {
				if (!visible) { add("copies in other sessions"); continue; }
				(mark.erased ? report.erased : report.pending).push(mark.id);
				(mark.erased ? report.erasedPairs : report.pendingPairs).push({ sessionId: id, id: mark.id });
			}
			for (const remote of registry.intents().find(intent => intent.id === operation.id)?.providers ?? []) {
				if (remote.sessionId !== id || remote.confirmed) continue;
				if (!visible) { add("copies in other sessions"); continue; }
				const reply = replies.get(remote.provider);
				report.pending.push(...(reply?.pending ?? []));
				for (const description of reply?.outOfReach ?? []) add(description);
				add(`Unconfirmed deletion at ${remote.provider}`);
			}
		}
		if (report.erased.length) add("Output already delivered and copies beyond the agent");
		return { ...report, pending: [...new Set(report.pending)] };
	}
}

interface CopyHistory {
	id: string;
	meta: StoredSession;
	copied: ReadonlySet<string>;
	entries: ReadonlyMap<string, HistoryEntry>;
}

/** Walk stored copy links without replaying intake or treating the branch position as a copy. */
function eraseCopies(origin: CopyHistory, ids: string[], sessions: Map<string, CopyHistory>): Map<CopyHistory, Set<string>> {
	const targets = new Map<CopyHistory, Set<string>>();
	const authority = (kind: string) => ["actorJoined", "actorLeft", "limit", "tenant", "grant", "authority.grant", "authority.revoke", "position", "erasure", "jobCleanupUnconfirmed"].includes(kind);
	const add = (session: CopyHistory, id: string) => {
		const e = session.entries.get(id);
		if (!e || targets.get(session)?.has(id)) return false;
		if (authority(e.kind) && !session.copied.has(e.id)) throw Object.assign(new Error("Records of authority cannot be erased"), { code: "forbidden" });
		if (!targets.has(session)) targets.set(session, new Set());
		targets.get(session)!.add(id);
		return true;
	};
	for (const id of ids) { if (!origin.entries.has(id)) throw Object.assign(new Error("Unknown erasure target"), { code: "not_found" }); add(origin, id); }
	const all = [...sessions.values()];
	for (let grew = true; grew;) {
		grew = false;
		for (const session of all) {
			const targetsHere = targets.get(session);
			const entries = [...session.entries.values()];
			const erased = entries.filter((e) => targetsHere?.has(e.id));
			const handoffs = handoffRecords(entries);
			const calls = new Set(erased.flatMap((e) => [
				...(e.kind !== "toolResult" && e.toolCallId ? [e.toolCallId] : []),
				...(e.message?.role === "assistant" ? e.message.content.filter(isToolCall).map((c) => c.id) : []),
			]));
			for (const e of entries) {
				if (targetsHere?.has(e.id) || authority(e.kind)) continue;
				const forkedFrom = session.copied.has(e.id) ? session.meta.forkedFrom : undefined;
				const links = forkedFrom ? e.sources?.some((id) => targets.get(sessions.get(forkedFrom.sessionId)!)?.has(id)) :
					e.sources?.some((id) => targetsHere?.has(id) || (!session.entries.has(id) && [...targets.values()].some(ids => ids.has(id))));
				const callCopy = e.toolCallId && calls.has(e.toolCallId) ||
					e.kind === "response" && e.message?.role === "assistant" &&
					e.message.content.some(p => isToolCall(p) && calls.has(p.id) && handoffs.has(p.id));
				const turnResult = e.kind === "turnEnd" && erased.some((x) => x.turnId === e.turnId && ["response", "toolResult"].includes(x.kind));
				// A completed turn with an erased outcome must not look like an interrupted turn on reopen.
				const endedTurnStart = e.kind === "turnStart" && erased.some((x) => x.kind === "turnEnd" && x.turnId === e.turnId);
				const jobId = e.jobId ?? (e.data as { value?: { jobId?: string } } | undefined)?.value?.jobId;
				const jobCopy = jobId && erased.some((x) => x.jobId === jobId && ["jobStarted", "jobEnded", "harness.jobStarted", "harness.jobEnded"].includes(x.kind));
				const startedByCall = (e.kind === "harness.jobStarted" || e.kind === "jobStarted") && !e.toolCallId && erased.some((x) => x.turnId === e.turnId && x.kind === "toolStarted");
				// Older or foreign responses need not give sources. Earlier branch entries may all have been in the request.
				let ancestry = false;
				if (e.kind === "response" && !e.sources && erased.length) {
					const seen = new Set<string>();
					for (let id = e.parentId; id && !seen.has(id); id = session.entries.get(id)?.parentId ?? null) {
						if (targetsHere?.has(id)) { ancestry = true; break; }
						seen.add(id);
					}
				}
				const inputId = e.inputId;
				const takingInput = inputId && erased.some((x) => x.inputId === inputId);
				if (links || callCopy || turnResult || endedTurnStart || jobCopy || startedByCall || ancestry || takingInput) grew = add(session, e.id) || grew;
			}
		}
	}
	return targets;
}
