import { lowerReasoning, parseModel, REASONING_LEVELS } from "./settings.js";
import { TurnModelAccess } from "./model-access.js";
import { ToolDispatch } from "./tool-dispatch.js";
import type { TurnState } from "./turn-state.js";
import { shapeViolation } from "./result-shape.js";
import { InterfaceToolRoutes } from "./interface-tool-routes.js";
import { connectionRights, intersectConnectionRights, type ConnectionRights } from "./connection-authority.js";
import { InputRequests } from "./input-requests.js";
import { SessionErasure } from "./session-erasure.js";
import { ApprovalReconciliation } from "./approval-reconciliation.js";
import { failure, turnLimit } from "./failure.js";
import { waitingApprovals } from "./waiting-approval.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { activeOperation, carrier, conversation, currentSpan, historyForPeer, readTrace, startOperation, TURN_TRACE, withTrace, type Operation } from "./telemetry.js";
import { Reservations, resourceBytes } from "./reservations.js";
import { isDeepStrictEqual } from "node:util";
import { pendingToolCalls, restoreAnsweredStep } from "./view.js";
import { HookRegistry } from "./hooks.js";
import { INTERFACE_SOURCE, validReportContent } from "./interface-tools.js";
import { type QueuedInput, Session } from "./session.js";
import { interruptedNote, type AgentEvent, type Answer, type Authority, type ContentPart, type EntryDraft, type HistoryEntry, type HistoryStore, type InputRequest, type InterruptedTurn, type ModelAccess, type ModelInfo, type ModelMessage, type ModelRequest, type Provider, type Runtime, type RuntimeHost, type ToolCall, type ToolDefinition, type ToolSource, type TurnOutcome, type TurnSettings, type TurnSnapshot, type Usage, type WorkingEnvironment, addUsage, isToolCall, text, zeroUsage } from "./types.js";

type RecordedSnapshot = TurnSnapshot & { startedBy: QueuedInput["startedBy"]; resultShape?: Record<string, unknown> };
export function recordedSnapshot(start: HistoryEntry): RecordedSnapshot {
	const d = start.data as RecordedSnapshot | undefined;
	const id = (x: unknown) => typeof x === "string" && x.length > 0;
	const object = (x: unknown) => x != null && typeof x === "object" && !Array.isArray(x);
	const cap = (x?: number) => x === undefined || Number.isSafeInteger(x) && x > 0;
	if (!d || !id(d.startedBy?.id) || !["actor", "job", "plugin", "answer", "toolResult"].includes(d.startedBy.kind) ||
		d.model !== null && (!id(d.model?.id) || !id(d.model?.provider)) || typeof d.system !== "string" ||
		d.context !== undefined && !validReportContent(d.context) || !Array.isArray(d.tools) ||
		!d.tools.every(t => id(t?.name) && typeof t.description === "string" && (typeof t.parameters === "boolean" || object(t.parameters))) ||
		!object(d.settings) || !cap(d.settings.maxSteps) || !cap(d.settings.maxOutput) ||
		d.settings.reasoning !== undefined && !REASONING_LEVELS.some(level => level === d.settings.reasoning)) {
		throw failure("unavailable", "Cannot recover an incomplete turn snapshot");
	}
	return d;
}

interface TurnExecutionOperations {
	intersectRights(...ceilings: readonly Authority[][]): Authority[];
	commit(s: Session, drafts: EntryDraft[], pluginRecord?: boolean, guard?: () => boolean | Promise<boolean>): Promise<HistoryEntry[]>;
	newId(): string;
	problem(plugin: string, where: string, error: unknown): void;
	reservations(): Reservations;
	emit(session: string | Session, type: string, data: any, source: string, ids?: Partial<AgentEvent>): void;
	runtime(): Runtime | undefined;
	modelAccess(s: Session, ref?: ReturnType<typeof parseModel> | null): ModelAccess | undefined;
	interfaceTools(): Pick<InterfaceToolRoutes, "interfaceOffer" | "queuedOffers" | "interfaceSources" | "unsettledHandoffs" | "settleInterfaceCall" | "interfaceRecords" | "offerScope">;
	toolDefinitions(s?: Session): ToolDefinition[];
	turnAuthority(): Pick<AsyncLocalStorage<{ sessionId: string; actors: Set<string>; jobs: Set<string>; state?: Pick<TurnState, "connectionRights" | "startingRights"> }>, "run">;
	tenantBudgetReached(s: Session): Promise<boolean>;
	environmentFor(s: Session): Promise<WorkingEnvironment | undefined>;
	projectOf(s: Session): string;
	checkScopedWork(s: Session, right: Authority): void;
	erasure(): Pick<SessionErasure, "admitHistory">;
	hooks(): HookRegistry;
	use<T>(capability: string): T | undefined;
	turnModels(): Pick<TurnModelAccess, "turnModel">;
	agentName(): string | undefined;
	now(): number;
	approvals(): Pick<ApprovalReconciliation, "closeWaiting" | "reconcileApprovals">;
	questions(): Pick<InputRequests, "recordedOpenRequests" | "recordAnswer" | "emitAnswer" | "viewersFor">;
	admit<T>(s: Session, work: () => Promise<T>): Promise<T>;
	findTool(s: Session | undefined, name: string): { plugin: string; source: ToolSource; definition: ToolDefinition } | undefined;
	workRights(s: Session, actors: Iterable<string>, jobs?: Iterable<string>): Authority[];
	actorForJob(s: Session, jobs?: Set<string>): string | undefined;
	tools(): Pick<ToolDispatch, "toolGate" | "toolAfter" | "modelApprovalGate" | "toolDisposition" | "executeTool">;
	providerFor(s: Session, ref?: ReturnType<typeof parseModel> | null): Provider | undefined;
}

export class TurnExecution {
	constructor(private readonly operations: TurnExecutionOperations) {}

	/** Used when no Runtime is loaded: the turn ends as failed, and each pending call gets one result. */
	private async endInterruptedTurn(s: Session, interrupted: InterruptedTurn): Promise<void> {
		const drafts: EntryDraft[] = interrupted.calls.map((c) => ({
			kind: "toolResult", writer: "harness", modelVisible: true, turnId: interrupted.turnId, stepId: c.stepId, toolCallId: c.id,
			message: { role: "toolResult", toolCallId: c.id, toolName: c.name, content: [text(interruptedNote(c.started))], isError: true },
			data: { status: c.started ? "outcomeUnknown" : "notStarted" },
		}));
		if (drafts.length) await this.operations.commit(s, drafts);
	}

