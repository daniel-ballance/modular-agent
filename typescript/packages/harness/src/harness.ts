import { parseModel } from "./settings.js";
import { SessionEnvironment } from "./working-environment.js";
import { Declarations } from "./declaration.js";
import type { Command, FollowOptions, Plugin, PluginApi, SessionPrepare, SessionStartOptions } from "./plugin-api.js";
import { Commands } from "./commands.js";
import { SessionAuthority, readTenants, intersectRights } from "./authority.js";
import { WorkReservations } from "./work-reservations.js";
import { HistoryCommit } from "./history-commit.js";
import { SessionLifecycle } from "./session-lifecycle.js";
import { InputAdmission } from "./input-admission.js";
import { TurnExecution } from "./turn-execution.js";
import { TurnModelAccess } from "./model-access.js";
import { ToolDispatch } from "./tool-dispatch.js";
import { InterfaceToolRoutes } from "./interface-tool-routes.js";
import { connectionRights } from "./connection-authority.js";
import { InputRequests } from "./input-requests.js";
import { Jobs } from "./jobs.js";
import { SessionErasure } from "./session-erasure.js";
import { ApprovalReconciliation } from "./approval-reconciliation.js";
import { failure } from "./failure.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { safeName } from "./telemetry.js";
import { Follower } from "./output-gate.js";
import { Reservations, reservationLimits, type ReservationOptions } from "./reservations.js";
import { RunReceipts, type ReceiptOperation } from "./run-receipts.js";
import { randomUUID } from "node:crypto";
import { HookRegistry } from "./hooks.js";
import { INTERFACE_SOURCE, type InterfaceToolConnection, type InterfaceToolConnectionOptions, type InterfaceToolSource } from "./interface-tools.js";
import { Session } from "./session.js";
import {
	type Actor,
	type AgentEvent,
	type Authority,
	type Configuration,
	type Declaration,
	type EntryDraft,
	type HistoryEntry,
	type HistoryStore,
	type HookRule,
	type InterfaceCapability,
	type ModelAccess,
	type ModelInfo,
	type Provider,
	type Runtime,
	type ToolDefinition,
	type ToolSource,
} from "./types.js";

export interface HarnessOptions { receiptDir?:string; approvalCoversNested?: boolean; agentName?: string; project: string; home: string; now?: () => number; newId?: () => string; questionsOutlastTurns?: boolean; settingsDuringTurn?: "nextTurn" | "refused"; jobReportsStartTurns?: boolean; rejectUnknownModel?: boolean; resourceReservations?: ReservationOptions; tenants?: Record<string, Tenant> | null }

export interface Tenant { rights: Authority[]; tokens?: number }
/**
 * The Harness: hosts plugins, offers the plugin API, keeps sessions.
 * It runs no turns, calls no models and runs no tools itself.
 */
export class Harness {
	private readonly environment: SessionEnvironment = new SessionEnvironment({
		use: (...args) => this.use(...args),
		projectOf: (...args) => this.projectOf(...args),
	});

	private readonly declarations: Declarations = new Declarations({
		runtime: (...args) => this.runtime(...args),
		use: (...args) => this.use(...args),
		providerFor: (...args) => this.providerFor(...args),
		interfaceTools: () => this.interfaceTools,
		projectOf: (...args) => this.projectOf(...args),
		project: () => this.project,
		hooks: () => this.hooks,
		jobReportsStartTurns: () => this.jobReportsStartTurns,
		erasure: () => this.erasure,
		reservations: () => this.reservations,
		questionsOutlastTurns: () => this.questionsOutlastTurns,
		approvals: () => this.approvals,
		tools: () => this.tools,
		settingsDuringTurn: () => this.settingsDuringTurn,
	});

	private readonly commandWork: Commands = new Commands({
		lifecycle: () => this.lifecycle,
		erasure: () => this.erasure,
		authority: () => this.authority,
		commandTable: () => this.commandTable,
		newId: (...args) => this.newId(...args),
		reservations: () => this.reservations,
		api: (...args) => this.api(...args),
		providerFor: (...args) => this.providerFor(...args),
		modelAccess: (...args) => this.modelAccess(...args),
		toolDefinitions: (...args) => this.toolDefinitions(...args),
		interfaceTools: () => this.interfaceTools,
		turns: () => this.turns,
		turnModels: () => this.turnModels,
		questions: () => this.questions,
		environmentFor: (...args) => this.environment.environmentFor(...args),
		scopedEnvironment: (...args) => this.environment.scopedEnvironment(...args),
	});

	private readonly authority: SessionAuthority = new SessionAuthority({
		tenants: () => this.tenants,
		historyCommit: () => this.historyCommit,
		hooks: () => this.hooks,
		emit: (...args) => this.emit(...args),
		questions: () => this.questions,
		approvals: () => this.approvals,
		sessions: () => this.sessions,
		jobWork: () => this.jobWork,
		admission: () => this.admission,
		use: (...args) => this.use(...args),
		turns: () => this.turns,
		tools: () => this.tools,
	});

	private readonly workReservations: WorkReservations = new WorkReservations({
		use: (...args) => this.use(...args),
		lifecycle: () => this.lifecycle,
		reservations: () => this.reservations,
		jobWork: () => this.jobWork,
	});

	private readonly historyCommit: HistoryCommit = new HistoryCommit({
		erasure: () => this.erasure,
		receiptOperation: () => this.receiptOperation,
		receipts: () => this.receipts,
		newId: (...args) => this.newId(...args),
		now: (...args) => this.now(...args),
		approvals: () => this.approvals,
		reservations: () => this.reservations,
		lifecycle: () => this.lifecycle,
		use: (...args) => this.use(...args),
		questions: () => this.questions,
		emit: (...args) => this.emit(...args),
		admission: () => this.admission,
	});

