import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readSettings } from "@modular-agent/config-files";
import type { Plugin } from "@modular-agent/harness";

type LoadEntry = string | { module: string; options?: Record<string, unknown>; export?: string };

function resolveModule(spec: string, base: string): string {
	if (spec.startsWith(".") || isAbsolute(spec)) return pathToFileURL(resolve(base, spec)).href;
	return spec; // a package name
}

/**
 * Plugins named in settings under "load". Each module's export is a Plugin, or a
 * function taking the entry's options and returning one. Plugins from the
 * project's settings are marked as project plugins, so the trust check applies.
 */
export async function pluginsFromSettings(home: string, project: string): Promise<{ plugins: Plugin[]; problems: string[] }> {
	const settings = readSettings(home, project);
	const plugins: Plugin[] = [];
	const problems: string[] = [];
	const layers: [Record<string, unknown>, "global" | "project", string][] = [
		[settings.global, "global", dirname(settings.globalPath)],
		[settings.project, "project", project],
	];
	for (const [layer, origin, base] of layers) {
		for (const raw of (layer.load as LoadEntry[] | undefined) ?? []) {
			const entry = typeof raw === "string" ? { module: raw } : raw;
			try {
				const mod = await import(resolveModule(entry.module, base));
				const exported = mod[entry.export ?? "default"];
				const plugin: Plugin = typeof exported === "function" ? exported(entry.options ?? {}) : exported;
				if (!plugin?.name || typeof plugin.setup !== "function") throw new Error("its export is not a plugin");
				plugins.push({ ...plugin, origin });
			} catch (error) {
				problems.push(`Could not load ${entry.module}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	return { plugins, problems };
}

/**
 * Global plugins load. Project plugins load only once the user trusts the
 * project, by listing it under "trustedProjects" in the global settings.
 */
export function projectTrust(home: string): Plugin {
	return {
		name: "project-trust",
		setup(api) {
			const trusted = () => ((readSettings(home, api.project).global.trustedProjects as string[] | undefined) ?? []).map((p) => resolve(p));
			api.on("plugin.load", (p: { name: string; origin: string; project: string }) => {
				if (p.origin !== "project") return undefined;
				return trusted().includes(resolve(p.project)) ? undefined : { refuse: `${p.name} comes with the project, which is not trusted. Run /trust and restart to load it.` };
			}, "first");
			api.registerCommand("trust", {
				description: "Trust this project, so the plugins in its settings load from the next start",
				run: () => {
					const settings = readSettings(home, api.project);
					const list = new Set((settings.global.trustedProjects as string[] | undefined) ?? []);
					list.add(resolve(api.project));
					mkdirSync(dirname(settings.globalPath), { recursive: true });
					writeFileSync(settings.globalPath, JSON.stringify({ ...settings.global, trustedProjects: [...list] }, null, 2) + "\n");
					return `Trusted ${api.project}. Restart to load its plugins.`;
				},
			});
		},
	};
}
