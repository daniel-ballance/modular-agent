import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import type { Plugin, TurnOutcome } from "@modular-agent/harness";
import { durableRuntime } from "@modular-agent/runtime-durable";
import { PLUGIN_BINDING, servePlugins, WireError, WirePeer } from "@modular-agent/plugin-wire";
import { transientRuntime } from "@modular-agent/runtime-transient";

async function wireHost(t: TestContext, runtime: Plugin) {
	const input = new PassThrough();
	const host = new WirePeer((line) => input.write(line));
	const serving = servePlugins({ name: "runtime-test", plugins: [runtime], input, output: (line) => host.feed(line) });
	t.after(async () => { input.end(); await serving; host.close(); });
	await host.request("plugin/initialize", { binding: PLUGIN_BINDING, project: "/project", home: "/home", config: {} });
	return host;
}

const turn = {
	sessionId: "session", turnId: "turn", startedBy: { kind: "actor", id: "user" }, settings: {},
	model: { provider: "fixture", id: "test", contextWindow: 1000, maxOutput: 100, input: ["text"], reasoning: false },
	modelSupports: { keepsState: false, runsTools: false },
};
const usage = { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 };
const response = { role: "assistant", content: [{ type: "toolCall", id: "question-call", name: "ask", arguments: {} }], stop: "toolUse", usage };

for (const makeRuntime of [transientRuntime, durableRuntime]) {
	test(`${makeRuntime.name}: wire step.after rejection leaves the pending call open`, { timeout: 5000 }, async (t) => {
		const host = await wireHost(t, makeRuntime());
		const definition = { name: "ask", description: "Ask a question", parameters: { type: "object" } };
		const outcome = { kind: "failed", error: "Step has an unfinished call round" };
		const committed: string[] = [];
		let pending = false;
		let observed: Pick<TurnOutcome, "outcome" | "result"> | undefined;
		host.handle("host/runtime/newId", () => ({ id: "step" }));
		host.handle("host/runtime/prepareStep", () => ({ system: "", messages: [], tools: [definition] }));
		host.handle("host/runtime/model", () => response);
		host.handle("host/runtime/definition", () => definition);
		host.handle("host/runtime/takeSteering", () => ({ entries: [] }));
		host.handle("host/runtime/record", ({ entry }) => {
			committed.push(entry.kind);
			return { ...entry, id: "response-entry", parentId: null, sessionId: "session", turnId: "turn", time: 1 };
		});
		host.handle("host/runtime/runToolCall", ({ call }) => {
			assert.equal(call.id, "question-call");
			pending = true;
			return { callId: call.id, pending: "Waiting for an answer" };
		});
		host.handle("host/runtime/hook", ({ hook, payload }) => {
			switch (hook) {
				case "turn.start": return null;
				case "tool.before": return { value: payload };
				case "step.after":
					assert.ok(pending);
					throw new WireError("invalid_request", outcome.error);
				case "turn.end":
					observed = payload;
					return null;
				default: assert.fail(`Unexpected hook ${hook}`);
			}
		});

		const end = await host.request<TurnOutcome>("runtime/runTurn", { turn });
		assert.deepEqual(end.outcome, outcome);
		assert.deepEqual(end.result.openToolCalls, ["question-call"]);
		assert.deepEqual(observed?.outcome, outcome);
		assert.deepEqual(observed?.result.openToolCalls, ["question-call"]);
		assert.deepEqual(committed, ["response"]);
		assert.deepEqual(end.entries, ["response-entry"]);
		assert.deepEqual(end.usage, usage);
	});
}

test("durable Runtime: failed wire resume preserves pending calls but not settled calls", { timeout: 5000 }, async (t) => {
	const host = await wireHost(t, durableRuntime());
	const decision = { refuse: "Committed refusal" };
	const rows = [
		{ kind: "modelRequest", data: { tools: ["ask"], safeToRepeat: false, model: turn.model } },
		{ kind: "response", message: { ...response, content: [
			{ type: "toolCall", id: "first-call", name: "ask", arguments: {} },
			{ type: "toolCall", id: "settled-call", name: "ask", arguments: {} },
			...response.content,
		] } },
		{ kind: "toolPending", toolCallId: "question-call", data: { requestIds: ["q3"] } },
		{ kind: "toolPending", toolCallId: "first-call", data: { requestIds: ["q1"] } },
		{ kind: "toolPending", toolCallId: "settled-call", data: { requestIds: ["q2"] } },
		{ kind: "modular-agent.stepAfter", data: { decision } },
	].map((row, i) => ({ ...row, id: `entry-${i}`, parentId: i ? `entry-${i - 1}` : null, sessionId: turn.sessionId, turnId: turn.turnId, stepId: "step", time: i }));
	const settled = { id: "terminal", kind: "toolResult", toolCallId: "settled-call", erased: true };
	host.handle("host/history", ({ all }) => ({ entries: all ? [...rows, settled] : rows }));
	host.handle("host/runtime/hook", ({ hook }) => { assert.equal(hook, "turn.end"); return null; });
	const end = await host.request<TurnOutcome>("runtime/resumeTurn", {
		turn, interrupted: { turnId: turn.turnId, calls: [], lastStep: { stepId: "step", decision } },
	});
	assert.deepEqual(end.outcome, { kind: "failed", error: decision.refuse });
	assert.deepEqual(end.result.openToolCalls, ["first-call", "question-call"]);
});
