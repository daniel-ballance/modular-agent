import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Configuration, Plugin } from "@modular-agent/harness";

type Json = Record<string, unknown>;

export function readJson(path: string): Json {
	if (!existsSync(path)) return {};
	return JSON.parse(readFileSync(path, "utf8")) as Json;
}

/** The two settings layers, kept apart so a host can tell where a setting came from. */
export function readSettings(home: string, project: string): { global: Json; project: Json; globalPath: string; projectPath: string } {
	const globalPath = join(home, "settings.json");
	const projectPath = join(project, ".modular-agent", "settings.json");
	return { global: readJson(globalPath), project: readJson(projectPath), globalPath, projectPath };
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
 * A project's plugin settings apply only once the project is trusted, listed under
 * "trustedProjects" in the global settings: they can start programs, such as MCP
 * servers, or change where a plugin reads and writes.
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
			const { global, project } = readSettings(api.home, api.project);
			const trusted = ((global.trustedProjects as string[] | undefined) ?? []).map((p) => resolve(p)).includes(resolve(api.project));
			const fromProject = trusted ? project : { session: project.session ?? {} };
			api.provide("configuration", new FileConfiguration(merge(merge(global, fromProject as Json), options.overrides ?? {})));
		},
	};
}
