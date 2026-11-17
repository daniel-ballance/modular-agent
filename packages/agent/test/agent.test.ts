import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { type AgentEvent, type Harness, type InputRequest, type OutputPayload, type Plugin, textOf } from "@modular-agent/harness";
import { createAgent } from "../src/index.js";

function setup(responses: FauxResponseStep[], extra: Plugin[] = [], dirs?: { project: string; home: string }) {
	const project = dirs?.project ?? mkdtempSync(join(tmpdir(), "ma-project-"));
	const home = dirs?.home ?? mkdtempSync(join(tmpdir(), "ma-home-"));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	return { project, home, faux, models, make: () => createAgent({ project, home, models, model: "faux/faux-1", plugins: extra }) };
}

function lastTurn(h: Harness, sessionId: string) {
	const ends = h.api("test").history(sessionId).filter((e) => e.kind === "turnEnd");
	return ends[ends.length - 1]?.data as { outcome: { kind: string }; result: { text?: string } };
}

test("a turn that reads a file and answers", async () => {
	const { project, make } = setup([
		fauxAssistantMessage([fauxToolCall("read", { path: "config.json" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("It sets port to 8080.")]),
	]);
	writeFileSync(join(project, "config.json"), '{"port":8080}');
	const h = await make();
	const api = h.api("test");
	const s = await api.startSession();
	await api.input(s, { content: "Read config.json and summarize it.", actorId: "user" });
	await api.waitForIdle(s);
	const turn = lastTurn(h, s);
	assert.equal(turn.outcome.kind, "completed");
	assert.equal(turn.result.text, "It sets port to 8080.");
	const result = api.history(s).find((e) => e.kind === "toolResult");
	assert.ok(result && textOf(result.message!.content).includes("8080"));
	assert.equal((result!.data as { status: string }).status, "completed");
	assert.ok(api.history(s).every((e) => e.sessionId === s));
	await h.stop();
});

test("approval as a plugin: a refusal wins, and with nobody to ask the call is refused", async () => {
	const approval: Plugin = {
		name: "approval",
		setup(api) {
			api.on("tool.before", async (p: { sessionId: string; call: { name: string }; definition?: { hints?: { destructive?: boolean } } }) => {
				if (!p.definition?.hints?.destructive) return undefined;
				const answer = await api.ask(p.sessionId, { kind: "approval", question: `Allow ${p.call.name}?` });
				return answer.declined ? { refuse: answer.reason ?? "Not approved" } : undefined;
			});
		},
	};
	const { project, make } = setup([
		fauxAssistantMessage([fauxToolCall("bash", { command: "touch made.txt" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Done.")]),
	], [approval]);
	const h = await make();
	const api = h.api("test");
	const s = await api.startSession();
	await api.input(s, { content: "make a file", actorId: "user" });
	await api.waitForIdle(s);
	const result = api.history(s).find((e) => e.kind === "toolResult")!;
	assert.equal((result.data as { status: string }).status, "refused");
	assert.match(textOf(result.message!.content), /No one present can answer/);
	assert.throws(() => readFileSync(join(project, "made.txt")));
	await h.stop();
});

test("an Interface answers an approval; a second answer is refused", async () => {
	const requests: InputRequest[] = [];
	let harnessApi: ReturnType<Harness["api"]> | undefined;
	const ui: Plugin = {
		name: "fake-ui",
		setup(api) {
			harnessApi = api;
			api.provide("interface", { id: "fake", actorId: "user", onInputRequest: (r: InputRequest) => requests.push(r) });
			api.on("tool.before", async (p: { sessionId: string; call: { name: string } }) => {
				if (p.call.name !== "bash") return undefined;
				const answer = await api.ask(p.sessionId, { kind: "approval", question: "Allow bash?" });
				return answer.declined ? { refuse: "Not approved" } : undefined;
			});
		},
	};
	const { project, make } = setup([
		fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi > made.txt" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Made it.")]),
	], [ui]);
	const h = await make();
	const api = h.api("test");
	const s = await api.startSession();
	await api.input(s, { content: "make a file", actorId: "user" });
	while (!requests.length) await new Promise((r) => setTimeout(r, 5));
	assert.deepEqual(harnessApi!.answer(s, { requestId: requests[0].id, actorId: "user", value: "allow" }), { accepted: true });
	assert.equal(harnessApi!.answer(s, { requestId: requests[0].id, actorId: "user", value: "allow" }).accepted, false);
	await api.waitForIdle(s);
	assert.equal(readFileSync(join(project, "made.txt"), "utf8").trim(), "hi");
	await h.stop();
});

test("input with a key is taken once", async () => {
	const { make } = setup([fauxAssistantMessage([fauxText("one")]), fauxAssistantMessage([fauxText("two")])]);
	const h = await make();
	const api = h.api("test");
	const s = await api.startSession();
	const first = await api.input(s, { content: "hello", actorId: "user", key: "k1" });
	const again = await api.input(s, { content: "hello", actorId: "user", key: "k1" });
	await api.waitForIdle(s);
	assert.equal(again.duplicate, true);
	assert.equal(again.inputId, first.inputId);
	assert.equal(api.history(s).filter((e) => e.kind === "input").length, 1);
	await h.stop();
});

test("steering joins the running turn; cancelling hands queued input back and leaves jobs running", async () => {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	let releaseSlow!: () => void;
	const slow = new Promise<void>((r) => (releaseSlow = r));
	const { make } = setup([
		async () => {
			await gate;
			return fauxAssistantMessage([fauxToolCall("read", { path: "nope.txt" })], { stopReason: "toolUse" });
		},
		(context) => fauxAssistantMessage([fauxText(`saw ${context.messages.filter((m) => m.role === "user").length} user messages`)]),
		async () => {
			await slow;
			return fauxAssistantMessage([fauxText("slow answer")]);
		},
	]);
	const h = await make();
	const api = h.api("test");
	const s = await api.startSession();
	await api.input(s, { content: "start", actorId: "user" });
	const steer = await api.input(s, { content: "also this", actorId: "user", when: "steer" });
	assert.equal(steer.taken, "inTurn");
	release();
	await api.waitForIdle(s);
	assert.match(lastTurn(h, s).result.text ?? "", /saw 2 user messages/);

	const job = api.startJob(s, { kind: "watcher" });
	await api.input(s, { content: "slow one", actorId: "user" });
	const queued = await api.input(s, { content: "after that", actorId: "user", when: "after" });
	assert.equal(queued.taken, "after");
	const cancelling = api.cancel(s);
	releaseSlow();
	const handedBack = await cancelling;
	assert.deepEqual(handedBack.map((q) => textOf(q.content)), ["after that"]);
	assert.equal(lastTurn(h, s).outcome.kind, "cancelled");
	assert.equal(api.jobs(s).find((j) => j.id === job.id)?.state, "running");
	await h.stop();
});

test("a job's report enters the session as input and starts a turn", async () => {
	const { make } = setup([(context) => fauxAssistantMessage([fauxText(`got: ${JSON.stringify(context.messages.at(-1))}`)])]);
	const h = await make();
	const api = h.api("test");
	const s = await api.startSession();
	const job = api.startJob(s, { kind: "dev-server" });
	await job.finish("failed", "server crashed: port in use");
	await api.waitForIdle(s);
	const report = api.history(s).find((e) => e.kind === "jobReport");
	assert.ok(report);
	const start = api.history(s).find((e) => e.kind === "turnStart");
	assert.deepEqual((start!.data as { startedBy: unknown }).startedBy, { kind: "job", id: job.id });
	assert.match(lastTurn(h, s).result.text ?? "", /port in use/);
	await h.stop();
});

test("the output gate can hold streamed pieces and redact a secret split across them", async () => {
	const guard: Plugin = {
		name: "guardrail",
		setup(api) {
			api.on("output", (p: OutputPayload) => {
				const streamed = p.events.filter((e) => e.type === "model.output" && e.data?.type === "text");
				const joined = streamed.map((e) => e.data.delta).join("");
				// Hold while the text so far could be the start of an account number.
				if (!p.final && /(A|AC|ACC|ACCT\d*)$/.test(joined)) return { action: "hold" };
				if (!/ACCT\d+/.test(joined)) return undefined;
				const redacted = joined.replace(/ACCT\d+/g, "[redacted]");
				const others = p.events.filter((e) => !streamed.includes(e));
				return { action: "pass", events: [{ ...streamed[0], data: { type: "text", delta: redacted } }, ...others] };
			});
		},
	};
	const { faux, make } = setup([], [guard]);
	faux.setResponses([fauxAssistantMessage([fauxText("Your number is ACCT44918821 ok")])]);
	const h = await make();
	const api = h.api("test");
	const s = await api.startSession();
	const seen: AgentEvent[] = [];
	api.follow(s, { recipient: "viewer" }, (e) => seen.push(e));
	await api.input(s, { content: "number?", actorId: "user" });
	await api.waitForIdle(s);
	await new Promise((r) => setTimeout(r, 20));
	const shown = seen.filter((e) => e.type === "model.output").map((e) => e.data.delta).join("");
	assert.ok(!/ACCT\d/.test(shown), `leaked: ${shown}`);
	assert.match(shown, /\[redacted\]/);
	// the record keeps everything intact
	const response = api.history(s).find((e) => e.kind === "response")!;
	assert.match(textOf(response.message!.content), /ACCT44918821/);
	await h.stop();
});

test("a context overflow is compacted and retried", async () => {
	let calls = 0;
	const env = setup([
		fauxAssistantMessage([fauxText("first answer")]),
		fauxAssistantMessage([fauxText("second answer")]),
		() => {
			calls++;
			return fauxAssistantMessage([], { stopReason: "error", errorMessage: "prompt is too long: 300000 tokens > 200000 maximum" });
		},
		fauxAssistantMessage([fauxText("summary of earlier work")]),
		(context) => fauxAssistantMessage([fauxText(`after compaction, ${context.messages.length} messages`)]),
	]);
	const h = await env.make();
	const api = h.api("test");
	const s = await api.startSession();
	for (const t of ["one", "two", "three"]) {
		await api.input(s, { content: t, actorId: "user" });
		await api.waitForIdle(s);
	}
	assert.equal(calls, 1);
	assert.ok(api.history(s).some((e) => e.kind === "summary"));
	assert.match(lastTurn(h, s).result.text ?? "", /after compaction/);
	await h.stop();
});

test("history survives a restart; moving the position is kept; an interrupted turn is repaired", async () => {
	const dirs = { project: mkdtempSync(join(tmpdir(), "ma-p-")), home: mkdtempSync(join(tmpdir(), "ma-h-")) };
	const first = setup([fauxAssistantMessage([fauxText("A")]), fauxAssistantMessage([fauxText("B")])], [], dirs);
	let h = await first.make();
	let api = h.api("test");
	const s = await api.startSession();
	await api.input(s, { content: "a", actorId: "user" });
	await api.waitForIdle(s);
	const afterA = api.history(s).at(-1)!.id;
	await api.input(s, { content: "b", actorId: "user" });
	await api.waitForIdle(s);
	await api.moveTo(s, afterA);
	// Simulate a crash in a later turn: a tool call started but never answered.
	await api.append(s, { kind: "turnStart", writer: "test", modelVisible: false, turnId: "t-crash" });
	const call = fauxToolCall("bash", { command: "sleep 100" });
	await api.append(s, { kind: "response", writer: "test", modelVisible: true, turnId: "t-crash", message: { role: "assistant", content: [call as never], stop: "toolUse" } });
	await api.append(s, { kind: "toolStarted", writer: "test", modelVisible: false, turnId: "t-crash", toolCallId: call.id });
	await h.stop();

	h = await setup([], [], dirs).make();
	api = h.api("test");
	await api.openSession(s);
	await api.waitForIdle(s);
	const branch = api.history(s);
	const repaired = branch.find((e) => e.kind === "toolResult" && e.toolCallId === call.id);
	assert.equal((repaired?.data as { status: string }).status, "outcomeUnknown");
	assert.ok(branch.some((e) => e.kind === "turnEnd" && e.turnId === "t-crash"));
	// the move back was recorded, so the B turn is off the current branch
	assert.ok(!branch.some((e) => e.message?.role === "user" && textOf(e.message.content) === "b"));
	await h.stop();
});

test("erasure removes content from the record and leaves an erasure entry", async () => {
	const dirs = { project: mkdtempSync(join(tmpdir(), "ma-p-")), home: mkdtempSync(join(tmpdir(), "ma-h-")) };
	const env = setup([fauxAssistantMessage([fauxText("noted")])], [], dirs);
	let h = await env.make();
	let api = h.api("test");
	const s = await api.startSession();
	await api.input(s, { content: "my phone is 555-0100", actorId: "user" });
	await api.waitForIdle(s);
	const input = api.history(s).find((e) => e.kind === "input")!;
	await api.erase(s, [input.id], "user");
	await h.stop();
	h = await setup([], [], dirs).make();
	api = h.api("test");
	await api.openSession(s);
	const all = api.history(s, { all: true });
	assert.ok(!JSON.stringify(all).includes("555-0100"));
	assert.ok(all.some((e) => e.kind === "erasure"));
	await h.stop();
});

test("tool calls that may run together do, and their results are recorded in the order the model asked", async () => {
	const started = new Set<string>();
	const waitFor = async (name: string) => {
		for (let i = 0; i < 200 && !started.has(name); i++) await new Promise((r) => setTimeout(r, 2));
		if (!started.has(name)) throw new Error(`${name} never started: the calls ran one at a time`);
	};
	const together: Plugin = {
		name: "together",
		setup(api) {
			api.provide("tool-source", {
				id: "together",
				tools: () => ["first", "second"].map((name) => ({ name, description: name, parameters: { type: "object" }, parallel: true })),
				run: async (call: { name: string }) => {
					started.add(call.name);
					await waitFor(call.name === "first" ? "second" : "first");
					if (call.name === "first") await new Promise((r) => setTimeout(r, 20)); // first finishes last
					return { status: "completed", content: [{ type: "text", text: `${call.name} done` }] };
				},
			});
		},
	};
	const { make } = setup(
		[fauxAssistantMessage([fauxToolCall("first", {}), fauxToolCall("second", {})], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("both done")])],
		[together],
	);
	const h = await make();
	const api = h.api("test");
	const s = await api.startSession();
	await api.input(s, { content: "go", actorId: "user" });
	await api.waitForIdle(s);
	const results = api.history(s).filter((e) => e.kind === "toolResult").map((e) => textOf(e.message!.content));
	assert.deepEqual(results, ["first done", "second done"]);
	assert.equal(lastTurn(h, s).outcome.kind, "completed");
	await h.stop();
});
