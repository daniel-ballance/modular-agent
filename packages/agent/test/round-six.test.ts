import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { client, methods } from "@agentclientprotocol/sdk";
import { ALL_AUTHORITY, text, textOf, zeroUsage, type HistoryStore, type Plugin, type Provider, type Runtime } from "@modular-agent/harness";
import { acpInterface } from "@modular-agent/interface-acp";
import { conformanceProvider, createAgent } from "../src/index.js";

function pulse() {
	let release!: () => void;
	const wait = new Promise<void>((resolve) => { release = resolve; });
	return { wait, release };
}

function folders(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "ma-r6-"));
	t.after(() => rmSync(root, { force: true, recursive: true }));
	return { project: root, home: join(root, "state") };
}

async function agent(t: TestContext, plugins: Plugin[] = [], dirs = folders(t), model = "conformance/echo") {
	const h = await createAgent({ ...dirs, model, plugins: [conformanceProvider(), ...plugins] });
	t.after(() => h.stop());
	return { h, api: h.api("test"), dirs };
}

async function acpAgent(t: TestContext, ...plugins: Plugin[]) {
	const acp = acpInterface();
	const fixture = await agent(t, [acp, ...plugins]);
	const connection = client({ name: "test" }).connect(acp.acp.app);
	t.after(() => connection.close());
	await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
	const { sessionId } = await connection.agent.request(methods.agent.session.new, { cwd: fixture.dirs.project, mcpServers: [] });
	const ext = (name: string, params: Record<string, unknown> = {}) => connection.agent.request(`_modular-agent/${name}`, { sessionId, ...params });
	return { ...fixture, sessionId, ext };
}

test("a limit narrows a running turn's next action, persists off branch, and cannot be erased", async (t) => {
	const checking = pulse();
	const proceed = pulse();
	const { api, dirs } = await agent(t, [{ name: "pause-tool", setup(api) {
		api.on("tool.before", async () => { checking.release(); await proceed.wait; });
	} }]);
	const s = await api.startSession();
	const mark = api.history(s).at(-1)!.id;
	await api.input(s, { actorId: "user", content: 'tool:write {"path":"state-of-project","content":"bad"}' });
	await checking.wait;
	await api.setLimit(s, ALL_AUTHORITY.filter((r) => r !== "tools"), "user");
	proceed.release();
	await api.waitForIdle(s);
	assert.equal((api.history(s).find((e) => e.kind === "toolResult")?.data as { status: string }).status, "refused");
	assert.throws(() => readFileSync(join(dirs.project, "state-of-project")), { code: "ENOENT" });
	const limit = api.history(s).find((e) => e.kind === "limit")!;
	await api.moveTo(s, mark);
	assert.ok(!api.session(s).actors[0].authority.includes("tools"));
	await assert.rejects(api.erase(s, [limit.id], "user"), /authority/);
	await api.setLimit(s, ALL_AUTHORITY, "user");
	await api.setLimit(s, null, "user");
	assert.ok(api.session(s).actors[0].authority.includes("tools"));
});

test("tenant usage is charged across sessions and processes and stops after the step that reaches the budget", async (t) => {
	const rights = ALL_AUTHORITY.filter((right) => right !== "tools");
	const tenants = JSON.stringify({ team: { rights, tokens: 5 } });
	const before = process.env.MODULAR_AGENT_TENANTS;
	t.after(() => { if (before === undefined) delete process.env.MODULAR_AGENT_TENANTS; else process.env.MODULAR_AGENT_TENANTS = before; });
	process.env.MODULAR_AGENT_TENANTS = tenants;
	let requests = 0;
	const model = { provider: "metered", id: "echo", contextWindow: 100_000, maxOutput: 100, reasoning: false, input: ["text"] };
	const provider: Provider = { id: model.provider, models: () => [model], supports: { keepsState: false, runsTools: false },
		async request() { requests++; return { role: "assistant", stop: "finished", content: [text("done")], usage: { ...zeroUsage(), input: 2, output: 1 } }; } };
	const plugin: Plugin = { name: "metered", setup(api) { api.provide("provider", provider); } };
	const dirs = folders(t);
	const one = await agent(t, [plugin], dirs, "metered/echo");
	const first = await one.api.startSession({ tenant: "team" });
	assert.equal(one.api.history(first)[0].kind, "tenant");
	await assert.rejects(one.api.startSession({ tenant: "unknown" }), /Unknown tenant/);
	await one.api.input(first, { actorId: "user", content: "first" });
	await one.api.waitForIdle(first);
	assert.deepEqual((await one.api.tenant(first)).tokens, { budget: 5, used: 3 });
	await one.h.stop();
	delete process.env.MODULAR_AGENT_TENANTS;
	const unknown = await agent(t, [plugin], dirs, "metered/echo");
	await assert.rejects(unknown.api.openSession(first), /Unknown tenant/);
	process.env.MODULAR_AGENT_TENANTS = tenants;
	const two = await agent(t, [plugin], dirs, "metered/echo");
	const second = await two.api.startSession({ tenant: "team" });
	await two.api.input(second, { actorId: "user", content: "second" });
	await two.api.waitForIdle(second);
	assert.deepEqual((two.api.history(second).at(-1)!.data as { outcome: unknown }).outcome, { kind: "limit", limit: "tenantTokens" });
	assert.deepEqual(await two.api.tenant(second), { tenant: "team", rights, tokens: { budget: 5, used: 6 } });
	await two.api.openSession(first);
	await two.api.input(first, { actorId: "user", content: "blocked" });
	await two.api.waitForIdle(first);
	assert.equal(requests, 2);
	assert.deepEqual((two.api.history(first).at(-1)!.data as { outcome: unknown }).outcome, { kind: "limit", limit: "tenantTokens" });
});

