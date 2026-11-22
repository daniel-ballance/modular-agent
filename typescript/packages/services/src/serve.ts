#!/usr/bin/env node
// Run one service: ma-service <history|environment|provider> '<json settings>'. Prints {"url": ...} once listening.
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { MutableModels } from "@earendil-works/pi-ai";
import { FileCredentialStore } from "@modular-agent/credentials-file";
import { environmentService } from "./environment.js";
import { historyService } from "./history.js";
import { providerService } from "./provider.js";
import { checkSettings } from "./settings.js";

const [kind, raw] = process.argv.slice(2);
const settings = JSON.parse(raw ?? "{}");
let started: { url: string };
if (kind === "history") started = await historyService(settings);
else if (kind === "environment") started = await environmentService(settings);
else if (kind === "provider") {
	// The gateway's models: the built-in vendors with credentials from a file only the gateway reads, or a module's own collection (for tests).
	checkSettings("provider", settings, "models", "token", "port", "auth");
	const { models: source, auth, ...options } = settings;
	let models: MutableModels;
	if (source !== undefined) {
		checkSettings("provider", source, "module", "export", "options");
		const mod = await import(source.module);
		models = await mod[source.export](source.options);
	} else models = builtinModels({ credentials: new FileCredentialStore(auth) as never });
	started = await providerService({ ...options, models });
} else {
	console.error("Usage: ma-service <history|environment|provider> '<json settings>'");
	process.exit(2);
}
console.log(JSON.stringify({ url: started.url }));
process.on("SIGTERM", () => process.exit(0));
