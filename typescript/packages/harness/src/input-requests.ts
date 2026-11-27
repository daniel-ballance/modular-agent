import { connectionRights } from "./connection-authority.js";
import { SessionErasure } from "./session-erasure.js";
import { ApprovalReconciliation } from "./approval-reconciliation.js";
import { failure } from "./failure.js";
import { waitingApprovals, type ApprovalBinding } from "./waiting-approval.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { activeOperation, conversation, currentSpan, startOperation, telemetryEvent } from "./telemetry.js";
import { Reservations, resourceBytes } from "./reservations.js";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { INTERFACE_SOURCE } from "./interface-tools.js";
import { Session } from "./session.js";
import { type AgentEvent, type Answer, type Authority, type CredentialStore, type SecretScope, type EntryDraft, type HistoryEntry, type InputRequest, type InputRequestDraft, type InterruptedTurn, type InterfaceCapability, type Provider, type ToolCall, type ToolDefinition, type ToolSource } from "./types.js";

interface InputRequestsOperations {
	useAll<T>(capability: string): T[];
	actorRights(s: Session, actorId: string): Authority[];
	turnAuthority(): Pick<AsyncLocalStorage<unknown>, "exit">;
	approvals(): Pick<ApprovalReconciliation, "eligibleMember" | "maximum" | "parkApproval" | "decideWaiting">;
	maybeContinueOpenCalls(s: Session, trace?: ReturnType<typeof currentSpan>): void;
	use<T>(capability: string): T | undefined;
	home(): string;
	commit(s: Session, drafts: EntryDraft[], pluginRecord?: boolean, guard?: () => boolean | Promise<boolean>): Promise<HistoryEntry[]>;
	toolWork(): Pick<AsyncLocalStorage<ToolCall>, "getStore">;
	questionsOutlastTurns(): boolean;
	approvalPass(): Pick<AsyncLocalStorage<{ callId: string; attempt: string; inherited?: { toolCallId: string; requestId: string; actorId: string }; allow?: { toolCallId: string; requestId: string; actorId: string } }>, "getStore">;
	gateSignal(): Pick<AsyncLocalStorage<AbortSignal | undefined>, "getStore">;
	erasure(): Pick<SessionErasure, "admitHistory" | "reconcilePending">;
	newId(): string;
	findTool(s: Session | undefined, name: string): { plugin: string; source: ToolSource; definition: ToolDefinition } | undefined;
	modelGate(): Pick<AsyncLocalStorage<{ response: HistoryEntry; actorId: string; turnId: string; callId: string }>, "getStore">;
	emit(session: string | Session, type: string, data: any, source: string, ids?: Partial<AgentEvent>): void;
	reservations(): Reservations;
	problem(plugin: string, where: string, error: unknown): void;
	openCalls(s: Session): InterruptedTurn["calls"];
}

export class InputRequests {
	constructor(private readonly operations: InputRequestsOperations) {}

	private connections = new Set<InterfaceCapability>();

	connectInterface(part: InterfaceCapability): () => void {
		this.connections.add(part);
		return () => { this.connections.delete(part); };
	}

	interfaces(): InterfaceCapability[] {
		return [...this.operations.useAll<InterfaceCapability>("interface"), ...this.connections];
	}

	presentActors(s: Session, request?: InputRequest): string[] {
		return [...new Set(this.interfaces().filter((i) => i.present?.(s.id, request) !== false)
			.flatMap((i) => [i.actorId, ...(i.presentActors?.(s.id) ?? [])]))].filter((id) => s.actors.has(id));
	}

	private mayAnswer(s: Session, request: InputRequest, actorId: string): boolean {
		const actor = s.actors.get(actorId);
		if (!actor) return false;
		if (request.answerers.length && !request.answerers.includes(actorId)) return false;
		return this.operations.actorRights(s, actorId).includes(request.kind === "approval" ? "approve" : "answer");
	}

