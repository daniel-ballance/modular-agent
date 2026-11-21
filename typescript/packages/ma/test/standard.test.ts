import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { createAgent, fileHistory, serveHistory, tool, type HistoryEntry } from "@modular-agent/core";
import { scriptedProvider } from "@modular-agent/core/testing";
import { standardFileTools } from "@modular-agent/tools-files/sdk";
import { codemode } from "../src/codemode.js";
import { PRINT_BYTES, PrintedOutput } from "../src/codemode-output.js";
import { ComputeBudget } from "../src/monty-worker.js";
import { paths } from "../src/configuration.js";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../../../../");
const cli = join(here, "../src/main.js");
async function project(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "ma-ts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "home"), config = join(dir, "config"), work = join(dir, "project"), script = join(dir, "script.json"), log = join(dir, "requests.jsonl");
  await Promise.all([home, config, work].map(d => mkdir(d)));
  const put = async (path: string, content: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); };
  await put(script, '[{"text":"ok"}]');
  const env = { PATH: process.env.PATH, HOME: home, MODULAR_AGENT_DATA_DIR: config, MODULAR_AGENT_SCRIPT: script, MODULAR_AGENT_SCRIPT_LOG: log };
  return { dir, home, config, work, script, log, env, put, run: (...args: string[]) => exec(process.execPath, [cli, ...args], { cwd: work, env }) };
}
const scripted = (code: string) => [{ toolCalls: [{ name: "codemode", input: { code } }] }, { text: "done" }];
async function sandbox(t: TestContext, code: string, fixture: () => number | Promise<number> = () => 7, computeMs?: number) {
  const p = await project(t);
  const agent = await createAgent({ project: p.work, providers: [scriptedProvider(scripted(code))], settings: { modelTools: ["codemode"] },
    plugins: [standardFileTools({ spill: join(p.dir, "output") }), codemode({ computeMs })],
    tools: [tool({ name: "fixture", description: "Fixture returns a number", input: { type: "object", properties: {}, additionalProperties: false }, run: fixture })] });
  t.after(() => agent.close());
  const session = await agent.session();
  return { p, session, result: async () => (await session.prompt("Run the code.")).toolResults()[0] };
}

test("codemode runs calls through the SDK, handles non-zero exit, and looks up tool schemas", async t => {
  const { p, result } = await sandbox(t, `tools.write('a.txt', 'harbour')
print(tools.read(path='a.txt'))
print(tools.exec('exit 3')['exit_code'])
print(describe_tool(name='read')['signature'])
print(search_tools('number fixture')[0]['name'])
print(tools.fixture())
try:
    tools.read(path='missing')
except RuntimeError as e:
    print(str(e))
try:
    tools.read('a.txt', path='a.txt')
except TypeError as e:
    print(str(e))
'ending'`);
  const r = await result();
  assert.equal(r.status, "completed", r.text());
  assert.equal(r.text(), "harbour\n3\ntools.read(path: str, limit: float = None, offset: float = None)\nfixture\n7\nFile not found: missing\nread(): got two values for path\nending");
  assert.equal(await readFile(join(p.work, "a.txt"), "utf8"), "harbour");
});

test("codemode renders Python values before converting them to JavaScript", async t => {
  const { session } = await sandbox(t, "");
  const cases = [
    ["1.0", "1.0"], ["-0.0", "-0.0"], ["2**70", "1180591620717411303424"],
    ["b'hi'", "b'hi'"], ["{1}", "{1}"], ["float('nan')", "nan"],
    ["[1.0, b'hi', {1}, float('nan')]", "[1.0, b'hi', {1}, nan]"],
    ["{'2': (1.0, 2**70), '1': 'é'}", '{\n  "2": [\n    1.0,\n    1180591620717411303424\n  ],\n  "1": "é"\n}'],
  ] as const;
  for (const [code, want] of cases) {
    const r = await session.callTool("codemode", { code });
    assert.equal(r.status, "completed", r.text());
    assert.equal(r.text(), want, code);
  }
});