	startTurn(s: Session, queued: QueuedInput): void {
		void connectionRights.exit(() => this.launch(s, this.operations.newId(), (signal, turnId) => this.runTurn(s, queued, turnId, signal)));
	}

	/** Run a turn as the session's running turn, then start any queued input. */
	launch(s: Session, turnId: string, body: (signal: AbortSignal, turnId: string) => Promise<void>): Promise<void> {
		const abort = new AbortController();
		const signal = AbortSignal.any([abort.signal, s.interruption.signal]);
		const done = body(signal, turnId)
			.catch((error) => this.operations.problem("harness", "turn", error))
			.finally(() => {
				s.running = undefined;
				this.startQueued(s);
			});
		s.running = { turnId, abort, done };
		return done;
	}

	startQueued(s: Session): void {
		if (s.running || s.reopening || s.closed || s.closing || s.suspended || s.erasing || s.moving) return;
		const next = [...s.steering, ...s.followUps];
		s.steering = [];
		s.followUps = next.slice(1);
		if (next[0]) this.startTurn(s, next[0]);
	}

	private async runTurn(s: Session, queued: QueuedInput, turnId: string, signal: AbortSignal): Promise<void> {
		const continuesTurnId = queued.continueTurnId;
		if (continuesTurnId && !this.readyContinuations(s).some(item => item.origin === continuesTurnId)) return;
		const continuing = continuesTurnId ? this.openCalls(s, continuesTurnId) : undefined;
		if (continuesTurnId && !this.operations.reservations().reserve(s, `turn:${turnId}`, { storageBytes: 3 * this.operations.reservations().limits.settlementBytes })) {
			// No turn was admitted. Wake only exchanges waiting on this origin.
			this.operations.emit(s, "continuation.refused", { code: "busy" }, "harness", { turnId: continuesTurnId });
			return;
		}
		const runtime = this.operations.runtime();
		const ref = parseModel(s.settings.model);
		const model: ModelAccess | undefined = this.operations.modelAccess(s, ref) ?? (ref ? {
			model: { ...ref, contextWindow: 0, maxOutput: 0, reasoning: false, input: ["text"] },
			supports: { keepsState: false, runsTools: false },
			request: async () => ({ role: "assistant", content: [], stop: "failed", error: { kind: "other", message: `Model ${ref.provider}/${ref.id} is not offered` } }),
		} : undefined);
		const settings = this.turnSettings(s, model?.model);
		const modelTools = s.settings.modelTools;
		const interfaceOffer = this.operations.interfaceTools().interfaceOffer(s, this.operations.interfaceTools().queuedOffers.get(queued));
		const tools = this.operations.toolDefinitions(s).filter((t) => (!t.callers || t.callers.includes("model")) &&
			(!this.operations.interfaceTools().interfaceSources.has(t.name) || interfaceOffer.has(t.name)) &&
			(modelTools == null || (Array.isArray(modelTools) && modelTools.includes(t.name))));
		const resultShape = queued.resultShape ?? s.settings.resultShape as Record<string, unknown> | undefined;
		let point: string | undefined;
		const actors = new Set(inputActors(queued));
		const jobs = new Set([...(queued.authorityJobs ?? []), ...(queued.startedBy.kind === "job" ? [queued.startedBy.id] : [])]);
		const authority = { startingRights: queued.startingRights ?? [], connectionRights: queued.connectionRights };
		const withAuthority = <T>(work: () => T) => this.operations.turnAuthority().run({ sessionId: s.id, actors, jobs, state: authority }, work);
		let contributions: { system?: string; context?: ContentPart[] }[] = [];
		let failure: string | undefined;
		let limited = false;
		try {
			limited = await this.operations.tenantBudgetReached(s);
			if (!limited && !signal.aborted) {
				const env = await this.operations.environmentFor(s);
				if (env?.save && (env.keepsPoints?.(this.operations.projectOf(s)) ?? env.points)) {
					withAuthority(() => this.operations.checkScopedWork(s, "watch"));
					await this.operations.erasure().admitHistory(s);
					point = await env.save();
				}
				await this.operations.erasure().admitHistory(s);
				contributions = await withAuthority(() => this.operations.hooks().collect("turn.before", { sessionId: s.id, turnId, input: queued.content }));
			}
		} catch (error) { failure = String(error); }
		const context = contributions.flatMap((c) => c.context ?? []);
		let snapshot: TurnSnapshot = {
			model: ref ?? null,
			system: contributions.map((c) => c.system).filter(Boolean).join("\n\n"), tools, settings,
			...(context.length ? { context } : {}),
		};
		const unit = this.operations.reservations().limits.settlementBytes;
		if (resourceBytes({ ...snapshot, resultShape, point }) + 2048 > unit) {
			failure = "Turn preparation exceeds reserved capacity";
			snapshot = { model: ref ?? null, system: "", settings: {}, tools: [] };
		}
		const state: TurnState = { ...snapshot, ...authority, interfaceOffer, interfaceAllowances: new Map(), dispatched: new Set(), steps: new Map(), sources: new Map(), actors, jobs };
		const span = this.turnSpan(s, turnId, queued.trace ?? null, undefined, continuesTurnId);
		return span.run(async () => {
			try {
				// Kept turns can be settled after a restart even if their Runtime
				// cannot resume them. Save the original segment for any persistent history.
				const store = this.operations.use<HistoryStore>("history-store");
				const traceContext = store && store.supports.persistent !== false ? carrier(span.spanContext) : undefined;
				const [start] = await this.operations.commit(s, [
					{ kind: "turnStart", writer: "harness", modelVisible: false, turnId, continuesTurnId, actorId: queued.actorId, sources: queued.sources, data: { ...snapshot, ...(traceContext ? { traceContext } : {}), startedBy: queued.startedBy, resultShape: failure ? undefined : resultShape, point, rights: state.startingRights,
						authorizers: [...actors].map(actorId => ({ sessionId: s.id, actorId })), ...(continuing ? { authorityActors: [...actors], authorityJobs: [...jobs] } : {}) } },
					...(continuing ? [] : [this.inputEntry(s, queued, turnId)]),
				]);
				if (start && span.spanContext) this.turnTraces.set(start, span.spanContext);
				this.operations.emit(s, "turn.started", { startedBy: queued.startedBy }, "harness", { turnId });
				let outcome: TurnOutcome;
				if (limited) outcome = { outcome: { kind: "limit", limit: "tenantTokens" }, result: { openToolCalls: [] }, entries: [], usage: zeroUsage() };
				else if (failure) outcome = this.failedOutcome(failure);
				else if (!runtime) outcome = this.failedOutcome("No Runtime is loaded");
				else if (!model) outcome = this.failedOutcome("No model is selected, or its Provider is not loaded");
				else {
					try {
						const input = {
							sessionId: s.id, turnId, startedBy: queued.startedBy, model: this.operations.turnModels().turnModel(s, turnId, state, model),
							settings, resultShape,
						};
						const host = this.runtimeHost(s, turnId, state, resultShape);
						outcome = continuing ? await runtime.continueOpenCalls(input, host, signal, continuing) : await runtime.runTurn(input, host, signal);
					} catch (error) {
						outcome = this.failedOutcome(error instanceof Error ? error.message : String(error));
					}
				}
				await this.finishTurn(s, turnId, outcome, state, signal, resultShape);
			} finally { this.endSteps(state); span.end(); }
		});
	}

