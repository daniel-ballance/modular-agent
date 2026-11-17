import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, type FauxResponseStep } from "@earendil-works/pi-ai";
import { type Harness, type Plugin, type PluginApi, text, textOf } from "@modular-agent/harness";
import { createAgent } from "../src/index.js";

const dirs = () => ({ project: mkdtempSync(join(tmpdir(), "ma-p-")), home: mkdtempSync(join(tmpdir(), "ma-h-")) });
async function agent(responses: FauxResponseStep[], plugins: Plugin[]): Promise<Harness> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	return createAgent({ ...dirs(), models, model: "faux/faux-1", plugins });
}
const lastText = (h: Harness, s: string) => (h.api("t").history(s).filter((e) => e.kind === "turnEnd").at(-1)!.data as { result: { text?: string } }).result.text;

test("a plugin checking the turn's result sends the model back", async () => {
	const checker: Plugin = {
		name: "must-cite",
		setup(api) {
			api.on("turn.result", (p: { result: { text?: string } }) => (p.result.text?.includes("[source]") ? undefined : { refuse: "Cite a source, marked [source]." }));
		},
	};
	let sawCheck = "";
	const h = await agent([
		fauxAssistantMessage([fauxText("The sky is blue.")]),
		(c) => {
			sawCheck = textOf(c.messages.at(-1)!.content as never);
			return fauxAssistantMessage([fauxText("The sky is blue [source].")]);
		},
	], [checker]);
	const api = h.api("t");
	const s = await api.startSession();
	await api.input(s, { content: "what colour is the sky?", actorId: "user" });
	await api.waitForIdle(s);
	assert.equal(sawCheck, "Cite a source, marked [source].", "the model was told why it was sent back");
	assert.equal(lastText(h, s), "The sky is blue [source].");
	assert.equal(api.history(s).filter((e) => e.kind === "turnEnd").length, 1, "still one turn");
	await h.stop();
});

test("a plugin defines a hook point for others, and only it may run it", async () => {
	let owner!: PluginApi;
	let stranger!: PluginApi;
	const linter: Plugin = { name: "linter", setup(api) { owner = api; api.defineHook("lint.rules", "collect"); } };
	const style: Plugin = { name: "style-rules", setup(api) { api.on("lint.rules", () => "no tabs"); } };
	const safety: Plugin = { name: "safety-rules", setup(api) { api.on("lint.rules", () => "no eval"); stranger = api; } };
	const h = await agent([], [linter, style, safety]);
	assert.deepEqual(await owner.runHook("lint.rules", {}), ["no tabs", "no eval"], "every handler's answer, in load order");
	await assert.rejects(stranger.runHook("lint.rules", {}), /safety-rules can't run lint\.rules: it belongs to linter/);
	await assert.rejects(stranger.runHook("provider.request", {}), /belongs to provider/);
	await h.stop();
});

test("a UI starts a tool call itself: the same checks apply, and it is recorded", async () => {
	const seenBefore: string[] = [];
	const tools: Plugin = {
		name: "ui-tools",
		setup(api) {
			api.provide("tool-source", {
				id: "ui-tools",
				tools: () => [
					{ name: "refresh", description: "refresh the view", parameters: { type: "object", properties: {} }, callers: ["model", "ui"] },
					{ name: "model_only", description: "x", parameters: { type: "object", properties: {} }, callers: ["model"] },
				],
				run: async () => ({ status: "completed", content: [text("refreshed")] }),
			});
			api.on("tool.before", (p: { call: { name: string; startedBy: string } }) => {
				seenBefore.push(`${p.call.name}:${p.call.startedBy}`);
				return undefined;
			});
		},
	};
	const h = await agent([], [tools]);
	const api = h.api("t");
	const s = await api.startSession();
	const ok = await api.callTool(s, { name: "refresh", input: {}, startedBy: "ui", actorId: "user" });
	assert.equal(ok.status, "completed");
	assert.equal(textOf(ok.content), "refreshed");
	assert.deepEqual(seenBefore, ["refresh:ui"], "the tool.before check ran for a UI's call");
	const refused = await api.callTool(s, { name: "model_only", input: {}, startedBy: "ui", actorId: "user" });
	assert.equal(refused.status, "refused");
	const recorded = api.history(s, { all: true }).filter((e) => e.kind === "toolCallOutsideTurn");
	assert.equal(recorded.length, 2, "both are recorded, with who started them");
	assert.equal((recorded[0].data as { call: { startedBy: string } }).call.startedBy, "ui");
	await h.stop();
});
