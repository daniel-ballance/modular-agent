import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgent, environmentCredentials, ModelFailure, type Provider } from "@modular-agent/core";

const beacon: Provider = {
  id: "beacon",
  models: () => [{
    provider: "beacon", id: "demo", contextWindow: 4096, maxOutput: 256,
    input: ["text"], reasoning: false,
  }],
  available: () => true,
  supports: { keepsState: false, safeToRepeat: true },
  async request(_model, _request, cx) {
    const key = await cx.credential();
    if (key !== "offline-key") {
      throw new ModelFailure({ kind: "credentials", message: "Key rejected" });
    }
    cx.piece("text", "Beacon ");
    cx.piece("text", "ready.");
    return { role: "assistant", stop: "finished", content: [{ type: "text", text: "Beacon ready." }] };
  },
};

test("beacon streams and records failures", async t => {
  for (const key of ["offline-key", "rejected"]) {
    await t.test(key, async () => {
      const agent = await createAgent({
        providers: [beacon],
        credentials: { ...environmentCredentials(), read: async name => name === "beacon" ? key : undefined },
      });
      try {
        assert.equal(agent.models()[0].id, "demo");
        const session = await agent.session();
        const pieces: string[] = [];
        for await (const event of session.promptStream("Check the beacon.")) {
          if (event.type === "text") pieces.push(event.data.delta);
        }
        const turn = await session.lastTurn();
        if (key === "offline-key") {
          assert.deepEqual(pieces, ["Beacon ", "ready."]);
          assert.equal(turn?.text, "Beacon ready.");
        } else {
          assert.deepEqual(pieces, []);
          assert.equal(turn?.outcome?.kind, "failed");
          const message = (await session.history()).find(e => e.kind === "response")?.message;
          assert.equal(message?.role, "assistant");
          assert.equal(message.stop, "failed");
          assert.equal(message.error?.kind, "credentials");
        }
      } finally {
        await agent.close();
      }
    });
  }
});

test("loads a Provider from another process", async () => {
  const program = `
    import { definePlugin, serve } from ${JSON.stringify(import.meta.resolve("@modular-agent/core"))};
    import { scriptedProvider } from ${JSON.stringify(import.meta.resolve("@modular-agent/core/testing"))};
    await serve(definePlugin({ name: "beacon-demo", setup(r) {
      r.provider(scriptedProvider([{ text: "Beacon ready." }]));
    }}));
  `;
  const agent = await createAgent({
    processPlugins: [{ command: [process.execPath, "--input-type=module", "--eval", program] }],
    model: "scripted/script",
  });
  try {
    const turn = await (await agent.session()).prompt("Check the beacon.");
    assert.equal(turn.text, "Beacon ready.");
  } finally {
    await agent.close();
  }
});
