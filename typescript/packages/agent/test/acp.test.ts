import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { client, methods, type InitializeRequest, type SessionNotification } from "@agentclientprotocol/sdk";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { approval } from "@modular-agent/approval";
import type { Harness, HistoryEntry, Plugin } from "@modular-agent/harness";
import { acpInterface } from "@modular-agent/interface-acp";
import { createAgent } from "../src/index.js";
import { testDirs, testTempDir } from "./fixtures/temp-dir.js";


/** Our agent, with an ACP Interface, and an ACP client from the official SDK connected to it in process. */
async function setup(t: TestContext, responses: FauxResponseStep[], options: { permission?: "allow" | "refuse" | "never"; d?: { project: string; home: string }; waitMs?: number; plugins?: Plugin[] } = {}) {
	const d = options.d ?? testDirs(t);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	const acp = acpInterface();
	const harness: Harness = await createAgent({ ...d, models, model: "faux/faux-1", plugins: [approval({ policy: "ask", waitMs: options.waitMs }), ...(options.plugins ?? []), acp] });
	const updates: SessionNotification[] = [];
	const permissions: unknown[] = [];
	let answerLater: ((optionId: string) => void) | undefined;
	const app = client({ name: "test-client" })
		.onNotification(methods.client.session.update, ({ params }) => {
			updates.push(params);
		})
		.onRequest(methods.client.session.requestPermission, async ({ params }) => {
			permissions.push(params);
			if (options.permission === "never") return new Promise((resolve) => (answerLater = (optionId) => resolve({ outcome: { outcome: "selected", optionId } })));
			return { outcome: { outcome: "selected", optionId: options.permission ?? "allow" } };
		});
	const connection = app.connect(acp.acp.app);
	return { d, harness, ctx: connection.agent, connection, updates, permissions, answer: (id: string) => answerLater?.(id) };
}

const kinds = (updates: SessionNotification[]) => updates.map((u) => u.update.sessionUpdate);

test("ACP: initialize negotiates the wire version independently of the binding", async (t) => {
	const ns = "modular-agent";
	for (const [version, binding] of [[2, "modular-agent-acp/1"], [2, "modular-agent-acp/2"], [65535, undefined]] as const) {
		await t.test(`version ${version} with ${binding ?? "the default binding"}`, async (t) => {
			const { ctx, connection, harness } = await setup(t, []);
			t.after(async () => { connection.close(); await harness.stop(); });
			const hello = await ctx.request(methods.agent.initialize, { protocolVersion: version, _meta: binding ? { [ns]: { binding } } : {} });
			assert.equal(hello.protocolVersion, 1);
			assert.deepEqual((hello._meta?.[ns] as { binding: string }).binding, binding ?? "modular-agent-acp/1");
		});
	}
});

test("ACP: failed initialize requests leave the connection uninitialized", async (t) => {
	const { ctx, connection, harness } = await setup(t, []);
	t.after(async () => { connection.close(); await harness.stop(); });
	const init = (params: unknown) => ctx.request(methods.agent.initialize, params as InitializeRequest);
	const ns = "modular-agent";
	const invalid = [
		[{}, { code: -32602 }],
		...["1", 1.5, -1, 65536, true, null, {}, []].map((version) => [{ protocolVersion: version }, { code: -32602 }]),
		[{ protocolVersion: 0 }, { code: -32602, data: { code: "unsupported_version" } }],
		[{ protocolVersion: 2, _meta: { [ns]: { binding: "modular-agent-acp/3" } } }, { code: -32602, data: { code: "unsupported_version" } }],
		...[null, [], { binding: 2 }].map((namespace) =>
			[{ protocolVersion: 2, _meta: { [ns]: namespace } }, { code: -32602, data: { code: "invalid_params" } }]),
	] as const;
	for (const [params, error] of invalid) {
		await assert.rejects(init(params), error, JSON.stringify(params));
		await assert.rejects(ctx.request(methods.agent.session.list, {}), { code: -32600 });
	}
	assert.equal((await init({ protocolVersion: 2 })).protocolVersion, 1);
	const list = await ctx.request(methods.agent.session.list, {});
	assert.deepEqual(list.sessions, []);
});

