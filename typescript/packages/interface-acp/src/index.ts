import { carrier, currentSpan, historyForPeer, readTrace, withTrace } from "@modular-agent/harness/telemetry";
import { Readable, Writable } from "node:stream";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { type AgentApp, type AgentContext, type Stream, agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type * as acp from "@agentclientprotocol/sdk";
import {
	ALL_AUTHORITY,
	type Actor,
	type Authority,
	type AgentEvent,
	type HistoryEntry,
	type InputRequest,
	type InterfaceCapability,
	type Plugin,
	type PluginApi,
	type Provider,
	inputIdOf,
	untilAborted,
	isToolCall,
	lowerReasoning,
	parseModel,
	thinkingLevels,
	textOf,
} from "@modular-agent/harness";

import { fromAcp, promptResponse, type Outcome, type Waiter } from "./messages.js";
import { parseHostServers, type AcpMcpServer, type McpServers } from "./mcp.js";

export { fromAcp } from "./messages.js";
export { unchangedAcpApproval } from "./approval.js";
export type { AcpMcpServer } from "./mcp.js";

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

const APPROVAL = ["off", "ask", "all", "never"];
/** The ACP host binding this Interface follows (docs/bindings/acp.md). */
export const BINDING = "modular-agent-acp/1";
const NS = "modular-agent";
const BINDING_V2 = "modular-agent-acp/2";
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const bindingError = (code: string, message = code) => new RequestError(code === "lost" ? -32000 : -32602, message, { code });
const notOpen = () => ({ accepted: false, reason: "not_open" });
const EXTENSIONS = ["history", "input", "requests", "answer", "actors", "join", "leave", "release", "proposals", "withdraw", "limit", "tenant", "fork", "move", "jobs", "cancel-job", "erase", "interrupted"];

interface SessionState {
	unwatchClose?: () => void;
	unfollow?: () => void;
	writer?: AbortSignal;
	waiters: Waiter[];
	/** Input handed back by the last cancel, for the cancelled prompt's response. */
	handedBack?: { inputId: string; content: unknown }[];
	/** Inputs this client gave, so they aren't echoed back. */
	ownInputs: Set<string>;
	toolOutput: Map<string, string>;
	present: Set<string>;
}

function kindOf(name: string): acp.ToolKind {
	if (name === "read") return "read";
	if (name === "write" || name === "edit") return "edit";
	if (name === "bash") return "execute";
	return "other";
}


/**
 * An Interface that speaks ACP (Agent Client Protocol) v1. An ACP client, such
 * as an editor or a host like T3 Code, drives the agent through it. Each ACP
 * session is one of our sessions, with the same id.
 */
export function localAcpActor(id = "acp-user"): Actor & { kind: "host" } {
	return { id, kind: "host", authority: [...ALL_AUTHORITY] };
}
export interface AcpOptions {
	/** Accept per-request trace context from this operator-trusted peer. */
	traceTrusted?: boolean;
	actorId?: string;
	approvalRouteId?: string;
	actor?: Actor;
	allowTenant?(tenant: string | null): boolean;
	allowAttached?(project: string, tenant?: string): boolean;
	authorizeSession?(id: string): Promise<unknown>;
	listProject?(cwd: string): Promise<string>;
	represents?: ReadonlySet<string>;
	connectionScope?<T>(run: () => T): T;
	allowSession?(id: string, project: string): Promise<boolean>;
	/** Read through the composition that owns this session, without attaching to it. */
	listOwner?(id: string): { api: PluginApi; allowJoin: boolean };
	declaration?: (sessionId?: string) => Record<string, unknown>;
	projectSettings?(project: string): Promise<Record<string, unknown>>;
	project?(cwd: string, sessionId?: string, tools?: boolean): Promise<{ api: PluginApi; cwd: string }>;
	claim?(sessionId: string, api: PluginApi): void;
	associate?(sessionId: string, api: PluginApi): void;
	attachMcp?(sessionId: string, project: string, servers: Record<string, AcpMcpServer>, api: PluginApi): Promise<unknown>;
	showApproval?: boolean;
	hostMcpServers?: boolean;
}

export class AcpInterface implements InterfaceCapability {
	readonly id = "acp";
	readonly actorId: string;
	readonly app: AgentApp;
	private api!: PluginApi;
	private projects = new Map<string, PluginApi>();
	private apiFor(id: string): PluginApi { return this.projects.get(id) ?? this.api; }
	private client?: AgentContext;
	private binding = BINDING;
	private initialized = false;
	private deliveredPollApprovals = new Set<string>();
	private clientCaps: acp.ClientCapabilities = {};
	private opening = new Map<string, PluginApi | undefined>();
	private sessions = new Map<string, SessionState>();
	private pending = new Map<string, { abort(): void; sessionId: string; actorId: string }>();

	constructor(private readonly options: AcpOptions = {}) {
		this.actorId = options.actor?.id ?? options.actorId ?? "acp-user";
		this.app = agent({ name: "modular-agent" });
		this.app.onConnect((connection) => {
			this.client = connection.client;
			connection.signal.addEventListener("abort", () => {
				if (this.client !== connection.client) return;
				this.client = undefined;
				for (const id of this.sessions.keys()) {
					const api = this.apiFor(id);
					this.detachView(id);
					api.presenceChanged(id);
				}
				for (const pending of this.pending.values()) pending.abort();
				this.opening.clear();
				this.projects.clear();
			}, { once: true });
		});
		this.register();
	}

	attach(api: PluginApi, primary = true): () => void {
		if (primary) this.api = api;
		// Bookkeeping needs the raw events; what the client is sent goes through the output gate.
		return api.onEvent((e) => this.scoped(() => this.track(e)), { raw: true });
	}

	private scoped<T>(run: () => T): T { return this.options.connectionScope ? this.options.connectionScope(run) : run(); }

	present(sessionId: string, request?: InputRequest): boolean {
		return request ? this.scoped(() => this.route(request) !== undefined) : this.presentActors(sessionId).length > 0;
	}
	presentActors(sessionId: string): string[] {
		if (!this.attached(sessionId)) return [];
		const actors = this.apiFor(sessionId).session(sessionId).actors;
		return [...(this.sessions.get(sessionId)?.present ?? [])].filter(id => this.represents(id) && actors.some(a => a.id === id));
	}
	/** A provisional claim blocks all concurrent opens. Only other listeners are blocked by a live writer. */
	holds(id: string, includeWriter: boolean): boolean {
		const writer = this.sessions.get(id)?.writer;
		return this.opening.get(id) === this.api || includeWriter && !!writer && !writer.aborted && this.apiFor(id) === this.api;
	}
	private claim(id: string, api: PluginApi): void {
		if (!this.client) throw bindingError("lost", "The ACP connection ended");
		this.options.claim?.(id, api);
		this.opening.set(id, api);
	}
	private represents(id: string): boolean { return id === this.actorId || this.options.represents?.has(id) === true; }

	private attached(id: string): boolean {
		const state = this.sessions.get(id);
		if (!this.client || !state) return false;
		try {
			const api = this.apiFor(id);
			if (state.writer && this.opening.get(id) !== api && state.writer !== api.sessionInterruption(id)) return false;
			const { project, tenant } = api.session(id);
			return this.options.allowAttached?.(project, tenant) ?? true;
		} catch { return false; }
	}

	private async requireAttachment(id: string): Promise<void> {
		if (!this.sessions.has(id)) {
			await this.checked(async () => this.options.authorizeSession?.(id));
			throw bindingError("not_open");
		}
		if (!this.attached(id) || !this.apiFor(id).session(id).actors.some(a => a.id === this.actorId)) throw bindingError("forbidden");
	}

	private actor(): Actor {
		return this.options.actor ?? localAcpActor(this.actorId);
	}

	// ---------- requests from the client ----------

	private mcp(api = this.api): McpServers | undefined {
		return api.use<McpServers>("mcp-servers");
	}

	private questionTrace() {
		return this.options.traceTrusted !== false ? carrier(currentSpan()) : undefined;
	}

	private traced<T>(meta: unknown, work: () => T): T {
		return withTrace(this.options.traceTrusted !== false ? readTrace(meta) : undefined, work);
	}

	private hostServers(servers?: acp.McpServer[]) {
		if (!servers?.length) return;
		if (this.options.hostMcpServers === false || !this.actor().authority.includes("tools")) throw bindingError("forbidden");
		return parseHostServers(servers, !!this.options.attachMcp);
	}

	private async attachMcp(api: PluginApi, id: string, configs: Record<string, AcpMcpServer> | undefined, cwd: string): Promise<void> {
		if (!configs) return;
		if (!this.hasRight(id, this.actorId, "tools")) throw bindingError("forbidden");
		if (this.options.attachMcp) await this.options.attachMcp(id, api.session(id).project, configs, api);
		else {
			const mcp = this.mcp(api);
			if (!mcp) throw bindingError("not_supported");
			await mcp.attach(id, configs, cwd);
		}
	}

	private register(): void {
		const app = this.app;
		app.onRequest("$/ping", () => ({}), () => ({}));
		app.onRequest(methods.agent.initialize, async ({ params }) => {
			if (this.initialized) throw bindingError("already_initialized");
			const ns = params._meta?.[NS];
			if (ns !== undefined && (!ns || typeof ns !== "object" || Array.isArray(ns) || ("binding" in ns && typeof ns.binding !== "string"))) throw bindingError("invalid_params");
			const binding = (ns as { binding?: string } | undefined)?.binding ?? BINDING;
			if (params.protocolVersion < PROTOCOL_VERSION || (binding !== BINDING && binding !== BINDING_V2)) throw bindingError("unsupported_version");
			this.clientCaps = params.clientCapabilities ?? {};
			this.binding = binding;
			const result = {
				protocolVersion: PROTOCOL_VERSION,
				agentCapabilities: {
					loadSession: true,
					promptCapabilities: { image: true, embeddedContext: true },
					sessionCapabilities: { list: {}, resume: {}, close: {} },
					// MCP servers the client passes are served only if a plugin can connect them.
					mcpCapabilities: { http: this.options.hostMcpServers !== false && (!!this.mcp() || !!this.options.attachMcp), sse: false },
				},
				agentInfo: { name: "modular-agent", title: "Modular Agent", version },
				authMethods: [],
				// What the agent supports, so a host never has to guess.
				_meta: { [NS]: { binding: this.binding, declaration: this.bindingDeclaration(), extensions: EXTENSIONS, actor: { id: this.actorId, kind: this.actor().kind, rights: this.actor().authority } } },
			} as const;
			const gated = await this.gateReply("", "initialize", { ...result, authMethods: [] });
			this.initialized = true;
			return gated;
		});

		app.onRequest(methods.agent.session.new, async ({ params }) => {
			const tenant = (params._meta?.[NS] as { tenant?: unknown } | undefined)?.tenant;
			if (tenant !== undefined && typeof tenant !== "string") throw RequestError.invalidParams();
			if (this.options.allowTenant && (!this.options.allowTenant(tenant ?? null) || !this.actor().authority.includes("input"))) throw bindingError("forbidden");
			const servers = this.hostServers(params.mcpServers);
			let id: string | undefined;
			try {
				const sessionId = await this.checked(() => this.traced(params._meta, async () => {
					const { api, cwd } = await this.options.project?.(params.cwd) ?? { api: this.api, cwd: params.cwd };
					const overrides = await this.options.projectSettings?.(cwd);
					return api.startSession({ tenant, settings: { ...overrides, cwd }, actor: this.actor(), onCreate: created => {
						id = created;
						this.claim(created, api);
						this.projects.set(created, api);
						this.options.associate?.(created, api);
					}, prepare: created => this.attachMcp(api, created, servers, cwd) });
				}));
				if (!this.opening.has(sessionId)) throw bindingError("lost");
				this.watchClose(sessionId, this.state());
				const configOptions = await this.configOptions(sessionId);
				this.open(sessionId);
				return { sessionId, configOptions, _meta: { [NS]: { declaration: this.bindingDeclaration(sessionId) } } };
			} finally {
				if (id !== undefined) {
					this.opening.delete(id);
					if (!this.sessions.get(id)?.writer) this.detachView(id);
				}
			}
		});

		app.onRequest(methods.agent.session.load, async ({ params }) => {
			return this.openForClient(params, true);
		});

		app.onRequest(methods.agent.session.resume, async ({ params }) => {
			return this.openForClient(params, false);
		});

		app.onRequest(methods.agent.session.list, async ({ params }) => {
			if (this.options.actor && !this.actor().authority.includes("watch")) throw bindingError("forbidden");
			const project = params.cwd && this.options.listProject ? await this.checked(() => this.options.listProject!(params.cwd!)) : params.cwd;
			const all = await this.api.listSessions(project ?? null);
			const sessions = [];
			for (const {id, project:cwd} of all) {
				if (project && project !== cwd || this.options.allowSession && !await this.options.allowSession(id, cwd)) continue;
				const { api, allowJoin } = this.options.listOwner?.(id) ?? { api:this.apiFor(id), allowJoin:true };
				const inspect = () => api.sessionSummary(id, {
					actor:this.actor(), allowJoin, scope:this.options.allowAttached, inTurn:this.attached(id) || undefined, secrets:true,
					represented:[...this.options.represents ?? []], present:this.presentActors(id),
				});
				try {
					const row = await inspect();
					if (!row || this.options.allowAttached && !this.options.allowAttached(row.project, row.tenant)) continue;
					const result = { sessionId:id, cwd:row.project, updatedAt:new Date(row.updated).toISOString(), _meta:{[NS]:{waiting:row.waiting}} };
					const out = await api.gateOutput(id, this.actorId, "reply", {method:"session/list", result:structuredClone(result)});
					if (isDeepStrictEqual(out?.result, result) && isDeepStrictEqual(row, await inspect())) sessions.push(result);
				} catch (error) {
					if (!["not_found", "unavailable"].includes((error as {code:string}).code)) throw error;
				}
			}
			return { sessions };
		});

		app.onRequest(methods.agent.session.close, async ({ params }) => {
			await this.requireAttachment(params.sessionId);
			await this.checked(() => this.traced(params._meta, () => this.apiFor(params.sessionId).closeSession(params.sessionId, this.actorId, undefined, this.actor().authority)));
			return {};
		});

		app.onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
			await this.requireAttachment(params.sessionId);
			const value = (params as { value: unknown }).value;
			this.requireRight(params.sessionId, this.actorId, "settings");
			if (params.configId === "model") {
				const option = (await this.configOptions(params.sessionId)).find((o) => o.id === "model");
				if (!option || !("options" in option) || !option.options.some((o) => "value" in o && o.value === value)) throw RequestError.invalidParams(undefined, "Model is not offered");
				await this.apiFor(params.sessionId).setSetting(params.sessionId, "model", String(value), this.actorId);
			}
			else if (params.configId === "thinking") {
				const model = this.apiFor(params.sessionId).modelAccess(params.sessionId)?.model;
				if (value !== "default" && !thinkingLevels(model).includes(String(value))) throw RequestError.invalidParams(undefined, "Reasoning level is not offered");
				await this.apiFor(params.sessionId).setSetting(params.sessionId, "thinking", String(value), this.actorId);
			}
			else if (params.configId === "approvalWait") {
				if (!this.bindingDeclaration(params.sessionId).approvalsOutlastTurns) throw bindingError("not_supported");
				if (value !== "live" && value !== "untilDeadline") throw bindingError("invalid_params");
				await this.apiFor(params.sessionId).setSetting(params.sessionId, "approvalWait", value, this.actorId);
			}
			else if (params.configId === "approval" && this.options.showApproval !== false) {
				if (!APPROVAL.includes(String(value))) throw RequestError.invalidParams(undefined, `approval must be one of ${APPROVAL.join(", ")}`);
				await this.apiFor(params.sessionId).setSetting(params.sessionId, "approval", String(value), this.actorId);
			}
			else throw new Error(`Unknown option ${params.configId}`);
			return this.gateReply(params.sessionId, "session/set_config_option", { configOptions: await this.configOptions(params.sessionId), _meta: { [NS]: { declaration: this.bindingDeclaration(params.sessionId) } } });
		});

		app.onRequest(methods.agent.session.prompt, async ({ params }) => {
			await this.requireAttachment(params.sessionId);
			const state = this.sessions.get(params.sessionId)!;
			this.requireRight(params.sessionId, this.actorId, "input");
			const writer = state.writer ?? this.apiFor(params.sessionId).sessionInterruption(params.sessionId);
			return this.checked(() => this.traced(params._meta, () => untilAborted(writer, () => this.prompt(params, state, writer))));
		});

		app.onNotification(methods.agent.session.cancel, async ({ params }) => {
			await this.requireAttachment(params.sessionId);
			const state = this.sessions.get(params.sessionId);
			this.requireRight(params.sessionId, this.actorId, "cancel");
			const handedBack = await this.apiFor(params.sessionId).cancel(params.sessionId);
			const list = handedBack.map((q) => ({ inputId: q.id, content: q.content }));
			if (state) state.handedBack = list;
			const ids = new Set(handedBack.map((q) => q.id));
			for (const w of [...(state?.waiters ?? [])]) {
				if (ids.has(w.inputId)) this.settle(params.sessionId, w, await this.response(params.sessionId, w.inputId, { kind: "cancelled" }, { handedBack: list }));
			}
		});

		this.registerExtensions();
	}

	private async openForClient(params: { sessionId: string; cwd: string; mcpServers?: acp.McpServer[]; _meta?: unknown }, replay: boolean) {
		const id = params.sessionId, operation = replay ? "load" : "resume";
		if (this.options.actor && !this.actor().authority.includes("watch")) throw bindingError("forbidden");
		const servers = this.hostServers(params.mcpServers);
		const { api, cwd } = await this.checked(async () =>
			await this.options.project?.(params.cwd, id, !!servers) ?? { api: this.apiFor(id), cwd: params.cwd });
		const previous = this.sessions.get(id), attached = !!previous?.writer && !previous.writer.aborted;
		const state = previous ?? this.state();
		if (this.opening.has(id)) throw bindingError("busy");
		await this.checked(async () => {
			this.claim(id, api);
			this.projects.set(id, api);
			this.sessions.set(id, state);
			state.present.add(this.actorId);
		});
		try {
			if (!this.opening.get(id)) throw bindingError("lost");
			await this.checked(() => this.traced(params._meta, () =>
				api.openSession(id, this.actor(), () => this.attachMcp(api, id, attached ? undefined : servers, cwd), operation)));
			if (!attached) this.watchClose(id, state);
			const result = await this.gateReply(id, replay ? "session/load" : "session/resume", await this.openResponse(id));
			if (replay && !attached && this.hasRight(id, this.actorId, "watch")) await this.replay(id);
			if (this.sessions.get(id) !== state) throw bindingError("lost");
			if (!attached) this.open(id);
			return result;
		} finally {
			this.opening.delete(id);
			if (!previous && !state.writer && this.sessions.get(id) === state) this.detachView(id);
		}
	}

	private hasRight(sessionId: string, actorId: string, right: Authority): boolean {
		if (!this.represents(actorId) || !this.actor().authority.includes(right)) return false;
		try {
			const { project, tenant, actors } = this.apiFor(sessionId).session(sessionId);
			return (this.options.allowAttached?.(project, tenant) ?? true) &&
				actors.some(a => a.id === this.actorId && a.authority.includes(right)) &&
				actors.some(a => a.id === actorId && a.authority.includes(right));
		} catch { return false; }
	}

	private requireRight(sessionId: string, actorId: string, right: Authority): void {
		if (!this.hasRight(sessionId, actorId, right)) {
			throw bindingError("forbidden", `Actor may not ${right}`);
		}
	}

	private async openResponse(sessionId: string) {
		const recovered = this.hasRight(sessionId, this.actorId, "watch") ? this.apiFor(sessionId).recoveredInput(sessionId).map((q) => ({ inputId: q.id, content: q.content })) : [];
		const handedBack = recovered.length ? await this.apiFor(sessionId).gateOutput(sessionId, this.actorId, "input.handedBack", recovered) : [];
		return { configOptions: await this.configOptions(sessionId), _meta: { [NS]: {
			declaration: this.bindingDeclaration(sessionId), ...(handedBack?.length ? { handedBack } : {}),
		} } };
	}

	/** The binding's extension methods (docs/bindings/acp.md). */
	private registerExtensions(): void {
		const any = (p: unknown) => (p ?? {}) as Record<string, any>;
		const open = (sessionId: unknown) => {
			if (typeof sessionId !== "string" || !sessionId) throw RequestError.invalidParams();
			return sessionId;
		};
		const extension = (name: string, run: (ctx: { params: Record<string, any> }) => unknown) => {
			const method = `_${NS}/${name}`;
			this.app.onRequest(method, any, async (ctx) => {
				const sessionId = open(ctx.params.sessionId);
				await this.requireAttachment(sessionId);
				const { actorId, when } = ctx.params;
				const represented = typeof actorId === "string" && actorId !== this.actorId;
				// Proposals, release and withdraw also serve parked job reports.
				const feature = name === "limit" ? "sessionLimits" : name === "tenant" ? "tenants" :
					["actors", "join", "leave"].includes(name) ||
					name === "input" && (when === "propose" || represented) ||
					name === "answer" && represented ? "severalActors" : undefined;
				if (represented && (name === "input" || name === "answer") && !this.represents(actorId)) throw bindingError("forbidden");
				if (feature && this.bindingDeclaration(sessionId)[feature] !== true) throw bindingError("not_supported");
				const result = await this.checked(async () => run(ctx));
				return (name === "requests" || name === "history") ? result : this.gateReply(sessionId, method, result);
			});
		};
		extension("history", async ({ params }) => {
			const sessionId = open(params.sessionId), limit = params.limit ?? 500;
			this.requireRight(sessionId, this.actorId, "watch");
			if (!Number.isInteger(limit) || limit < 1 || limit > 500 || (params.all !== undefined && typeof params.all !== "boolean")) throw bindingError("invalid_params");
			return this.apiFor(sessionId).inspectHistory(sessionId, { all: params.all === true, retryErasure: true }, async raw => {
				const at = params.after === undefined ? -1 : raw.findIndex((e) => e.id === params.after);
				if (params.after !== undefined && at < 0) throw bindingError("invalid_params", "Unknown history cursor");
				const entries: HistoryEntry[] = [];
				const before = new Map<string, Awaited<ReturnType<AcpInterface["requestView"]>>>();
				const changed = new Set<string>();
				const max = 4 * 1024 * 1024;
				let bytes = Buffer.byteLength('{"entries":[]}');
				for (let i = at + 1; i < Math.min(raw.length, at + 1 + limit); i++) {
					const entry = historyForPeer(raw[i]);
					const request = entry.kind === "inputRequest" ? (entry.data as { request?: InputRequest } | undefined)?.request : undefined;
					const view = request && await this.requestView(request);
					const projected = view ? { ...entry, data: { request: view } } : entry;
					const allowed = await this.apiFor(sessionId).gateOutput(sessionId, this.actorId, "entry", projected);
					if (!allowed) continue;
					const nextBytes = i + 1 < raw.length ? Buffer.byteLength(`,"nextEntryId":${JSON.stringify(entry.id)}`) : 0;
					const estimate = view ? { ...allowed, data: { request: { ...(allowed.data as { request: typeof view }).request, answerable: false } } } : allowed;
					const size = Buffer.byteLength(JSON.stringify(estimate)) + Number(entries.length > 0);
					if (bytes + size + nextBytes > max) {
						if (!entries.length) throw new RequestError(-32000, "History entry does not fit", { code: "result_too_large" });
						break;
					}
					if (view) {
						before.set(entry.id, view);
						if (!isDeepStrictEqual((allowed.data as { request: typeof view }).request, view)) changed.add(entry.id);
					}
					bytes += size;
					entries.push(allowed);
				}
				const last = entries.at(-1);
				const page = await this.gateReply(sessionId, "_modular-agent/history", {
					entries, ...(last && last.id !== raw.at(-1)?.id ? { nextEntryId: last.id } : {}),
				});
				page.entries = page.entries.map((entry) => {
					const original = before.get(entry.id);
					if (!original) return entry;
					const { request } = entry.data as { request: typeof original };
					const exact = !changed.has(entry.id) && isDeepStrictEqual(request, original);
					const answerable = this.canAnswer(sessionId, request.id) && (request.kind !== "approval" || exact);
					return { ...entry, data: { request: { ...request, answerable } } };
				});
				if (Buffer.byteLength(JSON.stringify(page)) > max) throw new RequestError(-32000, "Gated history page does not fit", { code: "result_too_large" });
				return page;
			});
		});
		extension("input", async ({ params }) => {
			const sessionId = open(params.sessionId);
			const { when } = params;
			if (when !== "now" && when !== "steer" && when !== "after" && when !== "propose") throw RequestError.invalidParams();
			const actorId = params.actorId ?? this.actorId;
			if (typeof actorId !== "string") throw bindingError("invalid_params");
			if (!this.represents(actorId)) throw bindingError("forbidden");
			const right = when === "propose" ? "propose" : "input";
			this.requireRight(sessionId, this.actorId, right);
			this.requireRight(sessionId, actorId, right);
			if (typeof params.content !== "string" && !Array.isArray(params.content)) throw RequestError.invalidParams();
			const content = typeof params.content === "string" ? params.content : fromAcp(params.content);
			const receipt = await this.checked(() => this.traced(params._meta, () => this.apiFor(sessionId).input(sessionId, { content, actorId, delegatedBy: actorId === this.actorId ? undefined : this.actorId, when, key: typeof params.key === "string" ? params.key : undefined })));
			return receipt.erased ? { duplicate: true, erased: true } : { inputId: receipt.inputId, taken: receipt.taken, ...(receipt.duplicate ? { duplicate: true } : {}) };
		});
		extension("requests", async ({ params }) => {
			const sessionId = open(params.sessionId);
			this.requireRight(sessionId, this.actorId, "watch");
			const api = this.apiFor(sessionId);
			await api.refreshApprovals(sessionId);
			const view = await this.requestViews(sessionId);
			for (const q of view.requests) if (q.kind === "approval") this.deliveredPollApprovals.delete(q.id);
			const gated = await this.gateReply(sessionId, "_modular-agent/requests", view);
			return { requests: await Promise.all(gated.requests.map(async (q) => {
				let answerable = this.canAnswer(sessionId, q.id) && (q.kind !== "approval" || isDeepStrictEqual(q, view.requests.find((r) => r.id === q.id)));
				if (q.approvalWait && answerable) {
					const r = api.openRequests(sessionId).find(r => r.id === q.id);
					const actor = r && this.route(r);
					const handle = this.sessions.get(sessionId);
					answerable = !!actor && !!handle && !!this.options.approvalRouteId && await api.presentApproval(sessionId, q.id, {
						handle, routeId: this.options.approvalRouteId, actorId: actor, submittedBy: this.actorId,
						present: () => this.sessions.get(sessionId) === handle && this.attached(sessionId) && this.presentActors(sessionId).includes(actor),
					});
				}
				if (q.kind === "approval" && answerable) this.deliveredPollApprovals.add(q.id);
				return { ...q, answerable };
			})) };
		});
		extension("answer", async ({ params }) => {
			const sessionId = open(params.sessionId);
			const actorId = params.actorId ?? this.actorId;
			if (typeof actorId !== "string" || typeof params.requestId !== "string" || !params.requestId ||
				(params.declined !== undefined && typeof params.declined !== "boolean")) throw bindingError("invalid_params");
			if (!this.represents(actorId) || !["answer", "approve"].some((r) => this.hasRight(sessionId, actorId, r as Authority))) throw bindingError("forbidden");
			const request = this.apiFor(sessionId).openRequests(sessionId).find((r) => r.id === params.requestId);
			if (!request || (request.answerers.length && !request.answerers.includes(actorId))) return notOpen();
			const right = request.kind === "approval" ? "approve" : "answer";
			if (!this.hasRight(sessionId, actorId, right) || request.kind === "approval" && (!this.deliveredPollApprovals.has(request.id) || !this.hasRight(sessionId, actorId, "watch") || !this.canAnswer(sessionId, request.id, actorId))) return notOpen();
			const declined = params.declined === true || params.value === undefined || request.kind === "approval" && params.value === "refuse";
			if ((request.kind === "secret" && params.value !== undefined) || !declined && (typeof params.value !== "string" || (request.kind === "choice" && !request.options?.includes(params.value)) ||
				(request.kind === "approval" && params.value !== "allow"))) throw bindingError("invalid_params", "Invalid answer value");
			const answer = await this.checked(() => this.traced(params._meta, () => this.apiFor(sessionId).submitAnswer(sessionId, { requestId: request.id, actorId, delegatedBy: actorId === this.actorId ? undefined : this.actorId, value: declined ? undefined : params.value, declined }, this.sessions.get(sessionId))));
			return answer.accepted ? answer : notOpen();
		});
		extension("actors", ({ params }) => {
			const sessionId = open(params.sessionId);
			this.requireRight(sessionId, this.actorId, "watch");
			return { actors: this.apiFor(sessionId).session(sessionId).actors.map(({ id, kind, authority }) => ({ id, kind, rights: authority })), present: this.apiFor(sessionId).presentActors(sessionId) };
		});
		extension("join", async ({ params }) => {
			const sessionId = open(params.sessionId);
			this.requireRight(sessionId, this.actorId, "grant");
			const actor = params.actor;
			if (typeof actor?.id !== "string" || !actor.id || !["host", "user", "agent", "program"].includes(actor.kind) ||
				!Array.isArray(actor.rights) || !actor.rights.every((r: Authority) => ALL_AUTHORITY.includes(r)) ||
				(params.present !== undefined && typeof params.present !== "boolean")) throw RequestError.invalidParams(undefined, "Invalid actor, rights or presence");
			if (actor.id === this.actorId) throw bindingError("forbidden");
			const present = this.sessions.get(sessionId)!.present;
			const wasPresent = present.has(actor.id);
			// Joining may mark presence only on an already configured route.
			if (params.present === false || !this.represents(actor.id)) present.delete(actor.id);
			else if (params.present === true) present.add(actor.id);
			try { await this.checked(() => this.apiFor(sessionId).join(sessionId, { id: actor.id, kind: actor.kind, authority: [...new Set<Authority>(actor.rights)] }, this.actorId)); }
			catch (error) { if (wasPresent) present.add(actor.id); else present.delete(actor.id); throw error; }
			return {};
		});
		extension("leave", async ({ params }) => {
			const sessionId = open(params.sessionId);
			await this.checked(() => this.apiFor(sessionId).leave(sessionId, String(params.actorId), this.actorId));
			this.sessions.get(sessionId)!.present.delete(String(params.actorId));
			return {};
		});
		extension("release", async ({ params }) => {
			const sessionId = open(params.sessionId);
			const { when } = params;
			if (when !== "now" && when !== "steer" && when !== "after") throw RequestError.invalidParams();
			return this.checked(() => this.apiFor(sessionId).releaseInput(sessionId, String(params.inputId), when, this.actorId, params.declined === true));
		});
		extension("proposals", ({ params }) => {
			const sessionId = open(params.sessionId);
			this.requireRight(sessionId, this.actorId, "watch");
			return { proposals: this.apiFor(sessionId).proposals(sessionId, this.actorId) };
		});
		extension("withdraw", async ({ params }) => {
			const sessionId = open(params.sessionId);
			if (typeof params.inputId !== "string" || !params.inputId) throw bindingError("invalid_params");
			if (params.actorId !== undefined) throw bindingError("invalid_params");
			await this.checked(() => this.apiFor(sessionId).withdrawProposal(sessionId, params.inputId, this.actorId));
			return {};
		});
		extension("limit", async ({ params }) => {
			const sessionId = open(params.sessionId);
			const { rights } = params;
			if (rights !== null && (!Array.isArray(rights) || !rights.every((r) => ALL_AUTHORITY.includes(r)))) throw RequestError.invalidParams();
			this.requireRight(sessionId, this.actorId, "administer");
			await this.checked(() => this.apiFor(sessionId).setLimit(sessionId, rights, this.actorId));
			return {};
		});
		extension("tenant", ({ params }) => this.apiFor(String(params.sessionId)).tenant(open(params.sessionId)));
		extension("fork", async ({ params }) => {
			const sessionId = open(params.sessionId);
			this.requireRight(sessionId, this.actorId, "settings");
			return { sessionId: await this.checked(() => this.apiFor(sessionId).forkSession(sessionId, String(params.entryId))) };
		});
		extension("move", async ({ params }) => {
			const sessionId = open(params.sessionId);
			this.requireRight(sessionId, this.actorId, "settings");
			return this.checked(() => this.apiFor(sessionId).moveTo(sessionId, String(params.entryId), { actorId: this.actorId, rewind: params.rewind === true }));
		});
		extension("jobs", ({ params }) => {
			const sessionId = open(params.sessionId);
			this.requireRight(sessionId, this.actorId, "watch");
			return { jobs: this.apiFor(sessionId).jobs(sessionId).map(({ id, kind, state }) => ({ id, kind, state })) };
		});
		extension("cancel-job", async ({ params }) => {
			const sessionId = open(params.sessionId);
			this.requireRight(sessionId, this.actorId, "cancel");
			await this.apiFor(sessionId).cancelJob(sessionId, String(params.jobId));
			return {};
		});
		extension("erase", async ({ params }) => {
			const sessionId = open(params.sessionId);
			if (!Array.isArray(params.entryIds) || !params.entryIds.every((id: unknown) => typeof id === "string")) throw RequestError.invalidParams();
			this.requireRight(sessionId, this.actorId, "erase");
			const report = await this.checked(() => this.apiFor(sessionId).erase(sessionId, params.entryIds, this.actorId));
			return { erased: report.erasedPairs, pending: report.pendingPairs, outOfReach: report.outOfReach };
		});
	}

	private async gateReply<T>(sessionId: string, method: string, result: T): Promise<T> {
		const gated = await this.checked(() => this.apiFor(sessionId).gateOutput(sessionId, this.actorId, "reply", { method, result }));
		if (sessionId && !this.attached(sessionId)) throw bindingError("forbidden");
		if (["session/load", "session/resume", "_modular-agent/history", "_modular-agent/requests",
			"_modular-agent/actors", "_modular-agent/jobs", "_modular-agent/proposals"].includes(method)) this.requireRight(sessionId, this.actorId, "watch");
		if (method === "session/prompt") this.requireRight(sessionId, this.actorId, "input");
		if (!gated) throw new RequestError(-32000, "Output was blocked", { code: "withheld" });
		return gated.result;
	}

	private async checked<T>(work: () => Promise<T>): Promise<T> {
		try { return await work(); }
		catch (error) {
			if (error instanceof RequestError) throw error;
			const { code, retryAfterMs } = (error ?? {}) as { code?: string; retryAfterMs?: number };
			const message = error instanceof Error ? error.message : String(error);
			if (code === "held" && Number.isSafeInteger(retryAfterMs) && retryAfterMs! > 0) {
				throw new RequestError(-32000, message, { code, retryAfterMs });
			}
			throw bindingError(code === "lost" || code === "result_too_large" || code === "conflict" || code === "not_found" || code === "forbidden" || code === "busy" || code === "wrong_project" || code === "unavailable" || code === "not_supported" ? code : /Unknown tenant|forbidden/i.test(message) ? "forbidden" : "invalid_params", message);
		}
	}

	private async response(sessionId: string, inputId: string, outcome: Outcome, extra?: Record<string, unknown>): Promise<acp.PromptResponse | RequestError> {
		// Raw bookkeeping sees turn.ended just before it is enqueued for the follower.
		await Promise.resolve();
		await this.apiFor(sessionId).flushOutput(sessionId, this.actorId);
		let response: acp.PromptResponse;
		try { response = await this.gateReply(sessionId, "session/prompt", promptResponse(inputId, outcome, extra)); }
		catch (error) { if (error instanceof RequestError) return error; throw error; }
		outcome = (response._meta?.[NS] as { outcome: Outcome }).outcome;
		return outcome.kind === "failed" && this.binding === BINDING_V2
			? new RequestError(-32000, outcome.error ?? "Turn failed", { _meta: response._meta })
			: response;
	}

	/** This agent's declaration, with the binding's keys and values. */
	private bindingDeclaration(sessionId?: string): Record<string, unknown> {
		const scoped = (sessionId ? this.apiFor(sessionId) : this.api).declaration(sessionId);
		const d = (this.options.declaration?.(sessionId) ?? scoped) as Record<string, unknown>;
		const bool = (k: string) => d[k] === true;
		return {
			inputDuringTurn: bool("inputDuringTurn"),
			waitingThroughRestart: bool("waitingThroughRestart"),
			continuesAfterRestart: bool("continuesAfterRestart"),
			rewinding: scoped.rewinding === true,
			forking: bool("forking"),
			keepsStateAtProvider: bool("keepsStateAtProvider"),
			runsToolsAtProvider: bool("runsToolsAtProvider"),
			liveSessions: bool("liveSessions"),
			severalActors: bool("severalActors"),
			sessionLimits: bool("sessionLimits"),
			tenants: bool("tenants"),
			holdsOutput: bool("holdsOutput"),
			outputBypassesAgent: bool("outputBypassesAgent"),
			cancellingTurnCancelsJobs: bool("cancellingTurnCancelsJobs"),
			pluginsDuringSession: bool("pluginsDuringSession"),
			erasure: bool("erasure"),
			inputKeys: bool("inputKeys"),
			portableSessions: bool("portableSessions"),
			questionsOutlastTurns: bool("questionsOutlastTurns"),
			...(scoped.approvalCoversNested === true && bool("approvalCoversNested") ? { approvalCoversNested: true } : {}),
			...(scoped.approvalsOutlastTurns === true && bool("approvalsOutlastTurns") ? { approvalsOutlastTurns: true } : {}),
			lateAnswersStartTurns: bool("questionsOutlastTurns"),
			startsTurnsUnasked: d.startsTurnsUnasked && d.startsTurnsUnasked !== "never" ? "jobReports" : "never",
			queuedInputAfterRestart: d.queuedInputAfterRestart,
			queuedJobReportsAfterRestart: d.queuedJobReportsAfterRestart,
			movingWithUnfinishedWork: d.movingWithUnfinishedWork,
			mixedActorInput: d.mixedActorInput,
			settingsDuringTurn: d.settingsDuringTurn ?? "nextTurn",
			erasureDuringTurn: d.erasureDuringTurn,
			commandContainment: d.commandContainment,
			...(scoped.telemetry === 1 ? { telemetry: 1 } : {}),
			...(d.confinesFiles === undefined ? {} : { confinesFiles: bool("confinesFiles") }),
			...(d.nestedToolCalls === undefined ? {} : { nestedToolCalls: bool("nestedToolCalls") }),
			...(scoped.interfaceTools === true ? { interfaceTools: true } : {}),
			...(d.resourceReservations === undefined ? {} : { resourceReservations: d.resourceReservations }),
		};
	}

	private state(): SessionState {
		return { waiters: [], ownInputs: new Set(), toolOutput: new Map(), present: new Set() };
	}

	private watchClose(id: string, state: SessionState): void {
		if (!this.client || !this.opening.get(id)) throw bindingError("lost");
		const signal = this.apiFor(id).sessionClosed(id);
		const closed = () => {
			if (this.opening.has(id)) this.opening.set(id, undefined);
			this.detachView(id);
		};
		state.unwatchClose?.();
		state.unwatchClose = () => signal.removeEventListener("abort", closed);
		signal.addEventListener("abort", closed, { once: true });
		this.sessions.set(id, state);
	}

	private detachView(id: string): void {
		const state = this.sessions.get(id);
		state?.unfollow?.();
		state?.unwatchClose?.();
		for (const waiter of state?.waiters ?? []) waiter.reject(bindingError("lost"));
		this.sessions.delete(id);
		this.projects.delete(id);
	}

	private open(sessionId: string): void {
		const state = this.sessions.get(sessionId);
		if (!state) throw bindingError("lost");
		state.present.add(this.actorId);
		state.unfollow?.();
		state.writer = this.apiFor(sessionId).sessionInterruption(sessionId);
		state.unfollow = this.apiFor(sessionId).follow(sessionId, { recipient: this.actorId }, (e) => this.scoped(() => this.forward(sessionId, e)));
		void this.update(sessionId, {
			sessionUpdate: "available_commands_update",
			availableCommands: this.apiFor(sessionId).commands().map((c) => ({ name: c.name, description: c.description, input: { hint: "arguments" } })),
		});
	}

	private async prompt(params: acp.PromptRequest, state: SessionState, writer: AbortSignal): Promise<acp.PromptResponse> {
		const sessionId = params.sessionId;
		const m = params._meta as Record<string, any> | undefined;
		const key = m?.[NS]?.key ?? m?.["modular-agent/key"];
		const busy = this.apiFor(sessionId).session(sessionId).busy;
		const receipt = await this.apiFor(sessionId).input(sessionId, {
			content: fromAcp(params.prompt),
			actorId: this.actorId,
			when: busy ? "after" : "now",
			key: typeof key === "string" ? key : undefined,
		});
		writer.throwIfAborted();
		if (receipt.erased) return this.gateReply(sessionId, "session/prompt", { stopReason: "end_turn", _meta: { [NS]: { duplicate: true, erased: true } } });
		if (receipt.handled) {
			if (receipt.output && !receipt.duplicate) {
				const output = await this.apiFor(sessionId).gateOutput(sessionId, this.actorId, "command.result", receipt.output);
				if (output) await this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: output } });
			}
			return this.gateReply(sessionId, "session/prompt", promptResponse(receipt.inputId, { kind: "completed" }, receipt.duplicate ? { duplicate: true } : {}));
		}
		// Take the snapshot and install the waiter in the same synchronous callback.
		// An input or turn end committed in between would never reach this waiter.
		return this.apiFor(sessionId).inspectHistory(sessionId, { all: true }, async all => {
			const taken = all.find((e) => e.kind === "input" && inputIdOf(e) === receipt.inputId);
			const end = taken?.turnId ? all.find((e) => e.kind === "turnEnd" && e.turnId === taken.turnId) : undefined;
			const latest = all.findLast((e) => e.kind === "inputAccepted" && inputIdOf(e) === receipt.inputId);
			if (receipt.duplicate && !taken && ((latest?.data as { when?: string } | undefined)?.when === "propose" ||
				all.some((e) => e.kind === "inputHandedBack" && e.inputId === receipt.inputId))) {
				throw RequestError.invalidParams(undefined, "The input was not taken by a turn");
			}
			if (end) {
				const data = (end.data ?? {}) as { outcome?: Outcome; result?: { openToolCalls?: string[] } };
				const response = await this.response(sessionId, receipt.inputId, data.outcome ?? { kind: "completed" }, {
					...(receipt.duplicate ? { duplicate: true } : {}),
					...(data.result?.openToolCalls?.length ? { openToolCalls: data.result.openToolCalls } : {}),
				});
				if (response instanceof Error) throw response;
				return response;
			}
			state.ownInputs.add(receipt.inputId);
			return new Promise((resolve, reject) => {
				state.waiters.push({ inputId: receipt.inputId, turnId: taken?.turnId, duplicate: receipt.duplicate, resolve, reject });
			});
		});
	}

	private settle(sessionId: string, waiter: Waiter, response: acp.PromptResponse | Error): void {
		const state = this.sessions.get(sessionId);
		if (state) state.waiters = state.waiters.filter((w) => w !== waiter);
		if (response instanceof Error) waiter.reject(response);
		else waiter.resolve(response);
	}

	/** Raw events: which turn took each prompt, and when that turn ended. */
	private track(e: AgentEvent): void {
		const state = this.sessions.get(e.sessionId);
		if (!state) return;
		if (e.type === "entry.added" && e.data?.kind === "actorLeft") {
			state.present.delete(e.data.actorId);
			for (const route of this.pending.values()) {
				if (route.sessionId === e.sessionId && route.actorId === e.data.actorId) route.abort();
			}
		}
		if (e.type === "session.interrupted") {
			for (const waiter of [...state.waiters]) this.settle(e.sessionId, waiter, bindingError("lost", "Session was interrupted; reopen it to recover"));
			return;
		}
		if (e.type === "input.withdrawn" && e.data?.reason === "cancelled") {
			(state.handedBack ??= []).push({ inputId: e.data.inputId, content: e.data.content });
		}
		if (e.type === "entry.added" && (e.data as HistoryEntry).kind === "input") {
			const inputId = inputIdOf(e.data as HistoryEntry);
			if (inputId) for (const w of state.waiters) if (w.inputId === inputId) w.turnId = (e.data as HistoryEntry).turnId;
			return;
		}
		if (e.type !== "turn.ended") return;
		const data = e.data as { outcome: Outcome; result?: { openToolCalls?: string[] } };
		for (const w of [...state.waiters]) {
			if (w.turnId !== e.turnId) continue;
			const extra: Record<string, unknown> = {};
			if (w.duplicate) extra.duplicate = true;
			if (data.result?.openToolCalls?.length) extra.openToolCalls = data.result.openToolCalls;
			if (data.outcome.kind === "cancelled" && state.handedBack) extra.handedBack = state.handedBack;
			void this.response(e.sessionId, w.inputId, data.outcome, extra)
				.then((response) => this.settle(e.sessionId, w, response), (error) => this.settle(e.sessionId, w, error));
		}
	}

	// ---------- updates to the client ----------

	private update(sessionId: string, update: acp.SessionUpdate): Promise<void> {
		if (!this.client || !this.attached(sessionId) || !this.hasRight(sessionId, this.actorId, "watch")) return Promise.resolve();
		return this.client.notify(methods.client.session.update, { sessionId, update }).catch(() => undefined);
	}

	private toolCall(sessionId: string, part: { id: string; name: string; arguments?: Record<string, unknown>; parentCallId?: string }, status: acp.ToolCallStatus): Promise<void> {
		return this.update(sessionId, {
			sessionUpdate: "tool_call",
			toolCallId: part.id,
			// The binding: a tool call's title is the tool's name. Its input is in rawInput.
			title: part.name,
			kind: kindOf(part.name),
			status,
			rawInput: part.arguments ?? {},
			...(part.parentCallId ? { _meta: { "modular-agent": { parentToolCallId: part.parentCallId } } } : {}),
		});
	}

	private toolResult(sessionId: string, entry: HistoryEntry): Promise<void> {
		const status = (entry.data as { status?: string } | undefined)?.status;
		const content = entry.message ? textOf(entry.message.content) : "";
		return this.update(sessionId, {
			sessionUpdate: "tool_call_update",
			toolCallId: entry.toolCallId!,
			status: status === "completed" ? "completed" : "failed",
			content: content ? [{ type: "content", content: { type: "text", text: content } }] : [],
		});
	}

	/** Gated events, as ACP session updates. */
	private async forward(sessionId: string, e: AgentEvent): Promise<void> {
		const state = this.sessions.get(sessionId);
		if (!state || !this.hasRight(sessionId, this.actorId, "watch")) return;
		switch (e.type) {
			case "session.interrupted":
				// ACP has no interruption update; the binding's extension notification carries it (docs/bindings/acp.md, Updates).
				return this.client ? this.client.notify("_modular-agent/interrupted" as never, { sessionId, reason: e.data?.reason } as never).catch(() => undefined) : undefined;
			case "model.output":
				if (e.data?.type === "text") return this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: e.data.delta } });
				if (e.data?.type === "reasoning") return this.update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: e.data.delta } });
				return;
			case "tool.started":
				return this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: e.toolCallId!, status: "in_progress" });
			case "tool.open":
				return this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: e.toolCallId!, status: "pending", content: [{ type: "content", content: { type: "text", text: "Waiting for an answer. The agent carries on when it arrives." } }] });
			case "tool.progress": {
				const id = e.toolCallId!;
				const so_far = ((state.toolOutput.get(id) ?? "") + textOf(e.data.content)).slice(-20_000);
				state.toolOutput.set(id, so_far);
				return this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: id, content: [{ type: "content", content: { type: "text", text: so_far } }] });
			}
			case "entry.added": {
				const entry = e.data as HistoryEntry;
				if (entry.kind === "modular-agent.nestedCall") {
					const call = (entry.data as { call?: import("@modular-agent/harness").ToolCall } | undefined)?.call;
					if (call) await this.toolCall(sessionId, { ...call, arguments: call.input }, "pending");
				} else if (entry.kind === "response" && entry.message?.role === "assistant") {
					for (const part of entry.message.content.filter(isToolCall)) await this.toolCall(sessionId, part, "pending");
				} else if (entry.kind === "toolResult" && entry.toolCallId) {
					state.toolOutput.delete(entry.toolCallId);
					await this.toolResult(sessionId, entry);
				} else if (entry.kind === "input" && entry.message) {
					const inputId = inputIdOf(entry);
					if (inputId && state.ownInputs.has(inputId)) return;
					for (const part of entry.message.content) if (part.type === "text") await this.update(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: (part as { text: string }).text } });
				}
				return;
			}
		}
	}

	/** Send a reopened session's history, as session/load requires. */
	private async replay(sessionId: string): Promise<void> {
		for (const raw of await this.apiFor(sessionId).readHistory(sessionId)) {
			if (!raw.message && raw.kind !== "modular-agent.nestedCall") continue;
			const entry = await this.apiFor(sessionId).gateOutput(sessionId, this.actorId, "entry", raw);
			const m = entry?.message;
			if (!entry) continue;
			if (entry.kind === "modular-agent.nestedCall") {
				const call = (entry.data as { call?: import("@modular-agent/harness").ToolCall } | undefined)?.call;
				if (call) await this.toolCall(sessionId, { ...call, arguments: call.input }, "pending");
			}
			if (!m) continue;
			if (m.role === "user" && entry.modelVisible) {
				const t = textOf(m.content);
				if (t) await this.update(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: t } });
			} else if (m.role === "assistant") {
				const t = textOf(m.content);
				if (t) await this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
				for (const part of m.content.filter(isToolCall)) await this.toolCall(sessionId, part, "pending");
			} else if (m.role === "toolResult") {
				await this.toolResult(sessionId, entry);
			}
		}
	}

	private async configOptions(sessionId: string): Promise<acp.SessionConfigOption[]> {
		const providers = this.apiFor(sessionId).useAll<Provider>("provider");
		const usable = await Promise.all(providers.map(async p => {
			try {
				if ((await p.availability?.())?.available === false) return undefined;
				await p.refreshModels?.();
				return p;
			} catch { return undefined; }
		}));
		const settings = this.apiFor(sessionId).session(sessionId).settings;
		const ref = parseModel(settings.model);
		const current = ref ? `${ref.provider}/${ref.id}` : "";
		const options = usable.flatMap((p) => p?.models().map((m) => ({ value: `${m.provider}/${m.id}`, name: m.name ?? m.id })) ?? []);
		const model = this.apiFor(sessionId).modelAccess(sessionId)?.model;
		const levels = thinkingLevels(model);
		const thinking = lowerReasoning(settings.reasoning, model) ?? "default";
		return [
			{ id: "model", name: "Model", category: "model", type: "select", currentValue: current, options },
			...(levels.length ? [{ id: "thinking", name: "Reasoning", category: "thought_level", type: "select" as const,
				currentValue: thinking, options: [{ value: "default", name: "Default" }, ...levels.map(value => ({ value, name: value }))] }] : []),
			...(this.bindingDeclaration(sessionId).approvalsOutlastTurns ? [{ id: "approvalWait", name: "Approval wait", type: "select" as const,
				currentValue: settings.approvalWait === "untilDeadline" ? "untilDeadline" : "live", options: ["live", "untilDeadline"].map(value => ({ value, name: value })) }] : []),
			...(this.options.showApproval === false ? [] : [{ id: "approval", name: "Approval", type: "select" as const, currentValue: APPROVAL.includes(String(settings.approval)) ? String(settings.approval) : "all", options: APPROVAL.map((v) => ({ value: v, name: v })) }]),
		];
	}

	// ---------- questions to the client ----------

	private async requestViews(sessionId: string) {
		return { requests: await Promise.all(this.apiFor(sessionId).openRequests(sessionId).map((r) => this.requestView(r))) };
	}

	private async requestView(r: InputRequest) {
		const call = r.kind === "approval" ? await this.approvalCall(r) : undefined;
		return {
			id: r.id, kind: r.kind, question: r.question, ...(r.kind === "choice" && r.options ? { options: r.options } : {}),
			...(r.kind === "link" && r.details ? { details: r.details } : {}), ...(r.toolCallId ? { toolCallId: r.toolCallId } : {}),
			...(call ? { call: { name: call.name, input: call.input } } : {}),
			...(r.coversNested ? { coversNested: true } : {}),
			...(r.approvalWait ? { approvalWait: r.approvalWait, deadlineAt: r.deadlineAt } : {}),
		};
	}

	private route(request: InputRequest): string | undefined {
		return this.presentActors(request.sessionId).find(id => this.hasRight(request.sessionId, id, request.kind === "approval" ? "approve" : "answer") &&
			(!request.answerers.length || request.answerers.includes(id)));
	}

	private canAnswer(sessionId: string, id: string, actorId?: string): boolean {
		if (!this.attached(sessionId)) return false;
		const request = this.apiFor(sessionId).openRequests(sessionId).find(q => q.id === id);
		return !!request && (actorId === undefined ? this.route(request) !== undefined : this.presentActors(sessionId).includes(actorId) &&
			this.hasRight(sessionId, actorId, request.kind === "approval" ? "approve" : "answer") &&
			(!request.answerers.length || request.answerers.includes(actorId)));
	}

	private async approvalCall(request: InputRequest) {
		const entry = (await this.apiFor(request.sessionId).readHistory(request.sessionId, { all: true })).find((e) => e.kind === "inputRequest" && (e.data as { request?: { id: string } })?.request?.id === request.id);
		return (entry?.data as { call?: { name: string; input: object } } | undefined)?.call;
	}

	onInputRequest(request: InputRequest): void { this.scoped(() => this.offerInputRequest(request)); }

	private offerInputRequest(request: InputRequest): void {
		if (request.approvalWait || !this.sessions.has(request.sessionId) || !this.client || this.pending.has(request.id)) return;
		const actorId = this.route(request);
		if (!actorId) return;
		// Without form support, free text and choices stay open for the binding's requests/answer extensions.
		if ((request.kind === "text" || request.kind === "choice") && !this.clientCaps.elicitation?.form) return;
		const abort = new AbortController();
		this.pending.set(request.id, { abort: () => abort.abort(), sessionId: request.sessionId, actorId });
		const send = request.kind === "approval" ? this.offerApproval(request, actorId, abort.signal) : this.apiFor(request.sessionId).gateOutput(request.sessionId, this.actorId, "input.request", request)
			.then((gated) => gated && !abort.signal.aborted && this.canAnswer(request.sessionId, request.id, actorId) ? this.ask(gated, actorId, abort.signal) : undefined);
		void send
			.then(async answer => {
				if (answer && !abort.signal.aborted && this.canAnswer(request.sessionId, request.id, actorId)) {
					await this.apiFor(request.sessionId).submitAnswer(request.sessionId, { requestId: request.id, actorId,
						delegatedBy: actorId === this.actorId ? undefined : this.actorId, ...answer });
				}
			})
			.catch(() => undefined)
			.finally(() => this.pending.delete(request.id));
	}

	onInputRequestClosed(requestId: string): void {
		// Answered elsewhere, or no longer answerable: withdraw the question from the client.
		this.deliveredPollApprovals.delete(requestId);
		this.pending.get(requestId)?.abort();
	}

	private async offerApproval(request: InputRequest, actorId: string, signal: AbortSignal): Promise<{ value?: string; declined?: boolean; reason?: string } | undefined> {
		{
			const client = this.client!;
			const call = await this.approvalCall(request);
			if (!call) return { declined: true, reason: "refused" };
			const options: acp.PermissionOption[] = [
				{ optionId: "allow", name: "Allow", kind: "allow_once" },
				{ optionId: "refuse", name: "Refuse", kind: "reject_once" },
			];
			const payload = { method: "session/request_permission", params: {
				sessionId: request.sessionId,
				toolCall: { toolCallId: request.toolCallId ?? request.id, title: call.name, rawInput: call.input,
					...(request.coversNested || request.details ? { content: [{ type: "content" as const, content: { type: "text" as const,
						text: request.coversNested ? request.question : request.details! } }] } : {}) },
				options, _meta: { ...this.questionTrace(), [NS]: { requestId: request.id, actorId, ...(request.coversNested ? { coversNested: true } : {}) } },
			} };
			const gated = await this.apiFor(request.sessionId).gateOutput(request.sessionId, this.actorId, "request", payload);
			if (!gated || !isDeepStrictEqual(gated, payload) || Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: Number.MAX_SAFE_INTEGER, ...gated })) > MAX_LINE_BYTES) {
				const views = await this.requestViews(request.sessionId);
				const poll = await this.gateReply(request.sessionId, "_modular-agent/requests", views).catch(() => undefined);
				const exact = poll?.requests.find((q) => q.id === request.id);
				if (!this.canAnswer(request.sessionId, request.id) || !this.hasRight(request.sessionId, this.actorId, "watch") ||
					!exact || !isDeepStrictEqual(views.requests.find((q) => q.id === request.id), exact)) return { declined: true, reason: "refused" };
				return;
			}
			if (signal.aborted || !this.canAnswer(request.sessionId, request.id, actorId)) return;
			const response = await client.request(methods.client.session.requestPermission, gated.params, { cancellationSignal: signal }) as acp.RequestPermissionResponse;
			// The permission reply refers to the exact view already delivered on this route.
			if (signal.aborted || !this.canAnswer(request.sessionId, request.id, actorId)) return;
			if (response.outcome.outcome !== "selected") return { declined: true, reason: "cancelled" };
			return response.outcome.optionId === "allow" ? { value: "allow" } : { declined: true };
		}
	}

	private async ask(request: InputRequest, actorId: string, signal: AbortSignal): Promise<{ value?: string; declined?: boolean; reason?: string }> {
		const client = this.client!;
		if (request.kind === "secret") return { declined: true, reason: "noLongerAnswerable" };
		// Free text and choices are a one-field form: a string, or an enum of the options.
		const field = request.kind === "choice" && request.options?.length ? { type: "string", title: request.question, enum: request.options } : { type: "string", title: request.question };
		const params = {
			sessionId: request.sessionId,
			mode: "form",
			_meta: { ...this.questionTrace(), [NS]: { requestId: request.id, actorId } },
			message: request.question,
			requestedSchema: { type: "object", properties: { answer: field }, required: ["answer"] },
		} as acp.CreateElicitationRequest;
		if (Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: Number.MAX_SAFE_INTEGER, method: "elicitation/create", params })) > MAX_LINE_BYTES) {
			return { declined: true, reason: "noLongerAnswerable" };
		}
		const response = await client.request(methods.client.elicitation.create, params, { cancellationSignal: signal });
		if (response.action !== "accept") return { declined: true };
		const value = (response as { content?: { answer?: unknown } }).content?.answer;
		if (typeof value !== "string" || (request.kind === "choice" && request.options?.length && !request.options.includes(value))) return { declined: true };
		return { value };
	}

	/** Serve ACP over this process's stdin and stdout. */
	serveStdio(): Promise<void> {
		const stream = ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>, { maxMessageBytes: MAX_LINE_BYTES });
		return this.serveStream(stream);
	}

	/** Serve a transport which already delivers complete, UTF-8 text messages. */
	serveMessages(transport: { receive(callback: (bytes: Buffer) => void): void;
		closed(callback: () => void): void; send(text: string): Promise<void>;
		controlTimeoutMs?: number; lose?(): void }): Promise<void> {
		let done = false;
		return this.scoped(() => this.serveStream({
			readable: new ReadableStream({
				start(controller) {
					transport.closed(() => { if (!done) { done = true; controller.close(); } });
					transport.receive(bytes => {
						if (done) return;
						let message;
						try { message = JSON.parse(bytes.toString("utf8")); }
						catch { void transport.send('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}').catch(() => {}); return; }
						if (!message || typeof message !== "object" || Array.isArray(message)) {
							void transport.send('{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid request"}}').catch(() => {});
							return;
						}
						if (message.jsonrpc === "2.0" && message.method === "$/ping" &&
							(typeof message.id === "number" || typeof message.id === "string")) {
							const valid = message.params === undefined || message.params && typeof message.params === "object" &&
								!Array.isArray(message.params) && Object.keys(message.params).length === 0;
							const reply = valid ? { result: {} } : { error: { code: -32602, message: "Invalid params" } };
							const timer = setTimeout(() => transport.lose?.(), transport.controlTimeoutMs ?? 5000);
							void transport.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply }))
								.catch(() => transport.lose?.()).finally(() => clearTimeout(timer));
							return;
						}
						controller.enqueue(message);
					});
				},
				cancel() { done = true; },
			}),
			writable: new WritableStream({ write: message => transport.send(JSON.stringify(message)) }),
		}));
	}

	serveStream(stream: Stream): Promise<void> {
		const output = stream.writable.getWriter();
		const interfacePart = this;
		const replies = new Map<number | string, { sessionId: string; method: string; right?: Authority }>();
		stream.readable = stream.readable.pipeThrough(new TransformStream({
			transform(message, controller) {
				if ("method" in message && "id" in message && message.id !== null && message.params && typeof message.params === "object") {
					const { sessionId, when } = message.params as { sessionId?: unknown; when?: unknown };
					if (typeof sessionId === "string" && replies.size < 1024) {
						const method = message.method;
						const watch = ["session/load", "session/resume", "_modular-agent/history", "_modular-agent/requests", "_modular-agent/jobs",
							"_modular-agent/tenant", "_modular-agent/proposals", "_modular-agent/actors"].includes(method);
						const right = watch ? "watch" : method === "session/prompt" ? "input" :
							method === "_modular-agent/input" ? (when === "propose" ? "propose" : "input") : undefined;
						replies.set(message.id, { sessionId, method, right });
					} else if (typeof sessionId === "string" && replies.size >= 1024) {
						throw new Error("Too many outstanding ACP requests");
					}
				}
				controller.enqueue(message);
			},
		}));
		stream.writable = new WritableStream({
			async write(message) {
				if ("id" in message && ("result" in message || "error" in message) && message.id !== null) {
					const route = replies.get(message.id);
					replies.delete(message.id);
					const payload = "result" in message || ("error" in message && message.error.data && typeof message.error.data === "object" && "_meta" in message.error.data);
					if (route && payload && route.right) {
						const refusal = await interfacePart.scoped(async () => {
							try {
								await interfacePart.apiFor(route.sessionId).checkPending(route.sessionId);
								return interfacePart.attached(route.sessionId) && interfacePart.hasRight(route.sessionId, interfacePart.actorId, route.right!) ? undefined : "forbidden";
							} catch (error) { return (error as { code?: string }).code === "unavailable" ? "unavailable" : "forbidden"; }
						});
						if (refusal) return output.write({ jsonrpc: "2.0", id: message.id,
							error: { code: -32602, message: "Session reply is no longer available", data: { code: refusal } } });
					}
				}
				if (Buffer.byteLength(JSON.stringify(message)) <= MAX_LINE_BYTES) return output.write(message);
				if ("result" in message || "error" in message) {
					const replacement = { jsonrpc: "2.0" as const, id: message.id, error: { code: -32000, message: "Result is too large", data: { code: "result_too_large" } } };
					if (Buffer.byteLength(JSON.stringify(replacement)) <= MAX_LINE_BYTES) return output.write(replacement);
					throw new Error("ACP response ID cannot fit the line limit");
				}
				// Updates are withheld. An oversized request must never be queued for reply.
				if ("id" in message) throw new Error("ACP request is too large");
			},
		});
		return this.scoped(() => this.app.connect(stream).closed);
	}
}

export function acpInterface(options: ConstructorParameters<typeof AcpInterface>[0] = {}): Plugin & { acp: AcpInterface } {
	const acpi = new AcpInterface(options);
	return {
		name: "interface-acp",
		acp: acpi,
		setup(api) {
			acpi.attach(api);
			api.provide("interface", acpi);
		},
	};
}
