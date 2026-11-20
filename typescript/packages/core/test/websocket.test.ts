import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { definePlugin, serve, tool } from "@modular-agent/core";
import { testAgent } from "@modular-agent/core/testing";

async function token(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "sdk-websocket-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, "token");
  await writeFile(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  return { dir, tokenFile };
}

test("SDK loads in-process, stdio, explicit service and environment services in order", async t => {
  const { tokenFile } = await token(t);
  const names: string[] = [];
  const plugin = definePlugin({ name: "listener", hooks: { "plugin.load": p => { names.push(p.name); } } });
  const first = await serve(definePlugin({ name: "first" }), { listen: "127.0.0.1:0", tokenFile });
  const second = await serve(definePlugin({ name: "second", setup(r) { assert.equal(r.config().check, true); } }), { listen: "127.0.0.1:0", tokenFile });
  const prior = process.env.MODULAR_AGENT_PLUGINS;
  const configured = { url: second.url, tokenFile, config: { check: true } };
  try {
    process.env.MODULAR_AGENT_PLUGINS = JSON.stringify([configured]);
    // An env entry is not sufficient to enable hosting in an embedded agent.
    const embedded = await testAgent({ script: [] });
    await embedded.close();
    const child = `process.stdin.on('data', b => { for (const line of String(b).trim().split('\\n')) {
      const { id, method } = JSON.parse(line);
      console.log(JSON.stringify({jsonrpc:'2.0', id, result: method === 'plugin/initialize' ? { name:'child', binding:'modular-agent-plugin/1' } : {} }));
    }});`;
    const hosted = await testAgent({ script: [], plugins: [plugin], processPlugins: [{ command: [process.execPath, "-e", child] }],
      servicePlugins: [{ url: first.url, tokenFile }] });
    await hosted.close();
    assert.deepEqual(names.filter(n => ["child", "first", "second"].includes(n)), ["child", "first", "second"]);
    process.env.MODULAR_AGENT_PLUGINS = JSON.stringify([{ ...configured, command: ["also-stdio"] }]);
    await assert.rejects(testAgent({ script: [], pluginHost: true }), { code: "invalid_composition" });
    delete process.env.MODULAR_AGENT_PLUGINS;
    await assert.rejects(testAgent({ script: [], pluginHost: false, servicePlugins: [] }), { code: "invalid_composition" });
    await assert.rejects(testAgent({ script: [], servicePlugins: [{ ...configured, config: {} }] }), { code: "invalid_composition" });
    await second.close();
    await assert.rejects(testAgent({ script: [], servicePlugins: [configured] }), { code: "invalid_composition" });
  } finally {
    if (prior === undefined) delete process.env.MODULAR_AGENT_PLUGINS;
    else process.env.MODULAR_AGENT_PLUGINS = prior;
    await Promise.all([first.close(), second.close()]);
  }
});

test("loss of a plugin service settles its dispatched tool once as outcomeUnknown", async t => {
  const { tokenFile } = await token(t);
  let signalStarted!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  let calls = 0;
  const plugin = definePlugin({ name: "hold", tools: [tool({ name: "hold", description: "Wait for cancel", input: { type: "object" },
    async run(_, cx) {
      calls++;
      signalStarted();
      await new Promise<void>(resolve => cx.cancelled.addEventListener("abort", () => resolve(), { once: true }));
      return "cancelled";
    } })] });
  const service = await serve(plugin, { listen: "127.0.0.1:0", tokenFile });
  try {
    const agent = await testAgent({ script: [{ toolCalls: [{ name: "hold", input: {} }] }, { text: "Done" }],
      servicePlugins: [{ url: service.url, tokenFile }] });
    try {
      const session = await agent.session();
      const result = session.prompt("Hold");
      await started;
      await service.close();
      assert.deepEqual((await result).toolResults().map(r => r.status), ["outcomeUnknown"]);
      assert.equal(calls, 1);
    } finally { await agent.close(); }
  } finally { await service.close(); }
});