test("ACP: withheld history entries are omitted before the page reply gate", async (t) => {
	const seen: string[][] = [];
	const gate: Plugin = { name: "hide-entries", setup(api) {
		api.on("output", ({ events }) => {
			const event = events[0];
			if (event?.type === "entry" && event.data.kind === "hidden.entry") return { action: "block" };
			if (event?.type === "reply" && event.data.method === "_modular-agent/history") {
				seen.push(event.data.result.entries.map((entry: HistoryEntry) => entry.kind));
			}
		});
	} };
	const { d, harness, ctx, connection } = await setup(t, [fauxAssistantMessage([fauxText("Ready")])], { plugins: [gate] });
	t.after(async () => { connection.close(); await harness.stop(); });
	await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
	const { sessionId } = await ctx.request(methods.agent.session.new, { cwd: d.project, mcpServers: [] });
	await ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "Start" }] });
	const api = harness.api("test");
	const after = api.history(sessionId).at(-1)!.id;
	await api.append(sessionId, { kind: "hidden.entry", modelVisible: false, writer: "test" });
	const visible = await api.append(sessionId, { kind: "visible.entry", modelVisible: false, writer: "test" });
	const hiddenPage = await ctx.request("_modular-agent/history", { sessionId, after, limit: 1 });
	assert.deepEqual(hiddenPage, { entries: [] });
	const mixed = await ctx.request("_modular-agent/history", { sessionId, after, limit: 2 });
	assert.deepEqual(mixed, { entries: [JSON.parse(JSON.stringify(visible))] });
	assert.deepEqual(seen, [[], ["visible.entry"]]);
});

test("ACP: initialize declares what the agent supports; a prompt runs a turn with a tool call", async (t) => {
	const { d, harness, ctx, updates, permissions, connection } = await setup(t, [
		fauxAssistantMessage([fauxToolCall("read", { path: "a.txt" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("It says hello.")]),
	]);
	writeFileSync(join(d.project, "a.txt"), "hello");
	const init = await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
	assert.equal(init.agentCapabilities?.loadSession, true);
	const declaration = (init._meta as Record<string, { binding: string; declaration: Record<string, unknown> }>)["modular-agent"].declaration;
	assert.equal((init._meta as Record<string, { binding: string }>)["modular-agent"].binding, "modular-agent-acp/1");
	assert.equal(declaration.questionsOutlastTurns, true);
	const session = await ctx.request(methods.agent.session.new, { cwd: d.project, mcpServers: [] });
	assert.ok(session.configOptions?.some((o) => o.id === "model"));
	const response = await ctx.request(methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [{ type: "text", text: "what's in a.txt?" }] });
	assert.equal(response.stopReason, "end_turn");
	await new Promise((r) => setTimeout(r, 20));
	const k = kinds(updates);
	assert.ok(k.includes("tool_call"), k.join(","));
	assert.ok(k.includes("tool_call_update"));
	assert.ok(k.includes("agent_message_chunk"));
	const text = updates.filter((u) => u.update.sessionUpdate === "agent_message_chunk").map((u) => (u.update as { content: { text: string } }).content.text).join("");
	assert.match(text, /It says hello/);
	assert.equal(permissions.length, 0, "read is read-only, so no approval");
	connection.close();
	await harness.stop();
});

test("ACP: an approval becomes session/request_permission; a refusal blocks the call", async (t) => {
	const { d, harness, ctx, permissions, connection } = await setup(
		t,
		[fauxAssistantMessage([fauxToolCall("bash", { command: "echo x > x.txt" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("Not allowed.")])],
		{ permission: "refuse" },
	);
	await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
	const { sessionId } = await ctx.request(methods.agent.session.new, { cwd: d.project, mcpServers: [] });
	const response = await ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "make x" }] });
	assert.equal(response.stopReason, "end_turn");
	assert.equal(permissions.length, 1);
	assert.equal(existsSync(join(d.project, "x.txt")), false);
	const result = harness.api("t").history(sessionId).find((e) => e.kind === "toolResult")!;
	assert.equal((result.data as { status: string }).status, "refused");
	connection.close();
	await harness.stop();
});