	private readonly lifecycle: SessionLifecycle = new SessionLifecycle({
		sessions: () => this.sessions,
		rebuildReservations: (...args) => this.workReservations.rebuildReservations(...args),
		use: (...args) => this.use(...args),
		erasure: () => this.erasure,
		tenants: () => this.tenants,
		newId: (...args) => this.newId(...args),
		now: (...args) => this.now(...args),
		project: () => this.project,
		workActors: (...args) => this.authority.workActors(...args),
		turnAuthority: () => this.authority.turnAuthority,
		workRights: (...args) => this.authority.workRights(...args),
		activePlugins: (...args) => this.activePlugins(...args),
		observeCommit: (...args) => this.historyCommit.observeCommit(...args),
		commit: (...args) => this.historyCommit.commit(...args),
		hooks: () => this.hooks,
		emit: (...args) => this.emit(...args),
		questions: () => this.questions,
		recoveryPolicy: (...args) => this.declarations.recoveryPolicy(...args),
		admission: () => this.admission,
		tools: () => this.tools,
		interfaceTools: () => this.interfaceTools,
		approvals: () => this.approvals,
		turns: () => this.turns,
		actorRights: (...args) => this.authority.actorRights(...args),
		withinLimits: (...args) => this.authority.withinLimits(...args),
		jobWork: () => this.jobWork,
		problem: (...args) => this.problem(...args),
		rightsOf: (...args) => this.authority.rightsOf(...args),
		requireAuthority: (...args) => this.authority.requireAuthority(...args),
		environmentFor: (...args) => this.environment.environmentFor(...args),
		projectOf: (...args) => this.projectOf(...args),
		findTool: (...args) => this.findTool(...args),
		providerFor: (...args) => this.providerFor(...args),
	});

	private readonly admission: InputAdmission = new InputAdmission({
		intersectRights,
		session: (...args) => this.lifecycle.session(...args),
		erasure: () => this.erasure,
		checkWriter: (...args) => this.lifecycle.checkWriter(...args),
		checkScopedWork: (...args) => this.authority.checkScopedWork(...args),
		requireAuthority: (...args) => this.authority.requireAuthority(...args),
		commandTable: () => this.commandTable,
		runCommand: (...args) => this.commandWork.runCommand(...args),
		newId: (...args) => this.newId(...args),
		hooks: () => this.hooks,
		receiptOperation: () => this.receiptOperation,
		commit: (...args) => this.historyCommit.commit(...args),
		rightsOf: (...args) => this.authority.rightsOf(...args),
		rejectUnknownModel: () => this.rejectUnknownModel,
		providerFor: (...args) => this.providerFor(...args),
		modelAccess: (...args) => this.modelAccess(...args),
		workRights: (...args) => this.authority.workRights(...args),
		runtime: (...args) => this.runtime(...args),
		reserveInput: (...args) => this.workReservations.reserveInput(...args),
		reservations: () => this.reservations,
		interfaceTools: () => this.interfaceTools,
		turns: () => this.turns,
		emit: (...args) => this.emit(...args),
		problem: (...args) => this.problem(...args),
		approvals: () => this.approvals,
	});

	private readonly turns: TurnExecution = new TurnExecution({
		intersectRights,
		commit: (...args) => this.historyCommit.commit(...args),
		newId: (...args) => this.newId(...args),
		problem: (...args) => this.problem(...args),
		reservations: () => this.reservations,
		emit: (...args) => this.emit(...args),
		runtime: (...args) => this.runtime(...args),
		modelAccess: (...args) => this.modelAccess(...args),
		interfaceTools: () => this.interfaceTools,
		toolDefinitions: (...args) => this.toolDefinitions(...args),
		turnAuthority: () => this.authority.turnAuthority,
		tenantBudgetReached: (...args) => this.authority.tenantBudgetReached(...args),
		environmentFor: (...args) => this.environment.environmentFor(...args),
		projectOf: (...args) => this.projectOf(...args),
		checkScopedWork: (...args) => this.authority.checkScopedWork(...args),
		erasure: () => this.erasure,
		hooks: () => this.hooks,
		use: (...args) => this.use(...args),
		turnModels: () => this.turnModels,
		agentName: () => this.agentName,
		now: (...args) => this.now(...args),
		approvals: () => this.approvals,
		questions: () => this.questions,
		admit: (...args) => this.admission.admit(...args),
		findTool: (...args) => this.findTool(...args),
		workRights: (...args) => this.authority.workRights(...args),
		actorForJob: (...args) => this.authority.actorForJob(...args),
		tools: () => this.tools,
		providerFor: (...args) => this.providerFor(...args),
	});

	private readonly turnModels: TurnModelAccess = new TurnModelAccess({
		newId: (...args) => this.newId(...args),
		turnAuthority: () => this.authority.turnAuthority,
		tenantBudgetReached: (...args) => this.authority.tenantBudgetReached(...args),
		erasure: () => this.erasure,
		reservations: () => this.reservations,
		checkScopedWork: (...args) => this.authority.checkScopedWork(...args),
		checkWriter: (...args) => this.lifecycle.checkWriter(...args),
		hooks: () => this.hooks,
		commit: (...args) => this.historyCommit.commit(...args),
		emit: (...args) => this.emit(...args),
		reserveCall: (...args) => this.workReservations.reserveCall(...args),
		step: (...args) => this.turns.step(...args),
	});

	private readonly tools: ToolDispatch = new ToolDispatch({
		now: (...args) => this.now(...args),
		interfaceTools: () => this.interfaceTools,
		approvals: () => this.approvals,
		intactInheritedCall: (...args) => this.turns.intactInheritedCall(...args),
		findTool: (...args) => this.findTool(...args),
		actorForJob: (...args) => this.authority.actorForJob(...args),
		workRights: (...args) => this.authority.workRights(...args),
		environmentFor: (...args) => this.environment.environmentFor(...args),
		projectOf: (...args) => this.projectOf(...args),
		checkWriter: (...args) => this.lifecycle.checkWriter(...args),
		commit: (...args) => this.historyCommit.commit(...args),
		erasure: () => this.erasure,
		agentName: () => this.agentName,
		emit: (...args) => this.emit(...args),
		jobWork: () => this.jobWork,
		scopedEnvironment: (...args) => this.environment.scopedEnvironment(...args),
		runtime: (...args) => this.runtime(...args),
		toolDefinitions: (...args) => this.toolDefinitions(...args),
		questions: () => this.questions,
		newId: (...args) => this.newId(...args),
		reservations: () => this.reservations,
		reserveCall: (...args) => this.workReservations.reserveCall(...args),
		problem: (...args) => this.problem(...args),
		approvalCoversNested: () => this.approvalCoversNested,
		plugins: (...args) => this.plugins(...args),
		hooks: () => this.hooks,
		rightsOf: (...args) => this.authority.rightsOf(...args),
	});

