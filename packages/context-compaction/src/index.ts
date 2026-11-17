import type { HistoryEntry, ModelMessage, ModelRequest, Plugin, PluginApi } from "@modular-agent/harness";
import { pairToolResults, text, textOf } from "@modular-agent/harness";

export interface CompactionOptions {
	/** Tokens kept free for the answer. */
	reserveTokens?: number;
	/** Roughly how many tokens of recent history to keep word for word. */
	keepRecentTokens?: number;
}

const estimate = (messages: ModelMessage[]): number => Math.ceil(JSON.stringify(messages).length / 4);

interface SummaryData { summary: string; firstKept: string }

/** A summary still in force. An erased one is skipped, so the model sees what remains in full, until it is compacted again. */
const isSummary = (e: HistoryEntry) => e.kind === "summary" && typeof (e.data as Partial<SummaryData> | undefined)?.summary === "string";

/** The model context: the latest summary, then everything after the first entry it kept. */
export function view(history: HistoryEntry[]): ModelMessage[] {
	let start = 0;
	let summary: SummaryData | undefined;
	for (let i = history.length - 1; i >= 0; i--) {
		if (isSummary(history[i])) {
			summary = history[i].data as SummaryData;
			const kept = history.findIndex((e) => e.id === summary!.firstKept);
			start = kept >= 0 ? kept : i + 1;
			break;
		}
	}
	const messages = history.slice(start).filter((e) => e.modelVisible && e.message).map((e) => e.message!);
	return pairToolResults(summary ? [{ role: "user", content: [text(`Summary of the earlier conversation:\n\n${summary.summary}`)] }, ...messages] : messages);
}

function transcript(entries: HistoryEntry[]): string {
	return entries
		.filter((e) => e.modelVisible && e.message)
		.map((e) => {
			const m = e.message!;
			if (m.role === "toolResult") return `[tool result ${m.toolName}] ${textOf(m.content).slice(0, 2000)}`;
			const calls = m.content.filter((p) => p.type === "toolCall").map((p) => `[tool call ${(p as { name: string }).name} ${JSON.stringify((p as { arguments: unknown }).arguments).slice(0, 500)}]`);
			return `[${m.role}] ${textOf(m.content)} ${calls.join(" ")}`.trim();
		})
		.join("\n\n");
}

/**
 * Context management: decides what the model sees before each step, and
 * compacts older history when it grows too large. Compaction adds a summary;
 * nothing is deleted.
 */
export function contextCompaction(options: CompactionOptions = {}): Plugin {
	return {
		name: "context-compaction",
		setup(api) {
			const reserve = (options.reserveTokens ?? (api.config().reserveTokens as number | undefined)) ?? 16_384;
			const keep = (options.keepRecentTokens ?? (api.config().keepRecentTokens as number | undefined)) ?? 20_000;

			api.on("step.before", async (payload: { sessionId: string; model?: { contextWindow: number }; request: ModelRequest }) => {
				let messages = view(api.history(payload.sessionId));
				const window = payload.model?.contextWindow ?? Infinity;
				if (estimate(messages) > window - reserve) {
					await compact(api, payload.sessionId, keep);
					messages = view(api.history(payload.sessionId));
				}
				return { value: { ...payload, request: { ...payload.request, messages } } };
			});

			api.on("model.failed", async (payload: { sessionId: string; error: { kind: string }; request: ModelRequest }) => {
				if (payload.error.kind !== "contextTooLarge") return undefined;
				const done = await compact(api, payload.sessionId, keep);
				if (!done) return undefined;
				return { retry: true, request: { ...payload.request, messages: view(api.history(payload.sessionId)) } };
			});

			api.registerCommand("compact", {
				description: "Summarize older history so the model context is smaller",
				run: async (_args, ctx) => ((await compact(api, ctx.sessionId, keep)) ? "Compacted." : "Nothing to compact."),
			});
		},
	};
}

/** Summarize everything before the recent part of the history, and record the summary. */
export async function compact(api: PluginApi, sessionId: string, keepTokens: number): Promise<boolean> {
	const history = api.history(sessionId);
	const lastSummary = history.map(isSummary).lastIndexOf(true);
	const candidates = history.slice(lastSummary + 1);
	// Keep recent entries, cutting only before an input so tool calls stay with their results.
	let tokens = 0;
	let cut = -1;
	for (let i = candidates.length - 1; i >= 0; i--) {
		const m = candidates[i].message;
		if (m) tokens += estimate([m]);
		if (tokens > keepTokens && m?.role === "user") {
			cut = i;
			break;
		}
	}
	// When everything fits, keep only from the latest input.
	if (cut <= 0) cut = candidates.map((e) => e.message?.role).lastIndexOf("user");
	if (cut <= 0) return false;
	const older = candidates.slice(0, cut);
	const access = api.modelAccess(sessionId);
	if (!access) return false;
	const previous = lastSummary >= 0 ? (history[lastSummary].data as SummaryData).summary + "\n\n" : "";
	const response = await access.request(
		{
			systemPrompt: "You summarize conversations between a user and a coding agent so the agent can continue the work. Keep goals, decisions, file names, commands run, results, open problems and next steps. Be concise.",
			messages: [{ role: "user", content: [text(`${previous ? `An earlier summary:\n${previous}` : ""}Summarize this conversation:\n\n${transcript(older)}`)] }],
			tools: [],
			settings: {},
		},
		{ signal: new AbortController().signal, sessionId },
	);
	if (response.stop === "failed") return false;
	// The summary copies what it summarizes, including any earlier summary: erasing any of them erases it.
	const sources = [...(lastSummary >= 0 ? [history[lastSummary].id] : []), ...older.map((e) => e.id)];
	await api.append(sessionId, { kind: "summary", writer: api.name, modelVisible: false, sources, data: { summary: textOf(response.content), firstKept: candidates[cut].id } satisfies SummaryData });
	api.emit(sessionId, "context.compacted", { summarized: older.length });
	return true;
}
