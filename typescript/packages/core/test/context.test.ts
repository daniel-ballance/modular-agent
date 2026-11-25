import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AgentError, createAgent, definePlugin, defineToolSource, environmentCredentials, serve, tool,
  type AgentOptions, type Plugin, type Provider, type ProviderContext, type Session, type ToolContext,
} from "@modular-agent/core";
import { overWire, scriptedProvider } from "@modular-agent/core/testing";
import { gitProject } from "./fixtures/git-project.js";

async function followTurn(session: Session, type: string) {
  const events: unknown[] = [];
  for await (const event of session.events()) {
    if (event.type === type) events.push(event.data);
    if (event.type === "turnEnded") return events;
  }
  throw new Error("Session ended before the turn settled");
}

const input = { type: "object", additionalProperties: false } as const;
const secret = "synthetic test credential";
function credentials(reads: string[]) {
  return { ...environmentCredentials(), async read(name: string) {
    reads.push(name);
    return name === "beacon" ? { type: "apiKey", key: secret } : name === "named" ? secret : undefined;
  } };
}

export function contextPlugin(capture?: (cx: ToolContext) => void): Plugin {
  const inspect = tool({ name: "inspect", description: "Read raw history", input, async run(_, cx) {
    capture?.(cx);
    const history = await cx.history();
    const recorded = history.entries.find(e => e.kind === "input");
    assert.ok(recorded);
    const tail = await cx.history(recorded.id);
    assert.ok(tail.entries.some(e => e.kind === "toolStarted" && !e.modelVisible));
    assert.ok(!tail.entries.some(e => e.id === recorded.id));
    await assert.rejects(cx.history("missing"), { code: "invalid_request" });
    assert.throws(() => cx.emit("tool.started", {}), { code: "invalid_request" });
    cx.emit("inspect.ready", { entry: recorded.id });
    return "inspected";
  } });
  return definePlugin({ name: "inspect", setup(r) { r.tools(defineToolSource({ id: "inspect", tools: () => [inspect] })); } });
}

