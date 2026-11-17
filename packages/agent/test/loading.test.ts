import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent } from "../src/index.js";

const PLUGIN = `export default (options) => ({
	name: "hello",
	setup(api) {
		api.registerCommand("hello", { description: "Say hello", run: () => \`hello, \${options.who}\` });
	},
});
`;

function project() {
	const dir = mkdtempSync(join(tmpdir(), "ma-p-"));
	mkdirSync(join(dir, ".modular-agent", "plugins"), { recursive: true });
	writeFileSync(join(dir, ".modular-agent", "plugins", "hello.mjs"), PLUGIN);
	writeFileSync(join(dir, ".modular-agent", "settings.json"), JSON.stringify({ load: [{ module: "./.modular-agent/plugins/hello.mjs", options: { who: "world" } }] }));
	return dir;
}

test("plugins named in settings load; a project's plugins load only once the project is trusted", async () => {
	const dir = project();
	const home = mkdtempSync(join(tmpdir(), "ma-h-"));

	let h = await createAgent({ project: dir, home, ephemeral: true });
	assert.ok(!h.plugins().includes("hello"), "an untrusted project's plugin must not load");
	const s1 = await h.api("t").startSession();
	assert.match(String(await h.api("t").runCommand(s1, "/trust", "user")), /Trusted/);
	await h.stop();

	h = await createAgent({ project: dir, home, ephemeral: true });
	assert.ok(h.plugins().includes("hello"));
	const s2 = await h.api("t").startSession();
	assert.equal(await h.api("t").runCommand(s2, "/hello", "user"), "hello, world");
	await h.stop();
});

test("a global plugin loads without trust, and a broken entry is reported, not fatal", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ma-p-"));
	const home = mkdtempSync(join(tmpdir(), "ma-h-"));
	writeFileSync(join(home, "hello.mjs"), PLUGIN);
	writeFileSync(join(home, "settings.json"), JSON.stringify({ load: [{ module: "./hello.mjs", options: { who: "home" } }, "./missing.mjs"] }));
	const h = await createAgent({ project: dir, home, ephemeral: true });
	assert.ok(h.plugins().includes("hello"));
	assert.ok(h.problems.some((p) => /missing\.mjs/.test(p.error)));
	await h.stop();
});