test("ACP proposals list oldest first, allow a proposer to withdraw, and report a declined release", async (t) => {
	const { api, sessionId, ext } = await acpAgent(t);
	const actor = { id: "guest", kind: "user", rights: ["watch", "propose"] };
	await ext("join", { actor, present: false });
	assert.deepEqual((await ext("actors") as { present: string[] }).present, ["acp-user"]);
	await ext("join", { actor });
	assert.deepEqual((await ext("actors") as { present: string[] }).present, ["acp-user"]);
	await assert.rejects(ext("input", { content: "not represented", when: "propose", actorId: "guest" }), { code: -32602, data: { code: "forbidden" } });
	const propose = async (content: string) => (await ext("input", { content, when: "propose" }) as { inputId: string }).inputId;
	const one = await propose("one"), two = await propose("two");
	const listed = (await ext("proposals") as { proposals: { inputId: string; actorId: string; content: ReturnType<typeof text>[]; time: number }[] }).proposals;
	assert.deepEqual(listed.map(({ inputId, actorId, content }) => [inputId, actorId, textOf(content)]), [[one, "acp-user", "one"], [two, "acp-user", "two"]]);
	assert.ok(listed[0].time > 0 && listed[0].time <= listed[1].time);
	await ext("join", { actor: { ...actor, id: "other" }, present: false });
	await assert.rejects(ext("withdraw", { inputId: one, actorId: "other" }), { code: -32602 });
	await ext("withdraw", { inputId: one });
	assert.deepEqual(await ext("release", { inputId: two, when: "now", declined: true }), { inputId: two, taken: "handedBack" });
	assert.deepEqual(await ext("proposals"), { proposals: [] });
	assert.deepEqual(api.history(sessionId).filter((e) => e.kind === "inputHandedBack").map((e) => e.data), [{ inputId: one, reason: "withdrawn" }, { inputId: two, reason: "declined" }]);
});

test("ACP replies withheld by a blocking or failing gate return an error without reversing the effect", async (t) => {
	const { ext, api, sessionId } = await acpAgent(t, { name: "withhold", setup(api) {
		api.on("output", (p) => {
			const method = p.events[0]?.type === "reply" && p.events[0].data.method;
			if (method === "_modular-agent/input") return { action: "block" };
			if (method === "_modular-agent/history") throw new Error("failed gate");
		});
	} });
	const withheld = { code: -32000, data: { code: "withheld" } };
	await assert.rejects(ext("input", { content: "keep me", when: "propose" }), withheld);
	assert.equal(api.proposals(sessionId, "acp-user").length, 1);
	await assert.rejects(ext("history"), withheld);
});

