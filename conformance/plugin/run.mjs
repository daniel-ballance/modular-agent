#!/usr/bin/env node
// Conformance kit for the plugin binding, modular-agent-plugin/1 (docs/bindings/plugin.md).
// Usage: node run.mjs [--verbose] -- <command that serves the build's conformance plugin> [args...]
// The kit plays the host. It starts the plugin, serves the host/* callbacks from a temporary folder,
// and checks every part of the conformance plugin. No network, no model. Exit code 0 means all passed.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
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
	const state = { rt: undefined }; // the running Runtime scenario, if any
	let nextId = 1;
	let seq = 0;
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
				if (!existsSync(envPath(p.cwd, p.path))) return fail(m.id, "not_found", `no file ${p.path}`);
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
			case "host/history": {
				const all = state.rt?.history?.() ?? [];
				const limit = p.limit ?? 500;
				if (!Number.isInteger(limit) || limit < 1 || limit > 500) return send({ id: m.id, error: { code: -32602, message: "bad limit", data: { code: "invalid_request" } } });
				let from = 0;
				if (p.after != null) {
					const i = all.findIndex((e) => e.id === p.after);
					if (i < 0) return send({ id: m.id, error: { code: -32602, message: "unknown entry", data: { code: "invalid_request" } } });
					from = i + 1;
				}
				const entries = all.slice(from, from + limit);
				return reply(m.id, from + limit < all.length ? { entries, next: entries.at(-1)?.id } : { entries });
			}
			case "host/session":
				return reply(m.id, { id: p.sessionId, project: work, settings: {}, busy: true, actors: [] });
			case "host/declaration":
				return reply(m.id, {});
			default:
				if (m.method.startsWith("host/runtime/") && state.rt) {
					try {
						reply(m.id, await state.rt.handle(m, send));
					} catch (e) {
						fail(m.id, e.code ?? "internal", e.message ?? String(e));
					}
					return;
				}
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
			m.seq = ++seq;
			if (m.method && m.id !== undefined) void onHostRequest(m);
			else if (m.method) {
				notes.push(m);
				if (m.method === "host/runtime/report") state.rt?.reports.push(m.params);
				if (m.method === "$/cancel") state.rt?.running.get(m.params?.id)?.();
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
		state,
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
			if (state.rt) state.rt.cancelled = true;
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

/**
 * A Runtime scenario: the kit plays the Harness behind host/runtime/*, with a scripted model.
 * model(request, n) gives the n-th model answer; tool(call) answers runToolCall (may return a promise);
 * gate(call) answers "before a tool call" with a refusal reason, or null.
 */
function scenario({ model, tool = async (c) => ({ callId: c.id, status: "completed", content: [{ type: "text", text: `ran ${c.name}` }] }), gate = () => null, definitions = {}, retry = false, before = [] }) {
	const rt = { records: [], reports: [], hooks: [], toolCalls: [], modelCalls: 0, steps: 0, running: new Map(), order: [] };
	// What host/history gives: entries another build wrote before this process, then this Runtime's own.
	rt.history = () => [...before, ...rt.records];
	rt.handle = async (m, send) => {
		const p = m.params ?? {};
		rt.order.push(m.method === "host/runtime/hook" ? `hook:${p.hook}` : m.method);
		switch (m.method) {
			case "host/runtime/newId":
				return { id: randomUUID() };
			case "host/runtime/prepareStep":
				rt.steps++;
				return { systemPrompt: "kit", messages: [], tools: Object.values(definitions), settings: {} };
			case "host/runtime/model": {
				const answer = await model(p.request, rt.modelCalls++);
				const text = (answer.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("");
				if (text) send({ method: "host/runtime/modelEvent", params: { parentRequestId: m.id, event: { type: "text", delta: text } } });
				return answer;
			}
			case "host/runtime/hook":
				rt.hooks.push(p.hook);
				// A host may answer requests about a cancelled turn with the error `cancelled`, as the binding allows.
				if (rt.cancelled && p.hook !== "turn.end") throw Object.assign(new Error("the turn was cancelled"), { code: "cancelled" });
				if (p.hook === "tool.before") {
					const g = gate(p.payload?.call);
					return g ? { value: p.payload, refused: g } : { value: p.payload };
				}
				if (p.hook === "step.after" || p.hook === "turn.result") return { value: p.payload };
				if (p.hook === "tool.after") return p.payload;
				if (p.hook === "model.failed") return retry && !rt.retried ? ((rt.retried = true), { retry: true }) : null;
				return null;
			case "host/runtime/definition":
				return definitions[p.toolName] ?? { name: p.toolName, description: "kit tool", parameters: { type: "object", properties: {} } };
			case "host/runtime/runToolCall": {
				rt.toolCalls.push(p.call);
				// As a real Harness does: a cancelled tool call stops, and still answers, as cancelled.
				const cancelled = new Promise((res) => rt.running.set(m.id, () => res({ callId: p.call.id, status: "cancelled", content: [{ type: "text", text: "Cancelled" }] })));
				try {
					return await Promise.race([tool(p.call, m.id), cancelled]);
				} finally {
					rt.running.delete(m.id);
				}
			}
			case "host/runtime/record": {
				const entry = { ...p.entry, id: randomUUID(), parentId: rt.history().at(-1)?.id ?? null, sessionId: "kit-session", time: Date.now(), turnId: "kit-turn" };
				rt.records.push(entry);
				return entry;
			}
			case "host/runtime/takeSteering":
				return { entries: [] };
			case "host/runtime/hasSteering":
				return { waiting: false };
			default:
				throw Object.assign(new Error(`unknown ${m.method}`), { code: "invalid_request" });
		}
	};
	return rt;
}
const usage0 = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 };
const say = (text) => ({ role: "assistant", content: [{ type: "text", text }], stop: "finished", usage: usage0 });
const callTools = (...calls) => ({ role: "assistant", content: calls.map(([name, args]) => ({ type: "toolCall", id: `call-${randomUUID()}`, name, arguments: args })), stop: "toolUse", usage: usage0 });
const turn = (extra = {}) => ({ sessionId: "kit-session", turnId: "kit-turn", startedBy: { kind: "actor", id: "kit" }, model: { provider: "kit", id: "scripted", contextWindow: 100000, maxOutput: 1000, input: ["text"], reasoning: false }, modelSupports: { keepsState: false, runsTools: false }, settings: { maxSteps: 8 }, ...extra });
const recordedResults = (rt) => rt.records.filter((e) => e.kind === "toolResult");
const resultFor = (rt, id) => recordedResults(rt).filter((e) => e.toolCallId === id || e.message?.toolCallId === id);
const statusOf = (e) => e?.data?.status;
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
	check("register: tool.before, turn.before and output handlers", hooks.some((h) => h.hook === "tool.before") && hooks.some((h) => h.hook === "turn.before") && hooks.some((h) => h.hook === "output"), JSON.stringify(hooks));
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
	check("provider/request: echo reply", msg.role === "assistant" && textOf(msg.content) === "echo: hello" && msg.stop === "finished", String(JSON.stringify(msg)).slice(0, 200));
	const events = p.notes.slice(before).filter((n) => n.method === "provider/event" && n.params?.parentRequestId === req.id);
	check("provider/request: streamed provider/event before the result", events.some((e) => e.params.event?.type === "text"), `${events.length} events`);
	const responseHooks = p.hostCalls.filter((c) => c.method === "host/hook" && c.params?.hook === "provider.response" && c.params?.parentRequestId === req.id);
	check("provider/request: \"as the response arrives\" runs once, through host/hook", responseHooks.length === 1, `${responseHooks.length} calls`);
	check("provider/request: it has the complete message, after the last provider/event", responseHooks.length === 1 && textOf(responseHooks[0].params?.payload?.message?.content) === "echo: hello" && events.every((e) => e.seq < responseHooks[0].seq), String(JSON.stringify(responseHooks[0]?.params?.payload ?? null)).slice(0, 200));
	let unknownProvider;
	try {
		await p.request("provider/request", { provider: "no-such-provider", model: { provider: "no-such-provider", id: "x" }, request: { systemPrompt: "", messages: [], tools: [], settings: {} } });
	} catch (e) {
		unknownProvider = e;
	}
	check("provider/request: an unknown provider is invalid_request, JSON-RPC -32602", code(unknownProvider) === "invalid_request" && unknownProvider?.code === -32602, JSON.stringify(unknownProvider));
	const call = await p.request("provider/request", { provider: "conformance", model: { provider: "conformance", id: "echo" }, request: { systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: 'tool:read {"path":"a.txt"}' }] }], tools: [], settings: {} } });
	const tc = (call.content ?? []).find((x) => x.type === "toolCall");
	check("provider/request: tool: asks for the call", call.stop === "toolUse" && tc?.name === "read" && tc?.arguments?.path === "a.txt", String(JSON.stringify(call)).slice(0, 200));
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
	check("tools/call read: completed with the file's text", res.status === "completed" && textOf(res.content).includes("a note for the kit"), String(JSON.stringify(res)).slice(0, 200));
	const calls = p.hostCalls.slice(before);
	check("tools/call read: used host/env/read, linked by parentRequestId", calls.some((c) => c.method === "host/env/read" && c.params?.parentRequestId === r.id), calls.map((c) => c.method).join(","));
	const nb = p.notes.length;
	const b = p.request("tools/call", { toolSource: "conformance-tools", sessionId: "s1", project: work, call: { id: "c2", name: "bash", input: { command: "echo kit-out; echo more" }, startedBy: "model" } });
	const bres = await b;
	check("tools/call bash: completed with its output", bres.status === "completed" && textOf(bres.content).includes("kit-out"), String(JSON.stringify(bres)).slice(0, 200));
	check("tools/call bash: used host/env/exec", p.hostCalls.some((c) => c.method === "host/env/exec" && c.params?.parentRequestId === b.id));
	check("tools/call bash: host/env/exec carries the call's sessionId", p.hostCalls.some((c) => c.method === "host/env/exec" && c.params?.parentRequestId === b.id && c.params?.sessionId === "s1"), String(JSON.stringify(p.hostCalls.find((c) => c.method === "host/env/exec" && c.params?.parentRequestId === b.id)?.params ?? null)).slice(0, 200));
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
	check("tools/call: a cancelled call answers cancelled", code(settled) === "cancelled" || settled?.status === "cancelled" || settled?.status === "failed", String(JSON.stringify(settled)).slice(0, 200));
	// The request and its cancel in one write, so the plugin reads both before it starts the work.
	const early = p.request("tools/call", { toolSource: "conformance-tools", sessionId: "s1", project: work, call: { id: "c3b", name: "bash", input: { command: "sleep 30" }, startedBy: "model" } }, 8000);
	p.notify("$/cancel", { id: early.id });
	const t1 = Date.now();
	let earlyAnswer;
	try {
		earlyAnswer = await early;
	} catch (e) {
		earlyAnswer = e;
	}
	check("cancelling: a request cancelled before it started is still answered, within 5 s", !String(earlyAnswer?.message ?? "").startsWith("timed out") && Date.now() - t1 < 5000, String(JSON.stringify(earlyAnswer)).slice(0, 200));
});

