import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { textOf, type Harness } from "@modular-agent/harness";
import { durableRuntime } from "@modular-agent/runtime-durable";
import { createAgent } from "../src/index.js";

async function agent(dirs: { project: string; home: string }, responses: FauxResponseStep[], durable: boolean): Promise<Harness> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	return createAgent({ ...dirs, models, model: "faux/faux-1", plugins: durable ? [durableRuntime()] : [] });
}

/** A session whose process stopped mid-step: read and bash had started, write had not. */
async function crashedSession() {
	const dirs = { project: mkdtempSync(join(tmpdir(), "ma-p-")), home: mkdtempSync(join(tmpdir(), "ma-h-")) };
	writeFileSync(join(dirs.project, "notes.txt"), "remember the milk");
	const h = await agent(dirs, [], false);
	const api = h.api("test");
	const s = await api.startSession();
	await api.append(s, { kind: "turnStart", writer: "test", modelVisible: false, turnId: "t1", data: { startedBy: { kind: "actor", id: "user" } } });
	await api.append(s, { kind: "input", writer: "test", modelVisible: true, turnId: "t1", message: { role: "user", content: [{ type: "text", text: "do three things" }] } });
	const calls = [fauxToolCall("read", { path: "notes.txt" }), fauxToolCall("bash", { command: "echo charged >> payments.log" }), fauxToolCall("write", { path: "done.txt", content: "ok" })];
	await api.append(s, { kind: "response", writer: "test", modelVisible: true, turnId: "t1", stepId: "step1", message: { role: "assistant", content: calls as never, stop: "toolUse" } });
	await api.append(s, { kind: "toolStarted", writer: "test", modelVisible: false, turnId: "t1", toolCallId: calls[0].id });
	await api.append(s, { kind: "toolStarted", writer: "test", modelVisible: false, turnId: "t1", toolCallId: calls[1].id });
	await h.stop();
	return { dirs, s, calls };
}

function statuses(h: Harness, s: string) {
	return Object.fromEntries(h.api("test").history(s).filter((e) => e.kind === "toolResult").map((e) => [e.message?.role === "toolResult" ? e.message.toolName : "?", (e.data as { status: string }).status]));
}
function outcome(h: Harness, s: string) {
	return (h.api("test").history(s).filter((e) => e.kind === "turnEnd").at(-1)!.data as { outcome: { kind: string } }).outcome.kind;
}

test("swap test: the same crashed session, reopened with a transient and then a durable Runtime", async () => {
	const { dirs, s } = await crashedSession();
	const copy = { project: dirs.project, home: mkdtempSync(join(tmpdir(), "ma-h2-")) };
	cpSync(dirs.home, copy.home, { recursive: true });

	// Transient: the turn ends as failed; started calls have an unknown outcome, the rest never started.
	const t = await agent(dirs, [], false);
	await t.api("test").openSession(s);
	assert.equal(outcome(t, s), "failed");
	assert.deepEqual(statuses(t, s), { read: "outcomeUnknown", bash: "outcomeUnknown", write: "notStarted" });
	assert.equal(existsSync(join(dirs.project, "done.txt")), false);
	await t.stop();

	// Durable: the same plugins, but a different Runtime. The turn carries on.
	const d = await agent(copy, [(context) => fauxAssistantMessage([fauxText(`Finished. Saw ${context.messages.filter((m) => m.role === "toolResult").length} results.`)])], true);
	const api = d.api("test");
	await api.openSession(s);
	assert.equal(outcome(d, s), "completed");
	// read is safe to repeat, so it ran again; bash is not, so its outcome is unknown; write never started, so it ran.
	assert.deepEqual(statuses(d, s), { read: "completed", bash: "outcomeUnknown", write: "completed" });
	assert.equal(readFileSync(join(dirs.project, "done.txt"), "utf8"), "ok");
	assert.equal(existsSync(join(dirs.project, "payments.log")), false, "an unsafe call must not run twice");
	const read = api.history(s).find((e) => e.kind === "toolResult" && e.message?.role === "toolResult" && e.message.toolName === "read")!;
	assert.match(textOf(read.message!.content), /milk/);
	assert.equal(d.declaration(d.session(s)).continuesAfterRestart, true);
	await d.stop();
});
