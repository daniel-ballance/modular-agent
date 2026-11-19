import assert from "node:assert/strict";
import { test } from "node:test";
import { baselineModels, discoveredModels, modelInfo, nearestLevel, thinkingFor } from "../models.js";

const model = (id: string) => baselineModels().find((m) => m.id === id)!;

test("the built-in catalog is valid ModelInfo with distinct ids", () => {
	const infos = baselineModels().map(modelInfo);
	assert.equal(new Set(infos.map((m) => m.id)).size, infos.length);
	for (const info of infos) {
		assert.equal(info.provider, "claude");
		assert.ok(info.contextWindow > 0 && info.maxOutput > 0);
		assert.deepEqual(info.input, ["text", "image"]);
		assert.equal(info.reasoning, true);
		assert.ok(info.thinking!.every((l) => ["off", "minimal", "low", "medium", "high", "xhigh"].includes(l)));
	}
	assert.deepEqual(modelInfo(model("claude-haiku-5-5")).thinking, ["off", "low", "medium", "high", "xhigh"]);
	assert.deepEqual(modelInfo(model("claude-opus-5-5")).thinking, ["low", "medium", "high", "xhigh"]);
	assert.deepEqual(modelInfo(model("claude-haiku-4-5")).thinking, ["off", "minimal", "low", "medium", "high"]);
});

test("no level leaves thinking to Claude Code", () => {
	assert.deepEqual(thinkingFor(model("claude-haiku-5-5"), undefined), {});
});

test("adaptive models take the effort of the same name", () => {
	const haiku = model("claude-haiku-5-5");
	assert.deepEqual(thinkingFor(haiku, "off"), { thinking: { type: "disabled" } });
	for (const level of ["low", "medium", "high", "xhigh"] as const) {
		assert.deepEqual(thinkingFor(haiku, level), { thinking: { type: "adaptive", display: "summarized" }, effort: level });
	}
	// minimal is an accepted level on this model and runs at Claude's lowest effort.
	assert.deepEqual(thinkingFor(model("claude-opus-4-7"), "minimal"), { thinking: { type: "adaptive", display: "summarized" }, effort: "low" });
});

test("a level the model does not accept moves to the nearest accepted one", () => {
	assert.equal(nearestLevel(model("claude-haiku-5-5"), "minimal"), "low");
	assert.equal(nearestLevel(model("claude-opus-5-5"), "off"), "low");
	assert.equal(nearestLevel(model("claude-opus-4-6"), "xhigh"), "high");
	assert.equal(thinkingFor(model("claude-opus-5-5"), "off").effort, "low");
	assert.equal(thinkingFor(model("claude-opus-4-6"), "xhigh").effort, "high");
});

test("older models take a thinking budget", () => {
	const old = model("claude-haiku-4-5");
	assert.deepEqual(thinkingFor(old, "off"), { thinking: { type: "disabled" } });
	assert.deepEqual(thinkingFor(old, "minimal"), { thinking: { type: "enabled", budgetTokens: 1024, display: "summarized" } });
	assert.deepEqual(thinkingFor(old, "high"), { thinking: { type: "enabled", budgetTokens: 16384, display: "summarized" } });
	assert.deepEqual(thinkingFor(old, "xhigh"), { thinking: { type: "enabled", budgetTokens: 16384, display: "summarized" } });
});

test("the reported models narrow the list, and an unknown model gets conservative limits", () => {
	const found = discoveredModels([
		{ value: "default", resolvedModel: "claude-sonnet-5-5", displayName: "Default", description: "" },
		{ value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet", description: "" },
		{ value: "claude-nova-9", displayName: "Nova 9", description: "", supportedEffortLevels: ["low", "high", "max"] },
		{ value: "not-claude", displayName: "Other", description: "" },
	], baselineModels());
	assert.deepEqual(found.map((m) => m.id), ["claude-sonnet-5-5", "claude-nova-9"]);
	assert.deepEqual(found[0], model("claude-sonnet-5-5"));
	assert.deepEqual(found[1], { id: "claude-nova-9", name: "Claude Nova 9", contextWindow: 200_000, maxOutput: 32_000, adaptive: true, thinking: ["low", "high"] });
});
