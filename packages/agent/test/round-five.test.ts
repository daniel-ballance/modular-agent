import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { ALL_AUTHORITY, text, type EntryDraft, type HistoryStore, type ModelRequest, type Plugin, type Provider } from "@modular-agent/harness";
import { durableRuntime } from "@modular-agent/runtime-durable";
import { createAgent, conformanceProvider } from "../src/index.js";

function folders(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "ma-r5-"));
	t.after(() => rmSync(root, { force: true, recursive: true }));
	return { project: root, home: join(root, "agent-state") };
}

async function open(t: TestContext, dirs = folders(t), plugins: Plugin[] = []) {
	const harness = await createAgent({ ...dirs, model: "conformance/echo", plugins: [conformanceProvider(), ...plugins] });
	t.after(() => harness.stop());
	return { api: harness.api("test"), store: harness.use<HistoryStore>("history-store")!, harness, dirs };
}

const model = { provider: "conformance", id: "echo" };
const draft = (kind: string, body: Partial<EntryDraft> = {}): EntryDraft => ({ kind, modelVisible: false, writer: "foreign", ...body });
async function seed(store: HistoryStore, project: string, entries: EntryDraft[]) {
	const sid = "portable";
	await store.create({ id: sid, project, created: 1 });
	await store.openForWriting(sid);
	await store.append(sid, entries.map((entry, i) => ({ ...entry, sessionId: sid, id: `e${i}`, parentId: i ? `e${i - 1}` : null, time: i + 1 })));
	await store.close(sid);
	return sid;
}

const setting = (key: string, value: unknown) => draft("setting", { data: { key, value } });
const joined = (rights: string[] = ALL_AUTHORITY) => draft("actorJoined", { data: { actor: { id: "user", kind: "user", rights } } });

test("portable receipts survive reopening even when input is handed back, and an unavailable model is not substituted", async (t) => {
	const { api, store, dirs } = await open(t);
	const missing = { provider: "missing", id: "chosen" };
	const sid = await seed(store, dirs.project, [
		joined(), setting("model", missing),
		draft("inputAccepted", { actorId: "user", data: { inputId: "receipt", key: "retry", when: "after", content: [text("not run")] } }),
	]);
	await api.openSession(sid);
	assert.deepEqual(api.recoveredInput(sid).map((q) => q.id), ["receipt"]);
	assert.deepEqual(api.history(sid).find((e) => e.kind === "inputHandedBack")?.data, { inputId: "receipt", reason: "restart" });
	assert.deepEqual(await api.input(sid, { actorId: "user", key: "retry", content: "wrong" }), { inputId: "receipt", taken: "after", duplicate: true });
	assert.equal(api.session(sid).settings.approval, "all");
	assert.deepEqual(api.session(sid).settings.model, missing);
	await api.input(sid, { actorId: "user", content: "no fallback" });
	await api.waitForIdle(sid);
	const response = api.history(sid).find((e) => e.kind === "response")?.message;
	assert.equal(response?.role === "assistant" && response.error?.kind, "other");
	assert.match(JSON.stringify(response), /missing\/chosen is not offered/);
	await api.setSetting(sid, "model", model, "user");
	writeFileSync(join(dirs.project, "note"), "visible only with approval");
	await api.input(sid, { actorId: "user", content: 'tool:read {"path":"note"}' });
	await api.waitForIdle(sid);
	assert.equal((api.history(sid).find((e) => e.kind === "toolResult")?.data as { status: string }).status, "refused");
	assert.equal((api.history(sid).find((e) => e.kind === "inputAnswer")?.data as { reason: string }).reason, "refused");
});

test("portable input reservations keep submitter and attributed actor distinct", async (t) => {
	const { api, store, dirs } = await open(t);
	const sid = await seed(store, dirs.project, [
		joined(),
		draft("actorJoined", { data: { actor: { id: "delegate", kind: "program", rights: ALL_AUTHORITY } } }),
		draft("inputAccepted", { actorId: "user", inputId: "erased", data: { key: "same", when: "propose", content: [text("old")], submittedBy: "delegate" } }),
		draft("erasure", { data: { entryIds: ["e2"], inputKeys: [{ inputId: "erased", key: "same", actorId: "user", submittedBy: "delegate" }] } }),
	]);
	await api.openSession(sid);
	const admission = { key: "same", when: "propose" as const, content: "new" };
	assert.deepEqual(await api.input(sid, { ...admission, actorId: "user", delegatedBy: "delegate" }), { duplicate: true, erased: true });
	const first = await api.input(sid, { ...admission, actorId: "user" });
	const second = await api.input(sid, { ...admission, actorId: "delegate" });
	assert.notEqual(first.inputId, second.inputId);
	assert.deepEqual(await api.input(sid, { ...admission, actorId: "user" }), { ...first, duplicate: true });
});

