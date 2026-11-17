import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { approval } from "@modular-agent/approval";
import type { Harness, InputRequest, Plugin, PluginApi } from "@modular-agent/harness";
import { durableRuntime } from "@modular-agent/runtime-durable";
import { subagents } from "@modular-agent/subagents";
import { createAgent } from "../src/index.js";

type Context = Parameters<FauxResponseFactory>[0];
const textOfMessage = (m: { content: unknown }) => (typeof m.content === "string" ? m.content : (m.content as { type: string; text?: string }[]).filter((p) => p.type === "text").map((p) => p.text).join(""));
const users = (c: Context) => c.messages.filter((m) => m.role === "user").map(textOfMessage);
const hasResult = (c: Context) => c.messages.some((m) => m.role === "toolResult");
const dirs = () => ({ project: mkdtempSync(join(tmpdir(), "ma-p-")), home: mkdtempSync(join(tmpdir(), "ma-h-")) });

/** One model for every session: what it says depends on the conversation it is shown. */
function router(child: (c: Context) => ReturnType<FauxResponseFactory>, delegateInput: Record<string, string | boolean>): FauxResponseFactory {
	return (c) => {
		const first = users(c)[0] ?? "";
		if (first === "count to three") return child(c);
		const report = users(c).find((u) => u.startsWith("[Job subagent"));
		if (report) return fauxAssistantMessage([fauxText(`Parent got: ${report.replace(/\s+/g, " ")}`)]);
		if (!hasResult(c)) return fauxAssistantMessage([fauxToolCall("delegate", delegateInput)], { stopReason: "toolUse" });
		const result = c.messages.filter((m) => m.role === "toolResult").map(textOfMessage).at(-1);
		return fauxAssistantMessage([fauxText(`Parent saw: ${result}`)]);
	};
}

async function agent(d: { project: string; home: string }, route: FauxResponseFactory, plugins: Plugin[]): Promise<Harness> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(Array.from({ length: 30 }, () => route));
	return createAgent({ ...d, models, model: "faux/faux-1", plugins });
}

const lastText = (h: Harness, s: string) => (h.api("t").history(s).filter((e) => e.kind === "turnEnd").at(-1)?.data as { result: { text?: string } } | undefined)?.result.text ?? "";
async function settle(h: Harness, s: string) {
	for (let i = 0; i < 5; i++) {
		await h.api("t").waitForIdle(s);
		await new Promise((r) => setTimeout(r, 20));
	}
}

test("a background subagent: its result arrives as a job report and wakes the parent", async () => {
	const h = await agent(dirs(), router(() => fauxAssistantMessage([fauxText("one two three")]), { task: "count to three", label: "counter" }), [subagents()]);
	const api = h.api("t");
	const s = await api.startSession();
	await api.input(s, { content: "please delegate", actorId: "user" });
	await settle(h, s);
	const report = api.history(s).find((e) => e.kind === "jobReport");
	assert.ok(report, "the job reported back");
	assert.match(lastText(h, s), /Parent got: \[Job subagent .* completed\] Subagent "counter" completed\. one two three/);
	const child = (api.history(s).find((e) => e.kind === "jobStarted")!.data as { detail: { childSessionId: string } }).detail.childSessionId;
	assert.notEqual(child, s);
	await h.stop();
});

test("a subagent with wait returns its answer in the call", async () => {
	const h = await agent(dirs(), router(() => fauxAssistantMessage([fauxText("one two three")]), { task: "count to three", wait: true }), [subagents()]);
	const api = h.api("t");
	const s = await api.startSession();
	await api.input(s, { content: "please delegate", actorId: "user" });
	await settle(h, s);
	assert.equal(lastText(h, s), "Parent saw: one two three");
	assert.ok(!api.history(s).some((e) => e.kind === "jobReport"), "no report: the answer came back in the call");
	await h.stop();
});

test("a subagent's approval goes to the parent, which passes it to its user", async () => {
	const d = dirs();
	const requests: InputRequest[] = [];
	let uiApi!: PluginApi;
	const ui: Plugin = { name: "ui", setup(a) { uiApi = a; a.provide("interface", { id: "ui", actorId: "user", onInputRequest: (r: InputRequest) => requests.push(r) }); } };
	const child = (c: Context) => (hasResult(c) ? fauxAssistantMessage([fauxText("made it")]) : fauxAssistantMessage([fauxToolCall("bash", { command: "echo child > child.txt" })], { stopReason: "toolUse" }));
	const h = await agent(d, router(child, { task: "count to three", wait: true }), [approval({ policy: "ask" }), subagents(), ui]);
	const api = h.api("t");
	const s = await api.startSession();
	await api.input(s, { content: "please delegate", actorId: "user" });
	for (let i = 0; i < 300 && !requests.length; i++) await new Promise((r) => setTimeout(r, 5));
	assert.equal(requests.length, 1);
	assert.equal(requests[0].sessionId, s, "the question was asked in the parent's session");
	assert.match(requests[0].question, /\[subagent .*\] Allow bash\?/);
	uiApi.answer(s, { requestId: requests[0].id, actorId: "user", value: "allow" });
	await settle(h, s);
	assert.ok(existsSync(join(d.project, "child.txt")));
	assert.equal(lastText(h, s), "Parent saw: made it");
	await h.stop();
});