	private readonly interfaceTools: InterfaceToolRoutes = new InterfaceToolRoutes({
		runtime: (...args) => this.runtime(...args),
		plugins: (...args) => this.plugins(...args),
		useAll: (...args) => this.useAll(...args),
		now: (...args) => this.now(...args),
		hasItem: (...args) => this.hasItem(...args),
		replacements: () => this.replacements,
		intersectRights,
		load: (...args) => this.load(...args),
		session: (...args) => this.lifecycle.session(...args),
		withConnectionActor: (...args) => this.authority.withConnectionActor(...args),
		actorRights: (...args) => this.authority.actorRights(...args),
		sessions: () => this.sessions,
		hooks: () => this.hooks,
		problem: (...args) => this.problem(...args),
		findTool: (...args) => this.findTool(...args),
		erasure: () => this.erasure,
		admit: (...args) => this.admission.admit(...args),
		checkWriter: (...args) => this.lifecycle.checkWriter(...args),
		newId: (...args) => this.newId(...args),
		commit: (...args) => this.historyCommit.commit(...args),
		workRights: (...args) => this.authority.workRights(...args),
		agentName: () => this.agentName,
		maybeContinueOpenCalls: (...args) => this.turns.maybeContinueOpenCalls(...args),
		approvals: () => this.approvals,
		recordedTurnActors: (...args) => this.turns.recordedTurnActors(...args),
		recordedTurnJobs: (...args) => this.turns.recordedTurnJobs(...args),
		recordedTurnRights: (...args) => this.turns.recordedTurnRights(...args),
		turnAuthority: () => this.authority.turnAuthority,
		toolAfter: (...args) => this.tools.toolAfter(...args),
		commitNow: (...args) => this.historyCommit.commitNow(...args),
		emit: (...args) => this.emit(...args),
	});

	private readonly questions: InputRequests = new InputRequests({
		useAll: (...args) => this.useAll(...args),
		actorRights: (...args) => this.authority.actorRights(...args),
		turnAuthority: () => this.authority.turnAuthority,
		approvals: () => this.approvals,
		maybeContinueOpenCalls: (...args) => this.turns.maybeContinueOpenCalls(...args),
		use: (...args) => this.use(...args),
		home: () => this.home,
		commit: (...args) => this.historyCommit.commit(...args),
		toolWork: () => this.tools.toolWork,
		questionsOutlastTurns: () => this.questionsOutlastTurns,
		approvalPass: () => this.tools.approvalPass,
		gateSignal: () => this.tools.gateSignal,
		erasure: () => this.erasure,
		newId: (...args) => this.newId(...args),
		findTool: (...args) => this.findTool(...args),
		modelGate: () => this.tools.modelGate,
		emit: (...args) => this.emit(...args),
		reservations: () => this.reservations,
		problem: (...args) => this.problem(...args),
		openCalls: (...args) => this.turns.openCalls(...args),
	});

	private readonly jobWork: Jobs = new Jobs({
		erasure: () => this.erasure,
		workActors: (...args) => this.authority.workActors(...args),
		turnAuthority: () => this.authority.turnAuthority,
		workRights: (...args) => this.authority.workRights(...args),
		reservations: () => this.reservations,
		newId: (...args) => this.newId(...args),
		reserveJob: (...args) => this.workReservations.reserveJob(...args),
		commit: (...args) => this.historyCommit.commit(...args),
		toolWork: () => this.tools.toolWork,
		emit: (...args) => this.emit(...args),
		problem: (...args) => this.problem(...args),
		admit: (...args) => this.admission.admit(...args),
		jobReportsStartTurns: () => this.jobReportsStartTurns,
		startQueued: (...args) => this.turns.startQueued(...args),
		acceptInput: (...args) => this.admission.acceptInput(...args),
	});

	readonly receipts: RunReceipts;
	readonly receiptOperation = new AsyncLocalStorage<ReceiptOperation>();
	readonly hooks: HookRegistry;
	readonly project: string;
	readonly home: string;
	private caps = new Map<string, { plugin: string; impl: unknown }[]>();
	private loaded: { plugin: Plugin; api: PluginApi }[] = [];
	private sessions = new Map<string, Session>();
	private readonly erasure: SessionErasure;
	private readonly tenants: Map<string, Tenant>;
	private reservations: Reservations;
	private listeners: { plugin: string; raw: boolean; fn: (e: AgentEvent) => void }[] = [];
	private commandTable = new Map<string, Command & { plugin: string }>();
	private now: () => number;
	private readonly questionsOutlastTurns: boolean;
	private readonly approvalCoversNested: boolean;
	private readonly approvals: ApprovalReconciliation = new ApprovalReconciliation({
		now: () => this.now(),
		newId: () => this.newId(),
		reservations: () => this.reservations,
		findTool: (s, name) => this.findTool(s, name),
		actorRights: (s, actor) => this.authority.actorRights(s, actor),
		originalWorkAllows: (s, approval) => this.authority.originalWorkAllows(s, approval),
		exitTurn: work => this.authority.turnAuthority.exit(work),
		exitConnection: work => connectionRights.exit(work),
		commit: (...args) => this.historyCommit.commit(...args),
		commitNow: (...args) => this.historyCommit.commitNow(...args),
		interfaces: () => this.questions.interfaces(),
		emitAnswer: (...args) => this.questions.emitAnswer(...args),
		toolDisposition: (...args) => this.tools.toolDisposition(...args),
		maybeContinueOpenCalls: (...args) => this.turns.maybeContinueOpenCalls(...args),
		problem: (...args) => this.problem(...args),
		intersectRights,
	});
	private readonly settingsDuringTurn?: "nextTurn" | "refused";
	private readonly jobReportsStartTurns: boolean;
	private readonly rejectUnknownModel: boolean;
	private readonly agentName?: string;
	private newId: () => string;
	private refusedTools = new Set<string>();
	readonly problems: { plugin: string; where: string; error: string }[] = [];

