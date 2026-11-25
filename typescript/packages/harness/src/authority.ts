import type { Tenant } from "./harness.js";
import { actorJoined } from "./session-lifecycle.js";
import { InputAdmission } from "./input-admission.js";
import { TurnExecution, tokenCount } from "./turn-execution.js";
import { ToolDispatch } from "./tool-dispatch.js";
import type { TurnState } from "./turn-state.js";
import { connectionRights } from "./connection-authority.js";
import { InputRequests } from "./input-requests.js";
import { Jobs } from "./jobs.js";
import { ApprovalReconciliation } from "./approval-reconciliation.js";
import { failure } from "./failure.js";
import { type WaitingApproval } from "./waiting-approval.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { HookRegistry } from "./hooks.js";
import { Session } from "./session.js";
import type { Actor, AgentEvent, Authority, EntryDraft, HistoryEntry, HistoryStore, Usage } from "./types.js";

export const ALL_AUTHORITY: Authority[] = ["watch", "propose", "input", "answer", "approve", "tools", "cancel", "settings", "erase", "grant", "jobs", "delegate", "administer"];

export interface TenantInfo { tenant: string | null; rights: Authority[] | null; tokens: { budget: number; used: number } | null }

interface SessionAuthorityOperations {
	tenants(): ReadonlyMap<string, Tenant>;
	commit(s: Session, drafts: EntryDraft[]): Promise<HistoryEntry[]>;
	hooks(): HookRegistry;
	emit(session: string | Session, type: string, data: any, source: string, ids?: Partial<AgentEvent>): void;
	questions(): Pick<InputRequests, "closeRevokedWaits">;
	approvals(): Pick<ApprovalReconciliation, "reconcileApprovals">;
	sessions(): ReadonlyMap<string, Session>;
	jobWork(): Pick<Jobs, "readJob">;
	admission(): Pick<InputAdmission, "admit">;
	use<T>(capability: string): T | undefined;
	turns(): Pick<TurnExecution, "recordedTurnActors" | "recordedTurnJobs" | "recordedTurnRights">;
	tools(): Pick<ToolDispatch, "toolWork">;
}

export class SessionAuthority {
	constructor(private readonly operations: SessionAuthorityOperations) {}

	turnAuthority = new AsyncLocalStorage<{ sessionId: string; actors: Set<string>; jobs: Set<string>; state?: Pick<TurnState, "connectionRights" | "startingRights"> }>();

	tenantAllows(tenant: string | undefined, right: Authority): boolean {
		return tenant === undefined || this.operations.tenants().get(tenant)?.rights.includes(right) === true;
	}

	/** Authority only narrows: a granted actor can do no more than whoever grants it. */
	async join(s: Session, actor: Actor, grantedBy: string, writer: string): Promise<void> {
		this.requireAuthority(s, grantedBy, "grant");
		const beyond = actor.authority.filter((a) => !ALL_AUTHORITY.includes(a) || !this.rightsOf(s, grantedBy).includes(a));
		if (beyond.length) throw Object.assign(new Error(`${grantedBy} can't grant ${beyond.join(", ")}`), { code: "forbidden" });
		await this.operations.commit(s, [actorJoined(actor, writer, grantedBy)]);
		await this.operations.hooks().observe("session.join", { sessionId: s.id, actorId: actor.id, actor, grantedBy });
		this.operations.emit(s, "session.joined", { actor }, writer, { actorId: actor.id });
		await this.operations.questions().closeRevokedWaits(s);
		await this.operations.approvals().reconcileApprovals(s);
	}

	requireAuthority(s: Session, actorId: string, authority: Authority): void {
		const actor = s.actors.get(actorId);
		if (!actor || !this.rightsOf(s, actorId).includes(authority)) {
			throw Object.assign(new Error(`Actor ${actorId} may not ${authority}`), { code: "forbidden" });
		}
	}

	withinLimits(s: Session, right: Authority): boolean {
		const tenant = s.tenant === undefined ? undefined : this.operations.tenants().get(s.tenant);
		return ALL_AUTHORITY.includes(right) && (right === "administer" || s.limit === null || s.limit.includes(right)) &&
			(s.tenant === undefined || tenant?.rights.includes(right) === true);
	}

	withConnectionActor<T>(actor: Actor, run: () => T): T {
		return this.turnAuthority.exit(() => connectionRights.run({ [actor.id]: [...actor.authority] }, run));
	}