	private turnTraces = new WeakMap<HistoryEntry, NonNullable<ReturnType<typeof currentSpan>>>();

	private turnSpan(s: Session, turnId: string, parent: ReturnType<typeof readTrace> | null, resumed?: boolean, continuesTurnId?: string): Operation {
		const previous = continuesTurnId ? this.savedTrace(s, continuesTurnId) : undefined;
		const link = resumed ? parent : previous;
		return startOperation(this.operations.agentName() ? `invoke_agent ${this.operations.agentName()}` : "invoke_agent", {
			...conversation(s.id), "modular_agent.turn.id": turnId, "gen_ai.operation.name": "invoke_agent",
			"gen_ai.agent.name": this.operations.agentName(), "modular_agent.turn.outcome": "interrupted", "modular_agent.turn.resumed": resumed,
		}, { parent, links: link ? [link] : undefined });
	}

	private savedTrace(s: Session, turnId: string) {
		for (const entry of s.branch().reverse()) {
			if (entry.turnId !== turnId || entry.erased || s.copied.has(entry.id) || entry.writer !== "harness" ||
				(entry.kind !== "turnStart" && entry.kind !== TURN_TRACE)) continue;
			const saved = this.turnTraces.get(entry) ?? readTrace((entry.data as { traceContext?: unknown } | undefined)?.traceContext);
			if (saved) return saved;
		}
	}

	private async finishTurn(s: Session, turnId: string, outcome: TurnOutcome, state?: TurnState, signal?: AbortSignal, resultShape?: Record<string, unknown>): Promise<void> {
		if (state) this.endSteps(state);
		// The process stopped: the turn is interrupted, not ended. Nothing is recorded or announced here;
		// reopening the session finds the turn and hands it to the Runtime.
		if (s.suspended) return;
		if (state?.toolResultError && outcome.outcome.kind !== "limit" && outcome.outcome.kind !== "cancelled") {
			outcome = { ...outcome, outcome: { kind: "failed", error: state.toolResultError }, result: { openToolCalls: [] } };
		}
		if (state?.capacityLimit && outcome.outcome.kind !== "cancelled" && !signal?.aborted) {
			outcome = { ...outcome, outcome: { kind: "limit", limit: "capacity" } };
		}
		const responses = s.order.map((id) => s.entries.get(id)!)
			.filter((e) => e.turnId === turnId && e.kind === "response" && e.message?.role === "assistant");
		if (responses.length && (state?.tenantLimit || outcome.outcome.kind === "failed" || outcome.outcome.kind === "cancelled")) {
			// A Runtime whose callback failed may have lost its in-memory usage.
			const recorded = responses.reduce((usage, e) => addUsage(usage, e.message?.role === "assistant" ? e.message.usage : undefined), zeroUsage());
			if (tokenCount(recorded) > tokenCount(outcome.usage)) outcome = { ...outcome, usage: recorded };
		}
		if (signal?.aborted && outcome.outcome.kind !== "completed") outcome = { ...outcome, outcome: { kind: "cancelled" } };
		else if (outcome.outcome.kind !== "cancelled" && (state?.tenantLimit || (responses.length > 0 && await this.operations.tenantBudgetReached(s)))) {
			outcome = { ...outcome, outcome: { kind: "limit", limit: "tenantTokens" } };
		}
		if (outcome.outcome.kind === "completed" && resultShape) {
			const reason = shapeViolation(resultShape, outcome.result.value);
			if (reason !== undefined) {
				await this.operations.commit(s, [{ kind: "resultFeedback", writer: "harness", turnId, modelVisible: true, data: { reason } }]);
				outcome = { ...outcome, outcome: { kind: "failed", error: reason }, result: { ...outcome.result, value: undefined } };
			}
		}
		// Committed dispositions survive a lost or invalid Runtime outcome.
		const complete = async () => {
		for (const item of this.operations.interfaceTools().unsettledHandoffs(s)) {
			if ((item.checkpoint ?? item.start)?.turnId === turnId && (signal?.aborted || outcome.outcome.kind !== "completed" || !item.data || item.data.deadline <= this.operations.now())) {
				await this.operations.interfaceTools().settleInterfaceCall(s, item);
			}
		}
		if (signal?.aborted && this.operations.interfaceTools().interfaceSources.size) outcome = { ...outcome, outcome: { kind: "cancelled" } };
		for (const w of waitingApprovals(s).values()) {
			if (w.entry.turnId === turnId && !w.result && !w.start && (signal?.aborted || outcome.outcome.kind !== "completed")) {
				await this.operations.approvals().closeWaiting(s, w, signal?.aborted ? "cancelled" : "noLongerAnswerable", "notStarted");
			}
		}
		const branch = s.branch();
		const pending = pendingToolCalls(branch, turnId, s.order.map((id) => s.entries.get(id)!));
		const cancelled = outcome.outcome.kind === "cancelled";
		const open = new Set(cancelled ? [] : pending);
		outcome = { ...outcome, result: { ...outcome.result, openToolCalls: [...open] } };
		if (cancelled && pending.length) {
			const drafts = pending.map((id): EntryDraft => {
				const disposition = branch.findLast((e) => e.kind === "toolPending" && e.turnId === turnId && e.toolCallId === id);
				const offer = branch.find((e) => e.kind === "response" && e.message?.role === "assistant" && e.message.content.some((p) => isToolCall(p) && p.id === id));
				const call = offer?.message?.content.filter(isToolCall).find((p) => p.id === id);
				return { kind: "toolResult", writer: "harness", modelVisible: true, turnId, stepId: disposition?.stepId, toolCallId: id,
					message: { role: "toolResult", toolCallId: id, toolName: call?.name ?? "", content: [text("Cancelled while waiting for an answer")], isError: true },
					data: { status: "cancelled" } };
			});
			await this.operations.commit(s, drafts);
		}
		for (const request of this.operations.questions().recordedOpenRequests(s).filter((r) => r.turnId === turnId && !s.requests.has(r.id) && !s.lateAnswers.has(r.id) && !open.has(r.toolCallId ?? ""))) {
			const answer = { requestId: request.id, actorId: "harness", declined: true, reason: outcome.outcome.kind === "cancelled" ? "cancelled" : "noLongerAnswerable" };
			await this.operations.questions().recordAnswer(s, request, answer, s.order.map(id => s.entries.get(id)!).find(e => e.kind === "inputRequest" && e.requestId === request.id)?.stepId);
			this.operations.questions().emitAnswer(s, request, answer);
		}
		const sources = s.branch().filter((e) => e.turnId === turnId && (e.kind === "response" || e.kind === "toolResult")).map((e) => e.id);
		if (resourceBytes({ outcome: outcome.outcome, result: outcome.result, usage: outcome.usage, sources }) + 2048 > this.operations.reservations().limits.settlementBytes) {
			this.operations.problem("harness", "settle turn", failure("result_too_large", "Turn result exceeds reserved capacity"));
			outcome = { ...outcome, outcome: outcome.outcome.kind === "completed" ? { kind: "failed", error: "result_too_large" } : outcome.outcome,
				result: { openToolCalls: [...open] } };
		}
		await this.operations.commit(s, [{ kind: "turnEnd", writer: "harness", modelVisible: false, turnId, sources, data: { outcome: outcome.outcome, result: outcome.result, usage: outcome.usage } }]);
		return open;
		};
		const open = this.operations.interfaceTools().interfaceSources.size ? await this.operations.admit(s, complete) : await complete();
		activeOperation()?.set("modular_agent.turn.outcome", outcome.outcome.kind);
		if (outcome.outcome.kind === "failed") activeOperation()?.fail("failed");
		if (!state?.endedHook) await this.operations.hooks().observe("turn.end", { sessionId: s.id, turnId, outcome: outcome.outcome, result: outcome.result });
		this.operations.emit(s, "turn.ended", outcome, "harness", { turnId });
		if (s.hasWaitingApprovals) {
			await this.operations.approvals().reconcileApprovals(s);
			for (const w of waitingApprovals(s).values()) if (w.end?.turnId === turnId && !w.decision && !w.result) {
				this.operations.emit(s, "input.request.opened", { request: w.request, waiting: true }, "harness", { toolCallId: w.request.toolCallId });
				for (const i of this.operations.questions().viewersFor(s, w.request)) i.onInputRequest?.(w.request);
			}
		}
		if (open.size) this.maybeContinueOpenCalls(s);
	}

