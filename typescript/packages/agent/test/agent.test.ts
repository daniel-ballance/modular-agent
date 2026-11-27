import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { type AgentEvent, type Harness, type InputRequest, type OutputPayload, type Plugin, textOf } from "@modular-agent/harness";
import { createAgent } from "../src/index.js";
import { testDirs, testTempDir } from "./fixtures/temp-dir.js";

function setup(t: TestContext, responses: FauxResponseStep[], extra: Plugin[] = [], dirs?: { project: string; home: string }) {
	const project = dirs?.project ?? testTempDir(t, "ma-project-");
	const home = dirs?.home ?? testTempDir(t, "ma-home-");
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

test("a turn that reads a file and answers", async (t) => {
	const { project, make } = setup(t, [
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

test("approval as a plugin: a refusal wins, and with nobody to ask the call is refused", async (t) => {
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
	const { project, make } = setup(t, [
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

test("an Interface answers an approval; a second answer is refused", async (t) => {
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
	const { project, make } = setup(t, [
		fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi > made.txt" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Made it.")]),
	], [ui]);
	const h = await make();
	const api = h.api("test");
	const s = await api.startSession();
	await api.input(s, { content: "make a file", actorId: "user" });
	while (!requests.length) await new Promise((r) => setTimeout(r, 5));
	assert.deepEqual(await harnessApi!.submitAnswer(s, { requestId: requests[0].id, actorId: "user", value: "allow" }), { accepted: true });
	assert.equal((await harnessApi!.submitAnswer(s, { requestId: requests[0].id, actorId: "user", value: "allow" })).accepted, false);
	await api.waitForIdle(s);
	assert.equal(readFileSync(join(project, "made.txt"), "utf8").trim(), "hi");
	await h.stop();
});

test("input with a key is taken once", async (t) => {
	const { make } = setup(t, [fauxAssistantMessage([fauxText("one")]), fauxAssistantMessage([fauxText("two")])]);
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

test("steering joins the running turn; cancelling hands queued input back and leaves jobs running", async (t) => {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	let releaseSlow!: () => void;
	const slow = new Promise<void>((r) => (releaseSlow = r));
	const { make } = setup(t, [
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

test("a job's report enters the session as input and starts a turn", async (t) => {
	const { make } = setup(t, [fauxAssistantMessage([fauxText("Ready")]),
		(context) => fauxAssistantMessage([fauxText(`got: ${JSON.stringify(context.messages.at(-1))}`)])]);
	const h = await make();
	const api = h.api("test");
	const s = await api.startSession();
	await api.input(s, { actorId: "user", content: "Start" });
	await api.waitForIdle(s);
	const job = api.startJob(s, { kind: "dev-server" });
	await job.finish("failed", "server crashed: port in use");
	await api.waitForIdle(s);
	const report = api.history(s).find((e) => e.kind === "input" && e.jobId);
	assert.ok(report);
	const start = api.history(s).find((e) => e.kind === "turnStart" && e.turnId === report.turnId);
	assert.deepEqual((start!.data as { startedBy: unknown }).startedBy, { kind: "job", id: job.id });
	assert.match(lastTurn(h, s).result.text ?? "", /port in use/);
	await h.stop();
});

test("the output gate can hold streamed pieces and redact a secret split across them", async (t) => {
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
	const { faux, make } = setup(t, [], [guard]);
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

test("a context overflow is compacted and retried", async (t) => {
	let calls = 0;
	const env = setup(t, [
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

test("history survives a restart; moving the position is kept; an interrupted turn is repaired", async (t) => {
	const dirs = testDirs(t);
	const first = setup(t, [fauxAssistantMessage([fauxText("A")]), fauxAssistantMessage([fauxText("B")])], [], dirs);
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
	await api.append(s, { kind: "turnStart", writer: "test", modelVisible: false, turnId: "t-crash", actorId: "user",
		data: api.history(s).find(e => e.kind === "turnStart")!.data });
	const call = fauxToolCall("bash", { command: "sleep 100" });
	await api.append(s, { kind: "response", writer: "test", modelVisible: true, turnId: "t-crash", message: { role: "assistant", content: [call as never], stop: "toolUse" } });
	await api.append(s, { kind: "toolStarted", writer: "test", modelVisible: false, turnId: "t-crash", toolCallId: call.id });
	await h.stop();

	h = await setup(t, [], [], dirs).make();
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

test("reopen refuses an interrupted turn without its starter or tool offer", async (t) => {
	const env = setup(t, []);
	const h = await env.make(), api = h.api("test");
	const ids = [];
	for (const key of ["startedBy", "tools"]) {
		const s = await api.startSession();
		await api.input(s, { actorId: "user", content: "publish", when: "propose" });
		const data: Record<string, unknown> = { model: null, tools: [], settings: {}, system: "", startedBy: { kind: "actor", id: "user" } };
		delete data[key];
		await api.append(s, { kind: "turnStart", writer: "test", modelVisible: false, turnId: "incomplete", actorId: "user", data });
		ids.push(s);
	}
	await h.stop();
	const reopened = await env.make();
	try { for (const s of ids) await assert.rejects(reopened.api("test").openSession(s), /incomplete turn snapshot/); }
	finally { await reopened.stop(); }
});

test("erasure removes content from the record and leaves an erasure entry", async (t) => {
	const dirs = testDirs(t);
	const env = setup(t, [fauxAssistantMessage([fauxText("noted")])], [], dirs);
	let h = await env.make();
	let api = h.api("test");
	const s = await api.startSession();
	await api.input(s, { content: "my phone is 555-0100", actorId: "user" });
	await api.waitForIdle(s);
	const input = api.history(s).find((e) => e.kind === "input")!;
	await api.erase(s, [input.id], "user");
	await h.stop();
	h = await setup(t, [], [], dirs).make();
	api = h.api("test");
	await api.openSession(s);
	const all = api.history(s, { all: true });
	assert.ok(!JSON.stringify(all).includes("555-0100"));
	assert.ok(all.some((e) => e.kind === "erasure"));
	await h.stop();
});

test("erasure reaches a summary that copied the erased entry", async (t) => {
	const dirs = testDirs(t);
	let lastContext = "";
	const env = setup(
		t,
		[
			fauxAssistantMessage([fauxText("noted")]),
			fauxAssistantMessage([fauxText("ok")]),
			fauxAssistantMessage([fauxText("Summary: the user's phone is 555-0100.")]),
			(c) => {
				lastContext = JSON.stringify(c.messages);
				return fauxAssistantMessage([fauxText("answered")]);
			},
		],
		[],
		dirs,
	);
	let h = await env.make();
	let api = h.api("test");
	const s = await api.startSession();
	await api.input(s, { content: "my phone is 555-0100", actorId: "user" });
	await api.waitForIdle(s);
	await api.input(s, { content: "and I like tea", actorId: "user" });
	await api.waitForIdle(s);
	assert.equal((await api.input(s, { content: "/compact", actorId: "user" })).output, "Compacted.");
	const summary = api.history(s).find((e) => e.kind === "summary")!;
	const input = api.history(s).find((e) => e.kind === "input")!;
	assert.ok(summary.sources?.includes(input.id), "the summary names what it copied");
	await api.erase(s, [input.id], "user");
	await api.input(s, { content: "what do you know?", actorId: "user" });
	await api.waitForIdle(s);
	assert.ok(!lastContext.includes("555-0100"), "the model no longer sees the erased number, from the input or the summary");
	assert.ok(lastContext.includes("I like tea"), "what remains is shown in full instead of the erased summary");
	await h.stop();
	h = await setup(t, [], [], dirs).make();
	api = h.api("test");
	await api.openSession(s);
	assert.ok(!JSON.stringify(api.history(s, { all: true })).includes("555-0100"), "the store has no copy left");
	await h.stop();
});

test("a session started only to look leaves nothing behind", async (t) => {
	const dirs = testDirs(t);
	const h = await setup(t, [fauxAssistantMessage([fauxText("hi")])], [], dirs).make();
	const api = h.api("test");
	// What a host does to read the model list: start a session, read and change its settings, close it.
	const look = await api.startSession({ settings: { cwd: dirs.project } });
	await api.setSetting(look, "thinking", "low", "user");
	await api.closeSession(look);
	assert.deepEqual(await api.listSessions(), []);
	const used = await api.startSession();
	await api.input(used, { content: "hello", actorId: "user" });
	await api.waitForIdle(used);
	assert.deepEqual((await api.listSessions()).map((x) => x.id), [used]);
	await h.stop();
});

test("parallel results are recorded as they finish and reach the model in call order", async (t) => {
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
		t,
		[fauxAssistantMessage([fauxToolCall("first", {}), fauxToolCall("second", {})], { stopReason: "toolUse" }), (context) => {
			const names = context.messages.flatMap((m) => m.role === "toolResult" ? [m.toolName] : []);
			return fauxAssistantMessage([fauxText(names.join(", "))]);
		}],
		[together],
	);
	const h = await make();
	const api = h.api("test");
	const s = await api.startSession();
	await api.input(s, { content: "go", actorId: "user" });
	await api.waitForIdle(s);
	const results = api.history(s).filter((e) => e.kind === "toolResult").map((e) => textOf(e.message!.content));
	assert.deepEqual(results, ["second done", "first done"]);
	assert.equal(lastTurn(h, s).result.text, "first, second");
	assert.equal(lastTurn(h, s).outcome.kind, "completed");
	await h.stop();
});
