import type { MutableModels } from "@earendil-works/pi-ai";
import type { AssistantMessage, ModelInfo, ModelRef, ModelRequest, Plugin, PluginApi, Provider, RequestOptions } from "@modular-agent/harness";
import { PiAiProvider } from "@modular-agent/provider-pi-ai";
import { call, type ClientOptions, ndjson, serve, stream } from "./http.js";

/**
 * A model gateway: Providers as a service. The gateway holds the credentials; an
 * agent using it holds none. It only makes model requests: the hook points
 * around a request run in the agent, in the plugin that stands for the Provider.
 */
export async function providerService(options: { models: MutableModels; token: string; port?: number }) {
	const noHooks = { runHook: async (_hook: string, payload: unknown) => payload } as unknown as PluginApi;
	const providers = new Map(
		options.models
			.getProviders()
			.filter((p) => options.models.getModels(p.id).length)
			.map((p) => [p.id, new PiAiProvider(p.id, options.models, noHooks)]),
	);
	return serve(
		[
			["GET", /^\/providers$/, async () => Promise.all([...providers.values()].map(async (p) => ({ id: p.id, supports: p.supports, models: p.models(), available: await p.available() })))],
			["POST", /^\/providers\/([^/]+)\/request$/, async (req, res) => {
				const provider = providers.get(req.params[0]);
				if (!provider) throw new Error(`No provider ${req.params[0]}`);
				const write = ndjson(res);
				const abort = new AbortController();
				let finished = false;
				res.on("close", () => finished || abort.abort());
				const message = await provider.request(req.body.model, req.body.request, { signal: abort.signal, sessionId: req.body.sessionId, onEvent: (event) => write({ event }) });
				finished = true;
				write({ message });
				res.end();
			}],
		],
		{ port: options.port, token: options.token },
	);
}

interface Offered { id: string; supports: Provider["supports"]; models: ModelInfo[]; available: boolean }

/** One of the gateway's Providers, standing in for it in the agent. */
export class HttpProvider implements Provider {
	readonly id: string;
	readonly supports: Provider["supports"];
	constructor(private client: ClientOptions, private offered: Offered, private api: PluginApi) {
		this.id = offered.id;
		this.supports = offered.supports;
	}
	models(): ModelInfo[] {
		return this.offered.models;
	}
	async available(): Promise<boolean> {
		return this.offered.available;
	}
	async request(ref: ModelRef, request: ModelRequest, options: RequestOptions): Promise<AssistantMessage> {
		// "Before a model request" runs here: this plugin is the Provider, as far as the agent knows.
		const { request: req } = await this.api.runHook<{ request: ModelRequest }>("provider.request", { sessionId: options.sessionId, provider: this.id, model: ref.id, request });
		let message: AssistantMessage | undefined;
		try {
			// Not retried: the gateway may have sent the request on, and a model request may cost money or act.
			await stream(this.client, `/providers/${this.id}/request`, { model: ref, request: req, sessionId: options.sessionId }, (line) => (line.event ? options.onEvent?.(line.event) : (message = line.message)), options.signal);
		} catch (error) {
			if (options.signal.aborted) return { role: "assistant", content: [], stop: "aborted" };
			return { role: "assistant", content: [], stop: "failed", error: { kind: "temporary", message: `The model gateway failed: ${error instanceof Error ? error.message : String(error)}` } };
		}
		if (!message) return { role: "assistant", content: [], stop: "failed", error: { kind: "temporary", message: "The model gateway ended without an answer" } };
		await this.api.runHook("provider.response", { sessionId: options.sessionId, provider: this.id, model: ref.id, message });
		return message;
	}
}

export function providerHttp(client: ClientOptions): Plugin {
	return {
		name: "provider-http",
		replaces: "provider-pi-ai",
		async setup(api) {
			const offered = await call<Offered[]>(client, "GET", "/providers", { retry: true });
			for (const o of offered) api.provide("provider", new HttpProvider(client, o, api));
		},
	};
}
