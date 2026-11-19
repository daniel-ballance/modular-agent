import { test } from "node:test";
import assert from "node:assert/strict";
import { applies, loadScenario, placements, runScenario, scenarioFiles } from "../src/scenarios.js";

for (const placement of placements()) {
  for (const path of scenarioFiles()) {
    const scenario = loadScenario(path);
    if (!applies(scenario, placement)) continue;
    test(`${scenario.scenario} (${placement.name})`, { timeout: 40_000 }, async () => {
      const failures = await runScenario(path, placement);
      assert.equal(failures.length, 0, failures.join("\n"));
    });
  }
}