	private hasAnswerer(s: Session, request: InputRequest): boolean {
		const candidates = request.kind === "approval" ? this.presentActors(s, request) : [...s.actors.keys()];
		return candidates.some(id => this.mayAnswer(s, request, id));
	}

	hasQuestionRoute(s: Session, r: InputRequest) {
		return this.operations.turnAuthority().exit(() => connectionRights.exit(() => r.approvalWait
			? [...s.actors.keys()].some(id => this.operations.approvals().eligibleMember(s, r.answerers.length ? r.answerers : undefined, id))
			: this.hasAnswerer(s, r)));
	}

	async closeUnanswerable(s: Session) {
		const closed = [];
		for (const { request, resolve } of s.requests.values()) {
			if (!this.hasQuestionRoute(s, request)) {
				closed.push(resolve({ requestId: request.id, actorId: "harness", declined: true, reason: request.kind === "approval" ? "refused" : "noLongerAnswerable",
					...(s.revokedQuestions.has(request.id) && {cause:"revoked" as const}) }));
			}
		}
		await Promise.all(closed);
	}

	async closeRevokedWaits(s: Session) {
		await this.closeUnanswerable(s);
		for (const r of this.waitingRequests(s)) {
			if (r.approvalWait || !s.revokedQuestions.has(r.id) || this.hasQuestionRoute(s, r)) continue;
			s.lateAnswers.add(r.id);
			try {
				const answer: Answer = {requestId:r.id, actorId:"harness", declined:true, reason:"noLongerAnswerable", cause:"revoked"};
				await this.recordAnswer(s, r, answer);
				s.waiting.delete(r.id);
				this.emitAnswer(s, r, answer, true);
			} finally { s.lateAnswers.delete(r.id); }
			this.operations.maybeContinueOpenCalls(s);
		}
	}

	recordedOpenQuestionEntries(s: Session, branch: HistoryEntry[]) {
		const settled = new Set(s.order.map(id => s.entries.get(id)!).filter(e =>
			e.kind === "inputAnswer" || e.kind === "inputClosed" || e.kind === "secretAnswerAccepted").map(e => e.requestId));
		return branch.filter(e => e.kind === "inputRequest" && !s.copied.has(e.id) && !e.erased && e.requestId && !settled.has(e.requestId));
	}

	recordedOpenRequests(s: Session): InputRequest[] {
		return this.recordedOpenQuestionEntries(s, s.branch()).map(readRequest);
	}

	private recordedAnswer(s: Session, draft: BoundRequest, approval?: ApprovalBinding): { request: InputRequest; answer?: Answer } | undefined {
		const branch = s.branch();
		const entry = [...branch].reverse().find((e) => e.kind === "inputRequest" && !e.erased && readRequest(e).key === draft.key);
		if (!entry) return undefined;
		const request = readRequest(entry);
		if (request.approvalWait || request.kind !== draft.kind || request.question !== draft.question || request.details !== draft.details
			|| JSON.stringify(request.options ?? []) !== JSON.stringify(draft.options ?? [])
			|| (request.credential ?? undefined) !== (draft.credential ?? undefined) || request.toolCallId !== draft.toolCallId) return undefined;
		if (approval?.call.startedBy === "tool") {
			const prior = entry.data as Partial<ApprovalBinding> | undefined;
			const exact = (value: unknown) => JSON.parse(JSON.stringify(value));
			if (!prior?.call || !prior.source || !prior.definition ||
				!isDeepStrictEqual(exact(approval), exact({ call: prior.call, source: prior.source, definition: prior.definition }))) return undefined;
		}
		const bound = (request as BoundRequest).boundCall;
		if (bound && !isDeepStrictEqual(bound, draft.boundCall)) return undefined;
		if (branch.some((e) => e.kind === "inputClosed" && (e.data as { requestId: string }).requestId === request.id)) return undefined;
		const answered = branch.find((e) => e.kind === "inputAnswer" && !e.erased && e.requestId === request.id);
		if (!answered) return { request };
		const body = answered.data as Answer & { answer?: Answer };
		const answer = body.answer ?? body;
		if (request.kind === "secret" && (answer.reason === "restart" || !answer.declined &&
			!branch.some(e => !e.erased && e.kind === "secretAnswerAccepted" && e.requestId === request.id))) return undefined;
		// A secret's recorded answer holds only where it was stored, so it can be reused like any other.
		// A recorded allow counts only if whoever gave it may still answer.
		if (!answer.declined && !this.mayAnswer(s, request, answer.actorId)) return undefined;
		return { request, answer };
	}

