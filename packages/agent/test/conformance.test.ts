import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// The ACP host binding's conformance kit (conformance/acp), run against this agent's CLI.
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const kit = `${repo}conformance/acp/run.mjs`;
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("this agent passes the ACP binding's conformance kit", () => {
	const run = spawnSync(process.execPath, [kit, "--", process.execPath, cli, "--acp"], { encoding: "utf8", timeout: 120_000 });
	const failures = run.stdout.split("\n").filter((l) => l.startsWith("FAIL"));
	assert.equal(run.status, 0, `${failures.join("\n")}\n${run.stdout.split("\n").at(-2)}\n${run.stderr.slice(-500)}`);
});
