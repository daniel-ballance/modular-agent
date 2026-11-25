import { ALL_AUTHORITY, normalizeSetting, type parseModel, type ListingViewer, type SessionStartOptions, type SessionPrepare, type SessionSummary, type Tenant } from "./harness.js";
import { InputAdmission } from "./input-admission.js";
import { TurnExecution, recordedSnapshot } from "./turn-execution.js";
import { ToolDispatch } from "./tool-dispatch.js";
import type { TurnState } from "./turn-state.js";
import { InterfaceToolRoutes } from "./interface-tool-routes.js";
import { connectionRights } from "./connection-authority.js";
import { InputRequests, readRequest } from "./input-requests.js";
import { Jobs } from "./jobs.js";
import { SessionErasure } from "./session-erasure.js";
import { ApprovalReconciliation } from "./approval-reconciliation.js";
import { failure } from "./failure.js";
import { waitingApprovals } from "./waiting-approval.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { conversation, historyForPeer, startOperation, TURN_TRACE, type Operation } from "./telemetry.js";
import { addAbortListener } from "node:events";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { interruptedCalls } from "./view.js";
import { HookRegistry } from "./hooks.js";
import { INTERFACE_HANDOFF } from "./interface-tools.js";
import { type QueuedInput, Session } from "./session.js";
import { type Actor, type AgentEvent, type Authority, type Configuration, type EntryDraft, type HistoryEntry, type HistoryStore, type InterruptedTurn, type Provider, type SessionInterruptionReason, type StoredSession, type ToolCall, type ToolDefinition, type ToolSource, type TurnOutcome, type TurnSnapshot, type WorkingEnvironment, isToolCall } from "./types.js";

interface SessionLifecycleOperations {
	sessions(): Map<string, Session>;
	rebuildReservations(): Promise<void>;
	use<T>(capability: string): T | undefined;
	erasure(): Pick<SessionErasure, "admitHistory" | "pendingRegistry" | "loadTombstones" | "reconcilePending">;
	tenants(): ReadonlyMap<string, Tenant>;
	newId(): string;
	now(): number;
	project(): string;
	workActors(s: Session): string[];
	turnAuthority(): Pick<AsyncLocalStorage<{ sessionId: string; actors: Set<string>; jobs: Set<string>; state?: Pick<TurnState, "connectionRights" | "startingRights"> }>, "getStore">;
	workRights(s: Session, actors: Iterable<string>, jobs?: Iterable<string>): Authority[];
	activePlugins(): { name: string; origin?: "global" | "project" }[];
	observeCommit<T>(s: Session, count: number, work: (span: Operation) => Promise<T>): Promise<T>;
	commit(s: Session, drafts: EntryDraft[], pluginRecord?: boolean, guard?: () => boolean | Promise<boolean>): Promise<HistoryEntry[]>;
	hooks(): HookRegistry;
	emit(session: string | Session, type: string, data: any, source: string, ids?: Partial<AgentEvent>): void;
	questions(): Pick<InputRequests, "recoverSecrets" | "waitingRequests" | "viewersFor" | "recordedOpenQuestionEntries">;
	recoveryPolicy(): { input: string; jobs: string };
	admission(): Pick<InputAdmission, "handBack" | "admit" | "cancel">;
	tools(): Pick<ToolDispatch, "recoverNestedCalls">;
	interfaceTools(): Pick<InterfaceToolRoutes, "recoverInterfaceCalls" | "unsettledHandoffs" | "clearInterfaceWork">;
	approvals(): Pick<ApprovalReconciliation, "reconcileApprovals" | "maximum">;
	turns(): Pick<TurnExecution, "startQueued" | "maybeContinueOpenCalls" | "openCalls" | "launch" | "resumeTurn">;
	actorRights(s: Session, actorId: string): Authority[];
	withinLimits(s: Session, right: Authority): boolean;
	jobWork(): Pick<Jobs, "readJob" | "reportJob" | "runningJobs" | "endJobObservation" | "cancelJob">;
	problem(plugin: string, where: string, error: unknown): void;
	rightsOf(s: Session, actorId: string): Authority[];
	requireAuthority(s: Session, actorId: string, authority: Authority): void;
	environmentFor(s: Session): Promise<WorkingEnvironment | undefined>;
	projectOf(s: Session): string;
	findTool(s: Session | undefined, name: string): { plugin: string; source: ToolSource; definition: ToolDefinition } | undefined;
	providerFor(s: Session, ref?: ReturnType<typeof parseModel> | null): Provider | undefined;
}

export class SessionLifecycle {
	constructor(private readonly operations: SessionLifecycleOperations) {}

	private opening = new Set<string>();

	session(id: string): Session {
		const s = this.operations.sessions().get(id);
		if (!s) throw failure("not_open", `Session ${id} is not open`);
		return s;
	}

	liveSessionInfo(id: string) {
		const s = this.operations.sessions().get(id);
		if (!s || s.closing || s.closed || s.interruption.signal.aborted) return undefined;
		return { ...s.meta, updated: s.entries.get(s.order.at(-1) ?? "")?.time ?? s.meta.created,
			settings: { ...s.settings }, tenant: s.tenant };
	}

