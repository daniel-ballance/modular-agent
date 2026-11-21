import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  createAgent, definePlugin, defineToolSource, serve, tool, transientRuntime,
  type Agent, type AgentOptions, type Content, type Event, type Plugin, type Session, type WorkingEnvironment,
} from "@modular-agent/core";
import { memoryEnvironment, scriptedProvider, testAgent } from "@modular-agent/core/testing";

const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" } as const;
const preview = (text: string): Content => [{ type: "text", text }, image];
const input = { type: "object" } as const;

export function progressPlugin(): Plugin {
  return definePlugin({ name: "preview", setup(r) {
    r.jobs({ async cancel(_, cx) { await cx.job.end({ kind: "cancelled" }); } });
    r.tool(tool({ name: "preview", description: "Report previews", input, async run(_, cx) {
      const job = await cx.jobs.start("preview", {});
      job.progress(preview("first"));
      job.progress(preview("second"));
      await job.end({ kind: "completed" });
      return "ready";
    } }));
  }, hooks: { async output({ events }, cx) {
    if (events.some(event => event.type === "job.progress")) {
      // The job progress gate can itself read from the host on this connection.
      assert.ok((await cx.history()).entries.some(row => row.kind === "jobStarted"));
    }
    return { redact: events.map(event => {
      if (event.type !== "job.progress") return event;
      const data = event.data as { content: Content };
      assert.deepEqual(data.content[1], image);
      const first = data.content[0];
      assert.ok(first.type === "text");
      return { ...event, data: { ...data, content: [{ ...first, text: `gated ${first.text}` }, ...data.content.slice(1)] } };
    }) };
  } } });
}

export function environmentPlugin(): Plugin {
  const files = new Map<string, Buffer>();
  const env: WorkingEnvironment = {
    id: "streaming", cwd: process.cwd(), containment: "none",
    at(cwd) { return { ...this, cwd }; },
    async readFile(path) { const data = files.get(path); assert.ok(data); return data; },
    async exists(path) { return files.has(path); },
    async writeFile(path, data) { files.set(path, Buffer.from(data)); },
    async list(path) {
      assert.equal(path, ".");
      return [...files.keys()].map(name => ({ name, kind: "file" }));
    },
    async exec(command, { onOutput }) {
      assert.equal(command, "preview");
      onOutput?.("first");
      onOutput?.("second");
      return { output: "firstsecond", exitCode: 0, timedOut: false };
    },
  };
  return definePlugin({ name: "streaming", replaces: ["working-environment"], setup(r) {
    r.environment(env);
    r.tool(tool({ name: "read_preview", description: "Read the preview result", input, async run(_, cx) {
      return (await cx.environment.read("result")).toString();
    } }));
    r.tool(tool({ name: "stream_preview", description: "Run the preview", input, async run(_, cx) {
      assert.equal((await cx.environment.exec("preview")).output, "firstsecond");
      assert.equal(await cx.environment.exists("result"), false);
      await cx.environment.write("result", "contents");
      assert.equal(await cx.environment.exists("result"), true);
      assert.deepEqual(await cx.environment.list("."), [{ name: "result", kind: "file" }]);
      assert.ok((await cx.tools.list()).some(t => t.name === "read_preview"));
      const answer = await cx.ask({ kind: "text", question: "Label this preview" });
      assert.deepEqual(answer, { value: "checked" });
      const result = await cx.tools.call("read_preview", {});
      assert.equal(result.status, "completed");
      return result.content;
    } }));
  }, hooks: { output({ events }) {
    return { redact: events.map(event => {
      if (event.type !== "toolOutput") return event;
      const data = event.data as { chunk: string; content: Content };
      const chunk = `gated ${data.chunk}`;
      return { ...event, data: { ...data, chunk, content: [{ type: "text", text: chunk }] } };
    }) };
  } } });
}

