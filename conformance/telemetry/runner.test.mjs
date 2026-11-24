import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { caseMatrix, runCase, sdks } from "./runner.mjs";
import { readWire } from "./wire.mjs";

test("matrix covers all four hosts and each cross-language peer", () => {
  const cases = sdks.flatMap(caseMatrix);
  assert.equal(cases.length, 88);
  assert.equal(new Set(cases.map(JSON.stringify)).size, cases.length);
  for (const host of sdks) {
    const own = caseMatrix(host);
    assert.equal(own.filter(c => c.placement === "inProcess" && !c.scenario.startsWith("waiting-approval")).length, 8);
    assert.equal(own.filter(c => !c.sdk && !c.scenario.startsWith("waiting-approval")).length, 1);
    assert.equal(own.filter(c => c.scenario.startsWith("waiting-approval")).length, 8);
    for (const peer of sdks.filter(sdk => sdk !== host)) {
      for (const scenario of ["tool-call", "nested-call"]) {
        assert.equal(own.filter(c => c.placement === `process:${peer}` && c.scenario === scenario).length, 1);
      }
    }
  }
});

test("waiting cases require a real adapter", async () => {
  const c = caseMatrix("rust").find(c => c.scenario === "waiting-approval");
  await assert.rejects(runCase(c, []), /Missing SDK adapter command/);
});

test("runner supplies the selected scenario and receiver to an isolated adapter", async () => {
  const adapter = `
    import assert from 'node:assert/strict';
    import { readFile, writeFile } from 'node:fs/promises';
    const load = async path => JSON.parse(await readFile(path, 'utf8'));
    const request = await load(process.env.MODULAR_AGENT_TELEMETRY_RUN);
    const scenario = await load(request.scenarioPath);
    assert.equal(request.sdk, false);
    assert.deepEqual(request.fixtures, []);
    assert.match(process.env.HOME, /ma-telemetry-.*\\/home$/);
    assert.match(process.env.MODULAR_AGENT_TELEMETRY_OTLP, /^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/v1\\/traces$/);
    assert(scenario.steps[0].prompt.includes(request.values.prompt));
    assert(scenario.steps[0].expect.text.includes(request.values.model));
    assert(scenario.steps[0].expect.records.includes('modelRequest'));
    const declaration = { telemetry: 1 };
    await writeFile(request.reportPath, JSON.stringify({ scenario: request.scenario, placement: request.placement,
      passed: true, sessionId: 's1', turnId: 't1', outcome: 'completed', historyKinds: scenario.steps[0].expect.records,
      declarations: { agent: declaration, session: declaration } }));
  `;
  const run = caseMatrix("rust").find(c => !c.sdk);
  assert.deepEqual(await runCase(run, [process.execPath, "--input-type=module", "-e", adapter]), { spans: 0, exports: 0 });
});

test("wire proxy delivers both frames and exits even if the host has not closed stdin", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "ma-proxy-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const file = join(workspace, "wire");
  const proxy = fileURLToPath(new URL("./wire-proxy.mjs", import.meta.url));
  const plugin = `
    process.stdin.once('data', chunk => {
      const msg = JSON.parse(chunk);
      process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:msg.id, result:{}})+'\\n', () => process.stdin.destroy());
    });`;
  const child = spawn(process.execPath, [proxy, file, process.execPath, "-e", plugin], { stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => child.kill());
  const replies = [];
  child.stdout.on("data", chunk => replies.push(chunk));
  child.stdin.write('{"jsonrpc":"2.0","id":7,"method":"plugin/shutdown"}\n');
  const [code] = await once(child, "close");
  assert.equal(code, 0);
  assert.equal(JSON.parse(Buffer.concat(replies)).id, 7);
  assert.deepEqual(readWire(file).map(frame => frame.direction), ["hostToPlugin", "pluginToHost"]);
});