	constructor(options: HarnessOptions) {
		this.reservations = new Reservations(reservationLimits(options.resourceReservations));
		this.tenants = readTenants(options.tenants === undefined ? process.env.MODULAR_AGENT_TENANTS : JSON.stringify(options.tenants ?? {}));
		this.project = options.project;
		this.home = options.home;
		this.receipts = new RunReceipts(options.receiptDir ?? options.home);
		this.erasure = new SessionErasure({
			sessions: this.sessions,
			receipts: this.receipts,
			store: () => this.use<HistoryStore>("history-store"),
			providers: () => this.useAll<Provider>("provider"),
			checkWriter: s => this.lifecycle.checkWriter(s),
			hasUnfinishedJobs: s => this.jobWork.runningJobs(s).length > 0,
			invalidateErasedHandoffs: (...args) => this.interfaceTools.invalidateErasedHandoffs(...args),
			commitNow: (...args) => this.historyCommit.commitNow(...args),
			write: (s, write) => this.lifecycle.write(s, write),
			emit: (...args) => this.emit(...args),
			loadInto: id => this.lifecycle.loadInto(id),
			requireAuthority: (...args) => this.authority.requireAuthority(...args),
			newId: () => this.newId(),
			problem: (...args) => this.problem(...args),
			actorRights: (s, actor) => this.authority.actorRights(s, actor),
		});
		this.now = options.now ?? Date.now;
		this.newId = options.newId ?? randomUUID;
		this.questionsOutlastTurns = options.questionsOutlastTurns ?? true;
		this.approvalCoversNested = options.approvalCoversNested === true;
		this.settingsDuringTurn = options.settingsDuringTurn;
		this.jobReportsStartTurns = options.jobReportsStartTurns ?? true;
		this.rejectUnknownModel = options.rejectUnknownModel === true;
		this.agentName = safeName(options.agentName);
		this.hooks = new HookRegistry(({ hook, plugin, error }) => this.problem(plugin, `hook ${hook}`, error));
		const h = (name: string, rule: HookRule, owner: string) => this.hooks.define(name, rule, owner);
		// Harness hook points
		h("plugin.load", "gate", "harness");
		h("session.prepare", "observe", "harness");
		h("session.start", "observe", "harness");
		h("session.end", "observe", "harness");
		h("session.join", "observe", "harness");
		h("session.leave", "observe", "harness");
		h("input", "transform", "harness");
		h("turn.before", "collect", "harness");
		h("output", "gate", "harness"); // applied by the Harness with its own rule: pass, redact, block or hold
		// The standard Runtime hook points, defined here so every Runtime offers the same set
		h("turn.start", "observe", "runtime");
		h("step.before", "transform", "runtime");
		h("step.after", "gate", "runtime");
		h("tool.before", "gate", "runtime");
		h("tool.after", "transform", "runtime");
		h("model.failed", "first", "runtime");
		h("turn.result", "gate", "runtime");
		h("turn.end", "observe", "runtime");
		// Provider hook points
		h("provider.request", "transform", "provider");
		h("provider.response", "observe", "provider");
		h("provider.piece", "observe", "provider");
	}

	async load(plugins: Plugin[]): Promise<void> {
		const replaced = new Set(plugins.map((p) => p.replaces).filter((r): r is string => !!r));
		for (const plugin of plugins) {
			if (replaced.has(plugin.name)) {
				this.emit("", "plugin.replaced", { plugin: plugin.name }, "harness");
				continue;
			}
			if (this.loaded.some((loaded) => loaded.plugin.name === plugin.name)) {
				this.problem(plugin.name, "load", new Error("A plugin with this name is already loaded"));
				continue;
			}
			const gate = await this.hooks.gate("plugin.load", { name: plugin.name, origin: plugin.origin ?? "global", project: this.project });
			if (gate.refused) {
				this.emit("", "plugin.refused", { plugin: plugin.name, reason: gate.refused }, "harness");
				continue;
			}
			const api = this.api(plugin.name);
			try {
				await plugin.setup(api);
				this.loaded.push({ plugin, api });
				this.emit("", "plugin.loaded", { plugin: plugin.name }, "harness");
			} catch (error) {
				this.problem(plugin.name, "setup", error);
			}
		}
	}

	/**
	 * Stop the process's part in every session. This is an interruption, not a
	 * close: running turns and jobs are abandoned without being recorded as ended,
	 * so reopening a session lets its Runtime and job plugins decide what happens.
	 */
	async interrupt(): Promise<void> {
		await Promise.all([...this.sessions.keys()].map(id => this.lifecycle.suspendSession(id)));
	}

	async stop(): Promise<void> {
		for (const id of [...this.sessions.keys()]) await this.lifecycle.suspendSession(id).catch(() => undefined);
		for (const { plugin } of [...this.loaded].reverse()) {
			try {
				await plugin.stop?.();
			} catch (error) {
				this.problem(plugin.name, "stop", error);
			}
		}
	}

	plugins(): string[] {
		return this.loaded.map((l) => l.plugin.name);
	}

