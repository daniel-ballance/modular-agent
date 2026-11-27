import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelRequest, StreamEvent } from "../data.js";
import { Cancelled, ClaudeProvider, loginVisible } from "../provider.js";
import { requestProblem } from "../serve.js";
import { createFake } from "../testing/fake-sdk.js";
import { ToolBridge, wireNames } from "../tools.js";

const TOOL = { name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } };

function setup(account?: Record<string, unknown>, env: NodeJS.ProcessEnv = { HOME: "/nowhere", PATH: "/usr/bin", ANTHROPIC_API_KEY: "must-not-pass", CLAUDECODE: "1" }) {
	const fake = createFake(account);
	const provider = new ClaudeProvider({ version: "9.9.9", sdkVersion: "fake", query: fake.query, env, loginVisible: () => true });
	const model = provider.model("claude-haiku-5-5")!;
	return { provider, model, log: fake.log };
}

const request = (text: string, extra: Partial<ModelRequest> = {}): ModelRequest => ({
	systemPrompt: "Be terse.", messages: [{ role: "user", content: [{ type: "text", text }] }], tools: [TOOL], settings: {}, ...extra,
});

test("the SDK is configured as a plain model endpoint", async () => {
	const { provider, model, log } = setup();
	await provider.infer(model, request("hi", { settings: { reasoning: "medium", maxOutput: 999_999 } }), new AbortController().signal, () => {});
	const options = log.started[0];
	assert.equal(options.systemPrompt, "Be terse.");
	assert.equal(options.model, "claude-haiku-5-5");
	assert.deepEqual(options.tools, []);
	assert.deepEqual(options.settingSources, []);
	assert.equal(options.strictMcpConfig, true);
	assert.equal(options.persistSession, false);
	assert.deepEqual(options.skills, []);
	assert.deepEqual(options.settings, { autoCompactEnabled: false, idleCompaction: false, autoMemoryEnabled: false, disableBundledSkills: true });
	assert.deepEqual(Object.keys(options.mcpServers!), ["host"]);
	assert.deepEqual(options.allowedTools, ["mcp__host"]);
	assert.deepEqual(options.toolAliases, { get_weather: "mcp__host__get_weather" });
	assert.deepEqual(options.thinking, { type: "adaptive", display: "summarized" });
	assert.equal(options.effort, "medium");
	assert.equal(options.agents, undefined);
	assert.equal(options.hooks, undefined);
	// The subscription env: no API key, no parent session, the cap clamped to the model's limit.
	assert.equal(options.env!.ANTHROPIC_API_KEY, undefined);
	assert.equal(options.env!.CLAUDECODE, undefined);
	assert.equal(options.env!.HOME, "/nowhere");
	assert.equal(options.env!.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "128000");
	assert.equal(options.env!.CLAUDE_AGENT_SDK_CLIENT_APP, "modular-agent-claude-sidecar/9.9.9");
	assert.equal(options.env!.DISABLE_PROMPT_CACHING, undefined);
	assert.equal(log.closed, 1);
});

test("a request without tools or settings offers no MCP server and sets no thinking", async () => {
	const { provider, model, log } = setup();
	await provider.infer(model, request("hi", { tools: [] }), new AbortController().signal, () => {});
	const options = log.started[0];
	assert.deepEqual(options.mcpServers, {});
	assert.deepEqual(options.allowedTools, []);
	assert.equal("thinking" in options, false);
	assert.equal("effort" in options, false);
	assert.equal(options.env!.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined);
});

test("text and thinking stream, and the message carries usage", async () => {
	const { provider, model } = setup();
	const events: StreamEvent[] = [];
	const message = await provider.infer(model, request("hi"), new AbortController().signal, (e) => events.push(e));
	const said = "model=claude-haiku-5-5 effort=default system=Be terse. said=hi";
	assert.deepEqual(events, [{ type: "reasoning", delta: "pondering" }, { type: "text", delta: said.slice(0, 8) }, { type: "text", delta: said.slice(8) }]);
	assert.deepEqual(message, {
		role: "assistant",
		content: [{ type: "reasoning", text: "pondering" }, { type: "text", text: said }],
		stop: "finished",
		usage: { input: 11, output: 34, cacheRead: 5, cacheWrite: 3, cost: 0 },
		model: { provider: "claude", id: "claude-haiku-5-5" },
	});
});

