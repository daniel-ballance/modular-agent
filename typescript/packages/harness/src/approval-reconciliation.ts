import { failure } from "./failure.js";
import { INTERFACE_SOURCE } from "./interface-tools.js";
import { resourceBytes, type Reservations } from "./reservations.js";
import type { Session } from "./session.js";
import { activeOperation, conversation, currentSpan, startOperation, telemetryEvent, withTrace } from "./telemetry.js";
import { text, type Answer, type Authority, type EntryDraft, type HistoryEntry, type InputRequest, type InputRequestDraft, type InterfaceCapability, type ToolCall, type ToolDefinition, type ToolSource } from "./types.js";
import { sameJson, waitingApprovals, type ApprovalBinding, type ApprovalDelivery, type ApprovalRoute, type WaitingApproval } from "./waiting-approval.js";

interface ApprovalOperations {
	now(): number;
	newId(): string;
	reservations(): Reservations;
	findTool(s: Session, name: string): { plugin: string; source: ToolSource; definition: ToolDefinition } | undefined;
	actorRights(s: Session, actor: string): Authority[];
	originalWorkAllows(s: Session, approval: WaitingApproval): boolean;
	exitTurn<T>(work: () => T): T;
	exitConnection<T>(work: () => T): T;
	commit(s: Session, drafts: EntryDraft[], pluginRecord?: boolean, guard?: () => boolean | Promise<boolean>): Promise<HistoryEntry[]>;
	commitNow(s: Session, drafts: EntryDraft[]): Promise<HistoryEntry[]>;
	interfaces(): InterfaceCapability[];
	emitAnswer(s: Session, request: InputRequest, answer: Answer, late: boolean): void;
	toolDisposition(call: ToolCall, status: string): void;
	maybeContinueOpenCalls(s: Session, trace?: ReturnType<typeof currentSpan>): void;
	problem(plugin: string, where: string, error: unknown): void;
	intersectRights(...ceilings: readonly Authority[][]): Authority[];
}

export class ApprovalReconciliation {
	maximum?: number;
	private readonly approvalRoutes = new Map<string, ApprovalRoute>();
	private readonly approvalDeliveries = new WeakMap<Session, Set<ApprovalDelivery & { entryId: string }>>();
	private readonly approvalTimer = new WeakMap<Session, NodeJS.Timeout>();

	constructor(private readonly operations: ApprovalOperations) {}

	registerRoute(policy: ApprovalRoute): () => void {
		this.approvalRoutes.set(policy.id, policy);
		return () => {
			if (this.approvalRoutes.get(policy.id) === policy) this.approvalRoutes.delete(policy.id);
		};
	}

	presenceChanged(s: Session): void {
		const delivered = this.approvalDeliveries.get(s);
		for (const d of delivered ?? []) if (!d.present()) delivered!.delete(d);
	}

	clear(s: Session): void {
		clearTimeout(this.approvalTimer.get(s));
		this.invalidateDeliveries(s);
	}

	invalidateDeliveries(s: Session): void {
		this.approvalDeliveries.delete(s);
	}

	approvalPrincipalsAllow(s: Session, w: WaitingApproval) {
		const p = w.proof;
		if (!p || !this.validWait(s, w) || !w.end || !w.decision?.actorId || w.result || !this.operations.originalWorkAllows(s, w) ||
			!["off", "ask", "all"].includes(String(s.settings.approval ?? "all"))) return false;
		const rights = this.operations.exitTurn(() => this.operations.exitConnection(() => this.approvalRights(s, w, this.approvalRoutes.get(p.routeId), w.decision!.actorId!, p.submittedBy)));
		return ["watch", "approve"].every(right => rights.includes(right as Authority) && p.rights.includes(right as Authority));
	}

	async approverStillAllows(s: Session, w: WaitingApproval) {
		if (!this.approvalPrincipalsAllow(s, w)) return false;
		const route = this.approvalRoutes.get(w.proof!.routeId)!;
		return this.operations.exitConnection(() => this.unchanged(w, route, w.decision!.actorId!));
	}

