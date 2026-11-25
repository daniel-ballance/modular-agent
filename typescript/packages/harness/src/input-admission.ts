import { untilAborted } from "./session-lifecycle.js";
import { parseModel } from "./settings.js";
import type { Command, InputOptions } from "./plugin-api.js";
import { TurnExecution, inputActors } from "./turn-execution.js";
import { InterfaceToolRoutes } from "./interface-tool-routes.js";
import { connectionRights, intersectConnectionRights } from "./connection-authority.js";
import { SessionErasure } from "./session-erasure.js";
import { ApprovalReconciliation } from "./approval-reconciliation.js";
import { failure } from "./failure.js";
import { waitingApprovals } from "./waiting-approval.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { conversation, currentSpan, startOperation } from "./telemetry.js";
import { Reservations } from "./reservations.js";
import { type ReceiptOperation } from "./run-receipts.js";
import { HookRegistry } from "./hooks.js";
import { inputKeyScope, type InputReceipt, type InputTiming, type QueuedInput, Session } from "./session.js";
import { type AgentEvent, type Authority, type EntryDraft, type HistoryEntry, type ModelAccess, type Provider, type Runtime, text, textOf } from "./types.js";

interface InputAdmissionOperations {
	intersectRights(...ceilings: readonly Authority[][]): Authority[];
	session(id: string): Session;
	erasure(): Pick<SessionErasure, "reconcilePending" | "admitHistory">;
	checkWriter(s: Session): void;
	checkScopedWork(s: Session, right: Authority): void;
	requireAuthority(s: Session, actorId: string, authority: Authority): void;
	commandTable(): ReadonlyMap<string, Command>;
	runCommand(sessionId: string, line: string, actorId: string): Promise<string | void>;
	newId(): string;
	hooks(): HookRegistry;
	receiptOperation(): AsyncLocalStorage<ReceiptOperation>;
	commit(s: Session, drafts: EntryDraft[], pluginRecord?: boolean, guard?: () => boolean | Promise<boolean>): Promise<HistoryEntry[]>;
	rightsOf(s: Session, actorId: string): Authority[];
	rejectUnknownModel(): boolean;
	providerFor(s: Session, ref?: ReturnType<typeof parseModel> | null): Provider | undefined;
	modelAccess(s: Session, ref?: ReturnType<typeof parseModel> | null): ModelAccess | undefined;
	workRights(s: Session, actors: Iterable<string>, jobs?: Iterable<string>): Authority[];
	runtime(): Runtime | undefined;
	reserveInput(s: Session, q: QueuedInput, rebuilding?: boolean, startsNow?: boolean): void;
	reservations(): Reservations;
	interfaceTools(): Pick<InterfaceToolRoutes, "interfaceSources" | "unsettledHandoffs" | "settleInterfaceCall" | "queuedOffers" | "offerScope">;
	turns(): Pick<TurnExecution, "startTurn" | "maybeContinueOpenCalls">;
	emit(session: string | Session, type: string, data: any, source: string, ids?: Partial<AgentEvent>): void;
	problem(plugin: string, where: string, error: unknown): void;
	approvals(): Pick<ApprovalReconciliation, "reconcileApprovals" | "closeWaiting">;
}

export class InputAdmission {
	constructor(private readonly operations: InputAdmissionOperations) {}

	async input(sessionId: string, options: InputOptions): Promise<InputReceipt & { handled?: boolean; output?: string }> {
		const span = startOperation("modular_agent.input.admit", conversation(sessionId));
		try {
			const receipt = await span.run(() => this.inputWithin(sessionId, options));
			span.set("modular_agent.input.id", receipt.inputId);
			return receipt;
		} catch (error) {
			if ((error as { code?: string }).code === "busy") span.event("modular_agent.capacity.refused", {});
			throw error;
		} finally { span.end(); }
	}

