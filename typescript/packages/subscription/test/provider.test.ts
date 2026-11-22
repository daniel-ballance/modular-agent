import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createAgent, definePlugin, type AssistantMessage } from "@modular-agent/core";
import { memoryEnvironment, overWire } from "@modular-agent/core/testing";
import { chatgpt, subscriptionLogins, type OAuth } from "@modular-agent/subscription";
import { access, body, fixture, loginFile, tokens } from "./fixtures.js";

const old: OAuth = { type: "oauth", access: "fixture-expired", refresh: "fixture-once", expires: 0 };
for (const served of [false, true]) {
  const placement = served ? "served" : "in process";
  test(`ChatGPT streams and maps the shared table (${placement})`, async t => {
    const logins = await loginFile(t), requests: Record<string, unknown>[] = [];
    await logins.setLogin("chatgpt", { ...old, access, expires: Date.now() + 60_000 });
    const expected = served ? "fixture-agent_2.0" : "modular-agent";
    const encrypted = { type: "reasoning", encrypted_content: "fixture-opaque-data" };
    const server = await fixture(t, async (req, res) => {
      assert.equal(req.headers.originator, expected);
      assert.equal(req.headers["chatgpt-account-id"], "fixture-account");
      assert.equal(req.headers["openai-beta"], "responses=experimental");
      assert.equal(req.headers.authorization, `Bearer ${access}`);
      assert.ok(req.headers["session-id"]);
      assert.equal(req.headers["session-id"], req.headers["x-client-request-id"]);
      const r = JSON.parse(await body(req));
      requests.push(r);
      assert.equal(r.prompt_cache_key, req.headers["session-id"]);
      assert.equal(r.instructions, "Fixture instructions");
      assert.deepEqual(r.include, ["reasoning.encrypted_content"]);
      assert.equal(r.store, false);
      assert.equal(r.stream, true);
      assert.equal(r.max_output_tokens, undefined);
      res.setHeader("content-type", "text/event-stream");
      res.write('data: {"type":"response.output_text.delta","delta":"hel');
      res.end(`lo"}\r\n\r\ndata: ${JSON.stringify({ type: "response.completed", response: { output: [encrypted, { type: "message", content: [{ type: "output_text", text: "hello" }] }] } })}\n\n`);
    });
    const p = chatgpt({ logins, clientIdentity: served ? expected : undefined, test: { endpoint: server.url },
      models: [{ id: "fixture-extra", contextWindow: 10000, maxOutput: 1000, input: ["text"] }] });
    const plugin = definePlugin({ name: "chatgpt-fixture", setup: r => r.provider(p) });
    const hooks = definePlugin({ name: "fixture-instructions", setup: r => {
      r.on("provider.request", ({ request }) => ({ change: { ...request, systemPrompt: "Fixture instructions" } }));
    } });
    const agent = await createAgent({ environment: memoryEnvironment(), plugins: [served ? overWire(plugin) : plugin, hooks] });
    t.after(() => agent.close());
    assert.equal(agent.models().find(m => m.id === "gpt-6.1-sol")?.contextWindow, 500000);
    assert.equal(agent.models().find(m => m.id === "fixture-extra")?.thinking, undefined);
    for (const [model, thinking] of [["gpt-6.1-sol", "off"], ["gpt-6.1-sol", undefined], ["gpt-6.1-sol", "minimal"], ["fixture-extra", "high"]]) {
      const session = await agent.session({ settings: { model: `chatgpt/${model}`, ...(thinking ? { thinking } : {}) } });
      let output = "";
      for await (const event of session.promptStream("hello")) if (event.type === "text") output += event.data.delta;
      assert.equal(output, "hello");
      assert.equal((await session.lastTurn())?.text, "hello");
      if (thinking === "minimal") assert.equal((await session.prompt("again")).text, "hello");
    }
    assert.deepEqual(requests.map(r => r.reasoning), [undefined, undefined, { effort: "low", summary: "auto" }, { effort: "low", summary: "auto" }, undefined]);
    assert.ok((requests[3].input as unknown[]).some(item => JSON.stringify(item) === JSON.stringify(encrypted)));
    assert.equal(requests[4].model, "fixture-extra");
  });

  test(`ChatGPT refresh is serialized and invalid_grant preserves the login (${placement})`, async t => {
    const logins = await loginFile(t);
    await logins.setLogin("chatgpt", old);
    let spent = 0, refuse = false;
    const server = await fixture(t, async (req, res) => {
      if (req.url === "/token") {
        spent++;
        const form = new URLSearchParams(await body(req));
        assert.equal(form.get("grant_type"), "refresh_token");
        assert.equal(form.get("refresh_token"), old.refresh);
        if (refuse) res.writeHead(400).end(JSON.stringify({ error: "invalid_grant", error_description: old.refresh }));
        else res.end(JSON.stringify(tokens));
      } else {
        assert.equal(req.headers.authorization, `Bearer ${access}`);
        res.end('data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"fresh"}]}]}}\n\n');
      }
    });
    const replies: AssistantMessage[] = [];
    const start = async () => {
      const p = chatgpt({ logins: subscriptionLogins(logins.path), test: { endpoint: `${server.url}/model`, oauth: { endpoints: { codexToken: `${server.url}/token` } } } });
      const plugin = definePlugin({ name: "chatgpt-fixture", setup: r => r.provider(p) });
      const hooks = definePlugin({ name: "fixture-replies", setup: r => {
        r.on("provider.response", ({ message }) => { replies.push(message); });
        r.on("model.failed", () => "stop");
      } });
      const agent = await createAgent({ environment: memoryEnvironment(), plugins: [served ? overWire(plugin) : plugin, hooks] });
      t.after(() => agent.close());
      return agent.session({ settings: { model: "chatgpt/gpt-6.1-sol" } });
    };
    const [a, b] = await Promise.all([start(), start()]);
    assert.deepEqual((await Promise.all([a.prompt("first"), b.prompt("second")])).map(r => r.text), ["fresh", "fresh"], JSON.stringify(replies));
    assert.equal(spent, 1);
    refuse = true;
    await logins.setLogin("chatgpt", old);
    const before = await readFile(logins.path);
    assert.equal((await a.prompt("cannot refresh")).outcome?.kind, "failed");
    assert.equal(replies.at(-1)?.error?.kind, "credentials");
    assert.match(replies.at(-1)?.error?.message ?? "", /sign in again/i);
    assert.doesNotMatch(replies.at(-1)?.error?.message ?? "", /fixture-once/);
    assert.deepEqual(await readFile(logins.path), before);
    assert.equal(spent, 2);
  });
}