	actorRights(s: Session, actorId: string): Authority[] {
		const scope = this.turnAuthority.getStore();
		const ceilings = [connectionRights.getStore(), scope?.state?.connectionRights].flatMap(rights =>
			rights && Object.hasOwn(rights, actorId) ? [rights[actorId]] : []);
		const allowed = (s.actors.get(actorId)?.authority ?? []).filter(right => ceilings.every(ceiling => ceiling.includes(right)) && this.withinLimits(s, right));
		if (!s.meta.parentSessionId) return allowed;
		const parent = this.operations.sessions().get(s.meta.parentSessionId);
		const link = s.order.map((id) => s.entries.get(id)!).find((e) => e.kind === "harness.parentAuthority");
		const work = link?.data as { actors?: string[]; jobs?: string[]; rights?: Authority[] } | undefined;
		return allowed.filter((right) => parent
			? (work?.rights ?? ["watch"]).includes(right) && this.workRights(parent, work?.actors ?? [], work?.jobs).includes(right)
			: right === "watch");
	}

	actorForJob(s: Session, jobs?: Set<string>): string | undefined {
		return s.order.map((id) => s.entries.get(id)!).find((e) => e.kind === "jobStarted" && e.jobId && jobs?.has(e.jobId))?.actorId;
	}

	workRights(s: Session, actors: Iterable<string>, jobs: Iterable<string> = []): Authority[] {
		const owners = [...actors].map((id) => this.actorRights(s, id));
		const recordedJobs = [...jobs].map((jobId) => {
			const start = s.order.map((id) => s.entries.get(id)!).find((e) => e.jobId === jobId && e.kind === "jobStarted");
			const kept = s.jobs.get(jobId) ?? (start && this.operations.jobWork().readJob(s, start));
			return { rights: kept?.rights ?? ["watch"], ancestors: [...new Set([...(kept?.actors ?? []), ...(kept?.job.actorId ? [kept.job.actorId] : [])])].map((id) => this.actorRights(s, id)) };
		});
		const scope = this.turnAuthority.getStore();
		const starting = scope?.sessionId === s.id ? scope.state?.startingRights : undefined;
		return ALL_AUTHORITY.filter((right) => (!starting || starting.includes(right)) && this.withinLimits(s, right) &&
			owners.every((owner) => owner.includes(right)) &&
			recordedJobs.every((job) => job.rights.includes(right) && job.ancestors.every((owner) => owner.includes(right))));
	}

	checkScopedWork(s: Session, right: Authority): void {
		const work = this.turnAuthority.getStore();
		if (work?.sessionId === s.id && (!work.actors.size && !work.jobs.size || !this.workRights(s, work.actors, work.jobs).includes(right))) {
			throw failure("forbidden", `Starting work cannot ${right}`);
		}
	}

	rightsOf(s: Session, actorId: string): Authority[] {
		const context = this.turnAuthority.getStore();
		return context?.sessionId === s.id
			? this.workRights(s, [actorId, ...context.actors], context.jobs)
			: this.actorRights(s, actorId);
	}

	setLimit(s: Session, rights: Authority[] | null, actorId: string, writer: string): Promise<void> {
		return this.operations.admission().admit(s, async () => {
			this.requireAuthority(s, actorId, "administer");
			const effective = (s.actors.get(actorId)?.authority ?? []).filter((r) => s.tenant === undefined || this.operations.tenants().get(s.tenant)?.rights.includes(r));
			if ((rights ?? ALL_AUTHORITY).some((right) => !effective.includes(right))) throw Object.assign(new Error("A limit cannot give a right the administrator lacks"), { code: "forbidden" });
			await this.operations.commit(s, [{ kind: "limit", writer, actorId, modelVisible: false, data: { rights: rights === null ? null : [...new Set(rights)] } }]);
			await this.operations.questions().closeRevokedWaits(s);
			await this.operations.approvals().reconcileApprovals(s);
		});
	}