test("codemode denies ambient OS access and allows explicitly seeded randomness", async t => {
  const { p, result } = await sandbox(t, `from pathlib import Path
import time
import random
import os

def denied(name, probe):
    try:
        probe()
    except Exception:
        print(name)

def network():
    import socket
    return socket.socket()

def process():
    import subprocess
    return subprocess.run(['true'])

denied('open', lambda: open('present.txt'))
denied('path', lambda: Path('present.txt').read_text())
denied('network', network)
denied('process', process)
denied('wall clock', lambda: time.time())
denied('monotonic clock', lambda: time.monotonic())
denied('sleep', lambda: time.sleep(0))
denied('entropy', lambda: os.urandom(1))
denied('unseeded random', lambda: random.random())
denied('unseeded generator', lambda: random.Random().random())
print(time.process_time(), time.thread_time())
random.Random(7).random() == random.Random(7).random()`);
  await p.put(join(p.work, "present.txt"), "not visible");
  const r = await result();
  assert.equal(r.status, "completed", r.text());
  assert.equal(r.text(), "open\npath\nnetwork\nprocess\nwall clock\nmonotonic clock\nsleep\nentropy\nunseeded random\nunseeded generator\n0.0 0.0\ntrue");
});

test("codemode allows 200 recursive frames and rejects 201", async t => {
  const { session } = await sandbox(t, "");
  const code = (frames: number) => `def recurse(n):\n    return recurse(n - 1) if n > 1 else 7\nrecurse(${frames})`;
  const allowed = await session.callTool("codemode", { code: code(200) });
  assert.equal(allowed.status, "completed", allowed.text());
  assert.equal(allowed.text(), "7");
  const denied = await session.callTool("codemode", { code: code(201) });
  assert.equal(denied.status, "failed");
  assert.match(denied.text(), /RecursionError/);
});

test("codemode allows more than 32 MiB but ends a growing allocation with MemoryError", async t => {
  const { session, result } = await sandbox(t, `x = []
for i in range(200000):
    x.append('y' * 10000)
    if i == 6000:
        print('allocated more than 32 MiB')
print('finished allocating')`);
  const r = await result();
  assert.equal(r.status, "failed");
  assert.match(r.text(), /^allocated more than 32 MiB\n/);
  assert.match(r.text(), /MemoryError/);
  assert.doesNotMatch(r.text(), /finished allocating/);
  const next = await session.callTool("codemode", { code: "print('still here')\n6 * 7" });
  assert.equal(next.status, "completed", next.text());
  assert.equal(next.text(), "still here\n42");
});

// A nested call gives the test a barrier before the worker enters the loop.
// Observe CPU time increasing after the barrier to test a live interpreter turn.
async function spinningSandbox(t: TestContext) {
  let markStarted!: () => void, release!: (value: number) => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const released = new Promise<number>(resolve => { release = resolve; });
  const { session, result } = await sandbox(t, "tools.fixture()\nwhile True: pass", () => {
    markStarted();
    return released;
  });
  const running = result();
  let pid: number;
  const ticks = async () => {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[11]); // utime
  };
  try {
    await Promise.race([started, running.then(r => { throw new Error(r?.text() ?? "No tool result"); })]);
    const { stdout } = await exec("ps", ["--ppid", String(process.pid), "-o", "pid=,stat=,comm="]);
    // Retired Monty children can still appear as zombies. They cannot be running this turn.
    const workers = stdout.trim().split("\n").map(line => line.trim().split(/\s+/))
      .filter(([, state, name]) => name === "monty" && !state.startsWith("Z"));
    assert.equal(workers.length, 1, stdout);
    pid = Number(workers[0][0]);
    const before = await ticks();
    release(7);
    while (await ticks() <= before) await delay(10, undefined, { signal: t.signal });
  } finally {
    release(7);
  }
  return { session, running, pid };
}

