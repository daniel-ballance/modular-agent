import { homedir } from "node:os";
import { join } from "node:path";
import type { MutableModels } from "@earendil-works/pi-ai";
import { Harness, type Plugin } from "@modular-agent/harness";
import { configuration } from "./config.js";
import { contextCompaction } from "@modular-agent/context-compaction";
import { fileCredentials } from "@modular-agent/credentials-file";
import { localEnvironment } from "@modular-agent/env-local";
import { jsonlHistory } from "@modular-agent/history-jsonl";
import { modelSelection } from "@modular-agent/model-selection";
import { piAiProviders } from "@modular-agent/provider-pi-ai";
import { transientRuntime } from "@modular-agent/runtime-transient";
import { systemPrompt } from "@modular-agent/system-prompt";
import { fileTools } from "@modular-agent/tools-files";
import { pluginsFromSettings, projectTrust } from "./loading.js";
import { remotePlugin } from "@modular-agent/plugin-rpc";
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
	/**
	 * Plugins to run each in a process of its own, by name, such as
	 * ["runtime-transient", "tools-files", "env-local"]. Defaults to the
	 * comma-separated MA_REMOTE environment variable. Only plugins that say how to
	 * load them elsewhere can move.
	 */
	remote?: string[];
}

/** The plugins that make up the vanilla agent, in load order. */
export function vanillaPlugins(options: AgentOptions = {}): Plugin[] {
	return [
		configuration({ plugins: { "credentials-file": options.usePiAuth ? { usePiAuth: true } : {} }, ...(options.settings ?? {}) }),
		fileCredentials(),
		...(options.ephemeral ? [] : [jsonlHistory()]),
		localEnvironment(),
		piAiProviders({ models: options.models }),
		transientRuntime(),
		fileTools(),
		systemPrompt(),
		contextCompaction(),
		modelSelection({ defaultModel: options.model }),
		...(options.plugins ?? []),
	];
}

export async function createAgent(options: AgentOptions = {}): Promise<Harness> {
	const project = options.project ?? process.cwd();
	const home = options.home ?? join(homedir(), ".modular-agent");
	const harness = new Harness({ project, home });
	const fromSettings = await pluginsFromSettings(home, project);
	for (const problem of fromSettings.problems) harness.problems.push({ plugin: "settings", where: "load", error: problem });
	// The trust check loads first, so it can refuse project plugins loaded after it.
	const remote = new Set(options.remote ?? (process.env.MA_REMOTE ? process.env.MA_REMOTE.split(",").map((s) => s.trim()) : []));
	const plugins = [projectTrust(home), ...vanillaPlugins(options), ...fromSettings.plugins].map((p) => (remote.has(p.name) && p.spawn ? remotePlugin(p) : p));
	await harness.load(plugins);
	return harness;
}

export { Harness };
