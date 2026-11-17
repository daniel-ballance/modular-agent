#!/usr/bin/env node
// Conformance kit for the plugin binding, modular-agent-plugin/1 (docs/bindings/plugin.md).
// Usage: node run.mjs [--verbose] -- <command that serves the build's conformance plugin> [args...]
// The kit plays the host. It starts the plugin, serves the host/* callbacks from a temporary folder,
// and checks every part of the conformance plugin. No network, no model. Exit code 0 means all passed.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const verbose = argv.includes("--verbose");
const dash = argv.indexOf("--");
if (dash < 0 || dash === argv.length - 1) {
	console.error("Usage: node run.mjs [--verbose] -- <plugin command> [args...]");
	process.exit(2);
}
const command = argv.slice(dash + 1);
const BINDING = "modular-agent-plugin/1";
const work = mkdtempSync(join(tmpdir(), "ma-plugin-kit-"));
const home = mkdtempSync(join(tmpdir(), "ma-plugin-home-"));
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail = "") {
	results.push({ name, ok: !!ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : verbose && detail ? `  (${detail})` : ""}`);
	return !!ok;
}
async function attempt(name, fn) {
	try {
		await fn();
	} catch (error) {
		check(name, false, error instanceof Error ? error.message : JSON.stringify(error));
	}
}
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** One plugin process, and the kit as its host. */
function start(extraEnv = {}) {
	const child = spawn(command[0], command.slice(1), { cwd: work, stdio: ["pipe", "pipe", verbose ? "inherit" : "ignore"], env: { ...process.env, ...extraEnv } });
	const pending = new Map();
	const notes = [];
	const hostCalls = [];
	const execs = new Map(); // host/env/exec request id -> { proc, parent }
	let nextId = 1;
	let buffer = "";
	const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
	const reply = (id, result) => send({ id, result });
	const fail = (id, code, message) => send({ id, error: { code: -32000, message, data: { code } } });
	const envPath = (cwd, p) => {
		const full = resolve(cwd ?? work, p);
		return full;
	};
	async function onHostRequest(m) {
		const p = m.params ?? {};
		hostCalls.push(m);
		switch (m.method) {
			case "$/ping":
				return reply(m.id, {});
			case "host/env/read":
				if (!existsSync(envPath(p.cwd, p.path))) return fail(m.id, "invalid_request", `no file ${p.path}`);
				return reply(m.id, { data: readFileSync(envPath(p.cwd, p.path)).toString("base64") });
			case "host/env/write":
				writeFileSync(envPath(p.cwd, p.path), Buffer.from(p.data, "base64"));
				return reply(m.id, {});
			case "host/env/exists":
				return reply(m.id, { exists: existsSync(envPath(p.cwd, p.path)) });
			case "host/env/exec": {
				const proc = spawn("bash", ["-c", p.command], { cwd: p.cwd ?? work, detached: true, stdio: ["ignore", "pipe", "pipe"] });
				let output = "";
				const out = (d) => {
					output += String(d);
					send({ method: "host/env/output", params: { parentRequestId: m.id, chunk: String(d) } });
				};
				proc.stdout.on("data", out);
				proc.stderr.on("data", out);
				execs.set(m.id, { proc, parent: p.parentRequestId });
				proc.on("exit", (code) => {
					execs.delete(m.id);
					setTimeout(() => reply(m.id, { exitCode: code, output, timedOut: false }), 20);
				});
				return;
			}
			case "host/ask":
				return reply(m.id, { requestId: randomUUID(), actorId: "kit", value: "kit answer" });
			case "host/hook":
				return reply(m.id, p.payload ?? null);
			case "host/credentials/read":
				return reply(m.id, { credential: null });
			case "host/history":
				return reply(m.id, { entries: [] });
			case "host/session":
				return reply(m.id, { id: p.sessionId, project: work, settings: {}, busy: true, actors: [] });
			case "host/declaration":
				return reply(m.id, {});
			default:
				return send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
		}
	}
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
			const line = buffer.slice(0, i).trim();
			buffer = buffer.slice(i + 1);
			if (!line) continue;
			let m;
			try {
				m = JSON.parse(line);
			} catch {
				notes.push({ method: "$/bad-line", params: { line } });
				continue;
			}
			if (m.method && m.id !== undefined) void onHostRequest(m);
			else if (m.method) {
				notes.push(m);
				if (m.method === "$/cancel") {
					// The plugin cancelled one of its own requests to us.
					const e = execs.get(m.params?.id);
					if (e) process.kill(-e.proc.pid, "SIGKILL");
				}
			} else if (pending.has(m.id)) {
				const { resolve: res, reject } = pending.get(m.id);
				pending.delete(m.id);
				if (m.error) reject(m.error);
				else res(m.result);
			}
		}
	});
	const exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
	return {
		child,
		notes,
		hostCalls,
		exited,
		request(method, params, ms = 15000) {
			const id = nextId++;
			send({ id, method, params });
			let timer;
			const p = new Promise((res, reject) => {
				pending.set(id, { resolve: res, reject });
				timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${method}`)), ms);
			});
			p.finally(() => clearTimeout(timer)).catch(() => undefined);
			p.id = id;
			return p;
		},
		notify(method, params) {
			send({ method, params });
		},
		/** Cancel a request this kit sent, as a host would, including the plugin's work for it here. */
		cancel(id) {
			send({ method: "$/cancel", params: { id } });
			for (const e of execs.values()) if (e.parent === id) process.kill(-e.proc.pid, "SIGKILL");
		},
		async stop() {
			child.stdin.end();
			await Promise.race([exited, sleep(3000)]);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		},
	};
}

