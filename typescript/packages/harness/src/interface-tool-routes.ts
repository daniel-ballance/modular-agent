import type { Plugin } from "./plugin-api.js";
import type { TurnState } from "./turn-state.js";
import { shapeViolation } from "./result-shape.js";
import { SessionErasure } from "./session-erasure.js";
import { ApprovalReconciliation } from "./approval-reconciliation.js";
import { failure } from "./failure.js";
import { waitingApprovals } from "./waiting-approval.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { conversation, currentSpan, safeName, startOperation, toolAttributes, withTrace } from "./telemetry.js";
import { Follower } from "./output-gate.js";
import { isDeepStrictEqual } from "node:util";
import { HookRegistry } from "./hooks.js";
import { INTERFACE_HANDOFF, INTERFACE_SOURCE, handoffRecords, isJson, sameDefinition, validReportContent, type HandoffData, type HandoffRecord, type AdapterInterfaceToolConnection, type AdapterInterfaceToolConnectionOptions, type InterfaceToolHandoff, type InterfaceToolReceipt, type InterfaceToolReport, type InterfaceToolSource } from "./interface-tools.js";
import { type QueuedInput, Session } from "./session.js";
import { type Actor, type AgentEvent, type Authority, type EntryDraft, type HistoryEntry, type Runtime, type ToolCall, type ToolDefinition, type ToolPending, type ToolResult, type ToolSource, type TurnOutcome, text } from "./types.js";

export interface InterfaceConnection extends AdapterInterfaceToolConnectionOptions {
	tools: Map<string, ToolDefinition>;
}
interface LiveHandoff {
	deliver(request: InterfaceToolHandoff): Promise<boolean>;
	connection: InterfaceConnection;
	turnId: string;
	withheld: boolean;
	check: () => boolean;
}

interface InterfaceToolRoutesOperations {
	intersectRights(...ceilings: readonly Authority[][]): Authority[];
	runtime(): Runtime | undefined;
	plugins(): string[];
	useAll<T>(capability: string): T[];
	now(): number;
	hasItem(item: string): boolean;
	replacements(): ReadonlyMap<string, string>;
	load(plugins: Plugin[]): Promise<void>;
	session(id: string): Session;
	withConnectionActor<T>(actor: Actor, run: () => T): T;
	actorRights(s: Session, actorId: string): Authority[];
	sessions(): ReadonlyMap<string, Session>;
	hooks(): HookRegistry;
	problem(plugin: string, where: string, error: unknown): void;
	findTool(s: Session | undefined, name: string): { plugin: string; source: ToolSource; definition: ToolDefinition } | undefined;
	erasure(): Pick<SessionErasure, "admitHistory" | "pendingRegistry" | "checkPending">;
	admit<T>(s: Session, work: () => Promise<T>): Promise<T>;
	checkWriter(s: Session): void;
	newId(): string;
	commit(s: Session, drafts: EntryDraft[], pluginRecord?: boolean, guard?: () => boolean | Promise<boolean>): Promise<HistoryEntry[]>;
	workRights(s: Session, actors: Iterable<string>, jobs?: Iterable<string>): Authority[];
	agentName(): string | undefined;
	maybeContinueOpenCalls(s: Session, trace?: ReturnType<typeof currentSpan>): void;
	approvals(): Pick<ApprovalReconciliation, "clear" | "invalidateDeliveries" | "closeWaiting">;
	recordedTurnActors(branch: HistoryEntry[], turnId: string): string[];
	recordedTurnJobs(branch: HistoryEntry[], turnId: string): string[];
	recordedTurnRights(branch: HistoryEntry[], turnId: string): Authority[];
	turnAuthority(): Pick<AsyncLocalStorage<{ sessionId: string; actors: Set<string>; jobs: Set<string>; state?: Pick<TurnState, "connectionRights" | "startingRights"> }>, "run">;
	toolAfter(s: Session, payload: { sessionId: string; call: ToolCall; result: ToolResult }, fromInterface?: boolean): Promise<{ result: ToolResult; error?: Error }>;
	commitNow(s: Session, drafts: EntryDraft[], pluginRecord?: boolean): Promise<HistoryEntry[]>;
	emit(session: string | Session, type: string, data: any, source: string, ids?: Partial<AgentEvent>): void;
}

