import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { isToolCall, modelView, textOf } from "@modular-agent/harness";
import { createAgent } from "../src/index.js";

const read = (path: string) => fauxAssistantMessage([fauxToolCall("read", { path }, { id: path })], { stopReason: "toolUse" });

for (const trigger of ["threshold", "overflow", "command"] as const) {
	test(`single-turn compaction via ${trigger} keeps the newest tool round`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "ma-compact-"));
		const model = { id: "faux-1", contextWindow: trigger === "threshold" ? 2200 : 128_000 };
		const faux = fauxProvider({ models: [model] });
		const models = createModels();
		models.setProvider(faux.provider);
		const harness = await createAgent({ project: root, home: join(root, "home"), models, model: "faux/faux-1", ephemeral: true });
		t.after(async () => {
			await harness.stop();
			rmSync(root, { recursive: true, force: true });
		});
		writeFileSync(join(root, "old.txt"), "OLD-RESULT ".repeat(500));
		writeFileSync(join(root, "recent.txt"), "verbatim recent result");
		const goal = "Compare the two files and identify their purpose";
		const summarize: FauxResponseStep = (ctx) => {
			const request = JSON.stringify(ctx.messages);
			assert.ok(request.includes(goal) && request.includes("OLD-RESULT"));
			assert.ok(!request.includes("verbatim recent result"));
			return fauxAssistantMessage("Goal: compare the files. The old file was inspected.", {
				stopReason: trigger === "threshold" ? "length" : "stop",
			});
		};
		const answer: FauxResponseStep = (ctx) => {
			const request = JSON.stringify(ctx.messages);
			assert.ok(request.includes("Goal: compare the files") && request.includes("verbatim recent result"));
			assert.ok(!request.includes("OLD-RESULT"));
			assert.deepEqual(ctx.messages.map((m) => m.role), ["system", "user", "assistant", "toolResult"]);
			return fauxAssistantMessage("comparison complete");
		};
		const script: FauxResponseStep[] = [read("old.txt"), read("recent.txt")];
		if (trigger === "command") {
			script.push(fauxAssistantMessage("comparison complete"), summarize);
		} else {
			if (trigger === "overflow") script.push(fauxAssistantMessage([], { stopReason: "error", errorMessage: "prompt is too long: 300000 tokens > 200000 maximum" }));
			script.push(summarize, answer);
		}
		faux.setResponses(script);

		const api = harness.api("test");
		const session = await api.startSession();
		await api.input(session, { content: goal, actorId: "user" });
		await api.waitForIdle(session);
		const end = api.history(session).find((e) => e.kind === "turnEnd");
		assert.equal((end?.data as { outcome: { kind: string } }).outcome.kind, "completed", JSON.stringify(end?.data));
		if (trigger === "command") {
			assert.equal((await api.input(session, { content: "/compact", actorId: "user" })).output, "Compacted.");
		}
		const history = api.history(session);
		const summaries = history.filter((e) => e.kind === "summary");
		assert.equal(summaries.length, 1);
		const [older, recent] = history.filter((e) => e.kind === "toolResult");
		const responses = history.filter((e) => e.kind === "response" && e.message?.content.some(isToolCall));
		assert.deepEqual(summaries[0].sources, [history.find((e) => e.kind === "input")!.id, responses[0].id, older.id]);
		const kept = modelView(history);
		assert.deepEqual(kept.map((m) => m.role), ["user", "assistant", "toolResult", "assistant"]);
		assert.deepEqual(kept[1].content.filter(isToolCall), responses[1].message!.content.filter(isToolCall));
		assert.deepEqual(kept[2], recent.message);
		assert.match(textOf(kept[0].content), /Goal: compare/);
		await api.erase(session, [older.id], "user");
		const erased = api.history(session);
		assert.ok(!erased.some((e) => e.id === summaries[0].id && !e.erased));
		assert.ok(!JSON.stringify(modelView(erased)).includes("Goal: compare the files"));
	});
}