	private defaultActor(): Actor {
		return { id: "user", kind: "user", authority: ALL_AUTHORITY };
	}

	async startSession(options: SessionStartOptions = {}): Promise<string> {
		const span = startOperation("modular_agent.session.open", { "modular_agent.session.operation": "new" });
		return span.observe(() => this.startSessionWithin(options, span));
	}

	private async startSessionWithin(options: SessionStartOptions, span: Operation): Promise<string> {
		await this.operations.rebuildReservations();
		const store = this.operations.use<HistoryStore>("history-store");
		const sourceId = options.forkFrom?.sessionId ?? options.parentSessionId;
		const ancestor = sourceId ? this.operations.sessions().get(sourceId) ?? await this.loadInto(sourceId) : undefined;
		const ancestorView = ancestor && await this.operations.erasure().admitHistory(ancestor);
		const tenant = ancestor?.tenant ?? options.tenant;
		if (tenant !== undefined && !this.operations.tenants().has(tenant)) throw Object.assign(new Error(`Unknown tenant ${tenant}`), { code: "invalid_params" });
		const cwd = options.settings?.cwd;
		const meta: StoredSession = { id: this.operations.newId(), created: this.operations.now(), project: ancestor?.meta.project ?? (typeof cwd === "string" ? cwd : this.operations.project()), forkedFrom: options.forkFrom, parentSessionId: options.parentSessionId };
		span.set("gen_ai.conversation.id", meta.id);
		const s = new Session(meta, !store);
		s.tenant = tenant;
		s.provisional = !!store && store.supports.persistent !== false && !options.forkFrom;
		if (store && !s.provisional) {
			await store.create(meta);
			await store.openForWriting(meta.id);
		}
		this.operations.sessions().set(meta.id, s);
		const actor = options.actor ?? this.defaultActor();
		s.actors.set(actor.id, actor);
		const config = this.operations.use<Configuration>("configuration");
		const defaults = { ...(config?.get<Record<string, unknown>>("session") ?? {}), ...(options.settings ?? {}) };
		let copies: HistoryEntry[] = [];
		if (options.forkFrom) {
			const source = ancestor;
			if (source) {
				const path: HistoryEntry[] = [];
				let id: string | null = options.forkFrom.entryId;
				while (id) {
					const e = source.entries.get(id);
					if (!e) break;
					path.push(e);
					id = e.parentId;
				}
				path.reverse();
				copies = copyForkPrefix(path.filter(e => e.kind !== INTERFACE_HANDOFF), meta.id, () => this.operations.newId());
				Object.assign(defaults, source.settings);
			}
		}
		const actors = options.forkFrom && ancestor ? [...ancestor.actors.values()] : [actor];
		const drafts: EntryDraft[] = [...actors.map((a) => actorJoined(a, "harness")), ...Object.entries(defaults).map(([key, value]): EntryDraft => ({ kind: "setting", writer: "harness", modelVisible: false, data: { key, value } }))];
		if (tenant !== undefined) drafts.unshift({ kind: "tenant", writer: "harness", modelVisible: false, data: { tenant } });
		if (options.forkFrom && ancestor?.limit) drafts.push({ kind: "limit", writer: "harness", modelVisible: false, actorId: actor.id, data: { rights: ancestor.limit } });
		else if (options.forkFrom && s.limit !== null) drafts.push({ kind: "limit", writer: "harness", modelVisible: false, actorId: actor.id, data: { rights: null } });
		if (options.parentSessionId) {
			const actors = ancestor ? this.operations.workActors(ancestor) : [];
			const work = this.operations.turnAuthority().getStore();
			const jobs = work?.sessionId === ancestor?.id && work ? [...work.jobs] : [];
			if (actors.length || jobs.length) drafts.push({ kind: "harness.parentAuthority", writer: "harness", modelVisible: false, data: { actors, jobs, rights: this.operations.workRights(ancestor!, actors, jobs) } });
		}
		this.watchWriter(s);
		try {
			if (options.forkFrom) {
				const departed = new Set(ancestor?.order.map((id) => ancestor.entries.get(id)!).flatMap((e) => e.kind === "actorLeft" ? [(e.data as { actorId: string }).actorId] : []));
				for (const id of departed) if (!ancestor?.actors.has(id)) drafts.push({ kind: "actorLeft", writer: "harness", modelVisible: false, data: { actorId: id } });
				drafts.push({ kind: "plugins", writer: "harness", modelVisible: false, data: { active: this.operations.activePlugins() } });
				let parentId = copies.at(-1)?.id ?? null;
				const setup = drafts.map((draft): HistoryEntry => {
					const entry = { ...draft, id: this.operations.newId(), parentId, sessionId: s.id, time: this.operations.now() };
					if (entry.kind === "setting") entry.data = normalizeSetting(entry.data as { key: string; value: unknown });
					parentId = entry.id;
					return entry;
				});
				const batch = [...copies, ...setup];
				const publish = async () => {
					if (ancestor && await this.operations.erasure().admitHistory(ancestor) !== ancestorView) throw failure("unavailable", "Erasure changed the fork source");
					await this.operations.observeCommit(s, batch.length, () => this.write(s, () => store?.append(s.id, batch, { forkErasureView: ancestorView })));
					for (const e of batch) s.apply(e);
				};
				const registry = this.operations.erasure().pendingRegistry();
				if (registry) await registry.exclusive(publish);
				else await publish();
			} else {
				await this.operations.commit(s, drafts);
				await this.recordPlugins(s);
			}
		} catch (error) {
			this.operations.sessions().delete(meta.id);
			await this.closeWriter(s);
			throw error;
		}
		await this.prepareSession(s, false, options.prepare);
		await this.operations.hooks().observe("session.start", { sessionId: s.id, resumed: false });
		this.operations.emit(s, "session.started", { meta }, "harness");
		return s.id;
	}

