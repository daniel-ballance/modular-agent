import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { type CredentialStore, type Harness, type InputRequest, type Plugin, type PluginApi, textOf } from "@modular-agent/harness";
import { questionTool } from "@modular-agent/tools-question";
import { createAgent } from "../src/index.js";

function fakeUi() {
	const requests: InputRequest[] = [];
	let api!: PluginApi;
	const plugin: Plugin = { name: "fake-ui", setup(a) { api = a; a.provide("interface", { id: "fake", actorId: "user", onInputRequest: (r: InputRequest) => requests.push(r) }); } };
	return {
		plugin, requests,
		answer: (r: InputRequest, value: string) => api.submitAnswer(r.sessionId, { requestId: r.id, actorId: "user", value }),
		next: async () => {
			for (let i = 0; i < 400 && !requests.length; i++) await new Promise((r) => setTimeout(r, 5));
			assert.ok(requests.length, "no question was asked");
			return requests.shift()!;
		},
	};
}
const dirs = () => ({ project: mkdtempSync(join(tmpdir(), "ma-p-")), home: mkdtempSync(join(tmpdir(), "ma-h-")) });
async function agent(d: { project: string; home: string }, responses: FauxResponseStep[], ui: Plugin, waitMs?: number): Promise<Harness> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	return createAgent({ ...d, models, model: "faux/faux-1", plugins: [questionTool({ waitMs }), ui] });
}
const kinds = (h: Harness, s: string, k: string) => h.api("t").history(s).filter((e) => e.kind === k);
const lastText = (h: Harness, s: string) => (kinds(h, s, "turnEnd").at(-1)!.data as { result: { text?: string } }).result.text;
const answerSeen = (context: { messages: { role: string; content: unknown }[] }) => {
	const r = context.messages.filter((m) => m.role === "toolResult").at(-1);
	return r ? textOf(r.content as never) : "none";
};

test("a tool's own question answered within the turn", async () => {
	const ui = fakeUi();
	const h = await agent(dirs(), [
		fauxAssistantMessage([fauxToolCall("ask_user", { question: "Which database?", options: ["postgres", "sqlite"] })], { stopReason: "toolUse" }),
		(context) => fauxAssistantMessage([fauxText(`Using: ${answerSeen(context)}`)]),
	], ui.plugin);
	const api = h.api("t");
	const s = await api.startSession();
	await api.input(s, { content: "set up a database", actorId: "user" });
	const q = await ui.next();
	assert.deepEqual(q.options, ["postgres", "sqlite"]);
	await ui.answer(q, "sqlite");
	await api.waitForIdle(s);
	assert.match(lastText(h, s) ?? "", /The user answered: sqlite/);
	await h.stop();
});

test("a tool's own question outlasts its turn; the tool runs again and finds the late answer, even after a restart", async () => {
	const d = dirs();
	const first = fakeUi();
	const call = fauxToolCall("ask_user", { question: "Which database?" });
	let h = await agent(d, [fauxAssistantMessage([call], { stopReason: "toolUse" })], first.plugin, 30);
	let api = h.api("t");
	const s = await api.startSession();
	await api.input(s, { content: "set up a database", actorId: "user" });
	const asked = await first.next();
	await api.waitForIdle(s);
	const [end] = kinds(h, s, "turnEnd").map((e) => e.data as { result: { openToolCalls: string[] } });
	assert.deepEqual(end.result.openToolCalls, [call.id]);
	assert.equal(kinds(h, s, "toolResult").length, 0);
	await h.stop();

	const ui = fakeUi();
	h = await agent(d, [(context) => fauxAssistantMessage([fauxText(`Using: ${answerSeen(context)}`)])], ui.plugin, 30);
	api = h.api("t");
	await api.openSession(s);
	const again = await ui.next();
	assert.equal(again.id, asked.id);
	assert.deepEqual(await ui.answer(again, "postgres"), { accepted: true });
	await api.waitForIdle(s);
	const results = kinds(h, s, "toolResult");
	assert.equal(results.length, 1, "exactly one result");
	assert.match(textOf(results[0].message!.content), /postgres/);
	assert.equal(kinds(h, s, "inputRequest").length, 1, "the rerun found the recorded answer and did not ask again");
	assert.match(lastText(h, s) ?? "", /The user answered: postgres/);
	await h.stop();
});

test("a tool that can't wait outside a turn fails instead of staying open", async () => {
	const ui = fakeUi();
	const h = await agent(dirs(), [], ui.plugin, 10);
	const api = h.api("t");
	const s = await api.startSession();
	await api.input(s, { actorId: "user", when: "propose", content: "Keep this session" });
	// ask_user may only be called by the model, so a UI call is refused before it runs.
	const refused = await api.callTool(s, { name: "ask_user", input: { question: "?" }, startedBy: "ui" });
	assert.equal(refused.status, "refused");
	await h.stop();
});

test("a secret goes to the credential store and nowhere else", async () => {
	const d = dirs();
	const ui = fakeUi();
	let context = "";
	const events: unknown[] = [];
	const h = await agent(d, [
		fauxAssistantMessage([fauxToolCall("ask_user", { question: "Your GitHub token?", secret: "github" })], { stopReason: "toolUse" }),
		(c) => {
			context = JSON.stringify(c.messages);
			return fauxAssistantMessage([fauxText(`Seen: ${answerSeen(c)}`)]);
		},
	], ui.plugin);
	const api = h.api("t");
	const s = await api.startSession();
	api.follow(s, { recipient: "test", raw: true }, (e) => events.push(e));
	await api.input(s, { content: "set up github", actorId: "user" });
	const q = await ui.next();
	assert.equal(q.kind, "secret");
	const store = h.use<CredentialStore>("credential-store")!, stage = store.stage;
	store.stage = async () => undefined;
	try { assert.deepEqual(await ui.answer(q, "not-staged"), { accepted: false }); } finally { store.stage = stage; }
	assert.equal(api.openRequests(s)[0]?.id, q.id);
	assert.equal((await ui.answer(q, "ghp_SECRET123")).accepted, true);
	await api.waitForIdle(s);
	assert.match(lastText(h, s)!, /kept as "secret:github"; its value is not shown to you/);
	assert.ok(!context.includes("ghp_SECRET123"), "the model never sees it");
	assert.ok(!JSON.stringify(events).includes("ghp_SECRET123"), "no event carries it");
	await h.stop();
	const files = readdirSync(d.home, { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl"));
	assert.ok(files.length && files.every((f) => !readFileSync(join(d.home, f), "utf8").includes("ghp_SECRET123")), "the history never records it");
	const auth = JSON.parse(readFileSync(join(d.home, "auth.json"), "utf8"));
	assert.deepEqual(auth["secret:github"], { type: "api_key", key: "ghp_SECRET123" }, "the credential store keeps it");
});
