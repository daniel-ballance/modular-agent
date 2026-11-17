import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { type Harness, type InputRequest, type Plugin, type PluginApi, textOf, WAITING_NOTE } from "@modular-agent/harness";
import { approval } from "@modular-agent/approval";
import { createAgent } from "../src/index.js";

function fakeUi() {
	const requests: InputRequest[] = [];
	let api!: PluginApi;
	const plugin: Plugin = { name: "fake-ui", setup(a) { api = a; a.provide("interface", { id: "fake", actorId: "user", onInputRequest: (r: InputRequest) => requests.push(r) }); } };
	return {
		plugin, requests,
		answer: (r: InputRequest, value: string) => api.answer(r.sessionId, { requestId: r.id, actorId: "user", value, declined: value !== "allow" }),
		next: async () => {
			for (let i = 0; i < 400 && !requests.length; i++) await new Promise((r) => setTimeout(r, 5));
			assert.ok(requests.length, "no question was asked");
			return requests.shift()!;
		},
	};
}
const dirs = () => ({ project: mkdtempSync(join(tmpdir(), "ma-p-")), home: mkdtempSync(join(tmpdir(), "ma-h-")) });
async function agent(d: { project: string; home: string }, responses: FauxResponseStep[], ui: Plugin): Promise<Harness> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	return createAgent({ ...d, models, model: "faux/faux-1", plugins: [approval({ policy: "ask", waitMs: 30 }), ui] });
}
const pay = () => fauxToolCall("bash", { command: "echo paid > paid.txt" });
const kinds = (h: Harness, s: string, k: string) => h.api("t").history(s).filter((e) => e.kind === k);
const turnData = (h: Harness, s: string) => kinds(h, s, "turnEnd").map((e) => e.data as { outcome: { kind: string }; result: { openToolCalls: string[]; text?: string } });

test("a question outlasts its turn; a late allow runs the call and the agent carries on", async () => {
	const d = dirs();
	const ui = fakeUi();
	const call = pay();
	const h = await agent(d, [fauxAssistantMessage([call], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("Paid.")])], ui.plugin);
	const api = h.api("t");
	const s = await api.startSession();
	await api.input(s, { content: "pay the bill", actorId: "user" });
	const asked = await ui.next();
	await api.waitForIdle(s);

	// The turn ended with the call open: no result, and the question still answerable.
	const [first] = turnData(h, s);
	assert.equal(first.outcome.kind, "completed");
	assert.deepEqual(first.result.openToolCalls, [call.id]);
	assert.equal(kinds(h, s, "toolResult").length, 0);
	assert.equal(kinds(h, s, "turnEnd").length, 1);
	assert.equal(api.openRequests(s).length, 1);
	assert.deepEqual(api.openRequests(s).map((r) => r.id), [asked.id]);
	assert.equal(existsSync(join(d.project, "paid.txt")), false);

	// The late answer lets the call run, in a new turn started by the answer.
	assert.deepEqual(ui.answer(asked, "allow"), { accepted: true });
	assert.equal(ui.answer(asked, "allow").accepted, false, "one answer closes the question");
	await api.waitForIdle(s);
	const results = kinds(h, s, "toolResult");
	assert.equal(results.length, 1, "exactly one result");
	assert.equal(results[0].toolCallId, call.id);
	assert.equal((results[0].data as { status: string }).status, "completed");
	assert.ok(existsSync(join(d.project, "paid.txt")));
	const second = turnData(h, s)[1];
	assert.equal(second.outcome.kind, "completed");
	assert.equal(second.result.text, "Paid.");
	const starts = kinds(h, s, "turnStart").map((e) => (e.data as { startedBy: { kind: string } }).startedBy.kind);
	assert.deepEqual(starts, ["actor", "answer"]);
	await h.stop();
});

test("new input while a call is open sees a stand-in result; the real one arrives later as a late result", async () => {
	const d = dirs();
	const ui = fakeUi();
	const call = pay();
	const seen: string[] = [];
	const h = await agent(d, [
		fauxAssistantMessage([call], { stopReason: "toolUse" }),
		(context) => {
			const i = context.messages.findIndex((m) => m.role === "assistant");
			const next = context.messages[i + 1];
			seen.push(next.role === "toolResult" ? textOf(next.content as never) : `unexpected ${next.role}`);
			return fauxAssistantMessage([fauxText("Noted. Still waiting on the payment.")]);
		},
		(context) => {
			const late = context.messages.find((m) => m.role === "user" && textOf(m.content as never).includes("Late result"));
			seen.push(late ? "late result shown" : "no late result");
			return fauxAssistantMessage([fauxText("The payment went through.")]);
		},
	], ui.plugin);
	const api = h.api("t");
	const s = await api.startSession();
	await api.input(s, { content: "pay the bill", actorId: "user" });
	const asked = await ui.next();
	await api.waitForIdle(s);
	await api.input(s, { content: "also, what's the weather?", actorId: "user" });
	await api.waitForIdle(s);
	assert.equal(seen[0], WAITING_NOTE);
	// the record holds no fake result
	assert.equal(kinds(h, s, "toolResult").length, 0);
	ui.answer(asked, "allow");
	await api.waitForIdle(s);
	assert.equal(seen[1], "late result shown");
	assert.equal(turnData(h, s).at(-1)!.result.text, "The payment went through.");
	await h.stop();
});

test("a late refusal ends the open call as refused, and the agent carries on", async () => {
	const d = dirs();
	const ui = fakeUi();
	const h = await agent(d, [fauxAssistantMessage([pay()], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("Understood, not paying.")])], ui.plugin);
	const api = h.api("t");
	const s = await api.startSession();
	await api.input(s, { content: "pay", actorId: "user" });
	const asked = await ui.next();
	await api.waitForIdle(s);
	ui.answer(asked, "refuse");
	await api.waitForIdle(s);
	const [result] = kinds(h, s, "toolResult");
	assert.equal((result.data as { status: string }).status, "refused");
	assert.equal(existsSync(join(d.project, "paid.txt")), false);
	assert.equal(turnData(h, s).at(-1)!.result.text, "Understood, not paying.");
	await h.stop();
});

test("a question waiting past its turn survives a restart, with a transient Runtime", async () => {
	const d = dirs();
	const first = fakeUi();
	let h = await agent(d, [fauxAssistantMessage([pay()], { stopReason: "toolUse" })], first.plugin);
	let api = h.api("t");
	const s = await api.startSession();
	await api.input(s, { content: "pay", actorId: "user" });
	const asked = await first.next();
	await api.waitForIdle(s);
	await h.stop();

	const ui = fakeUi();
	h = await agent(d, [fauxAssistantMessage([fauxText("Paid after the restart.")])], ui.plugin);
	api = h.api("t");
	await api.openSession(s);
	const again = await ui.next();
	assert.equal(again.id, asked.id);
	assert.deepEqual(ui.answer(again, "allow"), { accepted: true });
	await api.waitForIdle(s);
	assert.ok(existsSync(join(d.project, "paid.txt")));
	assert.equal(turnData(h, s).at(-1)!.result.text, "Paid after the restart.");
	assert.equal(h.declaration(h.session(s)).questionsOutlastTurns, true);
	await h.stop();
});
