#!/usr/bin/env node
import { caseMatrix, runCase, sdks } from "./runner.mjs";

const [host, action, ...command] = process.argv.slice(2);
if (!sdks.includes(host) || !(action === "--list" && command.length === 0 || action === "--" && command.length)) {
  console.error("Usage: node run.mjs <rust|typescript|go|python> --list | -- ADAPTER [ARG ...]");
  process.exitCode = 2;
} else if (action === "--list") {
  for (const item of caseMatrix(host)) console.log(JSON.stringify(item));
} else {
  let passed = 0;
  const matrix = caseMatrix(host);
  for (const testCase of matrix) {
    const label = [host, testCase.scenario, testCase.placement, testCase.handshake ?? (testCase.sdk ? "SDK" : "no SDK")].join(" ");
    try {
      const { spans } = await runCase(testCase, command);
      console.log(`${label}: pass (${spans} spans)`);
      passed++;
    } catch (error) {
      console.error(`${label}: fail: ${error.message}`);
    }
  }
  console.log(`${passed}/${matrix.length} telemetry cases passed`);
  if (passed !== matrix.length) process.exitCode = 1;
}