	private secretStore() {
		const store = this.operations.use<CredentialStore>("credential-store");
		return store?.stage && store.lookupStaged && store.activate && store.discard
			? store as CredentialStore & Required<Pick<CredentialStore, "stage" | "lookupStaged" | "activate" | "discard">> : undefined;
	}

	private secretScope(s: Session, requestId: string): SecretScope {
		return { deployment: resolve(this.operations.home()), sessionId: s.id, requestId };
	}

	async recordAnswer(s: Session, request: InputRequest, answer: Answer, stepId?: string, acceptSecret = false): Promise<Answer> {
		const fields = { writer: "harness", modelVisible: false, turnId: request.turnId, stepId,
			requestId: request.id, toolCallId: request.toolCallId, actorId: answer.actorId };
		let kept = answer;
		if (request.kind === "secret" && !answer.declined) {
			if (acceptSecret && !(await this.operations.commit(s, [{ ...fields, kind: "secretAnswerAccepted" }])).length) throw failure("lost", "Secret acceptance did not commit");
			let outcome;
			try { outcome = await this.secretStore()!.activate(this.secretScope(s, request.id)); }
			catch { throw new Error("Could not confirm secret activation"); }
			kept = outcome === "activated" ? { requestId: request.id, actorId: answer.actorId, stored: request.credential }
				: { requestId: request.id, actorId: answer.actorId, declined: true, reason: "superseded" };
		}
		const record = async () => {
			const systemClosure = kept.actorId === "harness" && kept.declined;
			const [entry] = await this.operations.commit(s, [{ ...fields, kind: "inputAnswer", actorId:systemClosure ? undefined : kept.actorId,
				data:systemClosure ? {requestId:kept.requestId, declined:true, reason:kept.reason, ...(kept.cause && {cause:kept.cause})} : kept }]);
			if (!entry) throw failure("lost", "Answer did not commit");
			const system = kept.actorId === "harness" && kept.reason &&
				["cancelled", "noLongerAnswerable", "restart", "timeLimit", "superseded", "refused", "erased"].includes(kept.reason) ? kept.reason : undefined;
			telemetryEvent("modular_agent.question.close", { "modular_agent.question.id": request.id,
				"modular_agent.question.kind": request.kind, "modular_agent.question.disposition": kept.declined ? system ?? "declined" : kept.stored ? "stored" : "answered" });
		};
		if (activeOperation()?.isOpen && activeOperation()?.spanContext) await record();
		else await startOperation("modular_agent.question.answer", { ...conversation(s.id), "modular_agent.turn.id": request.turnId, "modular_agent.step.id": stepId }).observe(record);
		if (request.kind === "secret" && kept.declined) await this.discardSecret(s, request.id);
		return kept;
	}

	private async discardSecret(s: Session, requestId: string): Promise<void> {
		try { await this.secretStore()?.discard(this.secretScope(s, requestId)); }
		catch { throw new Error("Could not discard secret staging"); }
	}