export class InterfaceToolRoutes {
	constructor(private readonly operations: InterfaceToolRoutesOperations) {}

	// The offer follows its input through the queue, even if another Interface becomes present.
	readonly offerScope = new AsyncLocalStorage<symbol>();

	queuedOffers = new WeakMap<QueuedInput, symbol>();

	private connectionOffers = new WeakMap<InterfaceConnection, symbol>();

	withInterfaceOffer<T>(scope: symbol, work: () => T): T { return this.offerScope.run(scope, work); }

	interfaceSources = new Map<string, InterfaceToolSource>();

	private interfaceConnections = new WeakMap<Session, Set<InterfaceConnection>>();

	private interfaceWork = new WeakMap<Session, Map<string, LiveHandoff>>();

	private interfaceTimers = new WeakMap<Session, Map<string, ReturnType<typeof setTimeout>>>();

	private handoffSpans = new WeakMap<Session, Map<string, NonNullable<ReturnType<typeof currentSpan>>>>();

	async registerInterfaceTools(sources: readonly InterfaceToolSource[]): Promise<void> {
		if (!sources.length) return;
		if (this.operations.runtime()?.supports.interfaceTools !== true) throw new Error("Interface tools need a Runtime that supports result-only continuations");
		if (this.operations.plugins().includes(INTERFACE_SOURCE)) throw new Error("Interface tools conflict with an existing plugin");
		const ids = new Set(this.operations.useAll<ToolSource>("tool-source").map(s => s.id));
		const routes = new Map<string, string>();
		const definitions = new Map<string, InterfaceToolSource>();
		const copy = structuredClone(sources);
		for (const source of copy) {
			const { sourceId, actorId, routeId, resultTimeoutMs, tools } = source;
			if (![sourceId, actorId, routeId].every(id => typeof id === "string" && id.length)
				|| !Number.isSafeInteger(resultTimeoutMs) || resultTimeoutMs <= 0 || !Number.isSafeInteger(this.operations.now() + resultTimeoutMs)) {
				throw new Error("Interface tool source needs IDs and a positive result timeout within Time range");
			}
			if (ids.has(sourceId) || routes.has(routeId) && routes.get(routeId) !== actorId) throw new Error("Conflicting Interface tool source or route");
			ids.add(sourceId);
			routes.set(routeId, actorId);
			for (const tool of tools) {
				if (!isJson(tool) || typeof tool.name !== "string" || !tool.name || typeof tool.description !== "string" ||
					!isDeepStrictEqual(tool.callers, ["model"]) || tool.hints?.safeToRepeat === true || tool.hints?.openWorld === false) {
					throw new Error("An Interface tool must be model-only, open-world and not safe to repeat");
				}
				shapeViolation(tool.parameters, {});
				if (tool.returns !== undefined) shapeViolation(tool.returns, undefined);
				if (definitions.has(tool.name) || this.operations.hasItem(`tool:${tool.name}`) || this.operations.replacements().has(`tool:${tool.name}`)) throw new Error(`Tool ${tool.name} is already registered`);
				definitions.set(tool.name, source);
			}
		}
		if (!definitions.size) return;
		await this.operations.load([{ name: INTERFACE_SOURCE, setup: api => {
			for (const source of copy) api.provide("tool-source", {
				id: source.sourceId, tools: () => structuredClone([...source.tools]),
				run: () => { throw new Error("Only the registered Interface can execute this tool"); },
			} satisfies ToolSource);
		} }]);
		if (!this.operations.plugins().includes(INTERFACE_SOURCE)) throw new Error("Interface tool registration failed");
		this.interfaceSources = definitions;
	}