await attempt("environment", async () => {
	await p.request("env/write", { cwd: work, sessionId: "s1", path: "w.txt", data: Buffer.from("wrïtten").toString("base64") });
	const ex = await p.request("env/exists", { cwd: work, sessionId: "s1", path: "w.txt" });
	const rd = await p.request("env/read", { cwd: work, sessionId: "s1", path: "w.txt" });
	check("env: write, exists, read round trip", ex.exists === true && Buffer.from(rd.data, "base64").toString() === "wrïtten");
	check("env: exists false for a missing file", (await p.request("env/exists", { cwd: work, sessionId: "s1", path: "nope.txt" })).exists === false);
	let missing;
	try {
		await p.request("env/read", { cwd: work, sessionId: "s1", path: "nope.txt" });
	} catch (e) {
		missing = e;
	}
	check("env/read of a missing file is not_found", code(missing) === "not_found", JSON.stringify(missing));
	const nb = p.notes.length;
	const e = p.request("env/exec", { cwd: work, sessionId: "s1", command: "echo env-out" });
	const er = await e;
	check("env/exec: exit code and output", er.exitCode === 0 && er.output.includes("env-out"), JSON.stringify(er));
	check("env/exec: streamed env/output", p.notes.slice(nb).some((n) => n.method === "env/output" && n.params?.parentRequestId === e.id && n.params.chunk.includes("env-out")));
	const z = await p.request("env/exec", { cwd: work, sessionId: "s1", command: "echo no-limit", timeoutMs: 0 });
	check("env/exec: timeoutMs 0 means no limit", z.exitCode === 0 && z.output.includes("no-limit") && !z.timedOut, JSON.stringify(z));
	const t1 = Date.now();
	const tl = await p.request("env/exec", { cwd: work, sessionId: "s1", command: "sleep 20", timeoutMs: 300 }, 20000);
	check("env/exec: a positive timeoutMs stops the command and reports timedOut", tl.timedOut === true && Date.now() - t1 < 5000, `${JSON.stringify(tl)} after ${Date.now() - t1} ms`);
	const pidFile = join(work, `pid-${randomUUID()}`);
	const s = p.request("env/exec", { cwd: work, sessionId: "s1", command: `setsid sleep 60 & echo $! > ${pidFile}; sleep 60` }, 20000);
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

	// Saved points, if the environment offers them.
	if (reg.workingEnvironment?.points === true) {
		writeFileSync(join(work, "pt.txt"), "before");
		const folderBefore = statSync(work).ino;
		const { point } = await p.request("env/save", { cwd: work, sessionId: "s1" });
		writeFileSync(join(work, "pt.txt"), "after");
		writeFileSync(join(work, "pt-new.txt"), "new");
		await p.request("env/restore", { cwd: work, sessionId: "s1", point });
		check("env/restore: restores in place; the project folder is the same folder", statSync(work).ino === folderBefore, `inode ${folderBefore} -> ${statSync(work).ino}`);
		check("env/restore: files are as they were at the saved point", readFileSync(join(work, "pt.txt"), "utf8") === "before" && !existsSync(join(work, "pt-new.txt")), JSON.stringify({ pt: readFileSync(join(work, "pt.txt"), "utf8"), added: existsSync(join(work, "pt-new.txt")) }));
		let gone;
		try {
			await p.request("env/restore", { cwd: work, sessionId: "s1", point: "kit-no-such-point" });
		} catch (e) {
			gone = e;
		}
		check("env/restore: an unknown point is not_found", code(gone) === "not_found", JSON.stringify(gone));
	}

	// A session's background processes outlive the call, and stop at env/sessionEnded for that session only.
	// Each writes a heartbeat file; a PID would mean nothing to the kit if the environment uses its own PID namespace.
	const beat = (sessionId) => join(work, `beat-${sessionId}`);
	const bg = (sessionId) => p.request("env/exec", { cwd: work, sessionId, command: `(for i in $(seq 600); do date +%s%N > ${beat(sessionId)}; sleep 0.1; done) >/dev/null 2>&1 &` });
	const beating = async (sessionId) => {
		const f = beat(sessionId);
		const a = existsSync(f) ? readFileSync(f, "utf8") : "";
		await sleep(600);
		const b = existsSync(f) ? readFileSync(f, "utf8") : "";
		return a !== "" && a !== b;
	};
	await bg("kit-session-1");
	await bg("kit-session-2");
	await sleep(300);
	const both = [await beating("kit-session-1"), await beating("kit-session-2")];
	check("env/exec: a background process outlives the call", both[0] && both[1], JSON.stringify(both));
	const ended = await p.request("env/sessionEnded", { sessionId: "kit-session-1" }, 10000).catch((e) => ({ error: e }));
	const oneAfter = await beating("kit-session-1");
	check("env/sessionEnded: answers {}, with the session's background processes stopped", JSON.stringify(ended) === "{}" && !oneAfter, JSON.stringify({ ended, stillBeating: oneAfter }));
	check("env/sessionEnded: another session's processes keep running", await beating("kit-session-2"));
	await p.request("env/sessionEnded", { sessionId: "kit-session-2" }, 10000).catch(() => undefined);
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
	const out = (reg.hooks ?? []).find((h) => h.hook === "output");
	const events = [{ type: "model.output", data: { delta: "the conformance-" } }, { type: "model.output", data: { delta: "secret is here" } }, { type: "entry", data: { message: { role: "assistant", content: [{ type: "text", text: "conformance-secret" }] } } }];
	const red = await p.request("hook/handle", { handlerId: out?.handlerId, hook: "output", payload: { sessionId: "s1", recipient: "kit", events, final: true } });
	const redJson = JSON.stringify(red ?? null);
	check("hook output: redacts conformance-secret in every event's text", Array.isArray(red?.events) && redJson.includes("[redacted]") && !/conformance-secret"/.test(redJson) && red.events.length === 3, redJson.slice(0, 240));
	const clean = await p.request("hook/handle", { handlerId: out?.handlerId, hook: "output", payload: { sessionId: "s1", recipient: "kit", events: [{ type: "entry", data: { text: "nothing to hide" } }], final: true } });
	check("hook output: lets clean output through", clean === null || JSON.stringify(clean).includes("nothing to hide"), JSON.stringify(clean));
	let err;
	try {
		await p.request("hook/handle", { handlerId: 987654, hook: "tool.before", payload: call({}) });
	} catch (e) {
		err = e;
	}
	check("hook: an unknown handler is unknown_handler", code(err) === "unknown_handler", JSON.stringify(err));
});

/** The Runtime checks, for each Runtime part. A build that serves no Runtime skips them with --no-runtime. */
async function runtimeChecks(part) {
	const q = start({ MODULAR_AGENT_PLUGIN_PARTS: part });
	const tag = `${part}:`;
	try {
		const r = await q.request("plugin/initialize", initParams);
		check(`${tag} registers a runtime that replaces runtime`, !!r.runtime?.id && (r.replaces ?? []).includes("runtime"), JSON.stringify({ runtime: r.runtime, replaces: r.replaces }));
		const durable = r.runtime?.supports?.continuesAfterRestart === true;
		check(`${tag} declares continuesAfterRestart ${part === "durable-runtime"}`, durable === (part === "durable-runtime"), JSON.stringify(r.runtime?.supports));

		let rt = (q.state.rt = scenario({ model: () => say("plain answer") }));
		let o = await q.request("runtime/runTurn", { turn: turn() });
		check(`${tag} a text turn completes with its text`, o.outcome?.kind === "completed" && o.result?.text === "plain answer" && Array.isArray(o.result?.openToolCalls), String(JSON.stringify(o)).slice(0, 200));
		check(`${tag} it recorded the response and listed its entries`, rt.records.some((e) => e.kind === "response") && (o.entries ?? []).length > 0, rt.records.map((e) => e.kind).join(","));
		check(`${tag} it recorded no turnStart or turnEnd: the host records those`, !rt.records.some((e) => e.kind === "turnStart" || e.kind === "turnEnd"), rt.records.map((e) => e.kind).join(","));
		check(`${tag} turn.end was its last request`, rt.order.at(-1) === "hook:turn.end", rt.order.slice(-4).join(","));
		check(`${tag} host/runtime/report is only ever a notification`, !q.hostCalls.some((c) => c.method === "host/runtime/report"));

		rt = q.state.rt = scenario({ retry: true, model: (_r, n) => (n === 0 ? { role: "assistant", content: [], stop: "failed", error: { kind: "temporary", message: "kit says try again" }, usage: usage0 } : say("retried")) });
		o = await q.request("runtime/runTurn", { turn: turn() });
		check(`${tag} a retried model request completes the turn`, o.outcome?.kind === "completed" && o.result?.text === "retried", JSON.stringify(o.outcome));
		check(`${tag} a retry without a request prepares the step again`, rt.steps === 2 && rt.hooks.includes("model.failed"), JSON.stringify({ steps: rt.steps, hooks: rt.hooks }));

		rt = q.state.rt = scenario({ model: (_r, n) => (n === 0 ? callTools(["read", { path: "a" }]) : say("after the tool")) });
		o = await q.request("runtime/runTurn", { turn: turn() });
		const call = rt.toolCalls[0];
		check(`${tag} a tool round: the call ran through runToolCall`, rt.toolCalls.length === 1 && call?.name === "read", JSON.stringify(rt.toolCalls));
		check(`${tag} "before a tool call" ran first`, rt.hooks.includes("tool.before"), rt.hooks.join(","));
		check(`${tag} exactly one recorded result for the call`, !!call && resultFor(rt, call.id).length === 1, String(JSON.stringify(recordedResults(rt))).slice(0, 200));
		check(`${tag} the turn completed after the tool`, o.outcome?.kind === "completed" && o.result?.text === "after the tool", JSON.stringify(o.outcome));

		rt = q.state.rt = scenario({ model: (_r, n) => (n === 0 ? callTools(["bash", { command: "rm -rf x" }]) : say("refused, fine")), gate: () => "kit refuses" });
		o = await q.request("runtime/runTurn", { turn: turn() });
		check(`${tag} a refused call never reaches runToolCall`, rt.toolCalls.length === 0, JSON.stringify(rt.toolCalls));
		check(`${tag} a refused call still gets one result, refused`, recordedResults(rt).length === 1 && statusOf(recordedResults(rt)[0]) === "refused", String(JSON.stringify(recordedResults(rt))).slice(0, 200));

		rt = q.state.rt = scenario({ model: () => callTools(["read", { path: "again" }]) });
		o = await q.request("runtime/runTurn", { turn: turn({ settings: { maxSteps: 2 } }) });
		check(`${tag} a step limit ends the turn as limit steps`, o.outcome?.kind === "limit" && /step/.test(String(o.outcome?.limit)), JSON.stringify(o.outcome));

		const par = { name: "par", description: "parallel", parameters: { type: "object", properties: {} }, parallel: true };
		const startedPar = new Set();
		let release;
		const both = new Promise((r) => (release = r));
		let sawSecondFirst = false;
		rt = q.state.rt = scenario({
			definitions: { par },
			model: (_r, n) => (n === 0 ? callTools(["par", { n: 1 }], ["par", { n: 2 }]) : say("both done")),
			tool: async (c) => {
				startedPar.add(c.id);
				if (startedPar.size === 2) release();
				await Promise.race([both, sleep(4000)]);
				// The first call ends only once the second's result is on the record, or after 4 s.
				if (c.input.n === 1) {
					for (let i = 0; i < 80 && !sawSecondFirst; i++) {
						sawSecondFirst = recordedResults(rt).some((e) => JSON.stringify(e.message?.content ?? "").includes("n=2"));
						if (!sawSecondFirst) await sleep(50);
					}
				}
				return { callId: c.id, status: startedPar.size === 2 ? "completed" : "failed", content: [{ type: "text", text: `n=${c.input.n}` }] };
			},
		});
		o = await q.request("runtime/runTurn", { turn: turn() });
		check(`${tag} parallel calls overlap`, startedPar.size === 2 && recordedResults(rt).length === 2 && recordedResults(rt).every((e) => statusOf(e) === "completed"), JSON.stringify(recordedResults(rt).map(statusOf)));
		check(`${tag} a parallel result is recorded as soon as it is ready`, sawSecondFirst, "the second call's result wasn't recorded while the first still ran");

		rt = q.state.rt = scenario({ model: (_r, n) => (n === 0 ? callTools(["bash", { command: "sleep 30" }]) : say("should not be reached")), tool: () => new Promise(() => {}) });
		const running = q.request("runtime/runTurn", { turn: turn() }, 20000);
		for (let i = 0; i < 100 && rt.toolCalls.length === 0; i++) await sleep(50);
		const t0 = Date.now();
		q.cancel(running.id);
		o = await running.catch((e) => ({ error: e }));
		check(`${tag} cancelling a turn answers within 5 s`, Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
		check(`${tag} a cancelled turn's outcome is cancelled, though the host answered its later hooks with the error cancelled`, o.outcome?.kind === "cancelled", String(JSON.stringify(o)).slice(0, 200));
		check(`${tag} the cancelled call still gets exactly one result`, !!rt.toolCalls[0] && resultFor(rt, rt.toolCalls[0].id).length === 1, String(JSON.stringify(recordedResults(rt))).slice(0, 200));

		q.state.rt = undefined;
		await q.request("plugin/shutdown", { reason: "stop" }).catch(() => undefined);
		await q.stop();

		// After a restart, in a new process. The turn's history was written by another build: only the standard kinds.
		// One call never started; one started and is not safe to repeat; one started and is.
		const notStarted = { id: "c-not-started", name: "read", input: { path: "b" }, started: false, safeToRepeat: false };
		const startedCall = { id: "c-started", name: "bash", input: { command: "echo once" }, started: true, safeToRepeat: false };
		const safeCall = { id: "c-safe", name: "read", input: { path: "c" }, started: true, safeToRepeat: true };
		const t0e = Date.now() - 5000;
		const entry = (kind, extra) => ({ id: `other-${kind}-${randomUUID()}`, parentId: null, sessionId: "kit-session", kind, time: t0e, writer: "another-build", modelVisible: false, turnId: "kit-turn", ...extra });
		const toolCall = (c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.input });
		const before = [
			entry("turnStart", { data: { startedBy: { kind: "actor", id: "kit" }, model: { provider: "kit", id: "scripted" }, system: "kit", tools: [], settings: { maxSteps: 8 } } }),
			entry("input", { modelVisible: true, actorId: "kit", message: { role: "user", content: [{ type: "text", text: "do three things" }] }, data: { inputId: "kit-input" } }),
			entry("response", { modelVisible: true, stepId: "kit-step-1", message: { role: "assistant", content: [notStarted, startedCall, safeCall].map(toolCall), stop: "toolUse", usage: usage0 } }),
			entry("toolStarted", { toolCallId: "c-started", stepId: "kit-step-1", data: { call: { ...startedCall, startedBy: "model" }, safeToRepeat: false } }),
			entry("toolStarted", { toolCallId: "c-safe", stepId: "kit-step-1", data: { call: { ...safeCall, startedBy: "model" }, safeToRepeat: true } }),
		];
		for (let i = 1; i < before.length; i++) before[i].parentId = before[i - 1].id;
		const fresh = start({ MODULAR_AGENT_PLUGIN_PARTS: part });
		try {
			await fresh.request("plugin/initialize", initParams);
			rt = fresh.state.rt = scenario({ model: () => say("carried on"), before });
			o = await fresh.request("runtime/resumeTurn", { turn: turn(), interrupted: { turnId: "kit-turn", calls: [notStarted, startedCall, safeCall] } });
		} finally {
			fresh.state.rt = undefined;
			await fresh.request("plugin/shutdown", { reason: "stop" }).catch(() => undefined);
			await fresh.stop();
		}
		check(`${tag} resume: the started, unsafe call is not repeated`, !rt.toolCalls.some((c) => c.id === "c-started"), JSON.stringify(rt.toolCalls));
		check(`${tag} resume: it gets one result, outcomeUnknown`, resultFor(rt, "c-started").length === 1 && statusOf(resultFor(rt, "c-started")[0]) === "outcomeUnknown", String(JSON.stringify(recordedResults(rt))).slice(0, 240));
		check(`${tag} resume: the call that never started has exactly one result`, resultFor(rt, "c-not-started").length === 1, String(JSON.stringify(recordedResults(rt))).slice(0, 240));
		check(`${tag} resume: the started call that is safe to repeat has exactly one result`, resultFor(rt, "c-safe").length === 1, String(JSON.stringify(recordedResults(rt))).slice(0, 240));
		if (durable) {
			check("durable-runtime: resume runs the call that never started", rt.toolCalls.some((c) => c.id === "c-not-started"), JSON.stringify(rt.toolCalls));
			check("durable-runtime: resume runs again a started call that is safe to repeat", rt.toolCalls.some((c) => c.id === "c-safe") && statusOf(resultFor(rt, "c-safe")[0]) === "completed", JSON.stringify(rt.toolCalls));
			check("durable-runtime: resume carries the turn on to completion", o.outcome?.kind === "completed" && o.result?.text === "carried on", JSON.stringify(o.outcome));
		} else {
			check("runtime: resume ends the turn as failed", o.outcome?.kind === "failed", JSON.stringify(o.outcome));
			check("runtime: resume asks the model nothing", rt.modelCalls === 0, `${rt.modelCalls} model calls`);
		}
	} finally {
		if (q.child.exitCode === null && q.child.signalCode === null && !q.child.stdin.writableEnded) {
			await q.request("plugin/shutdown", { reason: "stop" }).catch(() => undefined);
			await q.stop();
		}
	}
}

if (!argv.includes("--no-runtime")) {
	await attempt("runtime", () => runtimeChecks("runtime"));
	await attempt("durable-runtime", () => runtimeChecks("durable-runtime"));
}

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