	// Only a model gate can park an approval. A tool's own question is live-only.
	async parkApproval(s: Session, draft: InputRequestDraft & { coversNested?: true }, binding: ApprovalBinding, gate: { response: HistoryEntry; actorId: string; turnId: string }): Promise<Answer> {
		const call = { ...binding.call, actorId: gate.actorId };
		const denied = (reason: string): Answer => ({ requestId: "", actorId: "harness", declined: true, reason });
		const prior = waitingApprovals(s).get(call.id);
		if (prior) {
			if (prior.end && prior.proof && !prior.start && !prior.result && this.matchesApproval(prior, call, s)) {
				return { requestId: prior.request.id, actorId: prior.decision!.actorId!, value: "allow" };
			}
			return denied("Consent does not match this call");
		}
		const limit = Math.min(this.maximum!, draft.timeLimitMs ?? this.maximum!);
		if (!Number.isSafeInteger(limit) || limit < 0) return denied("Invalid approval time limit");
		if (![...s.actors.keys()].some(id => this.eligibleMember(s, draft.answerers, id))) return denied("No eligible approver");
		const id = this.operations.newId(), entryId = this.operations.newId();
		const request = { kind: "approval", id, sessionId: s.id, question: draft.question, details: draft.details, key: draft.key,
			...(draft.coversNested ? { coversNested: true } : {}), toolCallId: call.id, askedBy: "approval", answerable: false, approvalWait: "untilDeadline", timeLimitMs: limit,
			whenTimeLimit: "decline", ...(draft.answerers ? { answerers: [...draft.answerers] } : {}) };
		const data = structuredClone({ request, ...binding, call });
		const bytes = resourceBytes(data) + 2048;
		const reservations = this.operations.reservations();
		if (bytes > reservations.limits.entryBytes || !reservations.reserve(s, `question:${id}`, { storageBytes: bytes + 3 * reservations.limits.settlementBytes })) throw failure("busy", "No capacity for an approval");
		const fields = { writer: "harness", modelVisible: false, turnId: gate.turnId, stepId: call.stepId, toolCallId: call.id };
		try {
			const records = await this.operations.commit(s, [
				{ ...fields, id: entryId, kind: "inputRequest", requestId: id, data, sources: [gate.response.id] },
				{ ...fields, kind: "toolPending", data: { requestIds: [id] }, sources: [entryId] },
			], false, () => !s.suspended && !s.erasing && s.settings.approvalWait === "untilDeadline" && !s.running?.abort.signal.aborted &&
				![...s.entries.values()].some(e => e.toolCallId === call.id && ["toolStarted", "toolPending", "toolResult"].includes(e.kind)));
			if (!records.length) { this.operations.reservations().release(s, `question:${id}`); return denied("Call is no longer eligible"); }
		} catch (error) {
			if (!s.suspended) this.operations.reservations().release(s, `question:${id}`);
			throw error;
		}
		telemetryEvent("modular_agent.question.open", { "modular_agent.question.id": id, "modular_agent.question.kind": "approval" });
		this.scheduleApprovalExpiry(s);
		return { requestId: id, actorId: "harness", pending: true };
	}

	eligibleMember(s: Session, answerers: string[] | undefined, id: string) {
		const rights = this.operations.exitTurn(() => this.operations.exitConnection(() => this.operations.actorRights(s, id)));
		return (!answerers || answerers.includes(id)) && rights.includes("watch") && rights.includes("approve");
	}

	matchesApproval(w: WaitingApproval, call: ToolCall, s: Session) {
		const found = this.operations.findTool(s, call.name);
		const { call: original, source, definition } = w.binding;
		return w.intact && !!found && found.plugin !== INTERFACE_SOURCE && sameJson(original, call) &&
			source.plugin === found.plugin && source.toolSource === found.source.id && sameJson(definition, found.definition);
	}

	validWait(s: Session, w: WaitingApproval) {
		return w.intact && !!this.maximum && s.settings.approvalWait === "untilDeadline" &&
			w.request.timeLimitMs! <= this.maximum && w.request.deadlineAt! > this.operations.now();
	}

	private approvalRights(s: Session, w: WaitingApproval, route: ApprovalRoute | undefined, actor: string, principal: string): Authority[] {
		const raw = (w.entry.data as { request: InputRequest }).request;
		if (!route || !this.eligibleMember(s, raw.answerers, actor)) return [];
		return this.operations.exitTurn(() => this.operations.intersectRights(this.operations.actorRights(s, actor), this.operations.actorRights(s, principal), [...route.ceiling(s.id, actor, principal)]));
	}

	private async unchanged(w: WaitingApproval, route: ApprovalRoute, actor: string) {
		try { return await this.operations.exitTurn(() => route.unchanged(structuredClone(w.entry), actor)); }
		catch { return false; }
	}