	connectInterfaceTools(sessionId: string, options: AdapterInterfaceToolConnectionOptions): AdapterInterfaceToolConnection {
		const s = this.operations.session(sessionId);
		if (![...this.interfaceSources.values()].some(r => r.routeId === options.routeId && r.actorId === options.actor.id)) {
			throw failure("forbidden", "No Interface tool route for this actor");
		}
		const connection: InterfaceConnection = { ...options, actor: structuredClone(options.actor), tools: new Map() };
		if (!this.executorRights(s, connection).includes("watch")) throw failure("forbidden", "Actor cannot watch this session");
		const connections = this.interfaceConnections.get(s) ?? new Set();
		this.interfaceConnections.set(s, connections);
		connections.add(connection);
		const scope = this.offerScope.getStore();
		if (scope) this.connectionOffers.set(connection, scope);
		return {
			advertise: tools => {
				if (!this.interfacePresent(s, connection)) throw failure("not_open", "Interface connection ended");
				const next = new Map<string, ToolDefinition>();
				for (const tool of tools) {
					const source = this.interfaceSources.get(tool.name);
					const definition = source?.tools.find(t => t.name === tool.name);
					if (!definition || source?.actorId !== connection.actor.id || source.routeId !== connection.routeId ||
						next.has(tool.name) || !sameDefinition(tool, definition)) throw failure("invalid_request", "Advertisement does not match the registered Interface tool");
					next.set(tool.name, definition);
				}
				connection.tools = next;
			},
			release: id => this.releaseInterfaceCall(s, id, connection),
			withholdStaged: turn => this.withholdStaged(s, connection, turn),
			reportInterfaceToolResult: report => this.reportInterfaceToolResult(s, connection, report),
			disconnect: () => { connections.delete(connection); connection.tools.clear(); },
		};
	}

	private executorRights(s: Session, connection: InterfaceConnection): Authority[] {
		return this.operations.withConnectionActor(connection.actor, () => this.operations.actorRights(s, connection.actor.id));
	}

	private interfacePresent(s: Session, connection: InterfaceConnection): boolean {
		return !s.closed && !s.closing && !s.suspended && this.operations.sessions().get(s.id) === s && !!this.interfaceConnections.get(s)?.has(connection);
	}

	interfaceOffer(s: Session, scope?: symbol): Map<string, InterfaceConnection> {
		const offer = new Map<string, InterfaceConnection>();
		for (const connection of this.interfaceConnections.get(s) ?? []) {
			if (scope !== this.connectionOffers.get(connection)) continue;
			const rights = this.executorRights(s, connection);
			if (!this.interfacePresent(s, connection) || !rights.includes("tools") || !rights.includes("watch")) continue;
			for (const name of connection.tools.keys()) if (!offer.has(name)) offer.set(name, connection);
		}
		return offer;
	}

	interfaceRecords(s: Session) {
		return handoffRecords(s.order.filter(id => !s.copied.has(id)).map(id => s.entries.get(id)!));
	}

	unsettledHandoffs(s: Session) {
		return [...this.interfaceRecords(s).values()].filter(item => !item.result);
	}

	private validHandoff(s: Session, item: HandoffRecord) {
		const { data, dispatch, checkpoint, start } = item;
		const source = dispatch?.call && this.interfaceSources.get(dispatch.call.name);
		return !!data && !!start && !!checkpoint && !!dispatch && !!source && this.operations.runtime()?.supports.interfaceTools === true &&
			source.actorId === data.executorActorId && source.routeId === data.routeId && source.sourceId === dispatch.source.toolSource &&
			(source.tools.some(t => sameDefinition(t, dispatch.definition))) &&
			s.branch().some(e => e.id === checkpoint.id) && s.actors.has(data.executorActorId);
	}

	private async gateHandoff(s: Session, connection: InterfaceConnection, request: InterfaceToolHandoff): Promise<boolean> {
		const payload = structuredClone(request);
		const event = { type: "tool.handoff", time: this.operations.now(), sessionId: s.id, source: INTERFACE_SOURCE,
			turnId: request.turnId, toolCallId: request.call.id, stepId: request.call.stepId, data: payload };
		let unchanged = false;
		const follower = new Follower(this.operations.hooks(), connection.actor.id, false, gated => {
			unchanged = isDeepStrictEqual(gated, event);
		}, error => this.operations.problem("harness", "Interface handoff output gate", error));
		follower.push(structuredClone(event));
		await follower.idle();
		return unchanged;
	}