	async loadInto(id: string): Promise<Session | undefined> {
		const store = this.operations.use<HistoryStore>("history-store");
		if (!store) return undefined;
		const { meta, entries } = await store.load(id);
		if (!entries.length) return undefined;
		const s = new Session(meta, false);
		if (store.historyErasure) this.operations.erasure().loadTombstones(s, new Set(entries.filter(e => e.erased === true).map(e => e.id)));
		for (const e of entries) s.apply(e);
		const interrupted = this.unfinishedTurn(s, s.branch());
		if (interrupted) recordedSnapshot(interrupted);
		return s;
	}

	private async prepareSession(s: Session, resumed: boolean, prepare?: SessionPrepare) {
		try {
			await this.operations.hooks().observe("session.prepare", { sessionId: s.id, project: s.meta.project, resumed });
			await prepare?.(s.id);
		} catch (error) {
			await this.operations.hooks().observe("session.end", { sessionId: s.id });
			this.operations.sessions().delete(s.id);
			await this.closeWriter(s);
			throw error;
		}
	}

	async openSession(id: string, actor?: Actor, prepare?: SessionPrepare, operation: "load" | "resume" = "resume"): Promise<string> {
		return startOperation("modular_agent.session.open", { ...conversation(id), "modular_agent.session.operation": operation })
			.observe(async () => (await this.openSessionWithin(id, actor, prepare))!);
	}

	async resumeInterruptedSession(id: string, actor: Actor): Promise<boolean> {
		return startOperation("modular_agent.session.open", { ...conversation(id), "modular_agent.session.operation": "resume" })
			.observe(async () => !!await this.openSessionWithin(id, actor, undefined, true));
	}

	private async openSessionWithin(id: string, actor?: Actor, prepare?: SessionPrepare, interruptedOnly = false) {
		await this.operations.rebuildReservations();
		if (this.opening.has(id) || this.operations.sessions().get(id)?.closing) {
			throw Object.assign(new Error("Session is busy"), { code: "busy" });
		}
		this.opening.add(id);
		try { return await this.openStoredSession(id, actor, prepare, interruptedOnly); }
		finally { this.opening.delete(id); }
	}

