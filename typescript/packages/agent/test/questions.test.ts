import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { ALL_AUTHORITY, type Actor, type AgentEvent, type Harness, type InputRequest, type Plugin, type PluginApi } from "@modular-agent/harness";
import { approval, type ApprovalPolicy } from "@modular-agent/approval";
import { durableRuntime } from "@modular-agent/runtime-durable";
import { createAgent } from "../src/index.js";

/** An Interface that collects questions and answers them when told to. */
function fakeUi(actorId = "user") {
	const requests: InputRequest[] = [];
	let api!: PluginApi;
	const plugin: Plugin = {
		name: `fake-ui:${actorId}`,
		setup(a) {
			api = a;
			a.provide("interface", { id: "fake", actorId, onInputRequest: (r: InputRequest) => requests.push(r) });
		},
	};
	return {
		plugin,
		requests,
		answer: (r: InputRequest, value: string, as = actorId) => api.submitAnswer(r.sessionId, { requestId: r.id, actorId: as, value, declined: value !== "allow" }),
		next: async () => {
			for (let i = 0; i < 400 && !requests.length; i++) await new Promise((r) => setTimeout(r, 5));
			assert.ok(requests.length, "no question was asked");
			return requests.shift()!;
		},
	};
}

function dirs() {
	return { project: mkdtempSync(join(tmpdir(), "ma-p-")), home: mkdtempSync(join(tmpdir(), "ma-h-")) };
}

async function agent(d: { project: string; home: string }, responses: FauxResponseStep[], plugins: Plugin[], policy: ApprovalPolicy = "ask"): Promise<Harness> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	return createAgent({ ...d, models, model: "faux/faux-1", plugins: [approval({ policy }), ...plugins] });
}

const writeCall = () => fauxToolCall("bash", { command: "echo paid > paid.txt" });
const kinds = (h: Harness, s: string, kind: string) => h.api("t").history(s).filter((e) => e.kind === kind);
const outcome = (h: Harness, s: string) => (kinds(h, s, "turnEnd").at(-1)!.data as { outcome: { kind: string } }).outcome.kind;
const status = (h: Harness, s: string) => (kinds(h, s, "toolResult").at(-1)!.data as { status: string }).status;

/** Start a turn that asks for approval, and stop answering: the process "stops" while the question is open. */
async function crashWhileAsking(d: { project: string; home: string }) {
	const ui = fakeUi();
	const h = await agent(d, [fauxAssistantMessage([writeCall()], { stopReason: "toolUse" })], [ui.plugin]);
	const api = h.api("t");
	const s = await api.startSession();
	await api.input(s, { content: "pay the bill", actorId: "user" });
	const asked = await ui.next();
	// The process stops here. The harness is abandoned without a clean shutdown.
	abandoned.push(h);
	return { s, asked, abandoned: h };
}
/** A real crash would end the abandoned harnesses' plugin processes too. Do that once the tests are done. */
const abandoned: Harness[] = [];
after(() => Promise.all(abandoned.map((h) => h.stop().catch(() => undefined))));

test("durable: a question open when the process stopped is reopened, and the answer lets the call run", async () => {
	const d = dirs();
	const { s, asked, abandoned } = await crashWhileAsking(d);
	await abandoned.stop();
	const ui = fakeUi();
	const h = await agent(d, [fauxAssistantMessage([fauxText("Paid.")])], [durableRuntime(), ui.plugin]);
	const api = h.api("t");
	await api.openSession(s);
	const again = await ui.next();
	assert.equal(again.id, asked.id, "the same question, not a new one");
	assert.equal(kinds(h, s, "inputRequest").length, 1);
	assert.deepEqual(await ui.answer(again, "allow"), { accepted: true });
	await api.waitForIdle(s);
	assert.equal(outcome(h, s), "completed");
	assert.equal(status(h, s), "completed");
	assert.equal(readFileSync(join(d.project, "paid.txt"), "utf8").trim(), "paid");
	assert.equal(h.declaration(h.session(s)).waitingThroughRestart, true);
	await h.stop();
});