	async handoffInterfaceCall(s: Session, source: InterfaceToolSource, connection: InterfaceConnection, call: ToolCall,
		turnId: string, state: TurnState, signal: AbortSignal, allowed: () => boolean, approval: unknown): Promise<ToolResult | (ToolPending & { callId: string })> {
		const refused = (): ToolResult => ({ callId: call.id, status: "refused", content: [text("Interface handoff is not authorized")] });
		const definition = source.tools.find(t => t.name === call.name)!;
		const eligible = () => {
			const current = this.operations.findTool(s, call.name);
			const rights = this.executorRights(s, connection);
			return !signal.aborted && !s.moving && !s.erasing && allowed() && approval === s.settings.approval && this.interfacePresent(s, connection) &&
				rights.includes("watch") && rights.includes("tools") && connection.tools.get(call.name) === definition &&
				current?.plugin === INTERFACE_SOURCE && current.source.id === source.sourceId && sameDefinition(current.definition, definition) &&
				state.tools.some(t => t.name === call.name && sameDefinition(t, definition));
		};
		const deadline = this.operations.now() + source.resultTimeoutMs;
		if (!Number.isSafeInteger(deadline) || !eligible()) return refused();
		await this.operations.erasure().admitHistory(s);
		if (!eligible()) return refused();
		const request = { sessionId: s.id, turnId, deadline, call };
		if (!(await this.gateHandoff(s, connection, request))) return refused();
		return this.operations.admit(s, async () => {
			const freshness = await this.operations.erasure().admitHistory(s);
			const previous = this.interfaceRecords(s).has(call.id);
			if (!eligible() || previous || deadline <= this.operations.now()) return refused();
			this.operations.checkWriter(s);
			const startId = this.operations.newId();
			const scope = { toolCallId: call.id, turnId, stepId: call.stepId };
			const data: HandoffData = { toolStartedId: startId, executorActorId: source.actorId, routeId: source.routeId,
				rights: this.executorRights(s, connection), deadline };
			const committed = await this.operations.commit(s, [
				{ ...scope, id: startId, kind: "toolStarted", writer: "harness", modelVisible: false, actorId: call.actorId,
					data: { call, source: { plugin: INTERFACE_SOURCE, toolSource: source.sourceId }, definition, safeToRepeat: false, openWorld: true,
						authorizers: [...state.actors].map(actorId => ({ sessionId: s.id, actorId })), rights: this.operations.workRights(s, state.actors, state.jobs) } },
				{ ...scope, kind: INTERFACE_HANDOFF, writer: "harness", modelVisible: false, sources: [startId], data: { ...scope, ...data } },
			], false, () => eligible() && deadline > this.operations.now() && data.rights.every(r => this.executorRights(s, connection).includes(r)) &&
				(!this.operations.erasure().pendingRegistry() || this.operations.erasure().checkPending(s) === freshness));
			if (!committed.length) return refused();
			const pinned = AsyncLocalStorage.snapshot();
			const live: LiveHandoff = { connection, turnId, withheld: false, check: () => pinned(() => eligible() && deadline > this.operations.now()),
				deliver: request => pinned(() => this.deliverHandoff(s, live, request)) };
			const work = this.interfaceWork.get(s) ?? new Map();
			this.interfaceWork.set(s, work);
			work.set(call.id, live);
			state.dispatched.add(call.id);
			const item = this.interfaceRecords(s).get(call.id)!;
			let fresh = false;
			try { fresh = (await this.operations.erasure().admitHistory(s)) === freshness; } catch { /* fail closed */ }
			if (!fresh || !live.check()) {
				// No executable request left the Harness.
				await this.settleInterfaceCall(s, item);
				return { callId: call.id, pending: "Interface request was not released" };
			}
			this.operations.checkWriter(s);
			this.scheduleInterfaceExpiry(s, item);
			if (!connection.defer) await this.deliverHandoff(s, live, request);
			return { callId: call.id, pending: "Waiting for Interface tool result" };
		});
	}