	private async inputWithin(sessionId: string, options: InputOptions): Promise<InputReceipt & { handled?: boolean; output?: string }> {
		const s = this.operations.session(sessionId);
		const right = options.when === "propose" ? "propose" : "input";
		const authorize = () => {
			this.operations.checkScopedWork(s, right);
			if (options.startedBy?.kind !== "job") {
				this.operations.requireAuthority(s, options.actorId, right);
				if (options.delegatedBy) this.operations.requireAuthority(s, options.delegatedBy, right);
			}
		};
		authorize();
		await this.operations.erasure().reconcilePending(s);
		this.operations.checkWriter(s);
		if (s.erasing) throw failure("busy", "Erasure is in progress");
		authorize();
		const scoped = options.key && inputKeyScope(options.key, options.actorId, options.delegatedBy);
		if (scoped) {
			if (s.erasedKeys.has(scoped)) return { duplicate: true, erased: true } as InputReceipt;
			const earlier = s.keys.get(scoped);
			if (earlier) return { ...earlier, duplicate: true };
		}
		let content = typeof options.content === "string" ? [text(options.content)] : options.content;
		const typed = textOf(content).trimStart();
		if (options.when !== "propose" && !options.delegatedBy && options.startedBy?.kind !== "job" && typed.startsWith("/") && this.operations.commandTable().has(/^\/(\S+)/.exec(typed)?.[1] ?? "")) {
			const output = await this.operations.runCommand(sessionId, typed, options.actorId);
			const receipt = { inputId: this.operations.newId(), taken: "now" as const, handled: true, output: output ?? undefined };
			if (scoped) s.keys.set(scoped, receipt);
			return receipt;
		}
		const transformed = await this.operations.hooks().transform("input", { sessionId, content, actorId: options.actorId, when: options.when ?? "now" },
			(before, after) => {
				if (!Array.isArray(after.value?.content) || after.value.sessionId !== before.sessionId || after.value.when !== before.when || after.value.actorId !== before.actorId) {
					throw new Error("An input hook may change only content");
				}
			});
		if (s.erasing) throw failure("busy", "Erasure is in progress");
		if (transformed.stopped) {
			const inputId = this.operations.newId();
			if (this.operations.receiptOperation().getStore()) {
				await this.operations.commit(s, [
					{kind:"inputAccepted", writer:"harness", modelVisible:false, inputId, actorId:options.actorId,
						data:{key:options.key, when:"now", taken:"now", content}},
					{kind:"inputHandedBack", writer:"harness", modelVisible:false, inputId, data:{reason:"handled"}},
				]);
			}
			let output: string | void = undefined;
			const command = transformed.command;
			if (command !== undefined) {
				if (right !== "input") throw Object.assign(new Error("A proposal cannot run a command"), { code: "forbidden" });
				if (options.delegatedBy) this.operations.requireAuthority(s, options.delegatedBy, "input");
				output = await this.operations.runCommand(sessionId, command, options.actorId);
			}
			const receipt = { inputId, taken: "now" as const, handled: true, ...(output === undefined ? {} : { output }) };
			if (scoped) s.keys.set(scoped, receipt);
			return receipt;
		}
		content = transformed.value.content;
		const queued: QueuedInput = {
			id: this.operations.newId(), content, actorId: options.actorId, when: options.when ?? "now", key: options.key,
			resultShape: options.resultShape,
			connectionRights: connectionRights.getStore(),
			startedBy: options.startedBy ?? { kind: "actor", id: options.actorId }, kind: options.kind ?? "input", sources: options.sources, delegatedBy: options.delegatedBy,
		};
		return this.admit(s, async () => {
			if (queued.startedBy.kind !== "job") {
				this.operations.requireAuthority(s, queued.actorId, right);
				if (queued.delegatedBy) this.operations.requireAuthority(s, queued.delegatedBy, right);
			}
			if (scoped && s.erasedKeys.has(scoped)) return { duplicate: true, erased: true } as InputReceipt;
			const earlier = scoped && s.keys.get(scoped);
			if (earlier) return { ...earlier, duplicate: true };
			if (queued.startedBy.kind !== "job") queued.connectionRights = Object.fromEntries(inputActors(queued).map(id => [id, this.operations.rightsOf(s, id)]));
			return this.acceptInput(s, queued);
		});
	}