	async recoverSecrets(s: Session): Promise<void> {
		const entries = s.order.map(id => s.entries.get(id)!).filter(e => !s.copied.has(e.id));
		const decisions = new Map(entries.filter(e => e.kind === "secretAnswerAccepted").map(e => [e.requestId, e]));
		const answers = new Map(entries.filter(e => e.kind === "inputAnswer").map(e => [e.requestId, e]));
		for (const entry of entries) {
			if (entry.kind !== "inputRequest" || entry.erased) continue;
			const request = readRequest(entry);
			if (request.kind !== "secret") continue;
			const answer = answers.get(request.id);
			if (answer) {
				if (answer.erased || (answer.data as Answer)?.declined) await this.discardSecret(s, request.id);
				continue;
			}
			const decision = decisions.get(request.id);
			if (decision?.actorId) {
				await this.recordAnswer(s, request, { requestId: request.id, actorId: decision.actorId }, entry.stepId);
			} else {
				// Do not let pre-decision staging win on reopen. If the Runtime asks again,
				// recordedAnswer ignores this closure and ask allocates a fresh identity.
				await this.recordAnswer(s, request, { requestId: request.id, actorId: "harness", declined: true, reason: "restart" }, entry.stepId);
			}
		}
	}

	async deferTool(s: Session, turnId: string | undefined, question: InputRequestDraft, plugin: string) {
		const call = this.operations.toolWork().getStore();
		if (!this.operations.questionsOutlastTurns() || !call || !turnId || turnId !== s.running?.turnId || call.startedBy !== "model" || question.kind === "approval") {
			return { refuse: "This call cannot wait for a late answer" };
		}
		const answer = await this.ask(s, { ...question, toolCallId: call.id, key: `gate:${call.id}:${plugin}:${question.key ?? "question"}`,
			timeLimitMs: 0, whenTimeLimit: "leaveOpen" }, plugin, s.running.abort.signal);
		if (!answer.pending) return answer.declined ? { refuse: answer.reason ?? "The gate question was declined" } : undefined;
		await this.operations.commit(s, [{ kind: "toolPending", writer: "harness", modelVisible: false, turnId, stepId: call.stepId,
			toolCallId: call.id, data: { requestIds: [answer.requestId] } }]);
		return { pending: "Waiting for an answer to the gate" };
	}

	async ask(s: Session, draft: BoundRequest, askedBy: string, signal?: AbortSignal): Promise<Answer> {
		if ("approvalWait" in draft || "deadlineAt" in draft || "coversNested" in draft) throw failure("invalid_request", "Only the Harness sets the approval lifetime and coverage");
		const pass = this.operations.approvalPass().getStore();
		const call = this.operations.toolWork().getStore();
		if (pass && askedBy === "approval" && draft.kind === "approval" && call && call.id === draft.toolCallId && call.id === pass.callId) {
			if (call.parentCallId && pass.inherited) {
				return { requestId: pass.inherited.requestId, actorId: pass.inherited.actorId, value: "allow" };
			}
			if (!call.parentCallId) {
				// A repeated dispatch gets a fresh key. Only exact inputs within this gate pass can reuse the answer.
				const answer = await this.deliverQuestion(s, { ...draft, coversNested: true, key: draft.key + ":" + pass.attempt,
					question: draft.question + " This approval also covers its nested calls." }, askedBy, signal);
				if (!answer.declined && answer.value === "allow") pass.allow = { toolCallId: call.id, requestId: answer.requestId, actorId: answer.actorId };
				return answer;
			}
		}
		return this.deliverQuestion(s, draft, askedBy, signal);
	}