test("ACP: a timed-out approval is closed and a late allow cannot dispatch", async (t) => {
	const { d, harness, ctx, connection, answer } = await setup(
		t,
		[fauxAssistantMessage([fauxToolCall("bash", { command: "echo x > x.txt" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("Done.")])],
		{ permission: "never", waitMs: 30 },
	);
	await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
	const { sessionId } = await ctx.request(methods.agent.session.new, { cwd: d.project, mcpServers: [] });
	const response = await ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "make x" }] });
	assert.equal(response.stopReason, "end_turn");
	assert.equal(harness.api("t").openRequests(sessionId).length, 0);
	const entries = harness.api("t").history(sessionId);
	assert.ok(entries.some((e) => e.kind === "inputAnswer" && (e.data as { reason?: string }).reason === "timeLimit"));
	assert.equal(existsSync(join(d.project, "x.txt")), false);
	answer("allow");
	await harness.api("t").waitForIdle(sessionId);
	await new Promise((r) => setTimeout(r, 20));
	await harness.api("t").waitForIdle(sessionId);
	assert.equal(existsSync(join(d.project, "x.txt")), false, "the late allow must not run the call");
	connection.close();
	await harness.stop();
});

test("ACP: session/load replays the history; the session's cwd is where tools run", async (t) => {
	const d = testDirs(t);
	const other = testTempDir(t, "ma-cwd-");
	const first = await setup(t, [fauxAssistantMessage([fauxToolCall("write", { path: "here.txt", content: "x" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("Wrote it.")])], { d });
	await first.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
	const { sessionId } = await first.ctx.request(methods.agent.session.new, { cwd: other, mcpServers: [] });
	await first.ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "write here.txt" }] });
	assert.ok(existsSync(join(other, "here.txt")), "write ran in the session's cwd");
	first.connection.close();
	await first.harness.stop();

	const second = await setup(t, [], { d });
	await second.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
	const listed = await second.ctx.request(methods.agent.session.list, {});
	assert.ok(listed.sessions.some((s) => s.sessionId === sessionId));
	await second.ctx.request(methods.agent.session.load, { sessionId, cwd: other, mcpServers: [] });
	const k = kinds(second.updates);
	assert.ok(k.includes("user_message_chunk") && k.includes("agent_message_chunk") && k.includes("tool_call_update"), k.join(","));
	second.connection.close();
	await second.harness.stop();
});

test("ACP: a slash command is handled without the model", async (t) => {
	const { d, harness, ctx, updates, connection } = await setup(t, [], { plugins: [{
		name: "test-command",
		setup(api) { api.registerCommand("hello", { description: "Say hello", run: () => "Hello from the command." }); },
	}] });
	await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
	const { sessionId } = await ctx.request(methods.agent.session.new, { cwd: d.project, mcpServers: [] });
	const response = await ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "/hello" }] });
	assert.equal(response.stopReason, "end_turn");
	await new Promise((r) => setTimeout(r, 10));
	const available = updates.flatMap(({ update }) => update.sessionUpdate === "available_commands_update" ? update.availableCommands.map(c => c.name) : []);
	assert.ok(available.includes("hello"));
	assert.ok(!available.includes("approvals"));
	assert.ok(updates.some(({ update }) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && update.content.text === "Hello from the command."));
	connection.close();
	await harness.stop();
});
