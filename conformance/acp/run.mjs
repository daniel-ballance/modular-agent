#!/usr/bin/env node
// Conformance kit for the ACP host binding, modular-agent-acp/1 (docs/bindings/acp.md).
// Usage: node run.mjs [--verbose] -- <agent command> [args...]
// The agent is started in conformance mode, with a fresh data folder and project, and driven with the
// official ACP client library. It needs no network and no model. Exit code 0 means every check passed.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk";

const argv = process.argv.slice(2);
const verbose = argv.includes("--verbose");
const dash = argv.indexOf("--");
if (dash < 0 || dash === argv.length - 1) {
	console.error("Usage: node run.mjs [--verbose] -- <agent command> [args...]");
	process.exit(2);
}
const command = argv.slice(dash + 1);
const NS = "modular-agent";
const REQUIRED_EXTENSIONS = ["history", "input", "requests", "answer"];
const BOOLEAN_KEYS = ["inputDuringTurn", "waitingThroughRestart", "continuesAfterRestart", "rewinding", "forking", "keepsStateAtProvider", "runsToolsAtProvider", "liveSessions", "severalActors", "holdsOutput", "outputBypassesAgent", "cancellingTurnCancelsJobs", "pluginsDuringSession", "erasure", "inputKeys", "questionsOutlastTurns"];
const ENUM_KEYS = {
	startsTurnsUnasked: ["never", "jobReports"],
	queuedInputAfterRestart: ["handedBack", "run"],
	movingWithUnfinishedWork: ["cancels", "refused"],
	mixedActorInput: ["shared", "refused"],
	settingsDuringTurn: ["nextTurn", "refused"],
	erasureDuringTurn: ["allowed", "refused"],
	commandContainment: ["strong", "processGroup", "none"],
};

const dataDir = mkdtempSync(join(tmpdir(), "ma-conf-data-"));
const project = mkdtempSync(join(tmpdir(), "ma-conf-project-"));
const results = [];
const children = [];

function check(name, ok, detail = "") {
	results.push({ name, ok: !!ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : verbose && detail ? `  (${detail})` : ""}`);
	return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function within(ms, promise, what) {
	let timer;
	return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${what}`)), ms)))]).finally(() => clearTimeout(timer));
}
async function attempt(name, fn) {
	try {
		await fn();
	} catch (error) {
		check(name, false, error instanceof Error ? error.message : String(error));
	}
}

/** Start the agent and connect the official client. */
function connect() {
	const child = spawn(command[0], command.slice(1), {
		cwd: project,
		stdio: ["pipe", "pipe", verbose ? "inherit" : "ignore"],
		env: { ...process.env, MODULAR_AGENT_CONFORMANCE: "1", MODULAR_AGENT_DATA_DIR: dataDir },
	});
	children.push(child);
	const updates = [];
	const permissions = [];
	const state = { permissionAnswer: "allow" };
	const app = client({ name: "modular-agent-conformance" })
		.onNotification(methods.client.session.update, ({ params }) => {
			updates.push(params);
		})
		.onRequest(methods.client.session.requestPermission, async ({ params }) => {
			permissions.push(params);
			return { outcome: { outcome: "selected", optionId: state.permissionAnswer } };
		});
	const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
	return { child, ctx: connection.agent, updates, permissions, state };
}
async function stop(agent) {
	agent.child.stdin.end();
	const exited = new Promise((r) => agent.child.once("exit", r));
	await Promise.race([exited, sleep(3000)]);
	if (agent.child.exitCode === null && agent.child.signalCode === null) {
		agent.child.kill("SIGTERM");
		await Promise.race([exited, sleep(2000)]);
		if (agent.child.exitCode === null && agent.child.signalCode === null) agent.child.kill("SIGKILL");
	}
}
const meta = (x) => x?._meta?.[NS];
const textOf = (updates, sessionId, kind = "agent_message_chunk") => updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === kind).map((u) => u.update.content?.text ?? "").join("");
async function prompt(agent, sessionId, text, key) {
	return agent.ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }], ...(key ? { _meta: { [NS]: { key } } } : {}) });
}
async function setOption(agent, sessionId, configId, value) {
	return agent.ctx.request(methods.agent.session.setConfigOption, { sessionId, configId, value });
}
async function history(agent, sessionId, params = {}) {
	return agent.ctx.request(`_${NS}/history`, { sessionId, ...params });
}

let sessionId;
let agent = connect();