	private async deliverQuestion(s: Session, draft: BoundRequest, askedBy: string, signal?: AbortSignal): Promise<Answer> {
		const gateSignal = this.operations.gateSignal().getStore();
		signal = signal && gateSignal ? AbortSignal.any([signal, gateSignal]) : signal ?? gateSignal;
		signal?.throwIfAborted();
		await this.operations.erasure().admitHistory(s);
		if (draft.whenTimeLimit === "leaveOpen" && !this.operations.questionsOutlastTurns()) throw Object.assign(new Error("Questions cannot outlast the turn"), { code: "not_supported" });
		const call = this.operations.toolWork().getStore();
		if (call && call.id === draft.toolCallId) draft = { ...draft, boundCall: { name: call.name, input: call.input } };
		if (draft.kind === "secret" && (!draft.credential || !this.secretStore() ||
			this.operations.useAll<Provider>("provider").some(p => p.id === draft.credential))) {
			return { requestId: "", declined: true, actorId: "harness", reason: "A secret needs a credential name and a credential store to keep it" };
		}
		let request: InputRequest = { ...draft, id: this.operations.newId(), sessionId: s.id, askedBy, answerers: draft.answerers ?? [], turnId: s.running?.turnId };
		const stepId = call?.stepId ?? (draft.toolCallId ? s.order.map((id) => s.entries.get(id)!).findLast((e) => e.kind === "toolStarted" && e.toolCallId === draft.toolCallId)?.stepId : undefined);
		const registered = draft.kind === "approval" && call ? this.operations.findTool(s, call.name) : undefined;
		const approval = registered && call ? { call, source: { plugin: registered.plugin, toolSource: registered.source.id }, definition: registered.definition } : undefined;
		const gate = this.operations.modelGate().getStore();
		if (draft.kind === "approval" && askedBy === "approval" && gate && approval && draft.toolCallId === gate.callId && approval.call.id === gate.callId && approval.call.startedBy === "model" && !approval.call.parentCallId &&
			approval.source.plugin !== INTERFACE_SOURCE && (this.operations.approvals().maximum && s.settings.approvalWait === "untilDeadline" || waitingApprovals(s).has(approval.call.id))) {
			return this.operations.approvals().parkApproval(s, draft, approval, gate);
		}
		let reopened = false;
		if (draft.key) {
			// Changed input or registration needs a new approval identity, not a replay of the old one.
			let key = draft.coversNested || approval?.call.startedBy === "tool" ? draft.key + ":" + approvalKey(approval) : draft.key;
			if (draft.kind === "secret") {
				const branch = s.branch();
				for (const entry of branch) {
					if (entry.kind !== "inputRequest" || entry.erased) continue;
					const prior = readRequest(entry);
					if (prior.kind === "secret" && prior.key === key && branch.some(e => e.kind === "inputAnswer" &&
						e.requestId === prior.id && (e.data as Answer | undefined)?.reason === "restart")) key += ":" + prior.id;
				}
			}
			draft = { ...draft, key };
			request = { ...request, key };
			const recorded = this.recordedAnswer(s, draft, approval);
			if (recorded?.answer) {
				this.operations.emit(s, "input.request.reused", { requestId: recorded.request.id, key: draft.key }, "harness", { toolCallId: request.toolCallId });
				return recorded.answer;
			}
			if (recorded) {
				request = { ...recorded.request, turnId: s.running?.turnId ?? recorded.request.turnId };
				reopened = true;
			}
		}
		const viewers = this.viewersFor(s, request);
		if (!reopened) {
			const data = { request: { ...request, answerable: viewers.length > 0 }, ...approval };
			const bytes = resourceBytes(data) + 2048;
			const key = `question:${request.id}`;
			const unit = this.operations.reservations().limits.settlementBytes;
			if (bytes > this.operations.reservations().limits.entryBytes || !this.operations.reservations().reserve(s, key, { storageBytes: bytes + 3 * unit })) {
				throw failure("busy", "No capacity for the question and its closing records");
			}
			try {
				await this.operations.commit(s, [{ kind: "inputRequest", writer: askedBy, modelVisible: false, turnId: request.turnId, stepId,
					requestId: request.id, toolCallId: request.toolCallId, data }]);
			} catch (error) {
				if (!s.interruption.signal.aborted) this.operations.reservations().release(s, key);
				throw error;
			}
		}
		telemetryEvent("modular_agent.question.open", { "modular_agent.question.id": request.id, "modular_agent.question.kind": request.kind });
		if (!this.hasAnswerer(s, request)) {
			const approval = request.kind === "approval";
			const answer = { requestId: request.id, declined: true, actorId: "harness", reason: approval ? "refused" : "noLongerAnswerable" };
			await this.recordAnswer(s, request, answer, stepId);
			this.emitAnswer(s, request, answer);
			return approval ? { ...answer, reason: "No one present can answer" } : answer;
		}
		return new Promise<Answer>((resolve, reject) => {
			const cancel = () => void open.resolve({ requestId: request.id, declined: true, actorId: "harness", reason: "cancelled" });
			const open = {
				request,
				resolve: (answer: Answer) => {
					signal?.removeEventListener("abort", cancel);
					if (open.timer) clearTimeout(open.timer);
					s.requests.delete(request.id);
					s.lateAnswers.add(request.id);
					for (const i of viewers) i.onInputRequestClosed?.(request.id);
					if (s.suspended) { const declined = { ...answer, declined: true }; resolve(declined); return Promise.resolve(declined); }
					const work = this.recordAnswer(s, request, answer, stepId, request.kind === "secret" && !answer.declined).then(kept => {
						this.emitAnswer(s, request, kept);
						s.lateAnswers.delete(request.id);
						resolve(kept);
						return kept;
					}, error => { reject(error); throw error; });
					void work.catch(error => this.operations.problem("harness", "record answer", error));
					return work;
				},
				timer: undefined as NodeJS.Timeout | undefined,
			};
			if (request.timeLimitMs !== undefined) {
				open.timer = setTimeout(() => {
					if (request.kind === "approval" || request.whenTimeLimit !== "leaveOpen") return open.resolve({ requestId: request.id, declined: true, actorId: "harness", reason: "timeLimit" });
					// Leave the question open past its turn. Interfaces keep showing it.
					signal?.removeEventListener("abort", cancel);
					s.requests.delete(request.id);
					s.waiting.add(request.id);
					this.operations.emit(s, "input.request.waiting", { requestId: request.id }, "harness", { toolCallId: request.toolCallId });
					resolve({ requestId: request.id, actorId: "harness", pending: true });
				}, request.timeLimitMs);
			}
			s.requests.set(request.id, open);
			if (signal?.aborted) return cancel();
			signal?.addEventListener("abort", cancel, { once: true });
			this.operations.emit(s, "input.request.opened", { request, reopened }, askedBy, { toolCallId: request.toolCallId });
			for (const i of viewers) i.onInputRequest?.(request);
		});
	}

