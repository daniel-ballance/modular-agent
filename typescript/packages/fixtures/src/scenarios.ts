import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AgentError, createAgent, fileHistory, httpHistory, serveHistory, type Actor, type AgentOptions, type Answer, type InputTiming, type PromptResult, type ServicePlugin, type Session } from "@modular-agent/core";
import { answers, memoryEnvironment, scriptedProvider, testAgent, type ScriptStep } from "@modular-agent/core/testing";
import { count, fixture } from "./index.js";
import { ScenarioEvidence, type TelemetryRun } from "./telemetry-scenario.js";

const repo = fileURLToPath(new URL("../../../../../", import.meta.url)).replace(/\/$/, "");
const files = (dir: string) => readdirSync(dir).filter(f => f.endsWith(".json")).sort().map(f => join(dir, f));
const load = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8"));
export const scenarioFiles = () => {
  const waiting = join(repo, "conformance/sdk/fixtures/waiting-approval");
  return [...files(join(repo, "conformance/sdk/scenarios")), ...existsSync(waiting) ? files(waiting) : []];
};
export type Placement = { name: string; command?: string[]; servicePlugins?: ServicePlugin[] };
export function placements(require = process.env.MODULAR_AGENT_SDK_REQUIRE): Placement[] {
  // `all`, or a comma-separated list of SDKs (docs/sdk/testing.md#finding-the-fixture-programs).
  const names = (require ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const all = names.includes("all");
  const required = new Set(names.filter(n => n !== "all"));
  const out: Placement[] = [{ name: "inProcess" }];
  const available = new Set<string>();
  const services: Placement[] = [];
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
    services.push({ name: `service:${sdk}`, command: argv });
  }
  for (const sdk of required) if (!available.has(sdk)) throw new Error(`Required fixture program ${sdk} is not registered`);
  return [...out, ...services];
}

type Expect = { outcome?: string; text?: string; toolResults?: { name: string; status: string; text?: string; contains?: string }[]; records?: string[]; count?: number; error?: string };
type Crash = { record: string } | { count: number };
type Step = ({ prompt: string; as?: string; crashWhen?: Crash } | { reopen: true } |
  { send: string; timing?: InputTiming } | { answer: Answer } | { wait: true }) & { expect?: Expect };
export interface Scenario {
  scenario: string;
  requires?: { approvalsOutlastTurns?: boolean };
  agent: Pick<AgentOptions, "durability" | "approval" | "settings" | "severalActors"> & {
    plugins?: string[]; answers?: Answer[]; actors?: Actor[]; history?: "file" | "service";
  };
  expectCreateError?: { code: string; messageContains: string };
  model: ScriptStep[];
  steps: Step[];
  placements?: string[];
}
export const loadScenario = load<Scenario>;
export const applies = (s: Scenario, p: Placement) => !s.placements || s.placements.includes(p.name) || p.name.startsWith("process:") && s.placements.includes("process") || p.name.startsWith("service:") && s.placements.includes("service");
const countFile = (dir: string) => join(dir, "count");

type HistoryFixture = { dir: string } | { url: string; tokenFile: string };