	private async openStoredSession(id: string, actor?: Actor, prepare?: SessionPrepare, interruptedOnly = false) {
		const opened = this.operations.sessions().get(id);
		if (opened && !opened.interruption.signal.aborted) {
			if (interruptedOnly) return;
			if (actor) await this.authorizeOpeningActor(opened, actor);
			await this.operations.erasure().reconcilePending(opened);
			await prepare?.(id);
			return id;
		}
		if (opened) {
			if (actor && !await this.canDiscoverSession(id, actor, true)) throw failure("forbidden", "Session is inaccessible");
			await this.retireSession(opened);
		}
		const store = this.operations.use<HistoryStore>("history-store");
		if (!store) throw failure("not_supported", "No history store: sessions can't be reopened");
		await store.openForWriting(id, { wait: !interruptedOnly });
		const s = await this.loadInto(id).catch(async (error) => { await store.close(id); throw error; });
		if (!s || (s.tenant !== undefined && !this.operations.tenants().has(s.tenant))) {
			await store.close(id);
			throw s ? failure("forbidden", "Session tenant is unavailable") : failure("not_found", `Session ${id} not found`);
		}
		if (interruptedOnly && !this.unfinishedTurn(s, s.branch())) {
			await store.close(id);
			return;
		}
		const a = actor ?? this.defaultActor();
		try { await this.authorizeOpeningActor(s, a); }
		catch (error) { await store.close(id); throw error; }
		this.operations.sessions().set(id, s);
		this.watchWriter(s);
		s.reopening = true;
		try {
			await this.operations.erasure().reconcilePending(s);
			await this.operations.questions().recoverSecrets(s);
		}
		catch (error) { this.operations.sessions().delete(id); await this.closeWriter(s); throw error; }
		await this.prepareSession(s, true, prepare);
		const latest = s.entries.get(s.order.at(-1) ?? "");
		if (latest?.kind === "position") {
			const data = latest.data as { to: string | null; restore?: { point: string; undo: string } };
			if (data.restore) {
				const before = s.entries.get(s.order.at(-2) ?? "");
				const prior = before?.kind === "position" && (before.data as typeof data).restore;
				const undoing = !!prior && prior.point === data.restore.undo && prior.undo === data.restore.point && before?.parentId === data.to;
				try { await this.completeRewind(s, data.to, latest.parentId, data.restore, undoing); }
				catch (error) {
					if (s.suspended || (error as { code?: string }).code !== "conflict") { this.operations.sessions().delete(id); await this.closeWriter(s); throw error; }
				}
			}
		}

		if (s.settings.approval === undefined) s.settings.approval = "all";
		else if (!["off", "ask", "all", "never"].includes(String(s.settings.approval))) s.settings.approval = "never";
		await this.recordPlugins(s);
		const admissions = [...s.admissions.values()].filter((q) => !s.proposals.has(q.id));
		const recovery = this.operations.recoveryPolicy();
		const handBack = (q: QueuedInput) => (q.startedBy.kind === "job" ? recovery.jobs : recovery.input) === "handedBack";
		s.recoveredInput = admissions.filter(handBack);
		s.followUps.push(...admissions.filter(q => !handBack(q)));
		await this.operations.admission().handBack(s, s.recoveredInput, "restart");
		await this.operations.hooks().observe("session.start", { sessionId: s.id, resumed: true });
		await this.operations.tools().recoverNestedCalls(s);
		await this.operations.interfaceTools().recoverInterfaceCalls(s);
		await this.operations.approvals().reconcileApprovals(s, true);
		await this.recoverInterruptedTurn(s);
		await this.recoverReports(s);
		s.reopening = false;
		this.operations.turns().startQueued(s);
		this.operations.emit(s, "session.started", { meta: s.meta, resumed: true }, "harness");
		// Questions left open past their turn are still answerable after a restart.
		for (const request of this.operations.questions().waitingRequests(s)) {
			this.operations.emit(s, "input.request.opened", { request, waiting: true }, "harness", { toolCallId: request.toolCallId });
			for (const i of this.operations.questions().viewersFor(s, request)) i.onInputRequest?.(request);
		}
		this.operations.turns().maybeContinueOpenCalls(s);
		return id;
	}

	async canDiscoverSession(id: string, actor: Actor, severalActors: boolean): Promise<boolean> {
		const s = this.operations.sessions().get(id) ?? await this.loadInto(id);
		return !!s && this.discoveryRights(s, actor, severalActors).includes("watch");
	}

	async hostView(id: string, actor: Actor, scope: (project: string, tenant: string | null) => boolean) {
		const live = this.operations.sessions().get(id);
		const s = live && !live.closed && !live.suspended ? live : await this.loadInto(id);
		if (!s || !scope(s.meta.project, s.tenant ?? null)) throw failure("not_found", "Thread not found");
		const freshness = await this.operations.erasure().admitHistory(s);
		const rights = this.discoveryRights(s, actor, false);
		if (!rights.includes("watch")) throw failure("not_found", "Thread not found");
		const order = s.order.slice();
		return { records:s.branch(), order, all:order.map(id=>s.entries.get(id)!), rights, live:s === live, kept:!s.ephemeral && this.operations.use<HistoryStore>("history-store")?.supports.persistent !== false,
			generation:createHash("sha256").update(JSON.stringify([freshness, order.filter(id => { const e = s.entries.get(id)!; return e.kind === "position" || e.erased; })])).digest("hex") };
	}

	private discoveryRights(s: Session, actor: Actor, allowJoin: boolean): Authority[] {
		if (s.tenant !== undefined && !this.operations.tenants().has(s.tenant)) return [];
		if (s.actors.has(actor.id)) return this.operations.actorRights(s, actor.id).filter(right => actor.authority.includes(right));
		if (!allowJoin || s.order.some(id => {
			const e = s.entries.get(id)!;
			return e.kind === "actorLeft" && (e.data as { actorId?: string } | undefined)?.actorId === actor.id;
		})) return [];
		return actor.authority.filter(right => this.operations.withinLimits(s, right) && (!s.meta.parentSessionId || right === "watch"));
	}