test("codemode reports when its worker dies and the next run works", { timeout: 10_000, skip: process.platform !== "linux" }, async t => {
  const { session, running, pid } = await spinningSandbox(t);
  process.kill(pid, "SIGKILL");
  const r = await running;
  assert.equal(r.status, "failed");
  assert.match(r.text(), /sandbox worker process died/);
  const next = await session.callTool("codemode", { code: "tools.fixture()" });
  assert.equal(next.status, "completed", next.text());
  assert.equal(next.text(), "7");
});

test("cancelling codemode ends an active turn and frees its worker", { timeout: 10_000, skip: process.platform !== "linux" }, async t => {
  const { session, running, pid } = await spinningSandbox(t);
  try {
    await Promise.race([session.cancel(), delay(5_000, undefined, { ref: false, signal: t.signal }).then(() => {
      assert.fail("Cancellation did not stop the active worker");
    })]);
    assert.equal((await running).status, "cancelled");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    const next = await session.callTool("codemode", { code: "print('after cancellation')" });
    assert.equal(next.status, "completed", next.text());
    assert.equal(next.text(), "after cancellation\n");
  } finally {
    if (await readFile(`/proc/${pid}/stat`).catch(() => undefined)) process.kill(pid, "SIGKILL");
  }
});

test("codemode ends a turn at the computation time limit", { timeout: 40_000 }, async t => {
  const { session, result } = await sandbox(t, "print('started')\nwhile True: pass");
  const r = await result();
  assert.equal(r.status, "failed");
  assert.match(r.text(), /^started\n/);
  assert.match(r.text(), /TimeoutError/);
  const next = await session.callTool("codemode", { code: "21 * 2" });
  assert.equal(next.status, "completed", next.text());
  assert.equal(next.text(), "42");
});

test("a dispatched tool starts a fresh 30-second active wall clock interval", () => {
  const budget = new ComputeBudget(30_000_000);
  budget.observe(25_000_000);
  assert.equal(budget.remaining, 5_000_000);
  budget.dispatchedTool();
  assert.equal(budget.remaining, 30_000_000);
  budget.observe(54_999_999);
  assert.equal(budget.remaining, 1);
  assert.throws(() => budget.observe(55_000_000), /^Error: TimeoutError:/);
});

test("waiting longer than the computation budget for a nested tool does not use it", async t => {
  const { result } = await sandbox(t, "tools.fixture()", async () => {
    await delay(600);
    return 7;
  }, 300);
  const r = await result();
  assert.equal(r.status, "completed", r.text());
  assert.equal(r.text(), "7");
});

for (const [kind, lookup] of Object.entries({
  import: "    import tools\n",
  "name lookup": "    try:\n        unknown_name\n    except NameError:\n        pass\n",
  describe_tool: "    describe_tool('fixture')\n",
  search_tools: "    search_tools('fixture')\n",
})) {
  test(`codemode carries active time across ${kind} suspensions`, async t => {
    // Spend time in the interpreter, not measuring a fixed number of quick
    // pipe round trips. Each slice is small, but 20 million steps exceed 50 ms.
    const { result } = await sandbox(t, `print('started')\nfor block in range(2000):\n    for i in range(10000):\n        pass\n${lookup}    if block == 1:\n        print('resumed')`, undefined, 50);
    const r = await result();
    assert.equal(r.status, "failed");
    assert.match(r.text(), /^started\nresumed\nTimeoutError:/);
  });
}

test("codemode dispatches exactly 500 nested calls without counting lookups or rejected arguments", async t => {
  let calls = 0;
  const { result } = await sandbox(t, `for _ in range(500):
    import tools
    describe_tool('fixture')
    search_tools('fixture')
    try:
        tools.fixture('invalid')
    except TypeError:
        pass
    tools.fixture()
print('reached exactly 500')
tools.fixture()`, () => ++calls);
  const r = await result();
  assert.equal(r.status, "failed");
  assert.equal(calls, 500);
  assert.match(r.text(), /reached exactly 500\n/);
  assert.match(r.text(), /more than 500 function calls/);
});