const code = (e) => e?.data?.code;
const textOf = (content) => (content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("");
const initParams = { binding: BINDING, data: "modular-agent-data/1", host: { name: "conformance-kit", version: "1" }, project: work, home, config: {} };

let p = start();
let reg = {};
await attempt("initialize", async () => {
	reg = await p.request("plugin/initialize", initParams);
	check("initialize: binding echoed", reg.binding === BINDING, JSON.stringify(reg.binding));
	check("initialize: a name", typeof reg.name === "string" && reg.name.length > 0);
	const provider = (reg.providers ?? []).find((x) => x.id === "conformance");
	check("register: provider conformance with model echo", !!provider?.models?.some((m) => m.id === "echo" && m.provider === "conformance"), JSON.stringify(reg.providers));
	const ts = (reg.toolSources ?? []).find((x) => x.id === "conformance-tools");
	const names = (ts?.tools ?? []).map((t) => t.name);
	check("register: tool source conformance-tools with bash and read", names.includes("bash") && names.includes("read"), JSON.stringify(names));
	check("register: tool definitions have JSON Schema parameters", (ts?.tools ?? []).every((t) => t.parameters?.type === "object"));
	check("register: working environment with a containment value", ["strong", "processGroup", "none"].includes(reg.workingEnvironment?.containment), JSON.stringify(reg.workingEnvironment));
	const hooks = reg.hooks ?? [];
	check("register: tool.before and turn.before handlers", hooks.some((h) => h.hook === "tool.before") && hooks.some((h) => h.hook === "turn.before"), JSON.stringify(hooks));
	check("register: handler ids are numbers", hooks.every((h) => typeof h.handlerId === "number"));
	const rep = reg.replaces ?? [];
	check("register: replaces provider, tools and environment", ["provider:conformance", "tool:bash", "tool:read", "working-environment"].every((r) => rep.includes(r)), JSON.stringify(rep));
});

await attempt("ping", async () => {
	check("$/ping answers {}", JSON.stringify(await p.request("$/ping", {})) === "{}");
});
await attempt("unknown method", async () => {
	let err;
	try {
		await p.request("no/such-method", {});
	} catch (e) {
		err = e;
	}
	check("an unknown method is JSON-RPC -32601", err?.code === -32601, JSON.stringify(err));
});

await attempt("provider", async () => {
	const m = await p.request("provider/models", { provider: "conformance" });
	check("provider/models lists echo", (m.models ?? []).some((x) => x.id === "echo"));
	const before = p.notes.length;
	const req = p.request("provider/request", { provider: "conformance", model: { provider: "conformance", id: "echo" }, request: { systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], tools: [], settings: {} } });
	const msg = await req;
	check("provider/request: echo reply", msg.role === "assistant" && textOf(msg.content) === "echo: hello" && msg.stop === "finished", JSON.stringify(msg).slice(0, 200));
	const events = p.notes.slice(before).filter((n) => n.method === "provider/event" && n.params?.parentRequestId === req.id);
	check("provider/request: streamed provider/event before the result", events.some((e) => e.params.event?.type === "text"), `${events.length} events`);
	const call = await p.request("provider/request", { provider: "conformance", model: { provider: "conformance", id: "echo" }, request: { systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: 'tool:read {"path":"a.txt"}' }] }], tools: [], settings: {} } });
	const tc = (call.content ?? []).find((x) => x.type === "toolCall");
	check("provider/request: tool: asks for the call", call.stop === "toolUse" && tc?.name === "read" && tc?.arguments?.path === "a.txt", JSON.stringify(call).slice(0, 200));
	const done = await p.request("provider/request", { provider: "conformance", model: { provider: "conformance", id: "echo" }, request: { systemPrompt: "", messages: [
		{ role: "user", content: [{ type: "text", text: 'tool:read {"path":"a.txt"}' }] },
		{ role: "assistant", content: [tc], stop: "toolUse" },
		{ role: "toolResult", toolCallId: tc?.id ?? "x", toolName: "read", content: [{ type: "text", text: "ünïcödé result" }], isError: false },
	], tools: [], settings: {} } });
	check("provider/request: after the result, done: <result>", textOf(done.content) === "done: ünïcödé result", textOf(done.content));
});