	/** Serialize receipts, release and cancellation for a session. */
	admit<T>(s: Session, work: () => Promise<T>): Promise<T> {
		const wait = s.admissionsInFlight++ > 0 ? startOperation("modular_agent.capacity.wait", {
			...conversation(s.id), "modular_agent.capacity.scope": "session",
		}) : undefined;
		const run = s.admitting.then(() => { wait?.end(); return work(); }).finally(() => { s.admissionsInFlight--; });
		s.admitting = run.catch(() => undefined);
		return run;
	}

	async acceptInput(s: Session, q: QueuedInput): Promise<InputReceipt> {
		if (s.closed) throw failure("not_open", "Session is closed");
		if (s.suspended) throw failure("lost", "Session has lost its writer");
		if (s.closing || s.erasing || s.moving) throw failure("busy", "Session cannot take input right now");
		if (this.operations.rejectUnknownModel() && q.startedBy.kind === "actor" && q.when !== "propose" && s.settings.model != null) {
			await this.operations.providerFor(s)?.refreshModels?.();
			if (!this.operations.modelAccess(s)) throw Object.assign(new Error("The selected model is not offered"), { code: "invalid_request" });
		}
		await this.operations.erasure().admitHistory(s);
		if (q.startedBy.kind !== "job" && !q.releasedBy) {
			const right = q.when === "propose" ? "propose" : "input";
			for (const actor of inputActors(q)) this.operations.requireAuthority(s, actor, right);
		}
		const authorizers = inputActors(q);
		q.startingRights ??= this.operations.workRights(s, authorizers, q.startedBy.kind === "job" ? [q.startedBy.id] : []);
		const steer = q.when === "steer" && this.operations.runtime()?.supports.inputDuringTurn === true && !s.running?.steeringClosed;
		const taken = q.when === "propose" ? "proposed" : !s.isBusy() && !s.reopening && !s.followUps.length ? "now" : steer && !s.reopening ? "inTurn" : "after";
		// A selected turn already owns this input; only input still waiting for
		// disposition takes a slot in the pending queue.
		this.operations.reserveInput(s, q, false, taken === "now");
		try { await this.operations.commit(s, [{
			kind: "inputAccepted", writer: "harness", modelVisible: false, actorId: q.actorId, inputId: q.id, sources: q.sources,
			jobId: q.startedBy.kind === "job" ? q.startedBy.id : undefined,
			data: { key: q.key, when: q.when, ...(q.startedBy.kind === "job" && !q.releasedBy ? { parked: q.when === "propose" } : {}), content: q.content, releasedBy: q.releasedBy, submittedBy: q.delegatedBy, taken, connectionRights: q.connectionRights, rights: q.startingRights,
				authorizers: authorizers.map(actorId => ({ sessionId: s.id, actorId })) },
		}]); }
		catch (error) {
			if (!s.interruption.signal.aborted) this.operations.reservations().release(s, `input:${q.id}`);
			throw error;
		}
		q.trace ??= currentSpan();
		const offerScope = this.operations.interfaceTools().offerScope.getStore();
		if (offerScope) this.operations.interfaceTools().queuedOffers.set(q, offerScope);
		const receipt: InputReceipt = { inputId: q.id, taken };
		if (q.when !== "propose") {
			if (taken === "now") this.operations.turns().startTurn(s, q);
			else (taken === "inTurn" ? s.steering : s.followUps).push(q);
		}
		this.operations.emit(s, "input.accepted", { inputId: q.id, taken }, "harness", { actorId: q.actorId });
		return receipt;
	}

