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
	const harness = new Harness({ project: options.project ?? process.cwd(), home: options.home ?? join(homedir(), ".modular-agent") });
	await harness.load(vanillaPlugins(options));
	return harness;
}

export { Harness };