	async sessionSummary(id: string, viewer: ListingViewer): Promise<SessionSummary | undefined> {
		const store = this.operations.use<HistoryStore>("history-store");
		if (!store || store.supports.persistent !== true && store.supports.portableSessions !== true) return;
		const live = this.operations.sessions().get(id);
		const s = live && !live.interruption.signal.aborted ? live : await this.loadInto(id).catch(error => {
			if (["not_found", "ENOENT", "unknown_session"].includes(error?.code)) return undefined;
			throw error;
		});
		if (!s || s.ephemeral || s.provisional || viewer.scope && !viewer.scope(s.meta.project, s.tenant)) return;
		await this.operations.erasure().admitHistory(s);
		const rights = this.discoveryRights(s, viewer.actor, viewer.allowJoin);
		if (!rights.includes("watch")) return;
		const branch = s.branch(), start = this.unfinishedTurn(s, branch);
		const running = start && (s === live ? s.running?.turnId === start.turnId && !s.suspended : store.writerActive?.(id));
		const turn = !start ? "none" : running ? "running" : "interrupted";
		const questions = this.operations.questions().recordedOpenQuestionEntries(s, branch).filter(e => {
			if (s.copied.has(e.id)) return false;
			const r = readRequest(e);
			const inTurn = !!r.turnId && r.turnId === start?.turnId;
			if (inTurn && viewer.inTurn !== true && !viewer.inTurn?.includes(r.id) ||
				r.kind === "approval" && !inTurn && !(r.approvalWait === "untilDeadline" && this.operations.approvals().maximum && waitingApprovals(s).get(r.toolCallId!)?.end) || r.kind === "secret" && !viewer.secrets ||
				r.timeLimitMs !== undefined && r.whenTimeLimit !== "leaveOpen" && this.operations.now() >= e.time + r.timeLimitMs) return false;
			const right = r.kind === "approval" ? "approve" : "answer";
			if (!rights.includes(right)) return false;
			if (!r.answerers.length || r.answerers.includes(viewer.actor.id)) return true;
			return viewer.represented?.some(actorId => r.answerers.includes(actorId) && this.operations.actorRights(s, actorId).includes(right) &&
				(!inTurn || viewer.present?.includes(actorId)));
		}).length;
		const toolCalls = !viewer.routeId || !rights.includes("tools") ? 0 : this.operations.interfaceTools().unsettledHandoffs(s).filter(({data, checkpoint}) => {
			if (!data || data.routeId !== viewer.routeId || data.executorActorId !== viewer.actor.id || data.deadline <= this.operations.now() ||
				!branch.some(e => e === checkpoint)) return false;
			const end = branch.find(e => e.kind === "turnEnd" && e.turnId === checkpoint!.turnId);
			return !end || !end.erased && (end.data as TurnOutcome).result?.openToolCalls?.includes(checkpoint!.toolCallId!);
		}).length;
		return { id, project:s.meta.project, tenant:s.tenant, updated:s.entries.get(s.order.at(-1)!)?.time ?? s.meta.created,
			waiting:{questions, toolCalls, turn} };
	}

	private async authorizeOpeningActor(s: Session, actor: Actor): Promise<void> {
		const denied = () => Object.assign(new Error("Session is inaccessible"), { code: "forbidden" });
		if (s.actors.has(actor.id)) {
			if (!this.operations.actorRights(s, actor.id).includes("watch")) throw denied();
			return;
		}
		if (s.order.some((id) => { const e = s.entries.get(id)!; return e.kind === "actorLeft" && (e.data as { actorId?: string }).actorId === actor.id; })) throw denied();
		const rights = actor.authority.filter((r) => this.operations.withinLimits(s, r));
		if (!rights.includes("watch")) throw denied();
		await this.operations.commit(s, [actorJoined({ ...actor, authority: rights }, "harness")]);
	}

	private async recordPlugins(s: Session): Promise<void> {
		const active = this.operations.activePlugins();
		const last = s.order.map((id) => s.entries.get(id)!).findLast((e) => e.kind === "plugins" && !e.erased);
		if (!isDeepStrictEqual(last?.data, { active })) await this.operations.commit(s, [{ kind: "plugins", writer: "harness", modelVisible: false, data: { active } }]);
	}

	private async recoverReports(s: Session): Promise<void> {
		const entries = s.order.map((id) => s.entries.get(id)!);
		const jobs = new Map(entries.flatMap((e) => {
			const job = this.operations.jobWork().readJob(s, e);
			return job ? [[job.job.id, job] as const] : [];
		}));
		for (const end of entries) {
			if (!end.jobId || end.kind !== "jobEnded" || end.erased || !(end.data as { report?: boolean })?.report) continue;
			const job = jobs.get(end.jobId);
			if (job) await this.operations.jobWork().reportJob(s, job, end);
		}
	}

	private unfinishedTurn(s: Session, branch: HistoryEntry[]) {
		const start = branch.findLast(e => e.kind === "turnStart" && !e.erased && !s.copied.has(e.id));
		return start?.turnId && !s.order.some(id => {
			const e = s.entries.get(id)!;
			return e.kind === "turnEnd" && e.turnId === start.turnId;
		}) ? start : undefined;
	}

