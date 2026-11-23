import { setInterval } from "node:timers";
import { loadScenario, runScenario, scenarioAgent, type Placement } from "./scenarios.js";
import { loadTelemetryRun, ScenarioEvidence } from "./telemetry-scenario.js";
import { startTelemetry } from "./telemetry.js";

const endpoint = process.env.MODULAR_AGENT_TELEMETRY_OTLP;
const request = process.env.MODULAR_AGENT_TELEMETRY_RUN;
const run = request && loadTelemetryRun(request);
const [path, dir, index, placement, previous, history] = process.argv.slice(2);
if (run && run.sdk && !endpoint) throw new Error("Missing OTLP endpoint");
const stopTelemetry = run && run.sdk ? startTelemetry(endpoint!) : undefined;

try {
  if (!path && run) {
    const failures = await runScenario(run.scenarioPath, { name: run.placement }, run);
    for (const failure of failures) console.error(failure);
    if (failures.length) process.exitCode = 1;
  } else {
    const s = loadScenario(path);
    const step = s.steps[Number(index)];
    if (!("prompt" in step) || !step.crashWhen) throw new Error("Crash step needs a prompt and condition");
    const evidence = run ? new ScenarioEvidence(run, true, true) : undefined;
    const agent = await scenarioAgent(s, dir, JSON.parse(placement) as Placement, undefined,
      JSON.parse(history ?? "null") ?? undefined, evidence);
    try {
      const session = previous ? await agent.openSession(previous) : await agent.session({ actors: s.agent.actors });
      process.stdout.write(`SESSION ${session.id}\n`);
      const target = "record" in step.crashWhen ? step.crashWhen.record : undefined;
      const watch = target && setInterval(() => {
        void session.history().then(entries => {
          if (entries.some(e => e.kind === target)) {
            if (watch) clearInterval(watch);
            process.stdout.write(`RECORD ${target}\n`);
          }
        });
      }, 5);
      try {
        await (step.as === undefined ? session : session.as(step.as)).prompt(step.prompt);
        // The parent decides when to crash, even if the prompt already finished.
        await new Promise<void>(() => { setInterval(() => {}, 60_000); });
      } finally { if (watch) clearInterval(watch); }
    } finally { await agent.close(); }
  }
} finally { await stopTelemetry?.(); }
