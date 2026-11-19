import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { createAgent, tool } from "@modular-agent/core";
import { scriptedProvider } from "@modular-agent/core/testing";
import { standardFileTools } from "@modular-agent/tools-files/sdk";
import { codemode } from "../src/codemode.js";
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
  return { dir, home, config, work, script, log, put, run: (...args: string[]) => exec(process.execPath, [cli, ...args], { cwd: work, env }) };
}
const scripted = (code: string) => [{ toolCalls: [{ name: "codemode", input: { code } }] }, { text: "done" }];
async function sandbox(t: TestContext, code: string) {
  const p = await project(t);
  const agent = await createAgent({ project: p.work, providers: [scriptedProvider(scripted(code))], settings: { modelTools: ["codemode"] },
    plugins: [standardFileTools({ spill: join(p.dir, "output") }), codemode()],
    tools: [tool({ name: "fixture", description: "Fixture returns a number", input: { type: "object", properties: {}, additionalProperties: false }, run: () => 7 })] });
  t.after(() => agent.close());
  return { p, result: async () => (await (await agent.session()).prompt("Run the code.")).toolResults()[0] };
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
  assert.equal(r.text(), "harbour\n3\ntools.read(path: str, limit: float = None, offset: float = None)\nfixture\n7\nread() failed: File not found: missing\nread(): got two values for path\nending");
  assert.equal(await readFile(join(p.work, "a.txt"), "utf8"), "harbour");
});

test("codemode filters host OS calls and reports recursion errors", async t => {
  const { result } = await sandbox(t, `from pathlib import Path
try:
    Path('/etc/passwd').read_text()
except RuntimeError as e:
    print(str(e))
import time
try:
    time.time()
except RuntimeError as e:
    print(str(e))
def recurse():
    return recurse()
recurse()`);
  const r = await result();
  assert.equal(r.status, "failed");
  assert.match(r.text(), /no direct access to files, the network, the clock or the environment/);
  assert.match(r.text(), /RecursionError/);
});

test("codemode dispatches no more than 500 nested calls", async t => {
  const { result } = await sandbox(t, "for _ in range(501):\n    tools.fixture()");
  const r = await result();
  assert.equal(r.status, "failed");
  assert.match(r.text(), /more than 500 function calls/);
});

test("codemode cuts result lines and rejects printed output over 1 MiB", async t => {
  const cut = await sandbox(t, "print('hi\\n' * 2100, end='')");
  const r = await cut.result();
  assert.equal(r.status, "completed");
  assert.match(r.text(), /showing the first 2000 of 2100 lines/);
  const over = await sandbox(t, "print('x' * 1_100_000)");
  const out = await over.result();
  assert.equal(out.status, "failed");
  assert.match(out.text(), /printed output exceeded/);
  assert.ok(Buffer.byteLength(out.text()) < 52_000);
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

test("ma composes only the public SDK and official SDK plugin entry points", async () => {
  const pkg = join(root, "typescript/packages/ma");
  const manifest = JSON.parse(await readFile(join(pkg, "package.json"), "utf8"));
  const allowed = ["@modular-agent/core", "@modular-agent/tools-files", "@modular-agent/tools-mcp", "@pydantic/monty"];
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), allowed.slice().sort());
  for (const file of await readdir(join(pkg, "src"))) if (file.endsWith(".ts")) {
    const source = await readFile(join(pkg, "src", file), "utf8");
    for (const entry of source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)["']([^"']+)/g)) {
      const spec = entry[1];
      assert.ok(spec.startsWith("node:") || /^\.\/[\w-]+\.(js|json)$/.test(spec) ||
        ["@modular-agent/core", "@modular-agent/core/testing", "@modular-agent/tools-files/sdk", "@modular-agent/tools-mcp/sdk", "@pydantic/monty"].includes(spec), `${file}: ${spec}`);
    }
  }
});
