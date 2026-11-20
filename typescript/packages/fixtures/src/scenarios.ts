import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Actor, AgentOptions, Answer, InputTiming, PromptResult, Session } from "@modular-agent/core";
import { answers, testAgent, type ScriptStep } from "@modular-agent/core/testing";
import { count, fixture } from "./index.js";

const repo = fileURLToPath(new URL("../../../../../", import.meta.url)).replace(/\/$/, "");
const files = (dir: string) => readdirSync(dir).filter(f => f.endsWith(".json")).sort().map(f => join(dir, f));
const load = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8"));
export const scenarioFiles = () => files(join(repo, "conformance/sdk/scenarios"));
export type Placement = { name: string; command?: string[] };
export function placements(require = process.env.MODULAR_AGENT_SDK_REQUIRE): Placement[] {
  // `all`, or a comma-separated list of SDKs (docs/sdk/testing.md#finding-the-fixture-programs).
  const names = (require ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const all = names.includes("all");
  const required = new Set(names.filter(n => n !== "all"));
  const out: Placement[] = [{ name: "inProcess" }];
  const available = new Set<string>();
  for (const file of files(join(repo, "conformance/sdk/fixtures"))) {
    const { sdk, build, command } = load<{ sdk: string; build: string; command: string[] }>(file);
    const argv = command.map(a => a.replaceAll("{repo}", repo));
    if (command.some((a, i) => a.startsWith("{repo}") && !existsSync(argv[i]))) {
      const note = `${sdk} not built; build with: ${build}`;
      if (all || required.has(sdk) || sdk === "typescript") throw new Error(note);
      console.error(note);
      continue;
    }
    available.add(sdk);
    out.push({ name: `process:${sdk}`, command: argv });
  }
  for (const sdk of required) if (!available.has(sdk)) throw new Error(`Required fixture program ${sdk} is not registered`);
  return out;
}

type Expect = { outcome?: string; text?: string; toolResults?: { name: string; status: string; text?: string; contains?: string }[]; records?: string[]; count?: number; error?: string };
type Crash = { record: string } | { count: number };
type Step = ({ prompt: string; as?: string; crashWhen?: Crash } | { reopen: true } |
  { send: string; timing?: InputTiming } | { answer: Answer } | { wait: true }) & { expect?: Expect };
export interface Scenario {
  scenario: string;
  agent: Pick<AgentOptions, "durability" | "approval" | "settings" | "severalActors"> & { plugins?: string[]; answers?: Answer[]; actors?: Actor[] };
  model: ScriptStep[];
  steps: Step[];
  placements?: string[];
}
export const loadScenario = load<Scenario>;
export const applies = (s: Scenario, p: Placement) => !s.placements || s.placements.includes(p.name) || !!p.command && s.placements.includes("process");
const countFile = (dir: string) => join(dir, "count");

export async function scenarioAgent(s: Scenario, dir: string, p: Placement,
  handler = s.agent.answers && answers(s.agent.answers)) {
  const project = join(dir, "project");
  await mkdir(project, { recursive: true });
  const { plugins = [], answers: _answers, actors: _actors, ...options } = s.agent;
  const config = { path: countFile(dir) };
  return testAgent({ ...options, script: s.model, project, dataDir: join(dir, "data"),
    onQuestion: handler,
    ...(p.command ? { processPlugins: plugins.map(name => ({ command: [...p.command!, name], config })) }
      : { plugins: plugins.map(name => fixture(name, config)) }),
  });
}

// A process that is already a zombie cannot race recovery. Container PID 1
// may not reap orphaned killed plugins. On Linux check actual group states.
async function waitGroup(pid: number) {
  const deadline = Date.now() + 5000;
  while (true) {
    let live: boolean;
    if (process.platform === "linux") {
      live = readdirSync("/proc").filter(n => /^\d+$/.test(n)).some(n => {
        try {
          const stat = readFileSync(`/proc/${n}/stat`, "utf8");
          const [state, _ppid, group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          return Number(group) === pid && state !== "Z" && state !== "X";
        } catch (error) {
          if (!["ENOENT", "ESRCH", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          return false;
        }
      });
    } else {
      const { stdout } = await promisify(execFile)("ps", ["-ax", "-o", "pgid=,stat="], { timeout: 2_000 });
      live = stdout.split("\n").some(line => {
        const [group, state] = line.trim().split(/\s+/);
        return Number(group) === pid && !!state && !/^[ZX]/.test(state);
      });
    }
    if (!live) return;
    if (Date.now() > deadline) throw new Error(`Crash process group ${pid} is still running`);
    await delay(20);
  }
}

async function crashRun(path: string, dir: string, p: Placement, i: number, when: Crash, previous?: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./scenario-agent.js", import.meta.url)),
    path, dir, String(i), JSON.stringify(p), previous ?? ""], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
  // Node has reaped the direct child by the time it emits close, even if
  // orphaned grandchildren in the group are still awaiting reaping.
  const reaped = new Promise<void>(resolve => child.once("close", () => resolve()));
  let failure: unknown;
  child.on("error", error => { failure = error; });
  let sessionId: string | undefined;
  let record = false;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    if (line.startsWith("SESSION ")) sessionId = line.slice(8);
    if ("record" in when && line === `RECORD ${when.record}`) record = true;
  });
  try {
    const deadline = Date.now() + 30_000;
    while (!sessionId || !("count" in when ? count(countFile(dir)) >= when.count : record)) {
      if (failure || child.exitCode !== null || child.signalCode !== null) throw failure ?? new Error("Crash helper exited before the condition held");
      if (Date.now() > deadline) throw new Error(`Crash condition never held: ${JSON.stringify(when)}`);
      await delay(20);
    }
    return sessionId;
  } finally {
    const pid = child.pid;
    if (pid) {
      try { process.kill(-pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await reaped;
    if (pid) await waitGroup(pid);
    lines.close();
  }
}

export async function runScenario(path: string, p: Placement): Promise<string[]> {
  const s = loadScenario(path);
  const dir = await mkdtemp(join(tmpdir(), "sdk-scenario-"));
  const failures: string[] = [];
  const handler = s.agent.answers && answers(s.agent.answers);
  let id: string | undefined;
  let a: Awaited<ReturnType<typeof scenarioAgent>> | undefined;
  let session: Session | undefined;
  try {
    for (const [i, step] of s.steps.entries()) {
      const want = step.expect ?? {};
      const fail = (field: string, expected: unknown, actual: unknown) =>
        failures.push(`${s.scenario} (${p.name}) step ${i}: ${field}: want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      const compare = (field: string, expected: unknown, actual: unknown) => {
        if (expected !== undefined && expected !== actual) fail(field, expected, actual);
      };
      let result: PromptResult | undefined;
      try {
        if ("prompt" in step && step.crashWhen) {
          await a?.close(); a = undefined; session = undefined;
          id = await crashRun(path, dir, p, i, step.crashWhen, id);
        } else if ("reopen" in step) {
          await a?.close(); a = undefined; session = undefined;
          if (!id) throw new Error("No session to reopen");
          a = await scenarioAgent(s, dir, p, handler);
          session = await a.openSession(id);
          result = await session.lastTurn();
        } else {
          a ??= await scenarioAgent(s, dir, p, handler);
          session ??= await a.session({ actors: s.agent.actors });
          id = session.id;
          if ("prompt" in step) result = await (step.as === undefined ? session : session.as(step.as)).prompt(step.prompt);
          else if ("send" in step) await session.send(step.send, step.timing ?? "now");
          else if ("answer" in step) {
            const deadline = Date.now() + 10_000;
            let open;
            while ((open = await session.questions()).length !== 1) {
              if (Date.now() >= deadline) throw new Error(`Expected exactly one question; got ${open.length}`);
              await delay(20);
            }
            await session.answer(open[0].id, step.answer);
          } else if ("wait" in step) {
            await session.waitIdle();
            result = await session.lastTurn();
          }
        }
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (!want.error || want.error !== code) fail("error", want.error ?? "success", { code, message: String(error) });
        continue;
      }
      compare("error", want.error, "success");
      compare("outcome", want.outcome, result?.outcome?.kind ?? "none");
      compare("text", want.text, result?.text);
      if (want.toolResults) {
        const got = result?.toolResults() ?? [];
        compare("toolResults.length", want.toolResults.length, got.length);
        for (const [j, item] of want.toolResults.entries()) {
          compare(`toolResults[${j}].name`, item.name, got[j]?.name);
          compare(`toolResults[${j}].status`, item.status, got[j]?.status);
          const text = got[j]?.text();
          compare(`toolResults[${j}].text`, item.text, text);
          if (item.contains !== undefined && !text?.includes(item.contains)) fail(`toolResults[${j}].contains`, item.contains, text);
        }
      }
      if (want.records) {
        const kinds = (await session?.history() ?? []).map(e => e.kind);
        let at = 0;
        for (const kind of want.records) {
          const found = kinds.indexOf(kind, at);
          if (found < 0) { fail("records", want.records, kinds); break; }
          at = found + 1;
        }
      }
      compare("count", want.count, count(countFile(dir)));
    }
    if (failures.length === 0) {
      try { handler?.assertDone(); }
      catch (error) { failures.push(`${s.scenario} (${p.name}): ${String(error)}`); }
    }
  } finally {
    await a?.close();
    await rm(dir, { recursive: true, force: true });
  }
  return failures;
}
