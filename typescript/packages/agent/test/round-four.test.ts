import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { approval } from "@modular-agent/approval";
import { durableRuntime } from "@modular-agent/runtime-durable";
import { type HistoryEntry, type HistoryStore, type InputRequest, type InputRequestDraft, type Plugin, type Provider, type ToolContext } from "@modular-agent/harness";
import { createAgent, conformanceProvider } from "../src/index.js";

function folder(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "ma-r4-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

async function start(t: TestContext, options: Parameters<typeof createAgent>[0] = {}) {
	const home = options.home ?? folder(t);
	const h = await createAgent({ project: home, home, model: "conformance/echo", ...options, plugins: [conformanceProvider(), ...(options.plugins ?? [])] });
	t.after(() => h.stop());
	return { h, api: h.api("test"), home };
}

async function until(check: () => boolean) {
	for (let i = 0; i < 500 && !check(); i++) await delay(10);
	assert.ok(check(), "timed out waiting for the expected event");
}

const fullRights = ["watch", "input", "answer", "approve", "tools", "settings", "erase"] as const;

test("the agent reopens standard history with session settings, actors, keys and late questions", async (t) => {
	const { h, api, home } = await start(t, { plugins: [durableRuntime(), approval({ policy: "all", waitMs: 5 })] });
	const store = h.use<HistoryStore>("history-store")!;
	const sid = "portable-session";
	await store.create({ id: sid, created: 10, project: home });
	await store.openForWriting(sid);
	const call = { type: "toolCall" as const, id: "pending-call", name: "read", arguments: { path: "note" } };
	const drafts: Partial<HistoryEntry>[] = [
		{ kind: "actorJoined", data: { actor: { id: "friend", kind: "user", rights: fullRights } } },
		{ kind: "setting", data: { key: "settings", value: { model: { provider: "conformance", id: "echo" }, reasoning: "low", maxSteps: 7 } } },
		{ kind: "turnStart", turnId: "foreign-turn", actorId: "friend", data: { startedBy: { kind: "actor", id: "friend" }, model: { provider: "conformance", id: "echo" }, system: "retained", tools: [], settings: {}, rights: fullRights, authorizers: [{ sessionId: sid, actorId: "friend" }] } },
		{ kind: "input", turnId: "foreign-turn", actorId: "friend", data: { inputId: "original", key: "one" }, modelVisible: true, message: { role: "user", content: [{ type: "text", text: 'tool:read {"path":"note"}' }] } },
		{ kind: "response", turnId: "foreign-turn", stepId: "foreign-step", modelVisible: true, message: { role: "assistant", stop: "toolUse", content: [call] } },
		{ kind: "inputRequest", turnId: "foreign-turn", toolCallId: call.id, data: { request: { id: "foreign-question", sessionId: sid, kind: "approval", question: "Allow read?", details: '{\n  "path": "note"\n}', key: `approval:${call.id}`, toolCallId: call.id, answerable: true } } },
		{ kind: "turnEnd", turnId: "foreign-turn", data: { outcome: { kind: "completed" }, result: { openToolCalls: [call.id] }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } } },
		{ kind: "position", data: { to: "e6" } },
	];
	await store.append(sid, drafts.map((e, i) => ({ writer: "foreign", sessionId: sid, modelVisible: false, time: 10 + i, ...e, id: `e${i}`, parentId: i ? `e${i - 1}` : null }) as HistoryEntry));
	await store.close(sid);
	writeFileSync(join(home, "note"), "portable note");
	await api.openSession(sid, { id: "friend", kind: "user", authority: [] });
	assert.deepEqual(api.session(sid).settings.model, { provider: "conformance", id: "echo" });
	assert.equal(api.session(sid).settings.reasoning, "low");
	assert.deepEqual(api.history(sid).slice(-2).map((e) => e.kind), ["turnEnd", "plugins"]);
	assert.equal(api.history(sid).at(-1)?.parentId, "e6");
	assert.deepEqual(await api.input(sid, { content: "ignored", key: "one", actorId: "friend" }), { duplicate: true, inputId: "original", taken: "now" });
	assert.equal(api.openRequests(sid)[0]?.id, "foreign-question");
	assert.equal(api.answer(sid, { requestId: "foreign-question", actorId: "friend", value: "allow" }).accepted, true);
	await api.waitForIdle(sid);
	const history = api.history(sid);
	assert.equal(history.filter((e) => e.kind === "toolResult" && e.toolCallId === call.id).length, 1);
	assert.match(JSON.stringify(history.at(-1)?.data), /portable note/);
	assert.equal(api.openRequests(sid).length, 0);
});