test("printed output keeps the UTF-8 prefix of the segment that crosses 1 MiB", () => {
  const printed = new PrintedOutput(PRINT_BYTES);
  const start = "a".repeat(PRINT_BYTES - 4);
  printed.append(start);
  assert.throws(() => printed.append("é🙂not kept"), { message: "RuntimeError: printed output exceeded 1048576 bytes" });
  assert.ok(printed.text() === start + "é");
});

test("codemode stops on print overflow before a nested call and cuts the whole result", async t => {
  const cut = await sandbox(t, "print('hi\\n' * 2100, end='')");
  const r = await cut.result();
  assert.equal(r.status, "completed");
  assert.equal(r.text().split("\n").length, 2000);
  assert.match(r.text(), /showing the first 1999 of 2100 lines/);
  let called = false;
  const over = await sandbox(t, "print('é🙂' * 200_000)\ntools.fixture()", () => { called = true; return 7; });
  const out = await over.result();
  assert.equal(out.status, "failed");
  assert.match(out.text(), /^RuntimeError: printed output exceeded 1048576 bytes\né🙂é🙂/);
  assert.doesNotMatch(out.text(), /�/);
  assert.ok(Buffer.byteLength(out.text()) <= 50 * 1024);
  assert.equal(called, false);
});

test("file tools preserve BOM and CRLF, respect .gitignore, and attach images", async t => {
  const { p, result } = await sandbox(t, `tools.edit(path='crlf.txt', edits=[{'oldText':'one\\ntwo', 'newText':'new\\ntext'}])
print(tools.find(pattern='*.txt'))
print(tools.list())
tools.read(path='icon.png')`);
  await p.put(join(p.work, "crlf.txt"), "\ufeffone\r\ntwo\r\n");
  await p.put(join(p.work, ".gitignore"), "hidden.txt\n");
  await p.put(join(p.work, "hidden.txt"), "ignored");
  await writeFile(join(p.work, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const r = await result();
  assert.equal(r.status, "completed", r.text());
  assert.equal(await readFile(join(p.work, "crlf.txt"), "utf8"), "\ufeffnew\r\ntext\r\n");
  assert.equal(r.text(), "crlf.txt\n.gitignore\ncrlf.txt\nhidden.txt\nicon.png\nRead image file [image/png]\n");
  assert.deepEqual(r.content.find(c => c.type === "image"), { type: "image", mimeType: "image/png", data: "iVBORw==" });
});

test("line mode drains /after on EOF and writes verbose command output to stderr", { timeout: 10_000 }, async t => {
  const p = await project(t);
  await p.put(p.script, JSON.stringify([...scripted("tools.exec('printf progress')"), { text: "followed" }]));
  const child = spawn(process.execPath, [cli, "--verbose"], { cwd: p.work, env: p.env, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { child.kill(); });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.stdin.end("first\n/after second\n");
  const [status] = await once(child, "close");
  assert.equal(status, 0, stderr);
  assert.equal(stdout, "done\nfollowed\n");
  assert.match(stderr, /-> exec\(command="printf progress"\)/);
  assert.match(stderr, /\nprogress/);
});

test("state and configuration use the prescribed XDG paths and isolation override", () => {
  assert.deepEqual(paths({ XDG_CONFIG_HOME: "/config", XDG_STATE_HOME: "/state", HOME: "/home" }), { config: "/config/modular-agent", state: "/state/modular-agent/typescript", home: "/home" });
  assert.deepEqual(paths({ MODULAR_AGENT_DATA_DIR: "/isolated", HOME: "/home" }), { config: "/isolated", state: "/isolated/state", home: "/home" });
});

test("prompt matches Rust wording, with instructions, manual-only skills, functions, cwd and date in order", async t => {
  const p = await project(t);
  await p.put(join(p.config, "AGENTS.md"), "Global rules\n");
  await p.put(join(p.dir, "CLAUDE.md"), "Outer rules\n");
  await p.put(join(p.work, "AGENTS.md"), "Project rules\n");
  await p.put(join(p.work, "CLAUDE.md"), "Not selected\n");
  await p.put(join(p.config, "skills", "harbour", "SKILL.md"), "---\nname: harbour\ndescription: >-\n  Salt & tide\n  tables\n---\nSkill steps.\n");
  await p.put(join(p.work, ".agents/skills/duplicate/SKILL.md"), "---\nname: harbour\ndescription: duplicate\n---\nWrong steps\n");
  await p.put(join(p.config, "skills", "manual", "SKILL.md"), "---\ndescription: Not in the prompt\ndisable-model-invocation: true\n---\nManual steps.\n");
  const skills = await p.run("skills");
  assert.match(skills.stderr, /skipped .*skill harbour is already defined by/);
  assert.match(skills.stdout, /manual +Not in the prompt/);
  await p.run("-p", "/skill:manual extra");
  const [req] = (await readFile(p.log, "utf8")).trim().split("\n").map(l => JSON.parse(l));
  const prompt = req.system as string;
  const rust = await readFile(join(root, "rust/crates/standard/src/prompt.rs"), "utf8");
  const preamble = /const PREAMBLE: &str = "([\s\S]*?)";/.exec(rust)?.[1];
  const rules = /const RULES: &str = "([\s\S]*?)";/.exec(rust)?.[1];
  assert.ok(prompt.startsWith(`${preamble}\n\n${rules}\n\n`));
  const sections = ["Global rules", "Outer rules", "Project rules", "<skills>", "Salt &amp; tide tables", "# Functions in codemode", "## tools.exec(command: str, timeout: float = None)", `<cwd>\n${p.work}\n</cwd>`, "<date>\n"];
  let prev = -1;
  for (const part of sections) { const at = prompt.indexOf(part); assert.ok(at > prev, part); prev = at; }
  assert.doesNotMatch(prompt, /Not selected|Not in the prompt|duplicate/);
  assert.match(req.messages[0].text, /Manual steps\.\n<\/skill>\n\nextra$/);
});

test("project MCP only loads after trust, and the setting persists beside global config", async t => {
  const p = await project(t);
  const fixture = join(root, "conformance/reference/mcp-fixture.mjs");
  await p.put(join(p.work, ".mcp.json"), JSON.stringify({ mcpServers: { local: { command: process.execPath, args: [fixture] } } }));
  assert.equal((await p.run("mcp")).stdout, "");
  await p.put(p.script, JSON.stringify(scripted("tools.write('mcp.txt', tools.mcp_local__echo('notes'))")));
  await p.run("--trust-project", "-p", "Try it");
  assert.equal(await readFile(join(p.work, "mcp.txt"), "utf8"), "echo: notes");
  assert.match((await p.run("mcp")).stdout, /local +stdio/);
  assert.deepEqual(JSON.parse(await readFile(join(p.config, "trusted-projects.json"), "utf8")), { [p.work]: true });
});

test("Streamable HTTP MCP expands config values and skips a whole invalid catalog", { timeout: 10_000 }, async t => {
  const p = await project(t);
  const calls: string[] = [];
  const schema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
  const server = createServer(async (req, res) => {
    if (req.method === "GET" || req.method === "DELETE") { res.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body);
    if (msg.id === undefined) { res.writeHead(202).end(); return; }
    calls.push(`${req.url} ${msg.method}`);
    const result = msg.method === "initialize" ? { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : msg.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: schema }, ...(req.url === "/bad" ? [{ name: "invalid.name", inputSchema: schema }] : [])] }
      : { content: [{ type: "text", text: `echo: ${msg.params.arguments.text}` }] };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  Object.assign(p.env, { MA_TEST_HTTP: url });
  await p.put(join(p.config, "mcp.json"), JSON.stringify({ mcpServers: { ok: { url: "${MA_TEST_HTTP}/good" }, bad: { url: "${MA_TEST_HTTP}/bad" } } }));
  await p.put(p.script, JSON.stringify(scripted("print(tools.mcp_ok__echo('wave'))")));
  const result = await p.run("-p", "Echo");
  assert.match(result.stderr, /MCP server bad: invalid MCP tool name mcp_bad__invalid.name/);
  const requests = (await readFile(p.log, "utf8")).trim().split("\n").map(l => JSON.parse(l));
  assert.doesNotMatch(requests[0].system, /mcp_bad__/);
  assert.equal(requests[1].messages.at(-1).text, "echo: wave\n");
  assert.ok(calls.includes("/good tools/call"));
});

test("ACP attaches a client MCP server to its own project and honors project settings", { timeout: 10_000 }, async t => {
  const p = await project(t), work = join(p.dir, "other-project"), untrusted = join(p.dir, "untrusted");
  await p.put(join(work, ".modular-agent.json"), '{"model_tools":null,"plugins":[{"command":"must-not-run"}]}');
  const fixturePath = join(root, "conformance/reference/mcp-fixture.mjs");
  const config = JSON.stringify({ mcpServers: { project: { command: process.execPath, args: [fixturePath] } } });
  await p.put(join(work, ".mcp.json"), config);
  await p.put(join(untrusted, ".mcp.json"), config);
  await p.put(join(untrusted, ".modular-agent.json"), '{"model_tools":null}');
  await p.run("--project", work, "--trust-project", "mcp");
  await p.put(p.script, JSON.stringify([{ toolCalls: [{ name: "mcp_host__echo", input: { text: "tides" } }] }, { text: "ok" }]));
  const child = spawn(process.execPath, [cli, "--acp"], { cwd: p.work, env: p.env, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { child.stdin.end(); child.kill(); });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  lines.on("line", line => {
    const message = JSON.parse(line);
    if (pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); }
  });
  let id = 0;
  async function request(method: string, params: object) {
    const message = await new Promise<Record<string, unknown>>(resolve => {
      pending.set(++id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    assert.equal(message.error, undefined, JSON.stringify(message));
    return message.result;
  }
  await request("initialize", { protocolVersion: 1 });
  const opened = await request("session/new", { cwd: work, mcpServers: [{ name: "host", command: process.execPath,
    args: [fixturePath], env: [] }] }) as { sessionId: string };
  const other = await request("session/new", { cwd: untrusted, mcpServers: [] }) as { sessionId: string };
  await request("session/prompt", { sessionId: opened.sessionId, prompt: [{ type: "text", text: "Echo" }] });
  await request("session/close", { sessionId: opened.sessionId });
  await request("session/prompt", { sessionId: other.sessionId, prompt: [{ type: "text", text: "Echo" }] });
  await request("session/close", { sessionId: other.sessionId });
  const requests = (await readFile(p.log, "utf8")).trim().split("\n").map(l => JSON.parse(l));
  assert.ok(requests[0].tools.includes("mcp_host__echo"));
  assert.ok(requests[0].system.includes(`<cwd>\n${work}\n</cwd>`));
  assert.equal(requests[1].messages.at(-1).text, "echo: tides");
  assert.ok(requests[0].tools.includes("mcp_project__echo"));
  assert.ok(requests[2].system.includes(`<cwd>\n${untrusted}\n</cwd>`));
  assert.ok(!requests[2].tools.includes("mcp_project__echo") && !requests[2].tools.includes("mcp_host__echo"));
});

for (const remote of [false, true]) test(`ma ACP session/new is provisional with ${remote ? "HTTP" : "local file"} history`, { timeout: 10_000 }, async t => {
  const p = await project(t);
  const token = randomBytes(32).toString("hex");
  const tokenFile = join(p.dir, "history-token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const service = remote ? await serveHistory(fileHistory(join(p.dir, "history")), { address: "127.0.0.1:0", tokenFile }) : undefined;
  const env = { ...p.env, MODULAR_AGENT_CONFORMANCE: "1", TMPDIR: process.env.TMPDIR,
    MODULAR_AGENT_TENANTS: JSON.stringify({ demo: { rights: ["watch", "input", "settings"] } }),
    ...(service && { MODULAR_AGENT_HISTORY_URL: service.url, MODULAR_AGENT_HISTORY_TOKEN_FILE: tokenFile }) };
  const child = spawn(process.execPath, [cli, "--acp"], { cwd: p.work, env, stdio: ["pipe", "pipe", "inherit"] });
  const done = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const replies = lines[Symbol.asyncIterator]();
  let id = 0;
  async function request(method: string, params: object) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) + "\n");
    for (;;) {
      const line = await replies.next();
      assert.ok(!line.done, `ACP disconnected during ${method}`);
      const message = JSON.parse(line.value);
      if (message.id !== id) continue;
      assert.equal(message.error, undefined, JSON.stringify(message));
      return message.result;
    }
  }
  async function assertUnpublished(sessionId: string) {
    const listed = await request("session/list", { cwd: p.work });
    assert.deepEqual(listed.sessions, []);
    if (service) {
      const response = await fetch(`${service.url}/v1/sessions/${sessionId}`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 404, "a metadata-only record would return 200");
      await response.arrayBuffer();
    }
  }
  try {
    await request("initialize", { protocolVersion: 1 });
    const location = { cwd: p.work, mcpServers: [] };
    const unused = await request("session/new", location);
    await assertUnpublished(unused.sessionId);
    await request("session/close", { sessionId: unused.sessionId });
    await assertUnpublished(unused.sessionId);

    const { sessionId } = await request("session/new", location);
    await assertUnpublished(sessionId);
    const initial = (await request("_modular-agent/history", { sessionId })).entries as HistoryEntry[];
    assert.equal(initial[0]?.kind, "actorJoined");
    assert.equal((await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Hello" }] })).stopReason, "end_turn");
    await request("session/close", { sessionId });
    const listed = await request("session/list", { cwd: p.work });
    assert.deepEqual(listed.sessions.map((s: { sessionId: string }) => s.sessionId), [sessionId]);
    await request("session/load", { sessionId, cwd: p.work, mcpServers: [] });
    const kept = (await request("_modular-agent/history", { sessionId })).entries as HistoryEntry[];
    assert.deepEqual(kept.slice(0, initial.length), initial);
    assert.deepEqual(kept.slice(initial.length, initial.length + 3).map(e => e.kind), ["inputAccepted", "turnStart", "input"]);
  } finally {
    lines.close();
    child.kill();
    await done;
    await service?.close();
  }
});

test("ma composes only the public SDK and official SDK plugin entry points", async () => {
  const pkg = join(root, "typescript/packages/ma");
  const manifest = JSON.parse(await readFile(join(pkg, "package.json"), "utf8"));
  const allowed = ["@modular-agent/core", "@modular-agent/tools-files", "@modular-agent/tools-mcp", "@pydantic/monty", "protobufjs"]; // Monty's worker wire codec
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), allowed.slice().sort());
  for (const file of await readdir(join(pkg, "src"))) if (file.endsWith(".ts")) {
    const source = await readFile(join(pkg, "src", file), "utf8");
    for (const entry of source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)["']([^"']+)/g)) {
      const spec = entry[1];
      assert.ok(spec.startsWith("node:") || /^\.\/[\w-]+\.(js|json)$/.test(spec) ||
        (file === "monty-worker.ts" && spec === "protobufjs") ||
        ["@modular-agent/core", "@modular-agent/core/testing", "@modular-agent/tools-files/sdk", "@modular-agent/tools-mcp/sdk", "@pydantic/monty"].includes(spec), `${file}: ${spec}`);
    }
  }
});