export function runtimePlugin(): Plugin {
  const runtime = transientRuntime();
  const runTurn = runtime.runTurn.bind(runtime);
  runtime.runTurn = (turn, host, signal) => runTurn({ ...turn, model: { ...turn.model,
    async request(request, options) {
      const pieces: Promise<string>[] = [];
      const answer = await turn.model.request(request, { ...options, onEvent(piece) {
        if (piece.type === "text") pieces.push(host.history().then(history => {
          assert.ok(history.some(row => row.kind === "modelRequest"));
          return piece.delta;
        }));
      } });
      if (pieces.length) host.report("pieces", (await Promise.all(pieces)).join(""));
      return answer;
    },
  } }, host, signal);
  const provider = scriptedProvider([{ toolCalls: [{ name: "sample", input: {} }] }, { text: "answer" }]);
  const reply = provider.request.bind(provider);
  provider.request = (model, request, cx) => {
    assert.ok(request.systemPrompt.includes("Same-peer request gate"));
    return reply(model, request, cx);
  };
  return definePlugin({ name: "model-pieces", replaces: ["runtime"], setup(r) {
    r.runtime(runtime);
    r.provider(provider);
    r.tool(tool({ name: "sample", description: "Return a sample", input, run: () => "sampled" }));
  }, hooks: {
    async "step.before"(_, cx) {
      assert.ok((await cx.history()).entries.some(row => row.kind === "input"));
    },
    "provider.request": ({ request }) => ({ change: { ...request, systemPrompt: `${request.systemPrompt}\nSame-peer request gate` } }),
    "provider.response": ({ message }, cx) => { cx.emit("response.checked", message.stop); },
    "step.after": (_, cx) => { cx.emit("check.step", "recorded"); },
    output({ events }) {
      return { redact: events.map(event => event.type === `${runtime.id}.pieces` ? { ...event, data: `gated ${event.data}` } : event) };
    },
  } });
}

export function catalogPlugin(): Plugin {
  const added = tool({ name: "added", description: "Newly listed tool", input, run(_, cx) {
    cx.emit("catalog.confirmed", "available");
    return "available";
  } });
  const updated = tool({ name: "updated", description: "Updated tool", input, run: () => "also available" });
  const update = tool({ name: "update", description: "Add a tool and report it", input, run(_, cx) {
    current = [update, added];
    unscopedChange();
    cx.emit("catalog.changed", "first");
    cx.emit("catalog.changed", "second");
    return "updated";
  } });
  let current = [update];
  const source = defineToolSource({ id: "catalog", tools: () => current });
  // The unscoped invalidation must ask this plugin for its tool list, too.
  const unscopedChange = AsyncLocalStorage.bind(() => source.changed());
  return definePlugin({ name: "catalog", setup(r) {
    r.tools(source);
    r.command("refresh", "Refresh the catalog under the command parent", () => {
      current = [updated];
      source.changed();
    });
  }, hooks: { async output({ events }, cx) {
    if (events.some(event => event.type === "catalog.changed")) {
      cx.emit("catalog.recursed", "must be dropped");
      await cx.history();
    }
    return { redact: events.map(event => event.type === "catalog.changed" ? { ...event, data: `gated ${event.data}` } : event) };
  } } });
}

async function followUntil(session: Session, done: (event: Event) => boolean = event => event.type === "turnEnded"): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of session.events()) {
    events.push(event);
    if (done(event)) return events;
  }
  throw new Error("Session ended before the expected event");
}

