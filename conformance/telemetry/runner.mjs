import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareTrace } from "./compare.mjs";
import { startReceiver } from "./receiver.mjs";
import { readWire } from "./wire.mjs";

export const sdks = ["rust", "typescript", "go", "python"];
const cases = ["first-turn", "tool-call", "nested-call", "gate-refusal", "question-answered", "durable-crash", "kept-crash"];
const handshakes = ["agreed", "no-acceptance", "no-offer"];
const repo = fileURLToPath(new URL("../../", import.meta.url));
const proxy = fileURLToPath(new URL("./wire-proxy.mjs", import.meta.url));
const load = async file => JSON.parse(await readFile(file, "utf8"));

export function caseMatrix(host) {
  assert(sdks.includes(host), "Unknown host SDK");
  const result = cases.map(scenario => ({ host, scenario, placement: "inProcess", sdk: true }));
  result.push({ host, scenario: "first-turn", placement: "inProcess", sdk: false });
  for (const peer of sdks.filter(sdk => sdk !== host)) {
    for (const scenario of ["tool-call", "nested-call"]) {
      for (const handshake of handshakes) result.push({ host, scenario, placement: `process:${peer}`, handshake, sdk: true });
    }
  }
  return result.map(c => ({ ...c, agentName: "telemetry-conformance" }));
}

// Keep the shared checks. Change only fixture content and its corresponding
// expected value. The choice fixture needs the configured replacement for yes.
async function preparedScenario(scenarioName) {
  const scenario = await load(join(repo, "conformance/sdk/scenarios", `${scenarioName}.json`));
  const prefix = `ma-fixture-${randomUUID()}`;
  const values = Object.fromEntries(["prompt", "model", "tool", "question", "answer", "secret"].map(key => [key, `${prefix}-${key}`]));
  values.diagnostic = "the gate refused it";
  for (const step of scenario.steps) {
    if (step.prompt) step.prompt += ` ${values.prompt} ${values.secret}`;
    if (step.expect?.text) step.expect.text += ` ${values.model}`;
    for (const result of step.expect?.toolResults ?? []) {
      if (result.text && ["tide", "pilot"].includes(result.name)) result.text = result.text.replace("Whitby", values.tool);
      if (result.name === "confirm") result.text = values.answer;
    }
  }
  for (const response of scenario.model) {
    if (response.text) response.text += ` ${values.model}`;
    for (const { name, input } of response.toolCalls ?? []) {
      if (["tide", "pilot"].includes(name)) input.harbour = values.tool;
      if (name === "bump") input.note = [input.note, values.tool].filter(Boolean).join(" ");
      if (name === "confirm") input.question += ` ${values.question}`;
    }
  }
  if (scenarioName === "question-answered") scenario.agent.answers[0].value = values.answer;
  return { scenario, values };
}

async function fixtureSpecs(placement, names, dir, endpoint, handshake) {
  if (!placement.startsWith("process:")) return [];
  const peer = placement.slice("process:".length);
  assert(sdks.includes(peer), "Unknown fixture SDK");
  const { command, build } = await load(join(repo, "conformance/sdk/fixtures", `${peer}.json`));
  return names.map(name => {
    const wire = join(dir, `wire-${name}.ndjson`);
    return {
      name, wire, build,
      command: [process.execPath, proxy, wire, ...command.map(arg => arg.replaceAll("{repo}", repo)), name],
      env: { MODULAR_AGENT_TELEMETRY_OTLP: endpoint, MODULAR_AGENT_TELEMETRY_HANDSHAKE: handshake },
    };
  });
}

export async function runCase(testCase, command) {
  assert(caseMatrix(testCase.host).some(c => c.scenario === testCase.scenario && c.placement === testCase.placement &&
    c.handshake === testCase.handshake && c.sdk === testCase.sdk), "Not a shared telemetry case");
  assert(command?.length, "Missing SDK adapter command");
  const workspace = await mkdtemp(join(tmpdir(), "ma-telemetry-"));
  let receiver;
  let passed = false;
  try {
    receiver = await startReceiver();
    const { scenario, values } = await preparedScenario(testCase.scenario);
    const scenarioPath = join(workspace, "scenario.json");
    const reportPath = join(workspace, "report.json");
    const requestPath = join(workspace, "run.json");
    const workDir = join(workspace, "work");
    const home = join(workspace, "home");
    const fixtures = await fixtureSpecs(testCase.placement, scenario.agent.plugins, workspace, receiver.endpoint, testCase.handshake);
    await Promise.all([mkdir(home), mkdir(workDir), writeFile(scenarioPath, JSON.stringify(scenario)),
      writeFile(requestPath, JSON.stringify({ ...testCase, scenarioPath, reportPath, workDir, fixtures, values }))]);
    const log = await open(join(workspace, "runner.log"), "wx", 0o600);
    try {
      const env = Object.fromEntries(["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR"].flatMap(key =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]]));
      const child = spawn(command[0], command.slice(1), { cwd: repo, stdio: ["ignore", log.fd, log.fd], env: {
        ...env, HOME: home, MODULAR_AGENT_TELEMETRY_RUN: requestPath, MODULAR_AGENT_TELEMETRY_OTLP: receiver.endpoint,
      } });
      const [code, signal] = await once(child, "close");
      assert.equal(code, 0, `SDK adapter exited with ${signal ?? code}`);
    } finally {
      await log.close();
    }
    // The adapter exits only after the normal exporters get their successful
    // responses. Take one snapshot after that barrier, including extras.
    const received = receiver.snapshot();
    const report = await load(reportPath);
    const connections = fixtures.map(({ name, wire }) => ({ plugin: name, frames: readWire(wire) }));
    compareTrace({ testCase, report, received, connections, sentinels: Object.values(values) });
    passed = true;
    return { spans: received.spans.length, exports: received.payloads.length };
  } catch (error) {
    throw new Error(`${error.message}; artifacts: ${workspace}`, { cause: error });
  } finally {
    await receiver?.close();
    if (passed) await rm(workspace, { recursive: true, force: true });
  }
}
