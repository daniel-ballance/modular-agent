import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

// The ACP host binding's conformance kit (conformance/acp), run against this agent's CLI.
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const kit = `${repo}conformance/acp/run.mjs`;
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("this agent passes the ACP binding's conformance kit", t => {
	const run = spawnSync(process.execPath, [kit, "--", process.execPath, cli, "--acp"], { encoding: "utf8", timeout: 120_000 });
	t.diagnostic(run.stdout.trim().split("\n").at(-1) ?? "No kit summary");
	const failures = run.stdout.split("\n").filter((l) => l.startsWith("FAIL"));
	assert.equal(run.status, 0, `${failures.join("\n")}\n${run.stdout.split("\n").at(-2)}\n${run.stderr.slice(-500)}`);
});

async function startHistoryService(t: TestContext, leaseTtl?: number, root = tmpdir()) {
	const dir = mkdtempSync(join(root, "ma-hist-kit-"));
	const token = `t-${Math.random().toString(36).slice(2)}`;
	const tokenFile = join(dir, "token");
	const store = join(dir, "h");
	writeFileSync(tokenFile, token, { mode: 0o600 });
	const serve = fileURLToPath(import.meta.resolve("@modular-agent/services").replace(/index\.js$/, "serve.js"));
	const child = spawn(process.execPath, [serve, "history", JSON.stringify({ dir: store, token, leaseTtl })], { stdio: ["ignore", "pipe", "inherit"] });
	const closed = once(child, "close");
	t.after(async () => {
		try {
			child.kill("SIGTERM");
			await closed;
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
	const url: string = await Promise.race([
		once(child.stdout, "data").then(([d]) => JSON.parse(String(d).split("\n")[0]).url),
		closed.then(([code, signal]) => { throw new Error(`History service exited before startup (${code ?? signal})`); }),
	]);
	return { url, tokenFile, store };
}

test("this build's history service passes the history binding's conformance kit", async t => {
	// The kit waits for a lease to expire and also appends a large batch.
	const svc = await startHistoryService(t, 5_000);
	const run = spawnSync(process.execPath, [`${repo}conformance/history/run.mjs`, svc.url, svc.tokenFile], { encoding: "utf8", timeout: 60_000 });
	t.diagnostic(run.stdout.trim().split("\n").at(-1) ?? "No kit summary");
	assert.equal(run.status, 0, run.stdout.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
});

const tmpfs = 0x01021994;
const shm = "/dev/shm";

test("this agent passes the ACP kit with its history in a history service", async t => {
	const hasTmpfs = process.platform === "linux" && existsSync(shm) && statfsSync(shm).type === tmpfs;
	const svc = await startHistoryService(t, undefined, hasTmpfs ? shm : undefined);
	if (hasTmpfs) assert.equal(statfsSync(svc.store).type, tmpfs, "The ACP history fixture must not depend on disk sync latency");
	const run = spawnSync(process.execPath, [kit, "--", process.execPath, cli, "--acp"], { encoding: "utf8", timeout: 120_000, env: { ...process.env, MODULAR_AGENT_HISTORY_URL: svc.url, MODULAR_AGENT_HISTORY_TOKEN_FILE: svc.tokenFile } });
	t.diagnostic(run.stdout?.trim().split("\n").at(-1) || "No kit summary");
	assert.equal(run.status, 0, [run.error?.message, run.stdout, run.stderr].filter(Boolean).join("\n"));
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
	assert.equal(run.status, 0, run.stdout.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
});

test("this agent survives kill -9 mid-turn with a durable Runtime served from another process", t => {
	const plugins = [{ command: [process.execPath, servePlugin], env: { MODULAR_AGENT_PLUGIN_PARTS: "durable-runtime" } }];
	const run = spawnSync(process.execPath, [kit, "--crash-checks", "--job-checks", "--", process.execPath, cli, "--acp"], { encoding: "utf8", timeout: 240_000, env: { ...process.env, MODULAR_AGENT_PLUGINS: JSON.stringify(plugins) } });
	t.diagnostic(run.stdout.trim().split("\n").at(-1) ?? "No kit summary");
	assert.equal(run.status, 0, run.stdout.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
	assert.match(run.stdout, /PASS {2}crash: with continuesAfterRestart, the turn carried on and completed/);
});
