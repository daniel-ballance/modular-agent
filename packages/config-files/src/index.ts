import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Configuration, Plugin } from "@modular-agent/harness";

type Json = Record<string, unknown>;

function readJson(path: string): Json {
	if (!existsSync(path)) return {};
	return JSON.parse(readFileSync(path, "utf8")) as Json;
}

function merge(a: Json, b: Json): Json {
	const out: Json = { ...a };
	for (const [k, v] of Object.entries(b)) {
		out[k] = v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" ? merge(out[k] as Json, v as Json) : v;
	}
	return out;
}

/**
 * Settings from <home>/settings.json, overridden by <project>/.modular-agent/settings.json.
 * "session" holds defaults for new sessions; "plugins" holds each plugin's own settings.
 */
export class FileConfiguration implements Configuration {
	constructor(private data: Json) {}
	get<T = unknown>(key: string): T | undefined {
		return key.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Json)[k] : undefined), this.data) as T | undefined;
	}
	plugin(name: string): Record<string, unknown> {
		return (this.get<Json>(`plugins.${name}`) ?? {}) as Record<string, unknown>;
	}
}

export function fileConfiguration(options: { overrides?: Json } = {}): Plugin {
	return {
		name: "config-files",
		setup(api) {
			const global = readJson(join(api.home, "settings.json"));
			const project = readJson(join(api.project, ".modular-agent", "settings.json"));
			api.provide("configuration", new FileConfiguration(merge(merge(global, project), options.overrides ?? {})));
		},
	};
}