	/** The plugin API, as seen by one plugin. The host uses its own copy, named "host". */
	api(pluginName: string): PluginApi {
		return {
			name: pluginName,
			project: this.project,
			home: this.home,
			projectOf: (sessionId) => this.projectOf(this.lifecycle.session(sessionId)),
			provide: (capability, impl) => this.provide(pluginName, capability, impl),
			use: <T>(capability: string) => this.use<T>(capability),
			useAll: <T>(capability: string) => this.useAll<T>(capability),
			defineHook: (name, rule) => this.hooks.define(name, rule, pluginName),
			on: (hook, handler, order, options) => this.hooks.on(hook, pluginName, handler, order, options?.stream),
			reportProblem: (where, error) => this.problem(pluginName, where, error),
			runHook: async (hook, payload) => {
				// Only the owner runs a hook point: the plugin that defined it, or a plugin providing the capability that owns it.
				const owner = this.hooks.owner(hook);
				const provides = this.caps.get(owner)?.some((c) => c.plugin === pluginName);
				if (owner !== pluginName && !provides) throw new Error(`${pluginName} can't run ${hook}: it belongs to ${owner}`);
				return this.hooks.run(hook, payload);
			},
			onEvent: (fn, options) => {
				if (options?.raw) {
					let queue = Promise.resolve();
					const entry = { plugin: pluginName, raw: true, fn: (event: AgentEvent) => {
						if (!this.erasure.httpErasure() || !event.sessionId) return fn(event);
						// Preserve event order for consumers that track input and turn IDs.
						queue = queue.then(async () => { await this.eventAdmission(event); fn(event); })
							.catch(e => this.problem(pluginName, "event listener", e));
					} };
					this.listeners.push(entry);
					return () => {
						this.listeners = this.listeners.filter((l) => l !== entry);
					};
				}
				// Plugins that follow events see the gated view unless they ask for the raw one.
				const follower = new Follower(this.hooks, `plugin:${pluginName}`, false, fn, (e) => this.problem(pluginName, "event listener", e), undefined, undefined, event => this.eventAdmission(event));
				this.pluginFollowers.push(follower);
				return () => {
					this.pluginFollowers = this.pluginFollowers.filter((f) => f !== follower);
				};
			},
			emit: (sessionId, type, data, ids) => this.emit(sessionId, type, data, pluginName, ids),
			registerCommand: (name, command) => {
				if (this.replacedFor(pluginName, `command:${name}`)) return;
				const previous = this.commandTable.get(name);
				if (previous && !this.replacedFor(previous.plugin, `command:${name}`)) this.problem(pluginName, "registerCommand", new Error(`Command /${name} is already registered`));
				else this.commandTable.set(name, { ...command, plugin: pluginName });
			},
			commands: () => [...this.commandTable].map(([name, c]) => ({ name, description: c.description, plugin: c.plugin })),
			runCommand: (sessionId, line, actorId) => this.commandWork.runCommand(sessionId, line, actorId),
			startSession: (options) => this.lifecycle.startSession(options),
			openSession: (id, actor, prepare, operation) => this.lifecycle.openSession(id, actor, prepare, operation),
			join: (sessionId, actor, grantedBy) => this.authority.join(this.lifecycle.session(sessionId), actor, grantedBy, pluginName),
			leave: async (sessionId, actorId, requestedBy) => {
				const s = this.lifecycle.session(sessionId);
				if (requestedBy && requestedBy !== actorId) this.authority.requireAuthority(s, requestedBy, "grant");
				if (!s.actors.has(actorId)) throw new Error(`Actor ${actorId} is not part of this session`);
				await this.historyCommit.commit(s, [{ kind: "actorLeft", writer: pluginName, actorId, modelVisible: false, data: { actorId } }]);
				await this.hooks.observe("session.leave", { sessionId, actorId, requestedBy });
				this.emit(s, "session.left", { actorId }, pluginName, { actorId });
				await this.questions.closeRevokedWaits(s);
				await this.approvals.reconcileApprovals(s);
			},
			presentActors: (id) => this.questions.presentActors(this.lifecycle.session(id)),
			presenceChanged: (id) => { const s = this.sessions.get(id); if (s) {
				this.approvals.presenceChanged(s);
				void this.questions.closeUnanswerable(s).catch(e => this.problem("harness", "close unanswerable wait", e));
			} },
			listSessions: async (project) => (await this.use<HistoryStore>("history-store")?.list(project === null ? undefined : { project: project ?? this.project })) ?? [],
			sessionSummary: (id, viewer) => this.lifecycle.sessionSummary(id, viewer),
			forkSession: (sessionId, entryId) => this.lifecycle.forkSession(sessionId, entryId),
			closeSession: (id, actorId, delegatedBy, authority) => this.lifecycle.closeSession(id, actorId, delegatedBy, authority),
			session: (id) => {
				const s = this.lifecycle.session(id);
				return { id: s.id, project: s.meta.project, tenant: s.tenant, settings: { ...s.settings }, position: s.position, busy: s.isBusy(), actors: [...s.actors.values()].map((a) => ({ ...a, authority: this.authority.rightsOf(s, a.id) })), ephemeral: s.ephemeral };
			},
			input: (sessionId, options) => this.admission.input(sessionId, options),
			withdraw: (sessionId, inputId) => this.admission.withdraw(sessionId, inputId),
			proposals: (id, actorId) => {
				const s = this.lifecycle.session(id);
				this.authority.requireAuthority(s, actorId, "watch");
				return [...s.proposals.values()].map((q) => ({ inputId: q.id, actorId: q.actorId, content: q.content, time: q.time! }));
			},
			withdrawProposal: (id, inputId, actorId, delegatedBy) => this.admission.withdrawProposal(this.lifecycle.session(id), inputId, actorId, delegatedBy),
			cancel: (sessionId) => this.admission.cancel(sessionId),
			releaseInput: (id, inputId, when, actorId, declined) => this.admission.releaseInput(this.lifecycle.session(id), inputId, when, actorId, declined),
			recoveredInput: (id) => this.lifecycle.session(id).recoveredInput,
			waitForIdle: (sessionId) => this.admission.waitForIdle(sessionId),
			moveTo: (sessionId, entryId, options) => this.lifecycle.moveTo(sessionId, entryId, options ?? {}, pluginName),
			setSetting: (sessionId, key, value, actorId) => this.setSetting(this.lifecycle.session(sessionId), key, value, pluginName, actorId),
			setLimit: (id, rights, actorId) => this.authority.setLimit(this.lifecycle.session(id), rights, actorId, pluginName),
			tenant: (id) => this.authority.tenantInfo(this.lifecycle.session(id)),
			checkPending: id => this.erasure.admitHistory(this.lifecycle.session(id)),
			readHistory: (id, options) => this.inspectHistory(id, options ?? {}, entries => entries),
			inspectHistory: (id, options, inspect) => this.inspectHistory(id, options, inspect),
			history: (sessionId, options) => {
				const s = this.lifecycle.session(sessionId);
				this.authority.checkScopedWork(s, "watch");
				if (this.erasure.httpErasure() && !s.provisional) throw failure("unavailable", "HTTP history requires asynchronous readHistory");
				this.erasure.checkPending(s);
				return options?.all ? s.order.map((id) => s.entries.get(id)!) : s.branch();
			},
			append: async (sessionId, draft) => (await this.historyCommit.commit(this.lifecycle.session(sessionId), [{ ...draft, writer: draft.writer ?? pluginName }], true))[0],
			transaction: (sessionId, fn) => this.historyCommit.transaction(this.lifecycle.session(sessionId), pluginName, fn),
			erase: (sessionId, ids, actorId) => this.erasure.erase(this.lifecycle.session(sessionId), ids, actorId, pluginName),
			tools: (sessionId) => this.toolDefinitions(sessionId ? this.lifecycle.session(sessionId) : undefined),
			callTool: (sessionId, call) => this.tools.callTool(this.lifecycle.session(sessionId), { ...call, id: call.id ?? this.newId() }),
			ask: (sessionId, request) => this.questions.ask(this.lifecycle.session(sessionId), request, pluginName),
			deferTool: (id, turnId, question) => this.questions.deferTool(this.lifecycle.session(id), turnId, question, pluginName),
			refreshApprovals: id => this.approvals.reconcileApprovals(this.lifecycle.session(id)),
			registerApprovalRoute: policy => this.approvals.registerRoute(policy),
			presentApproval: (id, requestId, delivery) => this.approvals.presentApproval(this.lifecycle.session(id), requestId, delivery),
			submitAnswer: (sessionId, answer, handle) => this.questions.submitAnswer(this.lifecycle.session(sessionId), answer, handle),
			openRequests: (sessionId) => {
				const s = this.lifecycle.session(sessionId);
				return [...[...s.requests.values()].map((r) => r.request), ...this.questions.waitingRequests(s)];
			},
			startJob: (sessionId, options) => this.jobWork.startJob(this.lifecycle.session(sessionId), options, pluginName),
			workActors: (id) => this.authority.workActors(this.lifecycle.session(id)),
			workJobs: (id) => { const work = this.authority.turnAuthority.getStore(); return work?.sessionId === id ? [...work.jobs] : []; },
			workMay: (id, right, actors, jobs) => this.authority.workRights(this.lifecycle.session(id), actors, jobs).includes(right),
			jobTrace: (id, jobId) => {
				const s = this.lifecycle.session(id);
				return s.jobs.get(jobId)?.job.plugin === pluginName ? this.jobWork.jobSpans.get(s)?.get(jobId) : undefined;
			},
			findJob: (jobId) => {
				for (const s of this.sessions.values()) {
					if (s.order.some((id) => { const e = s.entries.get(id)!; return e.kind === "jobStarted" && e.jobId === jobId && e.writer === pluginName; })) return { sessionId: s.id };
				}
				return undefined;
			},
			onJobCancel: (handler) => this.jobWork.jobCancels.set(pluginName, handler),
			unfinishedJobs: (id) => this.jobWork.runningJobs(this.lifecycle.session(id)).filter(({ job }) => job.plugin === pluginName),
			resumeJob: (id, jobId) => {
				const s = this.lifecycle.session(id);
				const found = this.jobWork.runningJobs(s).find((j) => j.job.id === jobId && j.job.plugin === pluginName);
				if (!found) throw new Error(`No unfinished job ${jobId} of ${pluginName}`);
				return s.jobs.get(jobId)?.handle ?? this.jobWork.jobHandle(s, found);
			},
			jobs: (id) => {
				const s = this.lifecycle.session(id);
				const cleanup = new Set(s.order.map((eid) => s.entries.get(eid)!).filter((e) => e.kind === "jobCleanupUnconfirmed").map((e) => e.jobId));
				return this.jobWork.runningJobs(s).map(({ job }) => ({ ...job, state: cleanup.has(job.id) ? "cleanupUnconfirmed" as const : s.jobs.has(job.id) ? "running" as const : "unfinished" as const }));
			},
			cancelJob: (sessionId, jobId) => this.jobWork.cancelJob(this.lifecycle.session(sessionId), jobId),
			sessionInterruption: id => this.lifecycle.session(id).interruption.signal,
			follow: (sessionId, options, listener) => this.follow(this.lifecycle.session(sessionId), options, listener),
			flushOutput: async (id, recipient) => {
				const followers = [...(this.sessions.get(id)?.followers ?? [])].filter((f) => f.recipient === recipient);
				await Promise.all(followers.map((f) => f.idle()));
			},
			gateOutput: async (sessionId, recipient, type, data, ids) => {
				const s = this.sessions.get(sessionId);
				const freshness = s && await this.erasure.admitHistory(s);
				let out: typeof data | undefined;
				let overflow = false;
				const follower = new Follower(this.hooks, recipient, false, (e) => { if (e.type === type) out = e.data; }, (e) => { if ((e as {code?: string}).code === "result_too_large") overflow = true; else this.problem("harness", "output gate", e); }, undefined, undefined,
					s && this.erasure.httpErasure() ? () => this.erasure.admitHistory(s).then(current => { if (current !== freshness) throw failure("unavailable", "Erasure changed the output view"); }) : undefined);
				follower.push({ type, time: this.now(), sessionId, source: pluginName, ...ids, data });
				if (type === "model.output") follower.push({ type: "model.streamEnd", time: this.now(), sessionId, source: pluginName, ...ids });
				await follower.idle();
				if (s && await this.erasure.admitHistory(s) !== freshness) throw failure("unavailable", "Erasure changed the output view");
				if (overflow && type === "reply") throw failure("result_too_large", "Reply exceeds the gate limit");
				return out;
			},
			declaration: (sessionId) => this.declarations.declaration(sessionId ? this.lifecycle.session(sessionId) : undefined),
			gatedHistory: async (sessionId, options) => {
				const s = this.lifecycle.session(sessionId);
				await this.erasure.reconcilePending(s);
				const freshness = await this.erasure.admitHistory(s);
				const entries = options.all ? s.order.map((id) => s.entries.get(id)!) : s.branch();
				const out: HistoryEntry[] = [];
				const follower = new Follower(this.hooks, options.recipient, false, (e) => { if (e.type === "entry") out.push(e.data as HistoryEntry); }, (e) => this.problem("harness", "gated history", e), undefined, undefined,
					this.erasure.httpErasure() ? () => this.erasure.admitHistory(s).then(current => { if (current !== freshness) throw failure("unavailable", "Erasure changed the history view"); }) : undefined);
				for (const entry of entries) {
					follower.push({ type: "entry", time: this.now(), sessionId: s.id, source: "harness", data: entry });
					await follower.idle();
				}
				if (await this.erasure.admitHistory(s) !== freshness) throw failure("unavailable", "Erasure changed the history view");
				return out;
			},
			modelAccess: (sessionId) => this.modelAccess(this.lifecycle.session(sessionId)),
			config: () => this.use<Configuration>("configuration")?.plugin(pluginName) ?? {},
		};
	}