	async presentApproval(s: Session, id: string, delivery: ApprovalDelivery) {
		await this.reconcileApprovals(s);
		const w = [...waitingApprovals(s).values()].find(w => w.request.id === id);
		if (!w) return false;
		const { actorId, submittedBy, routeId, handle } = delivery;
		const delivered = this.approvalDeliveries.get(s) ?? new Set();
		this.approvalDeliveries.set(s, delivered);
		for (const old of delivered) if (!old.present() || old.handle === handle && old.routeId === routeId && old.entryId === w.entry.id && old.actorId === actorId) delivered.delete(old);
		const route = this.approvalRoutes.get(routeId);
		const eligible = () => {
			const item = waitingApprovals(s).get(w.request.toolCallId!);
			const rights = this.approvalRights(s, w, route, actorId, submittedBy);
			return !s.closed && !s.suspended && !s.erasing && !!item?.end && !item.decision && !item.result && !item.start && this.validWait(s, item) &&
				rights.includes("watch") && rights.includes("approve") && delivery.present();
		};
		if (!route || !eligible() || !await this.unchanged(w, route, actorId) || !eligible()) return false;
		delivered.add({ ...delivery, entryId: w.entry.id });
		return true;
	}

	async decideWaiting(s: Session, request: InputRequest, answer: Answer, handle?: object) {
		const span = startOperation("modular_agent.question.answer", { ...conversation(s.id), "modular_agent.turn.id": request.turnId });
		const decide = async () => {
			await this.reconcileApprovals(s);
			const w = waitingApprovals(s).get(request.toolCallId!);
			const submittedBy = answer.delegatedBy ?? answer.actorId;
			const deliveries = this.approvalDeliveries.get(s);
			if (!w || !answer.declined && answer.value !== "allow") return { accepted: false };
			let delivery, route;
			for (const d of deliveries ?? []) {
				if (d.handle !== handle || d.entryId !== w.entry.id || d.actorId !== answer.actorId || d.submittedBy !== submittedBy) continue;
				const policy = this.approvalRoutes.get(d.routeId);
				if (d.present() && policy && await this.unchanged(w, policy, answer.actorId)) { delivery = d; route = policy; break; }
				deliveries!.delete(d);
			}
			if (!delivery || !route) return { accepted: false };
			const acceptedRoute = route, delivered = delivery;
			const rights = () => this.approvalRights(s, w, acceptedRoute, answer.actorId, submittedBy);
			const proof = { requestEntryId: w.entry.id, routeId: route.id, submittedBy, rights: rights() };
			const body = { requestId: request.id, actorId: answer.actorId, ...(answer.declined ? { declined: true, reason: answer.reason } : { value: "allow", approvalView: proof }) };
			const id = this.operations.newId();
			const drafts: EntryDraft[] = [{ id, kind: "inputAnswer", writer: "harness", modelVisible: false, actorId: answer.actorId, requestId: request.id,
				toolCallId: request.toolCallId, turnId: request.turnId, stepId: w.entry.stepId, sources: [w.entry.id], data: body }];
			if (answer.declined) drafts.push(this.approvalResult(s, w, "refused", "The approver declined", id));
			const entries = await this.operations.commit(s, drafts, false, () => {
				const current = waitingApprovals(s).get(request.toolCallId!);
				proof.rights = rights();
				return !s.suspended && !s.closing && !s.erasing && !s.moving && this.approvalRoutes.get(acceptedRoute.id) === acceptedRoute && deliveries!.has(delivered) && delivered.present() &&
					!!current?.end && !current.start && !current.result && !current.decision && this.validWait(s, current) && proof.rights.includes("watch") && proof.rights.includes("approve");
			});
			if (!entries.length) { await this.reconcileApprovals(s); return { accepted: false }; }
			this.waitingClosed(s, w, answer, answer.declined ? "declined" : "answered");
			if (answer.declined) this.operations.toolDisposition(w.binding.call, "refused");
			this.operations.maybeContinueOpenCalls(s, currentSpan());
			return { accepted: true };
		};
		return span.observe(decide);
	}

	private waitingClosed(s: Session, w: WaitingApproval, answer: Answer, disposition: string) {
		const deliveries = this.approvalDeliveries.get(s);
		for (const d of deliveries ?? []) if (d.entryId === w.entry.id) deliveries!.delete(d);
		for (const i of this.operations.interfaces()) i.onInputRequestClosed?.(w.request.id);
		telemetryEvent("modular_agent.question.close", { "modular_agent.question.id": w.request.id, "modular_agent.question.kind": "approval", "modular_agent.question.disposition": disposition });
		this.operations.emitAnswer(s, w.request, answer, true);
	}

