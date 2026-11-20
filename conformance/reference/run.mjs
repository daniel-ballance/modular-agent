#!/usr/bin/env node
// The reference checks: run an implementation of the standard configuration (`ma`) with a
// scripted model and check only what it prints, its exit status, the files it leaves and the
// model requests it logs. See README.md and docs/reference/standard-configuration.md.
//
//   node run.mjs [--only NAME[,NAME]] -- <ma command...>
//   node run.mjs [--only ...] --agent LANGUAGE     (from agents/LANGUAGE.json)
//   node run.mjs [--only ...] --all                (every built agent; MODULAR_AGENT_REF_REQUIRE as for fixtures)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const fixture = join(here, "mcp-fixture.mjs");

// ---------- the checks ----------

const codemode = (code) => ({ toolCalls: [{ name: "codemode", input: { code } }] });
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
        portableSessions: true, nestedToolCalls: true, rewinding: true, inputKeys: true, commandContainment: "strong", confinesFiles: false,
        severalActors: false, sessionLimits: false, tenants: false, holdsOutput: false, outputBypassesAgent: false,
        cancellingTurnCancelsJobs: false, pluginsDuringSession: false, keepsStateAtProvider: false,
        runsToolsAtProvider: false, liveSessions: false,
      };
      for (const [k, v] of Object.entries(want)) ok(d?.[k] === v, `${k} is ${JSON.stringify(v)}`, d?.[k]);
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

function runOnce(command, t, run) {
  const env = {
    PATH: process.env.PATH,
    HOME: t.home,
    LANG: "C.UTF-8",
    MODULAR_AGENT_DATA_DIR: t.data,
    MODULAR_AGENT_SCRIPT: t.scriptFile,
    MODULAR_AGENT_SCRIPT_LOG: t.logFile,
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  };
  return new Promise((done) => {
    const child = spawn(command[0], [...command.slice(1), ...run.args], { cwd: t.project, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "", stderr = "", killed = false, timer, poll;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
    if (run.crashWhenFile) {
      poll = setInterval(() => { if (existsSync(join(t.dir, run.crashWhenFile))) { killed = true; kill(); } }, 20);
    }
    timer = setTimeout(() => { kill(); stderr += "\n[run.mjs: timed out after 60 s]"; }, 60_000);
    child.on("error", (e) => { clearTimeout(timer); clearInterval(poll); done({ exit: -1, stdout, stderr: String(e), killed }); });
    child.on("close", (code) => {
      clearTimeout(timer); clearInterval(poll);
      // Wait for the whole group to be gone before the next run reopens the session.
      for (let i = 0; i < 250; i++) { try { process.kill(-child.pid, 0); } catch { break; } spawnSync("sleep", ["0.02"]); }
      done({ exit: code, stdout, stderr, killed });
    });
  });
}

async function runCheck(command, check) {
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
  for (const [i, run] of check.runs.entries()) {
    const r = await runOnce(command, t, run);
    const where = `run ${i + 1} (ma ${run.args.join(" ")})`;
    if (run.crashWhenFile) { ok(r.killed, `${where}: was killed once ${run.crashWhenFile} appeared`, r.stderr.slice(-500)); continue; }
    const e = run.expect ?? {};
    const out = r.stdout.replace(/\n$/, "");
    if (e.exit !== undefined) ok(r.exit === e.exit, `${where}: exit status ${e.exit}`, `${r.exit}; stderr: ${r.stderr.slice(-500)}`);
    if (e.stdout !== undefined) ok(out === e.stdout, `${where}: stdout ${JSON.stringify(e.stdout)}`, out.slice(-300));
    if (e.stdoutContains) ok(out.includes(e.stdoutContains), `${where}: stdout contains ${e.stdoutContains}`, out.slice(-300));
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
    const failures = await runCheck(command, check);
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