	/**
	 * Items one plugin deliberately takes over from the others: "working-environment",
	 * "provider:<id>", "tool:<name>" or "command:<name>", mapped to the plugin that owns
	 * them. A plugin in another process names these in its registration
	 * (docs/bindings/plugin.md); everyone else's copy is left out, not shadowed.
	 */
	readonly replacements = new Map<string, string>();
	private replacedFor(plugin: string, item: string): boolean {
		const owner = this.replacements.get(item);
		return owner !== undefined && owner !== plugin;
	}

	private provide(plugin: string, capability: string, impl: unknown): void {
		if (capability === "working-environment" && this.replacedFor(plugin, "working-environment")) return;
		if (capability === "runtime" && this.replacedFor(plugin, "runtime")) return;
		if (capability === "provider" && this.replacedFor(plugin, `provider:${(impl as { id?: string }).id}`)) return;
		const list = this.caps.get(capability) ?? [];
		list.push({ plugin, impl });
		this.caps.set(capability, list);
		this.emit("", "capability.provided", { capability, plugin }, "harness");
	}

	use<T>(capability: string): T | undefined {
		return this.useAll<T>(capability)[0];
	}

	useAll<T>(capability: string): T[] {
		return (this.caps.get(capability) ?? []).filter(({ plugin, impl }) => {
			const item = capability === "provider" ? `provider:${(impl as Provider).id}` : capability;
			return !this.replacedFor(plugin, item);
		}).map((c) => c.impl as T);
	}

