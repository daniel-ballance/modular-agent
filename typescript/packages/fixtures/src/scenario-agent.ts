import { setInterval } from "node:timers";
import { loadScenario, scenarioAgent, type Placement } from "./scenarios.js";

const [path, dir, index, placement, previous] = process.argv.slice(2);
const s = loadScenario(path);
const step = s.steps[Number(index)];
if (!("prompt" in step) || !step.crashWhen) throw new Error("Crash step needs a prompt and condition");
const agent = await scenarioAgent(s, dir, JSON.parse(placement) as Placement);
const session = previous ? await agent.openSession(previous) : await agent.session();
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
await session.prompt(step.prompt);
// The parent decides when to crash, even if the prompt already finished.
await new Promise<void>(() => { setInterval(() => {}, 60_000); });