	viewersFor(s: Session, request: InputRequest): InterfaceCapability[] {
		return this.interfaces().filter((i) => i.present?.(s.id, request) !== false && (this.operations.actorRights(s, i.actorId).includes("watch") || this.mayAnswer(s, request, i.actorId)));
	}

	waitingRequests(s: Session): InputRequest[] {
		const calls = new Set(this.operations.openCalls(s).map((c) => c.id));
		return this.recordedOpenRequests(s).filter((r) => (s.waiting.has(r.id) || calls.has(r.toolCallId ?? "") || r.turnId !== s.running?.turnId)
			&& !s.requests.has(r.id) && !s.lateAnswers.has(r.id) && (r.approvalWait !== "untilDeadline" || !!waitingApprovals(s).get(r.toolCallId!)?.end));
	}

	private async answerLate(s: Session, answer: Answer): Promise<{ accepted: boolean; reason?: string }> {
		const request = this.waitingRequests(s).find((r) => r.id === answer.requestId);
		if (!request || request.approvalWait) return { accepted: false, reason: "The request is closed or can no longer be answered" };
		if (!this.mayAnswer(s, request, answer.actorId)) return { accepted: false, reason: `${answer.actorId} may not answer this request` };
		s.lateAnswers.add(request.id);
		const previous = s.settling ?? Promise.resolve();
		const span = startOperation("modular_agent.question.answer", { ...conversation(s.id), "modular_agent.turn.id": request.turnId });
		const work = previous.then(() => span.observe(async () => {
			const kept = await this.recordAnswer(s, request, answer,
				s.order.map(id => s.entries.get(id)!).find(e => e.requestId === request.id)?.stepId,
				request.kind === "secret" && !answer.declined);
			s.lateAnswers.delete(request.id);
			for (const i of this.viewersFor(s, request)) i.onInputRequestClosed?.(request.id);
			this.emitAnswer(s, request, kept, true);
			s.waiting.delete(request.id);
			this.operations.maybeContinueOpenCalls(s, currentSpan());
			return kept;
		}));
		s.settling = work.then(() => {}, error => this.operations.problem("harness", "late answer", error)).finally(() => {
			if (s.settling === tracked) s.settling = undefined;
		});
		const tracked = s.settling;
		const kept = await work;
		return { accepted: !kept.declined || !!answer.declined };
	}

