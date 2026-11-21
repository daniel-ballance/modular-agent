import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { anthropic } from "@modular-agent/anthropic";
import { createAgent, type Provider } from "@modular-agent/core";
import { memoryEnvironment } from "@modular-agent/core/testing";
import { openai } from "@modular-agent/openai";

const canonical = new URL("../../../../../docs/sdk/api-key-models.json", import.meta.url);
test("shipped API-key catalog is byte-identical to the SDK specification", async () => {
  const shipped = new URL("../../../provider-pi-ai/api-key-models.json", import.meta.url);
  assert.deepEqual(await readFile(shipped), await readFile(canonical));
});

for (const [vendor, make] of [["openai", openai], ["anthropic", anthropic]] as const) {
  test(`${vendor} uses every catalog mapping and never probes`, async t => {
    const bodies: Record<string, unknown>[] = [];
    const server = createServer(async (req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url?.split("?")[0], vendor === "openai" ? "/responses" : "/v1/messages");
      let text = "";
      for await (const chunk of req) text += chunk.toString();
      bodies.push(JSON.parse(text));
      // An explicit error avoids needing to simulate a vendor's streamed reply.
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "loopback test" } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const bound = server.address();
    assert.ok(bound && typeof bound !== "string");
    const enrolled = { id: "custom", input: ["text"], contextWindow: 8192, maxOutput: 4096, reasoning: true };
    const provider: Provider = make({ baseUrl: `http://127.0.0.1:${bound.port}`, models: [enrolled] });
    const table = JSON.parse(await readFile(canonical, "utf8")) as { models: {
      provider: string; id: string; levels: Record<string, Record<string, unknown>>;
    }[] };
    const models = table.models.filter(m => m.provider === vendor);
    assert.deepEqual(provider.models().map(m => m.id), [...models.map(m => m.id), enrolled.id]);
    assert.deepEqual(provider.models().at(-1), { provider: vendor, ...enrolled });
    const check = async (id: string, level: string | undefined, fields: object, maxOutput = 16384) => {
      const agent = await createAgent({ environment: memoryEnvironment(), providers: [provider], model: { provider: vendor, id },
        credentials: { read: async () => "loopback-test-key", list: async () => [], modify: async () => undefined,
          delete: async () => {} }, settings: { reasoning: level, maxOutput } });
      try {
        const before = bodies.length;
        const turn = await (await agent.session()).prompt("Hello");
        assert.equal(turn.outcome?.kind, "failed");
        assert.equal(bodies.length, before + 1, `exactly one request for ${id}:${level}`);
        const { reasoning, thinking, output_config, ...body } = bodies.at(-1)!;
        assert.deepEqual({ ...(reasoning === undefined ? {} : { reasoning }), ...(thinking === undefined ? {} : { thinking }),
          ...(output_config === undefined ? {} : { output_config }) }, fields, `${id}:${level}`);
        assert.equal(body.model, id);
        assert.equal(body[vendor === "openai" ? "max_output_tokens" : "max_tokens"], maxOutput);
      } finally { await agent.close(); }
    };
    for (const model of models) {
      assert.deepEqual(provider.models().find(m => m.id === model.id)?.thinking, Object.keys(model.levels));
      await check(model.id, undefined, {});
      for (const [level, fields] of Object.entries(model.levels)) await check(model.id, level, fields);
      if (!model.levels.off) await check(model.id, "off", {});
    }
    await check(enrolled.id, "high", {});
    if (vendor === "openai") await check("gpt-6-luna", "minimal", models[0].levels.off);
    else {
      await check("claude-opus-4-5", "high", { thinking: { type: "enabled", budget_tokens: 2047 }, output_config: { effort: "high" } }, 2048);
      await check("claude-opus-4-5", "low", { thinking: { type: "disabled" } }, 1024);
    }
  });
}