	hasItem(item: string): boolean {
		if (item.startsWith("provider:")) return this.useAll<Provider>("provider").some((p) => `provider:${p.id}` === item);
		if (item.startsWith("tool:")) return !!this.findTool(undefined, item.slice(5));
		if (item.startsWith("command:")) return this.commandTable.has(item.slice(8));
		return !!this.use(item);
	}

	private emit(session: string | Session, type: string, data: any, source: string, ids?: Partial<AgentEvent>): void {
		const sessionId = typeof session === "string" ? session : session.id;
		const s = this.sessions.get(sessionId);
		if (typeof session !== "string" && session !== s) return; // An old writer must not publish to a reopened session.
		const event: AgentEvent = { type, time: this.now(), sessionId, source, ...ids, data };
		if (s) this.eventViews.set(event, { session: s, epoch: this.erasure.epoch(s) });
		if (s?.interruption.signal.aborted && type !== "session.ended") return;
		if (type !== "session.interrupted") s?.remember(event);
		for (const l of [...this.listeners]) {
			try {
				l.fn(event);
			} catch (error) {
				if (type !== "plugin.problem") this.problem(l.plugin, "event listener", error);
			}
		}
		for (const f of s?.followers ?? []) f.push(event);
		for (const f of this.pluginFollowers) f.push(event);
	}

	private problem(plugin: string, where: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.problems.push({ plugin, where, error: message });
		this.emit("", "plugin.problem", { plugin, where, error: message }, "harness");
	}

	private pluginFollowers: Follower[] = [];
	private eventViews = new WeakMap<AgentEvent, { session: Session; epoch: number }>();
	private eventAdmission(event: AgentEvent): Promise<void> | undefined {
		if (!this.erasure.httpErasure() || !event.sessionId || ["session.interrupted", "entries.erased", "session.ended"].includes(event.type)) return;
		const view = this.eventViews.get(event);
		const s = view?.session ?? this.sessions.get(event.sessionId);
		if (!s || s !== this.sessions.get(event.sessionId) || view && view.epoch !== this.erasure.epoch(s)) return Promise.reject(failure("unavailable", "The queued event no longer has a current view"));
		return this.erasure.admitHistory(s).then(() => undefined);
	}

	private follow(s: Session, options: FollowOptions, listener: (event: AgentEvent) => unknown): (() => void) & { idle(): Promise<void> } {
		const follower = new Follower(this.hooks, options.recipient, options.raw ?? false, event => {
			if (!["session.interrupted", "entries.erased"].includes(event.type)) this.erasure.checkPending(s);
			if (event.type === "entry" || event.type === "entry.added") {
				const current = s.entries.get((event.data as HistoryEntry)?.id);
				if (current?.erased && !event.data?.erased) return;
			}
			return listener(event);
		}, (e) => this.problem("harness", "follow", e),
			() => { s.followers.delete(follower); options.onLag?.(); },
			bytes => {
				const key = `output:${this.newId()}`;
				if (!this.reservations.reserve(s, key, { bufferedBytes: bytes })) return undefined;
				return () => this.reservations.release(s, key);
			}, event => this.eventAdmission(event), options.include);
		// History first, from the requested point, then live events.
		const from = options.fromEntry ?? s.order.length;
		for (const id of s.order.slice(from)) {
			const event = { type: "entry", time: this.now(), sessionId: s.id, source: "harness", data: s.entries.get(id) };
			this.eventViews.set(event, { session: s, epoch: this.erasure.epoch(s) });
			follower.push(event);
		}
		if (!follower.closed) s.followers.add(follower);
		return Object.assign(() => { s.followers.delete(follower); follower.disconnect(); }, { idle: () => follower.idle() });
	}

	resourceLimits() { return structuredClone(this.reservations.limits); }

	shareReservations(serving: Harness) {
		serving.reservations.adopt(this.reservations);
		this.reservations = serving.reservations;
	}

	rebuildReservations(): Promise<void> {
		return this.workReservations.rebuildReservations();
	}

	session(id: string): Session {
		return this.lifecycle.session(id);
	}

	/** Live metadata for another connection attaching to a session in this process. */
	liveSessionInfo(id: string) {
		return this.lifecycle.liveSessionInfo(id);
	}

	startSession(options: SessionStartOptions = {}): Promise<string> {
		return this.lifecycle.startSession(options);
	}

	openSession(id: string, actor?: Actor, prepare?: SessionPrepare, operation: "load" | "resume" = "resume"): Promise<string> {
		return this.lifecycle.openSession(id, actor, prepare, operation);
	}

	/** Startup recovery never waits for a writer and rechecks the record under the lease. */
	resumeInterruptedSession(id: string, actor: Actor): Promise<boolean> {
		return this.lifecycle.resumeInterruptedSession(id, actor);
	}

	/** Check the operator's creation ceiling before allocating a provisional session. */
	tenantAllows(tenant: string | undefined, right: Authority): boolean {
		return this.authority.tenantAllows(tenant, right);
	}

	/** Discovery is the open authority check without joining or taking a writer lease. */
	canDiscoverSession(id: string, actor: Actor, severalActors: boolean): Promise<boolean> {
		return this.lifecycle.canDiscoverSession(id, actor, severalActors);
	}

	/** A host read never joins the viewer, takes a writer or starts recovery. Capture the
	 * branch, the commit offset and effective rights without yielding between them. */
	hostView(id: string, actor: Actor, scope: (project: string, tenant: string | null) => boolean) {
		return this.lifecycle.hostView(id, actor, scope);
	}

