import { untilAborted } from "./session-lifecycle.js";
import type { TurnState } from "./turn-state.js";
import { shapeViolation } from "./result-shape.js";
import { InterfaceToolRoutes } from "./interface-tool-routes.js";
import { InputRequests } from "./input-requests.js";
import { Jobs } from "./jobs.js";
import { SessionErasure } from "./session-erasure.js";
import { ApprovalReconciliation } from "./approval-reconciliation.js";
import { failure } from "./failure.js";
import { sameJson, waitingApprovals, type ApprovalBinding } from "./waiting-approval.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { activeOperation, conversation, safeName, startOperation, telemetryEvent, toolAttributes } from "./telemetry.js";
import { Reservations, resourceBytes } from "./reservations.js";
import { isDeepStrictEqual } from "node:util";
import { HookRegistry } from "./hooks.js";
import { INTERFACE_SOURCE, isJson, validReportContent } from "./interface-tools.js";
import { Session } from "./session.js";
import { interruptedNote, type AgentEvent, type Authority, type EntryDraft, type GateResult, type HistoryEntry, type Runtime, type ToolCall, type ToolDefinition, type ToolPending, type ToolResult, type ToolSource, type WorkingEnvironment, isPending, isToolCall, text } from "./types.js";

/** Kept only from an approval gate through that invocation's live tools.call handle. */
interface CoveringAllow { toolCallId: string; requestId: string; actorId: string }
interface ApprovalPass {
	callId: string; attempt: string; inherited?: CoveringAllow; allow?: CoveringAllow;
}
interface DispatchAllowance { call: ToolCall; binding: ApprovalBinding; policy: unknown; cover?: CoveringAllow }
interface NestedDispatch { depth: number; registration: ToolRegistration; approval: unknown; inherited?: CoveringAllow }
type ToolRegistration = { plugin: string; source: ToolSource; definition: ToolDefinition };

interface ToolDispatchOperations {
	now(): number;
	interfaceTools(): Pick<InterfaceToolRoutes, "interfaceSources" | "handoffInterfaceCall">;
	approvals(): Pick<ApprovalReconciliation, "maximum" | "validWait" | "matchesApproval" | "approvalPrincipalsAllow" | "approverStillAllows">;
	intactInheritedCall(s: Session, turnId: string | undefined, call: ToolCall): boolean;
	findTool(s: Session | undefined, name: string): { plugin: string; source: ToolSource; definition: ToolDefinition } | undefined;
	actorForJob(s: Session, jobs?: Set<string>): string | undefined;
	workRights(s: Session, actors: Iterable<string>, jobs?: Iterable<string>): Authority[];
	environmentFor(s: Session): Promise<WorkingEnvironment | undefined>;
	projectOf(s: Session): string;
	checkWriter(s: Session): void;
	commit(s: Session, drafts: EntryDraft[], pluginRecord?: boolean, guard?: () => boolean | Promise<boolean>): Promise<HistoryEntry[]>;
	erasure(): Pick<SessionErasure, "admitHistory" | "checkPending">;
	agentName(): string | undefined;
	emit(session: string | Session, type: string, data: any, source: string, ids?: Partial<AgentEvent>): void;
	jobWork(): Pick<Jobs, "startJob">;
	scopedEnvironment(env: WorkingEnvironment, check: () => void): WorkingEnvironment;
	runtime(): Runtime | undefined;
	toolDefinitions(s?: Session): ToolDefinition[];
	questions(): Pick<InputRequests, "ask" | "recordedOpenRequests" | "recordAnswer" | "viewersFor">;
	newId(): string;
	reservations(): Reservations;
	reserveCall(s: Session, id: string, rebuilding?: boolean): boolean;
	problem(plugin: string, where: string, error: unknown): void;
	approvalCoversNested(): boolean;
	plugins(): string[];
	hooks(): HookRegistry;
	rightsOf(s: Session, actorId: string): Authority[];
}

export class ToolDispatch {
	constructor(private readonly operations: ToolDispatchOperations) {}

	readonly approvalPass = new AsyncLocalStorage<ApprovalPass>();

	readonly modelGate = new AsyncLocalStorage<{ response: HistoryEntry; actorId: string; turnId: string; callId: string }>();

