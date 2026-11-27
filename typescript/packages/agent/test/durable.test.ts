import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { ALL_AUTHORITY, textOf, type Harness } from "@modular-agent/harness";
import { durableRuntime } from "@modular-agent/runtime-durable";
import { createAgent } from "../src/index.js";
import { testDirs, testTempDir } from "./fixtures/temp-dir.js";

async function agent(dirs: { project: string; home: string }, responses: FauxResponseStep[], durable: boolean): Promise<Harness> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	return createAgent({ ...dirs, models, model: "faux/faux-1", plugins: durable ? [durableRuntime()] : [] });
}

/** A session whose process stopped mid-step: read and bash had started, write had not. */
async function crashedSession(t: TestContext) {
	const dirs = testDirs(t);
	writeFileSync(join(dirs.project, "notes.txt"), "remember the milk");
	const h = await agent(dirs, [], false);
	const api = h.api("test");
	const s = await api.startSession();
	await api.append(s, { kind: "inputAccepted", writer: "harness", modelVisible: false, actorId: "user", inputId: "foreign-input",
		data: { content: [{ type: "text", text: "do three things" }], when: "now", taken: "now", rights: ALL_AUTHORITY, authorizers: [{ sessionId: s, actorId: "user" }] } });
	await api.append(s, { kind: "turnStart", writer: "test", modelVisible: false, turnId: "t1", actorId: "user", data: { startedBy: { kind: "actor", id: "user" }, model: { provider: "faux", id: "faux-1" }, system: "", tools: api.tools(s), settings: {}, rights: ALL_AUTHORITY, authorizers: [{ sessionId: s, actorId: "user" }] } });
	await api.append(s, { kind: "input", writer: "test", modelVisible: true, turnId: "t1", actorId: "user", message: { role: "user", content: [{ type: "text", text: "do three things" }] }, inputId: "foreign-input" });
	const calls = [fauxToolCall("read", { path: "notes.txt" }), fauxToolCall("bash", { command: "echo charged >> payments.log" }), fauxToolCall("write", { path: "done.txt", content: "ok" })];
	await api.append(s, { kind: "modelRequest", writer: "test", modelVisible: false, turnId: "t1", stepId: "step1", data: { model: { provider: "faux", id: "faux-1" }, tools: calls.map((call) => call.name), safeToRepeat: false } });
	await api.append(s, { kind: "response", writer: "test", modelVisible: true, turnId: "t1", stepId: "step1", message: { role: "assistant", content: calls as never, stop: "toolUse" } });
	for (const c of calls.slice(0, 2)) {
		await api.append(s, { kind: "toolStarted", writer: "test", modelVisible: false, turnId: "t1", toolCallId: c.id, stepId: "step1", data: { call: { id: c.id, name: c.name, input: c.arguments, startedBy: "model", stepId: "step1" }, safeToRepeat: c.name === "read" && process.platform === "linux" } });
	}
	await h.stop();
	return { dirs, s, calls };
}

function statuses(h: Harness, s: string) {
	return Object.fromEntries(h.api("test").history(s).filter((e) => e.kind === "toolResult").map((e) => [e.message?.role === "toolResult" ? e.message.toolName : "?", (e.data as { status: string }).status]));
}
function outcome(h: Harness, s: string) {
	return (h.api("test").history(s).filter((e) => e.kind === "turnEnd").at(-1)!.data as { outcome: { kind: string } }).outcome.kind;
}

test("swap test: the same crashed session, reopened with a transient and then a durable Runtime", async (context) => {
	const { dirs, s } = await crashedSession(context);
	const copy = { project: dirs.project, home: testTempDir(context, "ma-h2-") };
	cpSync(dirs.home, copy.home, { recursive: true });

	// Transient: the turn ends as failed; started calls have an unknown outcome, the rest never started.
	const t = await agent(dirs, [], false);
	await t.api("test").openSession(s);
	await t.api("test").waitForIdle(s);
	assert.equal(outcome(t, s), "failed");
	assert.deepEqual(statuses(t, s), { read: "outcomeUnknown", bash: "outcomeUnknown", write: "notStarted" });
	assert.equal(existsSync(join(dirs.project, "done.txt")), false);
	await t.stop();

	// Durable: the same plugins, but a different Runtime. The turn carries on.
	const d = await agent(copy, [(context) => fauxAssistantMessage([fauxText(`Finished. Saw ${context.messages.filter((m) => m.role === "toolResult").length} results.`)])], true);
	const api = d.api("test");
	await api.openSession(s);
	await api.waitForIdle(s);
	assert.equal(outcome(d, s), "completed");
	// Neither legacy start proves registration or cleanup. The unstarted write can run.
	assert.deepEqual(statuses(d, s), { read: "outcomeUnknown", bash: "outcomeUnknown", write: "completed" });
	assert.equal(readFileSync(join(dirs.project, "done.txt"), "utf8"), "ok");
	assert.equal(existsSync(join(dirs.project, "payments.log")), false, "an unsafe call must not run twice");
	const read = api.history(s).find((e) => e.kind === "toolResult" && e.message?.role === "toolResult" && e.message.toolName === "read")!;
	assert.match(textOf(read.message!.content), /unknown/);
	assert.equal(d.declaration(d.session(s)).continuesAfterRestart, true);
	await d.stop();
});
