import assert from "node:assert/strict";
import { test } from "node:test";
import { definePlugin } from "../src/index.js";
import { overWire, testAgent } from "../src/testing.js";

for (const served of [false, true]) {
  test(`an output hook sees shared events and redacts streamed text (served=${served})`, async () => {
    const gate = definePlugin({ name: "hide-word", hooks: { output({ events }) {
      if (!events.some(e => e.type === "text")) return;
      return { redact: events.map(e => {
        if (e.type !== "text") return e;
        const data = e.data as { delta: string };
        return { ...e, data: { ...data, delta: data.delta.replaceAll("hidden", "[redacted]") } };
      }) };
    } } });
    const agent = await testAgent({ plugins: [served ? overWire(gate) : gate], script: [{ text: "A hidden word." }] });
    try {
      assert.equal(agent.declaration().holdsOutput, true);
      const pieces = [];
      const session = await agent.session();
      for await (const e of session.promptStream("Say it.")) if (e.type === "text") pieces.push(e.data.delta);
      assert.equal(pieces.join(""), "A [redacted] word.");
    } finally { await agent.close(); }
  });
}