	releaseInput(s: Session, inputId: string, when: Exclude<InputTiming, "propose">, actorId: string, declined?: boolean): Promise<InputReceipt> {
		return this.admit(s, async () => {
			this.operations.requireAuthority(s, actorId, "input");
			const q = s.proposals.get(inputId);
			if (!q) throw Object.assign(new Error(`No open proposal ${inputId}`), { code: "conflict" });
			const receipt = declined
				? (await this.handBack(s, [q], "declined"), { inputId, taken: "handedBack" as const })
				: await this.acceptInput(s, { ...q, when, releasedBy: actorId,
					connectionRights: intersectConnectionRights(q.connectionRights, { [actorId]: this.operations.rightsOf(s, actorId) }),
					startingRights: this.operations.intersectRights(q.startingRights ?? [], this.operations.rightsOf(s, actorId)) });
			s.proposals.delete(inputId);
			return receipt;
		});
	}

	withdrawProposal(s: Session, id: string, actorId: string, delegatedBy?: string): Promise<void> {
		return this.admit(s, async () => {
			const q = s.proposals.get(id);
			if (!q) throw Object.assign(new Error(`No open proposal ${id}`), { code: "conflict" });
			if (!s.actors.has(actorId) || (delegatedBy && !s.actors.has(delegatedBy))) throw new Error("Actor is not part of this session");
			if (q.actorId !== actorId) {
				this.operations.requireAuthority(s, actorId, "input");
				if (delegatedBy) this.operations.requireAuthority(s, delegatedBy, "input");
			}
			await this.handBack(s, [q], "withdrawn");
		});
	}

	async handBack(s: Session, queued: QueuedInput[], reason: string): Promise<void> {
		const inputIds = queued.filter((q) => s.admissions.has(q.id)).map((q) => q.id);
		if (inputIds.length) await this.operations.commit(s, inputIds.map((inputId) => ({ kind: "inputHandedBack", writer: "harness", modelVisible: false, inputId, data: { reason } })));
		for (const q of queued) this.operations.emit(s, reason === "withdrawn" ? "input.withdrawn" : "input.handedBack",
			{ inputId: q.id, content: q.content, reason }, "harness");
	}

	withdraw(sessionId: string, inputId: string): QueuedInput | undefined {
		const s = this.operations.session(sessionId);
		for (const queue of [s.steering, s.followUps]) {
			const i = queue.findIndex((q) => q.id === inputId);
			if (i >= 0) {
				const [q] = queue.splice(i, 1);
				void this.handBack(s, [q], "withdrawn").catch((e) => this.operations.problem("harness", "withdraw input", e));
				return q;
			}
		}
		return undefined;
	}

	/** Cancel the running turn. Its jobs keep running. Queued input is handed back. */
	async cancel(sessionId: string): Promise<QueuedInput[]> {
		const s = this.operations.session(sessionId);
		const { handedBack, running } = await this.admit(s, async () => {
			const handedBack = [...s.steering, ...s.followUps].filter(q => !q.continueTurnId);
			s.steering = [];
			s.followUps = [];
			const running = s.running;
			running?.abort.abort();
			const recorded = this.handBack(s, handedBack, "cancelled");
			for (const w of waitingApprovals(s).values()) if (!w.result && !w.start && !s.closing) await this.operations.approvals().closeWaiting(s, w, "cancelled", "notStarted");
			for (const handoff of this.operations.interfaceTools().unsettledHandoffs(s)) await this.operations.interfaceTools().settleInterfaceCall(s, handoff);
			for (const r of [...s.requests.values()]) r.resolve({ requestId: r.request.id, declined: true, actorId: "harness", reason: "cancelled" });
			await recorded;
			return { handedBack, running };
		});
		await running?.done;
		if (this.operations.interfaceTools().interfaceSources.size || s.hasWaitingApprovals) this.operations.turns().maybeContinueOpenCalls(s);
		return handedBack;
	}

	async waitForIdle(sessionId: string): Promise<void> {
		const s = this.operations.session(sessionId);
		if (s.hasWaitingApprovals) await this.operations.approvals().reconcileApprovals(s);
		await untilAborted(s.interruption.signal, async () => {
			while (!s.suspended && (s.running || s.settling)) {
				if (s.settling) await s.settling;
				if (s.running && !s.suspended) await s.running.done;
			}
		});
	}
}
