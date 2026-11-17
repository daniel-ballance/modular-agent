import { parseModel, type ModelInfo, type Plugin, type Provider } from "@modular-agent/harness";

/**
 * Chooses the model and reasoning level for each session from every Provider's
 * catalog. Each change is recorded as a session setting.
 */
export function modelSelection(options: { defaultModel?: string; defaultThinking?: string } = {}): Plugin {
	return {
		name: "model-selection",
		setup(api) {
			const catalog = (): ModelInfo[] => api.useAll<Provider>("provider").flatMap((p) => p.models());
			const fallback = () => options.defaultModel ?? (api.config().default as string | undefined);

			api.on("session.start", async (payload: { sessionId: string }) => {
				const s = api.session(payload.sessionId);
				if (!s.settings.model && fallback()) await api.setSetting(payload.sessionId, "model", fallback());
				if (!s.settings.reasoning && options.defaultThinking) await api.setSetting(payload.sessionId, "thinking", options.defaultThinking);
			});

			api.registerCommand("model", {
				description: "Show or set the model: /model provider/id",
				run: async (args, ctx) => {
					const wanted = args.trim();
					if (!wanted) {
						const current = parseModel(api.session(ctx.sessionId).settings.model);
						return current ? `Current model: ${current.provider}/${current.id}` : "Current model: (none)";
					}
					const all = catalog();
					const match = all.find((m) => `${m.provider}/${m.id}` === wanted) ?? all.find((m) => m.id === wanted);
					if (!match) {
						const close = all.filter((m) => `${m.provider}/${m.id}`.includes(wanted)).slice(0, 10);
						return `Unknown model ${wanted}.${close.length ? ` Did you mean: ${close.map((m) => `${m.provider}/${m.id}`).join(", ")}` : ""}`;
					}
					await api.setSetting(ctx.sessionId, "model", `${match.provider}/${match.id}`, ctx.actorId);
					return `Model set to ${match.provider}/${match.id}`;
				},
			});

			api.registerCommand("models", {
				description: "List models: /models [filter]",
				run: (args) => {
					const filter = args.trim();
					const list = catalog().filter((m) => !filter || `${m.provider}/${m.id}`.includes(filter));
					return list.slice(0, 50).map((m) => `${m.provider}/${m.id}`).join("\n") + (list.length > 50 ? `\n... ${list.length - 50} more` : "");
				},
			});

			api.registerCommand("thinking", {
				description: "Show or set the reasoning level: /thinking low|medium|high",
				run: async (args, ctx) => {
					const level = args.trim();
					if (!level) return `Reasoning level: ${api.session(ctx.sessionId).settings.reasoning ?? "(default)"}`;
					await api.setSetting(ctx.sessionId, "thinking", level, ctx.actorId);
					return `Reasoning level set to ${level}`;
				},
			});
		},
	};
}