test("rewind commits intent before touching files, reports open-world calls, and refuses another branch", async (t) => {
	const { api, h, dirs } = await agent(t);
	const s = await api.startSession();
	const mark = api.session(s).position!;
	const note = join(dirs.project, "note");
	writeFileSync(note, "before");
	const call = await api.callTool(s, { startedBy: "ui", actorId: "user", name: "bash", input: { command: "printf after > note" } });
	assert.equal(call.status, "completed");
	const after = api.session(s).position!;
	const store = h.use<HistoryStore>("history-store")!;
	const append = store.append.bind(store);
	store.append = async (id, entries) => {
		if (entries.some((e) => e.kind === "position")) {
			assert.equal(readFileSync(note, "utf8"), "after", "no restore may run before committing the intent");
			throw new Error("lease lost");
		}
		await append(id, entries);
	};
	await assert.rejects(api.moveTo(s, mark, { rewind: true }), /lease lost/);
	assert.equal(api.session(s).position, after);
	assert.equal(readFileSync(note, "utf8"), "after");
	store.append = append;
	assert.deepEqual(await api.moveTo(s, mark, { rewind: true }), { outOfReach: [call.callId] });
	assert.equal(readFileSync(note, "utf8"), "before");
	await assert.rejects(api.moveTo(s, after, { rewind: true }), /current branch/);
	assert.equal(api.session(s).position, mark);
});

test("a job records its starting rights and accepts its report before the waiting turn is free", async (t) => {
	const requesting = pulse();
	const proceed = pulse();
	const { api, dirs } = await agent(t, [{ name: "pause-report", setup(api) {
		api.on("turn.before", async (p) => { if (textOf(p.input) === "hold") { requesting.release(); await proceed.wait; } });
	} }]);
	const s = await api.startSession();
	await api.join(s, { id: "worker", kind: "plugin", authority: ["watch", "jobs", "input"] }, "user");
	const job = api.startJob(s, { kind: "check", actorId: "worker" });
	await job.ready;
	assert.deepEqual((api.history(s).find((e) => e.kind === "jobStarted")!.data as { rights: string[] }).rights, ["watch", "input", "jobs"]);
	await api.join(s, { id: "worker", kind: "plugin", authority: ["watch", "jobs", "input", "tools"] }, "user");
	await api.input(s, { actorId: "user", content: "hold" });
	await requesting.wait;
	const content = [text('tool:write {"path":"job-file","content":"bad"}')];
	await job.finish("completed", content);
	const kept = api.history(s).filter((e) => e.jobId === job.id);
	assert.deepEqual(kept.map((e) => e.kind), ["jobStarted", "jobEnded", "inputAccepted"]);
	assert.equal((kept.at(-1)!.data as { key: string }).key, `job:${job.id}`);
	proceed.release();
	await api.waitForIdle(s);
	assert.deepEqual(api.history(s).find((e) => e.kind === "input" && e.jobId === job.id)?.message?.content, content);
	assert.equal((api.history(s).find((e) => e.kind === "toolResult")?.data as { status: string }).status, "refused");
	assert.throws(() => readFileSync(join(dirs.project, "job-file")), { code: "ENOENT" });
});

test("a changed model gets the nearest supported reasoning level below the old one", async (t) => {
	const levels: unknown[] = [];
	const base = { provider: "reason", contextWindow: 100_000, maxOutput: 100, reasoning: true, input: ["text"] };
	const plugin: Plugin = { name: "reason", setup(api) {
		api.provide("provider", {
			id: "reason", models: () => [{ ...base, id: "wide" }, { ...base, id: "narrow", thinking: ["off", "low", "xhigh"] }],
			supports: { keepsState: false, runsTools: false },
			async request(_model, request) { levels.push(request.settings.reasoning); return { role: "assistant", stop: "finished", content: [text("ok")] }; },
		} satisfies Provider);
	} };
	const { api } = await agent(t, [plugin], folders(t), "reason/wide");
	const s = await api.startSession({ settings: { reasoning: "high" } });
	await api.input(s, { actorId: "user", content: "first" });
	await api.waitForIdle(s);
	await api.setSetting(s, "model", "reason/narrow", "user");
	await api.input(s, { actorId: "user", content: "second" });
	await api.waitForIdle(s);
	assert.deepEqual(levels, ["high", "low"]);
});

test("a cancel wins over a Runtime callback failure", async (t) => {
	const running = pulse();
	const plugin: Plugin = { name: "fails-on-cancel", replaces: "runtime-transient", setup(api) {
		const runtime: Runtime = {
			id: "test", supports: {},
			async runTurn(_input, _host, signal) {
				running.release();
				await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("Callback failed")), { once: true }));
				throw new Error("unreachable");
			},
			async resumeTurn() { throw new Error("unused"); },
			async continueOpenCalls() { throw new Error("unused"); },
		};
		api.provide("runtime", runtime);
	} };
	const { api } = await agent(t, [plugin]);
	const s = await api.startSession();
	await api.input(s, { actorId: "user", content: "wait" });
	await running.wait;
	await api.cancel(s);
	assert.deepEqual((api.history(s).at(-1)!.data as { outcome: unknown }).outcome, { kind: "cancelled" });
});