await attempt("initialize", async () => {
	const init = await within(15000, agent.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} }), "initialize");
	check("initialize: protocol version 1", init.protocolVersion === 1, `got ${init.protocolVersion}`);
	const m = meta(init);
	check("initialize: _meta binding is modular-agent-acp/1", m?.binding === "modular-agent-acp/1", JSON.stringify(m?.binding));
	const d = m?.declaration ?? {};
	const missingBool = BOOLEAN_KEYS.filter((k) => typeof d[k] !== "boolean");
	check("declaration: every boolean key", missingBool.length === 0, `missing or not boolean: ${missingBool.join(", ")}`);
	const badEnum = Object.entries(ENUM_KEYS).filter(([k, values]) => !values.includes(d[k])).map(([k]) => `${k}=${JSON.stringify(d[k])}`);
	check("declaration: every declared-choice key", badEnum.length === 0, badEnum.join(", "));
	const ext = m?.extensions ?? [];
	check("initialize: required extensions listed", REQUIRED_EXTENSIONS.every((e) => ext.includes(e)), JSON.stringify(ext));
	check("initialize: actor is a host", m?.actor?.kind === "host" && typeof m?.actor?.id === "string", JSON.stringify(m?.actor));
});

await attempt("session/new", async () => {
	const s = await within(15000, agent.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [] }), "session/new");
	sessionId = s.sessionId;
	check("session/new: a session id", typeof sessionId === "string" && sessionId.length > 0);
	const ids = (s.configOptions ?? []).map((o) => o.id);
	check("session/new: model, thinking and approval options", ["model", "thinking", "approval"].every((i) => ids.includes(i)), ids.join(", "));
	const model = (s.configOptions ?? []).find((o) => o.id === "model");
	const values = (model?.options ?? []).flatMap((o) => (o.options ? o.options.map((x) => x.value) : [o.value]));
	check("session/new: conformance/echo is offered", values.includes("conformance/echo"), values.slice(0, 8).join(", "));
	const approval = (s.configOptions ?? []).find((o) => o.id === "approval");
	const av = (approval?.options ?? []).map((o) => o.value);
	check("session/new: approval values off, ask, all, never", ["off", "ask", "all", "never"].every((v) => av.includes(v)), av.join(", "));
	check("session/new: session declaration in _meta", typeof meta(s)?.declaration === "object");
	await setOption(agent, sessionId, "model", "conformance/echo");
	await setOption(agent, sessionId, "approval", "off");
});

let firstInputId;
await attempt("prompt", async () => {
	const r = await within(15000, prompt(agent, sessionId, "hello", "key-1"), "prompt hello");
	check("prompt: end_turn", r.stopReason === "end_turn", r.stopReason);
	await sleep(100);
	check("prompt: streams the echo", textOf(agent.updates, sessionId).includes("echo: hello"), JSON.stringify(textOf(agent.updates, sessionId)).slice(0, 120));
	firstInputId = meta(r)?.inputId;
	check("prompt: _meta inputId", typeof firstInputId === "string", JSON.stringify(meta(r)));
	check("prompt: _meta outcome completed", meta(r)?.outcome?.kind === "completed", JSON.stringify(meta(r)?.outcome));
});

await attempt("keyed prompt", async () => {
	const before = (await history(agent, sessionId)).entries.length;
	const chunks = agent.updates.length;
	const r = await within(15000, prompt(agent, sessionId, "hello", "key-1"), "resent prompt");
	await sleep(200);
	check("keyed prompt: duplicate is reported", meta(r)?.duplicate === true, JSON.stringify(meta(r)));
	check("keyed prompt: same input id", meta(r)?.inputId === firstInputId, `${meta(r)?.inputId} vs ${firstInputId}`);
	const after = (await history(agent, sessionId)).entries.length;
	check("keyed prompt: no new entries", after === before, `${before} -> ${after}`);
	check("keyed prompt: no new message", !agent.updates.slice(chunks).some((u) => u.update.sessionUpdate === "agent_message_chunk"));
});

let lastEntryId;
await attempt("history extension", async () => {
	const { entries } = await history(agent, sessionId);
	const kinds = new Set(entries.map((e) => e.kind));
	check("history: input, response, turnStart and turnEnd entries", ["input", "response", "turnStart", "turnEnd"].every((k) => kinds.has(k)), [...kinds].join(", "));
	const end = entries.filter((e) => e.kind === "turnEnd").at(-1);
	check("history: turnEnd carries its outcome", end?.data?.outcome?.kind === "completed", JSON.stringify(end?.data?.outcome));
	check("history: entries have id and parentId", entries.every((e) => typeof e.id === "string" && "parentId" in e));
	lastEntryId = entries.at(-1)?.id;
	const after = await history(agent, sessionId, { after: lastEntryId });
	check("history: after the last entry is empty", after.entries.length === 0, `${after.entries.length} entries`);
	let refused = false;
	try {
		await history(agent, sessionId, { after: "no-such-entry" });
	} catch (error) {
		refused = error?.code === -32602;
	}
	check("history: an unknown entry is refused with -32602", refused);
});