	private approvalResult(s: Session, w: WaitingApproval, status: "notStarted" | "refused" | "outcomeUnknown", message: string, decisionId?: string): EntryDraft {
		const continuation = s.branch().find(e => e.kind === "turnStart" && e.continuesTurnId === w.entry.turnId && !e.erased);
		return { kind: "toolResult", writer: "harness", modelVisible: true, turnId: continuation?.turnId ?? w.entry.turnId, stepId: w.entry.stepId, toolCallId: w.request.toolCallId,
			sources: [w.entry.id, ...(decisionId ? [decisionId] : []), ...(w.start ? [w.start.id] : [])],
			message: { role: "toolResult", toolCallId: w.request.toolCallId!, toolName: w.binding.call?.name ?? "", isError: true, content: [text(message)] }, data: { status } };
	}

	async closeWaiting(s: Session, w: WaitingApproval, reason: string, status: "refused" | "notStarted" | "outcomeUnknown", erasing = false) {
		const run = async () => {
			const id = w.decision?.id ?? this.operations.newId();
			const body = { requestId: w.request.id, declined: true, reason,
				...(reason === "noLongerAnswerable" && s.revokedQuestions.has(w.request.id) && {cause:"revoked" as const}) };
			const drafts: EntryDraft[] = w.decision ? [] : [{ kind: "inputAnswer", id, writer: "harness", modelVisible: false, turnId: w.entry.turnId, stepId: w.entry.stepId,
				toolCallId: w.entry.toolCallId, requestId: w.request.id, data: body, sources: [w.entry.id] }];
			drafts.push(this.approvalResult(s, w, status, reason, id));
			const guard = () => {
				const item = waitingApprovals(s).get(w.entry.toolCallId!);
				return item?.entry === w.entry && !item.result && item.start === w.start && item.decision === w.decision;
			};
			const entries = erasing ? guard() && await this.operations.commitNow(s, drafts.map(draft => ({
				...draft, erased: true, modelVisible: false, data: undefined, message: undefined, sources: undefined,
			}))) : await this.operations.commit(s, drafts, false, guard);
			if (!entries || !entries.length) return;
			if (!w.decision) this.waitingClosed(s, w, { ...body, actorId: "harness" }, reason);
			if (w.binding.call) this.operations.toolDisposition(w.binding.call, status);
		};
		if (activeOperation()?.isOpen) await run();
		else await startOperation("modular_agent.question.answer", { ...conversation(s.id), "modular_agent.turn.id": w.entry.turnId }).observe(run);
	}

	private scheduleApprovalExpiry(s: Session) {
		clearTimeout(this.approvalTimer.get(s));
		const deadlines = [...waitingApprovals(s).values()].filter(w => w.intact && !w.result && !w.start).map(w => w.request.deadlineAt!);
		if (!deadlines.length || s.suspended || s.closing || s.closed) return;
		const ms = Math.max(1, Math.min(2_147_483_647, Math.min(...deadlines) - this.operations.now()));
		const timer = setTimeout(() => void withTrace(undefined, () => this.reconcileApprovals(s)).catch(error => this.operations.problem("harness", "approval expiry", error)), ms);
		this.approvalTimer.set(s, timer.unref());
	}

	async reconcileApprovals(s: Session, reopening = false) {
		if (!s.hasWaitingApprovals || s.erasing || s.closed || s.suspended || s.closing) return;
		const deliveries = this.approvalDeliveries.get(s);
		const waits = waitingApprovals(s);
		for (const d of deliveries ?? []) {
			const w = [...waits.values()].find(w => w.entry.id === d.entryId);
			const rights = w && this.approvalRights(s, w, this.approvalRoutes.get(d.routeId), d.actorId, d.submittedBy);
			if (!w || w.result || w.decision || !d.present() || !rights?.includes("watch") || !rights.includes("approve")) deliveries!.delete(d);
		}
		for (const w of waits.values()) {
			if (w.result) continue;
			if (w.start) {
				if (reopening) await this.closeWaiting(s, w, "The tool started before interruption", "outcomeUnknown");
				continue;
			}
			if (!w.intact || !this.maximum) await this.closeWaiting(s, w, "noLongerAnswerable", "notStarted");
			else if (w.request.deadlineAt! <= this.operations.now()) await this.closeWaiting(s, w, "timeLimit", "notStarted");
			else if (w.decision && !this.approvalPrincipalsAllow(s, w)) {
				await this.closeWaiting(s, w, "refused", "refused");
			} else if (!this.validWait(s, w)) await this.closeWaiting(s, w, "refused", "refused");
			else if (!w.decision && ![...s.actors.keys()].some(id => this.eligibleMember(s, (w.entry.data as { request: InputRequest }).request.answerers, id))) await this.closeWaiting(s, w, "noLongerAnswerable", "refused");
		}
		this.scheduleApprovalExpiry(s);
		this.operations.maybeContinueOpenCalls(s);
	}
}