	emitAnswer(s: Session, request: InputRequest, answer: Answer, late = false): void {
		const ids = { actorId: answer.actorId, toolCallId: request.toolCallId, turnId: request.turnId };
		if (answer.reason === "noLongerAnswerable") this.operations.emit(s, "input.request.unanswerable", { requestId: request.id }, "harness", ids);
		if (answer.actorId !== "harness") this.operations.emit(s, "input.request.answered", { requestId: request.id, declined: answer.declined ?? false }, "harness", ids);
		this.operations.emit(s, "input.request.closed", { requestId: request.id, declined: answer.declined ?? false, value: answer.value, late }, "harness", ids);
	}

	async submitAnswer(s: Session, answer: Answer, handle?: object): Promise<{ accepted: boolean; reason?: string }> {
		if (resourceBytes(answer) + 2048 > this.operations.reservations().limits.settlementBytes) throw failure("result_too_large", "Answer exceeds reserved capacity");
		const find = () => s.requests.get(answer.requestId)?.request ?? this.waitingRequests(s).find(r => r.id === answer.requestId);
		const may = (request: InputRequest) => this.mayAnswer(s, request, answer.actorId) &&
			(!answer.delegatedBy || this.mayAnswer(s, { ...request, answerers: [] }, answer.delegatedBy));
		const request = find();
		if (!request || !may(request)) return { accepted: false };
		if (request.approvalWait) return this.operations.approvals().decideWaiting(s, request, answer, handle);
		await this.operations.erasure().reconcilePending(s);
		if (!find() || !isDeepStrictEqual(find(), request)) return { accepted: false };
		if (request.kind === "secret" && !answer.declined) {
			const store = this.secretStore();
			if (!store || !request.credential || typeof answer.value !== "string") return { accepted: false };
			const scope = { ...this.secretScope(s, request.id), credential: request.credential, actorId: answer.actorId };
			try {
				const staged = await store.stage(scope, answer.value);
				if (!staged) return { accepted: false };
				const receipt = await store.lookupStaged(scope);
				if (!receipt || receipt.receipt !== staged.receipt || !Object.entries(scope).every(([k, value]) => receipt[k as keyof typeof scope] === value)) {
					await this.discardSecret(s, request.id);
					return { accepted: false };
				}
			} catch { throw new Error("Could not stage the secret answer"); }
			if (!find() || !may(request)) {
				await this.discardSecret(s, request.id);
				return { accepted: false };
			}
			answer = { requestId: answer.requestId, actorId: answer.actorId, delegatedBy: answer.delegatedBy };
		}
		const open = s.requests.get(request.id);
		if (!open) return this.answerLate(s, answer);
		const kept = await open.resolve(answer);
		return { accepted: !kept.declined || !!answer.declined };
	}
}

function approvalKey(binding?: ApprovalBinding): string {
	return createHash("sha256").update(JSON.stringify(binding ?? null, (_, value) =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value)).digest("hex");
}

type BoundRequest = InputRequestDraft & { coversNested?: true; boundCall?: Pick<ToolCall, "name" | "input"> };

export function readRequest(entry: HistoryEntry): InputRequest {
	const request = (entry.data as { request: InputRequest }).request;
	if (!entry.requestId || entry.requestId !== request.id) throw failure("unavailable", "Question identity does not match its envelope");
	return { ...request, sessionId: entry.sessionId, answerers: request.answerers ?? [], toolCallId: entry.toolCallId ?? request.toolCallId ?? undefined, turnId: entry.turnId ?? request.turnId ?? undefined };
}