	/** Find a turn whose process stopped, and hand it to the Runtime, which decides what happens to it. */
	private async recoverInterruptedTurn(s: Session): Promise<void> {
		const branch = s.branch();
		const lastStart = this.unfinishedTurn(s, branch);
		if (!lastStart?.turnId) return;
		const snapshot = recordedSnapshot(lastStart);
		const pending = new Map((lastStart.continuesTurnId ? this.operations.turns().openCalls(s, lastStart.continuesTurnId) : []).map((c) => [c.id, c]));
		for (const c of interruptedCalls(branch, lastStart.turnId)) pending.set(c.id, c);
		// This host has no restart-time cleanup confirmation from its environments.
		const settled = new Set(s.order.map((id) => s.entries.get(id)!).filter((e) => e.kind === "toolResult").map((e) => e.toolCallId));
		const calls = [...pending.values()].filter((c) => !settled.has(c.id)).map((c) => ({ ...c, safeToRepeat: false }));
		const interrupted: InterruptedTurn = { turnId: lastStart.turnId, calls };
		this.operations.emit(s, "turn.interrupted", { pending: interrupted.calls.length }, "harness", { turnId: interrupted.turnId });
		// Not awaited: the resumed turn may wait for an answer that only an Interface opened after this can give.
		void connectionRights.exit(() => this.operations.turns().launch(s, interrupted.turnId, (signal) => this.operations.turns().resumeTurn(s, interrupted, snapshot, signal)));
	}

	async forkSession(sessionId: string, entryId: string): Promise<string> {
		const s = this.session(sessionId);
		await this.operations.erasure().admitHistory(s);
		if (s.erasing) throw failure("busy", "Erasure is in progress");
		// Forking at unfinished work would copy work that is still running: refused.
		if (s.running || this.operations.jobWork().runningJobs(s).length || this.operations.questions().waitingRequests(s).length || this.operations.turns().openCalls(s).length || this.operations.interfaceTools().unsettledHandoffs(s).length) throw failure("busy", "Can't fork while the session has unfinished work: a running turn, a job, or a call waiting for an answer");
		const target = s.entries.get(entryId);
		if (!target) throw Object.assign(new Error("Unknown fork target"), { code: "not_found" });
		if (target.kind === "position") throw Object.assign(new Error("Cannot fork a position record"), { code: "conflict" });
		const id = await this.startSession({ forkFrom: { sessionId, entryId }, actor: [...s.actors.values()][0] });
		await this.suspendSession(id);
		return id;
	}

	private stopSessionWork(s: Session): void {
		s.suspended = true;
		this.operations.interfaceTools().clearInterfaceWork(s);
		this.operations.jobWork().endJobObservation(s);
		s.steering = [];
		s.followUps = [];
		s.running?.abort.abort();
		for (const r of s.requests.values()) void r.resolve({ requestId: r.request.id, declined: true, actorId: "harness", reason: "the process stopped" });
		s.requests.clear();
	}

	async suspendSession(id: string): Promise<void> {
		const s = this.operations.sessions().get(id);
		if (!s) return;
		this.stopSessionWork(s);
		// A stopping process doesn't wait for its work to finish. Nothing more is recorded once suspended.
		await this.retireSession(s);
	}

	private async retireSession(s: Session): Promise<void> {
		await s.committing;
		await this.closeWriter(s);
		this.operations.sessions().delete(s.id);
	}

	private async closeWriter(s: Session): Promise<void> {
		s.unwatchWriter?.();
		if (!s.provisional) await this.operations.use<HistoryStore>("history-store")?.close(s.id);
	}

	watchWriter(s: Session): void {
		if (s.ephemeral || s.provisional) return;
		const signal = this.operations.use<HistoryStore>("history-store")?.writerSignal?.(s.id);
		if (!signal) return;
		const subscription = addAbortListener(signal, () => this.interruptSession(s, "writerLost", signal.reason));
		s.unwatchWriter = () => subscription[Symbol.dispose]();
	}

	interruptSession(s: Session, reason: SessionInterruptionReason, cause: unknown): void {
		if (s.suspended || s.closed) return;
		// Stop admission synchronously, before notifying anyone or waking a waiting call.
		s.suspended = true;
		this.operations.emit(s, "session.interrupted", { reason }, "harness");
		this.operations.jobWork().endJobObservation(s);
		s.interruption.abort(Object.assign(failure("lost", "Session was interrupted; reopen it to recover"), { cause }));
		this.stopSessionWork(s);
		for (const record of s.jobs.values()) void this.operations.jobWork().cancelJob(s, record.job.id).catch(error => this.operations.problem(record.job.plugin, "cancel interrupted job", error));
	}

	checkWriter(s: Session): void {
		s.interruption.signal.throwIfAborted();
		if (s.ephemeral || s.provisional) return;
		const store = this.operations.use<HistoryStore>("history-store");
		try {
			store?.writerSignal?.(s.id)?.throwIfAborted();
			store?.checkWriter?.(s.id);
		} catch (error) {
			this.interruptSession(s, "writerLost", error);
			s.interruption.signal.throwIfAborted();
			throw error;
		}
	}

	async write(s: Session, mutation: () => Promise<void> | undefined): Promise<void> {
		this.checkWriter(s);
		try { await mutation(); }
		catch (error) {
			const writerLost = this.operations.use<HistoryStore>("history-store")?.writerSignal?.(s.id)?.aborted || (error as { code?: string })?.code === "lost";
			this.interruptSession(s, writerLost ? "writerLost" : "commitFailed", error);
			s.interruption.signal.throwIfAborted();
			throw error;
		}
		s.interruption.signal.throwIfAborted();
	}

