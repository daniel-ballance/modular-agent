import { readFileSync } from "node:fs";
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
	constructor(readonly id: string, private collection: MutableModels, private api?: Pick<PluginApi, "runHook">,
		private apiKeyModels?: ReadonlyMap<string, ApiKeyModel>) {}

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
		const entry = this.apiKeyModels?.get(ref.id);
		const builtin = this.collection.getModel(this.id, ref.id);
		const found = this.apiKeyModels ? entry && apiKeyPiModel(entry, builtin) : builtin;
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
		let usageOmitted = false;
		try {
			const common = { signal: options.signal, apiKey: options.apiKey, sessionId: options.sessionId, maxTokens: req.settings.maxOutput,
				...(model.api === "openai-responses" && { onProviderStreamEvent(data: unknown) {
					const event = data as { type?: string; response?: { usage?: object | null } } | null;
					if (event?.type === "response.completed" || event?.type === "response.incomplete") {
						// pi-ai's meter starts at zero even if the terminal response omits usage.
						usageOmitted = event.response?.usage == null;
					}
				} }),
			};
			const stream = entry ? this.collection.stream(model, context, {
				...common, onPayload: payload => reasoningPayload(payload as Record<string, unknown>, entry, req.settings.reasoning),
			}) : this.collection.streamSimple(model, context, {
				...common,
				reasoning: reasoning === "off" ? undefined : reasoning as never,
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
		if (usageOmitted) delete message.usage;
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

export type ApiKeyModelEnrollment = Omit<ModelInfo, "provider" | "thinking" | "reasoning"> & { reasoning?: boolean };
type ApiKeyVendor = "openai" | "anthropic";
type ReasoningFields = { reasoning?: object; thinking?: { type: string; budget_tokens?: number }; output_config?: { effort?: string } };
type ApiKeyModel = Omit<ModelInfo, "thinking"> & { provider: ApiKeyVendor; levels: Record<string, ReasoningFields> };
const table: { models: ApiKeyModel[] } = JSON.parse(readFileSync(new URL("../../api-key-models.json", import.meta.url), "utf8"));

function apiKeyPiModel(entry: ApiKeyModel, builtin?: Model<Api>): Model<Api> {
	const openai = entry.provider === "openai";
	return {
		id: entry.id, name: entry.name ?? entry.id, provider: entry.provider,
		api: openai ? "openai-responses" : "anthropic-messages",
		baseUrl: openai ? "https://api.openai.com/v1" : "https://api.anthropic.com",
		contextWindow: entry.contextWindow, maxTokens: entry.maxOutput,
		input: entry.input as Model<Api>["input"], reasoning: entry.reasoning,
		cost: builtin?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function reasoningPayload(payload: Record<string, unknown>, model: ApiKeyModel, requested?: string) {
	// Pi AI supplies vendor-specific defaults for other consumers. API-key Providers
	// strip just the reasoning controls and use the shared table instead.
	const { reasoning: _reasoning, thinking: _thinking, output_config, ...rest } = payload;
	const { effort: _effort, ...output } = (output_config ?? {}) as Record<string, unknown>;
	const level = lowerReasoning(requested, { ...model, thinking: Object.keys(model.levels) });
	let fields = level === undefined ? undefined : model.levels[level];
	if (fields?.thinking?.type === "enabled") {
		const budget = Math.min(fields.thinking.budget_tokens!, Number(rest.max_tokens) - 1);
		fields = budget < 1024 ? model.levels.off : { ...fields, thinking: { type: "enabled", budget_tokens: budget } };
	}
	const config = { ...output, ...fields?.output_config };
	return { ...rest, ...fields, ...(Object.keys(config).length ? { output_config: config } : {}) };
}

/** The SDK APIs reuse the streaming adapter, but use the SDK's catalog and call-scoped API keys. */
export function apiKeyModelAdapter(id: ApiKeyVendor, enrolled: readonly ApiKeyModelEnrollment[] = []) {
	const catalog = new Map(table.models.filter(m => m.provider === id).map(m => [m.id, m]));
	for (const m of enrolled) if (!catalog.has(m.id)) {
		catalog.set(m.id, { ...structuredClone(m), provider: id, reasoning: m.reasoning ?? false, levels: {} });
	}
	const models: ModelInfo[] = [...catalog.values()].map(({ levels, ...info }) => {
		const thinking = Object.keys(levels);
		return thinking.length ? { ...info, thinking } : info;
	});
	return { models, provider: new PiAiProvider(id, builtinModels(), undefined, catalog) };
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