await attempt("approval", async () => {
	await setOption(agent, sessionId, "approval", "ask");
	agent.state.permissionAnswer = "refuse";
	const n = agent.permissions.length;
	const r1 = await within(15000, prompt(agent, sessionId, 'tool:bash {"command":"echo yes > refused.txt"}'), "refused tool prompt");
	check("approval: a permission request was made", agent.permissions.length === n + 1);
	const options = agent.permissions.at(-1)?.options ?? [];
	check("approval: exactly allow/allow_once and refuse/reject_once", options.length === 2 && options.some((o) => o.optionId === "allow" && o.kind === "allow_once") && options.some((o) => o.optionId === "refuse" && o.kind === "reject_once"), JSON.stringify(options));
	check("approval: refused call did not run", !existsSync(join(project, "refused.txt")));
	check("approval: the turn still ends", r1.stopReason === "end_turn", r1.stopReason);
	agent.state.permissionAnswer = "allow";
	const r2 = await within(15000, prompt(agent, sessionId, 'tool:bash {"command":"echo yes > allowed.txt"}'), "allowed tool prompt");
	check("approval: allowed call ran", existsSync(join(project, "allowed.txt")) && readFileSync(join(project, "allowed.txt"), "utf8").trim() === "yes");
	check("approval: allowed turn ends", r2.stopReason === "end_turn", r2.stopReason);
	const calls = agent.updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "tool_call");
	check("updates: tool_call with title bash", calls.some((u) => u.update.title === "bash"), calls.map((u) => u.update.title).join(","));
	await setOption(agent, sessionId, "approval", "off");
});

await attempt("cancel", async () => {
	const started = (async () => {
		for (let i = 0; i < 100; i++) {
			if (agent.updates.some((u) => u.sessionId === sessionId && u.update.sessionUpdate === "tool_call" && JSON.stringify(u.update.rawInput ?? "").includes("sleep 30"))) return;
			await sleep(50);
		}
	})();
	const pending = prompt(agent, sessionId, 'tool:bash {"command":"sleep 30"}');
	await started;
	const t0 = Date.now();
	await agent.ctx.notify(methods.agent.session.cancel, { sessionId });
	const r = await within(10000, pending, "cancelled prompt");
	check("cancel: stopReason cancelled", r.stopReason === "cancelled", r.stopReason);
	check("cancel: within 5 seconds", Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
});

await attempt("input extension", async () => {
	const before = (await history(agent, sessionId)).entries.filter((e) => e.kind === "turnEnd").length;
	const a = await agent.ctx.request(`_${NS}/input`, { sessionId, content: "queued", when: "now", key: "key-2" });
	check("input: receipt", typeof a.inputId === "string" && ["now", "inTurn", "after"].includes(a.taken), JSON.stringify(a));
	const b = await agent.ctx.request(`_${NS}/input`, { sessionId, content: "queued", when: "now", key: "key-2" });
	check("input: resent key is a duplicate", b.duplicate === true && b.inputId === a.inputId, JSON.stringify(b));
	let ended = false;
	for (let i = 0; i < 100 && !ended; i++) {
		await sleep(50);
		const entries = (await history(agent, sessionId)).entries;
		ended = entries.filter((e) => e.kind === "turnEnd").length > before && entries.some((e) => e.kind === "response" && JSON.stringify(e.message ?? {}).includes("echo: queued"));
	}
	check("input: the input ran as one turn", ended);
});

await attempt("requests and answer", async () => {
	const r = await agent.ctx.request(`_${NS}/requests`, { sessionId });
	check("requests: an array", Array.isArray(r.requests), JSON.stringify(r).slice(0, 100));
	const a = await agent.ctx.request(`_${NS}/answer`, { sessionId, requestId: "no-such-request", value: "x" });
	check("answer: an unknown request is not accepted", a.accepted === false, JSON.stringify(a));
});

await attempt("unused session", async () => {
	const s = await agent.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
	await agent.ctx.request(methods.agent.session.close, { sessionId: s.sessionId });
	const l = await agent.ctx.request(methods.agent.session.list, { cwd: project });
	const ids = (l.sessions ?? []).map((x) => x.sessionId);
	check("unused session: not listed after close", !ids.includes(s.sessionId));
	check("session/list: the used session is listed", ids.includes(sessionId), ids.join(", "));
});

await attempt("load in a new process", async () => {
	await agent.ctx.request(methods.agent.session.close, { sessionId });
	await stop(agent);
	agent = connect();
	await agent.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
	await within(15000, agent.ctx.request(methods.agent.session.load, { sessionId, cwd: project, mcpServers: [] }), "session/load");
	const replayed = agent.updates.filter((u) => u.sessionId === sessionId);
	check("load: replays the session before answering", replayed.length > 0 && JSON.stringify(replayed).includes("echo: hello"), `${replayed.length} updates`);
	const { entries } = await history(agent, sessionId);
	check("load: history survives a restart", entries.some((e) => e.kind === "turnEnd"));
	const r = await within(15000, prompt(agent, sessionId, "hello", "key-1"), "resent prompt after restart");
	check("load: a key survives a restart", meta(r)?.duplicate === true, JSON.stringify(meta(r)));
	await agent.ctx.request(methods.agent.session.close, { sessionId });
});

await stop(agent);
for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
rmSync(dataDir, { recursive: true, force: true });
rmSync(project, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