	private async deliverHandoff(s: Session, live: LiveHandoff, request: InterfaceToolHandoff): Promise<boolean> {
		const { call, turnId } = request;
		const work = this.interfaceWork.get(s);
		// An attempted delivery cannot be repeated, even on a throw.
		if (!work?.delete(call.id)) return false;
		const span = startOperation(`execute_tool ${safeName(call.name) ?? "interface"}`, {
			...conversation(s.id), "modular_agent.turn.id": turnId, "modular_agent.step.id": call.stepId, ...toolAttributes(call),
			"gen_ai.agent.name": this.operations.agentName(), "modular_agent.tool.status": "pending",
		});
		if (span.spanContext) {
			const spans = this.handoffSpans.get(s) ?? new Map();
			this.handoffSpans.set(s, spans);
			spans.set(call.id, span.spanContext);
		}
		try {
			if (span.run(() => live.connection.onHandoff(structuredClone(request))) !== "withheld") return true;
		} catch {
			this.operations.problem("harness", "Interface handoff", new Error("Interface delivery was not confirmed"));
			return false;
		} finally { span.end(); }
		// Only a synchronous, explicit pre-write decision can restore proof of non-delivery.
		live.withheld = true;
		work.set(call.id, live);
		const item = this.interfaceRecords(s).get(call.id);
		if (item && await this.settleInterfaceCall(s, item)) this.operations.maybeContinueOpenCalls(s);
		return false;
	}

	private withholdStaged(s: Session, connection: InterfaceConnection, turnId: string): Promise<void> {
		return this.operations.admit(s, async () => {
			if (s.closed || s.suspended || !connection.defer) return;
			const work = this.interfaceWork.get(s);
			const staged = [...(work ?? [])].filter(([, live]) => live.connection === connection && live.turnId === turnId);
			if (!staged.length) return;
			// Pin abandonment before any awaited work. The original handle can do this even
			// after disconnect, but a replacement connection cannot abandon its calls.
			for (const [, live] of staged) live.withheld = true;
			await this.operations.erasure().admitHistory(s);
			this.operations.checkWriter(s);
			const records = this.interfaceRecords(s);
			for (const [id] of staged) {
				const item = records.get(id);
				if (item) await this.settleInterfaceCall(s, item);
			}
			this.operations.maybeContinueOpenCalls(s);
		});
	}

	private releaseInterfaceCall(s: Session, id: string, connection: InterfaceConnection): Promise<boolean> {
		return this.operations.admit(s, async () => {
			const live = this.interfaceWork.get(s)?.get(id);
			const item = live?.connection === connection && this.interfaceRecords(s).get(id);
			if (!item || item.result || !live || live.withheld || !this.validHandoff(s, item)) return false;
			const { data, dispatch, checkpoint } = item;
			const request = { sessionId: s.id, turnId: checkpoint!.turnId!, deadline: data!.deadline, call: dispatch!.call };
			const freshness = await this.operations.erasure().admitHistory(s);
			if (!live.check() || !(await this.gateHandoff(s, connection, request))) return false;
			if (await this.operations.erasure().admitHistory(s) !== freshness) return false;
			this.operations.checkWriter(s);
			if (!live.check()) return false;
			return live.deliver(request);
		});
	}

	private scheduleInterfaceExpiry(s: Session, item: HandoffRecord): void {
		if (!item.data) return;
		const timers = this.interfaceTimers.get(s) ?? new Map();
		this.interfaceTimers.set(s, timers);
		clearTimeout(timers.get(item.id));
		timers.set(item.id, setTimeout(() => {
			void withTrace(undefined, () => this.operations.admit(s, async () => {
				if (s.closed || s.suspended) return;
				const current = this.interfaceRecords(s).get(item.id);
				if (!current || current.result || !current.data) return;
				if (current.data.deadline > this.operations.now()) return this.scheduleInterfaceExpiry(s, current);
				await this.settleInterfaceCall(s, current);
				this.operations.maybeContinueOpenCalls(s);
			})).catch(error => this.operations.problem("harness", "Interface tool expiry", error));
		}, Math.min(2_147_483_647, Math.max(1, item.data.deadline - this.operations.now()))).unref());
	}

