import { Readable, Writable } from "node:stream";
import { type AgentApp, type AgentContext, agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
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

interface Waiter {
	inputId: string;
	turnId?: string;
	resolve(response: acp.PromptResponse): void;
	reject(error: Error): void;
}

interface SessionState {
	unfollow?: () => void;
	waiters: Waiter[];
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

function titleOf(name: string, input: Record<string, unknown>): string {
	if (typeof input.command === "string") return `${name}: ${input.command}`;
	if (typeof input.path === "string") return `${name} ${input.path}`;
	if (typeof input.question === "string") return `${name}: ${input.question}`;
	return name;
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
				},
				agentInfo: { name: "modular-agent", title: "Modular Agent", version: "0.1.0" },
				authMethods: [],
				// What the agent supports, so a host never has to guess.
				_meta: { "modular-agent/declaration": declaration },
			};
		});

		app.onRequest(methods.agent.session.new, async ({ params }) => {
			const sessionId = await this.api.startSession({ settings: { cwd: params.cwd }, actor: this.actor() });
			this.open(sessionId);
			return { sessionId, configOptions: await this.configOptions(sessionId) };
		});

		app.onRequest(methods.agent.session.load, async ({ params }) => {
			this.sessions.set(params.sessionId, this.state());
			await this.api.openSession(params.sessionId, this.actor());
			await this.replay(params.sessionId);
			this.open(params.sessionId);
			return { configOptions: await this.configOptions(params.sessionId) };
		});

		app.onRequest(methods.agent.session.resume, async ({ params }) => {
			this.sessions.set(params.sessionId, this.state());
			await this.api.openSession(params.sessionId, this.actor());
			this.open(params.sessionId);
			return { configOptions: await this.configOptions(params.sessionId) };
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
			else throw new Error(`Unknown option ${params.configId}`);
			return { configOptions: await this.configOptions(params.sessionId) };
		});

		app.onRequest(methods.agent.session.prompt, async ({ params }) => this.prompt(params));

		app.onNotification(methods.agent.session.cancel, async ({ params }) => {
			const handedBack = await this.api.cancel(params.sessionId);
			const state = this.sessions.get(params.sessionId);
			const ids = new Set(handedBack.map((q) => q.id));
			for (const w of [...(state?.waiters ?? [])]) {
				if (ids.has(w.inputId)) this.settle(params.sessionId, w, { stopReason: "cancelled" });
			}
		});
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
		const key = (params._meta as Record<string, unknown> | undefined)?.["modular-agent/key"];
		const busy = this.api.session(sessionId).busy;
		const receipt = await this.api.input(sessionId, {
			content: fromAcp(params.prompt),
			actorId: this.actorId,
			when: busy ? "after" : "now",
			key: typeof key === "string" ? key : undefined,
		});
		if (receipt.handled) {
			if (receipt.output) await this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: receipt.output } });
			return { stopReason: "end_turn" };
		}
		state.ownInputs.add(receipt.inputId);
		return new Promise((resolve, reject) => {
			const waiter: Waiter = { inputId: receipt.inputId, resolve, reject };
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
		const outcome = (e.data as { outcome: { kind: string; error?: string; limit?: string } }).outcome;
		for (const w of [...state.waiters]) {
			if (w.turnId !== e.turnId) continue;
			if (outcome.kind === "failed") this.settle(e.sessionId, w, new Error(outcome.error ?? "The turn failed"));
			else if (outcome.kind === "cancelled") this.settle(e.sessionId, w, { stopReason: "cancelled" });
			else if (outcome.kind === "limit") this.settle(e.sessionId, w, { stopReason: outcome.limit === "steps" ? "max_turn_requests" : "max_tokens" });
			else this.settle(e.sessionId, w, { stopReason: "end_turn" });
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
			title: titleOf(part.name, part.arguments ?? {}),
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
		];
	}

	// ---------- questions to the client ----------

	onInputRequest(request: InputRequest): void {
		if (!this.sessions.has(request.sessionId) || !this.client || this.pending.has(request.id)) return;
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
		if (request.kind === "approval" || (request.kind === "choice" && request.options?.length)) {
			const options: acp.PermissionOption[] =
				request.kind === "approval"
					? [
							{ optionId: "allow", name: "Allow", kind: "allow_once" },
							{ optionId: "refuse", name: "Refuse", kind: "reject_once" },
						]
					: [...request.options!.map((o, i) => ({ optionId: `option:${i}`, name: o, kind: "allow_once" as const })), { optionId: "skip", name: "Skip", kind: "reject_once" }];
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
			const id = response.outcome.optionId;
			if (request.kind === "approval") return id === "allow" ? { value: "allow" } : { declined: true };
			const index = id.startsWith("option:") ? Number(id.slice(7)) : -1;
			return index >= 0 ? { value: request.options![index] } : { declined: true };
		}
		if (!this.clientCaps.elicitation?.form) return { declined: true, reason: "the client can't answer free-text questions" };
		const response = await client.request(
			methods.client.elicitation.create,
			{
				sessionId: request.sessionId,
				mode: "form",
				message: request.question,
				requestedSchema: { type: "object", properties: { answer: { type: "string", title: request.question } }, required: ["answer"] },
			} as acp.CreateElicitationRequest,
			{ cancellationSignal: signal },
		);
		if (response.action !== "accept") return { declined: true };
		const value = (response as { content?: { answer?: unknown } }).content?.answer;
		return typeof value === "string" ? { value } : { declined: true };
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
