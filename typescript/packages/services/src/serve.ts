#!/usr/bin/env node
// Run one service: ma-service <history|environment|provider> '<json settings>'. Prints {"url": ...} once listening.
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { MutableModels } from "@earendil-works/pi-ai";
import { FileCredentialStore } from "@modular-agent/credentials-file";
import { environmentService } from "./environment.js";
import { historyService } from "./history.js";
import { providerService } from "./provider.js";

const [kind, raw] = process.argv.slice(2);
const settings = JSON.parse(raw ?? "{}");
let started: { url: string };
if (kind === "history") started = await historyService(settings);
else if (kind === "environment") started = await environmentService(settings);
else if (kind === "provider") {
	// The gateway's models: the built-in vendors with credentials from a file only the gateway reads, or a module's own collection (for tests).
	let models: MutableModels;
	if (settings.models) {
		const mod = await import(settings.models.module);
		models = await mod[settings.models.export](settings.models.options);
	} else models = builtinModels({ credentials: new FileCredentialStore(settings.auth) as never });
	started = await providerService({ ...settings, models });
} else {
	console.error("Usage: ma-service <history|environment|provider> '<json settings>'");
	process.exit(2);
}
console.log(JSON.stringify({ url: started.url }));
process.on("SIGTERM", () => process.exit(0));