type Transport = "stdio" | "websocket";
type Placement = Pick<AgentOptions, "processPlugins" | "servicePlugins">;
async function hosted(t: TestContext, transport: Transport, plugin: () => Plugin, start: (options: Placement) => Promise<Agent>): Promise<Agent> {
  if (transport === "stdio") {
    const agent = await start({ processPlugins: [{
      command: [process.execPath, "--input-type=module", "--eval",
        `import { ${plugin.name} } from ${JSON.stringify(import.meta.url)};\n` +
        `import { serve } from ${JSON.stringify(import.meta.resolve("@modular-agent/core"))};\nawait serve(${plugin.name}());`],
      env: { CALLBACK_TEST_PLUGIN: "1" },
    }] });
    t.after(() => agent.close());
    return agent;
  }
  const dir = await mkdtemp(join(tmpdir(), "sdk-callbacks-"));
  let agent: Agent | undefined, server: Awaited<ReturnType<typeof serve>> | undefined;
  t.after(async () => {
    try { await agent?.close(); }
    finally {
      try { await server?.close(); }
      finally { await rm(dir, { recursive: true, force: true }); }
    }
  });
  const tokenFile = join(dir, "token");
  await writeFile(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  server = await serve(plugin, { listen: "127.0.0.1:0", tokenFile });
  return agent = await start({ servicePlugins: [{ url: server.url, tokenFile }] });
}

if (!process.env.CALLBACK_TEST_PLUGIN) {
  for (const transport of ["stdio", "websocket"] as const) {
    test(`job progress reaches an events follower through its owner's gate (${transport})`, { timeout: 5000 }, async t => {
      const agent = await hosted(t, transport, progressPlugin, options => testAgent({ ...options,
        script: [{ toolCalls: [{ name: "preview", input: {} }] }, { text: "Done" }] }));
      const session = await agent.session();
      const [events, result] = await Promise.all([followUntil(session), session.prompt("Show previews")]);
      const progress = events.filter(event => event.type === "jobProgress")
        .map(event => ({ jobId: event.jobId, content: event.data.content }));
      assert.equal(result.toolResults()[0].text(), "ready");
      const jobId = progress[0]?.jobId;
      assert.ok(jobId);
      assert.deepEqual(progress, [
        { jobId, content: preview("gated first") }, { jobId, content: preview("gated second") },
      ]);
    });

    test(`environment and nested tool callbacks stream through their own tool output gate (${transport})`, { timeout: 5000 }, async t => {
      const agent = await hosted(t, transport, environmentPlugin, options => testAgent({ ...options,
        onQuestion: () => ({ value: "checked" }), script: [{ toolCalls: [{ name: "stream_preview", input: {} }] }, { text: "Done" }] }));
      const session = await agent.session();
      const [events, result] = await Promise.all([followUntil(session), session.prompt("Stream the preview")]);
      assert.equal(result.toolResults()[0].text(), "contents");
      const progress = events.filter(event => event.type === "toolOutput");
      assert.deepEqual(progress.map(event => event.data), [
        { toolCallId: result.toolResults()[0].callId, chunk: "gated first", content: [{ type: "text", text: "gated first" }] },
        { toolCallId: result.toolResults()[0].callId, chunk: "gated second", content: [{ type: "text", text: "gated second" }] },
      ]);
    });

    test(`Runtime model pieces, history and hooks can use the same peer (${transport})`, { timeout: 5000 }, async t => {
      const agent = await hosted(t, transport, runtimePlugin, options => createAgent({ ...options,
        environment: memoryEnvironment(), model: "scripted/script" }));
      const session = await agent.session();
      const [events, result] = await Promise.all([followUntil(session), session.prompt("Generate an answer")]);
      assert.deepEqual(result.outcome, { kind: "completed" });
      assert.equal(result.text, "answer");
      assert.equal(result.toolResults()[0].text(), "sampled");
      assert.deepEqual(events.filter(event => event.type === "text").map(event => event.data.delta), ["answer"]);
      const reports = events.filter(event => ["response.checked", "check.step", `${transientRuntime().id}.pieces`].includes(event.type));
      assert.deepEqual(reports.map(event => event.data), ["toolUse", "recorded", "finished", "gated answer", "recorded"]);
    });

    test(`catalog changes and custom events can call back into their own plugin (${transport})`, { timeout: 5000 }, async t => {
      const agent = await hosted(t, transport, catalogPlugin, options => testAgent({ ...options,
        script: [{ toolCalls: [{ name: "update", input: {} }] }, { text: "Done" }] }));
      const session = await agent.session();
      const followed = followUntil(session, event => event.type === "catalog.confirmed");
      void followed.catch(() => {}); // Closing the agent also stops this follower if a call fails.
      assert.equal((await session.prompt("Update the catalog")).toolResults()[0].text(), "updated");
      assert.equal((await session.callTool("added", {})).text(), "available");
      const events = await followed;
      assert.deepEqual(events.filter(event => event.type === "catalog.changed").map(event => event.data), ["gated first", "gated second"]);
      assert.ok(!events.some(event => event.type === "catalog.recursed"));
      await session.runCommand("/refresh");
      await assert.rejects(session.callTool("added", {}), { code: "not_found" });
      assert.equal((await session.callTool("updated", {})).text(), "also available");
    });
  }
}
