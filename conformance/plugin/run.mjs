#!/usr/bin/env node
// Conformance kit for the plugin binding, modular-agent-plugin/1 (docs/bindings/plugin.md).
// Usage: node run.mjs [--verbose] -- <command that serves the build's conformance plugin> [args...]
// The kit plays the host. It starts the plugin, serves the host/* callbacks from a temporary folder,
// and checks every part of the conformance plugin. No network, no model. Exit code 0 means all passed.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { isDeepStrictEqual as equal } from "node:util";
import { codeOf, rpcError } from "./peer.mjs";

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
const safeEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: home, LANG: "C.UTF-8" };
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const standardPlatforms = ["linux", "darwin", "win32", "freebsd", "openbsd"];
const containmentOn = (env, platform) => standardPlatforms.includes(platform) && env?.platforms?.includes(platform) ? env.containment : "none";
const declaration = { inputDuringTurn: false, waitingThroughRestart: false, continuesAfterRestart: false, rewinding: false, forking: false, keepsStateAtProvider: false, runsToolsAtProvider: false, liveSessions: false, severalActors: false, holdsOutput: false, outputBypassesAgent: false, cancellingTurnCancelsJobs: false, pluginsDuringSession: false, erasure: false, inputKeys: true, questionsOutlastTurns: false, startsTurnsUnasked: "never", queuedInputAfterRestart: "handedBack", movingWithUnfinishedWork: "refused", mixedActorInput: "refused", settingsDuringTurn: "refused", erasureDuringTurn: "refused", commandContainment: "processGroup" };
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
	const child = spawn(command[0], command.slice(1), { cwd: work, stdio: ["pipe", "pipe", verbose ? "inherit" : "ignore"], env: { ...safeEnv, ...extraEnv } });
	const pending = new Map();
	const notes = [];
	const hostCalls = [];
	const execs = new Map(); // host/env/exec request id -> { proc, parent, cancel }
	const cancelledParents = new Set();
	const state = { rt: undefined }; // the running Runtime scenario, if any
	let nextId = 1;
	let seq = 0;
	let buffer = "";
	const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
	const reply = (id, result) => send({ id, result });
	const fail = (id, code, message) => send({ id, error: rpcError(code, message) });
	const withinWork = (path) => {
		const rel = relative(realpathSync(work), path);
		if (rel === ".." || rel.startsWith(".." + sep)) throw rpcError("invalid_request", "outside fixture project");
		return path;
	};
	const envPath = (cwd, p) => {
		const full = withinWork(resolve(realpathSync(cwd ?? work), p));
		withinWork(realpathSync(existsSync(full) ? full : dirname(full)));
		return full;
	};
	async function onHostRequest(m) {
		const p = m.params ?? {};
		hostCalls.push(m);
		const parent = pending.get(p.parentRequestId);
		const sid = parent?.params?.sessionId ?? parent?.params?.turn?.sessionId;
		const needsParent = m.method.startsWith("host/runtime/") || m.method.startsWith("host/env/") || ["host/hook", "host/ask"].includes(m.method);
		if ((needsParent || p.parentRequestId !== undefined) && (!parent || (p.sessionId !== undefined && p.sessionId !== sid))) return fail(m.id, "invalid_request", "wrong parent or session");
		if ((m.method.startsWith("host/runtime/") && !parent?.method.startsWith("runtime/")) || (m.method === "host/hook" && parent?.method !== "provider/request")) return fail(m.id, "invalid_request", "wrong role");
		if (cancelledParents.has(p.parentRequestId) && !["host/env/read", "host/env/exists", "host/history", "host/session", "host/declaration", "host/runtime/record"].includes(m.method) && !(m.method === "host/runtime/hook" && p.hook === "turn.end")) return fail(m.id, "cancelled");
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
				// This fixture accepts only its own commands, not arbitrary work from the peer.
				if (!["echo kit-out; echo more", "sleep 30"].includes(p.command)) return fail(m.id, "invalid_request", "not a fixture command");
				const proc = spawn("bash", ["-c", p.command], { cwd: envPath(p.cwd, "."), env: safeEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
				let output = "", cancelled = false;
				const out = (d) => {
					if (cancelled) return;
					output += d;
					send({ method: "host/env/output", params: { parentRequestId: m.id, chunk: d } });
				};
				proc.stdout.setEncoding("utf8").on("data", out);
				proc.stderr.setEncoding("utf8").on("data", out);
				execs.set(m.id, { proc, parent: p.parentRequestId, cancel: () => {
					cancelled = true;
					try { process.kill(-proc.pid, "SIGKILL"); } catch { /* already exited */ }
				} });
				proc.on("close", (code) => {
					execs.delete(m.id);
					if (cancelled) fail(m.id, "cancelled");
					else reply(m.id, { exitCode: code, output, timedOut: false });
				});
				return;
			}
			case "host/ask":
				return fail(m.id, "not_supported", "fixture has no question channel");
			case "host/hook": {
				const { model, request, provider, sessionId = null } = parent.params;
				if (p.payload?.provider !== provider || p.payload?.sessionId !== sessionId || !equal(p.payload?.model, model)) return fail(m.id, "invalid_request", "wrong Provider scope");
				if (p.hook === "provider.request" && equal(p.payload?.request, request) && !parent.modelRequestCommitted) {
					parent.modelRequestCommitted = true;
					// Return a changed request on one attempt to distinguish using the answer from ignoring it.
					const last = request.messages.at(-1);
					if (textOf(last?.content ?? []) === "fixture transform") {
						return reply(m.id, { ...p.payload, request: { ...request, messages: [{ role: "user", content: [{ type: "text", text: "transformed request" }] }] } });
					}
					return reply(m.id, p.payload);
				}
				if (p.hook === "provider.response" && parent.modelRequestCommitted && p.payload?.message?.role === "assistant") return reply(m.id, null);
				return fail(m.id, "invalid_request", "invalid Provider hook");
			}
			case "host/credentials/read":
				return state.reg?.providers?.some((x) => x.id === p.provider) ? reply(m.id, { credential: null }) : fail(m.id, "invalid_request");
			case "host/history": {
				if (p.sessionId !== "kit-session" && p.sessionId !== "s1") return fail(m.id, "invalid_request");
				const all = p.sessionId === "kit-session" ? state.rt?.history?.() ?? [] : [];
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
				return reply(m.id, { ...declaration, inputDuringTurn: state.rt?.steering ?? false });
			default:
				if (m.method.startsWith("host/runtime/") && state.rt) {
					try {
						reply(m.id, await state.rt.handle(m, send));
					} catch (e) {
						if (codeOf(e)) send({ id: m.id, error: e });
						else fail(m.id, e.code ?? "internal", e.message ?? String(e));
					}
					return;
				}
				return fail(m.id, "method_not_found");
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
			if (m.method && m.id !== undefined) void onHostRequest(m).catch((e) => fail(m.id, codeOf(e) ?? "internal", e?.message));
			else if (m.method) {
				notes.push(m);
				if (m.method === "host/runtime/report") state.rt?.reports.push(m.params);
				if (m.method === "$/cancel") state.rt?.running.get(m.params?.id)?.();
				if (m.method === "$/cancel") {
					// The plugin cancelled one of its own requests to us.
					const e = execs.get(m.params?.id);
					e?.cancel();
				}
			} else if (pending.has(m.id)) {
				const { resolve: res, reject } = pending.get(m.id);
				pending.delete(m.id);
				for (const e of execs.values()) if (e.parent === m.id) e.cancel();
				cancelledParents.delete(m.id);
				if (m.error) reject(m.error);
				else res(m.result);
			}
		}
	});
	child.stdin.on("error", () => undefined);
	const exited = new Promise((r) => {
		child.once("error", () => r({ code: null, signal: null }));
		child.once("close", (code, signal) => r({ code, signal }));
	});
	void exited.then(() => {
		for (const callback of execs.values()) callback.cancel();
		for (const callback of pending.values()) callback.reject(rpcError("lost", "fixture plugin connection closed"));
		pending.clear();
	});
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
				pending.set(id, { resolve: res, reject, method, params });
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
			cancelledParents.add(id);
			if (state.rt) for (const cancel of state.rt.running.values()) cancel();
			send({ method: "$/cancel", params: { id } });
			for (const e of execs.values()) if (e.parent === id) e.cancel();
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
function scenario({ model, tool = async (c) => ({ callId: c.id, status: "completed", content: [{ type: "text", text: `ran ${c.name}` }] }), gate = () => null, definitions = {}, retry = false, compact = false, steering = false, refuseAt, before = [], abandoned = [] }) {
	// Plugin binding: Runtime callbacks and Runtime records and effects.
	const rt = { records: [], reports: [], hooks: [], toolCalls: [], modelCalls: 0, steps: 0, running: new Map(), order: [], submitted: [], steering, finalChecks: [], preparedUsage: [], afterSteps: [] };
	const tools = { read: { name: "read", description: "fixture read", parameters: true }, bash: { name: "bash", description: "fixture shell", parameters: true }, ...definitions };
	const modelRef = { provider: "kit", id: "scripted" };
	const authorizers = [{ sessionId: "kit-session", actorId: "kit" }];
	const rights = ["watch", "input", "tools"];
	if (!before.length) {
		const content = [{ type: "text", text: "fixture input" }];
		before = [
			{ kind: "actorJoined", data: { actor: { id: "kit", kind: "host", rights }, operatorAdmission: true } },
			{ kind: "inputAccepted", actorId: "kit", inputId: "kit-input", data: { content, when: "now", authorizers, rights } },
			{ kind: "turnStart", turnId: "kit-turn", data: { model: modelRef, startedBy: { kind: "actor", id: "kit" }, system: "kit", settings: { maxSteps: 8 }, tools: Object.values(tools), authorizers, rights } },
			{ kind: "input", turnId: "kit-turn", actorId: "kit", modelVisible: true, message: { role: "user", content }, inputId: "kit-input" },
		].map((e, i) => ({ id: `kit-base-${i}`, parentId: i ? `kit-base-${i - 1}` : null, sessionId: "kit-session", time: Date.now(), writer: "kit-host", modelVisible: false, ...e }));
	}
	rt.history = () => [...before, ...rt.records];
	const put = (entry, writer = "kit-host") => {
		const saved = { ...entry, id: randomUUID(), parentId: rt.history().at(-1)?.id ?? null, sessionId: "kit-session", time: Date.now(), turnId: "kit-turn", writer };
		rt.records.push(saved);
		return saved;
	};
	const invalid = (message) => { throw Object.assign(Error(message), { code: "invalid_request" }); };
	const allowed = new Map(), known = new Map(), attempts = new Map();
	const refuseLimit = (phase, stepId) => {
		if (refuseAt !== phase || rt.modelCalls !== 1) return;
		rt.denied = stepId;
		const error = rpcError("turn_limit");
		error.data.limit = "sessionTokens";
		throw error;
	};
	const finish = (call, result) => put({ kind: "toolResult", ...(known.get(call.id)?.stepId ? { stepId: known.get(call.id).stepId } : {}), toolCallId: call.id, modelVisible: true, message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content, isError: result.status !== "completed" }, data: { status: result.status, ...(result.value === undefined ? {} : { value: result.value }) } });
	const resultOf = (e) => ({ callId: e.toolCallId, status: e.data.status, content: e.message.content, ...(e.data.value === undefined ? {} : { value: e.data.value }) });
	for (const e of before.filter((e) => e.kind === "response")) for (const c of e.message.content.filter((c) => c.type === "toolCall")) known.set(c.id, { id: c.id, name: c.name, input: c.arguments, startedBy: "model", stepId: e.stepId });
	for (const c of abandoned) {
		const status = c.started ? "outcomeUnknown" : "notStarted";
		finish(known.get(c.id), { status, content: [{ type: "text", text: c.started ? "The interrupted call may have run." : "The call did not start." }] });
	}
	const match = (a, b) => a?.id === b?.id && a?.name === b?.name && equal(a?.input, b?.input);

	rt.handle = async (m, send) => {
		const p = m.params ?? {};
		rt.order.push(m.method === "host/runtime/hook" ? `hook:${p.hook}` : m.method);
		switch (m.method) {
			case "host/runtime/newId":
				return { id: randomUUID() };
			case "host/runtime/prepareStep": {
				rt.steps++;
				rt.preparedUsage.push(p.usage);
				if (attempts.has(p.stepId)) invalid("reused attempt");
				refuseLimit("prepareStep", p.stepId);
				const messages = [], sources = [];
				if (compact && rt.retried && !rt.summary) {
					// Model attempt sequences: host-owned auxiliary work is committed inside preparation.
					const input = rt.history().find((e) => e.kind === "input");
					const stepId = randomUUID(), request = { systemPrompt: "Summarize fixture input", messages: [input.message], tools: [], settings: {} };
					const intent = put({ kind: "modelRequest", stepId, modelVisible: false, data: { model: modelRef, tools: request.tools.map((t) => t.name), safeToRepeat: false, auxiliary: true }, sources: [input.id] });
					put({ kind: "response", stepId, modelVisible: false, message: { ...say("fixture summary"), usage: auxiliaryUsage }, sources: [intent.id] });
					rt.summary = put({ kind: "summary", modelVisible: true, data: { summary: "fixture summary" }, sources: [input.id] });
					rt.auxiliary = stepId;
				}
				for (const e of rt.history().filter((x) => x.modelVisible && x.kind !== "toolResult" &&
					!rt.summary?.sources.includes(x.id))) {
					sources.push(e.id);
					if (e.kind === "summary") {
						messages.push({ role: "user", content: [{ type: "text", text: e.data.summary }] });
						continue;
					}
					messages.push(e.message);
					if (e.kind === "response") for (const c of e.message.content.filter((part) => part.type === "toolCall")) {
						const result = resultFor(rt, c.id)[0];
						if (result) {
						messages.push(result.message);
						sources.push(result.id);
					}
					}
				}
				const request = { systemPrompt: "kit", messages, tools: Object.values(tools), settings: {} };
				attempts.set(p.stepId, { request, sources });
				return request;
			}
			case "host/runtime/model": {
				const attempt = attempts.get(p.stepId);
				if (!attempt || attempt.sent || !equal(attempt.request, p.request)) invalid("not the prepared attempt");
				refuseLimit("model", p.stepId);
				attempt.sent = true;
				attempt.intent = put({ kind: "modelRequest", stepId: p.stepId, modelVisible: false, data: { model: modelRef, safeToRepeat: false, tracksStepAfter: true, tools: p.request.tools.map((t) => t.name) }, sources: attempt.sources });
				if (refuseAt === "postIntent" && rt.modelCalls === 1) {
					// Runtime records and effects: only the host settles a committed, undispatched attempt.
					put({ kind: "response", stepId: p.stepId, modelVisible: false, data: { recovery: true }, message: { role: "assistant", stop: "aborted", content: [] } });
					refuseLimit("postIntent", p.stepId);
				}
				const answer = await model(p.request, rt.modelCalls++);
				attempt.answer = answer;
				const text = (answer.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("");
				if (text) send({ method: "host/runtime/modelEvent", params: { parentRequestId: m.id, event: { type: "text", delta: text } } });
				return answer;
			}
			case "host/runtime/hook":
				rt.hooks.push(p.hook);
				if (p.hook === "tool.before") {
					const call = p.payload?.call, original = known.get(call?.id);
					if (!original || !match(call, original)) invalid("unknown or mismatched call");
					const g = gate(call);
					if (g) {
						// Runtime records and effects: return the committed settlement, not just the reason.
						const result = resultOf(finish(original, { status: "refused", content: [{ type: "text", text: g }] }));
						return { value: p.payload, refused: g, result };
					}
					allowed.set(call.id, structuredClone(call));
					return { value: p.payload };
				}
				if (p.hook === "step.after") {
					// Shared data: Recording order and ownership. This fixture gate always allows.
					const stepId = p.payload?.stepId;
					if (!rt.history().some((e) => e.kind === "modular-agent.stepAfter" && e.stepId === stepId)) {
						put({ kind: "modular-agent.stepAfter", stepId, modelVisible: false, data: { decision: null } });
					}
					rt.afterSteps.push(stepId);
					return { value: p.payload };
				}
				if (p.hook === "turn.end") rt.endOutcome = p.payload?.outcome;
				if (p.hook === "turn.result") return { value: p.payload };
				if (p.hook === "tool.after") {
					const result = resultFor(rt, p.payload?.call?.id)[0];
					if (!result) invalid("no cached tool result");
					return { ...p.payload, result: resultOf(result) };
				}
				if (p.hook === "model.failed") return retry && !rt.retried ? ((rt.retried = true), { retry: true }) : null;
				return null;
			case "host/runtime/definition":
				return tools[p.toolName] ?? null;
			case "host/runtime/runToolCall": {
				const c = p.call, original = known.get(c?.id);
				if (!original || resultFor(rt, c.id).length) invalid("unknown or settled call");
				const decision = allowed.get(c.id);
				allowed.delete(c.id);
				if (!decision) invalid("call has no allowance");
				if (!match(decision, c) || !tools[c.name]) return resultOf(finish(original, { status: "refused", content: [{ type: "text", text: "Fixture denied dispatch" }] }));
				rt.toolCalls.push(c);
				put({ kind: "toolStarted", toolCallId: c.id, stepId: original.stepId, actorId: "kit", modelVisible: false, data: { call: { ...c, actorId: "kit" }, source: fixtureSource, definition: tools[c.name], safeToRepeat: false, openWorld: tools[c.name].hints?.openWorld ?? true, authorizers, rights } });
				// As a real Harness does: a cancelled tool call stops, and still answers, as cancelled.
				const cancelled = new Promise((res) => rt.running.set(m.id, () => res({ callId: p.call.id, status: "cancelled", content: [{ type: "text", text: "Cancelled" }] })));
				try {
					const result = await Promise.race([tool(p.call, m.id), cancelled]);
					finish(original, result);
					return result;
				} finally {
					rt.running.delete(m.id);
				}
			}
			case "host/runtime/record": {
				const e = p.entry;
				rt.submitted.push(e);
				if (e?.kind === "response") {
					const attempt = attempts.get(e.stepId);
					if (!attempt?.answer || !equal(e.message, attempt.answer)) invalid("response does not match an attempt");
					if (attempt.saved) return attempt.saved;
					for (const c of e.message.content.filter((part) => part.type === "toolCall")) known.set(c.id, { id: c.id, name: c.name, input: c.arguments, startedBy: "model", stepId: e.stepId });
					return (attempt.saved = put({ kind: "response", stepId: e.stepId, message: e.message, modelVisible: true, sources: [attempt.intent.id] }, "kit-runtime"));
				}
				if (e?.kind === "toolResult") {
					if (e.data?.status === "notStarted") invalid("notStarted is host-owned");
					const committed = resultFor(rt, e.toolCallId)[0];
					if (committed && equal(committed.message, e.message) && equal(committed.data, e.data)) return committed;
					invalid("tool result does not match a committed result");
				}
				if (typeof e?.kind !== "string" || !e.kind.includes(".")) invalid("host-owned record");
				return put({ ...e, modelVisible: false }, "kit-runtime");
			}
			case "host/runtime/takeSteering":
				if (!rt.steering) throw rpcError("not_supported");
				if (p.final === true) rt.finalChecks.push(rt.order.length - 1);
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
const auxiliaryUsage = { ...usage0, input: 7 };
const fixtureSource = { plugin: "kit-host", toolSource: "kit-tools" };
const say = (text) => ({ role: "assistant", content: [{ type: "text", text }], stop: "finished", usage: usage0 });
const callTools = (...calls) => ({ role: "assistant", content: calls.map(([name, args]) => ({ type: "toolCall", id: `call-${randomUUID()}`, name, arguments: args })), stop: "toolUse", usage: usage0 });
const turn = (extra = {}) => ({ sessionId: "kit-session", turnId: "kit-turn", startedBy: { kind: "actor", id: "kit" }, model: { provider: "kit", id: "scripted", contextWindow: 100000, maxOutput: 1000, input: ["text"], reasoning: false }, modelSupports: { keepsState: false, runsTools: false, safeToRepeat: false }, settings: { maxSteps: 8 }, ...extra });
const recordedResults = (rt) => rt.records.filter((e) => e.kind === "toolResult");
const resultFor = (rt, id) => recordedResults(rt).filter((e) => e.toolCallId === id || e.message?.toolCallId === id);
const statusOf = (e) => e?.data?.status;
const textOf = (content) => (content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("");
const initParams = { binding: BINDING, data: "modular-agent-data/1", host: { name: "conformance-kit", version: "1" }, project: work, home, config: {} };

let p = start();
let reg = {};
await attempt("initialize", async () => {
	reg = p.state.reg = await p.request("plugin/initialize", initParams);
	check("initialize: binding echoed", reg.binding === BINDING, JSON.stringify(reg.binding));
	check("initialize: a name", typeof reg.name === "string" && reg.name.length > 0);
	const provider = (reg.providers ?? []).find((x) => x.id === "conformance");
	check("register: provider conformance with model echo", !!provider?.models?.some((m) => m.id === "echo" && m.provider === "conformance"), JSON.stringify(reg.providers));
	const ts = (reg.toolSources ?? []).find((x) => x.id === "conformance-tools");
	const names = (ts?.tools ?? []).map((t) => t.name);
	check("register: tool source conformance-tools with bash and read", names.includes("bash") && names.includes("read"), JSON.stringify(names));
	// Shared data: Tools. This checks the schema container, not the 2020-12 vocabulary.
	check("register: tool parameter schemas are objects or booleans", (ts?.tools ?? []).every((t) => typeof t.parameters === "boolean" || (t.parameters && typeof t.parameters === "object" && !Array.isArray(t.parameters))));
	// Plugin binding: The host asks a Provider.
	check("register: Provider declares runsTools false", provider?.supports?.runsTools === false);
	check("register: working environment with a containment value", ["strong", "processGroup", "none"].includes(reg.workingEnvironment?.containment), JSON.stringify(reg.workingEnvironment));
	const platforms = reg.workingEnvironment?.platforms;
	check("Starting: the handshake: platform claims use standard spellings for standard identifiers", platforms === undefined ||
		(Array.isArray(platforms) && platforms.every((p) => typeof p === "string" && (!standardPlatforms.includes(p.toLowerCase()) || standardPlatforms.includes(p)))), JSON.stringify(platforms));
	const hooks = reg.hooks ?? [];
	check("register: tool.before, turn.before and output handlers", hooks.some((h) => h.hook === "tool.before") && hooks.some((h) => h.hook === "turn.before") && hooks.some((h) => h.hook === "output"), JSON.stringify(hooks));
	// Plugin binding: Starting: the handshake.
	check("register: handler ids are unique safe integers", hooks.every((h) => Number.isSafeInteger(h.handlerId)) && new Set(hooks.map((h) => h.handlerId)).size === hooks.length);
	const rep = reg.replaces ?? [];
	check("register: replaces provider, tools and environment", ["provider:conformance", "tool:bash", "tool:read", "working-environment"].every((r) => rep.includes(r)), JSON.stringify(rep));
});

await attempt("ping", async () => {
	check("$/ping answers {}", JSON.stringify(await p.request("$/ping", {})) === "{}");
});
// Shared data: General rules; Plugin binding: Transport. The JSON-RPC object is level 1.
for (const depth of [64, 65]) await attempt(`Transport: JSON nesting at ${depth} levels`, async () => {
	const peer = start();
	try {
		const opaque = Array.from({ length: depth - 3 }).reduce((inner) => [inner], 1);
		const r = await peer.request("plugin/initialize", { ...initParams, config: { "kit.depth": opaque } }).catch((e) => e);
		check(`Transport: ${depth} JSON levels ${depth === 64 ? "are accepted" : "are accepted or refused as invalid_request"}`,
			r?.binding === BINDING || (depth > 64 && r?.code === -32602 && code(r) === "invalid_request"));
	} finally {
		await peer.request("plugin/shutdown", { reason: "stop" }).catch(() => undefined);
		await peer.stop();
	}
});

// Plugin binding: Transport. This independent process takes raw frames, not the mock host's decoder.
await attempt("framing", async () => {
	const child = spawn(command[0], command.slice(1), { cwd: work, env: safeEnv, stdio: ["pipe", "pipe", "ignore"] });
	child.stdin.on("error", () => undefined);
	const exits = new Promise((resolve) => child.once("close", resolve));
	try {
		let buffer = "";
		const answers = [];
		child.stdout.setEncoding("utf8").on("data", (chunk) => {
			buffer += chunk;
			for (let i; (i = buffer.indexOf("\n")) >= 0;) {
				try { answers.push(JSON.parse(buffer.slice(0, i))); } catch { answers.push(null); }
				buffer = buffer.slice(i + 1);
			}
		});
		const frame = (id, method, params) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
		child.stdin.write(frame("init", "plugin/initialize", initParams) + "\r\n");
		for (let i = 0; i < 100 && !answers.length && child.exitCode === null; i++) await sleep(50);
		check("framing: plugin accepts CRLF", answers.some((r) => r?.id === "init" && r.result?.binding === BINDING));
		child.stdin.write("[{}]\n{\n" + frame(7, "$/ping", {}) + "\n" + frame("7", "$/ping", {}) + "\n");
		for (let i = 0; i < 100 && answers.length < 5 && child.exitCode === null; i++) await sleep(50);
		check("framing: batch and malformed JSON get distinct error envelopes", answers.some((r) => r?.id === null && r.error?.code === -32600 && code(r.error) === "invalid_request") && answers.some((r) => r?.id === null && r.error?.code === -32700 && code(r.error) === "parse_error"));
		check("framing: numeric and string ids do not collide", [7, "7"].every((id) => answers.some((r) => r?.id === id && equal(r.result, {}))));
		child.stdin.write(frame(7, "$/ping", {}) + "\n");
		const closed = await Promise.race([exits.then(() => true), sleep(5000).then(() => false)]);
		check("framing: reusing a settled request id closes the connection", closed);
	} finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
});

await attempt("unknown method", async () => {
	let err;
	try {
		await p.request("no/such-method", {});
	} catch (e) {
		err = e;
	}
	// Plugin binding: Errors and connection loss.
	check("unknown method has the method_not_found envelope", err?.code === -32601 && code(err) === "method_not_found", JSON.stringify(err));
});

// Plugin binding: The host asks a Provider.
await attempt("provider", async () => {
	const m = await p.request("provider/models", { provider: "conformance" });
	check("provider/models lists echo", (m.models ?? []).some((x) => x.id === "echo"));
	const before = p.notes.length;
	const req = p.request("provider/request", { sessionId: "s1", provider: "conformance", model: { provider: "conformance", id: "echo" }, request: { systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], tools: [], settings: {} } });
	const msg = await req;
	check("provider/request: echo reply", msg.role === "assistant" && textOf(msg.content) === "echo: hello" && msg.stop === "finished", String(JSON.stringify(msg)).slice(0, 200));
	const events = p.notes.slice(before).filter((n) => n.method === "provider/event" && n.params?.parentRequestId === req.id);
	check("provider/request: streamed provider/event before the result", events.some((e) => e.params.event?.type === "text"), `${events.length} events`);
	const responseHooks = p.hostCalls.filter((c) => c.method === "host/hook" && c.params?.hook === "provider.response" && c.params?.parentRequestId === req.id);
	check("provider/request: \"as the response arrives\" runs once, through host/hook", responseHooks.length === 1, `${responseHooks.length} calls`);
	const projection = { sessionId: "s1", provider: "conformance", model: { provider: "conformance", id: "echo" }, message: msg };
	check("The host asks a Provider: provider.response sends the four-field projection after the last provider/event", responseHooks.length === 1 && equal(responseHooks[0].params?.payload, projection) && events.every((e) => e.seq < responseHooks[0].seq), String(JSON.stringify(responseHooks[0]?.params?.payload ?? null)).slice(0, 200));
	let unknownProvider;
	try {
		await p.request("provider/request", { provider: "no-such-provider", model: { provider: "no-such-provider", id: "x" }, request: { systemPrompt: "", messages: [], tools: [], settings: {} } });
	} catch (e) {
		unknownProvider = e;
	}
	check("provider/request: an unknown provider is invalid_request, JSON-RPC -32602", code(unknownProvider) === "invalid_request" && unknownProvider?.code === -32602, JSON.stringify(unknownProvider));
	// Plugin binding: The conformance plugin; ACP: Conformance mode.
	const request = (messages, tools) => p.request("provider/request", { sessionId: "s1", provider: "conformance", model: { provider: "conformance", id: "echo" }, request: { systemPrompt: "", messages, tools, settings: {} } });
	const transformed = await request([{ role: "user", content: [{ type: "text", text: "fixture transform" }] }], []).catch((e) => e);
	check("The host asks a Provider: inference uses the answer to provider.request", transformed.stop === "finished" && textOf(transformed.content) === "echo: transformed request");
	const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
	const tool = { name: "read", description: "fixture file", parameters: { type: "object", properties: { path: { type: "string" } } } };
	const input = user('tool:read {"path":"a.txt"}');
	const call = await request([input], [tool]);
	const tc = (call.content ?? []).find((x) => x.type === "toolCall");
	check("provider/request: tool directive asks for the exact call", call.stop === "toolUse" && tc?.name === "read" && equal(tc.arguments, { path: "a.txt" }));
	const invalid = await request([input], []);
	check("provider/request: unoffered tool directive fails with zero usage", invalid.stop === "failed" && equal(invalid.error, { kind: "other", message: "Invalid tool directive" }) && equal(invalid.usage, zeroUsage));
	const result = (id, ...parts) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: parts.map((text) => ({ type: "text", text })), isError: false });
	const older = { type: "toolCall", id: "older-id", name: "read", arguments: { path: "older.txt" } };
	const astral = "😀".repeat(199);
	const done = await request([user('tool:read {"path":"older.txt"}'), { role: "assistant", content: [older], stop: "toolUse" }, result(older.id, "wrong earlier result"), input, { role: "assistant", content: [tc], stop: "toolUse" }, result(tc.id, astral, "XZ")], [tool]);
	check("provider/request: done uses the first 200 code points after the latest user message", done.stop === "finished" && textOf(done.content) === `done: ${astral}X` && equal(done.usage, zeroUsage));
});

await attempt("tools", async () => {
	writeFileSync(join(work, "note.txt"), "a note for the kit");
	const before = p.hostCalls.length;
	const r = p.request("tools/call", { toolSource: "conformance-tools", sessionId: "s1", project: work, call: { id: "c1", name: "read", input: { path: "note.txt" }, startedBy: "model" } });
	const res = await r;
	check("tools/call read: completed with the file's text", res.status === "completed" && textOf(res.content).includes("a note for the kit"), String(JSON.stringify(res)).slice(0, 200));
	const calls = p.hostCalls.slice(before);
	check("tools/call read: used host/env/read, linked by parentRequestId", calls.some((c) => c.method === "host/env/read" && c.params?.parentRequestId === r.id), calls.map((c) => c.method).join(","));
	const beforeProgress = p.notes.length;
	const b = p.request("tools/call", { toolSource: "conformance-tools", sessionId: "s1", project: work, call: { id: "c2", name: "bash", input: { command: "echo kit-out; echo more" }, startedBy: "model" } });
	const bres = await b;
	check("tools/call bash: completed with its output", bres.status === "completed" && textOf(bres.content).includes("kit-out"), String(JSON.stringify(bres)).slice(0, 200));
	// Plugin binding: The conformance plugin. Progress forwarding here is a Bash fixture rule.
	const progress = p.notes.slice(beforeProgress).filter((n) => n.method === "tools/progress" && n.params?.parentRequestId === b.id);
	check("fixture bash: forwards output as progress and includes the exit line", progress.map((n) => textOf(n.params.content)).join("").includes("kit-out") && textOf(bres.content).endsWith("\n[exit code 0]"));
	check("tools/call bash: used host/env/exec", p.hostCalls.some((c) => c.method === "host/env/exec" && c.params?.parentRequestId === b.id));
	check("tools/call bash: host/env/exec carries the call's sessionId", p.hostCalls.some((c) => c.method === "host/env/exec" && c.params?.parentRequestId === b.id && c.params?.sessionId === "s1"), String(JSON.stringify(p.hostCalls.find((c) => c.method === "host/env/exec" && c.params?.parentRequestId === b.id)?.params ?? null)).slice(0, 200));

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
	// Plugin binding: Transport. The fixture command cannot normally finish in this interval.
	check("tools/call: a cancelled call answers cancelled, not generic failure", code(settled) === "cancelled" || settled?.status === "cancelled", String(JSON.stringify(settled)).slice(0, 200));
	// Early-arrival probe. It does not prove that dispatch had not started.
	const early = p.request("tools/call", { toolSource: "conformance-tools", sessionId: "s1", project: work, call: { id: "c3b", name: "bash", input: { command: "sleep 30" }, startedBy: "model" } }, 8000);
	p.cancel(early.id);
	const t1 = Date.now();
	let earlyAnswer;
	try {
		earlyAnswer = await early;
	} catch (e) {
		earlyAnswer = e;
	}
	check("tools/call: early-arriving cancel gets a cancelled answer within 5 s", (code(earlyAnswer) === "cancelled" || earlyAnswer?.status === "cancelled") && Date.now() - t1 <= 5000);
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
	check("env/exec: a positive timeoutMs stops the command and reports timedOut", tl.timedOut === true && tl.exitCode === null && Date.now() - t1 <= 5300, `${JSON.stringify(tl)} after ${Date.now() - t1} ms`);
	// The escapee writes a heartbeat file; a PID would mean nothing if the environment has its own PID namespace.
	const escBeat = join(work, `esc-${randomUUID()}`);
	const s = p.request("env/exec", { cwd: work, sessionId: "s1", command: `setsid bash -c 'for i in $(seq 600); do date +%s%N > ${escBeat}; sleep 0.1; done' >/dev/null 2>&1 & sleep 60` }, 20000);
	for (let i = 0; i < 100 && !existsSync(escBeat); i++) await sleep(50);
	const t0 = Date.now();
	p.cancel(s.id);
	// Plugin binding: Command lifetime.
	const cancelled = await s.catch((e) => e);
	check("env/exec: cancelling answers cancelled or lost within 5 s", ["cancelled", "lost"].includes(code(cancelled)) && Date.now() - t0 <= 5000, `${Date.now() - t0} ms`);
	// Plugin binding: Starting: the handshake. A nonmatching platform does not claim containment here.
	const containment = containmentOn(reg.workingEnvironment, process.platform);
	if (containment === "strong") {
		await sleep(1500);
		const a = existsSync(escBeat) ? readFileSync(escBeat, "utf8") : "";
		await sleep(700);
		const b = existsSync(escBeat) ? readFileSync(escBeat, "utf8") : "";
		check("env/exec: strong containment stops a setsid escapee", a !== "" && a === b, "its heartbeat still changes after the cancel");
	}

	// Saved points, if the environment offers them.
	if (reg.workingEnvironment?.points === true) {
		writeFileSync(join(work, "pt.txt"), "before");
		const folderBefore = statSync(work).ino;
		const { point } = await p.request("env/save", { cwd: work, sessionId: "s1" });
		writeFileSync(join(work, "pt.txt"), "after");
		writeFileSync(join(work, "pt-new.txt"), "new");
		const found = (sessionId, point) => p.request("env/checkPoint", { cwd: work, sessionId, point }).catch((e) => e);
		const pointChecks = [await found("s1", point), await found("s1", "kit-no-such-point"), await found("s2", point)];
		check("Paths and points: checkPoint reports a point only in its saving session and does not restore",
			equal(pointChecks, [{ exists: true }, { exists: false }, { exists: false }]) &&
			readFileSync(join(work, "pt.txt"), "utf8") === "after" && existsSync(join(work, "pt-new.txt")), JSON.stringify(pointChecks));
		await p.request("env/restore", { cwd: work, sessionId: "s1", point });
		check("env/restore: restores in place; the project folder is the same folder", statSync(work).ino === folderBefore, `inode ${folderBefore} -> ${statSync(work).ino}`);
		check("env/restore: files are as they were at the saved point", readFileSync(join(work, "pt.txt"), "utf8") === "before" && !existsSync(join(work, "pt-new.txt")), JSON.stringify({ pt: readFileSync(join(work, "pt.txt"), "utf8"), added: existsSync(join(work, "pt-new.txt")) }));
		let gone;
		try {
			await p.request("env/restore", { cwd: work, sessionId: "s1", point: "kit-no-such-point" });
		} catch (e) {
			gone = e;
		}
		check("Paths and points: env/restore of an unknown point is not_found", code(gone) === "not_found", JSON.stringify(gone));
		const foreign = start({ MODULAR_AGENT_PLUGIN_PARTS: "environment" });
		try {
			const otherProject = mkdtempSync(join(work, "foreign-project-"));
			const otherHome = mkdtempSync(join(home, "foreign-home-"));
			await foreign.request("plugin/initialize", { ...initParams, project: otherProject, home: otherHome });
			const saved = await foreign.request("env/save", { cwd: otherProject, sessionId: "s1" });
			const error = await p.request("env/restore", { cwd: work, sessionId: "s1", point: saved.point }).catch((e) => e);
			check("Paths and points: a point from another environment is distinct and restores as not_found", saved.point !== point && code(error) === "not_found");
		} finally {
			await foreign.request("plugin/shutdown", {}).catch(() => undefined);
			await foreign.stop();
		}
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
	// Plugin binding: Command lifetime. No descendant cleanup guarantee under containment none.
	if (containment === "none") {
		check("env/sessionEnded: acknowledges an unused session", equal(await p.request("env/sessionEnded", { sessionId: "kit-unused" }), {}));
		return;
	}
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
	// Plugin binding: Held output; Shared data: Output events and Entry fields and tombstones.
	const events = [{ type: "text", data: { delta: "the conformance-", stepId: "k1" } }, { type: "text", data: { delta: "secret is here", stepId: "k1" } }];
	const red = await p.request("hook/handle", { handlerId: out?.handlerId, hook: "output", payload: { sessionId: "s1", recipient: "kit", events, final: true } });
	const got = red?.events ?? [];
	const joined = got.filter((e) => e.type === "text").map((e) => e.data?.delta ?? "").join("");
	check("hook output: redacts a secret split across a stream's text events", Array.isArray(red?.events) && joined.includes("[redacted]") && !joined.includes("conformance-secret"), String(JSON.stringify(red)).slice(0, 240));
	const custom = await p.request("hook/handle", { handlerId: out?.handlerId, hook: "output", payload: { sessionId: "s1", recipient: "kit", final: true, events: [{ type: "kit.own", data: { n: 7, note: "conformance-secret", flag: true } }] } });
	const own = custom?.events?.[0];
	check("hook output: redacts strings in a build's own event type, and keeps the rest", own?.data?.n === 7 && own?.data?.flag === true && own?.data?.note === "[redacted]" && own?.type === "kit.own" && custom.events.length === 1, String(JSON.stringify(own)).slice(0, 200));
	const clean = await p.request("hook/handle", { handlerId: out?.handlerId, hook: "output", payload: { sessionId: "s1", recipient: "kit", events: [{ type: "entry", data: { entry: { id: "kit-e1", parentId: null, kind: "response", sessionId: "s1", time: 1, writer: "kit-runtime", modelVisible: true, turnId: "t1", stepId: "k1", message: { role: "assistant", content: [{ type: "text", text: "nothing to hide" }], stop: "finished" } } } }], final: true } });
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

		const steering = r.runtime?.supports?.inputDuringTurn === true;
		const runScenario = (options) => scenario({ steering, ...options });
		let rt = (q.state.rt = runScenario({ model: () => say("plain answer") }));
		let o = await q.request("runtime/runTurn", { turn: turn() });
		check(`${tag} a text turn completes with its text`, o.outcome?.kind === "completed" && o.result?.text === "plain answer" && Array.isArray(o.result?.openToolCalls), String(JSON.stringify(o)).slice(0, 200));
		const ordered = (items, needed) => {
			let last = -1;
			return needed.every((item) => (last = items.indexOf(item, last + 1)) >= 0);
		};
		const callback = (name) => `host/runtime/${name}`;
		check(`${tag} Model attempt sequences: normal step prepares, dispatches, commits and closes in order`,
			ordered(rt.order, [callback("newId"), callback("prepareStep"), callback("model"), callback("record"), "hook:step.after"]));
		check(`${tag} it recorded the response and listed its entries`, rt.records.some((e) => e.kind === "response") && (o.entries ?? []).length > 0, rt.records.map((e) => e.kind).join(","));
		check(`${tag} it recorded no turnStart or turnEnd: the host records those`, !rt.submitted.some((e) => !["response", "toolResult"].includes(e.kind) && !e.kind.includes(".")), rt.records.map((e) => e.kind).join(","));
		check(`${tag} turn.end was its last request`, rt.order.at(-1) === "hook:turn.end", rt.order.slice(-4).join(","));
		if (steering) check(`${tag} Runtime callbacks: final steering check at the end boundary`, rt.finalChecks.some((i) => i > rt.order.lastIndexOf("hook:step.after") && i < rt.order.indexOf("hook:turn.end")));
		else console.log(`SKIP  ${tag} final steering check (steering not advertised)`);
		check(`${tag} host/runtime/report is only ever a notification`, !q.hostCalls.some((c) => c.method === "host/runtime/report"));

		rt = q.state.rt = runScenario({ retry: true, model: (_r, n) => (n === 0 ? { role: "assistant", content: [], stop: "failed", error: { kind: "temporary", message: "kit says try again" }, usage: usage0 } : say("retried")) });
		o = await q.request("runtime/runTurn", { turn: turn() });
		check(`${tag} a retried model request completes the turn`, o.outcome?.kind === "completed" && o.result?.text === "retried", JSON.stringify(o.outcome));
		// Plugin binding: Runtime callbacks. Each answered attempt has a separate committed response.
		const retrySteps = rt.records.filter((e) => e.kind === "modelRequest").map((e) => e.stepId);
		check(`${tag} retry uses a fresh step ID and pairs both attempts with responses`, retrySteps.length === 2 && retrySteps[0] !== retrySteps[1] && equal(rt.records.filter((e) => e.kind === "response").map((e) => e.stepId), retrySteps));

		// Plugin binding: Model attempt sequences (failed attempt, context overflow).
		check(`${tag} Model attempt sequences: failed response precedes model.failed and step.after precedes retry`,
			rt.order.indexOf(callback("record")) >= 0 && rt.order.indexOf(callback("record")) < rt.order.indexOf("hook:model.failed") &&
			ordered(rt.order, [callback("model"), "hook:step.after", callback("model")]));
		rt = q.state.rt = runScenario({ retry: true, compact: true, model: (_req, n) => n === 0
			? { role: "assistant", content: [], stop: "failed", error: { kind: "contextTooLarge", message: "fixture overflow" }, usage: usage0 }
			: say("after compaction") });
		o = await q.request("runtime/runTurn", { turn: turn() });
		const intents = rt.records.filter((e) => e.kind === "modelRequest");
		check(`${tag} Model attempt sequences: context overflow requests fresh preparation after a retry without replacement`,
			o.outcome?.kind === "completed" && rt.steps === 2 && rt.modelCalls === 2 &&
			new Set(intents.map((e) => e.stepId)).size === 3 && intents[1]?.stepId === rt.auxiliary &&
			rt.records.indexOf(rt.summary) < rt.records.indexOf(intents[2]) &&
			ordered(rt.order, [callback("model"), callback("record"), "hook:model.failed", callback("prepareStep"), callback("model")]) &&
			ordered(rt.order, [callback("model"), "hook:step.after", callback("prepareStep")]));
		const aux = rt.records.find((e) => e.kind === "response" && e.stepId === rt.auxiliary);
		check(`${tag} Hook execution / Runtime callbacks: auxiliary attempt carries usage but no step.after or Runtime usage`,
			intents[1]?.data.auxiliary === true && equal(aux?.message.usage, auxiliaryUsage) &&
			equal(rt.afterSteps, [intents[0]?.stepId, intents[2]?.stepId]) && equal(rt.preparedUsage, [zeroUsage, usage0]) &&
			equal(o.usage, { ...usage0, input: 2, output: 2 }));

		for (const phase of ["prepareStep", "model", "postIntent"]) {
			rt = q.state.rt = runScenario({ refuseAt: phase, model: () => callTools(["read", { path: "a" }]) });
			o = await q.request("runtime/runTurn", { turn: turn() }).catch((e) => ({ error: e }));
			const limit = { kind: "limit", limit: "sessionTokens" };
			check(`${tag} Runtime callbacks: turn_limit from ${phase} ends the turn without a Runtime response to the undispatched attempt`,
				!!rt.denied && rt.modelCalls === 1 && equal(o.outcome, limit) && (rt.endOutcome === undefined || equal(rt.endOutcome, limit)) &&
				rt.records.filter((e) => e.kind === "response").length === (phase === "postIntent" ? 2 : 1) && !rt.submitted.some((e) => e.kind === "response" && e.stepId === rt.denied), JSON.stringify(o));
		}

		rt = q.state.rt = runScenario({ model: (_r, n) => (n === 0 ? callTools(["read", { path: "a" }]) : say("after the tool")) });
		o = await q.request("runtime/runTurn", { turn: turn() });
		const call = rt.toolCalls[0];
		// Plugin binding: Runtime callbacks and Runtime records and effects.
		const calls = q.hostCalls.filter((c) => c.params?.call?.id === call?.id || c.params?.payload?.call?.id === call?.id);
		check(`${tag} a tool round: the call ran through runToolCall`, rt.toolCalls.length === 1 && call?.name === "read", JSON.stringify(rt.toolCalls));
		check(`${tag} tool.before allowed this exact call before dispatch`, calls[0]?.method === "host/runtime/hook" && calls[0]?.params.hook === "tool.before" && equal(calls[0].params.payload.call.input, call?.input) && calls[1]?.method === "host/runtime/runToolCall");
		check(`${tag} exactly one recorded result for the call`, !!call && resultFor(rt, call.id).length === 1, String(JSON.stringify(recordedResults(rt))).slice(0, 200));
		check(`${tag} the turn completed after the tool`, o.outcome?.kind === "completed" && o.result?.text === "after the tool", JSON.stringify(o.outcome));

		rt = q.state.rt = runScenario({ model: (_r, n) => (n === 0 ? callTools(["bash", { command: "echo denied" }]) : say("refused, fine")), gate: () => "kit refuses" });
		o = await q.request("runtime/runTurn", { turn: turn() });
		check(`${tag} a refused call never dispatches`, rt.toolCalls.length === 0, JSON.stringify(rt.toolCalls));
		check(`${tag} a refused call still gets one result, refused`, recordedResults(rt).length === 1 && statusOf(recordedResults(rt)[0]) === "refused", String(JSON.stringify(recordedResults(rt))).slice(0, 200));

		rt = q.state.rt = runScenario({ model: () => callTools(["read", { path: "again" }]) });
		o = await q.request("runtime/runTurn", { turn: turn({ settings: { maxSteps: 2 } }) });
		check(`${tag} a step limit ends the turn as limit steps`, o.outcome?.kind === "limit" && o.outcome.limit === "steps", JSON.stringify(o.outcome));

		const par = { name: "par", description: "parallel", parameters: { type: "object", properties: {} }, parallel: true };
		const startedPar = new Set();
		let release;
		const both = new Promise((r) => (release = r));
		let sawSecondFirst = false;
		rt = q.state.rt = runScenario({
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
				return { callId: c.id, status: "completed", content: [{ type: "text", text: `n=${c.input.n}` }] };
			},
		});
		o = await q.request("runtime/runTurn", { turn: turn() });
		// Contracts: Tool dispatch. parallel is permission, not a promise of overlap.
		check(`${tag} both parallel-capable calls settle once`, startedPar.size === 2 && recordedResults(rt).length === 2 && recordedResults(rt).every((e) => statusOf(e) === "completed"));

		rt = q.state.rt = runScenario({ model: (_r, n) => (n === 0 ? callTools(["bash", { command: "sleep 30" }]) : say("should not be reached")), tool: () => new Promise(() => {}) });
		const running = q.request("runtime/runTurn", { turn: turn() }, 20000);
		for (let i = 0; i < 100 && rt.toolCalls.length === 0; i++) await sleep(50);
		const t0 = Date.now();
		q.cancel(running.id);
		o = await running.catch((e) => ({ error: e }));
		check(`${tag} cancelling a turn answers within 5 s`, Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
		check(`${tag} a cancelled turn's outcome is cancelled, when cancellation wins during dispatch`, o.outcome?.kind === "cancelled", String(JSON.stringify(o)).slice(0, 200));
		check(`${tag} the cancelled call still gets exactly one result`, !!rt.toolCalls[0] && resultFor(rt, rt.toolCalls[0].id).length === 1, String(JSON.stringify(recordedResults(rt))).slice(0, 200));

		q.state.rt = undefined;
		await q.request("plugin/shutdown", { reason: "stop" }).catch(() => undefined);
		await q.stop();

		// Shared data: Context and interrupted work. Synthetic history uses only standard kinds.
		// One call never started; one started and is not safe to repeat; one started and is.
		const notStarted = { stepId: "kit-step-1", id: "c-not-started", name: "read", input: { path: "b" }, started: false, safeToRepeat: false };
		const startedCall = { stepId: "kit-step-1", id: "c-started", name: "bash", input: { command: "echo once" }, started: true, safeToRepeat: false };
		const safeCall = { stepId: "kit-step-1", id: "c-safe", name: "read", input: { path: "c" }, started: true, safeToRepeat: true };
		const t0e = Date.now() - 5000;
		const entry = (kind, extra) => ({ id: `other-${kind}-${randomUUID()}`, parentId: null, sessionId: "kit-session", kind, time: t0e, writer: "another-build", modelVisible: false, turnId: "kit-turn", ...extra });
		const toolCall = (c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.input });
		const rights = ["watch", "input", "tools"];
		const authorizers = [{ sessionId: "kit-session", actorId: "kit" }];
		const source = [{ type: "text", text: "do three things" }];
		const recoveryTools = [
			{ name: "read", description: "fixture read", parameters: true, hints: { safeToRepeat: true, openWorld: false } },
			{ name: "bash", description: "fixture shell", parameters: true },
		];
		const before = [
			entry("actorJoined", { turnId: undefined, data: { actor: { id: "kit", kind: "host", rights }, operatorAdmission: true } }),
			entry("inputAccepted", { turnId: undefined, actorId: "kit", inputId: "kit-input", data: { content: source, when: "now", rights, authorizers } }),
			entry("turnStart", { data: { startedBy: { kind: "actor", id: "kit" }, model: { provider: "kit", id: "scripted" }, system: "kit", tools: ["read", "bash"].map((name) => ({ name, description: name, parameters: true })), settings: { maxSteps: 8 }, rights, authorizers } }),
			entry("input", { modelVisible: true, actorId: "kit", message: { role: "user", content: [{ type: "text", text: "do three things" }] }, inputId: "kit-input" }),
			entry("modelRequest", { stepId: "kit-step-1", data: { model: { provider: "kit", id: "scripted" }, safeToRepeat: false, tracksStepAfter: true, tools: recoveryTools.map((t) => t.name) } }),
			entry("response", { modelVisible: true, stepId: "kit-step-1", message: { role: "assistant", content: [notStarted, startedCall, safeCall].map(toolCall), stop: "toolUse", usage: usage0 } }),
			entry("toolStarted", { toolCallId: "c-started", stepId: "kit-step-1", actorId: "kit", data: { call: { id: startedCall.id, name: startedCall.name, input: startedCall.input, actorId: "kit", startedBy: "model" }, source: fixtureSource, definition: recoveryTools[1], openWorld: true, safeToRepeat: false, rights, authorizers } }),
			entry("toolStarted", { toolCallId: "c-safe", stepId: "kit-step-1", actorId: "kit", data: { call: { id: safeCall.id, name: safeCall.name, input: safeCall.input, actorId: "kit", startedBy: "model" }, source: fixtureSource, definition: recoveryTools[0], openWorld: false, safeToRepeat: true, rights, authorizers } }),
		];
		for (let i = 1; i < before.length; i++) before[i].parentId = before[i - 1].id;
		before[4].sources = [before[3].id];
		before[5].sources = [before[4].id];
		const fresh = start({ MODULAR_AGENT_PLUGIN_PARTS: part });
		try {
			await fresh.request("plugin/initialize", initParams);
			rt = fresh.state.rt = runScenario({ model: () => say("carried on"), definitions: Object.fromEntries(recoveryTools.map((d) => [d.name, d])), before, abandoned: durable ? [startedCall] : [notStarted, startedCall, safeCall] });
			o = await fresh.request("runtime/resumeTurn", { turn: turn(), interrupted: { turnId: "kit-turn", calls: durable ? [notStarted, safeCall] : [], lastStep: { stepId: "kit-step-1" } } });
		} finally {
			fresh.state.rt = undefined;
			await fresh.request("plugin/shutdown", { reason: "stop" }).catch(() => undefined);
			await fresh.stop();
		}
		const settled = durable ? [startedCall] : [notStarted, startedCall, safeCall];
		check(`${tag} The host asks the Runtime: no result is submitted again for a call already settled by the host`,
			!rt.submitted.some((e) => e.kind === "toolResult" && settled.some((c) => c.id === e.toolCallId)));
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
			check("runtime: transient resume dispatches no calls and leaves notStarted or outcomeUnknown", rt.toolCalls.length === 0 && statusOf(resultFor(rt, notStarted.id)[0]) === "notStarted" && statusOf(resultFor(rt, safeCall.id)[0]) === "outcomeUnknown");
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
	// Plugin binding: Starting: the handshake. Observe EOF exit before forced cleanup.
	p.child.stdin.end();
	const ex = await Promise.race([p.exited, sleep(5000).then(() => null)]);
	check("the plugin exits after shutdown and EOF without forced cleanup", ex !== null && ex.signal === null);
	if (!ex) p.child.kill("SIGKILL");
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
