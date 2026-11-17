// A Provider plugin with scripted answers, loadable in another process: everything it needs comes as JSON options.
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Plugin } from "@modular-agent/harness";
import { piAiProviders } from "@modular-agent/provider-pi-ai";

export type Scripted = { text: string } | { tool: string; args: Record<string, string | number | boolean> };

export function fauxProviders(options: { responses: Scripted[] }): Plugin {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(options.responses.map((r) => ("tool" in r ? fauxAssistantMessage([fauxToolCall(r.tool, r.args)], { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText(r.text)]))));
	return { ...piAiProviders({ models }), name: "provider-faux" };
}
