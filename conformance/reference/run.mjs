#!/usr/bin/env node
// The reference checks: run an implementation of the standard configuration (`ma`) with a
// scripted model and check only what it prints, its exit status, the files it leaves and the
// model requests it logs, plus telemetry at a receiver. See README.md and the standard configuration.
//
//   node run.mjs [--only NAME[,NAME]] -- <ma command...>
//   node run.mjs [--only ...] --agent LANGUAGE     (from agents/LANGUAGE.json)
//   node run.mjs [--only ...] --all                (every built agent; MODULAR_AGENT_REF_REQUIRE as for fixtures)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { code as approvalScript, checkApprovalCoversScript } from "./approval-covers-script.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const fixture = join(here, "mcp-fixture.mjs");
const telemetryReply = "reference-telemetry-reply-sentinel";

// ---------- the checks ----------

const codemode = (code) => ({ toolCalls: [{ name: "codemode", input: { code } }] });
const CODEMODE_VALUES = [
  ["{'a': 1, 'b': [1, 2.5, None, True]}", '{\n  "a": 1,\n  "b": [\n    1,\n    2.5,\n    null,\n    true\n  ]\n}'],
  ["(1, 'x')", '[\n  1,\n  "x"\n]'],
  ["1.0", "1.0"],
  ["2**70", "1180591620717411303424"],
  ["b'hi'", "b'hi'"],
  ["{1}", "{1}"],
  ["float('nan')", "nan"],
  ["{'k': 'é'}", '{\n  "k": "é"\n}'],
  ["'text'", "text"],
  ["None", "(no output)"],
  ["[(1,), {2}]", "[(1,), {2}]"],
  ["class P:\n    def __init__(self):\n        self.x = 1\n        self.y = 'a'\n    def __repr__(self):\n        return 'custom'\n[P(), {1}]", "[P(x=1, y='a'), {1}]"],
];
const SIX = ["read", "exec", "edit", "write", "find", "list"];

