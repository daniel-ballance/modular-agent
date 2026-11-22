// Plays the host over stdio against the built sidecar, with the scripted fake in place of the
// Agent SDK (CLAUDE_SIDECAR_TEST_FAKE_SDK). No model is reached.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ModelInfo } from "../data.js";
import { WireError, WirePeer } from "../wire.js";

const MAIN = fileURLToPath(new URL("../main.js", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "claude-sidecar-test-"));
const children = new Set<ChildProcess>();
after(() => {
	for (const child of children) if (child.exitCode === null) child.kill();
	rmSync(scratch, { recursive: true, force: true });
});

interface Host {
	peer: WirePeer;
	child: ChildProcess;
	/** Everything the plugin sent, in arrival order. */
	seen: { kind: string; parent?: unknown; value: any }[];
	stdout: string[];
	stderr: () => string;
	init: typeof INIT;
	probeClosed: Promise<void>;
	/** Changes the request at the provider.request hook. */
	transform?: (payload: any) => any;
	exited: Promise<number | null>;
}

function start(fake = "1"): Host {
	// The minimal environment a host gives a plugin: PATH and what the launch configuration adds. No HOME.
	const child = spawn(process.execPath, [MAIN], { env: { PATH: process.env.PATH ?? "", CLAUDE_SIDECAR_TEST_FAKE_SDK: fake }, stdio: ["pipe", "pipe", "pipe"] });
	children.add(child);
	let stderr = "";
	const probeClosed = new Promise<void>((resolve) => child.stderr!.on("data", (d) => {
		stderr += String(d);
		if (stderr.includes("[fake-sdk] probe closed\n")) resolve();
	}));
	const host: Host = {
		peer: new WirePeer((line) => void child.stdin!.write(line)),
		child, seen: [], stdout: [], stderr: () => stderr, probeClosed,
		init: { ...INIT, home: mkdtempSync(join(scratch, "home-")) },
		exited: new Promise((resolve) => child.on("close", (code) => resolve(code))),
	};
	child.stdout!.on("data", (d: Buffer) => {
		host.stdout.push(String(d));
		host.peer.feed(d);
	});
	host.peer.handle("host/hook", async (p) => {
		host.seen.push({ kind: `hook:${p.hook}`, parent: p.parentRequestId, value: p.payload });
		if (p.hook === "provider.request") return host.transform ? host.transform(p.payload) : p.payload;
		return null;
	});
	host.peer.onNotification("provider/event", (p) => host.seen.push({ kind: "event", parent: p.parentRequestId, value: p.event }));
	return host;
}

const INIT = { binding: "modular-agent-plugin/1", data: "modular-agent-data/1", host: { name: "test-host", version: "0" }, project: scratch, home: join(scratch, "home"), config: {} };
const TOOL = { name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } };
const MODEL = { provider: "claude", id: "claude-haiku-5-5" };
const ask = (text: string) => ({ provider: "claude", model: MODEL, sessionId: "s1", request: { systemPrompt: "Be terse.", messages: [{ role: "user", content: [{ type: "text", text }] }], tools: [TOOL], settings: { reasoning: "low" } } });

async function stop(host: Host): Promise<void> {
	assert.deepEqual(await host.peer.request("plugin/shutdown", { reason: "stop" }), {});
	host.child.stdin!.end();
	assert.equal(await host.exited, 0);
	// stdout carried nothing but protocol frames.
	for (const line of host.stdout.join("").split("\n").filter(Boolean)) assert.equal(JSON.parse(line).jsonrpc, "2.0");
}

const wireError = async (p: Promise<unknown>): Promise<WireError> => {
	const error = await p.then(() => undefined, (e) => e);
	assert.ok(error instanceof WireError, "expected a protocol error");
	return error;
};