for (const scenario of ["due", "allow", "refuse", "unknown"] as const) {
	test(`durable reopen: step.after ${scenario} at the checkpoint`, async (t) => {
		let gates = 0;
		const hook: Plugin = { name: "count-step-gates", setup(api) { api.on("step.after", () => { gates++; }); } };
		const { api, store, dirs } = await open(t, folders(t), [durableRuntime(), hook]);
		const ids = { turnId: "turn", stepId: "step" };
		const sid = await seed(store, dirs.project, [joined(), setting("model", model),
			draft("turnStart", { turnId: ids.turnId, actorId: "user", data: { model, startedBy: { kind: "actor", id: "user" }, tools: [], settings: {}, system: "" } }),
			draft("modelRequest", { ...ids, data: { model, safeToRepeat: false, tools: [], ...(scenario === "unknown" ? {} : { tracksStepAfter: true }) } }),
			draft("response", { ...ids, modelVisible: true, message: { role: "assistant", stop: "finished", content: [text("answer")] } }),
			...(scenario === "allow" || scenario === "refuse" ? [draft("modular-agent.stepAfter", { ...ids, data: { decision: scenario === "allow" ? null : { refuse: "committed denial" } } })] : []),
		]);
		await api.openSession(sid);
		await api.waitForIdle(sid);
		const history = api.history(sid);
		assert.equal(gates, Number(scenario === "due"));
		assert.equal(history.filter((e) => e.kind === "modular-agent.stepAfter").length, Number(scenario !== "unknown"));
		const end = history.findLast((e) => e.kind === "turnEnd");
		assert.deepEqual((end?.data as { outcome: unknown })?.outcome, scenario === "due" || scenario === "allow" ? { kind: "completed" } :
			{ kind: "failed", error: scenario === "refuse" ? "committed denial" : "Cannot establish the last step's gate decision" });
	});
}

test("rewind restores files before an out-of-turn call and refuses points from a stopped environment", async (t) => {
	const first = await open(t);
	const { api, dirs } = first;
	const sid = await api.startSession();
	await api.input(sid, { actorId: "user", content: "start" });
	await api.waitForIdle(sid);
	const mark = api.history(sid).at(-1)!.id;
	const path = join(dirs.project, "note");
	writeFileSync(path, "before");
	assert.equal((await api.callTool(sid, { name: "write", input: { path: "note", content: "after" }, startedBy: "ui", actorId: "user" })).status, "completed");
	const point = api.history(sid).find((e) => e.kind === "toolStarted")?.data as { point?: string };
	assert.equal(typeof point?.point, "string");
	await api.moveTo(sid, mark, { rewind: true });
	assert.equal(readFileSync(path, "utf8"), "before");
	assert.equal(api.history(sid).at(-1)?.id, mark);
	await api.callTool(sid, { name: "write", input: { path: "note", content: "newer" }, startedBy: "ui", actorId: "user" });
	await first.harness.stop();
	const second = await open(t, dirs);
	await second.api.openSession(sid);
	const head = second.api.session(sid).position;
	await assert.rejects(second.api.moveTo(sid, mark, { rewind: true }), /not found|ENOENT/i);
	assert.equal(readFileSync(path, "utf8"), "newer");
	assert.equal(second.api.session(sid).position, head);
});

