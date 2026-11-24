import { PROVIDER_ID, type AssistantMessage, type ModelRequest } from "./data.js";
import { Cancelled, type ClaudeProvider } from "./provider.js";
import { PLUGIN_BINDING, WireError, WirePeer } from "./wire.js";

export interface ServeOptions {
	provider: ClaudeProvider;
	input?: NodeJS.ReadableStream;
	output?: (line: string) => void;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Why a request is not a ModelRequest this Provider can read, or nothing if it is one. */
export function requestProblem(request: unknown): string | undefined {
	if (!isObject(request)) return "request must be an object";
	if (typeof request.systemPrompt !== "string") return "request.systemPrompt must be a string";
	if (!Array.isArray(request.messages)) return "request.messages must be an array";
	if (!Array.isArray(request.tools)) return "request.tools must be an array";
	if (!isObject(request.settings)) return "request.settings must be an object";
	for (const message of request.messages) {
		if (!isObject(message) || !Array.isArray(message.content) || message.content.some((part: unknown) => !isObject(part) || typeof part.type !== "string")) return "each message needs a content array of parts";
		if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return `unknown message role ${String(message.role)}`;
		if (message.role === "toolResult" && (typeof message.toolCallId !== "string" || typeof message.toolName !== "string")) return "a toolResult message needs toolCallId and toolName";
	}
	for (const tool of request.tools) {
		if (!isObject(tool) || typeof tool.name !== "string" || !tool.name || typeof tool.description !== "string") return "each tool needs a name and a description";
	}
	if (new Set(request.tools.map((tool: { name: string }) => tool.name)).size !== request.tools.length) return "tool names must be distinct";
	return undefined;
}

/**
 * Serve the Provider `claude` over modular-agent-plugin/1 (docs/bindings/plugin.md,
 * "The host asks a Provider"). Resolves when the host closes the connection.
 */
export function serve(options: ServeOptions): Promise<void> {
	const { provider } = options;
	const write = options.output ?? ((line: string) => void process.stdout.write(line));
	let closed = (): void => {};
	const peer = new WirePeer(write, () => closed());
	let initialized = false;
	let stopping = false;
	/** Requests being served, so shutdown can wait for them to settle. */
	const working = new Set<Promise<unknown>>();

	const ours = (id: unknown): void => {
		if (!initialized) throw new WireError("invalid_request", "Not initialized");
		if (id !== PROVIDER_ID) throw new WireError("invalid_request", `No provider ${String(id)}`);
	};

	peer.handle("plugin/initialize", async (p) => {
		if (p.binding !== PLUGIN_BINDING) throw new WireError("not_supported", `This plugin speaks ${PLUGIN_BINDING}, not ${String(p.binding)}`);
		if (initialized) throw new WireError("invalid_request", "Already initialized");
		if (typeof p.project !== "string" || typeof p.home !== "string") throw new WireError("invalid_request", "project and home must be paths");
		initialized = true;
		provider.start({ project: p.project, home: p.home });
		return {
			binding: PLUGIN_BINDING,
			name: "claude-agent-sdk",
			providers: [{ id: PROVIDER_ID, supports: { keepsState: false, runsTools: false, safeToRepeat: false }, models: provider.catalog() }],
		};
	});

	peer.handle("provider/models", async (p) => (ours(p.provider), { models: provider.catalog() }));
	peer.handle("provider/available", async (p) => {
		ours(p.provider);
		const available = await provider.ready();
		const reason = available ? undefined : provider.unavailableReason();
		return reason ? { available, reason } : { available };
	});
	peer.handle("provider/discard", async (p) => {
		ours(p.provider);
		if (typeof p.sessionId !== "string" || !p.sessionId) throw new WireError("invalid_request", "A session is required");
		if (p.erase !== undefined && typeof p.erase !== "boolean") throw new WireError("invalid_request", "erase must be a boolean");
		if (p.erase === true && (!Array.isArray(p.entryIds) || p.entryIds.some((id: unknown) => typeof id !== "string" || !id))) throw new WireError("invalid_request", "Erasing needs entryIds");
		if (p.erase !== true && p.entryIds !== undefined) throw new WireError("invalid_request", "entryIds are sent only when erasing");
		// Nothing is kept here between requests. What Anthropic holds of past requests cannot be named or deleted from here.
		return p.erase === true ? { outOfReach: ["Copies held by Anthropic for requests made through Claude Code"] } : {};
	});

	peer.handle("provider/request", async (p, ctx) => {
		ours(p.provider);
		if (stopping) throw new WireError("internal", "The plugin is shutting down");
		if (!isObject(p.model) || p.model.provider !== PROVIDER_ID) throw new WireError("invalid_request", "model.provider must be this Provider");
		if (!provider.model(p.model.id)) throw new WireError("invalid_request", `No model ${String(p.model.id)}`);
		if (p.sessionId !== undefined && (typeof p.sessionId !== "string" || !p.sessionId)) throw new WireError("invalid_request", "sessionId must be a nonempty string");
		const problem = requestProblem(p.request);
		if (problem) throw new WireError("invalid_request", problem);
		const scope = { sessionId: p.sessionId ?? null, provider: PROVIDER_ID, model: p.model };
		const work = (async (): Promise<AssistantMessage> => {
			// The host commits the request at this callback; inference uses the request it answers with.
			const prepared = await peer.request<{ request?: unknown }>("host/hook", {
				parentRequestId: ctx.id, hook: "provider.request", payload: { ...scope, request: p.request },
			}, ctx.signal);
			if (ctx.signal.aborted) throw new WireError("cancelled", "Cancelled");
			const emit = (event: unknown): void => peer.notify("provider/event", { parentRequestId: ctx.id, event });
			const model = provider.model(p.model.id);
			const invalid = requestProblem(prepared?.request);
			let message: AssistantMessage;
			if (!model || invalid) {
				// Inference was admitted, so from here a failure is a message, not a protocol error.
				message = {
					role: "assistant", content: [], stop: "failed", model: { provider: PROVIDER_ID, id: String(p.model.id) },
					error: { kind: "other", message: model ? `The prepared request is not usable: ${invalid}` : `Model ${String(p.model.id)} is no longer offered.` },
				};
			} else {
				try {
					message = await provider.infer(model, prepared.request as ModelRequest, ctx.signal, emit);
				} catch (error) {
					if (error instanceof Cancelled) throw new WireError("cancelled", "Cancelled");
					throw error;
				}
			}
			if (ctx.signal.aborted) throw new WireError("cancelled", "Cancelled");
			await peer.request("host/hook", { parentRequestId: ctx.id, hook: "provider.response", payload: { ...scope, message } });
			return message;
		})();
		working.add(work);
		try {
			return await work;
		} finally {
			working.delete(work);
		}
	});

	peer.handle("plugin/shutdown", async () => {
		stopping = true;
		provider.close();
		await Promise.allSettled([...working]);
		return {};
	});

	const input = options.input ?? process.stdin;
	return new Promise((resolve) => {
		closed = () => {
			input.pause?.();
			provider.close();
			resolve();
		};
		input.on("data", (chunk: Buffer | string) => peer.feed(chunk));
		const end = (): void => peer.close("the host closed the connection");
		input.on("end", end);
		input.on("close", end);
	});
}
