import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEvent } from "@modular-agent/harness";
import { Peer, remotePlugin } from "@modular-agent/plugin-rpc";
import { createAgent } from "../src/index.js";
import type { Scripted } from "./fixtures/faux-provider.js";

const dirs = () => ({ project: mkdtempSync(join(tmpdir(), "ma-p-")), home: mkdtempSync(join(tmpdir(), "ma-h-")) });
const fixture = new URL("./fixtures/faux-provider.js", import.meta.url).href;
const remoteProvider = (responses: Scripted[]) => remotePlugin({ name: "provider-faux", spawn: { module: fixture, export: "fauxProviders", options: { responses } } });
const children = () => {
	try {
		return execFileSync("pgrep", ["-P", String(process.pid)]).toString().trim().split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
};

test("RPC: only the Harness in this process; Provider, Runtime, tools and working environment each in their own", async () => {
	const d = dirs();
	writeFileSync(join(d.project, "note.txt"), "remote hello");
	const h = await createAgent({
		...d,
		model: "faux/faux-1",
		remote: ["runtime-transient", "tools-files", "env-local"],
		plugins: [remoteProvider([{ tool: "read", args: { path: "note.txt" } }, { tool: "bash", args: { command: "echo done | tee out.txt" } }, { text: "Read it and wrote out.txt." }])],
	});
	assert.ok(children() >= 4, `expected four plugin processes, saw ${children()}`);
	const api = h.api("t");
	const s = await api.startSession();
	const events: AgentEvent[] = [];
	api.follow(s, { recipient: "t" }, (e) => events.push(e));
	await api.input(s, { content: "go", actorId: "user" });
	await api.waitForIdle(s);
	const results = api.history(s).filter((e) => e.kind === "toolResult").map((e) => (e.data as { status: string }).status);
	assert.deepEqual(results, ["completed", "completed"]);
	assert.match(JSON.stringify(api.history(s).find((e) => e.kind === "toolResult")!.message), /remote hello/, "read ran in the tools process, through the environment process");
	assert.equal(readFileSync(join(d.project, "out.txt"), "utf8").trim(), "done", "bash ran");
	assert.ok(events.some((e) => e.type === "model.output"), "the model's output streamed back across two processes");
	assert.ok(events.some((e) => e.type === "tool.progress"), "bash's live output did too");
	await h.stop();
	assert.equal(children(), 0, "stopping the agent ends its plugin processes");
});

test("RPC: cancelling reaches a tool in another process", async () => {
	const d = dirs();
	const h = await createAgent({
		...d,
		model: "faux/faux-1",
		remote: ["runtime-transient", "tools-files", "env-local"],
		plugins: [remoteProvider([{ tool: "bash", args: { command: "sleep 30; echo late > late.txt" } }, { text: "never" }])],
	});
	const api = h.api("t");
	const s = await api.startSession();
	const started = new Promise<void>((r) => api.follow(s, { recipient: "t" }, (e) => e.type === "tool.started" && r()));
	await api.input(s, { content: "go", actorId: "user" });
	await started;
	const t0 = Date.now();
	await api.cancel(s);
	await api.waitForIdle(s);
	assert.ok(Date.now() - t0 < 5000, "the abort crossed to the tools and environment processes, and the command stopped");
	const end = api.history(s).filter((e) => e.kind === "turnEnd").at(-1)!.data as { outcome: { kind: string } };
	assert.equal(end.outcome.kind, "cancelled");
	await h.stop();
});

test("RPC: a plugin in another process that dies takes its calls with it, and the turn says so", async t => {
	const d = dirs();
	const environment = remotePlugin({ name: "env-crashing", replaces: "env-local",
		spawn: { module: new URL("./fixtures/crashing-environment.js", import.meta.url).href, export: "crashingEnvironment" } });
	const h = await createAgent({ ...d, model: "faux/faux-1", remote: [],
		plugins: [environment, remoteProvider([{ tool: "bash", args: { command: "unused" } }, { text: "after" }])] });
	t.after(() => h.stop());
	const api = h.api("t");
	const s = await api.startSession();
	await api.input(s, { content: "go", actorId: "user" });
	await api.waitForIdle(s);
	const result = api.history(s).find((e) => e.kind === "toolResult")!;
	const turn = api.history(s).filter((e) => e.kind === "turnEnd").at(-1)!.data as { result: { text?: string } };
	assert.equal((result.data as { status: string }).status, "failed");
	assert.match(JSON.stringify(result.message), /process running env-crashing ended/);
	assert.equal(turn.result.text, "after", "the turn carried on, with the failure as the call's result");
	await h.stop(); // Wait for the exit event as well as EOF on the RPC pipe.
	assert.ok(h.problems.some((p) => p.plugin === "env-crashing" && p.where === "process"), "the Harness reports the lost plugin");
});

test("RPC: an answer finished after the connection closed is not written", async () => {
	let finish!: (v: string) => void;
	const wrote: string[] = [];
	let closed = false;
	const answering = new Peer((line) => {
		if (closed) throw new Error("write after end");
		wrote.push(line);
	}, { slow: () => new Promise<string>((r) => (finish = r)) });
	answering.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "slow", params: [] }));
	await new Promise((r) => setImmediate(r));
	answering.close(new Error("stopped"));
	closed = true;
	finish("late");
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(wrote, []);
});