	private readonly dispatchAllowances = new WeakMap<TurnState, Map<string, DispatchAllowance>>();

	toolWork = new AsyncLocalStorage<ToolCall>();

	gateSignal = new AsyncLocalStorage<AbortSignal | undefined>();

	/** Run one tool call. Hook points are applied by whoever owns the operation. */
	async executeTool(s: Session, call: ToolCall, signal: AbortSignal, turnId?: string, state?: TurnState,
		nested?: NestedDispatch, directAllowance?: DispatchAllowance): Promise<ToolResult | (ToolPending & { callId: string })> {
		const wait = waitingApprovals(s).get(call.id);
		const allowance = directAllowance ?? (state && this.dispatchAllowances.get(state)?.get(call.id));
		if (state) this.dispatchAllowances.get(state)?.delete(call.id);
		const denied = (): ToolResult => ({ callId: call.id, status: wait && wait.request.deadlineAt! <= this.operations.now() ? "notStarted" : "refused", content: [text("Consent no longer authorizes dispatch")] });
		const needsGate = !nested && state && !this.operations.interfaceTools().interfaceSources.has(call.name) && (this.coversNested() || this.operations.approvals().maximum && s.settings.approvalWait === "untilDeadline" &&
			!s.branch().some(e => e.kind === "toolStarted" && e.toolCallId === call.id));
		if (!this.operations.intactInheritedCall(s, turnId, call) || needsGate && !allowance || wait && (!allowance || wait.start || wait.result || !this.operations.approvals().validWait(s, wait))) return denied();
		const found = this.operations.findTool(s, call.name);
		if (s.erasing) return { callId: call.id, status: "refused", content: [text("Erasure is in progress")] };
		if (!found && wait) return denied();
		if (!found) return { callId: call.id, status: "failed", content: [text(`Unknown tool: ${call.name}`)] };
		const violation = shapeViolation(found.definition.parameters, call.input);
		if (violation && wait) return denied();
		if (violation) return { callId: call.id, status: "failed", content: [text(`Invalid input: ${violation}`)] };
		if (signal.aborted) return { callId: call.id, status: "notStarted", content: [text("Cancelled before it ran")] };
		if (nested && !sameRegistration(found, nested.registration)) return { callId: call.id, status: "refused", content: [text("Registration changed before dispatch")] };
		if (!nested && state && !state.tools.some((t) => t.name === call.name)) return { callId: call.id, status: "refused", content: [text("Tool was not offered to this turn")] };
		// The "tools" right: every actor the work belongs to must let tools run for it (docs/bindings/data.md#actors).
		const owners = state ? [...state.actors] : call.actorId ? [call.actorId] : [];
		call = { ...call, actorId: call.actorId ?? owners[0] ?? this.operations.actorForJob(s, state?.jobs) };
		const allowed = () => (!state || owners.length > 0 || state.jobs.size > 0) && this.operations.workRights(s, owners, state?.jobs).includes("tools");
		const refused = () => ({ callId: call.id, status: "refused" as const, content: [text(`No "tools" right: ${owners.join(", ")}`)] });
		if (!allowed()) return refused();
		if (found.plugin === INTERFACE_SOURCE) {
			const registration = this.operations.interfaceTools().interfaceSources.get(call.name);
			const connection = state?.interfaceOffer?.get(call.name);
			const allowance = state?.interfaceAllowances?.get(call.id);
			if (!allowance || !isDeepStrictEqual({ ...allowance.call, actorId: call.actorId }, call) ||
				call.actorId !== (owners[0] ?? this.operations.actorForJob(s, state?.jobs))) return refused();
			state?.interfaceAllowances?.set(call.id, null);
			if (!registration || !connection || !turnId || !call.stepId || !state || nested || call.startedBy !== "model" || !call.actorId) return refused();
			return this.operations.interfaceTools().handoffInterfaceCall(s, registration, connection, call, turnId, state, signal, allowed, allowance.approval);
		}
		const env = await this.operations.environmentFor(s);
		const safeToRepeat = found.definition.hints?.safeToRepeat === true && env?.containment === "strong";
		const point = !nested && !turnId && env?.save && (env.keepsPoints?.(this.operations.projectOf(s)) ?? env.points) ? await env.save() : undefined;
		const eligible = (current: ToolRegistration | undefined) => allowed() && !s.erasing && !s.suspended &&
			(!allowance || sameJson(allowance.call, call) && (wait || allowance.policy === s.settings.approval) && current &&
				current.plugin === allowance.binding.source.plugin && current.source.id === allowance.binding.source.toolSource && sameJson(current.definition, allowance.binding.definition)) &&
			sameRegistration(current, found) && (!nested || nested.approval === s.settings.approval);
		if (!eligible(this.operations.findTool(s, call.name))) return refused();
		if (signal.aborted) return { callId: call.id, status: "notStarted", content: [text("Cancelled before it ran")] };
		this.operations.checkWriter(s);
		const consent = (afterStart?: HistoryEntry) => {
			if (!wait) return true;
			const w = waitingApprovals(s).get(call.id);
			return !!w && w.start === afterStart && w.entry === wait.entry && w.decision === wait.decision && !w.result &&
				sameJson(call, allowance?.call) && this.operations.approvals().matchesApproval(w, call, s) && this.operations.approvals().approvalPrincipalsAllow(s, w) &&
				this.operations.workRights(s, owners, state?.jobs).includes("tools") && !signal.aborted && !s.erasing && !s.suspended;
		};
		if (wait && (!consent() || !await this.operations.approvals().approverStillAllows(s, wait) || !consent())) return denied();
		const [start] = await this.operations.commit(s, [{ kind: "toolStarted", writer: "harness", modelVisible: false, turnId, actorId: call.actorId ?? owners[0] ?? this.operations.actorForJob(s, state?.jobs), toolCallId: call.id, stepId: call.stepId,
			sources: wait ? [wait.entry.id, wait.decision!.id] : nested ? s.branch().filter(e => e.kind === "modular-agent.nestedCall" && e.toolCallId === call.id).map(e => e.id) : undefined,
			data: { call: { ...call, actorId: call.actorId ?? owners[0] ?? this.operations.actorForJob(s, state?.jobs) }, source: { plugin: found.plugin, toolSource: found.source.id }, definition: found.definition, safeToRepeat, point, openWorld: found.definition.hints?.openWorld ?? true,
				...(nested?.inherited ? { approvalCoveredBy: { toolCallId: nested.inherited.toolCallId, requestId: nested.inherited.requestId } } : {}),
				authorizers: owners.map((actorId) => ({ sessionId: s.id, actorId })), rights: this.operations.workRights(s, owners, state?.jobs) } }], false, wait ? () => consent() : undefined);
		if (wait && (!start || !consent(start))) return denied();
		const current = this.operations.findTool(s, call.name);
		if (!eligible(current)) return refused();
		this.operations.checkWriter(s);
		if (signal.aborted) return { callId: call.id, status: "notStarted", content: [text("Cancelled before it ran")] };
		if (wait && !await this.operations.approvals().approverStillAllows(s, wait)) return denied();
		await this.operations.erasure().admitHistory(s);
		this.operations.checkWriter(s);
		if (wait && !consent(start)) return denied();
		if (signal.aborted || !eligible(this.operations.findTool(s, call.name))) return refused();
		const name = safeName(found.definition.name);
		const span = startOperation(name ? `execute_tool ${name}` : "execute_tool", {
			...conversation(s.id), "modular_agent.turn.id": turnId, "modular_agent.step.id": call.stepId,
			...toolAttributes(call), "gen_ai.agent.name": this.operations.agentName(),
		});
		state?.dispatched.add(call.id);
		return span.run(async () => {
			try {
				const result = await this.invokeTool(s, found, call, signal, turnId, state, nested?.depth ?? 0, nested?.inherited ?? allowance?.cover, owners, allowed, env, start);
				const status = isPending(result) ? "pending" : result.status;
				span.set("modular_agent.tool.status", status);
				if (status === "failed" || status === "outcomeUnknown") span.fail(status);
				return result;
			} finally { span.end(); }
		});
	}