	async resumeTurn(s: Session, interrupted: InterruptedTurn, snapshot: RecordedSnapshot, signal: AbortSignal): Promise<void> {
		const turnId = interrupted.turnId;
		if (!this.operations.runtime()?.supports.continuesAfterRestart) return withTrace(undefined, () => this.resumeTurnWithin(s, interrupted, snapshot, signal));
		const saved = this.savedTrace(s, turnId);
		const span = this.turnSpan(s, turnId, saved ?? null, true);
		try {
			await span.run(async () => {
				const traceContext = carrier(span.spanContext);
				if (traceContext) await this.operations.commit(s, [{ kind: TURN_TRACE, writer: "harness", turnId, modelVisible: false, data: { traceContext } }]);
				await this.resumeTurnWithin(s, interrupted, snapshot, signal);
			});
		} finally { span.end(); }
	}

	private async resumeTurnWithin(s: Session, interrupted: InterruptedTurn, snapshot: RecordedSnapshot, signal: AbortSignal): Promise<void> {
		const turnId = interrupted.turnId;
		const runtime = this.operations.runtime();
		const model = this.operations.modelAccess(s, snapshot.model);
		if (!runtime || !model) {
			const pending = new Set(pendingToolCalls(s.branch(), turnId, s.order.map((id) => s.entries.get(id)!)));
			await this.endInterruptedTurn(s, { turnId, calls: interrupted.calls.filter((c) => !pending.has(c.id)) });
			await this.finishTurn(s, turnId, this.failedOutcome("The process stopped during the turn"), undefined, signal);
			return;
		}
		const branch = s.branch();
		const state: TurnState = {
			model: model.model, system: snapshot.system, context: snapshot.context, tools: snapshot.tools,
			settings: { ...snapshot.settings, reasoning: lowerReasoning(snapshot.settings.reasoning, model.model) },
			dispatched: new Set(), steps: new Map(), sources: new Map(), actors: new Set(this.recordedTurnActors(branch, turnId)),
			jobs: new Set(this.recordedTurnJobs(branch, turnId)),
			startingRights: this.recordedTurnRights(branch, turnId),
			connectionRights: intersectConnectionRights(...branch.filter(e => e.turnId === turnId && e.kind === "input" && !e.erased)
				.map(e => (e.data as QueuedInput | undefined)?.connectionRights)),
		};
		const kept = s.order.map((id) => s.entries.get(id)!);
		const pending = new Set(pendingToolCalls(branch, turnId, kept));
		const calls = interrupted.calls.filter((c) => !pending.has(c.id));
		let outcome: TurnOutcome;
		try {
			const restored = restoreAnsweredStep(branch, turnId, kept);
			const eligible = calls.filter((c) => {
				const offer = branch.find((e) => e.kind === "modelRequest" && e.stepId === c.stepId && !e.erased);
				return runtime.supports.continuesAfterRestart && !restored?.lastStep.decision && !c.started && this.operations.findTool(s, c.name) &&
					(offer?.data as { tools?: string[] } | undefined)?.tools?.includes(c.name) && state.startingRights?.includes("tools") && this.operations.workRights(s, [...state.actors], state.jobs).includes("tools");
			});
			await this.endInterruptedTurn(s, { turnId, calls: calls.filter((c) => !eligible.includes(c)) });
			outcome = await runtime.resumeTurn(
				{ sessionId: s.id, turnId, startedBy: snapshot.startedBy, model: this.operations.turnModels().turnModel(s, turnId, state, model), settings: state.settings, resultShape: snapshot.resultShape },
				this.runtimeHost(s, turnId, state, snapshot.resultShape, runtime.supports.continuesAfterRestart === true),
				signal,
				{ turnId, calls: eligible, ...(restored ? { lastStep: restored.lastStep } : {}) },
			);
		} catch (error) {
			outcome = this.failedOutcome(error instanceof Error ? error.message : String(error));
		}
		if (!s.suspended) {
			const keptNow = s.order.map((id) => s.entries.get(id)!);
			const terminal = new Set(keptNow.filter((e) => e.kind === "toolResult").map((e) => e.toolCallId));
			const open = new Set(pendingToolCalls(s.branch(), turnId, keptNow));
			await this.endInterruptedTurn(s, { turnId, calls: interrupted.calls.filter((c) => !terminal.has(c.id) && !open.has(c.id)) });
		}
		await this.finishTurn(s, turnId, outcome, state, signal, snapshot.resultShape);
	}