	async closeSession(id: string, actorId?: string, delegatedBy?: string, authority?: readonly Authority[]): Promise<void> {
		return startOperation("modular_agent.session.close", { ...conversation(id), "modular_agent.session.operation": "close" })
			.observe(() => this.closeSessionWithin(id, actorId, delegatedBy, authority));
	}

	private async closeSessionWithin(id: string, actorId?: string, delegatedBy?: string, authority?: readonly Authority[]): Promise<void> {
		const s = this.operations.sessions().get(id);
		if (!s) return;
		await this.operations.admission().admit(s, async () => {
			if (s.closing || s.reopening) throw Object.assign(new Error("Session is busy"), { code: "busy" });
			const needsCancel = !!s.running || this.operations.jobWork().runningJobs(s).length > 0 || this.operations.interfaceTools().unsettledHandoffs(s).length > 0;
			if ((needsCancel && authority && !authority.includes("cancel")) || [actorId, delegatedBy].some(id => id !== undefined &&
				(!s.actors.has(id) || (needsCancel && !this.operations.rightsOf(s, id).includes("cancel"))))) {
				throw Object.assign(new Error("Actor may not close this session"), { code: "forbidden" });
			}
			s.closing = true;
		});
		if (!s.interruption.signal.aborted) {
			await this.operations.admission().cancel(id);
			for (const { job } of this.operations.jobWork().runningJobs(s)) await this.operations.jobWork().cancelJob(s, job.id);
		}
		for (const r of s.requests.values()) r.resolve({ requestId: r.request.id, declined: true, actorId: "harness", reason: "session closed" });
		s.requests.clear();
		await this.operations.hooks().observe("session.end", { sessionId: id });
		await this.operations.use<WorkingEnvironment>("working-environment")?.sessionEnded?.(id);
		this.operations.emit(id, "session.ended", {}, "harness");
		s.closed = true;
		this.operations.interfaceTools().clearInterfaceWork(s);
		await this.retireSession(s);
	}

	async moveTo(sessionId: string, entryId: string, options: { rewind?: boolean; actorId?: string }, writer: string): Promise<{ outOfReach?: string[] }> {
		const s = this.session(sessionId);
		return this.operations.admission().admit(s, async () => {
			if (options.actorId) this.operations.requireAuthority(s, options.actorId, "settings");
			if (s.provisional) throw failure("invalid_request", "Session has not admitted its first input");
			if (s.isBusy() || s.outsideTools || s.erasing || s.settling || s.requests.size || this.operations.questions().waitingRequests(s).length || this.operations.turns().openCalls(s).length || this.operations.interfaceTools().unsettledHandoffs(s).length || this.operations.jobWork().runningJobs(s).length) {
				throw failure("busy", "Can't move while work is unfinished");
			}
			const target = s.branch().find((e) => e.id === entryId);
			if (!target) {
				if (s.entries.has(entryId)) throw Object.assign(new Error("Target is not a quiescent entry on the current branch"), { code: "conflict" });
				throw Object.assign(new Error("Unknown move target"), { code: "not_found" });
			}
			if (target.turnId && target.kind !== "turnEnd") throw Object.assign(new Error("Move target is inside a turn"), { code: "conflict" });
			s.moving = true;
			let journal: { point: string; undo: string } | undefined;
				const previous = s.position;
			const outOfReach: string[] = [];
			try {
				if (options.rewind) {
					const env = await this.operations.environmentFor(s);
					if (!env || !(env.keepsPoints?.(this.operations.projectOf(s)) ?? env.points) || !env.restore || !env.save || !env.hasPoint) throw failure("not_supported", "This environment cannot rewind");
					const branch = s.branch();
					const at = branch.findIndex((e) => e.id === entryId);
					if (at < 0) throw failure("conflict", "Rewind needs an entry on the current branch");
					const after = branch.slice(at + 1);
					if (after.some((e) => e.kind === "jobStarted" || e.kind === "harness.jobStarted" || e.kind === "jobEnded")) throw failure("conflict", "Cannot rewind past a job");
					for (const e of after) {
						if (e.kind !== "toolStarted" || !e.toolCallId) continue;
						const data = e.data as { call?: ToolCall; openWorld?: boolean } | undefined;
						const start = branch.find((start) => start.kind === "turnStart" && e.turnId && e.turnId === start.turnId);
						const tool = data?.call?.name;
						const definition = (start?.data as TurnSnapshot | undefined)?.tools?.find((t) => t.name === tool)
							?? (tool ? this.operations.findTool(s, tool)?.definition : undefined);
						if (data?.openWorld ?? true) outOfReach.push(e.toolCallId);
					}
					if ([...this.operations.sessions().values()].some((other) => other !== s && other.meta.project === s.meta.project)) throw Object.assign(new Error("Another open session uses the project"), { code: "conflict" });
					const points = after.filter((e) => e.kind === "turnStart" || (e.kind === "toolStarted" && !e.turnId))
						.map((e) => (e.data as { point?: string } | undefined)?.point);
					for (const point of points) if (!point || !await env.hasPoint(point)) {
						throw Object.assign(new Error("Saved point not found in this environment"), { code: "conflict" });
					}
					if (points.length) {
						journal = { point: points[0]!, undo: await env.save() };
						await this.operations.commit(s, [{ kind: "position", writer, actorId: options.actorId, modelVisible: false, data: { to: entryId, restore: journal } }]);
						await this.completeRewind(s, entryId, previous, journal, false);
					}
				}
				if (!journal) await this.operations.commit(s, [{ kind: "position", writer, actorId: options.actorId, modelVisible: false, data: { to: entryId } }]);
				const provider = this.operations.providerFor(s);
				if (provider?.supports.keepsState === true) await provider.discardState?.(s.id).catch((e) => this.operations.problem(writer, "discard provider state on move", e));
				this.operations.emit(s, "position.moved", { to: entryId }, writer);
				return outOfReach.length ? { outOfReach: [...new Set(outOfReach)] } : {};
			} finally { s.moving = false; }
		});
	}