test("ChatGPT refreshes an unexpired login once after a 401", async t => {
  const logins = await loginFile(t);
  await logins.setLogin("chatgpt", { ...old, expires: Date.now() + 60_000, account: "fixture-account" });
  const requests: string[] = [];
  const server = await fixture(t, async (req, res) => {
    requests.push(req.url!);
    if (req.url === "/token") {
      assert.equal(new URLSearchParams(await body(req)).get("refresh_token"), old.refresh);
      res.end(JSON.stringify(tokens));
    } else if (req.headers.authorization === `Bearer ${old.access}`) {
      res.writeHead(401).end("{}");
    } else {
      assert.equal(req.headers.authorization, `Bearer ${access}`);
      const prompt = JSON.parse(await body(req));
      assert.equal(prompt.instructions, "You are a helpful assistant.");
      res.end('data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"café"}]}}\n\n' +
        'data: {"type":"response.completed",\n' + 'data: "response":{"output":[],"usage":{"input_tokens":7,"output_tokens":2,"input_tokens_details":{"cached_tokens":1}}}}\n\n');
    }
  });
  const p = chatgpt({ logins, test: { endpoint: `${server.url}/model`, oauth: { endpoints: { codexToken: `${server.url}/token` } } } });
  const agent = await createAgent({ providers: [p], model: "chatgpt/gpt-6.1-sol", environment: memoryEnvironment() });
  t.after(() => agent.close());
  const reply = await (await agent.session()).prompt("hello");
  assert.equal(reply.text, "café");
  assert.equal(reply.usage?.cacheRead, 1);
  assert.deepEqual(requests, ["/model", "/token", "/model"]);
});