	recordedTurnRights(branch: HistoryEntry[], turnId: string): Authority[] {
		const records = branch.filter(e => e.turnId === turnId && !e.erased && (e.kind === "turnStart" || e.kind === "input"));
		const start = records.find(e => e.kind === "turnStart");
		const explicit = (start?.data as { rights?: Authority[] } | undefined)?.rights;
		const inputs = records.filter(e => e.kind === "input").map(e => {
			const data = e.data as { rights?: Authority[]; connectionRights?: ConnectionRights } | undefined;
			return data?.rights ?? (data?.connectionRights && this.operations.intersectRights(...Object.values(data.connectionRights))) ?? explicit ?? [];
		});
		return explicit || inputs.length ? this.operations.intersectRights(...(explicit ? [explicit] : []), ...inputs) : [];
	}

	recordedTurnActors(branch: HistoryEntry[], turnId: string): string[] {
		return branch.flatMap((e) => {
			if (e.turnId !== turnId || e.erased || (e.kind !== "input" && e.kind !== "turnStart")) return [];
			const d = e.data as { startedBy?: QueuedInput["startedBy"]; releasedBy?: string; delegatedBy?: string; authorityActors?: string[] } | undefined;
			if (e.jobId || d?.startedBy?.kind === "job") return [];
			const actor = e.actorId ?? (d?.startedBy?.kind === "actor" ? d.startedBy.id : undefined);
			return [actor, d?.releasedBy, d?.delegatedBy, ...(d?.authorityActors ?? [])].filter((id): id is string => typeof id === "string");
		});
	}

	recordedTurnJobs(branch: HistoryEntry[], turnId: string): string[] {
		return branch.flatMap((e) => {
			if (e.turnId !== turnId || e.kind !== "turnStart" || e.erased) return [];
			const d = e.data as { startedBy?: QueuedInput["startedBy"]; authorityJobs?: string[] } | undefined;
			return d?.startedBy?.kind === "job" ? [d.startedBy.id] : d?.authorityJobs ?? [];
		});
	}

	turnSettings(s: Session, model?: ModelInfo): TurnSettings {
		return { maxSteps: s.settings.maxSteps as number | undefined, reasoning: lowerReasoning(s.settings.reasoning, model), maxOutput: s.settings.maxOutput as number | undefined };
	}

	private inputEntry(s: Session, q: QueuedInput, turnId: string): EntryDraft {
		const jobId = q.startedBy.kind === "job" ? q.startedBy.id : undefined;
		const sources = jobId ? s.order.filter((id) => { const e = s.entries.get(id)!; return e.jobId === jobId && e.kind === "jobEnded"; }) : undefined;
		return {
			kind: "input", writer: "harness", modelVisible: true, turnId, actorId: q.actorId, jobId, inputId: q.id, sources: [...(sources ?? []), ...(q.sources ?? [])],
			message: { role: "user", content: q.content }, data: { key: q.key, releasedBy: q.releasedBy, delegatedBy: q.delegatedBy, authorityActors: q.authorityActors, connectionRights: q.connectionRights, rights: q.startingRights },
		};
	}

	private failedOutcome(error: string): TurnOutcome {
		return { outcome: { kind: "failed", error }, result: { openToolCalls: [] }, entries: [], usage: zeroUsage() };
	}

	private endSteps(state: TurnState, except?: string): void {
		for (const [id, span] of state.steps) if (id !== except) { span.end(); state.steps.delete(id); }
	}

	step(s: Session, turnId: string, steps: Map<string, Operation>, stepId: string): Operation {
		let span = steps.get(stepId);
		if (!span) {
			span = startOperation("modular_agent.step", { ...conversation(s.id), "modular_agent.turn.id": turnId, "modular_agent.step.id": stepId });
			steps.set(stepId, span);
		}
		return span;
	}