	private async completeRewind(s: Session, to: string | null, previous: string | null, restore: { point: string; undo: string }, undoing: boolean): Promise<void> {
		const move = (target: string | null, intent?: typeof restore) => this.operations.commit(s, [{ kind: "position", writer: "harness", modelVisible: false, data: { to: target, ...(intent ? { restore: intent } : {}) } }]);
		const env = await this.operations.environmentFor(s);
		if (!env?.restore || !env.hasPoint || !(env.keepsPoints?.(this.operations.projectOf(s)) ?? env.points)) { s.suspended = true; throw failure("lost", "Rewind environment unavailable"); }
		const verify = async (point: string) => {
			try {
				if (!await env.hasPoint!(point)) throw failure("conflict", "Cannot verify ownership of rewind point");
			} catch (error) { s.suspended = true; throw error; }
		};
		await verify(restore.point);
		const check = () => this.checkWriter(s);
		try {
			check();
			await env.restore(restore.point);
		} catch (error) {
			if (undoing) { s.suspended = true; throw error; }
			try {
				check();
				await verify(restore.undo);
				await move(previous, { point: restore.undo, undo: restore.point });
				check();
				await env.restore(restore.undo);
				await move(previous);
			} catch (failure) { s.suspended = true; throw failure; }
			throw Object.assign(new Error("Rewind failed; original point restored", { cause: error }), { code: "conflict" });
		}
		try { await move(to); }
		catch (error) { s.suspended = true; throw error; }
	}
}

function copyForkPrefix(branch: HistoryEntry[], sessionId: string, makeId: () => string): HistoryEntry[] {
	const kept = branch.filter((e) => !e.erased && e.kind !== "position" && e.kind !== TURN_TRACE);
	const entries = new Map(kept.map((e) => [e.id, makeId()]));
	const associations = new Map<string, Map<string, string>>();
	const remap = (kind: string, id: string) => {
		const group = associations.get(kind) ?? new Map<string, string>();
		associations.set(kind, group);
		if (!group.has(id)) group.set(id, makeId());
		return group.get(id)!;
	};
	let parentId: string | null = null;
	return kept.map((old) => {
		const e: HistoryEntry = { ...structuredClone(historyForPeer(old)), id: entries.get(old.id)!, parentId, sessionId, sources: [old.id] };
		if (e.turnId) e.turnId = remap("turn", e.turnId);
		if (e.continuesTurnId) e.continuesTurnId = remap("turn", e.continuesTurnId);
		if (e.stepId) e.stepId = remap("step", e.stepId);
		if (e.toolCallId) e.toolCallId = remap("call", e.toolCallId);
		if (e.jobId) e.jobId = remap("job", e.jobId);
		if (e.inputId) e.inputId = remap("input", e.inputId);
		if (e.requestId) e.requestId = remap("request", e.requestId);
		if (e.message?.role === "assistant") for (const part of e.message.content) {
			if (isToolCall(part)) part.id = remap("call", part.id);
		}
		if (e.message?.role === "toolResult") e.message.toolCallId = remap("call", e.message.toolCallId);
		if (e.kind === "summary") {
			const data = e.data as { summary: string; summarizes?: string[] };
			data.summarizes = (data.summarizes ?? old.sources ?? []).flatMap((id) => entries.has(id) ? [entries.get(id)!] : []);
		}
		if (e.kind === "turnEnd") {
			const result = (e.data as { result: TurnOutcome["result"] }).result;
			result.openToolCalls = result.openToolCalls.map((id) => remap("call", id));
		}
		parentId = e.id;
		return e;
	});
}

export function actorJoined(actor: Actor, writer: string, actorId?: string): EntryDraft {
	const { authority, ...details } = actor;
	return { kind: "actorJoined", writer, actorId, modelVisible: false, data: { actor: { ...details, kind: details.kind === "plugin" ? "program" : details.kind, rights: authority }, ...(actorId ? {} : { operatorAdmission: true }) } };
}

