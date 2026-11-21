import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MutableModels } from "@earendil-works/pi-ai";
import { Harness, filePendingErasure, type ReservationOptions, type Plugin } from "@modular-agent/harness";
import { configuration } from "./config.js";
import { contextCompaction } from "@modular-agent/context-compaction";
import { fileCredentials } from "@modular-agent/credentials-file";
import { localEnvironment } from "@modular-agent/env-local";
import { jsonlHistory } from "@modular-agent/history-jsonl";
import { modelSelection } from "@modular-agent/model-selection";
import { piAiProviders } from "@modular-agent/provider-pi-ai";
import { approval } from "@modular-agent/approval";
import { transientRuntime } from "@modular-agent/runtime-transient";
import { systemPrompt } from "@modular-agent/system-prompt";
import { fileTools } from "@modular-agent/tools-files";
import { pluginsFromSettings, projectTrust } from "./loading.js";
import { remotePlugin } from "@modular-agent/plugin-rpc";
import { historyHttp, HttpHistoryStore } from "@modular-agent/services";
import { type ExternalPluginSpec, pluginSpecsFromEnv, startExternalPlugin, startPluginService } from "@modular-agent/plugin-wire";
export { pluginsFromSettings, projectTrust } from "./loading.js";

export interface AgentOptions {
	project?: string;
	home?: string;
	model?: string;
	/** Share Pi's ~/.pi/agent/auth.json for credentials. */
	usePiAuth?: boolean;
	/** Keep no history on disk. */
	ephemeral?: boolean;
	/** A pi-ai collection to use instead of the built-in providers, for tests. */
	models?: MutableModels;
	/** Extra plugins, loaded after the standard set. */
	plugins?: Plugin[];
	settings?: Record<string, unknown>;
	resourceReservations?: ReservationOptions;
	/**
	 * Plugins to run each in a process of its own, by name, such as
	 * ["runtime-transient", "tools-files", "env-local"]. Defaults to the
	 * comma-separated MA_REMOTE environment variable. Only plugins that say how to
	 * load them elsewhere can move.
	 */
	remote?: string[];
	/** Plugins to start as separate programs, in any language. Defaults to MODULAR_AGENT_PLUGINS. */
	externalPlugins?: ExternalPluginSpec[];
}

/** The plugins that make up the vanilla agent, in load order. */
export function vanillaPlugins(options: AgentOptions = {}): Plugin[] {
	return [
		configuration({ plugins: { "credentials-file": options.usePiAuth ? { usePiAuth: true } : {} }, ...(options.settings ?? {}) }),
		fileCredentials(),
		...(options.ephemeral ? [] : [jsonlHistory()]),
		localEnvironment({ points: "copy" }),
		piAiProviders({ models: options.models }),
		transientRuntime(),
		fileTools(),
		systemPrompt(),
		contextCompaction(),
		modelSelection({ defaultModel: options.model }),
		...(options.plugins?.some((p) => p.name === "approval") ? [] : [approval({ policy: "off" })]),
		...(options.plugins ?? []),
	];
}

export async function createAgent(options: AgentOptions = {}): Promise<Harness> {
	const project = options.project ?? process.cwd();
	const home = options.home ?? process.env.MODULAR_AGENT_DATA_DIR ?? process.env.MA_HOME ?? join(homedir(), ".modular-agent");
	const harness = new Harness({ project, home, resourceReservations: options.resourceReservations });
	const fromSettings = await pluginsFromSettings(home, project);
	for (const problem of fromSettings.problems) harness.problems.push({ plugin: "settings", where: "load", error: problem });
	// The trust check loads first, so it can refuse project plugins loaded after it.
	const remote = new Set(options.remote ?? (process.env.MA_REMOTE ? process.env.MA_REMOTE.split(",").map((s) => s.trim()) : []));
	// A history service that follows modular-agent-history/1, in any language, can replace the local store.
	const historyUrl = process.env.MODULAR_AGENT_HISTORY_URL;
	const historyService: Plugin[] = [];
	if (historyUrl !== undefined) {
		const client = { url: historyUrl, token: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(process.env.MODULAR_AGENT_HISTORY_TOKEN_FILE ?? "")) };
		const store = new HttpHistoryStore(client);
		await store.initialize();
		const erasure = process.env.MODULAR_AGENT_PENDING_ERASURE_DIR ?? (process.env.MODULAR_AGENT_CONFORMANCE === "1"
			? process.env.MODULAR_AGENT_CONFORMANCE_ERASURE_DIR : undefined);
		if (erasure) Object.assign(store, { pendingErasure: filePendingErasure(erasure) });
		historyService.push(historyHttp(client, store));
	}
	// Load local items first, then validate each external registration against them.

	const plugins = [projectTrust(home), ...vanillaPlugins(options), ...historyService, ...fromSettings.plugins].map((p) => (remote.has(p.name) && p.spawn ? remotePlugin(p) : p));
	await harness.load(plugins);
	const owned = new Set<string>();
	try {
		for (const spec of options.externalPlugins ?? pluginSpecsFromEnv()) {
			const external = await ("url" in spec ? startPluginService(spec, { project, home }) : startExternalPlugin(spec, { project, home }));
			try {
				const detail = external.refusal(harness, owned);
				if (detail) throw new Error(detail);
				const plugin = external.plugin;
				for (const item of external.replacements) harness.replacements.set(item, plugin.name);
				await harness.load([plugin]);
				if (!harness.plugins().includes(plugin.name)) throw new Error("The host refused to load this plugin");
				for (const item of external.items) owned.add(item);
			} catch (error) {
				await external.stop("refused", error instanceof Error ? error.message : String(error));
				throw error;
			}
		}
	} catch (error) {
		await harness.stop();
		throw error;
	}
	return harness;
}

export { Harness };
export { conformanceProvider, ConformanceProvider } from "./conformance.js";