async function fixtureHistory(s: Scenario, dir: string): Promise<{ descriptor?: HistoryFixture; stop?: () => Promise<void> }> {
  if (!s.agent.history) return {};
  const storeDir = join(dir, "history");
  await mkdir(storeDir, { recursive: true });
  if (s.agent.history === "file") return { descriptor: { dir: storeDir } };
  if (s.agent.history !== "service") throw new Error(`Unknown history fixture ${s.agent.history}`);
  const tokenFile = join(dir, "history-token");
  if (!existsSync(tokenFile)) await writeFile(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  const service = await serveHistory(fileHistory(storeDir), { address: "127.0.0.1:0", tokenFile });
  return { descriptor: { url: service.url, tokenFile }, stop: service.close };
}

export async function scenarioAgent(s: Scenario, dir: string, p: Placement,
  handler = s.agent.answers && answers(s.agent.answers), store?: HistoryFixture, evidence?: ScenarioEvidence) {
  const project = join(dir, "project");
  await mkdir(project, { recursive: true });
  const { plugins = [], answers: _answers, actors: _actors, history: _history, ...options } = s.agent;
  const history = store && ("dir" in store ? fileHistory(store.dir) : httpHistory(store.url, store.tokenFile));
  const config = { path: countFile(dir) };
  const run = evidence?.run;
  const composition: AgentOptions = { ...options, project, dataDir: join(dir, "data"),
    onQuestion: handler, history,
    ...(p.servicePlugins ? { servicePlugins: p.servicePlugins }
      : run && p.name.startsWith("process:") ? { processPlugins: plugins.map(name => {
        const supplied = run.fixtures.find(f => f.name === name);
        if (!supplied) throw new Error(`Missing fixture ${name}`);
        return { command: supplied.command, env: supplied.env, config };
      }) }
      : p.command ? { processPlugins: plugins.map(name => ({ command: [...p.command!, name], config })) }
      : { plugins: plugins.map(name => fixture(name, config, s.scenario === "question-answered" ? run?.values.answer : undefined)) }),
  };
  if (!evidence) return testAgent({ ...composition, script: s.model });
  return createAgent({ ...composition, agentName: run!.agentName, environment: memoryEnvironment(),
    providers: [evidence.provider(scriptedProvider(s.model))], model: "scripted/script",
    plugins: [...composition.plugins ?? [], evidence.historyPlugin()],
  });
}

// A process that is already a zombie cannot race recovery. Container PID 1
// may not reap orphaned killed plugins. On Linux check actual group states.
export async function waitGroup(pid: number) {
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

async function killGroup(pid?: number) {
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ESRCH") return;
    // Darwin can return EPERM for an exited group with zombies still present.
    // Do not mistake a live, unsignalable group for confirmed cleanup.
    if (process.platform === "darwin" && code === "EPERM") return await waitGroup(pid);
    throw error;
  }
}

export async function servicesFor(s: Scenario, dir: string, p: Placement) {
  const children: { pid?: number; reaped: Promise<void> }[] = [];
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= Promise.all(children.map(async ({ pid, reaped }) => {
    await killGroup(pid);
    await reaped;
    if (pid) await waitGroup(pid);
  })).then(() => {});
  if (!p.name.startsWith("service:")) return { placement: p, stop };
  try {
    const tokenFile = join(dir, "service-token");
    if (!existsSync(tokenFile)) await writeFile(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    const servicePlugins: ServicePlugin[] = [];
    for (const name of s.agent.plugins ?? []) {
      const command = p.command!;
      const child = spawn(command[0], [...command.slice(1), name, "--listen", "127.0.0.1:0", "--token-file", tokenFile],
        { detached: true, stdio: ["ignore", "pipe", "inherit"], env: { PATH: process.env.PATH } });
      const reaped = new Promise<void>(resolve => child.once("close", () => resolve()));
      children.push({ pid: child.pid, reaped });
      const lines = createInterface({ input: child.stdout });
      let timer: NodeJS.Timeout | undefined;
      try {
        const url = await new Promise<string>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Fixture ${name} did not announce a WebSocket URL`)), 5_000);
          child.on("error", reject);
          child.once("exit", (code, signal) => reject(new Error(`Fixture ${name} exited before listening (${signal ?? code})`)));
          lines.once("line", line => {
            try {
              const url = new URL(line);
              if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !url.port || url.port === "0") throw new Error();
              resolve(url.href);
            } catch { reject(new Error(`Fixture ${name} did not print a loopback WebSocket URL`)); }
          });
        });
        servicePlugins.push({ url, tokenFile, config: { path: countFile(dir) } });
      } finally { clearTimeout(timer); lines.close(); child.stdout.resume(); }
    }
    return { placement: { name: p.name, servicePlugins }, stop };
  } catch (error) { await stop(); throw error; }
}

async function crashRun(path: string, dir: string, p: Placement, i: number, when: Crash, previous?: string, history?: HistoryFixture, evidence?: ScenarioEvidence) {
  const services = await servicesFor(loadScenario(path), dir, p);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./scenario-agent.js", import.meta.url)),
    path, dir, String(i), JSON.stringify(services.placement), previous ?? "", JSON.stringify(history ?? null)],
    { detached: true, stdio: ["ignore", "pipe", "inherit"],
      env: evidence ? { ...process.env, MODULAR_AGENT_TELEMETRY_OTLP: process.env.MODULAR_AGENT_TELEMETRY_OTLP } : undefined });
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
    await evidence?.beforeKill(sessionId, count(countFile(dir)));
    return sessionId;
  } finally {
    const pid = child.pid;
    try {
      await Promise.all([services.stop(), (async () => {
        await killGroup(pid);
        await reaped;
        if (pid) await waitGroup(pid);
      })()]);
    } finally { lines.close(); }
  }
}

export async function runScenario(path: string, p: Placement, run?: TelemetryRun): Promise<string[]> {
  const s = loadScenario(path);
  if (s.requires?.approvalsOutlastTurns) {
    const driver = await import(new URL("../../../../scripts/waiting-scenarios.mjs", import.meta.url).href);
    return driver.runWaitingScenario(path, p, run);
  }
  const dir = run?.workDir ?? await mkdtemp(join(tmpdir(), "sdk-scenario-"));
  const evidence = run && new ScenarioEvidence(run, s.steps.some(step => "prompt" in step && !!step.crashWhen));
  let report: unknown;
  const failures: string[] = [];
  const handler = s.agent.answers && answers(s.agent.answers);
  let id: string | undefined;
  let a: Awaited<ReturnType<typeof scenarioAgent>> | undefined;
  let session: Session | undefined;
  let services: Awaited<ReturnType<typeof servicesFor>> | undefined;
  let history: Awaited<ReturnType<typeof fixtureHistory>> = {};
  const stop = async () => {
    try { await a?.close(); }
    finally { a = undefined; session = undefined; await services?.stop(); services = undefined; }
  };
  const start = async () => {
    services = await servicesFor(s, dir, p);
    try { return await scenarioAgent(s, dir, services.placement, handler, history.descriptor, evidence); }
    catch (error) { await stop(); throw error; }
  };
  try {
    history = await fixtureHistory(s, dir);
    if (s.expectCreateError) {
      if (s.steps.length) throw new Error(`${s.scenario} (${p.name}): expectCreateError requires no steps`);
      services = await servicesFor(s, dir, p);
      const want = s.expectCreateError;
      let actual: unknown = "success";
      try { a = await scenarioAgent(s, dir, services.placement, handler, history.descriptor); }
      catch (error) {
        if (error instanceof AgentError && error.code === want.code && error.message.includes(want.messageContains)) return failures;
        actual = { code: error instanceof AgentError ? error.code : undefined, message: String(error) };
      }
      return [`${s.scenario} (${p.name}) create: want ${JSON.stringify(want)}, got ${JSON.stringify(actual)}`];
    }
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
          await stop();
          id = await crashRun(path, dir, p, i, step.crashWhen, id, history.descriptor, evidence);
        } else if ("reopen" in step) {
          await stop();
          if (!id) throw new Error("No session to reopen");
          a = await start();
          session = await a.openSession(id);
          result = await session.lastTurn();
        } else {
          a ??= await start();
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
    if (!failures.length && a && session) report = await evidence?.report(a, session, count(countFile(dir)));
  } finally {
    try { await stop(); }
    finally {
      try { await history.stop?.(); }
      finally { if (!run) await rm(dir, { recursive: true, force: true }); }
    }
  }
  if (run && !failures.length) {
    if (!report) throw new Error("No scenario evidence to report");
    await writeFile(run.reportPath, JSON.stringify(report));
  }
  return failures;
}