test("collected context stays on turnStart and reaches the model; every step has a preceding modelRequest", async (t) => {
	const { api } = await open(t, folders(t), [{ name: "turn-context", setup(api) {
		api.on("turn.before", () => ({ system: "System contribution", context: [text("collected: ")] }));
	} }]);
	const sid = await api.startSession();
	await api.input(sid, { actorId: "user", content: "hello" });
	await api.waitForIdle(sid);
	const branch = api.history(sid);
	const start = branch.find((e) => e.kind === "turnStart")!;
	assert.deepEqual((start.data as { context: unknown }).context, [text("collected: ")]);
	assert.deepEqual(branch.find((e) => e.kind === "input")?.message?.content, [text("hello")]);
	const response = branch.find((e) => e.kind === "response")!;
	assert.match(JSON.stringify(response.message), /echo: hello/);
	const request = branch.find((e) => e.kind === "modelRequest" && e.stepId === response.stepId)!;
	assert.ok(branch.indexOf(request) < branch.indexOf(response));
	const intent = request.data as { model: typeof model; safeToRepeat: boolean; tools: string[]; request: ModelRequest };
	assert.deepEqual(intent.model, model);
	assert.equal(intent.safeToRepeat, true);
	assert.deepEqual(intent.request.messages.filter((m) => m.role === "user").map((m) => m.content), [[text("collected: ")], [text("hello")]]);
	assert.deepEqual(intent.tools, intent.request.tools.map((t) => t.name));
});

test("an unsafe in-flight model request is not repeated even by the durable Runtime", async (t) => {
	let requests = 0;
	const chosen = { provider: "stateful", id: "one" };
	const provider: Provider = {
		id: chosen.provider, supports: { keepsState: true, runsTools: false },
		models: () => [{ ...chosen, contextWindow: 100_000, maxOutput: 100, input: ["text"], reasoning: false }],
		request: async () => { requests++; return { role: "assistant", stop: "finished", content: [text("should not run")] }; },
	};
	const { api, store, dirs } = await open(t, folders(t), [durableRuntime(), { name: "stateful", setup(api) { api.provide("provider", provider); } }]);
	const sid = await seed(store, dirs.project, [joined(), setting("model", chosen),
		draft("turnStart", { turnId: "turn", actorId: "user", data: { model: chosen, startedBy: { kind: "actor", id: "user" }, system: "", tools: [], settings: {} } }),
		draft("modelRequest", { turnId: "turn", stepId: "step", data: { model: chosen, safeToRepeat: false } }),
	]);
	await api.openSession(sid);
	await api.waitForIdle(sid);
	assert.equal(requests, 0);
	assert.match(JSON.stringify(api.history(sid).at(-1)?.data), /interrupted model request/);
});


test("durable reopen sends committed result feedback in its next request", async (t) => {
	const { api, store, dirs } = await open(t, folders(t), [durableRuntime()]);
	const turnId = "unfinished";
	const reason = "Please cite the source";
	const sid = await seed(store, dirs.project, [
		joined(), setting("model", model),
		draft("inputAccepted", { inputId: "admission", actorId: "user", data: { when: "now", taken: "now", content: [text("Question")] } }),
		draft("turnStart", { turnId, actorId: "user", data: { model, tools: [], system: "", settings: {}, startedBy: { kind: "actor", id: "user" } } }),
		draft("input", { turnId, inputId: "admission", actorId: "user", modelVisible: true, message: { role: "user", content: [text("Question")] } }),
		draft("modelRequest", { turnId, stepId: "first", data: { model, tools: [], safeToRepeat: false, tracksStepAfter: true } }),
		draft("response", { turnId, stepId: "first", modelVisible: true, message: { role: "assistant", content: [text("An answer")], stop: "finished" } }),
		draft("resultFeedback", { turnId, modelVisible: true, data: { reason } }),
	]);
	await api.openSession(sid);
	await api.waitForIdle(sid);
	const history = api.history(sid);
	const retry = history.filter((e) => e.kind === "modelRequest").at(-1)!;
	assert.notEqual(retry.stepId, "first");
	assert.ok(retry.sources?.includes("e7"));
	assert.equal((history.findLast((e) => e.kind === "turnEnd")?.data as { result: { text: string } }).result.text, "echo: Please cite the source");
});