test("erasure reports in-use fork copies as pending and preserves copy lineage", async (t) => {
	const { api, home } = await start(t);
	const parent = await api.startSession();
	await api.input(parent, { actorId: "user", content: "erase me" });
	await api.waitForIdle(parent);
	const input = api.history(parent).find((e) => e.kind === "input")!;
	const response = api.history(parent).find((e) => e.kind === "response")!;
	const end = api.history(parent).at(-1)!;
	const child = await api.forkSession(parent, end.id);
	await api.closeSession(child);
	const { api: other } = await start(t, { home });
	await other.openSession(child);
	const pending = await api.erase(parent, [input.id], "user");
	assert.ok(pending.pendingPairs.some((p) => p.sessionId === child));
	assert.doesNotMatch(JSON.stringify(api.history(parent)), /erase me/);
	await other.closeSession(child);
	const report = await api.erase(parent, [input.id], "user");
	assert.ok(pending.erased.includes(response.id));
	assert.ok(pending.erased.includes(end.id));
	assert.ok(report.erasedPairs.some((p) => p.sessionId === child));
	await api.openSession(child);
	await api.waitForIdle(child);
	for (const sid of [parent, child]) {
		const entries = api.history(sid, { all: true });
		assert.doesNotMatch(JSON.stringify(entries), /erase me/);
		assert.ok(!entries.some((e) => e.kind === "turnEnd" && !e.erased), "erasure does not leave an interrupted turn to recover");
		assert.ok(entries.some((e) => e.kind === "response" && e.erased));
	}
});

test("a stateful Provider is asked to delete remote copies before erasure returns", async (t) => {
	const calls: { sessionId: string; erase?: boolean; entryIds?: string[] }[] = [];
	const stateful: Provider = {
		id: "stateful", supports: { keepsState: true },
		models: () => [{ provider: "stateful", id: "model", contextWindow: 100_000, maxOutput: 100, input: ["text"], reasoning: false }],
		request: async () => ({ role: "assistant", stop: "finished", content: [{ type: "text", text: "done" }] }),
		async discardState(sessionId, options) {
			await delay(10);
			calls.push({ sessionId, ...options });
			return options?.erase ? { pending: options.entryIds?.slice(0, 1), outOfReach: ["provider logs"] } : undefined;
		},
	};
	const { api } = await start(t, { model: "stateful/model", plugins: [{ name: "stateful", setup(api) { api.provide("provider", stateful); } }] });
	const sid = await api.startSession();
	await api.input(sid, { actorId: "user", content: "hello" });
	await api.waitForIdle(sid);
	const id = api.history(sid).find((entry) => entry.kind === "input")!.id;
	await api.moveTo(sid, api.history(sid).at(-1)!.id);
	const report = await api.erase(sid, [id], "user");
	assert.deepEqual(calls, [{ sessionId: sid }, { sessionId: sid, erase: true, entryIds: report.erased }]);
	assert.deepEqual(report.pending, [id]);
	assert.ok(report.outOfReach.includes("provider logs"));
});

test("unconfirmed Provider deletion blocks model reuse after reopen", async (t) => {
	let confirmed = false;
	let requests = 0;
	let discards = 0;
	const provider: Provider = {
		id: "kept", supports: { keepsState: true },
		models: () => [{ provider: "kept", id: "model", contextWindow: 100_000, maxOutput: 100, input: ["text"], reasoning: false }],
		request: async () => {
			requests++;
			return { role: "assistant", stop: "finished", content: [{ type: "text", text: "done" }] };
		},
		async discardState(_id, options) {
			if (options?.erase) {
				discards++;
				if (!confirmed) throw Error("Deletion not confirmed");
			}
		},
	};
	const options = { model: "kept/model", plugins: [{ name: "kept", setup(api: import("@modular-agent/harness").PluginApi) { api.provide("provider", provider); } }] };
	const first = await start(t, options);
	const id = await first.api.startSession();
	await first.api.input(id, { content: "Private input", actorId: "user" });
	await first.api.waitForIdle(id);
	const input = first.api.history(id).find(e => e.kind === "input")!;
	assert.ok((await first.api.erase(id, [input.id], "user")).outOfReach.includes("Unconfirmed deletion at kept"));
	await first.h.stop();
	const second = await start(t, { ...options, home: first.home });
	await second.api.openSession(id);
	await second.api.input(id, { content: "Do not contact the Provider", actorId: "user" });
	await second.api.waitForIdle(id);
	assert.equal(requests, 1);
	assert.equal(discards, 2);
	confirmed = true;
	await second.api.input(id, { content: "Start with clean state", actorId: "user" });
	await second.api.waitForIdle(id);
	assert.equal(requests, 2);
	assert.equal(discards, 3);
});