	clearInterfaceWork(s: Session): void {
		this.operations.approvals().clear(s);
		for (const timer of this.interfaceTimers.get(s)?.values() ?? []) clearTimeout(timer);
		this.interfaceTimers.delete(s);
		this.interfaceConnections.delete(s);
		this.interfaceWork.delete(s);
		this.handoffSpans.delete(s);
	}

	async invalidateErasedHandoffs(s: Session, entryIds: string[]): Promise<void> {
		const ids = new Set(entryIds);
		this.operations.approvals().invalidateDeliveries(s);
		for (const w of waitingApprovals(s).values()) {
			if (!w.result && !w.start && [w.entry.id, w.decision?.id, w.end?.id, ...(w.entry.sources ?? []),
				...s.branch().filter(e => e.toolCallId === w.request.toolCallId && e.kind === "toolPending").map(e => e.id)].some(id => id && ids.has(id))) {
				await this.operations.approvals().closeWaiting(s, w, "noLongerAnswerable", "notStarted", true);
			}
		}
		for (const item of this.unsettledHandoffs(s)) {
			if ([item.start?.id, item.checkpoint?.id].some(id => id && ids.has(id))) {
				await this.settleInterfaceCall(s, item, undefined, true);
			}
		}
	}

	async recoverInterfaceCalls(s: Session): Promise<void> {
		for (const item of this.unsettledHandoffs(s)) {
			const end = s.branch().find(e => e.kind === "turnEnd" && e.turnId === (item.checkpoint ?? item.start)?.turnId);
			if (!this.validHandoff(s, item) || item.data!.deadline <= this.operations.now() ||
				(end ? end.erased || !(end.data as { result?: TurnOutcome["result"] })?.result?.openToolCalls.includes(item.id) : !this.operations.runtime()?.supports.continuesAfterRestart)) {
				await this.settleInterfaceCall(s, item);
			} else this.scheduleInterfaceExpiry(s, item);
		}
	}

	private reportInterfaceToolResult(s: Session, connection: InterfaceConnection, raw: InterfaceToolReport): Promise<InterfaceToolReceipt> {
		const refused = { status: "refused" } as const;
		let report: InterfaceToolReport;
		try {
			const { callId, status, content, value } = raw;
			if (typeof callId !== "string" || !callId || !["completed", "failed"].includes(status) ||
				!validReportContent(content) || status === "failed" && !content.length || value !== undefined && !isJson(value)) return Promise.resolve(refused);
			report = structuredClone({ callId, status, content, ...(value === undefined ? {} : { value }) });
		} catch { return Promise.resolve(refused); }
		const parent = currentSpan();
		return this.operations.admit(s, async () => {
			if (!this.interfacePresent(s, connection) || s.erasing || s.moving || s.reopening) return refused;
			const item = this.interfaceRecords(s).get(report.callId);
			if (!item?.data || !this.validHandoff(s, item)) return refused;
			const { data, checkpoint } = item;
			const authorized = () => this.interfacePresent(s, connection) && !s.erasing && !s.moving &&
				data.executorActorId === connection.actor.id && data.routeId === connection.routeId &&
				this.operations.intersectRights(data.rights, this.executorRights(s, connection)).includes("watch") &&
				this.operations.intersectRights(data.rights, this.executorRights(s, connection)).includes("tools");
			if (!authorized()) return refused;
			try { await this.operations.erasure().admitHistory(s); } catch { return refused; }
			if (!authorized()) return refused;
			if (data.deadline <= this.operations.now()) {
				if (!item.result) { await this.settleInterfaceCall(s, item); this.operations.maybeContinueOpenCalls(s); }
				return refused;
			}
			const end = s.branch().find(e => e.turnId === checkpoint!.turnId && e.kind === "turnEnd");
			if (end?.erased || item.result?.erased) return refused;
			if (!end) return { status: "refused", reason: "notReady" };
			if (!(end.data as { result?: TurnOutcome["result"] })?.result?.openToolCalls.includes(item.id)) return refused;
			if (item.result) return item.result.actorId === connection.actor.id && !item.result.erased ? { status: "alreadySettled" } : refused;
			if (this.interfaceWork.get(s)?.has(item.id)) return refused;
			const span = startOperation("modular_agent.interface.report", { ...conversation(s.id) }, { parent: parent ?? null });
			return span.observe(async () => {
				const settled = await this.settleInterfaceCall(s, item, { report, actorId: connection.actor.id, authorized });
				this.operations.maybeContinueOpenCalls(s, currentSpan());
				if (settled?.error) throw settled.error;
				return settled ? { status: "accepted" } : refused;
			});
		});
	}