	private runtimeHost(s: Session, turnId: string, state: TurnState, resultShape?: Record<string, unknown>, observeSteps = true): RuntimeHost {
		const turn = activeOperation();
		// A kept Runtime may finish bookkeeping, but it does not resume a step.
		const step = (id: string) => observeSteps ? turn?.run(() => this.step(s, turnId, state.steps, id)) : undefined;
		const inStep = <T>(id: string | undefined, work: () => T): T => {
			const span = id ? step(id) : undefined;
			return span ? span.run(work) : work();
		};
		const withAuthority = <T>(fn: () => T): T => this.operations.turnAuthority().run({ sessionId: s.id, actors: state.actors, jobs: state.jobs, state }, fn);
		const checkRead = async () => { await this.operations.erasure().admitHistory(s); withAuthority(() => this.operations.checkScopedWork(s, "watch")); };
		return {
			newId: async () => this.operations.newId(),
			callActor: () => state.actors.values().next().value ?? this.operations.actorForJob(s, state.jobs),
			prepareStep: ({ stepId, usage }) => {
				this.endSteps(state, stepId);
				return inStep(stepId, async () => {
					await checkRead();
					if (state.capacityLimit) throw turnLimit("capacity");
					if (state.tenantLimit || await this.operations.tenantBudgetReached(s)) { state.tenantLimit = true; throw turnLimit("tenantTokens"); }
					const attempts = s.order.map((id) => s.entries.get(id)!).filter((e) => e.turnId === turnId && e.kind === "modelRequest" && !(e.data as { auxiliary?: boolean })?.auxiliary).length;
					if (state.settings.maxSteps !== undefined && attempts >= state.settings.maxSteps) throw turnLimit("steps");
					const model = this.operations.modelAccess(s, state.model);
					const branch = s.branch();
					const lastAttempt = branch.findLastIndex((e) => e.turnId === turnId && e.kind === "modelRequest" && !(e.data as { auxiliary?: boolean })?.auxiliary);
					const feedback = branch.slice(lastAttempt + 1).filter((e) => !e.erased && e.turnId === turnId && e.kind === "resultFeedback");
					const request: ModelRequest = {
						systemPrompt: state.system, messages: s.modelMessages(branch, turnId), tools: state.tools, providerTools: "none",
						settings: { reasoning: state.settings.reasoning, maxOutput: state.settings.maxOutput },
					};
					const payload = { sessionId: s.id, turnId, stepId, usage, model: model?.model, history: s.branch().map(historyForPeer), request };
					const transformed = (await withAuthority(() => this.operations.hooks().transform("step.before", payload))).value.request;
					await checkRead();
					if (!Array.isArray(transformed?.tools) || transformed.tools.some(t => !request.tools.some(offered => isDeepStrictEqual(offered, t)))) throw new Error("step.before cannot widen the tool offer");
					const prepared: ModelRequest = feedback.length ? { ...transformed, messages: [...transformed.messages,
						...feedback.map((e): ModelMessage => ({ role: "user", content: [text((e.data as { reason: string }).reason)] }))] } : transformed;
					// Hooks may copy or transform messages, so conservatively name their visible sources.
					state.sources.set(stepId, [...new Set([...branch.filter((e) => !e.erased && ((e.modelVisible && e.kind !== "resultFeedback") || e.kind === "summary" || (e.kind === "turnStart" && e.turnId === turnId && state.context?.length))), ...feedback].map((e) => e.id))]);
					return prepared;
				});
			},
			hook: (name, payload) => inStep(payload?.stepId ?? payload?.call?.stepId, async () => {
				if (name === "turn.end") {
					if (state.endedHook || s.suspended) return null as never;
					state.endedHook = true;
					if (state.toolResultError && payload.outcome?.kind !== "cancelled" && payload.outcome?.kind !== "limit") {
						payload = { ...payload, outcome: { kind: "failed", error: state.toolResultError }, result: {} };
					}
					if (state.capacityLimit && payload.outcome?.kind !== "cancelled") payload = { ...payload, outcome: { kind: "limit", limit: "capacity" } };
					else if ((state.tenantLimit || await this.operations.tenantBudgetReached(s)) && payload.outcome?.kind !== "cancelled") payload = { ...payload, outcome: { kind: "limit", limit: "tenantTokens" } };
					const openToolCalls = payload.outcome?.kind === "cancelled" ? [] :
						pendingToolCalls(s.branch(), turnId, s.order.map((id) => s.entries.get(id)!));
					payload = { ...payload, result: { ...payload.result, openToolCalls } };
				}
				if (name === "step.after") {
					if (state.toolResultError) throw new Error(state.toolResultError);
					if (state.stepAfterRunning) throw new Error("Step gate is in progress");
					state.stepAfterRunning = true;
					try {
						const restored = restoreAnsweredStep(s.branch(), turnId, s.order.map((id) => s.entries.get(id)!));
						if (!restored || restored.lastStep.stepId !== payload.stepId || !isDeepStrictEqual(restored.response.message, payload.response)) throw new Error("No matching answered step");
						if (await this.operations.tenantBudgetReached(s)) state.tenantLimit = true;
						const value = { sessionId: s.id, turnId, stepId: payload.stepId, response: restored.response.message };
						let decision = restored.lastStep.decision;
						if (decision === undefined) {
							const gate = await withAuthority(() => this.operations.hooks().gate("step.after", value));
							decision = gate.refused !== undefined ? { refuse: gate.refused } : gate.pending !== undefined ? { refuse: "Invalid pending step decision" } : null;
							await this.operations.commit(s, [{ kind: "modular-agent.stepAfter", writer: "harness", turnId, stepId: payload.stepId,
								modelVisible: false, data: { decision }, sources: [restored.response.id] }]);
						}
						return { value, ...(decision === null ? {} : { refused: decision.refuse }) } as never;
					} finally { state.stepAfterRunning = false; state.steps.get(payload.stepId)?.end(); state.steps.delete(payload.stepId); }
				}
				const scope = { ...payload, sessionId: s.id, turnId };
				if (name === "tool.before" && this.operations.interfaceTools().interfaceSources.has(payload.call?.name)) {
					const call = payload.call as ToolCall;
					const refused = (reason: string) => ({ value: scope, refused: reason });
					const registration = this.operations.findTool(s, call.name);
					const branch = s.branch();
					const attempt = branch.find(e => e.kind === "modelRequest" && e.turnId === turnId && e.stepId === call.stepId && !e.erased);
					const response = branch.find(e => e.kind === "response" && e.turnId === turnId && e.stepId === call.stepId && !e.erased);
					if (call.startedBy !== "model" || call.parentCallId || !state.interfaceOffer?.has(call.name) ||
						!state.interfaceAllowances || state.interfaceAllowances.has(call.id) ||
						registration?.plugin !== INTERFACE_SOURCE ||
						!(attempt?.data as { tools?: string[] } | undefined)?.tools?.includes(call.name) ||
						response?.message?.role !== "assistant" || !response.message.content.some(part => isToolCall(part) &&
							part.id === call.id && part.name === call.name && isDeepStrictEqual(part.arguments, call.input))) return refused("Interface tool was not offered for this call");
					state.interfaceAllowances.set(call.id, null);
					const approval = s.settings.approval;
					const gate = await withAuthority(() => this.operations.tools().toolGate({ ...scope, definition: registration.definition }, s.running?.abort.signal));
					if (gate.pending !== undefined) return refused("An Interface handoff cannot wait on a question");
					if (gate.refused === undefined) state.interfaceAllowances.set(call.id, { call: structuredClone(gate.value.call), approval });
					return gate;
				}
				if (name === "tool.after") {
					const { result, error } = await withAuthority(() => this.operations.tools().toolAfter(s, scope));
					if (error) state.toolResultError ??= error.message;
					return { ...scope, result };
				}
				if (name === "turn.result") scope.shape = resultShape;
				const violation = name === "turn.result" && resultShape ? shapeViolation(resultShape, scope.result?.value) : undefined;
				const result = violation ? { value: scope, refused: violation } : name === "tool.before" && payload.call
					? await withAuthority(() => this.operations.tools().modelApprovalGate(s, state, turnId, scope))
					: await withAuthority(() => this.operations.hooks().run(name, scope));
				if (name === "turn.result" && typeof result?.refused === "string") {
					await this.operations.commit(s, [{ kind: "resultFeedback", writer: "harness", turnId, modelVisible: true, data: { reason: result.refused } }]);
				}
				if (name === "model.failed" && result?.retry) {
					const provider = this.operations.providerFor(s, state.model);
					if (provider?.supports.keepsState === true) await provider.discardState?.(s.id);
				}
				if (name === "tool.before" && result?.pending && payload.call && !waitingApprovals(s).has(payload.call.id)) this.operations.tools().toolDisposition(payload.call, "pending");
				return result;
			}),
			runToolCall: (call, signal) => inStep(call.stepId, () => withAuthority(() => this.operations.tools().executeTool(s, call, signal, turnId, state))),
			definition: async (name) => this.operations.findTool(s, name)?.definition,
			registration: (name) => {
				const found = this.operations.findTool(s, name);
				return found && { source: { plugin: found.plugin, toolSource: found.source.id }, definition: found.definition };
			},
			history: async options => {
				await checkRead();
				return options?.all ? s.order.map(id => s.entries.get(id)!) : s.branch();
			},
			record: (draft) => inStep(draft.stepId, async () => {
				if (draft.kind === "turnStart" || draft.kind === "turnEnd") {
					return s.branch().find((e) => e.turnId === turnId && e.kind === draft.kind)
						?? { ...draft, id: turnId, turnId, sessionId: s.id, time: this.operations.now(), parentId: s.position };
				}
				if (draft.kind === "inputRequest" || draft.kind === "inputAnswer" || draft.kind === "toolPending" || draft.kind === "toolStarted") throw failure("invalid_request", "Only the Harness records questions and pending dispositions");
				const wait = draft.toolCallId && waitingApprovals(s).get(draft.toolCallId);
				if (wait && draft.kind === "toolResult") {
					if (wait.result) return wait.result;
					draft = { ...draft, sources: [...draft.sources ?? [], wait.entry.id, ...(wait.decision ? [wait.decision.id] : [])] };
					if (!state.dispatched.has(draft.toolCallId!) && wait.request.deadlineAt! <= this.operations.now()) {
						draft.data = { status: "notStarted" };
						if (draft.message?.role === "toolResult") draft.message = { ...draft.message, isError: true, content: [text("The approval deadline passed before dispatch")] };
					}
				}
				if (draft.toolCallId && this.operations.interfaceTools().interfaceRecords(s).has(draft.toolCallId)) throw failure("invalid_request", "Interface handoffs are settled by the Harness");
				const modelSources = draft.kind === "response" ? [
					...(state.sources.get(draft.stepId ?? "") ?? []),
					...s.branch().filter((e) => e.kind === "modelRequest" && e.turnId === turnId && e.stepId === draft.stepId).map((e) => e.id),
				] : [];
				const callSources = draft.kind === "toolResult" && draft.toolCallId ? s.branch()
					.filter((e) => e.kind === "toolStarted" && e.toolCallId === draft.toolCallId
						|| e.message?.role === "assistant" && e.message.content.some((p) => isToolCall(p) && p.id === draft.toolCallId))
					.map((e) => e.id) : [];
				const sources = [...new Set([...(draft.sources ?? []), ...modelSources, ...callSources])];
				const entry = (await this.operations.commit(s, [{ ...draft, turnId, sources }], false, wait && draft.kind === "toolResult" ? () => !waitingApprovals(s).get(draft.toolCallId!)?.result : undefined))[0];
				if (!entry && wait) return waitingApprovals(s).get(draft.toolCallId!)!.result!;
				if (draft.kind === "toolResult" && draft.toolCallId && !state.dispatched.has(draft.toolCallId) && draft.message?.role === "toolResult") {
					const status = (draft.data as { status?: string } | undefined)?.status;
					if (status) this.operations.tools().toolDisposition({ id: draft.toolCallId, name: draft.message.toolName, startedBy: "model" }, status);
				}
				return entry;
			}),
			takeSteering: (final = false) => this.operations.admit(s, async () => {
				const items = s.steering.splice(0);
				if (final && !items.length && s.running?.turnId === turnId) s.running.steeringClosed = true;
				if (!items.length) return [];
				for (const q of items) for (const id of inputActors(q)) state.actors.add(id);
				state.connectionRights = intersectConnectionRights(state.connectionRights, ...items.map(q => q.connectionRights));
				state.startingRights = this.operations.intersectRights(state.startingRights ?? [], ...items.map(q => q.startingRights ?? []));
				return this.operations.commit(s, items.map((q) => this.inputEntry(s, q, turnId)));
			}),
			hasSteering: async () => s.steering.length > 0,
			report: (type, data, ids) => {
				if (type === "step.started" && ids?.stepId) { this.endSteps(state, ids.stepId); step(ids.stepId); }
				if (type !== "model.output") this.operations.emit(s, type, data, "runtime", { turnId, ...ids });
			},
		};
	}