test("permission grants and revocations cannot be erased", async (t) => {
	const { api } = await start(t);
	const sid = await api.startSession();
	await api.join(sid, { id: "viewer", kind: "user", authority: ["watch"] }, "user");
	await api.leave(sid, "viewer");
	await api.input(sid, { actorId: "user", when: "propose", content: "Keep this session" });
	for (const entry of api.history(sid).filter((e) => ["actorJoined", "actorLeft"].includes(e.kind))) {
		await assert.rejects(api.erase(sid, [entry.id], "user"), /authority/);
	}
	assert.ok(!api.session(sid).actors.some((a) => a.id === "viewer"));
});

test("changing any part of a keyed question does not reuse its answer", async (t) => {
	const seen: InputRequest[] = [];
	const ui: Plugin = { name: "question-ui", setup(api) { api.provide("interface", { id: "question-ui", actorId: "user", onInputRequest: (r: InputRequest) => seen.push(r) }); } };
	const { api } = await start(t, { plugins: [ui] });
	const sid = await api.startSession();
	await api.input(sid, { actorId: "user", when: "propose", content: "Keep this session" });
	const base: InputRequestDraft = { key: "same", kind: "choice", question: "Which?", options: ["a", "b"], toolCallId: "first" };
	let index = 0;
	const ask = async (draft: InputRequestDraft) => {
		const result = api.ask(sid, draft);
		await until(() => seen.length > index);
		const r = seen[index++];
		assert.equal(api.answer(sid, { requestId: r.id, actorId: "user", declined: true }).accepted, true);
		assert.equal((await result).requestId, r.id);
		return r.id;
	};
	for (const change of [{ question: "Another?" }, { kind: "text" as const }, { options: ["b", "a"] }, { toolCallId: "second" }]) {
		const original = await ask({ ...base, key: `q${index}` });
		const same = seen.at(-1)!.key;
		assert.equal((await api.ask(sid, { ...base, key: same })).requestId, original);
		assert.notEqual(await ask({ ...base, ...change, key: same }), original);
	}
	const secret = { kind: "secret" as const, key: "secret", question: "Which token?" };
	assert.notEqual(await ask({ ...secret, credential: "one" }), await ask({ ...secret, credential: "two" }));
});

test("steering from a second actor cannot borrow settings rights from the first", async (t) => {
	let release!: () => void;
	let entered = false;
	const hold = new Promise<void>((resolve) => { release = resolve; });
	const tools: Plugin = { name: "mixed-tools", setup(api) {
		api.provide("tool-source", {
			id: "mixed-tools",
			tools: () => ["hold", "change"].map((name) => ({ name, description: name, parameters: { type: "object" } })),
			async run(call: { name: string }, ctx: ToolContext) {
				if (call.name === "hold") { entered = true; await hold; }
				else await api.setSetting(ctx.sessionId, "example", "changed", "user");
				return { status: "completed", content: [{ type: "text", text: "ok" }] };
			},
		});
	} };
	const { api } = await start(t, { plugins: [tools] });
	const sid = await api.startSession();
	await api.join(sid, { id: "guest", kind: "user", authority: ["watch", "input", "tools"] }, "user");
	await api.input(sid, { actorId: "user", content: "tool:hold {}" });
	try {
		await until(() => entered);
		assert.equal((await api.input(sid, { actorId: "guest", when: "steer", content: "tool:change {}" })).taken, "inTurn");
	} finally { release(); }
	await api.waitForIdle(sid);
	assert.equal(api.session(sid).settings.example, undefined);
	assert.match(JSON.stringify(api.history(sid).filter((e) => e.kind === "toolResult")), /may not settings/);
});

test("closing a session stops its background work, not another session's", async (t) => {
	const { api, home } = await start(t);
	const active = async (file: string) => {
		const sid = await api.startSession();
		await api.input(sid, { actorId: "user", when: "propose", content: "Keep this session" });
		const result = await api.callTool(sid, { name: "bash", input: { command: `sleep 30 >/dev/null 2>&1 & echo $! > ${file}` }, actorId: "user", startedBy: "ui" });
		assert.equal(result.status, "completed");
		return { sid, pid: +readFileSync(join(home, file), "utf8") };
	};
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return process.platform !== "linux" || !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
		} catch { return false; }
	};
	const one = await active("one.pid"), two = await active("two.pid");
	await api.closeSession(one.sid);
	await until(() => !alive(one.pid));
	assert.ok(alive(two.pid));
	await api.closeSession(two.sid);
	await until(() => !alive(two.pid));
});
