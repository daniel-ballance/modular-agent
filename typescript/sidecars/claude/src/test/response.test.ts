import assert from "node:assert/strict";
import { test } from "node:test";
import type { StreamEvent } from "../data.js";
import { Response, errorKind, scrub, stopFor } from "../response.js";

const MODEL = { provider: "claude", id: "claude-haiku-5-5" };
const names = (called: string): string | undefined => called === "mcp__host__get_weather" ? "get_weather" : undefined;

function build(events: unknown[]): { response: Response; emitted: StreamEvent[]; completed: boolean[] } {
	const emitted: StreamEvent[] = [];
	const response = new Response(MODEL, (e) => emitted.push(e), names);
	const completed = events.map((e) => response.apply(e as never));
	return { response, emitted, completed };
}

const start = { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 } } };

test("text and thinking stream and end up in the message with usage", () => {
	const { response, emitted, completed } = build([
		start,
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hel" } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "lo" } },
		{ type: "content_block_stop", index: 1 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
		{ type: "message_stop" },
	]);
	assert.deepEqual(emitted, [{ type: "reasoning", delta: "hm" }, { type: "text", delta: "Hel" }, { type: "text", delta: "lo" }]);
	assert.equal(completed.at(-1), true);
	assert.deepEqual(response.finish(stopFor(response.rawStopReason)), {
		role: "assistant",
		content: [{ type: "reasoning", text: "hm" }, { type: "text", text: "Hello" }],
		stop: "finished",
		usage: { input: 10, output: 7, cacheRead: 4, cacheWrite: 2, cost: 0 },
		model: MODEL,
	});
});

test("a tool call carries the host's name, the model's id and parsed arguments", () => {
	const { response, emitted } = build([
		start,
		{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__host__get_weather", input: {} } },
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"city\":" } },
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "\"Paris\"}" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
		{ type: "message_stop" },
	]);
	assert.deepEqual(emitted, [
		{ type: "toolInput", delta: "{\"city\":", toolCallId: "toolu_1" },
		{ type: "toolInput", delta: "\"Paris\"}", toolCallId: "toolu_1" },
	]);
	assert.equal(response.rawStopReason, "tool_use");
	assert.deepEqual(response.calledTools, ["toolu_1"]);
	const message = response.finish("toolUse");
	assert.equal(message.stop, "toolUse");
	assert.equal(message.error, undefined);
	assert.deepEqual(message.content, [{ type: "toolCall", id: "toolu_1", name: "get_weather", arguments: { city: "Paris" } }]);
});

test("a tool call with no input has empty arguments", () => {
	const { response } = build([
		start,
		{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__host__get_weather", input: {} } },
		{ type: "content_block_stop", index: 0 },
	]);
	assert.deepEqual(response.finish("toolUse").content, [{ type: "toolCall", id: "toolu_1", name: "get_weather", arguments: {} }]);
});

test("a call to a tool the host did not offer is not passed on", () => {
	const { response, emitted } = build([
		start,
		{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} } },
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
		{ type: "message_stop" },
	]);
	assert.deepEqual(emitted, []);
	assert.deepEqual(response.calledTools, []);
	assert.deepEqual(response.finish("finished").content, []);
});

test("a tool call cut off by the output limit is dropped; one that cannot be read fails a toolUse stop", () => {
	const cut = [
		start,
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__host__get_weather", input: {} } },
		{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"city\":\"Pa" } },
	];
	const length = build(cut).response.finish("length");
	assert.deepEqual(length.content, [{ type: "text", text: "ok" }]);
	assert.equal(length.stop, "length");
	const bad = build([...cut, { type: "content_block_stop", index: 1 }]).response.finish("toolUse");
	assert.equal(bad.stop, "failed");
	assert.equal(bad.error?.kind, "other");
	assert.deepEqual(bad.content, [{ type: "text", text: "ok" }]);
});

test("a second API message in the same turn appends, and its output adds up", () => {
	const { response } = build([
		start,
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "one" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
		{ type: "message_stop" },
		{ type: "message_start", message: { usage: { input_tokens: 30, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "two" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } },
		{ type: "message_stop" },
	]);
	const message = response.finish("finished");
	assert.deepEqual(message.content, [{ type: "text", text: "one" }, { type: "text", text: "two" }]);
	assert.deepEqual(message.usage, { input: 30, output: 11, cacheRead: 0, cacheWrite: 0, cost: 0 });
});

test("thinking whose text is withheld streams nothing and leaves no part", () => {
	const { response, emitted } = build([
		start,
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "x" } },
		{ type: "content_block_stop", index: 1 },
		{ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 2 },
	]);
	assert.deepEqual(emitted, [{ type: "text", delta: "ok" }]);
	assert.deepEqual(response.finish("finished").content, [{ type: "text", text: "ok" }]);
});

test("stop reasons", () => {
	assert.equal(stopFor("end_turn"), "finished");
	assert.equal(stopFor("stop_sequence"), "finished");
	assert.equal(stopFor(undefined), "finished");
	assert.equal(stopFor("max_tokens"), "length");
	assert.equal(stopFor("refusal"), "refused");
});

test("a failed message carries its error and whatever was produced", () => {
	const { response } = build([start, { type: "content_block_start", index: 0, content_block: { type: "text", text: "part" } }]);
	const message = response.finish("failed", { kind: "temporary", message: "overloaded" });
	assert.equal(message.stop, "failed");
	assert.deepEqual(message.error, { kind: "temporary", message: "overloaded" });
	assert.deepEqual(message.content, [{ type: "text", text: "part" }]);
});

test("error kinds", () => {
	assert.equal(errorKind("authentication_failed", "x"), "credentials");
	assert.equal(errorKind("oauth_org_not_allowed", "x"), "credentials");
	assert.equal(errorKind("rate_limit", "x"), "temporary");
	assert.equal(errorKind("overloaded", "x"), "temporary");
	assert.equal(errorKind("server_error", "x"), "temporary");
	assert.equal(errorKind("invalid_request", "Prompt is too long: 250000 tokens"), "contextTooLarge");
	assert.equal(errorKind("invalid_request", "bad schema"), "other");
	assert.equal(errorKind("billing_error", "x"), "other");
	assert.equal(errorKind(undefined, "Claude Code exited before the turn finished."), "other");
	assert.equal(errorKind(undefined, "API Error: 529 overloaded"), "temporary");
});

test("token-like text is cut out of errors", () => {
	const scrubbed = scrub(`bad sk-ant-oat01-abcDEF_123 and ${"a".repeat(80)} end`);
	assert.equal(scrubbed, "bad [redacted] and [redacted] end");
});