test("a tool call ends the request with toolUse and closes Claude Code", async () => {
	const { provider, model, log } = setup();
	const events: StreamEvent[] = [];
	const message = await provider.infer(model, request("[fake:tool]"), new AbortController().signal, (e) => events.push(e));
	assert.equal(message.stop, "toolUse");
	assert.deepEqual(message.content, [
		{ type: "reasoning", text: "pondering" },
		{ type: "toolCall", id: "toolu_fake_1", name: "get_weather", arguments: { city: "Paris" } },
	]);
	assert.deepEqual(message.usage, { input: 11, output: 21, cacheRead: 5, cacheWrite: 3, cost: 0 });
	assert.deepEqual(events.filter((e) => e.type === "toolInput"), [
		{ type: "toolInput", delta: "{\"city\":", toolCallId: "toolu_fake_1" },
		{ type: "toolInput", delta: "\"Paris\"}", toolCallId: "toolu_fake_1" },
	]);
	assert.equal(log.closed, 1);
});

test("the conversation with its tool result is what the next request shows Claude", async () => {
	const { provider, model, log } = setup();
	await provider.infer(model, request("unused", { messages: [
		{ role: "user", content: [{ type: "text", text: "Weather in Paris?" }] },
		{ role: "assistant", stop: "toolUse", content: [{ type: "toolCall", id: "c1", name: "get_weather", arguments: { city: "Paris" } }] },
		{ role: "toolResult", toolCallId: "c1", toolName: "get_weather", isError: false, content: [{ type: "text", text: "18C" }] },
	] }), new AbortController().signal, () => {});
	assert.match(log.prompts[0], /Weather in Paris\?/);
	assert.match(log.prompts[0], /id="c1" name="get_weather" status="ok">\n18C\n/);
	assert.equal(log.started[0].env!.DISABLE_PROMPT_CACHING, "1");
});

test("model-service failures are failed messages with an error", async () => {
	const signal = new AbortController().signal;
	const auth = await setup().provider.infer(setup().model, request("[fake:auth]"), signal, () => {});
	assert.equal(auth.stop, "failed");
	assert.equal(auth.error?.kind, "credentials");
	assert.match(auth.error!.message, /Invalid authentication credentials/);
	const exit = await setup().provider.infer(setup().model, request("[fake:exit]"), signal, () => {});
	assert.equal(exit.stop, "failed");
	assert.deepEqual(exit.error, { kind: "other", message: "Claude Code exited before the turn finished." });
	const length = await setup().provider.infer(setup().model, request("[fake:length]"), signal, () => {});
	assert.equal(length.stop, "length");
	assert.equal(length.error, undefined);
});

test("a login that is not a subscription fails before any prompt is sent", async () => {
	const { provider, model, log } = setup({ apiKeySource: "user" });
	assert.equal(provider.available(), true);
	const message = await provider.infer(model, request("hi"), new AbortController().signal, () => {});
	assert.equal(message.stop, "failed");
	assert.equal(message.error?.kind, "credentials");
	assert.deepEqual(log.prompts, []);
	assert.equal(log.closed, 1);
	assert.equal(provider.available(), false);
});

test("cancelling closes the query promptly and yields no message", async () => {
	const { provider, model, log } = setup();
	const abort = new AbortController();
	const events: StreamEvent[] = [];
	const pending = provider.infer(model, request("[fake:slow]"), abort.signal, (e) => {
		events.push(e);
		abort.abort();
	});
	await assert.rejects(pending, Cancelled);
	assert.deepEqual(events, [{ type: "text", delta: "working" }]);
	assert.equal(log.closed, 1);
	const already = new AbortController();
	already.abort();
	await assert.rejects(provider.infer(model, request("hi"), already.signal, () => {}), Cancelled);
	assert.equal(log.started.length, 1);
});