const checks = [
  {
    name: "print",
    about: "Print mode prints the final answer and offers the model only codemode.",
    script: [{ text: "Hello." }],
    runs: [{ args: ["-p", "Say hello."], expect: { stdout: "Hello.", exit: 0 } }],
    log: (log, ok) => {
      ok(log.length === 1, "one model request", log.length);
      ok(eq(log[0]?.tools, ["codemode"]), "the model is offered only codemode", log[0]?.tools);
      ok(last(log[0], "user")?.text?.includes("Say hello."), "the request carries the prompt", last(log[0], "user"));
    },
  },
  {
    name: "client-identity",
    about: "MA_CLIENT_IDENTITY must be 1 to 64 of A-Z a-z 0-9 . _ -; ma refuses to start otherwise, and accepts a valid one.",
    script: [{ text: "Hello." }, { text: "Hello." }],
    runs: [
      { args: ["-p", "Say hello."], env: { MA_CLIENT_IDENTITY: "bad identity!" }, expect: { exit: 1, stderrContains: "MA_CLIENT_IDENTITY" } },
      { args: ["-p", "Say hello."], env: { MA_CLIENT_IDENTITY: "x".repeat(65) }, expect: { exit: 1, stderrContains: "MA_CLIENT_IDENTITY" } },
      { args: ["-p", "Say hello."], env: { MA_CLIENT_IDENTITY: "my-agent_2.0" }, expect: { stdout: "Hello.", exit: 0 } },
    ],
  },
  {
    name: "approval-covers-script",
    about: "A live or waiting allow covers both writes in this script, once. A refusal writes neither file.",
    script: [codemode(approvalScript), { text: "Done." }],
    run: (command, _invoke, _skip, t) => checkApprovalCoversScript(command, t, environment(t)),
  },
  {
    name: "codemode-nested",
    about: "Code reads and writes files through tools; the nested calls stay out of the model's view.",
    files: { "project/in.txt": "whitby\n" },
    script: [codemode("t = tools.read(path='in.txt')\ntools.write(path='out.txt', content=t.upper())\nprint('copied')"), { text: "Done." }],
    runs: [{ args: ["-p", "Copy it."], expect: { stdout: "Done.", exit: 0, files: { "project/out.txt": { contains: "WHITBY" } } } }],
    log: (log, ok) => {
      const second = log[1];
      ok(!!second, "a second model request after the code ran", log.length);
      const results = (second?.messages ?? []).filter((m) => m.role === "toolResult");
      ok(results.length === 1 && results[0].name === "codemode", "the model sees one result, codemode's", results.map((r) => r.name));
      ok(results[0]?.text?.includes("copied"), "codemode's result carries what was printed", results[0]?.text);
    },
  },
  {
    name: "codemode-tools-values",
    about: "`import tools` gives the tools object; a function assigned to a variable and positional arguments make the same calls.",
    files: { "project/in.txt": "whitby\n" },
    script: [codemode("import tools\nf = tools.read\na = f('in.txt')\nw = tools.write\nw('out.txt', a.upper())\nb = tools.read(path='in.txt')\nprint('same' if a == b else 'different')"), { text: "Done." }],
    runs: [{ args: ["-p", "Copy it."], expect: { stdout: "Done.", exit: 0, files: { "project/out.txt": { contains: "WHITBY" } } } }],
    log: (log, ok) => {
      const results = (log[1]?.messages ?? []).filter((m) => m.role === "toolResult");
      ok(results.length === 1 && results[0].name === "codemode", "the model sees one result, codemode's", results.map((r) => r.name));
      ok(results[0]?.text?.includes("same"), "the alias and the direct call read the same text", results[0]?.text);
    },
  },
  {
    name: "codemode-positional-order",
    about: "Positional arguments take the required fields, then the others in alphabetical order, as the prompt's signature shows.",
    files: { "project/in.txt": "l1\nl2\nl3\nl4\nl5\n" },
    script: [codemode("tools.read('in.txt', 1, 2)"), { text: "Done." }],
    runs: [{ args: ["-p", "Read."], expect: { stdout: "Done.", exit: 0 } }],
    log: (log, ok) => {
      const text = (log[1]?.messages ?? []).filter((m) => m.role === "toolResult").at(-1)?.text ?? "";
      ok(text.startsWith("l2\n") && !text.includes("l3"), "read('in.txt', 1, 2) is limit=1, offset=2", text.slice(0, 200));
      ok(/read\(path: str, limit[^,)]*, offset/.test(JSON.stringify(log[0] ?? {})), "the prompt's signature lists limit before offset", (JSON.stringify(log[0] ?? {}).match(/read\(path[^)]*\)/) ?? [""])[0]);
    },
  },
  {
    name: "codemode-no-ambient-access",
    about: "The sandbox refuses wall clocks, sleep, unseeded randomness and files; a seeded generator works.",
    script: [codemode([
      "def attempt(name, f):",
      "    try:",
      "        f()",
      "        print(name, 'allowed')",
      "    except Exception as e:",
      "        print(name, 'denied')",
      "import time",
      "import random",
      "attempt('clock', lambda: time.time())",
      "attempt('sleep', lambda: time.sleep(0))",
      "attempt('entropy', lambda: random.random())",
      "attempt('file', lambda: open('in.txt'))",
      "r = random.Random(7)",
      "print('seeded', r.random() == random.Random(7).random())",
    ].join("\n")), { text: "Done." }],
    runs: [{ args: ["-p", "Probe."], expect: { stdout: "Done.", exit: 0 } }],
    log: (log, ok) => {
      const text = (log[1]?.messages ?? []).filter((m) => m.role === "toolResult").at(-1)?.text ?? "";
      for (const what of ["clock", "sleep", "entropy", "file"]) ok(text.includes(`${what} denied`), `${what} is denied`, text.slice(0, 400));
      ok(text.includes("seeded True"), "a seeded generator works and repeats", text.slice(0, 400));
    },
  },
  {
    name: "codemode-results",
    about: "exec returns its dict for a non-zero exit and raises for a timeout; a bare tool name is not a function; printing past 1 MiB stops the run with the error first.",
    script: [
      codemode([
        "r = tools.exec(command='exit 3')",
        "print('exit', type(r).__name__, r['exit_code'])",
        "try:",
        "    tools.exec(command='sleep 5', timeout=1)",
        "    print('timeout returned')",
        "except RuntimeError:",
        "    print('timeout RuntimeError')",
        "try:",
        "    read(path='x')",
        "    print('bare allowed')",
        "except NameError:",
        "    print('bare NameError')",
      ].join("\n")),
      codemode("for i in range(2000):\n    print('x' * 1000)\nprint('after')"),
      { text: "Done." },
    ],
    runs: [{ args: ["-p", "Probe."], expect: { stdout: "Done.", exit: 0 } }],
    log: (log, ok) => {
      const result = (req) => (req?.messages ?? []).filter((m) => m.role === "toolResult").at(-1)?.text ?? "";
      const first = result(log[1]), second = result(log[2]);
      ok(first.includes("exit dict 3"), "a non-zero exit returns the dict", first.slice(0, 400));
      ok(first.includes("timeout RuntimeError"), "a timed-out exec raises RuntimeError", first.slice(0, 400));
      ok(first.includes("bare NameError"), "a bare tool name raises NameError", first.slice(0, 400));
      ok(second.startsWith("RuntimeError: printed output exceeded 1048576 bytes\nxxx") && !second.includes("after"), "printing past 1 MiB stops the run; the result starts with the error, then the output", second.slice(0, 200));
    },
  },
  {
    name: "codemode-values",
    about: "The last expression's value is given as JSON when it can be, otherwise as its repr; a TypeError for bad arguments; an uncaught error ends with its traceback.",
    script: [...CODEMODE_VALUES.map(([code]) => codemode(code)),
      codemode("tools.write('a.txt', 'hi', None)"), codemode("tools.write({'path': 'b.txt', 'content': 'by name'})"),
      codemode("print('before')\nraise ValueError('stop here')"), { text: "Done." }],
    runs: [{ args: ["-p", "Values."], expect: { stdout: "Done.", exit: 0, files: { "project/a.txt": { absent: true }, "project/b.txt": "by name" } } }],
    log: (log, ok) => {
      const result = (req) => (req?.messages ?? []).filter((m) => m.role === "toolResult").at(-1)?.text ?? "";
      CODEMODE_VALUES.forEach(([code, want], i) => ok(result(log[i + 1]) === want, `${code} is given as ${JSON.stringify(want)}`, result(log[i + 1])));
      const n = CODEMODE_VALUES.length;
      ok(result(log[n + 1]).trimEnd().split("\n").at(-1).startsWith("TypeError:"), "too many arguments raises TypeError", result(log[n + 1]).slice(-300));
      const raised = result(log[n + 3]);
      ok(raised.startsWith("before\nTraceback") && raised.trimEnd().endsWith("ValueError: stop here"), "an uncaught error gives the output, then the traceback ending Type: message", raised.slice(0, 400));
    },
  },
  {
    name: "sandbox-memory",
    about: "Code that outgrows the 256 MiB sandbox limit fails with MemoryError; the agent carries on and the next run works.",
    // Bounded at about 2 GB, so a build without the limit fails this check rather than exhausting the machine.
    script: [codemode("x = []\nfor i in range(200000):\n    x.append('y' * 10000)\nprint(len(x))"), codemode("print('still here')"), { text: "Done." }],
    runs: [{ args: ["-p", "Fill memory."], expect: { stdout: "Done.", exit: 0 } }],
    log: (log, ok) => {
      const result = (req) => (req?.messages ?? []).filter((m) => m.role === "toolResult").at(-1)?.text ?? "";
      ok(log.length === 3, "three model requests", log.length);
      ok(result(log[1]).includes("MemoryError"), "the first run fails with MemoryError", result(log[1]).slice(0, 300));
      ok(!result(log[1]).includes("200000"), "the first run did not finish", result(log[1]).slice(0, 300));
      ok(result(log[2]).includes("still here"), "the next run works", result(log[2]).slice(0, 300));
    },
  },
  {
    name: "one-offer",
    about: "A direct call to a tool the model was not offered does not run.",
    script: [{ toolCalls: [{ name: "write", input: { path: "direct.txt", content: "x" } }] }, { text: "ok" }],
    runs: [{ args: ["-p", "Write it."], expect: { files: { "project/direct.txt": { absent: true } } } }],
  },
  {
    name: "model-tools-null",
    about: "With model_tools null the six tools are offered directly and run.",
    files: { "data/settings.json": JSON.stringify({ model_tools: null }) },
    script: [{ toolCalls: [{ name: "write", input: { path: "direct.txt", content: "x" } }] }, { text: "ok" }],
    runs: [{ args: ["-p", "Write it."], expect: { stdout: "ok", exit: 0, files: { "project/direct.txt": "x" } } }],
    log: (log, ok) => {
      const tools = log[0]?.tools ?? [];
      ok(["codemode", ...SIX].every((t) => tools.includes(t)), "codemode and the six tools are offered", tools);
    },
  },
  {
    name: "instructions",
    about: "Global and project AGENTS.md reach the prompt, global first, with the working folder.",
    files: { "data/AGENTS.md": "GLOBAL-RULE-7\n", "project/AGENTS.md": "PROJECT-RULE-9\n" },
    script: [{ text: "ok" }],
    runs: [{ args: ["-p", "Hi."], expect: { exit: 0 } }],
    log: (log, ok, t) => {
      const s = log[0]?.system ?? "";
      ok(s.includes("GLOBAL-RULE-7") && s.includes("PROJECT-RULE-9"), "both instruction files are in the prompt", s.slice(0, 200));
      ok(s.indexOf("GLOBAL-RULE-7") < s.indexOf("PROJECT-RULE-9"), "global instructions come first");
      ok(s.includes(t.project), "the prompt names the working folder", t.project);
    },
  },
  {
    name: "skills",
    about: "A project skill is listed in the prompt, and /skill:NAME puts its body in the input.",
    files: { "project/.agents/skills/harbour/SKILL.md": "---\nname: harbour\ndescription: Tide tables for Yorkshire harbours\n---\nSKILL-BODY-42\n" },
    script: [{ text: "ok" }],
    runs: [
      { args: ["-p", "Hi."], expect: { exit: 0 } },
      { args: ["-p", "/skill:harbour"], expect: { exit: 0 } },
    ],
    log: (log, ok) => {
      const s = log[0]?.system ?? "";
      ok(s.includes("harbour") && s.includes("Tide tables for Yorkshire harbours"), "the skill is listed in the prompt", s.slice(0, 200));
      const input = log.slice(1).flatMap((r) => r.messages ?? []).filter((m) => m.role === "user").map((m) => m.text).join("\n");
      ok(input.includes("SKILL-BODY-42"), "/skill:harbour puts the body in the input", input.slice(0, 200));
    },
  },
  {
    name: "mcp",
    about: "An MCP server's tool is a function in codemode.",
    files: { "data/mcp.json": () => JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture] } } }) },
    script: [codemode("tools.write(path='mcp.txt', content=str(tools.mcp_fixture__echo(text='harbour')))"), { text: "ok" }],
    runs: [{ args: ["-p", "Echo."], expect: { exit: 0, files: { "project/mcp.txt": { contains: "echo: harbour" } } } }],
    log: (log, ok) => ok((log[0]?.system ?? "").includes("mcp_fixture__echo"), "the prompt lists the MCP function", (log[0]?.system ?? "").slice(-300)),
  },
  {
    name: "continue",
    about: "-c reopens this folder's last session, and the model sees the earlier exchange.",
    script: [{ text: "one" }, { text: "two" }],
    runs: [
      { args: ["-p", "first"], expect: { stdout: "one", exit: 0 } },
      { args: ["-c", "-p", "second"], expect: { stdout: "two", exit: 0 } },
    ],
    log: (log, ok) => {
      const texts = (log[1]?.messages ?? []).map((m) => `${m.role}:${m.text}`);
      ok(texts.includes("user:first") && texts.includes("assistant:one") && texts.includes("user:second"), "the second request carries the first exchange", texts);
    },
  },
  {
    name: "durable-crash",
    about: "A kill -9 during a command in code: on reopen the turn carries on, and neither the code nor the command runs again.",
    script: [codemode("tools.exec(command='echo started >> started.txt; sleep 60')"), { text: "recovered" }, { text: "after" }],
    runs: [
      { args: ["-p", "go"], crashWhenFile: "project/started.txt" },
      { args: ["-c", "-p", "next"], expect: { stdout: "after", exit: 0, files: { "project/started.txt": "started\n" } } },
    ],
    log: (log, ok) => {
      const recovered = log.find((r) => (r.messages ?? []).at(-1)?.role === "toolResult");
      ok(!!recovered, "the interrupted turn made another model request after the code's result was settled");
    },
  },
  {
    name: "resume-open",
    about: "An interrupted served turn carries on at startup only when requested. Its tool effect happens once.",
    script: [codemode("tools.exec(command='echo once >> effect; while test ! -f release; do sleep 0.1; done')"), { text: "Recovered without a repeated effect." }],
    async run(command, invoke, skip, t) {
      const { checkResumeOpen } = await import("./resume-open.mjs");
      await checkResumeOpen(command, t, environment(t));
    },
  },
  {
    name: "transient-crash",
    about: "With the transient Runtime the interrupted turn fails on reopen, and nothing runs again.",
    script: [codemode("tools.exec(command='echo started >> started.txt; sleep 60')"), { text: "after" }],
    runs: [
      { args: ["--runtime", "transient", "-p", "go"], crashWhenFile: "project/started.txt" },
      { args: ["--runtime", "transient", "-c", "-p", "next"], expect: { stdout: "after", exit: 0, files: { "project/started.txt": "started\n" } } },
    ],
  },
  {
    name: "declaration",
    about: "ma --declaration prints the declaration the standard configuration publishes, as one JSON object.",
    git: true,
    script: [],
    runs: [{ args: ["--declaration"], expect: { exit: 0, json: (d, ok) => {
      const want = {
        inputDuringTurn: true, continuesAfterRestart: true, waitingThroughRestart: true, questionsOutlastTurns: true,
        lateAnswersStartTurns: true, startsTurnsUnasked: "jobReports", queuedInputAfterRestart: "handedBack",
        queuedJobReportsAfterRestart: "run", settingsDuringTurn: "refused", erasureDuringTurn: "refused",
        movingWithUnfinishedWork: "refused", mixedActorInput: "refused", forking: true, erasure: true,
        portableSessions: true, nestedToolCalls: true, rewinding: true, inputKeys: true, commandContainment: process.platform === "darwin" ? "processGroup" : "strong", confinesFiles: false,
        severalActors: false, sessionLimits: false, tenants: false, holdsOutput: false, outputBypassesAgent: false,
        cancellingTurnCancelsJobs: false, pluginsDuringSession: false, keepsStateAtProvider: false,
        runsToolsAtProvider: false, liveSessions: false,
      };
      for (const [k, v] of Object.entries(want)) ok(d?.[k] === v, `${k} is ${JSON.stringify(v)}`, d?.[k]);
      for (const key of ["approvalCoversNested", "approvalsOutlastTurns"]) ok(!(key in d), key + " is omitted without approval");
      ok(d?.projectRoot === undefined, "projectRoot is omitted", d?.projectRoot);
    } } }],
  },
  {
    name: "points-in-git",
    about: "In a git project, a turn saves a point under refs/modular-agent/ and leaves HEAD, the index and git log alone.",
    git: true,
    files: { "project/tracked.txt": "one\n" },
    script: [{ text: "ok" }],
    runs: [{ args: ["-p", "Hi."], expect: { stdout: "ok", exit: 0 } }],
    after: (t, ok) => {
      const refs = gitOut(t.project, ["for-each-ref", "--format=%(refname)", "refs/modular-agent/points/"]).split("\n").filter(Boolean);
      ok(refs.length >= 1, "a point was saved under refs/modular-agent/points/", refs);
      ok(gitOut(t.project, ["rev-parse", "--verify", "-q", "HEAD"]) === "", "no commit was made on a branch");
      ok(gitOut(t.project, ["status", "--porcelain"]).includes("?? tracked.txt"), "the person's index is untouched", gitOut(t.project, ["status", "--porcelain"]));
    },
  },
  {
    name: "points-outside-git",
    about: "Outside a git work tree there are no points: rewinding is false and nothing is said about it.",
    script: [{ text: "ok" }],
    runs: [
      { args: ["-p", "Hi."], expect: { stdout: "ok", exit: 0, stderrLacks: "saved point" } },
      { args: ["--declaration"], expect: { exit: 0, json: (d, ok) => ok(d?.rewinding === false, "rewinding is false", d?.rewinding) } },
    ],
  },
  {
    name: "prompt-tail",
    about: "The prompt ends with the working folder in <cwd> and the local date in <date>.",
    script: [{ text: "ok" }],
    runs: [{ args: ["-p", "Hi."], expect: { exit: 0 } }],
    log: (log, ok, t) => {
      const s = log[0]?.system ?? "";
      const cwd = s.lastIndexOf("<cwd>"), date = s.lastIndexOf("<date>");
      ok(cwd >= 0 && s.slice(cwd).includes(t.project), "a <cwd> section names the working folder", s.slice(-300));
      ok(date > cwd && /<date>\s*\d{4}-\d{2}-\d{2}/.test(s.slice(date)), "a <date> section with YYYY-MM-DD follows it", s.slice(-200));
    },
  },
  {
    name: "json-events",
    about: "--json prints one SDK-shaped event per line, ending the turn with turnEnded.",
    script: [{ text: "Hello." }],
    runs: [{ args: ["--json", "-p", "Hi."], expect: { exit: 0, jsonLines: (events, ok) => {
      ok(events.length > 0 && events.every((e) => typeof e.type === "string" && "time" in e && "data" in e), "every line has type, time and data", events.slice(0, 3));
      ok(events.some((e) => e.type === "turnEnded"), "a turnEnded event is printed", events.map((e) => e.type));
      ok(events.some((e) => e.type === "text" && JSON.stringify(e.data).includes("Hello.")), "the model's text arrives as text events", events.map((e) => e.type));
    } } }],
  },
  {
    name: "models",
    about: "ma models lists the scripted model.",
    script: [],
    runs: [{ args: ["models"], expect: { exit: 0, stdoutContains: "scripted/script" } }],
  },
  {
    name: "telemetry-export",
    about: "Telemetry is off by default, exports metadata to a configured endpoint, and can be disabled again.",
    script: [{ text: telemetryReply }],
    async run(command, invoke, skip) {
      const { checkTelemetryExport } = await import("./telemetry-export.mjs");
      await checkTelemetryExport(command, invoke, skip, telemetryReply);
    },
  },
  {
    name: "trace-trust",
    about: "ma continues work in the supplied trace only for a trace-trusted connection.",
    script: Array.from({ length: 6 }, () => ({ text: "Hello." })),
    async run(command, invoke, skip, t) {
      const { checkTraceTrust } = await import("./trace-trust.mjs");
      await checkTraceTrust(command, t, environment(t), invoke);
    },
  },
  {
    name: "version",
    about: "ma --version names the implementation's language.",
    script: [],
    runs: [{ args: ["--version"], expect: { exit: 0, stdoutMatches: /\b(rust|typescript|go|python)\b/i } }],
  },
];