test("handshake, catalog and availability", async () => {
	const host = start();
	assert.equal((await wireError(host.peer.request("provider/models", { provider: "claude" }))).code, "invalid_request");
	assert.equal((await wireError(host.peer.request("plugin/initialize", { ...INIT, binding: "modular-agent-plugin/9" }))).code, "not_supported");
	assert.deepEqual(await host.peer.request("$/ping", {}), {});
	const registration = await host.peer.request("plugin/initialize", host.init);
	assert.equal(registration.binding, "modular-agent-plugin/1");
	assert.equal(registration.name, "claude-agent-sdk");
	assert.equal(registration.providers.length, 1);
	assert.equal(registration.providers[0].id, "claude");
	assert.deepEqual(registration.providers[0].supports, { keepsState: false, runsTools: false, safeToRepeat: false });
	assert.ok(registration.providers[0].models.some((m: any) => m.id === "claude-haiku-5-5" && m.provider === "claude"));
	assert.deepEqual(Object.keys(registration).sort(), ["binding", "name", "providers"]);
	assert.equal((await wireError(host.peer.request("plugin/initialize", INIT))).code, "invalid_request");

	// The probe closes after reading the account's context windows.
	await host.probeClosed;
	const { models } = await host.peer.request<{ models: ModelInfo[] }>("provider/models", { provider: "claude" });
	assert.deepEqual(models.map((m) => m.id), ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-nova-9"]);
	assert.deepEqual(models[1], { provider: "claude", id: "claude-haiku-5-5", name: "Claude Haiku 5.5", contextWindow: 200000, maxOutput: 128000, input: ["text", "image"], reasoning: true, thinking: ["off", "low", "medium", "high", "xhigh"] });

	assert.deepEqual(await host.peer.request("provider/available", { provider: "claude" }), { available: true });
	assert.equal((await wireError(host.peer.request("provider/available", { provider: "other" }))).code, "invalid_request");
	assert.equal((await wireError(host.peer.request("provider/models", { provider: "other" }))).code, "invalid_request");
	const unknown = await wireError(host.peer.request("tools/list", { toolSource: "x" }));
	assert.equal(unknown.rpcCode, -32601);
	assert.deepEqual(await host.peer.request("provider/discard", { provider: "claude", sessionId: "s1" }), {});
	assert.deepEqual(Object.keys(await host.peer.request("provider/discard", { provider: "claude", sessionId: "s1", erase: true, entryIds: ["e1"] })), ["outOfReach"]);
	await stop(host);
});

for (const [mode, detail] of [["signed-out", ""], ["api-key", " (it is using an API key from user)"]]) {
	test(`Claude Code in ${mode} mode reports why it is unavailable`, async () => {
		const host = start(mode);
		await host.peer.request("plugin/initialize", host.init);
		assert.deepEqual(await host.peer.request("provider/available", { provider: "claude" }), {
			available: false,
			reason: `Claude Code is not signed in with a Claude subscription${detail}. Run \`claude auth login\`, sign in with your Claude account, then try again.`,
		});
		await stop(host);
	});
}

test("a request: request hook, streamed pieces, response hook, then the same message as the result", async () => {
	const host = start();
	await host.peer.request("plugin/initialize", host.init);
	// The hook changes the request; inference must use what the hook answered.
	host.transform = (payload) => ({ ...payload, request: { ...payload.request, systemPrompt: "Changed by the hook." } });
	const params = ask("hello");
	const pending = host.peer.request("provider/request", params);
	const message = await pending;
	const mine = host.seen.filter((s) => s.parent === pending.id);
	assert.equal(mine.length, host.seen.length);
	assert.deepEqual(mine.map((s) => s.kind), ["hook:provider.request", "event", "event", "event", "hook:provider.response"]);
	assert.deepEqual(mine[0].value, { sessionId: "s1", provider: "claude", model: MODEL, request: params.request });
	const said = "model=claude-haiku-5-5 effort=low system=Changed by the hook. said=hello";
	assert.deepEqual(mine.slice(1, 4).map((s) => s.value), [{ type: "reasoning", delta: "pondering" }, { type: "text", delta: said.slice(0, 8) }, { type: "text", delta: said.slice(8) }]);
	assert.deepEqual(mine[4].value, { sessionId: "s1", provider: "claude", model: MODEL, message });
	assert.deepEqual(message, {
		role: "assistant",
		content: [{ type: "reasoning", text: "pondering" }, { type: "text", text: said }],
		stop: "finished",
		usage: { input: 11, output: 34, cacheRead: 5, cacheWrite: 3, cost: 0 },
		model: MODEL,
	});
	await stop(host);
});

test("a tool call comes back as toolUse; a sessionless request has a null session in its hooks", async () => {
	const host = start();
	await host.peer.request("plugin/initialize", host.init);
	const { sessionId: _none, ...sessionless } = ask("[fake:tool] call it");
	const pending = host.peer.request("provider/request", sessionless);
	const message = await pending;
	assert.equal(message.stop, "toolUse");
	assert.deepEqual(message.content.filter((p: any) => p.type === "toolCall"), [{ type: "toolCall", id: "toolu_fake_1", name: "get_weather", arguments: { city: "Paris" } }]);
	assert.equal(host.seen[0].value.sessionId, null);
	assert.equal(host.seen.at(-1)!.kind, "hook:provider.response");
	assert.equal(host.seen.at(-1)!.value.sessionId, null);
	assert.deepEqual(host.seen.filter((s) => s.kind === "event" && s.value.type === "toolInput").map((s) => s.value.toolCallId), ["toolu_fake_1", "toolu_fake_1"]);
	await stop(host);
	assert.match(host.stderr(), /\[fake-sdk\] query closed/);
});

test("a model-service failure is a failed message, not a protocol error", async () => {
	const host = start();
	await host.peer.request("plugin/initialize", host.init);
	const message = await host.peer.request("provider/request", ask("[fake:auth]"));
	assert.equal(message.stop, "failed");
	assert.equal(message.error.kind, "credentials");
	assert.deepEqual(host.seen.map((s) => s.kind), ["hook:provider.request", "hook:provider.response"]);
	assert.deepEqual(host.seen[1].value.message, message);
	await stop(host);
});

test("invalid requests are refused before the hook", async () => {
	const host = start();
	await host.peer.request("plugin/initialize", host.init);
	const bad = [
		{ ...ask("x"), provider: "other" },
		{ ...ask("x"), model: { provider: "other", id: "claude-haiku-5-5" } },
		{ ...ask("x"), model: { provider: "claude", id: "nope" } },
		{ ...ask("x"), request: { systemPrompt: "x" } },
	];
	for (const params of bad) {
		const error = await wireError(host.peer.request("provider/request", params));
		assert.equal(error.code, "invalid_request");
		assert.equal(error.rpcCode, -32602);
	}
	assert.deepEqual(host.seen, []);
	await stop(host);
});

test("a refused request hook ends the request with the host's error and no inference", async () => {
	const host = start();
	await host.peer.request("plugin/initialize", host.init);
	host.transform = () => { throw new WireError("turn_limit", "steps", -32000, { limit: "steps" }); };
	const error = await wireError(host.peer.request("provider/request", ask("hello")));
	assert.equal(error.code, "turn_limit");
	assert.deepEqual(host.seen.map((s) => s.kind), ["hook:provider.request"]);
	await stop(host);
	assert.doesNotMatch(host.stderr(), /query closed/);
});

test("cancel aborts the SDK query and answers cancelled promptly", async () => {
	const host = start();
	await host.peer.request("plugin/initialize", host.init);
	const pending = host.peer.request("provider/request", ask("[fake:slow]"));
	// Wait for the first streamed piece, so the cancel lands mid-inference.
	for (let i = 0; i < 200 && !host.seen.some((s) => s.kind === "event"); i++) await new Promise((r) => setTimeout(r, 10));
	assert.ok(host.seen.some((s) => s.kind === "event"));
	const at = Date.now();
	host.peer.cancel(pending.id);
	host.peer.cancel(pending.id);
	const error = await wireError(pending);
	assert.equal(error.code, "cancelled");
	assert.ok(Date.now() - at < 2_000, "the answer to a cancel must be prompt");
	assert.ok(!host.seen.some((s) => s.kind === "hook:provider.response"));
	// A cancel for a settled id is ignored, and the plugin still serves.
	host.peer.notify("$/cancel", { id: pending.id });
	assert.deepEqual(await host.peer.request("$/ping", {}), {});
	const next = await host.peer.request("provider/request", ask("after"));
	assert.equal(next.stop, "finished");
	await stop(host);
});

test("the plugin exits when the host closes stdin, even mid-request", async () => {
	const host = start();
	await host.peer.request("plugin/initialize", host.init);
	const pending = host.peer.request("provider/request", ask("[fake:slow]"));
	pending.catch(() => {});
	for (let i = 0; i < 200 && !host.seen.some((s) => s.kind === "event"); i++) await new Promise((r) => setTimeout(r, 10));
	host.child.stdin!.end();
	assert.equal(await host.exited, 0);
	assert.match(host.stderr(), /\[fake-sdk\] query closed/);
});