/** Process 1: the parent delegates, and the process stops while the child's model request is still running. */
async function stopDuringChild(d: { project: string; home: string }) {
	let childStarted!: () => void;
	const started = new Promise<void>((r) => (childStarted = r));
	const hang = () => {
		childStarted();
		return new Promise<never>(() => undefined);
	};
	const h = await agent(d, router(hang, { task: "count to three", label: "counter" }), [subagents({ durable: true }), durableRuntime()]);
	const api = h.api("t");
	const s = await api.startSession();
	await api.input(s, { content: "please delegate", actorId: "user" });
	await started;
	await api.waitForIdle(s);
	await h.stop();
	return s;
}

test("transient subagents: after a restart, the parent hears the subagent's outcome is unknown", async () => {
	const d = dirs();
	const s = await stopDuringChild(d);
	const h = await agent(d, router(() => fauxAssistantMessage([fauxText("never asked")]), { task: "count to three" }), [subagents()]);
	const api = h.api("t");
	await api.openSession(s);
	await settle(h, s);
	assert.match(lastText(h, s), /outcomeUnknown\] Subagent "counter" was interrupted when the process stopped/);
	await h.stop();
});

test("durable subagents: after a restart, the subagent carries on and the parent gets its real result", async () => {
	const d = dirs();
	const s = await stopDuringChild(d);
	const h = await agent(d, router(() => fauxAssistantMessage([fauxText("one two three")]), { task: "count to three" }), [subagents({ durable: true }), durableRuntime()]);
	const api = h.api("t");
	await api.openSession(s);
	await settle(h, s);
	assert.match(lastText(h, s), /completed\] Subagent "counter" completed\. one two three/);
	const ended = api.history(s, { all: true }).filter((e) => e.kind === "jobEnded");
	assert.equal(ended.length, 1, "the job ended exactly once");
	await h.stop();
});

test("a subagent's subagent asks for approval: the question climbs to the top user", async () => {
	const d = dirs();
	const requests: InputRequest[] = [];
	let uiApi!: PluginApi;
	const ui: Plugin = { name: "ui", setup(a) { uiApi = a; a.provide("interface", { id: "ui", actorId: "user", onInputRequest: (r: InputRequest) => requests.push(r) }); } };
	const route: FauxResponseFactory = (c) => {
		const first = users(c)[0] ?? "";
		const done = hasResult(c);
		const last = c.messages.filter((m) => m.role === "toolResult").map(textOfMessage).at(-1);
		if (first === "grandchild task") return done ? fauxAssistantMessage([fauxText("grandchild wrote it")]) : fauxAssistantMessage([fauxToolCall("bash", { command: "echo deep > deep.txt" })], { stopReason: "toolUse" });
		if (first === "child task") return done ? fauxAssistantMessage([fauxText(`child relays: ${last}`)]) : fauxAssistantMessage([fauxToolCall("delegate", { task: "grandchild task", label: "grandchild", wait: true })], { stopReason: "toolUse" });
		return done ? fauxAssistantMessage([fauxText(`top relays: ${last}`)]) : fauxAssistantMessage([fauxToolCall("delegate", { task: "child task", label: "child", wait: true })], { stopReason: "toolUse" });
	};
	const h = await agent(d, route, [approval({ policy: "ask" }), subagents(), ui]);
	const api = h.api("t");
	const s = await api.startSession();
	await api.input(s, { content: "go deep", actorId: "user" });
	for (let i = 0; i < 400 && !requests.length; i++) await new Promise((r) => setTimeout(r, 5));
	assert.equal(requests.length, 1, "the top user is asked once");
	assert.equal(requests[0].sessionId, s);
	assert.match(requests[0].question, /^\[subagent "child"\] \[subagent "grandchild"\] Allow bash\?/);
	uiApi.answer(s, { requestId: requests[0].id, actorId: "user", value: "allow" });
	await settle(h, s);
	assert.ok(existsSync(join(d.project, "deep.txt")));
	assert.equal(lastText(h, s), "top relays: child relays: grandchild wrote it");
	await h.stop();
});

test("the parent can message a finished subagent again, and it remembers its earlier work", async () => {
	const seen: string[][] = [];
	const route: FauxResponseFactory = (c) => {
		const all = users(c);
		if (all[0] === "remember the number 7") {
			seen.push(all);
			return fauxAssistantMessage([fauxText(all.length > 1 ? "the number was 7" : "noted")]);
		}
		const results = c.messages.filter((m) => m.role === "toolResult").map(textOfMessage);
		if (results.length === 0) return fauxAssistantMessage([fauxToolCall("delegate", { task: "remember the number 7", label: "memory", wait: true })], { stopReason: "toolUse" });
		if (results.length === 1) return fauxAssistantMessage([fauxToolCall("delegate", { task: "what was the number?", subagent: "memory", wait: true })], { stopReason: "toolUse" });
		return fauxAssistantMessage([fauxText(`Parent saw: ${results.at(-1)}`)]);
	};
	const h = await agent(dirs(), route, [subagents()]);
	const api = h.api("t");
	const s = await api.startSession();
	await api.input(s, { content: "go", actorId: "user" });
	await settle(h, s);
	assert.equal(lastText(h, s), "Parent saw: the number was 7");
	assert.deepEqual(seen.at(-1), ["remember the number 7", "what was the number?"], "the follow-up reached the same child, with its history");
	const children = new Set(api.history(s, { all: true }).filter((e) => e.kind === "jobStarted").map((e) => (e.data as { detail: { childSessionId: string } }).detail.childSessionId));
	assert.equal(children.size, 1, "one child session, two jobs");
	await h.stop();
});