	private async invokeTool(s: Session, found: ToolRegistration, call: ToolCall, signal: AbortSignal, turnId: string | undefined, state: TurnState | undefined,
		depth: number, cover: CoveringAllow | undefined, owners: string[], allowed: () => boolean, env: WorkingEnvironment | undefined, start: HistoryEntry): Promise<ToolResult | (ToolPending & { callId: string })> {
		this.operations.emit(s, "tool.started", { call }, found.source.id, { turnId, toolCallId: call.id, stepId: call.stepId });
		const toolSpan = activeOperation();
		let asked = 0;
		const pendingQuestions: string[] = [];
		const children = new Set<Promise<ToolResult>>();
		const lifetime = new AbortController();
		let live = true;
		const check = () => {
			if (!live) throw Object.assign(new Error("There is no live parent"), { code: "invalid_request" });
			this.operations.erasure().checkPending(s);
			if (signal.aborted) throw Object.assign(new Error("The parent was cancelled"), { code: "cancelled" });
			if (!allowed() || s.erasing || s.suspended) throw Object.assign(new Error("The parent cannot run tools"), { code: "invalid_request" });
			this.operations.checkWriter(s);
		};
		const drain = async () => {
			live = false;
			lifetime.abort();
			await Promise.allSettled(children);
		};
		try {
			const result = await this.toolWork.run(call, () => found.source.run(call, {
				sessionId: s.id,
				signal,
				call,
				jobs: { start: async (kind, detail, key) => {
					check();
					const job = this.operations.jobWork().startJob(s, { kind, detail, key, actors: owners, toolCallId: call.id }, found.plugin);
					await job.ready;
					return job;
				} },
				progress: (content) => {
					try { check(); } catch { return; }
					this.operations.emit(s, "tool.progress", { content }, found.source.id, { turnId, toolCallId: call.id });
				},
				environment: env && this.operations.scopedEnvironment(env, check),
				tools: this.operations.runtime()?.supports.nestedToolCalls === true ? {
					list: async () => {
						check();
						return structuredClone(this.operations.toolDefinitions(s).filter(t => !t.callers || t.callers.includes("plugin")));
					},
					call: async (name, input, askingSignal) => {
						check();
						if (typeof name !== "string" || !name || !input || typeof input !== "object" || Array.isArray(input)) {
							throw Object.assign(new Error("A tool name and input object are required"), { code: "invalid_request" });
						}
						const childSignal = AbortSignal.any([signal, lifetime.signal, ...(askingSignal ? [askingSignal] : [])]);
						if (childSignal.aborted) throw Object.assign(new Error("The callback was cancelled"), { code: "cancelled" });
						const invoke = () => this.callNested(s, call, name, structuredClone(input), childSignal, depth + 1, turnId, state, start.id, cover);
						const work = toolSpan ? toolSpan.run(invoke) : invoke();
						children.add(work);
						try { return await work; } finally { children.delete(work); }
					},
				} : undefined,
				ask: (request, askingSignal) => {
					check();
					const n = ++asked;
					return this.operations.questions().ask(s, { ...request, toolCallId: call.id, key: request.key ?? `call:${call.id}:${n}` }, found.source.id, askingSignal ? AbortSignal.any([signal, askingSignal]) : signal)
						.then((answer) => { if (answer.pending) pendingQuestions.push(answer.requestId); return answer; });
				},
			}));
			await drain();
			if (isPending(result)) {
				if (depth) return { callId: call.id, status: "refused", content: [text("A nested call cannot be left open")] };
				if (!turnId || !pendingQuestions.length) return { callId: call.id, status: "failed", content: [text("No qualifying question for a pending result")] };
				await this.operations.commit(s, [{ kind: "toolPending", writer: "harness", modelVisible: false, turnId, stepId: call.stepId, toolCallId: call.id, data: { requestIds: [...new Set(pendingQuestions)], toolStartedId: start.id } }]);
				this.operations.emit(s, "tool.ended", { status: "open", reason: result.pending }, found.source.id, { turnId, toolCallId: call.id });
				return { callId: call.id, pending: result.pending };
			}
			const out: ToolResult = { ...result, callId: call.id };
			this.operations.emit(s, "tool.ended", { status: out.status }, found.source.id, { turnId, toolCallId: call.id });
			return out;
		} catch (error) {
			await drain();
			const status = (error as { code?: string })?.code === "lost" ? "outcomeUnknown" : signal.aborted ? "cancelled" : "failed";
			const message = error instanceof Error ? error.message : String(error);
			this.operations.emit(s, "tool.ended", { status }, found.source.id, { turnId, toolCallId: call.id });
			return { callId: call.id, status, content: [text(status === "cancelled" ? "Cancelled" : `Tool failed: ${message}`)] };
		}
	}