// ---------- running ----------

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const gitOut = (dir, args) => { const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : ""; };
const last = (req, role) => (req?.messages ?? []).filter((m) => m.role === role).at(-1);

function environment(t) {
  return {
    PATH: process.env.PATH,
    HOME: t.home,
    LANG: "C.UTF-8",
    MODULAR_AGENT_DATA_DIR: t.data,
    MODULAR_AGENT_SCRIPT: t.scriptFile,
    MODULAR_AGENT_SCRIPT_LOG: t.logFile,
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  };
}

function runOnce(command, t, run) {
  const env = { ...environment(t), ...run.env };
  return new Promise((done) => {
    const child = spawn(command[0], [...command.slice(1), ...run.args], { cwd: t.project, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "", stderr = "", killed = false, timer, poll;
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const lifecycle = {};
    child.stdout.on("data", (d) => { stdout += d; lifecycle.lastStdoutMs = elapsed(); });
    child.stderr.on("data", (d) => { stderr += d; lifecycle.lastStderrMs = elapsed(); });
    child.stdout.on("end", () => { lifecycle.stdoutEndMs = elapsed(); });
    child.stderr.on("end", () => { lifecycle.stderrEndMs = elapsed(); });
    child.on("exit", (code, signal) => Object.assign(lifecycle, { exitMs: elapsed(), code, signal }));
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
    if (run.crashWhenFile) {
      poll = setInterval(() => { if (existsSync(join(t.dir, run.crashWhenFile))) { killed = true; kill(); } }, 20);
    }
    let timeoutDetail;
    timer = setTimeout(() => {
      // An exited agent and a descendant still holding a pipe can delay 'close'.
      // Capture process names and states, not command arguments.
      const ps = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,comm="], { encoding: "utf8", timeout: 1000 });
      const table = (ps.stdout ?? "").split("\n").map((line) => line.trim().split(/\s+/, 5));
      const related = new Set([String(child.pid)]);
      for (let size = -1; size !== related.size;) {
        size = related.size;
        for (const [pid, ppid, pgid] of table) if (related.has(ppid) || pgid === String(child.pid)) related.add(pid);
      }
      const processes = table.filter(([pid]) => related.has(pid)).map((fields) => fields.join(" "));
      timeoutDetail = JSON.stringify({ pid: child.pid, elapsedMs: elapsed(), ...lifecycle, processes });
      kill();
      // A child that left the process group can still hold these pipes open.
      child.stdout.destroy();
      child.stderr.destroy();
    }, 60_000);
    child.on("error", (e) => { clearTimeout(timer); clearInterval(poll); done({ exit: -1, stdout, stderr: String(e), killed }); });
    child.on("close", (code) => {
      clearTimeout(timer); clearInterval(poll);
      // Wait for the whole group to be gone before the next run reopens the session.
      for (let i = 0; i < 250; i++) { try { process.kill(-child.pid, 0); } catch { break; } spawnSync("sleep", ["0.02"]); }
      done({ exit: code, stdout, stderr, killed, timeoutDetail });
    });
  });
}

async function runCheck(command, check, skip) {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ma-ref-"));
  const t = { dir, home: join(dir, "home"), data: join(dir, "data"), project: join(dir, "project"), scriptFile: join(dir, "script.json"), logFile: join(dir, "requests.jsonl") };
  for (const d of [t.home, t.data, t.project]) mkdirSync(d, { recursive: true });
  for (const [path, content] of Object.entries(check.files ?? {})) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof content === "function" ? content() : content);
  }
  if (check.git) spawnSync("git", ["init", "-q", t.project], { stdio: "ignore" });
  writeFileSync(t.scriptFile, JSON.stringify(check.script));
  const failures = [];
  const ok = (cond, what, got) => { if (!cond) failures.push(got === undefined ? what : `${what}: got ${JSON.stringify(got)}`); };
  if (check.run) {
    try { await check.run(command, (cmd, run) => runOnce(cmd, t, run), skip, t); }
    catch (error) { failures.push(error.message); }
  }
  for (const [i, run] of (check.runs ?? []).entries()) {
    const r = await runOnce(command, t, run);
    const where = `run ${i + 1} (ma ${run.args.join(" ")})`;
    ok(!r.timeoutDetail, `${where}: timed out after 60 s`, r.timeoutDetail);
    if (run.crashWhenFile) { ok(r.killed, `${where}: was killed once ${run.crashWhenFile} appeared`, r.stderr.slice(-500)); continue; }
    const e = run.expect ?? {};
    const out = r.stdout.replace(/\n$/, "");
    if (e.exit !== undefined) ok(r.exit === e.exit, `${where}: exit status ${e.exit}`, `${r.exit}; stderr: ${r.stderr.slice(-500)}`);
    if (e.stdout !== undefined) ok(out === e.stdout, `${where}: stdout ${JSON.stringify(e.stdout)}`, out.slice(-300));
    if (e.stdoutContains) ok(out.includes(e.stdoutContains), `${where}: stdout contains ${e.stdoutContains}`, out.slice(-300));
    if (e.stderrContains) ok(r.stderr.includes(e.stderrContains), `${where}: stderr mentions ${JSON.stringify(e.stderrContains)}`, r.stderr.slice(-300));
    if (e.stderrLacks) ok(!r.stderr.includes(e.stderrLacks), `${where}: stderr does not mention ${JSON.stringify(e.stderrLacks)}`, r.stderr.slice(-300));
    if (e.stdoutMatches) ok(e.stdoutMatches.test(out), `${where}: stdout matches ${e.stdoutMatches}`, out.slice(-300));
    if (e.json) { let v; try { v = JSON.parse(out); } catch { ok(false, `${where}: stdout is one JSON object`, out.slice(0, 300)); } if (v !== undefined) e.json(v, (c, w, g) => ok(c, `${where}: ${w}`, g)); }
    if (e.jsonLines) { let v; try { v = out.split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { ok(false, `${where}: every stdout line is JSON`, out.slice(0, 300)); } if (v) e.jsonLines(v, (c, w, g) => ok(c, `${where}: ${w}`, g)); }
    for (const [path, want] of Object.entries(e.files ?? {})) {
      const full = join(dir, path), exists = existsSync(full), got = exists ? readFileSync(full, "utf8") : undefined;
      if (want?.absent) ok(!exists, `${where}: ${path} does not exist`, got);
      else if (want?.contains) ok(got?.includes(want.contains), `${where}: ${path} contains ${JSON.stringify(want.contains)}`, got ?? "(missing)");
      else ok(got === want, `${where}: ${path} is ${JSON.stringify(want)}`, got ?? "(missing)");
    }
  }
  if (check.after) check.after(t, (c, w, g) => ok(c, `after: ${w}`, g));
  if (check.log) {
    const log = existsSync(t.logFile) ? readFileSync(t.logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    check.log(log, (c, w, g) => ok(c, `requests: ${w}`, g), t);
  }
  if (!failures.length) rmSync(dir, { recursive: true, force: true });
  return failures.map((f) => `${f}${failures.length ? `  [kept ${dir}]` : ""}`);
}

async function runAgent(name, command, only) {
  let failed = 0, passed = 0;
  for (const check of checks.filter((c) => !only || only.includes(c.name))) {
    const failures = await runCheck(command, check, reason => console.log(`SKIP ${name} ${check.name}: ${reason}`));
    if (failures.length) { failed++; console.log(`FAIL ${name} ${check.name}: ${check.about}`); for (const f of failures) console.log(`     ${f}`); }
    else { passed++; console.log(`PASS ${name} ${check.name}`); }
  }
  console.log(`${name}: ${passed} passed, ${failed} failed`);
  return failed;
}

function agents() {
  const dir = join(here, "agents");
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    const a = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const command = a.command.map((x) => x.replaceAll("{repo}", repo));
    const missing = a.command.filter((x) => x.startsWith("{repo}")).map((x) => x.replaceAll("{repo}", repo)).filter((p) => !existsSync(p));
    return { ...a, command, missing };
  });
}

const argv = process.argv.slice(2);
const onlyAt = argv.indexOf("--only");
const only = onlyAt >= 0 ? argv[onlyAt + 1].split(",") : undefined;
const dash = argv.indexOf("--");
let failed = 0;
if (dash >= 0) {
  failed += await runAgent("ma", argv.slice(dash + 1), only);
} else if (argv.includes("--agent") || argv.includes("--all")) {
  const pick = argv.includes("--all") ? undefined : argv[argv.indexOf("--agent") + 1];
  const require = (process.env.MODULAR_AGENT_REF_REQUIRE ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const a of agents().filter((a) => !pick || a.language === pick)) {
    if (a.missing.length) {
      const why = `${a.language}: not built (${a.missing.join(", ")}); build with: ${a.build}`;
      if (pick || require.includes("all") || require.includes(a.language)) { console.log(`FAIL ${why}`); failed++; } else console.log(`SKIP ${why}`);
      continue;
    }
    failed += await runAgent(a.language, a.command, only);
  }
} else {
  console.error("usage: node run.mjs [--only NAMES] (-- <ma command...> | --agent LANGUAGE | --all)");
  process.exit(2);
}
process.exit(failed ? 1 : 0);