// This file also supplies the process plugin above; only the host registers tests.
if (!process.env.CONTEXT_PLUGIN) {
  for (const placement of ["local", "process", "service"] as const) {
    test(`tool reads raw records and emits a gated custom event (${placement})`, async t => {
      let retained: ToolContext | undefined;
      let placementOptions: Pick<AgentOptions, "plugins" | "processPlugins" | "servicePlugins"> = {};
      if (placement === "local") placementOptions = { plugins: [contextPlugin(cx => { retained = cx; })] };
      if (placement === "process") placementOptions = { processPlugins: [{
        command: [process.execPath, "--input-type=module", "--eval",
          `import { contextPlugin } from ${JSON.stringify(import.meta.url)};\n` +
          `import { serve } from ${JSON.stringify(import.meta.resolve("@modular-agent/core"))};\nawait serve(contextPlugin());`],
        env: { CONTEXT_PLUGIN: "1" },
      }] };
      if (placement === "service") {
        const dir = await mkdtemp(join(tmpdir(), "sdk-context-"));
        t.after(() => rm(dir, { recursive: true, force: true }));
        const tokenFile = join(dir, "token");
        await writeFile(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
        const server = await serve(contextPlugin, { listen: "127.0.0.1:0", tokenFile });
        t.after(() => server.close());
        placementOptions = { servicePlugins: [{ url: server.url, tokenFile }] };
      }
      const gate = definePlugin({ name: "gate", hooks: { output(payload) {
        if (payload.events.some(e => e.type === "inspect.ready")) return { redact: payload.events.map(e =>
          e.type === "inspect.ready" ? { ...e, data: { entry: "redacted" } } : e) };
      } } });
      const agent = await createAgent({ project: await gitProject(t), providers: [scriptedProvider([
        { toolCalls: [{ name: "inspect", input: {} }] }, { text: "done" },
      ])], ...placementOptions,
        plugins: [gate, ...(placementOptions.plugins ?? [])],
      });
      try {
        const session = await agent.session();
        const [events, result] = await Promise.all([followTurn(session, "inspect.ready"), session.prompt("inspect")]);
        assert.equal(result.toolResults()[0].text(), "inspected");
        assert.deepEqual(events, [{ entry: "redacted" }]);
        if (placement === "local") {
          assert.ok(retained);
          await assert.rejects(retained.history(), { code: "invalid_request" });
          assert.throws(() => retained!.emit("inspect.ready", {}), { code: "invalid_request" });
        }
      } finally { await agent.close(); }
    });
  }

  test("named tool credentials are local and remain scoped to the call", async t => {
    let retained: ToolContext | undefined;
    const reads: string[] = [];
    const local = tool({ name: "local", description: "Read a named credential", input, inProcessOnly: true, async run(_, cx) {
      retained = cx;
      assert.equal(await cx.credential("named"), secret);
      assert.equal(await cx.credential("missing"), undefined);
      return "checked";
    } });
    const plugin = definePlugin({ name: "local", tools: [local] });
    const agent = await createAgent({ project: await gitProject(t), tools: [local], credentials: credentials(reads) });
    try {
      assert.equal((await (await agent.session()).callTool("local", {})).text(), "checked");
      await assert.rejects(retained!.credential("named"), { code: "invalid_request" });
      assert.deepEqual(reads, ["named", "missing"]);
    } finally { await agent.close(); }
    await assert.rejects(serve(plugin), { code: "not_supported" });
  });

  test("an unflagged served tool cannot read a named credential", async t => {
    const reads: string[] = [];
    const probe = tool({ name: "probe", description: "Check credential placement", input, async run(_, cx) {
      await assert.rejects(cx.credential("beacon"), AgentError);
      await assert.rejects(cx.credential("beacon"), { code: "not_supported" });
      return "denied";
    } });
    const agent = await createAgent({ project: await gitProject(t), plugins: [overWire(definePlugin({ name: "probe", tools: [probe] }))], credentials: credentials(reads) });
    try {
      assert.equal((await (await agent.session()).callTool("probe", {})).text(), "denied");
      assert.deepEqual(reads, []);
    } finally { await agent.close(); }
  });

  for (const local of [true, false]) test(`Provider credential context (${local ? "local" : "served"})`, async t => {
    let retained: ProviderContext | undefined;
    let availability: Pick<ProviderContext, "credential"> | undefined;
    const reads: string[] = [];
    const provider: Provider = { id: "beacon", models: () => [{ id: "demo", provider: "beacon", input: ["text"], reasoning: false, contextWindow: 4096, maxOutput: 256 }],
      supports: { keepsState: false, safeToRepeat: true }, inProcessOnly: local,
      async available(cx) {
        availability = cx;
        assert.equal(await cx.credential(), secret);
        if (local) assert.equal(await cx.credential("named"), secret);
        return true;
      },
      async request(_, __, cx) {
        retained = cx;
        assert.equal(await cx.credential(), secret);
        if (local) {
          assert.equal(await cx.credential("named"), secret);
          assert.equal(await cx.credential("missing"), undefined);
        } else {
          await assert.rejects(cx.credential("named"), { code: "not_supported" });
          await assert.rejects(cx.credential("beacon"), { code: "not_supported" });
        }
        cx.emit("beacon.ready", { ok: true });
        return { role: "assistant", stop: "finished", content: [{ type: "text", text: "ready" }] };
      },
    };
    const plugin = definePlugin({ name: "beacon", setup(r) { r.provider(provider); } });
    const agent = await createAgent({ project: await gitProject(t), plugins: [local ? plugin : overWire(plugin)], credentials: credentials(reads) });
    try {
      const session = await agent.session();
      const [events, result] = await Promise.all([followTurn(session, "beacon.ready"), session.prompt("beacon")]);
      assert.equal(result.text, "ready");
      assert.deepEqual(events, [{ ok: true }]);
      assert.deepEqual([...new Set(reads)], local ? ["beacon", "named", "missing"] : ["beacon"]);
      await assert.rejects(retained!.credential(), { code: "invalid_request" });
      await assert.rejects(availability!.credential(), { code: "invalid_request" });
    } finally { await agent.close(); }
    if (local) await assert.rejects(createAgent({ plugins: [overWire(plugin)] }), { code: "invalid_composition" });
  });
}
