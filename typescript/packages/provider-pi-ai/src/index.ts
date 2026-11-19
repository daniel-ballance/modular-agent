import {
	type AssistantMessage as PiAssistantMessage,
	type Context,
	type Message as PiMessage,
	type Model,
	type MutableModels,
	type Api,
	isContextOverflow,
	isRetryableAssistantError,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { lowerReasoning } from "@modular-agent/harness";
import type {
	AssistantMessage,
	ContentPart,
	CredentialStore,
	ModelError,
	ModelInfo,
	ModelMessage,
	ModelRef,
	ModelRequest,
	Plugin,
	PluginApi,
	Provider,
	RequestOptions,
	StopReason,
} from "@modular-agent/harness";

/** One pi-ai provider (one vendor) as one Provider. */
export class PiAiProvider implements Provider {
	readonly supports = { keepsState: false, runsTools: false, liveSessions: false, lateAnswers: false };
	constructor(readonly id: string, private collection: MutableModels, private api?: Pick<PluginApi, "runHook">) {}

	models(): ModelInfo[] {
		return this.collection.getModels(this.id).map(toInfo);
	}

	async available(): Promise<boolean> {
		try {
			return (await this.collection.getAuth(this.id)) !== undefined;
		} catch {
			return false;
		}
	}

	async request(ref: ModelRef, request: ModelRequest, options: RequestOptions & { apiKey?: string; baseUrl?: string }): Promise<AssistantMessage> {
		const found = this.collection.getModel(this.id, ref.id);
		const model = found && (options.baseUrl ? { ...found, baseUrl: options.baseUrl } : found);
		if (!model) return failed(`Unknown model ${this.id}/${ref.id}`, "other");
		// "Before a model request": Provider middleware may change the request.
		const { request: req } = options.requestPrepared || !this.api ? { request } : await this.api.runHook<{ request: ModelRequest }>("provider.request", { sessionId: options.sessionId, provider: this.id, model: { provider: this.id, id: ref.id }, request });
		const context: Context = {
			systemPrompt: req.systemPrompt || undefined,
			messages: req.messages.map((m) => toPi(m, model)),
			tools: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
		};
		const reasoning = lowerReasoning(req.settings.reasoning, toInfo(model));
		let final: PiAssistantMessage;
		try {
			const stream = this.collection.streamSimple(model, context, {
				signal: options.signal,
				apiKey: options.apiKey,
				sessionId: options.sessionId,
				reasoning: reasoning === "off" ? undefined : reasoning as never,
				maxTokens: req.settings.maxOutput,
			});
			for await (const event of stream) {
				if (event.type === "text_delta") options.onEvent?.({ type: "text", delta: event.delta });
				else if (event.type === "thinking_delta") options.onEvent?.({ type: "reasoning", delta: event.delta });
				else if (event.type === "toolcall_delta") options.onEvent?.({ type: "toolInput", delta: event.delta });
			}
			final = await stream.result();
		} catch (error) {
			return failed(error instanceof Error ? error.message : String(error), "other");
		}
		const message = fromPi(final, model);
		if (!options.signal.aborted && !options.requestPrepared && this.api) await this.api.runHook("provider.response", { sessionId: options.sessionId, provider: this.id, model: { provider: this.id, id: ref.id }, message });
		return message;
	}
}

function toInfo(m: Model<Api>): ModelInfo {
	return {
		provider: m.provider,
		id: m.id,
		name: m.name,
		contextWindow: m.contextWindow,
		maxOutput: m.maxTokens,
		input: [...(m.input ?? ["text"])],
		reasoning: m.reasoning,
	};
}

const STOP: Record<string, StopReason> = { stop: "finished", toolUse: "toolUse", length: "length", error: "failed", aborted: "aborted" };

function fromPi(m: PiAssistantMessage, model: Model<Api>): AssistantMessage {
	const usage = {
		input: m.usage?.input ?? 0,
		output: m.usage?.output ?? 0,
		cacheRead: m.usage?.cacheRead ?? 0,
		cacheWrite: m.usage?.cacheWrite ?? 0,
		cost: m.usage?.cost?.total ?? 0,
	};
	let error: ModelError | undefined;
	if (m.stopReason === "error") {
		const message = m.errorMessage ?? "The model request failed";
		if (isContextOverflow(m, model.contextWindow)) error = { kind: "contextTooLarge", message };
		else if (isRetryableAssistantError(m)) error = { kind: "temporary", message };
		else if (/\b(401|403)\b|unauthori[sz]ed|credential|api key|oauth/i.test(message)) error = { kind: "credentials", message };
		else error = { kind: "other", message };
	}
	return {
		role: "assistant",
		content: m.content.map((p): ContentPart => p.type === "thinking"
			? { type: "reasoning", ...(p.thinking ? { text: p.thinking } : {}), ...(p.thinkingSignature ? { providerData: p.thinkingSignature } : {}) }
			: { ...p }),
		stop: STOP[m.stopReason] ?? "finished",
		usage,
		model: { provider: m.provider, id: m.model },
		error,
		providerData: m,
	};
}

function toPi(m: ModelMessage, model: Model<Api>): PiMessage {
	const timestamp = Date.now();
	switch (m.role) {
		case "user":
			return { role: "user", content: m.content.filter((p) => p.type === "text" || p.type === "image") as never, timestamp };
		case "toolResult":
			return {
				role: "toolResult", toolCallId: m.toolCallId, toolName: m.toolName, isError: m.isError, timestamp,
				content: m.content.filter((p) => p.type === "text" || p.type === "image") as never,
			} as PiMessage;
		case "assistant": {
			// Replay the Provider's own form when we have it, so nothing is lost; pi-ai handles handoffs between vendors.
			if (m.providerData && typeof m.providerData === "object") return m.providerData as PiAssistantMessage;
			return {
				role: "assistant",
				content: m.content.filter((p) => ["text", "reasoning", "thinking", "toolCall"].includes(p.type)).map((p) => p.type === "reasoning"
					? { type: "thinking", thinking: p.text ?? "", thinkingSignature: p.providerData }
					: p) as never,
				api: model.api,
				provider: m.model?.provider ?? model.provider,
				model: m.model?.id ?? model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: m.stop === "toolUse" ? "toolUse" : "stop",
				timestamp,
			} as PiAssistantMessage;
		}
	}
}

function failed(message: string, kind: ModelError["kind"]): AssistantMessage {
	return { role: "assistant", content: [], stop: "failed", error: { kind, message } };
}

/** The SDK APIs reuse the base adapter, but supply API-key auth per call. */
export function apiKeyModelAdapter(id: "openai" | "anthropic") {
	const collection = builtinModels();
	const api = id === "openai" ? "openai-responses" : "anthropic-messages";
	const models = collection.getModels(id).filter(m => m.api === api);
	return { models: models.map(toInfo), provider: new PiAiProvider(id, collection) };
}

export interface PiAiProviderOptions {
	/** Use this pi-ai collection instead of every built-in provider, for example a faux provider in tests. */
	models?: MutableModels;
	/** Only offer these pi-ai provider ids. */
	only?: string[];
}

/** Offers every pi-ai vendor as a Provider. Credentials come from the credential store, if one is loaded. */
export function piAiProviders(options: PiAiProviderOptions = {}): Plugin {
	return {
		name: "provider-pi-ai",
		// A collection of models passed in can't move to another process; the built-in one can.
		...(options.models ? {} : { spawn: { module: "@modular-agent/provider-pi-ai", export: "piAiProviders", options: { only: options.only } } }),
		setup(api) {
			const credentials = api.use<CredentialStore>("credential-store");
			const models = options.models ?? builtinModels(credentials ? { credentials: credentials as never } : undefined);
			for (const p of models.getProviders()) {
				if (options.only && !options.only.includes(p.id)) continue;
				if (models.getModels(p.id).length === 0) continue;
				api.provide("provider", new PiAiProvider(p.id, models, api));
			}
		},
	};
}