	/** A continuation inherits only calls with an intact question checkpoint. In
	 * particular, losing the waiting marker and its proof cannot buy live approval. */
	intactInheritedCall(s: Session, turnId: string | undefined, call: ToolCall) {
		if (!turnId || call.startedBy !== "model") return true;
		const branch = s.branch();
		const origin = branch.find(e => e.kind === "turnStart" && e.turnId === turnId)?.continuesTurnId;
		if (!origin || branch.some(e => e.kind === "response" && e.turnId === turnId && e.stepId === call.stepId)) return true;
		return !!this.questionSettlement(s, branch, origin, call.id, call.stepId, true);
	}

	/** Return the last answer to the questions named by this call's host checkpoint. */
	private questionSettlement(s: Session, branch: HistoryEntry[], origin: string, callId: string, stepId?: string, dispatch = false) {
		const own = branch.filter(e => !e.erased && e.sessionId === s.id && !s.copied.has(e.id) && e.turnId === origin && e.toolCallId === callId);
		const checkpoints = own.filter(e => e.kind === "toolPending");
		const pending = checkpoints[0];
		const data = pending?.data as { requestIds?: string[]; toolStartedId?: string } | undefined;
		const ids = data?.requestIds;
		if (checkpoints.length !== 1 || !pending.stepId || stepId && stepId !== pending.stepId || !Array.isArray(ids) || !ids.length) return;
		const scope = own.filter(e => e.stepId === pending.stepId);
		if (data?.toolStartedId !== undefined && !scope.some(e => e.kind === "toolStarted" && e.id === data.toolStartedId)) return;
		for (const id of ids) {
			const entry = scope.find(e => e.kind === "inputRequest" && e.requestId === id);
			const request = (entry?.data as { request?: InputRequest })?.request;
			if (!request || request.id !== id || request.sessionId !== s.id || request.toolCallId !== callId ||
				dispatch && request.kind === "approval" && waitingApprovals(s).get(callId)?.entry !== entry ||
				!scope.some(e => e.kind === "inputAnswer" && e.requestId === id)) return;
		}
		return scope.findLast(e => e.kind === "inputAnswer" && !!e.requestId && ids.includes(e.requestId));
	}

