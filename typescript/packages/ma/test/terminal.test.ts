import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createAgent, fileCredentials, tool } from "@modular-agent/core";
import { testAgent } from "@modular-agent/core/testing";
import { standardPlugins } from "../src/compose.js";
import { loadScript } from "../src/script.js";
import { line } from "../src/terminal.js";

async function until<T>(check: () => T | undefined | Promise<T | undefined>, what: string): Promise<T> {
  for (let tries = 0; tries < 500; tries++) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  throw new Error("timed out waiting for " + what);
}

async function terminal(t: TestContext, tty: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "ma-ts-terminal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const results: string[] = [], shown: string[] = [], credentials = join(dir, "credentials.json");
  const asker = tool({ name: "ask_secret", description: "Ask for a key", input: { type: "object" }, async run(_, cx) {
    const answer = await cx.ask({ kind: "secret", credential: "deploy", question: "Deploy key?" });
    const result = typeof answer === "object" && "stored" in answer ? "stored" : "declined";
    results.push(result);
    return result;
  } });
  const agent = await testAgent({ dataDir: dir, durability: "kept", credentials: fileCredentials(credentials), tools: [asker],
    script: [{ toolCalls: [{ name: "ask_secret", input: {} }] }, { text: "done" }] });
  t.after(() => agent.close());
  const session = await agent.session();
  t.mock.method(console, "error", (...args: unknown[]) => { shown.push(args.join(" ")); });
  t.mock.method(process.stderr, "write", () => true);
  const input = Object.assign(new PassThrough(), tty ? { isTTY: true } : {});
  const running = line(agent, session, false, false, input);
  const type = (text: string) => { input.write(text + "\n"); };
  const stored = async () => JSON.parse(await readFile(credentials, "utf8").catch(() => "{}")).deploy;
  return { session, results, shown, type, stored, async end() { input.end(); await running; } };
}

test("without a terminal the terminal declines a secret question when it opens", async t => {
  const term = await terminal(t, false);
  term.type("Ask.");
  await until(() => term.results.length, "the tool's result");
  assert.deepEqual(term.results, ["declined"]);
  assert.ok(!term.shown.some(l => l.includes("Question")), term.shown.join("\n"));
  await term.end();
  assert.equal(await term.stored(), undefined);
});

test("a secret given on the /answer line is refused and the question stays open", async t => {
  const term = await terminal(t, true);
  term.type("Ask.");
  const [question] = await until(async () => (await term.session.questions()).at(0) && term.session.questions(), "the question");
  await until(() => term.shown.some(l => l.includes(`Question ${question.id}`)), "the question shown");
  assert.ok(term.shown.some(l => l.endsWith("Use /answer REQUEST_ID (hidden input)")), term.shown.join("\n"));
  term.type(`/answer ${question.id} typed-in-view`);
  await until(() => term.shown.includes("Do not put the secret on the command line; use /answer REQUEST_ID"), "the refusal");
  assert.equal((await term.session.questions()).length, 1);
  assert.deepEqual(term.results, []);
  term.type(`/answer ${question.id}`);
  term.type("typed-hidden");
  await until(() => term.results.length, "the tool's result");
  assert.deepEqual(term.results, ["stored"]);
  await term.end();
  assert.equal(await term.stored(), "typed-hidden");
});

test("/answer REQUEST_ID decline declines a secret question", async t => {
  const term = await terminal(t, true);
  term.type("Ask.");
  const [question] = await until(async () => (await term.session.questions()).at(0) && term.session.questions(), "the question");
  await until(() => term.shown.some(l => l.includes(`Question ${question.id}`)), "the question shown");
  term.type(`/answer ${question.id} decline`);
  await until(() => term.results.length, "the tool's result");
  assert.deepEqual(term.results, ["declined"]);
  await term.end();
});

test("test_ask_secret is unreachable when MODULAR_AGENT_SCRIPT is unset", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ma-ts-script-hook-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, "config"), state = join(dir, "state"), project = join(dir, "project");
  await Promise.all([config, state, project].map(d => mkdir(d, { recursive: true })));
  const paths = { config, state, home: dir };
  const scriptFile = join(dir, "script.json");
  await writeFile(scriptFile, '[{"text":"ok"}]');

  const script = await loadScript(scriptFile);
  const scripted = await createAgent({
    project,
    dataDir: state,
    durability: "kept",
    credentials: fileCredentials(join(config, "credentials.json")),
    providers: [script!],
    model: "scripted/script",
    plugins: standardPlugins({ paths, serving: false, projectMcp: async () => ({}), script }),
  });
  let sessionId: string;
  try {
    const s2 = await scripted.session();
    s2.onQuestion(() => "decline");
    await s2.prompt("init");
    sessionId = s2.id;
    const ok = await s2.callTool("test_ask_secret", { question: "Key?", credential: "deploy" });
    assert.equal(ok.status, "completed");
    assert.equal(ok.content.map(c => c.type === "text" ? c.text : "").join(""), "declined");
  } finally {
    await scripted.close();
  }

  const unscripted = await createAgent({
    project,
    dataDir: state,
    durability: "kept",
    plugins: standardPlugins({ paths, serving: false, projectMcp: async () => ({}), script: await loadScript(undefined) }),
  });
  t.after(() => unscripted.close());
  const s1 = await unscripted.openSession(sessionId);
  await assert.rejects(s1.callTool("test_ask_secret", { question: "Key?", credential: "deploy" }), {
    code: "not_found", message: "Unknown tool test_ask_secret",
  });
  const nested = await s1.callTool("codemode", { code: "tools.test_ask_secret(question='Key?', credential='deploy')" });
  assert.equal(nested.status, "failed");
  assert.match(nested.content.map(c => c.type === "text" ? c.text : "").join(""), /AttributeError/);
});