test("durable: an answer given before the process stopped is not asked again", async () => {
	const d = dirs();
	const { s, asked, abandoned } = await crashWhileAsking(d);
	// Record the answer as the first process would have, then "crash" before the tool started.
	const a = abandoned.api("t");
	await a.append(s, { kind: "inputAnswer", writer: "harness", modelVisible: false, actorId: "user", data: { requestId: asked.id, actorId: "user", value: "allow" } });
	await abandoned.stop();
	const ui = fakeUi();
	const h = await agent(d, [fauxAssistantMessage([fauxText("Paid.")])], [durableRuntime(), ui.plugin]);
	const api = h.api("t");
	const events: AgentEvent[] = [];
	api.onEvent((e) => events.push(e), { raw: true });
	await api.openSession(s);
	await api.waitForIdle(s);
	assert.equal(ui.requests.length, 0, "no question was asked again");
	assert.ok(events.some((e) => e.type === "input.request.reused"));
	assert.equal(outcome(h, s), "completed");
	assert.ok(existsSync(join(d.project, "paid.txt")));
	await h.stop();
});

test("durable: a recorded allow from someone who may no longer answer is not reused", async () => {
	const d = dirs();
	const { s, asked, abandoned } = await crashWhileAsking(d);
	await abandoned.api("t").append(s, { kind: "inputAnswer", writer: "harness", modelVisible: false, actorId: "alice", data: { requestId: asked.id, actorId: "alice", value: "allow" } });
	await abandoned.stop();
	const ui = fakeUi();
	const h = await agent(d, [fauxAssistantMessage([fauxText("Not paid.")])], [durableRuntime(), ui.plugin]);
	const api = h.api("t");
	await api.openSession(s); // alice is not part of the reopened session
	const again = await ui.next();
	await ui.answer(again, "refuse");
	await api.waitForIdle(s);
	assert.equal(status(h, s), "refused");
	assert.equal(existsSync(join(d.project, "paid.txt")), false);
	await h.stop();
});

test("transient: a question open when the process stopped is recorded as no longer answerable", async () => {
	const d = dirs();
	const { s, asked, abandoned } = await crashWhileAsking(d);
	await abandoned.stop();
	const ui = fakeUi();
	const h = await agent(d, [], [ui.plugin]);
	const api = h.api("t");
	await api.openSession(s);
	await api.waitForIdle(s);
	assert.equal(ui.requests.length, 0);
	const closed = kinds(h, s, "inputAnswer");
	assert.equal(closed.length, 1);
	assert.deepEqual(closed[0].data, { requestId: asked.id, reason: "noLongerAnswerable", declined: true });
	assert.equal(status(h, s), "notStarted");
	assert.equal(outcome(h, s), "failed");
	assert.equal(h.declaration(h.session(s)).waitingThroughRestart, false);
	await h.stop();
});

test("approval policy never refuses even read-only tools without asking", async () => {
	const d = dirs();
	const ui = fakeUi();
	const h = await agent(d, [
		fauxAssistantMessage([fauxToolCall("read", { path: "nothing.txt" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([writeCall()], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("ok")]),
	], [ui.plugin], "never");
	const api = h.api("t");
	const s = await api.startSession();
	await api.input(s, { content: "go", actorId: "user" });
	await api.waitForIdle(s);
	const results = kinds(h, s, "toolResult").map((e) => (e.data as { status: string }).status);
	assert.deepEqual(results, ["refused", "refused"]);
	assert.equal(ui.requests.length, 0);
	await h.stop();
});

test("a viewer can see a question but only an actor with authority can answer it", async () => {
	const d = dirs();
	const owner = fakeUi("user");
	const viewer = fakeUi("viewer");
	const h = await agent(d, [fauxAssistantMessage([writeCall()], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("done")])], [owner.plugin, viewer.plugin]);
	const api = h.api("t");
	const s = await api.startSession();
	const v: Actor = { id: "viewer", kind: "user", authority: ["watch"] };
	await api.join(s, v, "user");
	await assert.rejects(api.join(s, { id: "guest", kind: "user", authority: ["erase"] }, "viewer"), /may not grant/);
	await api.input(s, { content: "pay", actorId: "user" });
	const seen = await viewer.next();
	assert.equal((await viewer.answer(seen, "allow", "viewer")).accepted, false);
	const asked = await owner.next();
	assert.equal((await owner.answer(asked, "allow")).accepted, true);
	assert.equal((await owner.answer(asked, "allow")).accepted, false, "one answer closes the request");
	await api.waitForIdle(s);
	assert.equal(status(h, s), "completed");
	void ALL_AUTHORITY;
	await h.stop();
});
