import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { testTempDir } from "./fixtures/temp-dir.js";

// The ACP host binding's conformance kit (conformance/acp), run against this agent's CLI.
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const kit = `${repo}conformance/acp/run.mjs`;
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function runKit(t: TestContext, args: string[], timeout: number, env: NodeJS.ProcessEnv = {}) {
	// The kit may kill its agent before the agent can remove its own scratch.
	return spawnSync(process.execPath, args, {
		encoding: "utf8", timeout, env: { ...process.env, ...env, TMPDIR: testTempDir(t, "ma-kit-tmp-") },
	});
}

function kitFailures(stdout: string): string {
	return (stdout.match(/^FAIL  .*(?:\n {6}.*)*/gm) ?? []).join("\n");
}

test("this agent passes the ACP binding's conformance kit", t => {
	const run = runKit(t, [kit, "--", process.execPath, cli, "--acp"], 120_000);
	t.diagnostic(run.stdout.trim().split("\n").at(-1) ?? "No kit summary");
	assert.equal(run.status, 0, `${kitFailures(run.stdout)}\n${run.stdout.split("\n").at(-2)}\n${run.stderr.slice(-500)}`);
});

async function startHistoryService(t: TestContext, leaseTtl?: number): Promise<{ url: string; tokenFile: string }> {
	const dir = mkdtempSync(join(tmpdir(), "ma-hist-kit-"));
	let child: ChildProcess | undefined;
	let closed: Promise<void> | undefined;
	t.after(async () => {
		try {
			child?.kill("SIGTERM");
			await closed;
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	const token = `t-${Math.random().toString(36).slice(2)}`;
	const tokenFile = join(dir, "token");
	writeFileSync(tokenFile, token, { mode: 0o600 });
	const serve = fileURLToPath(import.meta.resolve("@modular-agent/services").replace(/index\.js$/, "serve.js"));
	const service = child = spawn(process.execPath, [serve, "history", JSON.stringify({ dir: join(dir, "h"), token, leaseTtl })], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, TMPDIR: dir } });
	closed = new Promise(resolve => service.once("close", () => resolve()));
	const url = await new Promise<string>((resolve, reject) => {
		service.stdout.once("data", (d) => resolve(JSON.parse(String(d).split("\n")[0]).url));
		service.once("error", reject);
		service.once("close", code => reject(new Error(`history service exited with ${code}`)));
	});
	return { url, tokenFile };
}

test("this build's history service passes the history binding's conformance kit", async t => {
	// The kit waits for a lease to expire and also appends a large batch.
	const svc = await startHistoryService(t, 5_000);
	const run = runKit(t, [`${repo}conformance/history/run.mjs`, svc.url, svc.tokenFile], 60_000);
	t.diagnostic(run.stdout.trim().split("\n").at(-1) ?? "No kit summary");
	assert.equal(run.status, 0, kitFailures(run.stdout));
});

test("this agent passes the ACP kit with its history in a history service", async t => {
	const svc = await startHistoryService(t);
	const run = runKit(t, [kit, "--", process.execPath, cli, "--acp"], 120_000, { MODULAR_AGENT_HISTORY_URL: svc.url, MODULAR_AGENT_HISTORY_TOKEN_FILE: svc.tokenFile });
	t.diagnostic(run.stdout.trim().split("\n").at(-1) ?? "No kit summary");
	assert.equal(run.status, 0, kitFailures(run.stdout));
});

const servePlugin = fileURLToPath(import.meta.resolve("@modular-agent/plugin-wire").replace(/index\.js$/, "serve-cli.js"));

test("this build's conformance plugin passes the plugin binding's kit", t => {
	const run = runKit(t, [`${repo}conformance/plugin/run.mjs`, "--", process.execPath, servePlugin], 120_000, { MODULAR_AGENT_PLUGIN_REQUIRE_HISTORY_SELECT: "1" });
	t.diagnostic(run.stdout.trim().split("\n").at(-1) ?? "No kit summary");
	assert.equal(run.status, 0, run.stdout.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
});

test("this agent passes the ACP kit hosting its Provider, tools, environment and hooks as two external plugins", t => {
	const plugins = [
		{ command: [process.execPath, servePlugin], env: { MODULAR_AGENT_PLUGIN_PARTS: "provider,hooks" } },
		{ command: [process.execPath, servePlugin], env: { MODULAR_AGENT_PLUGIN_PARTS: "tools,environment" } },
	];
	const run = runKit(t, [kit, "--plugin-checks", "--probe-checks", "--job-checks", "--", process.execPath, cli, "--acp"], 180_000, { MODULAR_AGENT_PLUGINS: JSON.stringify(plugins) });
	t.diagnostic(run.stdout.trim().split("\n").at(-1) ?? "No kit summary");
	assert.equal(run.status, 0, kitFailures(run.stdout));
});

test("this agent survives kill -9 mid-turn with a durable Runtime served from another process", t => {
	const plugins = [{ command: [process.execPath, servePlugin], env: { MODULAR_AGENT_PLUGIN_PARTS: "durable-runtime" } }];
	const run = runKit(t, [kit, "--crash-checks", "--job-checks", "--", process.execPath, cli, "--acp"], 240_000, { MODULAR_AGENT_PLUGINS: JSON.stringify(plugins) });
	t.diagnostic(run.stdout.trim().split("\n").at(-1) ?? "No kit summary");
	assert.equal(run.status, 0, kitFailures(run.stdout));
	assert.match(run.stdout, /PASS {2}crash: with continuesAfterRestart, the turn carried on and completed/);
});