	async settleInterfaceCall(s: Session, item: HandoffRecord,
		submitted?: { report: InterfaceToolReport; actorId: string; authorized: () => boolean }, erasure = false) {
		if (item.result || s.suspended) return;
		const { checkpoint, start, dispatch } = item;
		const origin = checkpoint ?? start;
		const { id } = item;
		const link = this.handoffSpans.get(s)?.get(id);
		const span = startOperation("modular_agent.tool.settle", {
			...conversation(s.id), "modular_agent.turn.id": origin?.turnId, "modular_agent.step.id": origin?.stepId,
			"modular_agent.tool.call.id": id,
		}, { parent: submitted ? currentSpan() : null, links: link ? [link] : undefined });
		return span.observe(async () => {
			const live = this.interfaceWork.get(s)?.get(id);
			const call = dispatch?.call;
			const branch = s.branch();
			const actors = new Set(origin?.turnId ? this.operations.recordedTurnActors(branch, origin.turnId) : []);
			const jobs = new Set(origin?.turnId ? this.operations.recordedTurnJobs(branch, origin.turnId) : []);
			const startingRights = origin?.turnId ? this.operations.recordedTurnRights(branch, origin.turnId) : [];
			const checked = submitted && call ? await this.operations.turnAuthority().run({ sessionId: s.id, actors, jobs, state: { startingRights } },
				() => this.operations.toolAfter(s, { sessionId: s.id, call, result: submitted.report }, true)) : undefined;

			const result: ToolResult = checked?.result ?? { callId: id, status: live ? "notStarted" : "outcomeUnknown",
				content: [text(live ? "Interface request was not released" : "Interface tool outcome is unknown")] };
			const draft: EntryDraft = { kind: "toolResult", writer: "harness", modelVisible: true, turnId: origin?.turnId,
				stepId: origin?.stepId, toolCallId: id, actorId: submitted?.actorId,
				sources: [start?.id, checkpoint?.id].filter((entry): entry is string => !!entry),
				message: { role: "toolResult", toolCallId: id, toolName: call?.name ?? "unknown", content: result.content, isError: result.status !== "completed" },
				data: { status: result.status, value: result.value },
			};
			const written = erasure ? await this.operations.commitNow(s, [draft]) : await this.operations.commit(s, [draft], false, async () => {
				if (this.interfaceRecords(s).get(id)?.result) return false;
				if (!submitted) return true;
				try { await this.operations.erasure().admitHistory(s); } catch { return false; }
				return submitted.authorized();
			});
			if (!written.length) return;
			clearTimeout(this.interfaceTimers.get(s)?.get(id));
			this.interfaceTimers.get(s)?.delete(id);
			this.interfaceWork.get(s)?.delete(id);
			this.handoffSpans.get(s)?.delete(id);
			span.set("modular_agent.tool.status", result.status);
			if (checked?.error || result.status === "failed" || result.status === "outcomeUnknown") span.fail(result.status);
			this.operations.emit(s, "tool.result", { status: result.status }, "harness", { turnId: origin?.turnId, stepId: origin?.stepId, toolCallId: id, actorId: submitted?.actorId });
			return { error: checked?.error };
		});
	}
}