await attempt("tools", async () => {
	writeFileSync(join(work, "note.txt"), "a note for the kit");
	const before = p.hostCalls.length;
	const r = p.request("tools/call", { toolSource: "conformance-tools", sessionId: "s1", project: work, call: { id: "c1", name: "read", input: { path: "note.txt" }, startedBy: "model" } });
	const res = await r;
	check("tools/call read: completed with the file's text", res.status === "completed" && textOf(res.content).includes("a note for the kit"), JSON.stringify(res).slice(0, 200));
	const calls = p.hostCalls.slice(before);
	check("tools/call read: used host/env/read, linked by parentRequestId", calls.some((c) => c.method === "host/env/read" && c.params?.parentRequestId === r.id), calls.map((c) => c.method).join(","));
	const nb = p.notes.length;
	const b = p.request("tools/call", { toolSource: "conformance-tools", sessionId: "s1", project: work, call: { id: "c2", name: "bash", input: { command: "echo kit-out; echo more" }, startedBy: "model" } });
	const bres = await b;
	check("tools/call bash: completed with its output", bres.status === "completed" && textOf(bres.content).includes("kit-out"), JSON.stringify(bres).slice(0, 200));
	check("tools/call bash: used host/env/exec", p.hostCalls.some((c) => c.method === "host/env/exec" && c.params?.parentRequestId === b.id));
	check("tools/call bash: sent tools/progress", p.notes.slice(nb).some((n) => n.method === "tools/progress" && n.params?.parentRequestId === b.id));
	const lst = await p.request("tools/list", { toolSource: "conformance-tools" });
	check("tools/list", (lst.tools ?? []).some((t) => t.name === "bash"));
});

