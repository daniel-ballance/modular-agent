#!/usr/bin/env node
import { caseMatrix, runCase, sdks } from "./runner.mjs";

const [host, ...args] = process.argv.slice(2);
const scope = ["--in-process", "--peers"].includes(args[0]) ? args.shift() : null;
const [action, ...command] = args;
const selected = ({ placement }) => scope === null || (placement === "inProcess") === (scope === "--in-process");
if (!sdks.includes(host) || !(action === "--list" && command.length === 0 || action === "--" && command.length)) {
  console.error("Usage: node run.mjs <rust|typescript|go|python> [--in-process|--peers] (--list | -- ADAPTER [ARG ...])");
  process.exitCode = 2;
} else if (action === "--list") {
  for (const item of caseMatrix(host).filter(selected)) console.log(JSON.stringify(item));
} else {
  let passed = 0, skipped = 0, declaration;
  const matrix = caseMatrix(host).filter(selected);
  for (const testCase of matrix) {
    const label = [host, testCase.scenario, testCase.placement, testCase.handshake ?? (testCase.sdk ? "SDK" : "no SDK")].join(" ");
    try {
      const result = await runCase(testCase, command, { declaration });
      if (result.skipped) { skipped++; console.log(`${label}: SKIP (${result.skipped})`); continue; }
      if (result.declaration) declaration = result.declaration;
      console.log(`${label}: pass (${result.spans} spans)`);
      passed++;
    } catch (error) {
      console.error(`${label}: fail: ${error.message}`);
    }
  }
  console.log(`${passed}/${matrix.length - skipped} telemetry cases passed${skipped ? `; ${skipped} skipped` : ""}`);
  if (passed + skipped !== matrix.length) process.exitCode = 1;
}
