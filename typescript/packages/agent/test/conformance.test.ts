import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// The ACP host binding's conformance kit (conformance/acp), run against this agent's CLI.
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const kit = `${repo}conformance/acp/run.mjs`;
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function acpFailures(stdout: string): string {
	// The ACP kit prints failure details on an indented line below each FAIL.
	return (stdout.match(/^FAIL  .*(?:\n {6}.*)*/gm) ?? []).join("\n");
}

test("this agent passes the ACP binding's conformance kit", t => {
	const run = spawnSync(process.execPath, [kit, "--", process.execPath, cli, "--acp"], { encoding: "utf8", timeout: 120_000 });
	t.diagnostic(run.stdout.trim().split("\n").at(-1) ?? "No kit summary");
	assert.equal(run.status, 0, `${acpFailures(run.stdout)}\n${run.stdout.split("\n").at(-2)}\n${run.stderr.slice(-500)}`);
});

async function startHistoryService(leaseTtl?: number): Promise<{ url: string; tokenFile: string; stop: () => void }> {
	const dir = mkdtempSync(join(tmpdir(), "ma-hist-kit-"));
	const token = `t-${Math.random().toString(36).slice(2)}`;
	const tokenFile = join(dir, "token");
	writeFileSync(tokenFile, token, { mode: 0o600 });
	const serve = fileURLToPath(import.meta.resolve("@modular-agent/services").replace(/index\.js$/, "serve.js"));
	const child = spawn(process.execPath, [serve, "history", JSON.stringify({ dir: join(dir, "h"), token, leaseTtl })], { stdio: ["ignore", "pipe", "inherit"] });
	const url = await new Promise<string>((resolve) => child.stdout!.once("data", (d) => resolve(JSON.parse(String(d).split("\n")[0]).url)));
	return { url, tokenFile, stop: () => child.kill("SIGTERM") };
}

test("this build's history service passes the history binding's conformance kit", async t => {
	// The kit waits for a lease to expire and also appends a large batch.
	const svc = await startHistoryService(5_000);
	try {
		const run = spawnSync(process.execPath, [`${repo}conformance/history/run.mjs`, svc.url, svc.tokenFile], { encoding: "utf8", timeout: 60_000 });
		t.diagnostic(run.stdout.trim().split("\n").at(-1) ?? "No kit summary");
		assert.equal(run.status, 0, run.stdout.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
	} finally {
		svc.stop();
	}
});

test("this agent passes the ACP kit with its history in a history service", async t => {
	const svc = await startHistoryService();
	try {
		const run = spawnSync(process.execPath, [kit, "--", process.execPath, cli, "--acp"], { encoding: "utf8", timeout: 120_000, env: { ...process.env, MODULAR_AGENT_HISTORY_URL: svc.url, MODULAR_AGENT_HISTORY_TOKEN_FILE: svc.tokenFile } });
		t.diagnostic(run.stdout.trim().split("\n").at(-1) ?? "No kit summary");
		assert.equal(run.status, 0, acpFailures(run.stdout));
	} finally {
		svc.stop();
	}
});

const servePlugin = fileURLToPath(import.meta.resolve("@modular-agent/plugin-wire").replace(/index\.js$/, "serve-cli.js"));

test("this build's conformance plugin passes the plugin binding's kit", t => {
	const run = spawnSync(process.execPath, [`${repo}conformance/plugin/run.mjs`, "--", process.execPath, servePlugin], { encoding: "utf8", timeout: 120_000 });
	t.diagnostic(run.stdout.trim().split("\n").at(-1) ?? "No kit summary");
	assert.equal(run.status, 0, run.stdout.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
});

test("this agent passes the ACP kit hosting its Provider, tools, environment and hooks as two external plugins", t => {
	const plugins = [
		{ command: [process.execPath, servePlugin], env: { MODULAR_AGENT_PLUGIN_PARTS: "provider,hooks" } },
		{ command: [process.execPath, servePlugin], env: { MODULAR_AGENT_PLUGIN_PARTS: "tools,environment" } },
	];
	const run = spawnSync(process.execPath, [kit, "--plugin-checks", "--probe-checks", "--job-checks", "--", process.execPath, cli, "--acp"], { encoding: "utf8", timeout: 180_000, env: { ...process.env, MODULAR_AGENT_PLUGINS: JSON.stringify(plugins) } });
	t.diagnostic(run.stdout.trim().split("\n").at(-1) ?? "No kit summary");
	assert.equal(run.status, 0, acpFailures(run.stdout));
});

test("this agent survives kill -9 mid-turn with a durable Runtime served from another process", t => {
	const plugins = [{ command: [process.execPath, servePlugin], env: { MODULAR_AGENT_PLUGIN_PARTS: "durable-runtime" } }];
	const run = spawnSync(process.execPath, [kit, "--crash-checks", "--job-checks", "--", process.execPath, cli, "--acp"], { encoding: "utf8", timeout: 240_000, env: { ...process.env, MODULAR_AGENT_PLUGINS: JSON.stringify(plugins) } });
	t.diagnostic(run.stdout.trim().split("\n").at(-1) ?? "No kit summary");
	assert.equal(run.status, 0, acpFailures(run.stdout));
	assert.match(run.stdout, /PASS {2}crash: with continuesAfterRestart, the turn carried on and completed/);
});
