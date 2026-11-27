import type { ModelMessage, ModelRequest, Plugin, PluginApi } from "@modular-agent/harness";
import { isToolCall, modelView, modelViewRows, pairToolResults, text, textOf } from "@modular-agent/harness";

export interface CompactionOptions {
	/** Tokens kept free for the answer. */
	reserveTokens?: number;
	/** Roughly how many tokens of recent history to keep word for word. */
	keepRecentTokens?: number;
}

const estimate = (messages: ModelMessage[]): number => Math.ceil(JSON.stringify(messages).length / 4);

export const view = modelView;

function transcript(messages: ModelMessage[]): string {
	return pairToolResults(messages)
		.map((m) => {
			if (m.role === "toolResult") return `[tool result ${m.toolName}] ${textOf(m.content).slice(0, 2000)}`;
			const calls = m.content.filter(isToolCall).map((p) => `[tool call ${p.name} ${JSON.stringify(p.arguments ?? {}).slice(0, 500)}]`);
			return `[${m.role}] ${textOf(m.content)} ${calls.join(" ")}`.trim();
		})
		.join("\n\n");
}

function cutBefore(rows: ReturnType<typeof modelViewRows>, kinds: Map<string, string>, keepTokens: number, stepBudget: number): number {
	const results = new Map(rows.flatMap(({ message }, i) =>
		message.role === "toolResult" ? [[message.toolCallId, i] as const] : []));
	const safe: boolean[] = [];
	const steps: number[] = [];
	let through = -1;
	for (const [i, { id, message }] of rows.entries()) {
		safe[i] = through < i;
		if (kinds.get(id) !== "response" || message.role !== "assistant" ||
			(message.stop !== "finished" && message.stop !== "toolUse")) continue;
		steps.push(i);
		for (const call of message.content.filter(isToolCall)) {
			through = Math.max(through, results.get(call.id) ?? Infinity);
		}
	}

	const latestInput = rows.findLastIndex(({ id }) => kinds.get(id) === "input");
	const firstNew = rows.findIndex(({ id }) => kinds.get(id) !== "summary" && kinds.get(id) !== "turnStart");
	const afterFirstStep = steps.find((i) => i > latestInput) ?? Infinity;
	const stepStarts = new Set(steps);
	let tokens = 0;
	let inputCut = -1;
	let stepCut = -1;
	for (let i = rows.length - 1; i > firstNew; i--) {
		const { id, message } = rows[i];
		tokens += estimate([message]);
		if (!safe[i]) continue;
		if (kinds.get(id) === "input") {
			inputCut = inputCut < 0 ? i : inputCut;
			if (tokens > keepTokens) return i;
		}
		// A cut after the first step can shorten this turn while retaining a whole response and its results.
		if (i > afterFirstStep && stepStarts.has(i) && (stepCut < 0 || tokens <= stepBudget)) stepCut = i;
	}
	return inputCut >= 0 ? inputCut : stepCut;
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

			api.on("step.before", async (payload: { sessionId: string; turnId: string; model?: { contextWindow: number }; request: ModelRequest }) => {
				let messages = view(await api.readHistory(payload.sessionId), payload.turnId);
				const window = payload.model?.contextWindow ?? Infinity;
				const threshold = window - Math.min(reserve, Math.floor(window / 2));
				if (estimate(messages) > threshold) {
					await compact(api, payload.sessionId, keep, threshold);
					messages = view(await api.readHistory(payload.sessionId), payload.turnId);
				}
				return { value: { ...payload, request: { ...payload.request, messages } } };
			});

			api.on("model.failed", async (payload: { sessionId: string; turnId: string; error: { kind: string }; request: ModelRequest }) => {
				if (payload.error.kind !== "contextTooLarge") return undefined;
				const done = await compact(api, payload.sessionId, keep);
				if (!done) return undefined;
				return { retry: true, request: { ...payload.request, messages: view(await api.readHistory(payload.sessionId), payload.turnId) } };
			});

			api.registerCommand("compact", {
				description: "Summarize older history so the model context is smaller",
				run: async (_args, ctx) => ((await compact(api, ctx.sessionId, keep)) ? "Compacted." : "Nothing to compact."),
			});
		},
	};
}

/** Summarize everything before the recent part of the history, and record the summary. */
export async function compact(
	api: Pick<PluginApi, "name" | "readHistory" | "modelAccess" | "append" | "emit">,
	sessionId: string,
	keepTokens: number,
	budget = Infinity,
): Promise<boolean> {
	const history = await api.readHistory(sessionId);
	const rows = modelViewRows(history);
	const cut = cutBefore(rows, new Map(history.map((e) => [e.id, e.kind])), keepTokens, Math.min(keepTokens, budget));
	if (cut <= 0) return false;
	const older = rows.slice(0, cut);
	const access = api.modelAccess(sessionId);
	if (!access) return false;
	const response = await access.request(
		{
			systemPrompt: "You summarize conversations between a user and a coding agent so the agent can continue the work. Keep goals, decisions, file names, commands run, results, open problems and next steps. Be concise.",
			messages: [{ role: "user", content: [text(`Summarize this conversation:\n\n${transcript(older.map(({ message }) => message))}`)] }],
			tools: [],
			providerTools: "none",
			settings: { maxOutput: 1024 },
		},
		{ signal: new AbortController().signal, sessionId },
	);
	const summary = textOf(response.content);
	if (response.stop !== "finished" || !summary.trim() || response.content.some(isToolCall)) {
		throw new Error("Summary request did not produce a summary");
	}
	// The summary copies what it summarizes, including any earlier summary: erasing any of them erases it.
	const summarized = new Set(older.map(({ id }) => id));
	const sources = history.filter((entry) => summarized.has(entry.id)).map((entry) => entry.id);
	await api.append(sessionId, { kind: "summary", writer: api.name, modelVisible: true, sources, data: { summary } });
	api.emit(sessionId, "context.compacted", { summarized: older.length });
	return true;
}