	/** Nested calls never use a model offer and are settled by the Harness, not the Runtime. */
	private async callNested(s: Session, parent: ToolCall, name: string, input: Record<string, unknown>,
		signal: AbortSignal, depth: number, turnId: string | undefined, state: TurnState | undefined, parentStart: string, inherited?: CoveringAllow): Promise<ToolResult> {
		const call: ToolCall = { id: this.operations.newId(), name, input, startedBy: "tool", parentCallId: parent.id, actorId: parent.actorId, stepId: parent.stepId };
		const scope = { turnId, stepId: call.stepId, actorId: call.actorId, toolCallId: call.id };
		if (resourceBytes(call) + 2048 > this.operations.reservations().limits.entryBytes || !this.operations.reserveCall(s, call.id)) {
			throw failure("busy", "No capacity for nested call");
		}
		const [intent] = await this.operations.commit(s, [{ ...scope, kind: "modular-agent.nestedCall", writer: "harness", modelVisible: false, sources: [parentStart], data: { call } }]);
		const stop = (status: ToolResult["status"], reason: string): ToolResult => ({ callId: call.id, status, content: [text(reason)] });
		let registration = this.operations.findTool(s, name);
		let executed = call;
		let result: ToolResult;
		let processingError: unknown;
		try {
			if (signal.aborted) result = stop("notStarted", "Cancelled before it ran");
			else if (depth > 8) result = stop("refused", "Nested tool call depth exceeds 8");
			else {
				// A replacement while a gate waits invalidates its answer. Limit churn so the child always settles.
				for (let pass = 0; ; pass++) {
					if (!registration || (registration.definition.callers && !registration.definition.callers.includes("plugin"))) {
						result = stop("refused", `Tool ${name} is not registered for plugin callers`); break;
					}
					const approval = s.settings.approval;
					const coverage = this.newApprovalPass(call, inherited);
					const gate = await this.toolGate({ sessionId: s.id, turnId, call, definition: registration.definition }, signal, coverage);
					if (signal.aborted) { result = stop("notStarted", "Cancelled before it ran"); break; }
					if (gate.pending !== undefined) { result = stop("refused", "A nested call cannot be left open"); break; }
					const current = this.operations.findTool(s, name);
					if (!sameRegistration(current, registration) || approval !== s.settings.approval) {
						if (pass >= 7) { result = stop("refused", "Registration kept changing"); break; }
						registration = current;
						continue;
					}
					if (gate.refused !== undefined) { result = stop("refused", gate.refused); break; }
					executed = gate.value.call;
					const ran = await this.executeTool(s, executed, signal, turnId, state, { depth, registration, approval, inherited });
					result = isPending(ran) ? stop("refused", "A nested call cannot be left open") : ran;
					break;
				}
			}
		} catch (error) {
			processingError = error;
			result = stop(signal.aborted ? "notStarted" : "failed", "Could not process the nested call");
		}
		if (!state?.dispatched.has(call.id) && (result.status === "refused" || result.status === "notStarted")) this.toolDisposition(call, result.status);
		await this.closeNestedQuestions(s, call.id);
		const after = await this.toolAfter(s, { sessionId: s.id, call: executed, result });
		result = after.result;
		processingError ??= after.error;
		await this.recordNestedResult(s, executed, turnId, result, intent?.id);
		if (processingError !== undefined) {
			this.operations.problem("harness", "nested tool result", processingError);
			throw processingError;
		}
		return result;
	}