await attempt("tools cancel", async () => {
	const c = p.request("tools/call", { toolSource: "conformance-tools", sessionId: "s1", project: work, call: { id: "c3", name: "bash", input: { command: "sleep 30" }, startedBy: "model" } }, 20000);
	for (let i = 0; i < 100 && !p.hostCalls.some((x) => x.method === "host/env/exec" && x.params?.parentRequestId === c.id); i++) await sleep(50);
	const t0 = Date.now();
	p.cancel(c.id);
	let settled;
	try {
		settled = await c;
	} catch (e) {
		settled = e;
	}
	check("tools/call: cancelling ends the call within 5 s", Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
	check("tools/call: a cancelled call answers cancelled", code(settled) === "cancelled" || settled?.status === "cancelled" || settled?.status === "failed", JSON.stringify(settled).slice(0, 200));
});

await attempt("environment", async () => {
	await p.request("env/write", { cwd: work, path: "w.txt", data: Buffer.from("wrïtten").toString("base64") });
	const ex = await p.request("env/exists", { cwd: work, path: "w.txt" });
	const rd = await p.request("env/read", { cwd: work, path: "w.txt" });
	check("env: write, exists, read round trip", ex.exists === true && Buffer.from(rd.data, "base64").toString() === "wrïtten");
	check("env: exists false for a missing file", (await p.request("env/exists", { cwd: work, path: "nope.txt" })).exists === false);
	const nb = p.notes.length;
	const e = p.request("env/exec", { cwd: work, command: "echo env-out" });
	const er = await e;
	check("env/exec: exit code and output", er.exitCode === 0 && er.output.includes("env-out"), JSON.stringify(er));
	check("env/exec: streamed env/output", p.notes.slice(nb).some((n) => n.method === "env/output" && n.params?.parentRequestId === e.id && n.params.chunk.includes("env-out")));
	const z = await p.request("env/exec", { cwd: work, command: "echo no-limit", timeoutMs: 0 });
	check("env/exec: timeoutMs 0 means no limit", z.exitCode === 0 && z.output.includes("no-limit") && !z.timedOut, JSON.stringify(z));
	const t1 = Date.now();
	const tl = await p.request("env/exec", { cwd: work, command: "sleep 20", timeoutMs: 300 }, 20000);
	check("env/exec: a positive timeoutMs stops the command and reports timedOut", tl.timedOut === true && Date.now() - t1 < 5000, `${JSON.stringify(tl)} after ${Date.now() - t1} ms`);
	const pidFile = join(work, `pid-${randomUUID()}`);
	const s = p.request("env/exec", { cwd: work, command: `setsid sleep 60 & echo $! > ${pidFile}; sleep 60` }, 20000);
	for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(50);
	const pid = Number(readFileSync(pidFile, "utf8"));
	const t0 = Date.now();
	p.cancel(s.id);
	try {
		await s;
	} catch {
		/* cancelled */
	}
	check("env/exec: cancelling answers within 5 s", Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
	if (reg.workingEnvironment?.containment === "strong") {
		for (let i = 0; i < 40 && alive(pid); i++) await sleep(50);
		check("env/exec: strong containment stops a setsid escapee", !alive(pid), `pid ${pid}`);
	}
	if (alive(pid)) process.kill(pid, "SIGKILL");
});

await attempt("hooks", async () => {
	const gate = (reg.hooks ?? []).find((h) => h.hook === "tool.before");
	const collect = (reg.hooks ?? []).find((h) => h.hook === "turn.before");
	const call = (input) => ({ sessionId: "s1", turnId: "t1", call: { id: "c9", name: "bash", input, startedBy: "model" }, definition: { name: "bash", description: "x", parameters: { type: "object", properties: {} } } });
	const refused = await p.request("hook/handle", { handlerId: gate?.handlerId, hook: "tool.before", payload: call({ command: "echo conformance-forbidden" }) });
	check("hook tool.before: refuses conformance-forbidden", refused?.refuse === "refused by the conformance plugin", JSON.stringify(refused));
	const allowed = await p.request("hook/handle", { handlerId: gate?.handlerId, hook: "tool.before", payload: call({ command: "echo fine" }) });
	check("hook tool.before: allows anything else with null", allowed === null, JSON.stringify(allowed));
	const contrib = await p.request("hook/handle", { handlerId: collect?.handlerId, hook: "turn.before", payload: { sessionId: "s1", turnId: "t1", input: [{ type: "text", text: "hi" }] } });
	check("hook turn.before: contributes the system line", contrib?.system === "The conformance plugin is loaded.", JSON.stringify(contrib));
	let err;
	try {
		await p.request("hook/handle", { handlerId: 987654, hook: "tool.before", payload: call({}) });
	} catch (e) {
		err = e;
	}
	check("hook: an unknown handler is unknown_handler", code(err) === "unknown_handler", JSON.stringify(err));
});

await attempt("shutdown", async () => {
	const r = await p.request("plugin/shutdown", { reason: "stop" });
	check("plugin/shutdown answers", r !== undefined);
	await p.stop();
	const ex = await Promise.race([p.exited, sleep(3000).then(() => null)]);
	check("the plugin exits after shutdown", ex !== null);
});

await attempt("parts and stdin", async () => {
	const q = start({ MODULAR_AGENT_PLUGIN_PARTS: "tools" });
	const r = await q.request("plugin/initialize", initParams);
	check("MODULAR_AGENT_PLUGIN_PARTS=tools registers only tools", !(r.providers ?? []).length && !r.workingEnvironment && !(r.hooks ?? []).length && (r.toolSources ?? []).some((t) => t.id === "conformance-tools"), JSON.stringify(Object.keys(r)));
	let err;
	const z = start();
	try {
		await z.request("plugin/initialize", { ...initParams, binding: "modular-agent-plugin/99" });
	} catch (e) {
		err = e;
	} finally {
		await z.stop();
	}
	check("an unknown binding version is not_supported", code(err) === "not_supported", JSON.stringify(err));
	q.child.stdin.end();
	const ex = await Promise.race([q.exited, sleep(3000).then(() => null)]);
	check("the plugin exits when its stdin closes", ex !== null);
	if (!ex) q.child.kill("SIGKILL");
});

rmSync(work, { recursive: true, force: true });
rmSync(home, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