	async tenantInfo(s: Session): Promise<TenantInfo> {
		const tenant = s.tenant === undefined ? undefined : this.operations.tenants().get(s.tenant);
		if (tenant?.tokens === undefined) return { tenant: s.tenant ?? null, rights: tenant?.rights ?? null, tokens: null };
		const store = this.operations.use<HistoryStore>("history-store");
		const other = await Promise.all((await store?.list() ?? [])
			.filter(({ id }) => !this.operations.sessions().has(id)).map(async ({ id }) => (await store!.load(id)).entries));
		const histories = [...other, ...[...this.operations.sessions().values()].filter((session) => session.tenant === s.tenant)
			.map((session) => session.order.map((id) => session.entries.get(id)!))];
		// Count each turn once even across branches and forks. For an interrupted or running turn,
		// the committed responses are the usage that has not made it into a turnEnd yet.
		const ends = new Map<string, Usage>();
		const responses = new Map<string, HistoryEntry>();
		for (const entries of histories) {
			if ((entries.find((e) => e.kind === "tenant")?.data as { tenant?: string } | undefined)?.tenant !== s.tenant) continue;
			for (const e of entries) {
				if (e.erased || !e.turnId && !e.stepId) continue;
				if (e.kind === "turnEnd" && e.turnId) {
					const usage = (e.data as { usage?: Usage }).usage;
					if (usage) ends.set(e.turnId, usage);
				} else if (e.kind === "response") responses.set(e.id, e);
			}
		}
		let used = [...ends.values()].reduce((n, u) => n + tokenCount(u), 0);
		for (const e of responses.values()) {
			if (!ends.has(e.turnId!) && e.message?.role === "assistant") used += tokenCount(e.message.usage);
		}
		return { tenant: s.tenant!, rights: tenant.rights, tokens: { budget: tenant.tokens, used } };
	}

	async tenantBudgetReached(s: Session): Promise<boolean> {
		if (s.tenant === undefined || this.operations.tenants().get(s.tenant)?.tokens === undefined) return false;
		const { tokens } = await this.tenantInfo(s);
		return !!tokens && tokens.used >= tokens.budget;
	}

	originalWorkAllows(s: Session, w: WaitingApproval) {
		const origin = w.entry.turnId!;
		const branch = s.branch();
		const work = branch.filter(e => e.turnId === origin && (e.kind === "input" || e.kind === "turnStart"));
		if (!work.some(e => e.kind === "turnStart") || work.some(e => e.erased) || !this.operations.turns().recordedTurnRights(branch, origin).includes("tools")) return false;
		return this.turnAuthority.exit(() => connectionRights.exit(() => {
			for (const e of work) {
				const contributors = (e.data as { authorizers?: {sessionId: string; actorId?: string; jobId?: string}[] }).authorizers;
				if (contributors !== undefined && (!Array.isArray(contributors) || contributors.some(ref => {
					const owner = ref && this.operations.sessions().get(ref.sessionId);
					return !owner || owner.tenant !== s.tenant || Boolean(ref.actorId) === Boolean(ref.jobId) ||
						!this.workRights(owner, ref.actorId ? [ref.actorId] : [], ref.jobId ? [ref.jobId] : []).includes("tools");
				}))) return false;
			}
			return this.workRights(s, this.operations.turns().recordedTurnActors(branch, origin), this.operations.turns().recordedTurnJobs(branch, origin)).includes("tools");
		}));
	}

	workActors(s: Session): string[] {
		const context = this.turnAuthority.getStore();
		if (context?.sessionId === s.id) return [...new Set([...context.actors, ...[...context.jobs].flatMap((id) => {
			const actor = s.order.map((id) => s.entries.get(id)!).find((e) => e.kind === "jobStarted" && e.jobId === id)?.actorId;
			return actor ? [actor] : [];
		})])];
		const actorId = this.operations.tools().toolWork.getStore()?.actorId;
		return actorId ? [actorId] : [];
	}
}

export function readTenants(json: string | undefined): Map<string, Tenant> {
	if (json === undefined) return new Map();
	const value: unknown = JSON.parse(json);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MODULAR_AGENT_TENANTS must be a JSON object");
	return new Map(Object.entries(value).map(([name, config]) => {
		if (!name || !config || !Array.isArray(config.rights) || !config.rights.every((right: unknown) => typeof right === "string") ||
			(config.tokens !== undefined && (!Number.isSafeInteger(config.tokens) || config.tokens < 0))) {
			throw new Error(`Invalid tenant configuration for ${name}`);
		}
		return [name, { rights: [...new Set<Authority>(config.rights)], tokens: config.tokens }];
	}));
}

export function intersectRights(...ceilings: readonly Authority[][]): Authority[] {
	return ceilings.length ? ALL_AUTHORITY.filter(right => ceilings.every(ceiling => Array.isArray(ceiling) && ceiling.includes(right))) : [];
}
