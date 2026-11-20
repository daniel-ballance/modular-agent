import { Readable, Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { type AgentApp, type AgentContext, agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type * as acp from "@agentclientprotocol/sdk";
import {
	ALL_AUTHORITY,
	type Actor,
	type Authority,
	type AgentEvent,
	type ContentPart,
	type HistoryEntry,
	type InputRequest,
	type InterfaceCapability,
	type Plugin,
	type PluginApi,
	type Provider,
	inputHandedBackIds,
	inputIdOf,
	isToolCall,
	lowerReasoning,
	parseModel,
	thinkingLevels,
	text,
	textOf,
} from "@modular-agent/harness";

const APPROVAL = ["off", "ask", "all", "never"];
/** The ACP host binding this Interface follows (docs/bindings/acp.md). */
export const BINDING = "modular-agent-acp/1";
const NS = "modular-agent";
const BINDING_V2 = "modular-agent-acp/2";
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const bindingError = (code: string, message = code) => new RequestError(-32602, message, { code });
const notOpen = () => ({ accepted: false, reason: "not_open" });
const EXTENSIONS = ["history", "input", "requests", "answer", "actors", "join", "leave", "release", "proposals", "withdraw", "limit", "tenant", "fork", "move", "jobs", "cancel-job", "erase"];

interface Outcome { kind: string; error?: string; limit?: string }
interface Waiter {
	inputId: string;
	turnId?: string;
	duplicate?: boolean;
	resolve(response: acp.PromptResponse): void;
	reject(error: Error): void;
}

/** A turn's outcome as an ACP prompt response, with the binding's _meta. */
function promptResponse(inputId: string, outcome: Outcome, extra: Record<string, unknown> = {}): acp.PromptResponse {
	const stopReason: acp.StopReason =
		outcome.kind === "cancelled" ? "cancelled" : outcome.kind === "limit" ? (outcome.limit === "steps" ? "max_turn_requests" : "max_tokens") : outcome.kind === "failed" ? "refusal" : "end_turn";
	return { stopReason, _meta: { [NS]: { inputId, outcome, ...extra } } };
}

interface SessionState {
	unfollow?: () => void;
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


/** ACP prompt content, as our content parts. */
export function fromAcp(blocks: acp.ContentBlock[]): ContentPart[] {
	return blocks.map((b): ContentPart => {
		switch (b.type) {
			case "text":
				return text(b.text);
			case "image":
				return { type: "image", data: b.data, mimeType: b.mimeType };
			case "resource": {
				const r = b.resource as { uri: string; text?: string; blob?: string };
				return text(r.text !== undefined ? `<resource uri="${r.uri}">\n${r.text}\n</resource>` : `[resource ${r.uri}]`);
			}
			case "resource_link":
				return text(`[resource link ${b.uri}${b.name ? ` (${b.name})` : ""}]`);
			default:
				// Kept intact in the record, even though the model can't use it.
				return { ...(b as object), type: `acp:${(b as { type: string }).type}` };
		}
	});
}

/**
 * An Interface that speaks ACP (Agent Client Protocol) v1. An ACP client, such
 * as an editor or a host like T3 Code, drives the agent through it. Each ACP
 * session is one of our sessions, with the same id.
 */
/** The "mcp-servers" capability, as the tools-mcp plugin provides it. */
export type AcpMcpServer = { command: string; args?: string[]; env?: Record<string, string> } | { url: string; headers?: Record<string, string> };
interface McpServers { attach(sessionId: string, servers: Record<string, AcpMcpServer>, cwd?: string): Promise<string[]> }
export interface AcpOptions {
	actorId?: string;
	declaration?: (sessionId?: string) => Record<string, boolean | string>;
	projectSettings?(project: string): Promise<Record<string, unknown>>;
	project?(cwd: string, sessionId?: string): Promise<{ api: PluginApi; cwd: string }>;
	attachMcp?(sessionId: string, project: string, servers: Record<string, AcpMcpServer>, api: PluginApi): Promise<unknown>;
	showApproval?: boolean;
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
	private sessions = new Map<string, SessionState>();
	private pending = new Map<string, AbortController>();

	constructor(private readonly options: AcpOptions = {}) {
		this.actorId = options.actorId ?? "acp-user";
		this.app = agent({ name: "modular-agent" });
		this.app.onConnect((connection) => {
			this.client = connection.client;
			connection.signal.addEventListener("abort", () => {
				if (this.client !== connection.client) return;
				this.client = undefined;
				for (const [id, state] of this.sessions) {
					state.present.clear();
					this.apiFor(id).presenceChanged(id);
				}
			}, { once: true });
		});
		this.register();
	}

	attach(api: PluginApi, primary = true): void {
		if (primary) this.api = api;
		// Bookkeeping needs the raw events; what the client is sent goes through the output gate.
		api.onEvent((e) => this.track(e), { raw: true });
	}

	present(sessionId: string): boolean { return !!this.client && this.sessions.has(sessionId); }
	presentActors(sessionId: string): string[] { return [...(this.sessions.get(sessionId)?.present ?? [])]; }

	private actor(): Actor {
		return { id: this.actorId, kind: "host", authority: ALL_AUTHORITY };
	}

	// ---------- requests from the client ----------

	private mcp(api = this.api): McpServers | undefined {
		return api.use<McpServers>("mcp-servers");
	}

	/** Give the session the MCP servers the client passed. They are not recorded: their headers and env may hold secrets. */
	private async attachMcp(api: PluginApi, sessionId: string, servers: acp.McpServer[] | undefined, cwd: string | undefined): Promise<void> {
		const mcp = this.mcp(api);
		if ((!mcp && !this.options.attachMcp) || !servers?.length || !this.hasRight(sessionId, this.actorId, "tools")) return;
		const configs = Object.fromEntries(servers.flatMap((s): [string, AcpMcpServer][] => {
			if ("command" in s) return [[s.name, { command: s.command, args: s.args, env: Object.fromEntries(s.env.map((e) => [e.name, e.value])) }]];
			if (s.type === "http") return [[s.name, { url: s.url, headers: Object.fromEntries(s.headers.map((h) => [h.name, h.value])) }]];
			if (this.options.attachMcp) throw RequestError.invalidParams(undefined, "only stdio and Streamable HTTP MCP are supported");
			return [];
		}));
		if (this.options.attachMcp) await this.options.attachMcp(sessionId, api.session(sessionId).project, configs, api);
		else await mcp!.attach(sessionId, configs, cwd);
	}

	private register(): void {
		const app = this.app;
		app.onRequest(methods.agent.initialize, async ({ params }) => {
			if (this.initialized) throw bindingError("already_initialized");
			const ns = params._meta?.[NS];
			if (ns !== undefined && (!ns || typeof ns !== "object" || Array.isArray(ns) || ("binding" in ns && typeof ns.binding !== "string"))) throw bindingError("invalid_params");
			const binding = (ns as { binding?: string } | undefined)?.binding ?? BINDING;
			if (params.protocolVersion !== PROTOCOL_VERSION || (binding !== BINDING && binding !== BINDING_V2)) throw bindingError("unsupported_version");
			this.clientCaps = params.clientCapabilities ?? {};
			this.binding = binding;
			const result = {
				protocolVersion: PROTOCOL_VERSION,
				agentCapabilities: {
					loadSession: true,
					promptCapabilities: { image: true, embeddedContext: true },
					sessionCapabilities: { list: {}, resume: {}, close: {} },
					// MCP servers the client passes are served only if a plugin can connect them.
					mcpCapabilities: { http: !!this.mcp() || !!this.options.attachMcp, sse: false },
				},
				agentInfo: { name: "modular-agent", title: "Modular Agent", version: "0.1.0" },
				authMethods: [],
				// What the agent supports, so a host never has to guess.
				_meta: { [NS]: { binding: this.binding, declaration: this.bindingDeclaration(), extensions: EXTENSIONS, actor: { id: this.actorId, kind: "host", rights: ALL_AUTHORITY } } },
			} as const;
			const gated = await this.gateReply("", "initialize", { ...result, authMethods: [] });
			this.initialized = true;
			return gated;
		});

		app.onRequest(methods.agent.session.new, async ({ params }) => {
			const tenant = (params._meta?.[NS] as { tenant?: unknown } | undefined)?.tenant;
			if (tenant !== undefined && typeof tenant !== "string") throw RequestError.invalidParams();
			const sessionId = await this.checked(async () => {
				const { api, cwd } = await this.options.project?.(params.cwd) ?? { api: this.api, cwd: params.cwd };
				const overrides = await this.options.projectSettings?.(cwd);
				return api.startSession({ tenant, settings: { ...overrides, cwd }, actor: this.actor(), prepare: async id => {
					this.projects.set(id, api);
					try { await this.attachMcp(api, id, params.mcpServers, params.cwd); }
					catch (error) { this.projects.delete(id); throw error; }
				} });
			});
			this.open(sessionId);
			return { sessionId, configOptions: await this.configOptions(sessionId), _meta: { [NS]: { declaration: this.bindingDeclaration(sessionId) } } };
		});

		app.onRequest(methods.agent.session.load, async ({ params }) => {
			return this.openForClient(params, true);
		});

		app.onRequest(methods.agent.session.resume, async ({ params }) => {
			return this.openForClient(params, false);
		});

		app.onRequest(methods.agent.session.list, async ({ params }) => {
			const sessions = await this.api.listSessions(params.cwd ?? null);
			return {
				sessions: sessions
					.map((s) => ({ sessionId: s.id, cwd: s.project, updatedAt: new Date(s.created).toISOString() })),
			};
		});

		app.onRequest(methods.agent.session.close, async ({ params }) => {
			if (!this.sessions.has(params.sessionId)) throw bindingError("not_open");
			await this.checked(() => this.apiFor(params.sessionId).closeSession(params.sessionId, this.actorId));
			this.sessions.get(params.sessionId)?.unfollow?.();
			this.sessions.delete(params.sessionId);
			this.projects.delete(params.sessionId);
			return {};
		});

		app.onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
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
				await this.apiFor(params.sessionId).setSetting(params.sessionId, "thinking", value === "default" ? "off" : String(value), this.actorId);
			}
			else if (params.configId === "approval" && this.options.showApproval !== false) {
				if (!APPROVAL.includes(String(value))) throw RequestError.invalidParams(undefined, `approval must be one of ${APPROVAL.join(", ")}`);
				await this.apiFor(params.sessionId).setSetting(params.sessionId, "approval", String(value), this.actorId);
			}
			else throw new Error(`Unknown option ${params.configId}`);
			return this.gateReply(params.sessionId, "session/set_config_option", { configOptions: await this.configOptions(params.sessionId), _meta: { [NS]: { declaration: this.bindingDeclaration(params.sessionId) } } });
		});

		app.onRequest(methods.agent.session.prompt, async ({ params }) => this.prompt(params));

		app.onNotification(methods.agent.session.cancel, async ({ params }) => {
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

	private async openForClient(params: { sessionId: string; cwd: string; mcpServers?: acp.McpServer[] }, replay: boolean) {
		const id = params.sessionId;
		const attached = this.sessions.has(id);
		await this.reopen(id, params.cwd, attached ? undefined : params.mcpServers);
		try {
			const result = await this.gateReply(id, replay ? "session/load" : "session/resume", await this.openResponse(id));
			if (replay && !attached && this.hasRight(id, this.actorId, "watch")) await this.replay(id);
			if (!attached) this.open(id);
			return result;
		} catch (e) { if (!attached) this.sessions.delete(id); throw e; }
	}

	private async reopen(sessionId: string, cwd: string, servers?: acp.McpServer[]): Promise<void> {
		const previous = this.sessions.get(sessionId);
		if (!previous) this.sessions.set(sessionId, this.state());
		try {
			await this.checked(async () => {
				const api = (await this.options.project?.(cwd, sessionId))?.api ?? this.projects.get(sessionId) ?? this.api;
				this.projects.set(sessionId, api);
				await api.openSession(sessionId, this.actor(), id => this.attachMcp(api, id, servers, cwd));
			});
		} catch (error) {
			if (!previous) { this.sessions.delete(sessionId); this.projects.delete(sessionId); }
			throw error;
		}
	}

	private hasRight(sessionId: string, actorId: string, right: Authority): boolean {
		return this.apiFor(sessionId).session(sessionId).actors.some((a) => a.id === actorId && a.authority.includes(right));
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
			if (typeof sessionId !== "string" || !this.sessions.has(sessionId)) throw RequestError.invalidParams(undefined, `Session ${String(sessionId)} is not open on this connection`);
			return sessionId;
		};
		const extension = (name: string, run: (ctx: { params: Record<string, any> }) => unknown) => {
			const method = `_${NS}/${name}`;
			this.app.onRequest(method, any, async (ctx) => {
				const sessionId = open(ctx.params.sessionId);
				const { actorId, when } = ctx.params;
				const represented = typeof actorId === "string" && actorId !== this.actorId;
				// Proposals, release and withdraw also serve parked job reports.
				const feature = name === "limit" ? "sessionLimits" : name === "tenant" ? "tenants" :
					["actors", "join", "leave"].includes(name) ||
					name === "input" && (when === "propose" || represented) ||
					name === "answer" && represented ? "severalActors" : undefined;
				if (feature && this.bindingDeclaration(sessionId)[feature] !== true) throw bindingError("not_supported");
				return (name === "requests" || name === "history") ? run(ctx) : this.gateReply(sessionId, method, await run(ctx));
			});
		};
		extension("history", async ({ params }) => {
			const sessionId = open(params.sessionId);
			this.requireRight(sessionId, this.actorId, "watch");
			const limit = params.limit ?? 500;
			if (!Number.isInteger(limit) || limit < 1 || limit > 500 || (params.all !== undefined && typeof params.all !== "boolean")) throw bindingError("invalid_params");
			const raw = this.apiFor(sessionId).history(sessionId, { all: params.all === true });
			const at = params.after === undefined ? -1 : raw.findIndex((e) => e.id === params.after);
			if (params.after !== undefined && at < 0) throw bindingError("invalid_params", "Unknown history cursor");
			const entries: HistoryEntry[] = [];
			const before = new Map<string, ReturnType<AcpInterface["requestView"]>>();
			const changed = new Set<string>();
			const max = 4 * 1024 * 1024;
			let bytes = Buffer.byteLength('{"entries":[]}');
			for (let i = at + 1; i < Math.min(raw.length, at + 1 + limit); i++) {
				const entry = raw[i];
				const request = entry.kind === "inputRequest" ? (entry.data as { request?: InputRequest } | undefined)?.request : undefined;
				const view = request && this.requestView(request);
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
		extension("input", async ({ params }) => {
			const sessionId = open(params.sessionId);
			const { when } = params;
			if (when !== "now" && when !== "steer" && when !== "after" && when !== "propose") throw RequestError.invalidParams();
			const actorId = params.actorId ?? this.actorId;
			if (typeof actorId !== "string") throw bindingError("invalid_params");
			if (actorId !== this.actorId) throw bindingError("forbidden");
			const right = when === "propose" ? "propose" : "input";
			this.requireRight(sessionId, this.actorId, right);
			this.requireRight(sessionId, actorId, right);
			if (typeof params.content !== "string" && !Array.isArray(params.content)) throw RequestError.invalidParams();
			const content = typeof params.content === "string" ? params.content : fromAcp(params.content);
			const receipt = await this.checked(() => this.apiFor(sessionId).input(sessionId, { content, actorId, delegatedBy: actorId === this.actorId ? undefined : this.actorId, when, key: typeof params.key === "string" ? params.key : undefined }));
			return receipt.erased ? { duplicate: true, erased: true } : { inputId: receipt.inputId, taken: receipt.taken, ...(receipt.duplicate ? { duplicate: true } : {}) };
		});
		extension("requests", async ({ params }) => {
			const sessionId = open(params.sessionId);
			this.requireRight(sessionId, this.actorId, "watch");
			const view = this.requestViews(sessionId);
			for (const q of view.requests) if (q.kind === "approval") this.deliveredPollApprovals.delete(q.id);
			const gated = await this.gateReply(sessionId, "_modular-agent/requests", view);
			return { requests: gated.requests.map((q) => {
				const answerable = this.canAnswer(sessionId, q.id) && (q.kind !== "approval" || isDeepStrictEqual(q, view.requests.find((r) => r.id === q.id)));
				if (q.kind === "approval" && answerable) this.deliveredPollApprovals.add(q.id);
				return { ...q, answerable };
			}) };
		});
		extension("answer", async ({ params }) => {
			const sessionId = open(params.sessionId);
			const actorId = params.actorId ?? this.actorId;
			if (typeof actorId !== "string" || typeof params.requestId !== "string" || !params.requestId ||
				(params.declined !== undefined && typeof params.declined !== "boolean")) throw bindingError("invalid_params");
			if (actorId !== this.actorId || !["answer", "approve"].some((r) => this.hasRight(sessionId, actorId, r as Authority))) throw bindingError("forbidden");
			const request = this.apiFor(sessionId).openRequests(sessionId).find((r) => r.id === params.requestId);
			if (!request || (request.answerers.length && !request.answerers.includes(actorId))) return notOpen();
			const right = request.kind === "approval" ? "approve" : "answer";
			if (!this.hasRight(sessionId, actorId, right) || request.kind === "approval" && (!this.deliveredPollApprovals.has(request.id) || !this.hasRight(sessionId, actorId, "watch") || !this.canAnswer(sessionId, request.id))) return notOpen();
			const declined = params.declined === true || params.value === undefined || request.kind === "approval" && params.value === "refuse";
			if ((request.kind === "secret" && params.value !== undefined) || !declined && (typeof params.value !== "string" || (request.kind === "choice" && !request.options?.includes(params.value)) ||
				(request.kind === "approval" && params.value !== "allow"))) throw bindingError("invalid_params", "Invalid answer value");
			const answer = this.apiFor(sessionId).answer(sessionId, { requestId: request.id, actorId, value: declined ? undefined : params.value, declined });
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
			// Membership is not representation; no additional principals are configured for this connection.
			if (params.present === false) present.delete(actor.id);
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
		const gated = await this.apiFor(sessionId).gateOutput(sessionId, this.actorId, "reply", { method, result });
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
			throw bindingError(code === "result_too_large" || code === "conflict" || code === "not_found" || code === "forbidden" || code === "busy" || code === "wrong_project" ? code : /Unknown tenant|forbidden/i.test(message) ? "forbidden" : "invalid_params", message);
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
			lateAnswersStartTurns: bool("questionsOutlastTurns"),
			startsTurnsUnasked: d.startsTurnsUnasked && d.startsTurnsUnasked !== "never" ? "jobReports" : "never",
			queuedInputAfterRestart: d.queuedInputAfterRestart,
			queuedJobReportsAfterRestart: d.queuedJobReportsAfterRestart,
			movingWithUnfinishedWork: d.movingWithUnfinishedWork,
			mixedActorInput: d.mixedActorInput,
			settingsDuringTurn: d.settingsDuringTurn ?? "nextTurn",
			erasureDuringTurn: d.erasureDuringTurn,
			commandContainment: d.commandContainment,
			...(d.confinesFiles === undefined ? {} : { confinesFiles: bool("confinesFiles") }),
			...(d.nestedToolCalls === undefined ? {} : { nestedToolCalls: bool("nestedToolCalls") }),
		};
	}

	private state(): SessionState {
		return { waiters: [], ownInputs: new Set(), toolOutput: new Map(), present: new Set() };
	}

	private open(sessionId: string): void {
		const state = this.sessions.get(sessionId) ?? this.state();
		this.sessions.set(sessionId, state);
		state.unfollow?.();
		state.unfollow = this.apiFor(sessionId).follow(sessionId, { recipient: this.actorId }, (e) => this.forward(sessionId, e));
		void this.update(sessionId, {
			sessionUpdate: "available_commands_update",
			availableCommands: this.apiFor(sessionId).commands().map((c) => ({ name: c.name, description: c.description, input: { hint: "arguments" } })),
		});
	}

	private async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
		const sessionId = params.sessionId;
		const state = this.sessions.get(sessionId);
		if (!state) throw new Error(`Session ${sessionId} is not open on this connection`);
		const m = params._meta as Record<string, any> | undefined;
		const key = m?.[NS]?.key ?? m?.["modular-agent/key"];
		this.requireRight(sessionId, this.actorId, "input");
		const busy = this.apiFor(sessionId).session(sessionId).busy;
		const receipt = await this.apiFor(sessionId).input(sessionId, {
			content: fromAcp(params.prompt),
			actorId: this.actorId,
			when: busy ? "after" : "now",
			key: typeof key === "string" ? key : undefined,
		});
		if (receipt.erased) return this.gateReply(sessionId, "session/prompt", { stopReason: "end_turn", _meta: { [NS]: { duplicate: true, erased: true } } });
		if (receipt.handled) {
			if (receipt.output && !receipt.duplicate) {
				const output = await this.apiFor(sessionId).gateOutput(sessionId, this.actorId, "command.result", receipt.output);
				if (output) await this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: output } });
			}
			return this.gateReply(sessionId, "session/prompt", promptResponse(receipt.inputId, { kind: "completed" }, receipt.duplicate ? { duplicate: true } : {}));
		}
		const all = this.apiFor(sessionId).history(sessionId, { all: true });
		const taken = all.find((e) => e.kind === "input" && inputIdOf(e) === receipt.inputId);
		const end = taken?.turnId ? all.find((e) => e.kind === "turnEnd" && e.turnId === taken.turnId) : undefined;
		const latest = all.findLast((e) => e.kind === "inputAccepted" && inputIdOf(e) === receipt.inputId);
		if (receipt.duplicate && !taken && ((latest?.data as { when?: string } | undefined)?.when === "propose" ||
			all.some((e) => e.kind === "inputHandedBack" && inputHandedBackIds(e).includes(receipt.inputId)))) {
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
		if (!this.client) return Promise.resolve();
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
		for (const raw of this.apiFor(sessionId).history(sessionId)) {
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
				if (await p.available?.() === false) return undefined;
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
		const thinking = lowerReasoning(settings.reasoning, model) ?? (levels.includes("off") ? "off" : levels[0] ?? "off");
		return [
			{ id: "model", name: "Model", category: "model", type: "select", currentValue: current, options },
			{ id: "thinking", name: "Reasoning", category: "thought_level", type: "select", currentValue: thinking, options: levels.map((v) => ({ value: v, name: v })) },
			...(this.options.showApproval === false ? [] : [{ id: "approval", name: "Approval", type: "select" as const, currentValue: APPROVAL.includes(String(settings.approval)) ? String(settings.approval) : "all", options: APPROVAL.map((v) => ({ value: v, name: v })) }]),
		];
	}

	// ---------- questions to the client ----------

	private requestViews(sessionId: string) {
		return { requests: this.apiFor(sessionId).openRequests(sessionId).map((r) => this.requestView(r)) };
	}

	private requestView(r: InputRequest) {
		const call = r.kind === "approval" ? this.approvalCall(r) : undefined;
		return {
			id: r.id, kind: r.kind, question: r.question, ...(r.kind === "choice" && r.options ? { options: r.options } : {}),
			...(r.kind === "link" && r.details ? { details: r.details } : {}), ...(r.toolCallId ? { toolCallId: r.toolCallId } : {}),
			...(call ? { call: { name: call.name, input: call.input } } : {}),
		};
	}

	private canAnswer(sessionId: string, id: string): boolean {
		const request = this.apiFor(sessionId).openRequests(sessionId).find((q) => q.id === id);
		return !!request && this.hasRight(sessionId, this.actorId, request.kind === "approval" ? "approve" : "answer") &&
			(request.kind !== "approval" || this.present(sessionId)) && (!request.answerers.length || request.answerers.includes(this.actorId));
	}

	private approvalCall(request: InputRequest) {
		const entry = this.apiFor(request.sessionId).history(request.sessionId, { all: true }).find((e) => e.kind === "inputRequest" && (e.data as { request?: { id: string } })?.request?.id === request.id);
		return (entry?.data as { call?: { name: string; input: object } } | undefined)?.call;
	}

	onInputRequest(request: InputRequest): void {
		if (!this.sessions.has(request.sessionId) || !this.client || this.pending.has(request.id)) return;
		if (!this.apiFor(request.sessionId).session(request.sessionId).actors.some((a) => a.id === this.actorId && a.authority.includes(request.kind === "approval" ? "approve" : "answer"))) return;
		// Without form support, free text and choices stay open for the binding's requests/answer extensions.
		if ((request.kind === "text" || request.kind === "choice") && !this.clientCaps.elicitation?.form) return;
		const abort = new AbortController();
		this.pending.set(request.id, abort);
		const send = request.kind === "approval" ? this.offerApproval(request, abort.signal) : this.apiFor(request.sessionId).gateOutput(request.sessionId, this.actorId, "input.request", request)
			.then((gated) => gated && !abort.signal.aborted ? this.ask(gated, abort.signal) : undefined);
		void send
			.then((answer) => answer && this.apiFor(request.sessionId).answer(request.sessionId, { requestId: request.id, actorId: this.actorId, ...answer }))
			.catch(() => undefined)
			.finally(() => this.pending.delete(request.id));
	}

	onInputRequestClosed(requestId: string): void {
		// Answered elsewhere, or no longer answerable: withdraw the question from the client.
		this.deliveredPollApprovals.delete(requestId);
		this.pending.get(requestId)?.abort();
	}

	private async offerApproval(request: InputRequest, signal: AbortSignal): Promise<{ value?: string; declined?: boolean; reason?: string } | undefined> {
		{
			const client = this.client!;
			const call = this.approvalCall(request);
			if (!call) return { declined: true, reason: "refused" };
			const options: acp.PermissionOption[] = [
				{ optionId: "allow", name: "Allow", kind: "allow_once" },
				{ optionId: "refuse", name: "Refuse", kind: "reject_once" },
			];
			const payload = { method: "session/request_permission", params: {
				sessionId: request.sessionId,
				toolCall: { toolCallId: request.toolCallId ?? request.id, title: call.name, rawInput: call.input,
					...(request.details ? { content: [{ type: "content" as const, content: { type: "text" as const, text: request.details } }] } : {}) },
				options, _meta: { [NS]: { requestId: request.id, actorId: this.actorId } },
			} };
			const gated = await this.apiFor(request.sessionId).gateOutput(request.sessionId, this.actorId, "request", payload);
			if (!gated || !isDeepStrictEqual(gated, payload) || Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: Number.MAX_SAFE_INTEGER, ...gated })) > MAX_LINE_BYTES) {
				const views = this.requestViews(request.sessionId);
				const poll = await this.gateReply(request.sessionId, "_modular-agent/requests", views).catch(() => undefined);
				const exact = poll?.requests.find((q) => q.id === request.id);
				if (!this.canAnswer(request.sessionId, request.id) || !this.hasRight(request.sessionId, this.actorId, "watch") ||
					!exact || !isDeepStrictEqual(views.requests.find((q) => q.id === request.id), exact)) return { declined: true, reason: "refused" };
				return;
			}
			if (signal.aborted || !this.canAnswer(request.sessionId, request.id)) return;
			const response = await client.request(methods.client.session.requestPermission, gated.params, { cancellationSignal: signal }) as acp.RequestPermissionResponse;
			// The permission reply refers to the exact view already delivered on this route.
			if (signal.aborted || !this.canAnswer(request.sessionId, request.id)) return;
			if (response.outcome.outcome !== "selected") return { declined: true, reason: "cancelled" };
			return response.outcome.optionId === "allow" ? { value: "allow" } : { declined: true };
		}
	}

	private async ask(request: InputRequest, signal: AbortSignal): Promise<{ value?: string; declined?: boolean; reason?: string }> {
		const client = this.client!;
		if (request.kind === "secret") return { declined: true, reason: "noLongerAnswerable" };
		// Free text and choices are a one-field form: a string, or an enum of the options.
		const field = request.kind === "choice" && request.options?.length ? { type: "string", title: request.question, enum: request.options } : { type: "string", title: request.question };
		const params = {
			sessionId: request.sessionId,
			mode: "form",
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
		const output = stream.writable.getWriter();
		stream.writable = new WritableStream({
			async write(message) {
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
		return this.app.connect(stream).closed;
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
