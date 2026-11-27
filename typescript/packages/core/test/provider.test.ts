import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgent, definePlugin, defineProvider, environmentCredentials, type Event, type ModelInfo } from "../src/index.js";
import { overWire } from "../src/testing.js";
import { gitProject } from "./fixtures/git-project.js";

for (const served of [false, true]) {
  test(`Provider audio arrives as a custom session event (${served ? "served" : "local"})`, async t => {
    const audio: Exclude<"audio", Event["type"]> = "audio";
    const provider = defineProvider({
      id: "beacon", supports: { keepsState: false, safeToRepeat: true },
      models: () => [{ provider: "beacon", id: "demo", contextWindow: 4096, maxOutput: 256, input: ["text"], reasoning: false }],
      request(_model, _request, cx) {
        cx.emit("beacon.audio", { clip: "sample" });
        return { role: "assistant", stop: "finished", content: [{ type: "text", text: "Beacon ready." }] };
      },
    });
    const plugin = definePlugin({ name: "beacon", setup(r) { r.provider(provider); } });
    const agent = await createAgent({ project: await gitProject(t), plugins: [served ? overWire(plugin) : plugin] });
    try {
      const session = await agent.session();
      const follow = async () => {
        const clips: unknown[] = [];
        for await (const event of session.events()) {
          assert.notEqual(event.type, audio);
          if (event.type === "beacon.audio") clips.push(event.data);
          if (event.type === "turnEnded") return clips;
        }
        throw new Error("Session ended before the turn settled");
      };
      const [clips, result] = await Promise.all([follow(), session.prompt("Check the beacon.")]);
      assert.deepEqual(clips, [{ clip: "sample" }]);
      assert.equal(result.text, "Beacon ready.");
    } finally { await agent.close(); }
  });

  test(`Provider readiness, catalog changes, hooks and credentials (${served ? "served" : "local"})`, async t => {
    const catalog: ModelInfo[] = [{ provider: "beacon", id: "demo", contextWindow: 4096, maxOutput: 256, input: ["text"], reasoning: false }];
    const calls: string[] = [];
    let ready = false;
    let requestCount = 0;
    const provider = defineProvider({
      id: "beacon", models: () => catalog, supports: { keepsState: false, safeToRepeat: true },
      async available() { calls.push("available"); return ready; },
      async request(_model, request, cx) {
        requestCount++;
        assert.equal(request.systemPrompt, "Transformed");
        assert.equal(await cx.credential(), "test-credential");
        cx.piece("text", "Bea");
        cx.piece("text", "con");
        return { role: "assistant", stop: "finished", content: [{ type: "text", text: "Beacon" }] };
      },
    });
    const plugin = definePlugin({ name: "test-provider", setup(r) { r.provider(provider); } });
    const hooks = definePlugin({ name: "host-hooks", setup(r) {
      r.on("provider.request", ({ request }) => { calls.push("request"); return { change: { ...request, systemPrompt: "Transformed" } }; });
      r.on("provider.response", ({ message }) => { calls.push(`response:${message.stop}`); });
    } });
    const agent = await createAgent({ project: await gitProject(t), plugins: [served ? overWire(plugin) : plugin, hooks],
      credentials: { ...environmentCredentials(), read: async id => id === "beacon" ? "test-credential" : undefined } });
    try {
      let changes = 0;
      const unsubscribe = agent.onModelsChanged(() => { changes++; });
      catalog.push({ ...catalog[0], id: "updated" });
      provider.changed();
      assert.equal(changes, served ? 0 : 1);
      assert.deepEqual((await agent.refreshModels()).map(m => m.id), ["demo", "updated"]);
      assert.equal(changes, 1);
      unsubscribe();
      const session = await agent.session();
      const failure = await session.prompt("Check the beacon.");
      assert.equal(failure.outcome?.kind, "failed");
      assert.equal(requestCount, 0);
      assert.deepEqual(calls.splice(0), ["request", "available", "response:failed"]);
      ready = true;
      const pieces: string[] = [];
      const next = await agent.session({ settings: { model: "beacon/updated" } });
      for await (const event of next.promptStream("Check the beacon.")) {
        if (event.type === "text") pieces.push(event.data.delta);
      }
      assert.deepEqual(pieces, ["Bea", "con"]);
      assert.equal((await next.lastTurn())?.text, "Beacon");
      assert.deepEqual(calls, ["request", "available", "response:finished"]);
      assert.equal(requestCount, 1);
    } finally { await agent.close(); }
  });
}
