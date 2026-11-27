import assert from "node:assert/strict";
import { test } from "node:test";
import { isToolCall, modelView, text, type HistoryEntry, type ModelMessage } from "@modular-agent/harness";
import { compact } from "../src/index.js";

function fixture() {
	const history: HistoryEntry[] = [];
	const add = (id: string, kind: string, message?: ModelMessage, data?: unknown) => history.push({
		id, kind, message, data, modelVisible: !!message, parentId: history.at(-1)?.id ?? null,
		sessionId: "session", time: history.length, writer: "test",
	});
	const response = (id: string, ...calls: string[]) => add(id, "response", {
		role: "assistant", stop: "toolUse",
		content: calls.map((id) => ({ type: "toolCall", id, name: "read", arguments: {} })),
	});
	const result = (call: string) => add(`result-${call}`, "toolResult", {
		role: "toolResult", toolCallId: call, toolName: "read", content: [text(call)], isError: false,
	});
	add("prompt", "input", { role: "user", content: [text("The original goal")] });
	const api = {
		name: "context-compaction",
		readHistory: () => history,
		modelAccess: () => ({
			model: { id: "fake", provider: "fake", contextWindow: 1000, maxOutput: 100, input: ["text"], reasoning: false },
			supports: {},
			request: async () => ({ role: "assistant", stop: "finished", content: [text("Goal and settled outcomes")] }),
		}),
		append: async (_session, draft) => {
			const entry = { ...draft, id: `summary-${history.length}`, parentId: history.at(-1)!.id, sessionId: "session", time: history.length };
			history.push(entry);
			return entry;
		},
		emit: () => {},
	} satisfies Parameters<typeof compact>[0];
	return { history, add, response, result, compact: () => compact(api, "session", 0) };
}

test("settled calls with late results cannot be split, and an Interface handoff stays pending", async () => {
	const f = fixture();
	f.response("parallel", "first", "late");
	f.result("first");
	f.response("next", "next-call");
	f.result("next-call");
	f.add("handoff", "modular-agent.interfaceHandoff");
	f.add("end", "turnEnd", undefined, { result: { openToolCalls: ["late"] } });
	assert.equal(await f.compact(), false);
	f.result("late");
	f.response("keep", "keep-call");
	f.result("keep-call");
	f.response("open", "open-call");
	f.add("pending", "modular-agent.interfaceHandoff");
	f.add("end-open", "turnEnd", undefined, { result: { openToolCalls: ["open-call"] } });
	assert.equal(await f.compact(), true);
	const summary = f.history.at(-1)!;
	assert.deepEqual(summary.sources, ["prompt", "parallel", "result-first", "next", "result-next-call", "result-late", "keep", "result-keep-call"]);
	const messages = modelView(f.history);
	assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "toolResult"]);
	assert.equal(messages[1].content.filter(isToolCall)[0].id, "open-call");
	assert.match((messages[2].content[0] as { text: string }).text, /waiting/);
});

test("a later summary names the prior summary and the retained steps it replaces", async () => {
	const f = fixture();
	for (const step of ["a", "b"]) { f.response(step, step); f.result(step); }
	assert.equal(await f.compact(), true);
	const earlier = f.history.at(-1)!;
	f.response("c", "c");
	f.result("c");
	assert.equal(await f.compact(), true);
	assert.deepEqual(f.history.at(-1)?.sources, ["b", "result-b", earlier.id]);
	assert.deepEqual(modelView(f.history).map((m) => m.role), ["user", "assistant", "toolResult"]);
	earlier.erased = true;
	assert.ok(!modelView(f.history).some((m) => m.role === "user" && m.content[0].type === "text" && m.content[0].text === "Goal and settled outcomes"));
});
