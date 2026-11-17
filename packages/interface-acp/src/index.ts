import { Readable, Writable } from "node:stream";
import { type AgentApp, type AgentContext, agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type * as acp from "@agentclientprotocol/sdk";
import {
	ALL_AUTHORITY,
	type Actor,
	type AgentEvent,
	type ContentPart,
	type HistoryEntry,
	type InputRequest,
	type InterfaceCapability,
	type Plugin,
	type PluginApi,
	type Provider,
	isToolCall,
	text,
	textOf,
} from "@modular-agent/harness";

const THINKING = ["default", "minimal", "low", "medium", "high", "xhigh"];
const APPROVAL = ["off", "ask", "all", "never"];
/** The ACP host binding this Interface follows (docs/bindings/acp.md). */
export const BINDING = "modular-agent-acp/1";
const NS = "modular-agent";
const EXTENSIONS = ["history", "input", "requests", "answer", "fork", "move", "jobs", "cancel-job"];

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
type McpServerConfig = { command: string; args?: string[]; env?: Record<string, string> } | { url: string; headers?: Record<string, string> };
interface McpServers { attach(sessionId: string, servers: Record<string, McpServerConfig>, cwd?: string): Promise<string[]> }

export class AcpInterface implements InterfaceCapability {
	readonly id = "acp";
	readonly actorId: string;
	readonly app: AgentApp;
	private api!: PluginApi;
	private client?: AgentContext;
	private clientCaps: acp.ClientCapabilities = {};
	private sessions = new Map<string, SessionState>();
	private pending = new Map<string, AbortController>();

	constructor(options: { actorId?: string } = {}) {
		this.actorId = options.actorId ?? "acp-user";
		this.app = agent({ name: "modular-agent" });
		this.app.onConnect((connection) => {
			this.client = connection.client;
		});
		this.register();
	}

	attach(api: PluginApi): void {
		this.api = api;
		// Bookkeeping needs the raw events; what the client is sent goes through the output gate.
		api.onEvent((e) => this.track(e), { raw: true });
	}

	private actor(): Actor {
		return { id: this.actorId, kind: "user", authority: ALL_AUTHORITY };
	}

	// ---------- requests from the client ----------

	private mcp(): McpServers | undefined {
		return this.api.use<McpServers>("mcp-servers");
	}

	/** Give the session the MCP servers the client passed. They are not recorded: their headers and env may hold secrets. */
	private async attachMcp(sessionId: string, servers: acp.McpServer[] | undefined, cwd: string | undefined): Promise<void> {
		const mcp = this.mcp();
		if (!mcp || !servers?.length) return;
		const configs: Record<string, McpServerConfig> = {};
		for (const s of servers) {
			if ("command" in s) configs[s.name] = { command: s.command, args: s.args, env: Object.fromEntries(s.env.map((e) => [e.name, e.value])) };
			else if (s.type === "http") configs[s.name] = { url: s.url, headers: Object.fromEntries(s.headers.map((h) => [h.name, h.value])) };
		}
		await mcp.attach(sessionId, configs, cwd);
	}

	private register(): void {
		const app = this.app;
		app.onRequest(methods.agent.initialize, ({ params }) => {
			this.clientCaps = params.clientCapabilities ?? {};
			const declaration = this.api.declaration();
			return {
				protocolVersion: PROTOCOL_VERSION,
				agentCapabilities: {
					loadSession: declaration.forking === true,
					promptCapabilities: { image: true, embeddedContext: true },
					sessionCapabilities: { list: {}, resume: {}, close: {} },
					// MCP servers the client passes are served only if a plugin can connect them.
					mcpCapabilities: { http: !!this.mcp(), sse: false },
				},
				agentInfo: { name: "modular-agent", title: "Modular Agent", version: "0.1.0" },
				authMethods: [],
				// What the agent supports, so a host never has to guess.
				_meta: { [NS]: { binding: BINDING, declaration: this.bindingDeclaration(), extensions: EXTENSIONS, actor: { id: this.actorId, kind: "host" } } },
			};
		});

		app.onRequest(methods.agent.session.new, async ({ params }) => {
			const sessionId = await this.api.startSession({ settings: { cwd: params.cwd }, actor: this.actor() });
			await this.attachMcp(sessionId, params.mcpServers, params.cwd);
			this.open(sessionId);
			return { sessionId, configOptions: await this.configOptions(sessionId), _meta: { [NS]: { declaration: this.bindingDeclaration(sessionId) } } };
		});

		app.onRequest(methods.agent.session.load, async ({ params }) => {
			this.sessions.set(params.sessionId, this.state());
			await this.api.openSession(params.sessionId, this.actor());
			await this.attachMcp(params.sessionId, params.mcpServers, params.cwd);
			await this.replay(params.sessionId);
			this.open(params.sessionId);
			return { configOptions: await this.configOptions(params.sessionId), _meta: { [NS]: { declaration: this.bindingDeclaration(params.sessionId) } } };
		});

		app.onRequest(methods.agent.session.resume, async ({ params }) => {
			this.sessions.set(params.sessionId, this.state());
			await this.api.openSession(params.sessionId, this.actor());
			await this.attachMcp(params.sessionId, params.mcpServers, params.cwd);
			this.open(params.sessionId);
			return { configOptions: await this.configOptions(params.sessionId), _meta: { [NS]: { declaration: this.bindingDeclaration(params.sessionId) } } };
		});

		app.onRequest(methods.agent.session.list, async ({ params }) => {
			const sessions = await this.api.listSessions(params.cwd ?? null);
			return {
				sessions: sessions
					.map((s) => ({ sessionId: s.id, cwd: s.project, updatedAt: new Date(s.created).toISOString() })),
			};
		});

		app.onRequest(methods.agent.session.close, async ({ params }) => {
			this.sessions.get(params.sessionId)?.unfollow?.();
			this.sessions.delete(params.sessionId);
			await this.api.closeSession(params.sessionId);
			return {};
		});

		app.onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
			const value = (params as { value: unknown }).value;
			if (params.configId === "model") await this.api.setSetting(params.sessionId, "model", String(value), this.actorId);
			else if (params.configId === "thinking") await this.api.setSetting(params.sessionId, "thinking", value === "default" ? undefined : String(value), this.actorId);
			else if (params.configId === "approval") {
				if (!APPROVAL.includes(String(value))) throw RequestError.invalidParams(undefined, `approval must be one of ${APPROVAL.join(", ")}`);
				await this.api.setSetting(params.sessionId, "approvalPolicy", String(value), this.actorId);
			}
			else throw new Error(`Unknown option ${params.configId}`);
			return { configOptions: await this.configOptions(params.sessionId) };
		});

		app.onRequest(methods.agent.session.prompt, async ({ params }) => this.prompt(params));

		app.onNotification(methods.agent.session.cancel, async ({ params }) => {
			const state = this.sessions.get(params.sessionId);
			const handedBack = await this.api.cancel(params.sessionId);
			const list = handedBack.map((q) => ({ inputId: q.id, content: q.content }));
			if (state) state.handedBack = list;
			const ids = new Set(handedBack.map((q) => q.id));
			for (const w of [...(state?.waiters ?? [])]) {
				if (ids.has(w.inputId)) this.settle(params.sessionId, w, promptResponse(w.inputId, { kind: "cancelled" }, { handedBack: list }));
			}
		});

		this.registerExtensions();
	}

	/** The binding's extension methods (docs/bindings/acp.md). */
	private registerExtensions(): void {
		const any = (p: unknown) => (p ?? {}) as Record<string, any>;
		const open = (sessionId: unknown) => {
			if (typeof sessionId !== "string" || !this.sessions.has(sessionId)) throw RequestError.invalidParams(undefined, `Session ${String(sessionId)} is not open on this connection`);
			return sessionId;
		};
		this.app.onRequest(`_${NS}/history`, any, async ({ params }) => {
			const sessionId = open(params.sessionId);
			const entries = await this.api.gatedHistory(sessionId, { recipient: `acp:${this.actorId}`, all: params.all === true });
			if (params.after === undefined) return { entries };
			const at = entries.findIndex((e) => e.id === params.after);
			if (at < 0) throw new RequestError(-32602, `Unknown entry ${String(params.after)}`);
			return { entries: entries.slice(at + 1) };
		});
		this.app.onRequest(`_${NS}/input`, any, async ({ params }) => {
			const sessionId = open(params.sessionId);
			const when = params.when === "steer" || params.when === "after" ? params.when : "now";
			const content = typeof params.content === "string" ? params.content : fromAcp(params.content as acp.ContentBlock[]);
			const receipt = await this.api.input(sessionId, { content, actorId: this.actorId, when, key: typeof params.key === "string" ? params.key : undefined });
			return { inputId: receipt.inputId, taken: receipt.taken, ...(receipt.duplicate ? { duplicate: true } : {}) };
		});
		this.app.onRequest(`_${NS}/requests`, any, async ({ params }) => {
			const sessionId = open(params.sessionId);
			return { requests: this.api.openRequests(sessionId).map((r) => ({ id: r.id, kind: r.kind, question: r.question, ...(r.options ? { options: r.options } : {}), ...(r.toolCallId ? { toolCallId: r.toolCallId } : {}), answerable: true })) };
		});
		this.app.onRequest(`_${NS}/answer`, any, async ({ params }) => {
			const sessionId = open(params.sessionId);
			const known = this.api.openRequests(sessionId).some((r) => r.id === params.requestId);
			if (!known) return { accepted: false, reason: "No open request with that id" };
			return this.api.answer(sessionId, { requestId: String(params.requestId), actorId: this.actorId, value: params.value, declined: params.declined === true });
		});
		this.app.onRequest(`_${NS}/fork`, any, async ({ params }) => ({ sessionId: await this.api.forkSession(open(params.sessionId), String(params.entryId)) }));
		this.app.onRequest(`_${NS}/move`, any, async ({ params }) => (await this.api.moveTo(open(params.sessionId), String(params.entryId), { actorId: this.actorId }), {}));
		this.app.onRequest(`_${NS}/jobs`, any, async ({ params }) => ({ jobs: this.api.jobs(open(params.sessionId)).map((j) => ({ id: j.id, kind: j.kind, state: j.state })) }));
		this.app.onRequest(`_${NS}/cancel-job`, any, async ({ params }) => (await this.api.cancelJob(open(params.sessionId), String(params.jobId)), {}));
	}

	/** This agent's declaration, with the binding's keys and values. */
	private bindingDeclaration(sessionId?: string): Record<string, unknown> {
		const d = this.api.declaration(sessionId) as Record<string, unknown>;
		const bool = (k: string) => d[k] === true;
		return {
			inputDuringTurn: bool("inputDuringTurn"),
			waitingThroughRestart: bool("waitingThroughRestart"),
			continuesAfterRestart: bool("continuesAfterRestart"),
			rewinding: bool("rewinding"),
			forking: bool("forking"),
			keepsStateAtProvider: bool("keepsStateAtProvider"),
			runsToolsAtProvider: bool("runsToolsAtProvider"),
			liveSessions: bool("liveSessions"),
			severalActors: bool("severalActors"),
			holdsOutput: bool("holdsOutput"),
			outputBypassesAgent: bool("outputBypassesAgent"),
			cancellingTurnCancelsJobs: bool("cancellingTurnCancelsJobs"),
			pluginsDuringSession: bool("pluginsDuringSession"),
			erasure: bool("erasure"),
			inputKeys: bool("inputKeys"),
			questionsOutlastTurns: bool("questionsOutlastTurns"),
			startsTurnsUnasked: d.startsTurnsUnasked ? "jobReports" : "never",
			// Queued input isn't recorded: after a restart it was never acknowledged, so the host still holds it.
			queuedInputAfterRestart: "handedBack",
			movingWithUnfinishedWork: "cancels",
			mixedActorInput: "shared",
			settingsDuringTurn: "nextTurn",
			erasureDuringTurn: "allowed",
			commandContainment: "strong",
		};
	}

	private state(): SessionState {
		return { waiters: [], ownInputs: new Set(), toolOutput: new Map() };
	}

	private open(sessionId: string): void {
		const state = this.sessions.get(sessionId) ?? this.state();
		this.sessions.set(sessionId, state);
		state.unfollow?.();
		state.unfollow = this.api.follow(sessionId, { recipient: `acp:${this.actorId}` }, (e) => void this.forward(sessionId, e));
		void this.update(sessionId, {
			sessionUpdate: "available_commands_update",
			availableCommands: this.api.commands().map((c) => ({ name: c.name, description: c.description, input: { hint: "arguments" } })),
		});
	}

	private async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
		const sessionId = params.sessionId;
		const state = this.sessions.get(sessionId);
		if (!state) throw new Error(`Session ${sessionId} is not open on this connection`);
		const m = params._meta as Record<string, any> | undefined;
		const key = m?.[NS]?.key ?? m?.["modular-agent/key"];
		const busy = this.api.session(sessionId).busy;
		const receipt = await this.api.input(sessionId, {
			content: fromAcp(params.prompt),
			actorId: this.actorId,
			when: busy ? "after" : "now",
			key: typeof key === "string" ? key : undefined,
		});
		if (receipt.handled) {
			if (receipt.output) await this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: receipt.output } });
			return promptResponse(receipt.inputId, { kind: "completed" });
		}
		if (receipt.duplicate) {
			// The key was known: start nothing, and describe the turn the first prompt started.
			const all = this.api.history(sessionId, { all: true });
			const taken = all.find((e) => (e.data as { inputId?: string } | undefined)?.inputId === receipt.inputId);
			const end = taken && all.find((e) => e.kind === "turnEnd" && e.turnId === taken.turnId);
			if (end || !taken) {
				const data = (end?.data ?? {}) as { outcome?: Outcome; result?: { openToolCalls?: string[] } };
				return promptResponse(receipt.inputId, data.outcome ?? { kind: "completed" }, { duplicate: true, ...(data.result?.openToolCalls?.length ? { openToolCalls: data.result.openToolCalls } : {}) });
			}
		}
		state.ownInputs.add(receipt.inputId);
		return new Promise((resolve, reject) => {
			const waiter: Waiter = { inputId: receipt.inputId, duplicate: receipt.duplicate, resolve, reject };
			// The input may already be recorded, if the turn started at once.
			const entry = this.api.history(sessionId, { all: true }).find((e) => (e.data as { inputId?: string } | undefined)?.inputId === receipt.inputId);
			if (entry) waiter.turnId = entry.turnId;
			state.waiters.push(waiter);
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
		if (e.type === "entry.added") {
			const inputId = (e.data as HistoryEntry).data && ((e.data as HistoryEntry).data as { inputId?: string }).inputId;
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
			this.settle(e.sessionId, w, promptResponse(w.inputId, data.outcome, extra));
		}
	}

	// ---------- updates to the client ----------

	private update(sessionId: string, update: acp.SessionUpdate): Promise<void> {
		if (!this.client) return Promise.resolve();
		return this.client.notify(methods.client.session.update, { sessionId, update }).catch(() => undefined);
	}

	private toolCall(sessionId: string, part: { id: string; name: string; arguments?: Record<string, unknown> }, status: acp.ToolCallStatus): Promise<void> {
		return this.update(sessionId, {
			sessionUpdate: "tool_call",
			toolCallId: part.id,
			// The binding: a tool call's title is the tool's name. Its input is in rawInput.
			title: part.name,
			kind: kindOf(part.name),
			status,
			rawInput: part.arguments ?? {},
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
		if (!state) return;
		switch (e.type) {
			case "model.output":
				if (e.data?.type === "text") return this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: e.data.delta } });
				if (e.data?.type === "reasoning") return this.update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: e.data.delta } });
				return;
			case "tool.started":
				return this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: e.toolCallId!, status: "in_progress" });
			case "tool.progress": {
				const id = e.toolCallId!;
				const so_far = ((state.toolOutput.get(id) ?? "") + textOf(e.data.content)).slice(-20_000);
				state.toolOutput.set(id, so_far);
				return this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: id, content: [{ type: "content", content: { type: "text", text: so_far } }] });
			}
			case "entry.added": {
				const entry = e.data as HistoryEntry;
				if (entry.kind === "response" && entry.message?.role === "assistant") {
					for (const part of entry.message.content.filter(isToolCall)) await this.toolCall(sessionId, part, "pending");
				} else if (entry.kind === "toolResult" && entry.toolCallId) {
					state.toolOutput.delete(entry.toolCallId);
					await this.toolResult(sessionId, entry);
				} else if (entry.kind === "toolOpen" && entry.toolCallId) {
					await this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: entry.toolCallId, status: "pending", content: [{ type: "content", content: { type: "text", text: "Waiting for an answer. The agent carries on when it arrives." } }] });
				} else if ((entry.kind === "input" || entry.kind === "jobReport") && entry.message) {
					const inputId = (entry.data as { inputId?: string } | undefined)?.inputId;
					if (inputId && state.ownInputs.has(inputId)) return;
					for (const part of entry.message.content) if (part.type === "text") await this.update(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: (part as { text: string }).text } });
				}
				return;
			}
		}
	}

	/** Send a reopened session's history, as session/load requires. */
	private async replay(sessionId: string): Promise<void> {
		for (const entry of this.api.history(sessionId)) {
			const m = entry.message;
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
		const providers = this.api.useAll<Provider>("provider");
		const usable = await Promise.all(providers.map(async (p) => ((await p.available?.()) ?? true ? p : undefined)));
		const settings = this.api.session(sessionId).settings;
		const current = typeof settings.model === "string" ? settings.model : "";
		const options = usable.flatMap((p) => p?.models().map((m) => ({ value: `${m.provider}/${m.id}`, name: m.name ?? m.id })) ?? []);
		if (current && !options.some((o) => o.value === current)) options.unshift({ value: current, name: current });
		const thinking = typeof settings.thinking === "string" ? settings.thinking : "default";
		return [
			{ id: "model", name: "Model", category: "model", type: "select", currentValue: current, options },
			{ id: "thinking", name: "Reasoning", category: "thought_level", type: "select", currentValue: thinking, options: THINKING.map((v) => ({ value: v, name: v })) },
			{ id: "approval", name: "Approval", type: "select", currentValue: typeof settings.approvalPolicy === "string" ? settings.approvalPolicy : "off", options: APPROVAL.map((v) => ({ value: v, name: v })) },
		];
	}

	// ---------- questions to the client ----------

	onInputRequest(request: InputRequest): void {
		if (!this.sessions.has(request.sessionId) || !this.client || this.pending.has(request.id)) return;
		// Without form support, free text and choices stay open for the binding's requests/answer extensions.
		if ((request.kind === "text" || request.kind === "choice") && !this.clientCaps.elicitation?.form) return;
		const abort = new AbortController();
		this.pending.set(request.id, abort);
		void this.ask(request, abort.signal)
			.then((answer) => this.api.answer(request.sessionId, { requestId: request.id, actorId: this.actorId, ...answer }))
			.catch(() => this.api.answer(request.sessionId, { requestId: request.id, actorId: this.actorId, declined: true, reason: "the client did not answer" }))
			.finally(() => this.pending.delete(request.id));
	}

	onInputRequestClosed(requestId: string): void {
		// Answered elsewhere, or no longer answerable: withdraw the question from the client.
		this.pending.get(requestId)?.abort();
	}

	private async ask(request: InputRequest, signal: AbortSignal): Promise<{ value?: string; declined?: boolean; reason?: string }> {
		const client = this.client!;
		// ACP forbids secrets in forms, so a secret is never asked over ACP.
		if (request.kind === "secret") return { declined: true, reason: "ACP can't carry a secret" };
		if (request.kind === "approval") {
			const options: acp.PermissionOption[] = [
				{ optionId: "allow", name: "Allow", kind: "allow_once" },
				{ optionId: "refuse", name: "Refuse", kind: "reject_once" },
			];
			const response = await client.request(
				methods.client.session.requestPermission,
				{
					sessionId: request.sessionId,
					toolCall: { toolCallId: request.toolCallId ?? request.id, title: request.question, ...(request.details ? { content: [{ type: "content", content: { type: "text", text: request.details } }] } : {}) },
					options,
				},
				{ cancellationSignal: signal },
			);
			if (response.outcome.outcome !== "selected") return { declined: true, reason: "cancelled" };
			return response.outcome.optionId === "allow" ? { value: "allow" } : { declined: true };
		}
		// Free text and choices are a one-field form: a string, or an enum of the options.
		const field = request.kind === "choice" && request.options?.length ? { type: "string", title: request.question, enum: request.options } : { type: "string", title: request.question };
		const response = await client.request(
			methods.client.elicitation.create,
			{
				sessionId: request.sessionId,
				mode: "form",
				message: request.question,
				requestedSchema: { type: "object", properties: { answer: field }, required: ["answer"] },
			} as acp.CreateElicitationRequest,
			{ cancellationSignal: signal },
		);
		if (response.action !== "accept") return { declined: true };
		const value = (response as { content?: { answer?: unknown } }).content?.answer;
		if (typeof value !== "string" || (request.kind === "choice" && request.options?.length && !request.options.includes(value))) return { declined: true };
		return { value };
	}

	/** Serve ACP over this process's stdin and stdout. */
	serveStdio(): Promise<void> {
		const stream = ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
		return this.app.connect(stream).closed;
	}
}

export function acpInterface(options: { actorId?: string } = {}): Plugin & { acp: AcpInterface } {
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