	private activePlugins() { return this.loaded.map(({ plugin: { name, origin } }) => ({ name, ...(origin ? { origin } : {}) })); }

	forkSession(sessionId: string, entryId: string): Promise<string> {
		return this.lifecycle.forkSession(sessionId, entryId);
	}

	closeSession(id: string, actorId?: string, delegatedBy?: string, authority?: readonly Authority[]): Promise<void> {
		return this.lifecycle.closeSession(id, actorId, delegatedBy, authority);
	}

	/** Commit drafts to the session. All are kept, or none are. */
	commit(s: Session, drafts: EntryDraft[], pluginRecord = false, guard?: () => boolean | Promise<boolean>): Promise<HistoryEntry[]> {
		return this.historyCommit.commit(s, drafts, pluginRecord, guard);
	}

	private async setSetting(s: Session, key: string, value: unknown, writer: string, actorId?: string): Promise<void> {
		if (actorId) this.authority.requireAuthority(s, actorId, "settings");
		if (this.settingsDuringTurn === "refused" && s.isBusy()) throw Object.assign(new Error("Cannot change settings during a turn"), { code: "busy" });
		await this.historyCommit.commit(s, [{ kind: "setting", writer, actorId, modelVisible: false, data: { key, value } }]);
		if (s.hasWaitingApprovals) await this.approvals.reconcileApprovals(s);
		this.emit(s, "setting.changed", { key, value, appliesFrom: this.settingsDuringTurn === "nextTurn" ? "next turn" : "next step" }, writer, { actorId });
	}

	private inspectHistory<T>(id: string, options: { all?: boolean }, inspect: (entries: HistoryEntry[]) => T): T | Promise<T> {
		const s = this.lifecycle.session(id);
		const snapshot = () => {
			this.authority.checkScopedWork(s, "watch");
			return inspect(options.all ? s.order.map(id => s.entries.get(id)!) : s.branch());
		};
		if (this.erasure.httpErasure() && !s.provisional) return this.erasure.admitHistory(s).then(snapshot);
		this.erasure.checkPending(s);
		return snapshot();
	}

	/** Apply the token ceiling to this connection's operations without rewriting recorded grants. */
	withConnectionActor<T>(actor: Actor, run: () => T): T {
		return this.authority.withConnectionActor(actor, run);
	}

	private runtime(): Runtime | undefined {
		return this.use<Runtime>("runtime");
	}

	private providerFor(s: Session, ref = parseModel(s.settings.model) as ReturnType<typeof parseModel> | null): Provider | undefined {
		if (!ref) return undefined;
		return this.useAll<Provider>("provider").find((p) => p.id === ref.provider);
	}

	private modelAccess(s: Session, ref = parseModel(s.settings.model) as ReturnType<typeof parseModel> | null): ModelAccess | undefined {
		const provider = this.providerFor(s, ref);
		if (!ref || !provider) return undefined;
		const info: ModelInfo | undefined = provider.models().find((m) => m.id === ref.id);
		if (!info) return undefined;
		return {
			model: info,
			supports: provider.supports,
			prepareOnWire: provider.prepareOnWire,
			inProcessInference: provider.inProcessInference,
			request: async (request, options) => {
				const available = provider.prepareOnWire ? true : await provider.available?.().catch(() => false);
				options.signal.throwIfAborted();
				if (available === false) return { role: "assistant", stop: "failed", content: [],
					error: { kind: "credentials", message: "Provider is not available" } };
				return provider.request(ref, request, { ...options, sessionId: s.id });
			},
		};
	}

	projectOf(s: Session): string {
		return typeof s.settings.cwd === "string" ? s.settings.cwd : this.project;
	}
	withInterfaceOffer<T>(scope: symbol, work: () => T): T {
		return this.interfaceTools.withInterfaceOffer(scope, work);
	}

	registerInterfaceTools(sources: readonly InterfaceToolSource[]): Promise<void> {
		return this.interfaceTools.registerInterfaceTools(sources);
	}

	connectInterfaceTools(sessionId: string, options: InterfaceToolConnectionOptions): InterfaceToolConnection {
		return this.interfaceTools.connectInterfaceTools(sessionId, options);
	}

	private findTool(s: Session | undefined, name: string): { plugin: string; source: ToolSource; definition: ToolDefinition } | undefined {
		for (const { plugin, impl } of this.caps.get("tool-source") ?? []) {
			if (this.interfaceTools.interfaceSources.has(name) && plugin !== INTERFACE_SOURCE) continue;
			const source = impl as ToolSource;
			const definition = source.tools(s?.id).find((t) => t.name === name && !this.replacedFor(plugin, `tool:${t.name}`));
			if (definition) return { plugin, source, definition };
		}
		return undefined;
	}

	private toolDefinitions(s?: Session): ToolDefinition[] {
		const seen = new Set<string>();
		const out: ToolDefinition[] = [];
		for (const { plugin, impl } of this.caps.get("tool-source") ?? []) {
			const source = impl as ToolSource;
			for (const t of source.tools(s?.id)) {
				if (this.interfaceTools.interfaceSources.has(t.name) && plugin !== INTERFACE_SOURCE) continue;
				if (this.replacedFor(plugin, `tool:${t.name}`)) continue;
				if (seen.has(t.name)) {
					// A name is never silently shadowed: the later source's tool is refused, and said so once.
					const key = `${source.id}:${t.name}`;
					if (!this.refusedTools.has(key)) {
						this.refusedTools.add(key);
						this.problem(source.id, "tools", new Error(`Tool ${t.name} is already offered by another tool source; this one is refused`));
					}
					continue;
				}
				seen.add(t.name);
				out.push(t);
			}
		}
		return out;
	}

	/** Attach a connection without adding a persistent plugin registration. */
	connectInterface(part: InterfaceCapability): () => void {
		return this.questions.connectInterface(part);
	}

	enableWaitingApprovals(maximum: number): void {
		if (!Number.isSafeInteger(maximum) || maximum <= 0 || !this.questionsOutlastTurns || !this.plugins().includes("approval") ||
			this.runtime()?.supports.interfaceTools !== true) throw failure("invalid_composition", "Waiting approvals need a positive Duration and a Runtime that continues settled calls");
		this.approvals.maximum = maximum;
	}

	declaration(s?: Session): Declaration {
		return this.declarations.declaration(s);
	}
}
