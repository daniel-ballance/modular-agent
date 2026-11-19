import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin, ToolDefinition } from "@modular-agent/harness";

const BASE = `You are a coding agent working in the user's project. Use the tools to read files, edit them and run commands. Be concise. When you change files, say what you changed.`;

/** Context files from the project folder up to the filesystem root, outermost first. */
export function contextFiles(project: string, names = ["AGENTS.md", "CLAUDE.md"]): { path: string; text: string }[] {
	const found: { path: string; text: string }[] = [];
	let dir = project;
	while (true) {
		for (const name of names) {
			const path = join(dir, name);
			if (existsSync(path)) {
				found.push({ path, text: readFileSync(path, "utf8") });
				break;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return found.reverse();
}

/**
 * Builds the system prompt at the start of each turn: base instructions, the
 * tools, the working directory, and context files such as AGENTS.md.
 * Other plugins add their own sections through the "turn.before" hook point.
 */
export function systemPrompt(options: { base?: string; contextFileNames?: string[] } = {}): Plugin {
	return {
		name: "system-prompt",
		setup(api) {
			const settings = api.config();
			const base = options.base ?? (settings.base as string | undefined) ?? BASE;
			api.on(
				"turn.before",
				(payload: { sessionId: string }) => {
					const tools = api.tools(payload.sessionId).map((t: ToolDefinition) => `- ${t.name}: ${t.description}`).join("\n");
					const project = api.projectOf(payload.sessionId);
					const files = contextFiles(project, options.contextFileNames)
						.map((f) => `<context-file path="${f.path}">\n${f.text.trim()}\n</context-file>`)
						.join("\n\n");
					const parts = [base, tools && `Available tools:\n${tools}`, `Working directory: ${project}`, files && `Project context:\n\n${files}`];
					return { system: parts.filter(Boolean).join("\n\n") };
				},
				"first",
			);
		},
	};
}