test("the model list narrows to what Claude Code reports", async () => {
	const { provider } = setup();
	assert.equal(provider.catalog().length, 18);
	await provider.refresh();
	assert.deepEqual(provider.catalog().map((m) => m.id), ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-nova-9"]);
	assert.equal(provider.catalog()[0].contextWindow, 200_000);
	assert.equal(provider.model("claude-opus-5"), undefined);
});

test("readiness and a request finish while the probe is still reading context windows", async (t) => {
	let reading!: () => void, release!: () => void;
	const started = new Promise<void>((resolve) => { reading = resolve; });
	const windows = new Promise<void>((resolve) => { release = resolve; });
	const fake = createFake(undefined, () => { reading(); return windows; });
	const changes: number[] = [];
	const id = "claude-haiku-5-5";
	const provider = new ClaudeProvider({
		version: "9.9.9", sdkVersion: "fake", query: fake.query, env: {}, loginVisible: () => true,
		onChange: () => changes.push(provider.model(id)!.contextWindow),
	});
	t.after(() => { provider.close(); release(); });

	let available: boolean | undefined;
	const ready = provider.ready().then((answer) => { available = answer; });
	await started;
	// Let readiness settle without releasing the window read.
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(available, true);
	await ready;
	assert.equal(provider.model(id)!.contextWindow, 1_000_000);
	assert.equal(fake.log.closed, 0);
	assert.equal(fake.log.started.length, 1);
	const message = await provider.infer(provider.model("claude-nova-9")!, request("hi"), new AbortController().signal, () => {});
	assert.equal(message.stop, "finished");
	assert.equal(fake.log.closed, 1);

	const refreshed = provider.refresh();
	release();
	await refreshed;
	assert.equal(provider.model(id)!.contextWindow, 200_000);
	assert.equal(changes.at(-1), 200_000);
	assert.equal(fake.log.closed, 2);
});

for (const end of ["close", "deadline"] as const) {
	test(`the probe closes on ${end} even when a context read does not answer`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let reading!: () => void;
		const started = new Promise<void>((resolve) => { reading = resolve; });
		let reads = 0;
		const fake = createFake(undefined, () => {
			reads++;
			reading();
			return new Promise<void>(() => {});
		});
		const provider = new ClaudeProvider({ version: "9.9.9", sdkVersion: "fake", query: fake.query, env: {}, loginVisible: () => true });
		t.after(() => provider.close());

		const refreshed = provider.refresh();
		assert.equal(await provider.ready(), true);
		await started;
		if (end === "close") {
			provider.close();
			await assert.rejects(refreshed, Cancelled);
			assert.equal(await provider.ready(), false);
		} else {
			t.mock.timers.tick(30_000);
			await assert.rejects(refreshed, /did not answer in time/);
			assert.equal(await provider.ready(), true);
		}
		assert.equal(fake.log.closed, 1);
		assert.equal(reads, 1);
	});
}

test("a login is seen from the environment without opening a file", () => {
	const none = (): boolean => false;
	assert.equal(loginVisible({}, none, "linux"), false);
	assert.equal(loginVisible({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, none, "linux"), true);
	assert.equal(loginVisible({ HOME: "/h" }, (p) => p === "/h/.claude/.credentials.json", "linux"), true);
	assert.equal(loginVisible({ HOME: "/h", CLAUDE_CONFIG_DIR: "/c" }, (p) => p === "/h/.claude/.credentials.json", "linux"), false);
	assert.equal(loginVisible({ CLAUDE_CONFIG_DIR: "/c" }, (p) => p === "/c/.credentials.json", "linux"), true);
	assert.equal(loginVisible({ HOME: "/h" }, (p) => p === "/h/.claude.json", "linux"), false);
	assert.equal(loginVisible({ HOME: "/h" }, (p) => p === "/h/.claude.json", "darwin"), true);
});

test("tool names map to MCP names and back", () => {
	assert.deepEqual([...wireNames(["read", "a.b", "a_b"])], [["read", "read"], ["a.b", wireNames(["a.b", "a_b"]).get("a.b")!], ["a_b", "a_b"]]);
	assert.match(wireNames(["a.b", "a_b"]).get("a.b")!, /^a_b_[0-9a-f]{8}$/);
	const bridge = new ToolBridge([TOOL, { name: "fs.read", description: "", parameters: true }]);
	assert.equal(bridge.hostName("mcp__host__get_weather"), "get_weather");
	assert.equal(bridge.hostName("get_weather"), "get_weather");
	assert.equal(bridge.hostName("mcp__host__fs_read"), "fs.read");
	assert.equal(bridge.hostName("Bash"), undefined);
	assert.equal(bridge.hostName("mcp__host__nope"), undefined);
});

test("a malformed ModelRequest is named", () => {
	assert.equal(requestProblem(request("hi")), undefined);
	assert.match(requestProblem({ ...request("hi"), systemPrompt: 1 })!, /systemPrompt/);
	assert.match(requestProblem({ ...request("hi"), messages: [{ role: "system", content: [] }] })!, /role/);
	assert.match(requestProblem({ ...request("hi"), tools: [TOOL, TOOL] })!, /distinct/);
});