test("a refused repeat of a started tool settles it as outcomeUnknown, without a second call", async (t) => {
	const { api, store, dirs } = await open(t, folders(t), [durableRuntime()]);
	const call = { id: "call", name: "read", input: { path: "note" }, startedBy: "model", stepId: "step" };
	const sid = await seed(store, dirs.project, [joined(["watch", "input"]), setting("model", model), setting("approval", "off"),
		draft("turnStart", { turnId: "turn", data: { model, startedBy: { kind: "actor", id: "user" }, system: "", tools: api.tools(), settings: {} } }),
		draft("input", { turnId: "turn", actorId: "user", modelVisible: true, data: { inputId: "input" }, message: { role: "user", content: [text('tool:read {"path":"note"}')] } }),
		draft("response", { turnId: "turn", stepId: "step", modelVisible: true, message: { role: "assistant", stop: "toolUse", content: [{ type: "toolCall", id: call.id, name: call.name, arguments: call.input }] } }),
		draft("toolStarted", { turnId: "turn", stepId: "step", toolCallId: call.id, data: { call, safeToRepeat: true } }),
	]);
	await api.openSession(sid);
	await api.waitForIdle(sid);
	const entries = api.history(sid).filter((e) => e.toolCallId === call.id);
	assert.deepEqual(entries.map((e) => e.kind), ["toolStarted", "toolResult"]);
	assert.equal((entries[1].data as { status: string }).status, "outcomeUnknown");
});

test("plugin binding: refreshes before completing the parent, gates split output, and sends discard entry IDs", async (t) => {
	const harness = await wireHarness(t);
	const api = harness.api("test");
	const sid = await api.startSession();
	const seen: unknown[] = [];
	const stop = api.follow(sid, { recipient: "wire-test" }, (event) => { if (event.type === "model.output") seen.push(event.data.delta); });
	t.after(stop);
	assert.equal((await api.callTool(sid, { name: "grow", input: {}, startedBy: "ui", actorId: "user" })).status, "completed");
	assert.ok(api.tools(sid).some((tool) => tool.name === "grown"));
	await api.input(sid, { actorId: "user", content: "stream" });
	await api.waitForIdle(sid);
	await api.flushOutput(sid, "wire-test");
	assert.deepEqual(seen, ["split [redacted]", " end"]);
	assert.doesNotMatch(JSON.stringify(await api.gatedHistory(sid, { recipient: "wire-test" })), /conformance-secret/);
	const input = api.history(sid).find((e) => e.kind === "input")!;
	const result = await api.erase(sid, [input.id], "user");
	assert.deepEqual(result.pending, [input.id]);
});

test("plugin binding: the history cursor counts toward the exact 4 MiB result limit", async (t) => {
	const harness = await wireHarness(t);
	const api = harness.api("test");
	const sid = await api.startSession();
	const empty = await api.append(sid, draft("foreign.pad", { id: "dummy", data: "" }));
	const max = 4 * 1024 * 1024;
	const overhead = Buffer.byteLength(JSON.stringify({ entries: [{ ...empty, id: "edge1", parentId: empty.id }], next: "edge1" }));
	const available = max - overhead;
	await api.append(sid, draft("foreign.pad", { id: "edge1", data: "é".repeat(Math.floor(available / 2)) + (available % 2 ? "x" : "") }));
	await api.append(sid, draft("foreign.tail", { id: "tail" }));
	const output = await api.runCommand(sid, "/wire-page dummy", "user");
	assert.deepEqual(JSON.parse(output!), { ids: ["edge1"], next: "edge1", bytes: max });
	const blank = await api.append(sid, draft("foreign.pad", { id: "blank", data: "" }));
	const alone = Buffer.byteLength(JSON.stringify({ entries: [{ ...blank, id: "edge2", parentId: blank.id }] }));
	await api.append(sid, draft("foreign.pad", { id: "edge2", data: "x".repeat(max - alone) }));
	await api.append(sid, draft("foreign.tail", { id: "last" }));
	const minimum = await api.runCommand(sid, "/wire-page blank", "user");
	assert.deepEqual(JSON.parse(minimum!), { code: "result_too_large" });
});

async function wireHarness(t: TestContext) {
	const module = fileURLToPath(new URL("./fixtures/round-five-wire.js", import.meta.url));
	const served = fileURLToPath(import.meta.resolve("@modular-agent/plugin-wire").replace(/index\.js$/, "serve-cli.js"));
	const harness = await createAgent({ ...folders(t), model: "wire-test/sample", externalPlugins: [
		{ command: [process.execPath, module] },
		{ command: [process.execPath, served], env: { MODULAR_AGENT_PLUGIN_PARTS: "hooks" } },
	] });
	t.after(() => harness.stop());
	return harness;
}