	toolDisposition(call: Pick<ToolCall, "id" | "name" | "startedBy" | "parentCallId">, status: string): void {
		telemetryEvent("modular_agent.tool.disposition", { ...toolAttributes(call), "modular_agent.tool.status": status });
	}

	private async recordNestedResult(s: Session, call: ToolCall, turnId: string | undefined, result: ToolResult, intent?: string): Promise<void> {
		await this.operations.commit(s, [{ kind: "toolResult", writer: "harness", modelVisible: false, turnId, stepId: call.stepId,
			actorId: call.actorId, toolCallId: call.id, sources: intent ? [intent] : undefined,
			message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content, isError: result.status !== "completed" },
			data: { status: result.status, value: result.value, call } }]);
	}

	private async closeNestedQuestions(s: Session, callId: string): Promise<void> {
		for (const request of this.operations.questions().recordedOpenRequests(s).filter(r => r.toolCallId === callId)) {
			if (s.lateAnswers.has(request.id)) continue;
			const answer = { requestId: request.id, actorId: "harness", declined: true, reason: "noLongerAnswerable" };
			await this.operations.questions().recordAnswer(s, request, answer, s.order.map(id => s.entries.get(id)!).find(e => e.kind === "inputRequest" && e.requestId === request.id)?.stepId);
			s.waiting.delete(request.id);
			for (const viewer of this.operations.questions().viewersFor(s, request)) viewer.onInputRequestClosed?.(request.id);
			this.operations.emit(s, "input.request.closed", answer, "harness", { turnId: request.turnId, toolCallId: callId });
		}
	}

	async recoverNestedCalls(s: Session): Promise<void> {
		const entries = s.branch();
		const terminal = new Set(entries.filter(e => e.kind === "toolResult").map(e => e.toolCallId));
		const started = new Set(entries.filter(e => e.kind === "toolStarted").map(e => e.toolCallId));
		for (const e of entries.slice().reverse()) {
			if ((e.kind !== "modular-agent.nestedCall" && e.kind !== "toolStarted") || terminal.has(e.toolCallId)) continue;
			const call = (e.data as { call?: ToolCall } | undefined)?.call;
			if (!call || call.startedBy !== "tool" || !call.parentCallId) continue;
			terminal.add(call.id);
			await this.closeNestedQuestions(s, call.id);
			const dispatched = started.has(call.id);
			await this.recordNestedResult(s, call, e.turnId, { callId: call.id,
				status: dispatched ? "outcomeUnknown" : "notStarted", content: [text(interruptedNote(dispatched))] }, e.id);
		}
	}

	async modelApprovalGate<T extends { call: ToolCall }>(s: Session, state: TurnState, turnId: string, payload: T): Promise<GateResult<T>> {
		const call = payload.call;
		const wait = waitingApprovals(s).get(call.id);
		const signal = s.running?.abort.signal;
		if (!this.operations.intactInheritedCall(s, turnId, call)) return { value: payload, refused: "Missing continuation checkpoint" };
		this.dispatchAllowances.get(state)?.delete(call.id);
		const branch = s.branch();
		const parkable = this.operations.approvals().maximum && s.settings.approvalWait === "untilDeadline" && call.startedBy === "model" && !call.parentCallId &&
			!branch.some(e => e.kind === "toolStarted" && e.toolCallId === call.id);
		if (!wait && !parkable && !this.coversNested()) return this.toolGate(payload, signal);
		const actorId = state.actors.values().next().value ?? this.operations.actorForJob(s, state.jobs);
		// A continuation can also repeat a tool that left a non-approval question open.
		const currentStep = branch.some(e => e.kind === "response" && e.turnId === turnId && e.stepId === call.stepId);
		const origin = wait?.entry.turnId ?? (!currentStep && branch.find(e => e.kind === "turnStart" && e.turnId === turnId)?.continuesTurnId || turnId);
		const response = branch.find(e => e.kind === "response" && !e.erased && !s.copied.has(e.id) && e.turnId === origin && e.stepId === call.stepId &&
			e.message?.role === "assistant" && e.message.content.some(p => isToolCall(p) && p.id === call.id && p.name === call.name && sameJson(p.arguments, call.input)));
		const offered = branch.some(e => e.kind === "modelRequest" && !e.erased && e.turnId === origin && e.stepId === call.stepId && (e.data as { tools?: string[] })?.tools?.includes(call.name));
		const refuse = () => ({ value: payload, refused: "The waiting approval cannot authorize this call" });
		if (!actorId || !response || !offered || call.startedBy !== "model" || call.parentCallId || call.actorId && call.actorId !== actorId || !this.operations.workRights(s, state.actors, state.jobs).includes("tools")) return refuse();
		if (wait && (!wait.end || !wait.proof || wait.start || wait.result || !this.operations.approvals().validWait(s, wait) ||
			!branch.some(e => e.kind === "turnStart" && !e.erased && e.turnId === turnId && e.continuesTurnId === origin))) return refuse();
		const found = this.operations.findTool(s, call.name);
		if (!found || found.definition.callers && !found.definition.callers.includes("model")) return refuse();
		const policy = s.settings.approval;
		const registration = structuredClone({ source: { plugin: found.plugin, toolSource: found.source.id }, definition: found.definition });
		const coverage = this.newApprovalPass(call);
		const run = () => this.toolGate({ ...payload, definition: found.definition }, signal, coverage);
		const result = wait || parkable ? await this.modelGate.run({ response, turnId, actorId, callId: call.id }, run) : await run();
		if (result.refused === undefined && !result.pending) {
			const final = { ...result.value.call, actorId };
			if (wait && (!this.operations.approvals().matchesApproval(wait, final, s) || !await this.operations.approvals().approverStillAllows(s, wait))) return refuse();
			const allowances = this.dispatchAllowances.get(state) ?? new Map();
			this.dispatchAllowances.set(state, allowances);
			const cover = wait ? this.coversNested() && wait.request.coversNested === true
				? { toolCallId: call.id, requestId: wait.request.id, actorId: wait.decision!.actorId! } : undefined : coverage?.allow;
			allowances.set(call.id, { call: structuredClone(final), binding: { ...registration, call: structuredClone(final) }, policy, cover });
		}
		return result;
	}

	coversNested() { return this.operations.approvalCoversNested() && this.operations.plugins().includes("approval"); }

	private newApprovalPass(call: ToolCall, inherited?: CoveringAllow): ApprovalPass | undefined {
		return this.coversNested() ? { callId: call.id, attempt: this.operations.newId(), inherited } : undefined;
	}

	async toolGate<T extends { call: ToolCall }>(payload: T, signal?: AbortSignal, coverage = this.newApprovalPass(payload.call)): Promise<GateResult<T>> {
		const { call } = payload;
		let changed = false;
		const pass = (p: T, second: boolean) => this.operations.hooks().gate("tool.before", p, {
			invoke: (value, handler) => this.gateSignal.run(signal, () => this.toolWork.run(value.call, () => coverage ? this.approvalPass.run(coverage, handler) : handler())),
			change: (before, after) => {
				const candidate = after?.call;
				if (!candidate || !isDeepStrictEqual({ ...call, input: {} }, { ...candidate, input: {} }) ||
					!candidate.input || typeof candidate.input !== "object" || Array.isArray(candidate.input)) {
					throw new Error("Tool gate changed the call identity or gave invalid input");
				}
				if (!isDeepStrictEqual(before.call.input, candidate.input)) {
					if (second) throw new Error("Tool gate changed the call again");
					changed = true;
				}
				return { ...before, call: { ...before.call, input: candidate.input } };
			},
		});
		const first = await pass(payload, false);
		if (!changed || first.refused !== undefined || first.pending !== undefined) return first;
		if (coverage) coverage.allow = undefined;
		return pass(first.value, true);
	}

	/** A tool call an Interface or plugin starts. The same checks apply. */
	async callTool(s: Session, call: ToolCall): Promise<ToolResult> {
		if (s.provisional) throw failure("invalid_request", "Session has not admitted its first input");
		if (s.closed) throw failure("not_open", "Session is closed");
		if (s.suspended) throw failure("lost", "Session has lost its writer");
		if (s.moving || s.closing || s.erasing) throw failure("busy", "Session cannot run tools right now");
		if (resourceBytes(call) + 2048 > this.operations.reservations().limits.entryBytes || !this.operations.reserveCall(s, call.id)) {
			throw failure("busy", "No capacity for tool call");
		}
		return untilAborted(s.interruption.signal, async () => {
			s.outsideTools++;
			try { return await this.callOutsideTurn(s, call); }
			finally {
				if (!s.interruption.signal.aborted) this.operations.reservations().release(s, `call:${call.id}`);
				s.outsideTools--;
			}
		});
	}

	private async callOutsideTurn(s: Session, call: ToolCall): Promise<ToolResult> {
		const found = this.operations.findTool(s, call.name);
		const definition = found?.definition;
		const coverage = this.newApprovalPass(call);
		const policy = s.settings.approval;
		const registration = found && structuredClone({ source: { plugin: found.plugin, toolSource: found.source.id }, definition: found.definition });
		const gate = call.actorId && !this.operations.rightsOf(s, call.actorId).includes("tools")
			? { refused: "No tools right", value: { call } }
			: definition?.callers && call.startedBy !== "tool" && !definition.callers.includes(call.startedBy as "ui" | "plugin")
			? { refused: `${call.name} can't be called by a ${call.startedBy}`, value: { call } }
			: await this.toolGate({ sessionId: s.id, call, definition }, undefined, coverage);
		let result: ToolResult;
		if (gate.refused) {
			result = { callId: call.id, status: "refused", content: [text(gate.refused)] };
			this.toolDisposition(call, result.status);
		}
		else {
			const final = gate.value.call;
			const allowance = coverage && registration ? { call: final, binding: { ...registration, call: final }, policy, cover: coverage.allow } : undefined;
			const ran = await this.executeTool(s, final, s.interruption.signal, undefined, undefined, undefined, allowance);
			// Only a turn can carry an open call forward, so outside a turn it fails instead.
			result = isPending(ran) ? { callId: call.id, status: "failed", content: [text(`${call.name} can't wait for an answer outside a turn`)] } : ran;
		}
		const after = await this.toolAfter(s, { sessionId: s.id, call, result });
		result = after.result;
		await this.operations.commit(s, [{ kind: "toolResult", writer: "harness", modelVisible: false, toolCallId: call.id, actorId: call.actorId, message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content, isError: result.status !== "completed" }, data: { status: result.status, value: result.value, call } }]);
		if (after.error) throw after.error;
		return result;
	}

	async toolAfter(s: Session, payload: { sessionId: string; call: ToolCall; result: ToolResult }, fromInterface = false) {
		const { sessionId, call, result } = payload;
		try {
			const after = (await this.operations.hooks().transform("tool.after", structuredClone({ sessionId, call, result }), (before, answer) => {
				const next = answer.value;
				const fixedFields = ({ result: { content: _content, value: _value, ...result }, ...rest }: typeof next) =>
					JSON.parse(JSON.stringify({ ...rest, result }));
				if (answer.stop || !Array.isArray(next?.result?.content) || !isDeepStrictEqual(fixedFields(before), fixedFields(next))) {
					throw new Error("tool.after may change only result content and value");
				}
			})).value.result;
			if (fromInterface && (!validReportContent(after.content) || after.value !== undefined && !isJson(after.value))) {
				throw new Error("Invalid Interface tool output");
			}
			const startId = s.order.findLast(id => {
				const e = s.entries.get(id)!;
				return e.kind === "toolStarted" && e.toolCallId === call.id;
			});
			const start = startId && s.entries.get(startId);
			const shape = ((start || undefined)?.data as { definition?: ToolDefinition } | undefined)?.definition?.returns;
			const violation = after.status === "completed" && shape ? shapeViolation(shape, after.value) : undefined;
			if (violation) throw new Error(`Invalid tool output: ${violation}`);
			if (resourceBytes(after) + 2048 > this.operations.reservations().limits.settlementBytes) {
				const error = failure("result_too_large", "Tool result exceeds reserved capacity");
				return { error, result: { callId: after.callId, status: after.status === "completed" && shape ? "failed" as const : after.status,
					content: [text("result_too_large")] } };
			}
			return { result: after };
		} catch (cause) {
			const error = cause instanceof Error ? cause : new Error(String(cause));
			this.operations.problem("harness", "tool result", error);
			return { error, result: { callId: result.callId, status: fromInterface ? "failed" as const : result.status, content: [text("Tool result could not be processed")] } };
		}
	}
}

function sameRegistration(a: { plugin: string; source: ToolSource; definition: ToolDefinition } | undefined,
	b: { plugin: string; source: ToolSource; definition: ToolDefinition }): boolean {
	return !!a && a.plugin === b.plugin && a.source === b.source && isDeepStrictEqual(a.definition, b.definition);
}