	/** Tool calls on the current branch that have no result and are not part of a running turn. */
	openCalls(s: Session, origin?: string): InterruptedTurn["calls"] {
		const branch = s.branch();
		const kept = s.order.map((id) => s.entries.get(id)!);
		const results = new Set(kept.filter((e) => e.kind === "toolResult").map((e) => e.toolCallId));
		const continued = new Set(kept.filter((e) => e.kind === "turnStart").map((e) => e.continuesTurnId));
		const open = new Set(branch.flatMap((e) => e.kind === "turnEnd" && !e.erased && (origin ? e.turnId === origin : !continued.has(e.turnId)) ? (e.data as { result?: TurnOutcome["result"] }).result?.openToolCalls ?? [] : []));
		const calls: InterruptedTurn["calls"] = [];
		const handoffs = this.operations.interfaceTools().interfaceRecords(s);
		for (const e of branch) {
			if (e.message?.role !== "assistant") continue;
			for (const part of e.message.content.filter(isToolCall)) {
				if (open.has(part.id) && !results.has(part.id) && !handoffs.has(part.id)) calls.push({ id: part.id, name: part.name, input: part.arguments ?? {}, stepId: e.stepId, started: false, safeToRepeat: false });
			}
		}
		return calls;
	}

	/** Each ended turn has its own queue key. The last required decision fixes ready order. */
	private readyContinuations(s: Session) {
		const branch = s.branch();
		const visible = new Map(branch.map((e, index) => [e.id, { e, index }]));
		const used = new Set(s.order.map(id => s.entries.get(id)!).filter(e => e.kind === "turnStart").map(e => e.continuesTurnId));
		const handoffs = this.operations.interfaceTools().interfaceRecords(s);
		const requests = this.operations.questions().recordedOpenRequests(s);
		const ready: { origin: string; record: HistoryEntry; order: number; sources: string[] }[] = [];
		for (const end of branch) {
			if (!end.turnId || end.kind !== "turnEnd" || end.erased || used.has(end.turnId) || s.copied.has(end.id)) continue;
			const ids = (end.data as { result?: TurnOutcome["result"] })?.result?.openToolCalls ?? [];
			if (!ids.length || requests.some(r => r.toolCallId && ids.includes(r.toolCallId))) continue;
			const decisions = ids.map(id => {
				const item = handoffs.get(id);
				if (item) {
					if (!this.operations.interfaceTools().interfaceSources.size || this.operations.runtime()?.supports.interfaceTools !== true || !item.data || !item.checkpoint || item.checkpoint.turnId !== end.turnId || !visible.has(item.checkpoint.id) || !item.result || item.result.erased || item.result.turnId !== end.turnId || item.result.stepId !== item.checkpoint.stepId) return undefined;
					return item.result && visible.get(item.result.id);
				}
				const answer = this.questionSettlement(s, branch, end.turnId!, id);
				return answer && visible.get(answer.id);
			});
			if (decisions.some(d => !d)) continue;
			const last = decisions.reduce((a,b) => a!.index > b!.index ? a : b)!;
			ready.push({ origin: end.turnId, record: last.e, order: Math.max(last.index, visible.get(end.id)!.index),
				sources: [end.id, ...new Set(decisions.map(d => d!.e.id))] });
		}
		return ready.sort((a,b) => a.order - b.order);
	}

	maybeContinueOpenCalls(s: Session, trace?: ReturnType<typeof currentSpan>): void {
		if (s.closing || s.closed || s.suspended || s.erasing || s.moving || s.reopening) return;
		const branch = s.branch();
		for (const { origin, record, sources } of this.readyContinuations(s)) {
			if (s.followUps.some(q => q.continueTurnId === origin)) continue;
			const owners = this.recordedTurnActors(branch, origin);
			const jobs = this.recordedTurnJobs(branch, origin);
			const start = branch.find(e => e.kind === "turnStart" && e.turnId === origin && !e.erased);
			if (!start || !owners.length && !jobs.length) continue;
			const startedBy: QueuedInput["startedBy"] = record.kind === "toolResult" ? { kind: "toolResult", id: record.id }
				: { kind: "answer", id: (record.data as Answer).requestId };
			const queued: QueuedInput = { id: `continue:${origin}`, content: [], actorId: owners[0] ?? start.actorId ?? "harness",
				authorityActors: owners, authorityJobs: jobs, startingRights: this.recordedTurnRights(branch, origin),
				when: "after", startedBy, kind: "continue", continueTurnId: origin, trace, sources };
			const scope = this.operations.interfaceTools().offerScope.getStore();
			if (scope) this.operations.interfaceTools().queuedOffers.set(queued, scope);
			s.followUps.push(queued);
		}
		this.startQueued(s);
	}
}

export function tokenCount(usage?: Usage): number {
	return (usage?.input ?? 0) + (usage?.output ?? 0);
}

export function inputActors(q: QueuedInput): string[] {
	return [q.startedBy.kind === "job" ? undefined : q.actorId, q.releasedBy, q.delegatedBy, ...(q.authorityActors ?? [])].filter((id): id is string => id !== undefined);
}

