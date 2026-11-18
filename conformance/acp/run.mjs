#!/usr/bin/env node
// Conformance kit for the ACP host binding, modular-agent-acp/1 (docs/bindings/acp.md).
// Usage: node run.mjs [--verbose] [options] -- <agent command> [args...] [--then <second agent command> [args...]]
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
// With --plugin-checks, also check the conformance plugin's hooks are in force (docs/bindings/plugin.md).
const pluginChecks = argv.includes("--plugin-checks");
// With --crash-checks, also kill the agent with SIGKILL during a bash call, reopen the session in a new
// process, and check the turn ends as the agent declared: carried on (continuesAfterRestart) or failed.
const crashChecks = argv.includes("--crash-checks");
// With --probe-checks, also load the probe plugin (../plugin/probe.mjs), which checks the host side of the plugin binding.
const probeChecks = argv.includes("--probe-checks");
// With --job-checks, also load the jobs plugin (../plugin/jobs.mjs): jobs recorded in the standard kinds, reported,
// cancelled, and taken up after a kill -9 by whichever agent reopens the session (with --then, the second).
const jobChecks = argv.includes("--job-checks");
// With --portable-checks, also check every entry the agents kept in the history service is in the shared shapes
// (docs/bindings/data.md#portable-sessions). It needs MODULAR_AGENT_HISTORY_URL and MODULAR_AGENT_HISTORY_TOKEN_FILE.
const portableChecks = argv.includes("--portable-checks");
const dash = argv.indexOf("--");
if (dash < 0 || dash === argv.length - 1) {
	console.error("Usage: node run.mjs [--verbose] [--plugin-checks] [--crash-checks] [--probe-checks] [--job-checks] [--portable-checks] -- <agent command> [args...] [--then <second agent command> [args...]]");
	process.exit(2);
}
// With --then, every reopening in a new process uses the second agent: one agent writes a session and another,
// perhaps in another language, reopens, continues and recovers it. Both must use the same history service.
const rest = argv.slice(dash + 1);
const then = rest.indexOf("--then");
const command = then < 0 ? rest : rest.slice(0, then);
const second = then < 0 ? command : rest.slice(then + 1);
if (!command.length || !second.length) {
	console.error("--then needs a second agent command");
	process.exit(2);
}
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
const dataDir2 = second === command ? dataDir : mkdtempSync(join(tmpdir(), "ma-conf-data-"));
const probeDir = mkdtempSync(join(tmpdir(), "ma-conf-probe-"));
const probeOut = (role) => join(probeDir, `${role}.json`);
const pluginEnv = {};
{
	const extra = [];
	if (probeChecks) {
		const probe = new URL("../plugin/probe.mjs", import.meta.url).pathname;
		for (const role of ["probe", "refuse-hook", "refuse-replace", "refuse-duplicate", "output-observer"]) extra.push({ command: [process.execPath, probe], config: { role, out: probeOut(role) } });
	}
	if (jobChecks) extra.push({ command: [process.execPath, new URL("../plugin/jobs.mjs", import.meta.url).pathname], config: { out: probeOut("jobs") } });
	if (extra.length) {
		const given = process.env.MODULAR_AGENT_PLUGINS ? JSON.parse(process.env.MODULAR_AGENT_PLUGINS) : [];
		pluginEnv.MODULAR_AGENT_PLUGINS = JSON.stringify([...given, ...extra]);
	}
}
const sessionsUsed = [];
// Tenants every agent is started with, for the tenant checks (docs/bindings/data.md#limits-and-tenants).
const TENANTS = JSON.stringify({ "kit-readonly": { rights: ["watch", "input", "answer", "settings"] }, "kit-broke": { rights: ["watch", "input", "answer", "approve", "tools", "cancel", "settings", "erase", "grant", "administer"], tokens: 0 } });
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
function connect(which = command) {
	const child = spawn(which[0], which.slice(1), {
		cwd: project,
		stdio: ["pipe", "pipe", verbose ? "inherit" : "ignore"],
		env: { ...process.env, ...pluginEnv, MODULAR_AGENT_TENANTS: TENANTS, MODULAR_AGENT_CONFORMANCE: "1", MODULAR_AGENT_DATA_DIR: which === command ? dataDir : dataDir2 },
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

/** Wait until fn(entries) is true, reading the full history; returns the entries. */
async function waitFor(a, sid, fn, ms = 15000) {
	let entries = [];
	for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(150)) {
		entries = (await history(a, sid, { all: true })).entries;
		if (fn(entries)) break;
	}
	return entries;
}
const said = (entries, text) => entries.some((e) => e.kind === "response" && JSON.stringify(e.message ?? {}).includes(text));

let sessionId;
let erasedForPortable;
let decl = {};
let extensions = [];
let agent = connect();

await attempt("initialize", async () => {
	const init = await within(15000, agent.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} }), "initialize");
	check("initialize: protocol version 1", init.protocolVersion === 1, `got ${init.protocolVersion}`);
	const m = meta(init);
	check("initialize: _meta binding is modular-agent-acp/1", m?.binding === "modular-agent-acp/1", JSON.stringify(m?.binding));
	const d = m?.declaration ?? {};
	decl = d;
	extensions = m?.extensions ?? [];
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
	sessionsUsed.push(sessionId);
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
	check("prompt: streams the echo", textOf(agent.updates, sessionId).includes("echo: hello"), String(JSON.stringify(textOf(agent.updates, sessionId))).slice(0, 120));
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

if (pluginChecks) {
	await attempt("plugin hooks", async () => {
		const r = await within(15000, prompt(agent, sessionId, 'tool:bash {"command":"echo conformance-forbidden > forbidden.txt"}'), "forbidden prompt");
		check("plugin: the conformance plugin's gate refused the call", !existsSync(join(project, "forbidden.txt")));
		check("plugin: the turn still ends", r.stopReason === "end_turn", r.stopReason);
		const { entries } = await history(agent, sessionId);
		const refused = entries.filter((e) => e.kind === "toolResult").at(-1);
		check("plugin: the refusal reason reached the record", JSON.stringify(refused ?? {}).includes("refused by the conformance plugin"), String(JSON.stringify(refused?.message ?? refused)).slice(0, 160));
		// The conformance plugin's output gate, a stream at a time (docs/bindings/plugin.md, the output hook).
		const before = agent.updates.length;
		const g = await within(15000, prompt(agent, sessionId, "conformance-secret"), "secret prompt");
		const streamed = agent.updates.slice(before).filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk").map((u) => u.update.content?.text ?? "").join("");
		check("plugin: the output gate redacted the streamed reply", g.stopReason === "end_turn" && streamed.includes("[redacted]") && !streamed.includes("conformance-secret"), String(JSON.stringify(streamed)).slice(0, 160));
		const after = (await history(agent, sessionId)).entries.filter((e) => e.kind === "response").at(-1);
		check("plugin: the history extension passes the gate too", JSON.stringify(after ?? {}).includes("[redacted]") && !JSON.stringify(after ?? {}).includes("conformance-secret"), String(JSON.stringify(after?.message ?? after)).slice(0, 160));
	});
}

await attempt("failed turn", async () => {
	const r = await within(15000, prompt(agent, sessionId, "fail:the kit asked for it"), "failing prompt");
	check("failed turn: /1 reports refusal", r.stopReason === "refusal", r.stopReason);
	check("failed turn: /1 _meta outcome failed, with the reason", meta(r)?.outcome?.kind === "failed" && String(meta(r)?.outcome?.error ?? "").includes("the kit asked for it"), JSON.stringify(meta(r)?.outcome));
	const two = connect();
	try {
		const init = await within(15000, two.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {}, _meta: { [NS]: { binding: "modular-agent-acp/2" } } }), "initialize /2");
		check("/2: the agent speaks modular-agent-acp/2 when asked", meta(init)?.binding === "modular-agent-acp/2", JSON.stringify(meta(init)?.binding));
		const s2 = await two.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
		await setOption(two, s2.sessionId, "model", "conformance/echo");
		let err;
		try {
			await within(15000, prompt(two, s2.sessionId, "fail:the kit asked again"), "failing prompt /2");
		} catch (e) {
			err = e;
		}
		check("/2: a failed turn is a JSON-RPC error -32000", err?.code === -32000, String(JSON.stringify(err)).slice(0, 200));
		check("/2: its data carries _meta with outcome failed", err?.data?._meta?.[NS]?.outcome?.kind === "failed", String(JSON.stringify(err?.data)).slice(0, 200));
		const ok = await within(15000, prompt(two, s2.sessionId, "hello again"), "prompt /2");
		check("/2: a completed turn is end_turn, as in /1", ok.stopReason === "end_turn", ok.stopReason);
		await two.ctx.request(methods.agent.session.close, { sessionId: s2.sessionId });
	} finally {
		await stop(two);
	}
});

if (decl.severalActors) {
	await attempt("several actors", async () => {
		const ask = (name, params) => agent.ctx.request(`_${NS}/${name}`, { sessionId, ...params });
		const refused = async (p) => {
			try {
				await p;
				return false;
			} catch (e) {
				return e?.code === -32602;
			}
		};
		check("actors: the several-actors extensions are listed", ["actors", "join", "leave", "release"].every((x) => extensions.includes(x)), JSON.stringify(extensions));
		const a0 = await ask("actors", {});
		check("actors: lists the connection's actor", (a0.actors ?? []).some((a) => a.kind === "host"), String(JSON.stringify(a0)).slice(0, 200));
		check("join: a right the granter lacks is refused", await refused(ask("join", { actor: { id: "kit-greedy", kind: "user", rights: ["watch", "kit-unknown-right"] } })));
		await ask("join", { actor: { id: "kit-viewer", kind: "user", rights: ["watch"] } });
		await ask("join", { actor: { id: "kit-guest", kind: "user", rights: ["watch", "propose"] } });
		const a1 = await ask("actors", {});
		check("join: both actors are listed with their rights", (a1.actors ?? []).some((a) => a.id === "kit-viewer" && a.rights?.length === 1) && (a1.actors ?? []).some((a) => a.id === "kit-guest"), String(JSON.stringify(a1.actors)).slice(0, 300));
		check("input: an actor without input is refused", await refused(ask("input", { actorId: "kit-viewer", content: "viewer input", when: "now" })));
		const turns = (await history(agent, sessionId)).entries.filter((e) => e.kind === "turnEnd").length;
		const prop = await ask("input", { actorId: "kit-guest", content: "proposed by the guest", when: "propose" });
		check("propose: proposed input waits", prop.taken === "proposed" && typeof prop.inputId === "string", JSON.stringify(prop));
		await sleep(500);
		check("propose: nothing runs before a release", (await history(agent, sessionId)).entries.filter((e) => e.kind === "turnEnd").length === turns);
		const rel = await ask("release", { inputId: prop.inputId, when: "now" });
		check("release: the input is taken", ["now", "inTurn", "after"].includes(rel.taken), JSON.stringify(rel));
		let ran = false;
		for (let i = 0; i < 100 && !ran; i++) {
			await sleep(100);
			const es = (await history(agent, sessionId)).entries;
			// The released input's turn has replied and ended.
			ran = said(es, "echo: proposed by the guest") && es.filter((e) => e.kind === "turnEnd").length > turns;
		}
		check("release: the released input ran as a turn", ran);
		check("proposals: the proposals extensions are listed", ["proposals", "withdraw"].every((x) => extensions.includes(x)), JSON.stringify(extensions));
		const p2 = await ask("input", { actorId: "kit-guest", content: "a second proposal", when: "propose" });
		const listed = (await ask("proposals", {})).proposals ?? [];
		check("proposals: a proposal is listed with its proposer", listed.some((x) => x.inputId === p2.inputId && x.actorId === "kit-guest") && !listed.some((x) => x.inputId === prop.inputId), String(JSON.stringify(listed)).slice(0, 200));
		await ask("withdraw", { inputId: p2.inputId, actorId: "kit-guest" });
		await sleep(400);
		const after = (await ask("proposals", {})).proposals ?? [];
		const es2 = (await history(agent, sessionId)).entries;
		check("withdraw: the proposal is gone, handed back, and never ran", !after.some((x) => x.inputId === p2.inputId) && es2.some((e) => e.kind === "inputHandedBack" && (e.data?.inputIds ?? []).includes(p2.inputId)) && !said(es2, "echo: a second proposal"), String(JSON.stringify(after)).slice(0, 200));
		await ask("join", { actor: { id: "kit-guest", kind: "user", rights: ["watch"] } });
		check("join again: taking a right away holds", await refused(ask("input", { actorId: "kit-guest", content: "no longer allowed", when: "propose" })));
		await ask("leave", { actorId: "kit-viewer" });
		const a2 = await ask("actors", {});
		check("leave: the actor is gone", !(a2.actors ?? []).some((a) => a.id === "kit-viewer"), String(JSON.stringify(a2.actors)).slice(0, 200));
		const kinds = (await history(agent, sessionId)).entries.map((e) => e.kind);
		check("actors: recorded as actorJoined and actorLeft", kinds.includes("actorJoined") && kinds.includes("actorLeft"), [...new Set(kinds)].join(","));
	});
}

if (decl.rewinding) {
	await attempt("rewinding", async () => {
		const file = join(project, "rewind.txt");
		await within(15000, prompt(agent, sessionId, 'tool:bash {"command":"echo one > rewind.txt"}'), "rewind one");
		const mark = (await history(agent, sessionId)).entries.at(-1)?.id;
		await within(15000, prompt(agent, sessionId, 'tool:bash {"command":"echo two > rewind.txt"}'), "rewind two");
		check("rewinding: the second turn changed the file", readFileSync(file, "utf8").trim() === "two");
		await agent.ctx.request(`_${NS}/move`, { sessionId, entryId: mark, rewind: true });
		check("rewinding: move with rewind restores the file", existsSync(file) && readFileSync(file, "utf8").trim() === "one", existsSync(file) ? readFileSync(file, "utf8") : "missing");
		const branch = (await history(agent, sessionId)).entries;
		check("rewinding: the branch ends at the entry moved to", branch.at(-1)?.id === mark, `${branch.at(-1)?.kind}`);
		const r = await within(15000, prompt(agent, sessionId, "after the rewind"), "prompt after rewind");
		check("rewinding: the session carries on", r.stopReason === "end_turn", r.stopReason);
	});
}

if (decl.sessionLimits) {
	await attempt("session limits", async () => {
		const lim = (rights) => agent.ctx.request(`_${NS}/limit`, { sessionId, rights });
		check("limits: the limit extension is listed", extensions.includes("limit"), JSON.stringify(extensions));
		let refused = false;
		try {
			await lim(["watch", "kit-unknown-right"]);
		} catch (e) {
			refused = e?.code === -32602;
		}
		check("limits: a limit with a right the administrator lacks is refused", refused);
		await lim(["watch", "input", "answer", "approve", "settings", "erase", "grant", "administer", "cancel", "propose"]);
		const r = await within(15000, prompt(agent, sessionId, 'tool:bash {"command":"echo yes > limited.txt"}'), "limited prompt");
		check("limits: a tool call is refused under a limit without tools", r.stopReason === "end_turn" && !existsSync(join(project, "limited.txt")), r.stopReason);
		await lim(null);
		await within(15000, prompt(agent, sessionId, 'tool:bash {"command":"echo yes > unlimited.txt"}'), "unlimited prompt");
		check("limits: with the limit removed, the call runs", existsSync(join(project, "unlimited.txt")));
		const es = (await history(agent, sessionId)).entries.filter((e) => e.kind === "limit");
		check("limits: recorded as limit entries", es.length >= 2 && es.at(-1).data?.rights === null, String(JSON.stringify(es.map((e) => e.data))).slice(0, 200));
	});
}

if (decl.tenants) {
	await attempt("tenants", async () => {
		const open = async (tenant) => {
			const s2 = await agent.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [], _meta: { [NS]: { tenant } } });
			await setOption(agent, s2.sessionId, "model", "conformance/echo");
			await setOption(agent, s2.sessionId, "approval", "off");
			return s2.sessionId;
		};
		check("tenants: the tenant extension is listed", extensions.includes("tenant"), JSON.stringify(extensions));
		let refused = false;
		try {
			await agent.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [], _meta: { [NS]: { tenant: "kit-no-such-tenant" } } });
		} catch (e) {
			refused = e?.code === -32602;
		}
		check("tenants: an unknown tenant is refused", refused);
		const ro = await open("kit-readonly");
		const info = await agent.ctx.request(`_${NS}/tenant`, { sessionId: ro });
		check("tenants: the session reports its tenant", info.tenant === "kit-readonly" && Array.isArray(info.rights) && !info.rights.includes("tools"), JSON.stringify(info));
		const first = (await history(agent, ro, { all: true })).entries;
		check("tenants: a tenant entry is the session's first", first[0]?.kind === "tenant" && first[0]?.data?.tenant === "kit-readonly", String(JSON.stringify(first[0])).slice(0, 160));
		const r = await within(15000, prompt(agent, ro, 'tool:bash {"command":"echo yes > tenant.txt"}'), "tenant prompt");
		check("tenants: the tenant's ceiling refuses a tool call", r.stopReason === "end_turn" && !existsSync(join(project, "tenant.txt")), r.stopReason);
		const broke = await open("kit-broke");
		const b = await within(15000, prompt(agent, broke, "hello broke"), "budget prompt");
		check("tenants: an exhausted budget ends the turn as tenantTokens, max_tokens", b.stopReason === "max_tokens" && meta(b)?.outcome?.limit === "tenantTokens", `${b.stopReason} ${JSON.stringify(meta(b)?.outcome)}`);
		check("tenants: without a model request", !(await history(agent, broke, { all: true })).entries.some((e) => e.kind === "response" || e.kind === "modelRequest"));
		for (const id of [ro, broke]) await agent.ctx.request(methods.agent.session.close, { sessionId: id });
	});
}

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
	check("requests: an array", Array.isArray(r.requests), String(JSON.stringify(r)).slice(0, 100));
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

if (probeChecks) {
	await attempt("probe", async () => {
		const r = await within(30000, prompt(agent, sessionId, "tool:probe {}"), "probe prompt");
		check("probe: the turn ends", r.stopReason === "end_turn", r.stopReason);
		const checks = existsSync(probeOut("probe")) ? JSON.parse(readFileSync(probeOut("probe"), "utf8")) : [];
		check("probe: the probe ran", checks.length > 0, "no results; was the tool called?");
		for (const c of checks) check(`probe: ${c.name}`, c.ok, c.detail);
		for (const role of ["refuse-hook", "refuse-replace", "refuse-duplicate"]) {
			const lines = existsSync(probeOut(role)) ? readFileSync(probeOut(role), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
			const why = { "refuse-hook": "a handler for a hook point the host doesn't offer", "refuse-replace": "naming a replacement it doesn't register", "refuse-duplicate": "a second plugin with a name already loaded" }[role];
			check(`probe: ${why} gets plugin/shutdown, reason refused`, lines.some((l) => l.params?.reason === "refused"), JSON.stringify(lines));
		}
		const tools = agent.updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "tool_call").map((u) => u.update.title);
		check("probe: the refused plugins left nothing behind, and the host carried on", r.stopReason === "end_turn" && tools.includes("probe"), tools.join(","));
		// What the output gate was given, in the shared shapes (docs/bindings/data.md#output-events).
		const seen = existsSync(probeOut("output-observer")) ? readFileSync(probeOut("output-observer"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
		const events = seen.flatMap((x) => x?.events ?? []);
		check("output events: the gate was given events", events.length > 0, `${seen.length} payloads`);
		check("output events: every payload has sessionId, recipient, events and final", seen.every((x) => (typeof x?.sessionId === "string" || x?.sessionId === null) && typeof x?.recipient === "string" && Array.isArray(x?.events) && typeof x?.final === "boolean"), String(JSON.stringify(seen.find((x) => !(typeof x?.sessionId === "string" && Array.isArray(x?.events))))).slice(0, 200));
		const OUT = { text: (d) => typeof d?.delta === "string", reasoning: (d) => typeof d?.delta === "string", toolCall: (d) => typeof d?.call?.id === "string" && typeof d?.call?.name === "string", toolOutput: (d) => typeof d?.toolCallId === "string" && typeof d?.chunk === "string", toolResult: (d) => typeof d?.toolCallId === "string" && typeof d?.status === "string" && Array.isArray(d?.content), entry: (d) => typeof d?.entry?.id === "string", turnEnded: (d) => typeof d?.outcome?.kind === "string", reply: (d) => typeof d?.method === "string" };
		const bad = events.filter((e) => (OUT[e?.type] ? !OUT[e.type](e.data) : !String(e?.type ?? "").includes(".")));
		check("output events: every event is a standard type in its shape, or a build's own type with a dot", bad.length === 0, String(JSON.stringify(bad.slice(0, 2))).slice(0, 300));
		const types = new Set(events.map((e) => e?.type));
		check("output events: a turn with a tool call gives text, toolCall, toolResult and turnEnded", ["text", "toolCall", "toolResult", "turnEnded"].every((t) => types.has(t)), [...types].join(","));
	});
}

if (jobChecks) {
	await attempt("jobs", async () => {
		const r = await within(15000, prompt(agent, sessionId, 'tool:background {"text":"kit-job","ms":300}'), "background prompt");
		check("jobs: the turn that started the job ends", r.stopReason === "end_turn", r.stopReason);
		const entries = await waitFor(agent, sessionId, (es) => said(es, "echo: background: kit-job"));
		const started = entries.find((e) => e.kind === "jobStarted" && e.data?.kind === "background");
		const jobId = started?.jobId;
		check("jobs: jobStarted, by the plugin's name", !!jobId && started.writer === "conformance-jobs" && started.data?.detail?.text === "kit-job", String(JSON.stringify(started)).slice(0, 200));
		const ended = entries.filter((e) => e.kind === "jobEnded" && e.jobId === jobId);
		check("jobs: one jobEnded, completed and reported", ended.length === 1 && ended[0].data?.outcome?.kind === "completed" && ended[0].data?.report === true, String(JSON.stringify(ended)).slice(0, 200));
		const report = entries.find((e) => e.kind === "input" && e.data?.key === `job:${jobId}`);
		check("jobs: the report is input keyed job:<jobId>, after jobEnded", !!report && entries.indexOf(report) > entries.indexOf(ended[0]), JSON.stringify(report?.data));
		check("jobs: the report started a turn, startedBy the job", entries.some((e) => e.kind === "turnStart" && e.data?.startedBy?.kind === "job" && e.data?.startedBy?.id === jobId));
		check("jobs: the report reached the model", said(entries, "echo: background: kit-job"));
		if (extensions.includes("cancel-job")) {
			await within(15000, prompt(agent, sessionId, 'tool:background {"text":"kit-cancel","ms":600000}'), "long background prompt");
			const es = await waitFor(agent, sessionId, (x) => x.some((e) => e.kind === "jobStarted" && e.data?.detail?.text === "kit-cancel"));
			const id = es.find((e) => e.kind === "jobStarted" && e.data?.detail?.text === "kit-cancel")?.jobId;
			await agent.ctx.request(`_${NS}/cancel-job`, { sessionId, jobId: id });
			const after = await waitFor(agent, sessionId, (x) => x.some((e) => e.kind === "jobEnded" && e.jobId === id), 8000);
			const end = after.filter((e) => e.kind === "jobEnded" && e.jobId === id);
			check("jobs: cancel-job ends the job once, as cancelled, without a report", end.length === 1 && end[0].data?.outcome?.kind === "cancelled" && !after.some((e) => e.kind === "input" && e.data?.key === `job:${id}`), String(JSON.stringify(end)).slice(0, 200));
		}
	});
}

await attempt("load in a new process", async () => {
	await setOption(agent, sessionId, "approval", "never");
	await agent.ctx.request(methods.agent.session.close, { sessionId });
	await stop(agent);
	agent = connect(second);
	await agent.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
	const loaded = await within(45000, agent.ctx.request(methods.agent.session.load, { sessionId, cwd: project, mcpServers: [] }), "session/load");
	const replayed = agent.updates.filter((u) => u.sessionId === sessionId);
	check("load: replays the session before answering", replayed.length > 0 && JSON.stringify(replayed).includes("echo: hello"), `${replayed.length} updates`);
	const { entries } = await history(agent, sessionId);
	check("load: history survives a restart", entries.some((e) => e.kind === "turnEnd"));
	const r = await within(15000, prompt(agent, sessionId, "hello", "key-1"), "resent prompt after restart");
	check("load: a key survives a restart", meta(r)?.duplicate === true, JSON.stringify(meta(r)));
	const approval = (loaded.configOptions ?? []).find((o) => o.id === "approval");
	check("load: the approval setting survives", approval?.currentValue === "never", JSON.stringify(approval?.currentValue));
	const n = agent.permissions.length;
	const nv = await within(15000, prompt(agent, sessionId, 'tool:bash {"command":"echo yes > never.txt"}'), "prompt under never");
	check("load: under never, the call is refused without asking", nv.stopReason === "end_turn" && agent.permissions.length === n && !existsSync(join(project, "never.txt")));
	await setOption(agent, sessionId, "approval", "off");
	if (portableChecks && extensions.includes("erase")) {
		const result = (await history(agent, sessionId)).entries.find((e) => e.kind === "toolResult" && e.toolCallId && e.turnId);
		if (result) {
			await agent.ctx.request(`_${NS}/erase`, { sessionId, entryIds: [result.id] });
			erasedForPortable = { sid: sessionId, id: result.id, turnId: result.turnId, toolCallId: result.toolCallId };
		}
	}
	await agent.ctx.request(methods.agent.session.close, { sessionId });
});

if (crashChecks) {
	await attempt("crash", async () => {
		await stop(agent);
		agent = connect(command);
		await within(15000, agent.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} }), "initialize");
		const s = await agent.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
		const sid = s.sessionId;
		sessionsUsed.push(sid);
		await setOption(agent, sid, "model", "conformance/echo");
		await setOption(agent, sid, "approval", "off");
		const marker = join(project, "crash.txt");
		void prompt(agent, sid, `tool:bash {"command":"echo start >> crash.txt; sleep 4; echo end >> crash.txt"}`).catch(() => undefined);
		for (let i = 0; i < 200 && !(existsSync(marker) && readFileSync(marker, "utf8").includes("start")); i++) await sleep(50);
		check("crash: the bash call started", existsSync(marker));
		agent.child.kill("SIGKILL");
		await sleep(6000);
		const after = existsSync(marker) ? readFileSync(marker, "utf8") : "";
		check("crash: the killed agent's command did not finish", !after.includes("end"), JSON.stringify(after));
		agent = connect(second);
		const init = await agent.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
		// A history service holds the killed agent's lease until it runs out, so reopening may wait for it.
		const loaded = await within(45000, agent.ctx.request(methods.agent.session.load, { sessionId: sid, cwd: project, mcpServers: [] }), "session/load after the crash");
		// The agent that reopens decides how the turn ends.
		const durable = (meta(loaded)?.declaration ?? meta(init)?.declaration ?? {}).continuesAfterRestart === true;
		let entries = [];
		let call;
		for (let i = 0; i < 200; i++) {
			entries = (await history(agent, sid, { all: true })).entries;
			call = entries.flatMap((e) => (e.kind === "response" ? (e.message?.content ?? []).filter((p) => p.type === "toolCall") : [])).at(-1);
			const turnId = entries.find((e) => e.kind === "toolResult" && call && (e.toolCallId === call.id || e.message?.toolCallId === call.id))?.turnId;
			if (turnId && entries.some((e) => e.kind === "turnEnd" && e.turnId === turnId)) break;
			await sleep(100);
		}
		const results = entries.filter((e) => e.kind === "toolResult" && call && (e.toolCallId === call.id || e.message?.toolCallId === call.id));
		check("crash: the interrupted call has exactly one result", results.length === 1, `${results.length} results`);
		check("crash: its outcome is unknown", results[0]?.data?.status === "outcomeUnknown", JSON.stringify(results[0]?.data));
		const end = entries.find((e) => e.kind === "turnEnd" && e.turnId === results[0]?.turnId);
		if (durable) check("crash: with continuesAfterRestart, the turn carried on and completed", end?.data?.outcome?.kind === "completed", JSON.stringify(end?.data?.outcome));
		else check("crash: without continuesAfterRestart, the turn ended as failed", end?.data?.outcome?.kind === "failed", JSON.stringify(end?.data?.outcome));
		const lines = (existsSync(marker) ? readFileSync(marker, "utf8") : "").split("\n").filter((l) => l === "start").length;
		check("crash: the command was not run again", lines === 1, `${lines} starts`);
		await agent.ctx.request(methods.agent.session.close, { sessionId: sid });
	});
}

await stop(agent);

if (jobChecks && crashChecks) {
	await attempt("jobs after a crash", async () => {
		await stop(agent);
		agent = connect(command);
		await within(15000, agent.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} }), "initialize");
		const s = await agent.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
		const sid = s.sessionId;
		sessionsUsed.push(sid);
		await setOption(agent, sid, "model", "conformance/echo");
		await setOption(agent, sid, "approval", "off");
		await within(15000, prompt(agent, sid, 'tool:background {"text":"kit-survivor","ms":600000}'), "long background prompt");
		const before = await waitFor(agent, sid, (x) => x.some((e) => e.kind === "jobStarted"));
		const jobId = before.find((e) => e.kind === "jobStarted")?.jobId;
		check("jobs after a crash: the job started", !!jobId);
		agent.child.kill("SIGKILL");
		await sleep(500);
		agent = connect(second);
		await agent.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
		await within(45000, agent.ctx.request(methods.agent.session.load, { sessionId: sid, cwd: project, mcpServers: [] }), "session/load after the crash");
		const entries = await waitFor(agent, sid, (x) => said(x, "echo: background: kit-survivor (taken up)"), 20000);
		const ended = entries.filter((e) => e.kind === "jobEnded" && e.jobId === jobId);
		check("jobs after a crash: the reopening agent's plugin took the job up, and it ended once", ended.length === 1 && ended[0].data?.outcome?.kind === "completed", String(JSON.stringify(ended)).slice(0, 200));
		check("jobs after a crash: its report ran as a turn", said(entries, "echo: background: kit-survivor (taken up)"));
		await agent.ctx.request(methods.agent.session.close, { sessionId: sid });
		await stop(agent);
	});
}

if (portableChecks) {
	await attempt("portable", async () => {
		const url = process.env.MODULAR_AGENT_HISTORY_URL;
		const tokenFile = process.env.MODULAR_AGENT_HISTORY_TOKEN_FILE;
		if (!url || !tokenFile) throw new Error("--portable-checks needs MODULAR_AGENT_HISTORY_URL and MODULAR_AGENT_HISTORY_TOKEN_FILE");
		const token = readFileSync(tokenFile, "utf8").trim();
		const problems = [];
		let count = 0;
		for (const sid of sessionsUsed) {
			const res = await fetch(`${url.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(sid)}`, { headers: { authorization: `Bearer ${token}` } });
			if (!res.ok) {
				problems.push(`${sid}: HTTP ${res.status}`);
				continue;
			}
			const { entries } = await res.json();
			count += entries.length;
			problems.push(...portableProblems(sid, entries));
		}
		check("portable: the sessions are in the history service", count > 0, `${count} entries`);
		check("portable: every entry is in the shared shapes", problems.length === 0, problems.slice(0, 6).join("; "));
		if (erasedForPortable) {
			const res = await fetch(`${url.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(erasedForPortable.sid)}`, { headers: { authorization: `Bearer ${token}` } });
			const kept = (await res.json()).entries?.find((e) => e.id === erasedForPortable.id);
			check("portable: an erased tool result keeps its turnId and toolCallId in the service", kept?.erased === true && kept.turnId === erasedForPortable.turnId && kept.toolCallId === erasedForPortable.toolCallId && !("message" in kept), String(JSON.stringify(kept)).slice(0, 200));
		}
	});
}

/** What breaks the shared shapes in one session's kept entries (docs/bindings/data.md). */
function portableProblems(sid, entries) {
	const out = [];
	const say = (e, what) => out.push(`${e.kind ?? "?"} ${String(e.id).slice(0, 8)}: ${what}`);
	const STANDARD = ["inputAccepted", "inputHandedBack", "input", "turnStart", "modelRequest", "response", "toolStarted", "toolResult", "inputRequest", "inputAnswer", "turnEnd", "summary", "setting", "actorJoined", "actorLeft", "position", "erasure", "jobStarted", "jobEnded", "plugins", "limit", "tenant"];
	const seen = new Set();
	for (const e of entries) {
		if (e.erased) continue;
		if (typeof e.id !== "string") say(e, "id is not a string");
		if (e.sessionId !== sid) say(e, `sessionId is ${JSON.stringify(e.sessionId)}`);
		if (typeof e.time !== "number") say(e, `time is ${typeof e.time}`);
		if (typeof e.kind !== "string") say(e, "no kind");
		if (typeof e.modelVisible !== "boolean") say(e, "modelVisible is not a boolean");
		if (typeof e.writer !== "string") say(e, "no writer");
		if (!STANDARD.includes(e.kind) && !String(e.kind).includes(".")) say(e, "a build's own kind without a dot");
		const d = e.data ?? {};
		switch (e.kind) {
			case "input":
				if (e.message?.role !== "user" || typeof d.inputId !== "string" || typeof e.turnId !== "string") say(e, "needs a user message, data.inputId and turnId");
				break;
			case "turnStart":
				if (!d.startedBy?.kind || !d.model?.provider || !d.model?.id || typeof d.system !== "string" || !Array.isArray(d.tools)) say(e, "needs data.startedBy, data.model, data.system and data.tools");
				break;
			case "response":
				if (e.message?.role !== "assistant" || !Array.isArray(e.message?.content) || typeof e.message?.stop !== "string") say(e, "needs an assistant message with content and stop");
				break;
			case "toolStarted":
				if (typeof e.toolCallId !== "string" || d.call?.id !== e.toolCallId || typeof d.safeToRepeat !== "boolean") say(e, "needs toolCallId, data.call and data.safeToRepeat");
				break;
			case "toolResult":
				if (e.message?.role !== "toolResult" || typeof d.status !== "string" || e.toolCallId !== e.message?.toolCallId) say(e, "needs a toolResult message, toolCallId and data.status");
				break;
			case "inputRequest":
				if (!d.request?.kind || typeof d.request?.id !== "string") say(e, "needs data.request");
				break;
			case "inputAnswer":
				if (typeof d.requestId !== "string") say(e, "data is the Answer, with requestId");
				break;
			case "turnEnd":
				if (!d.outcome?.kind || !Array.isArray(d.result?.openToolCalls)) say(e, "needs data.outcome and data.result.openToolCalls");
				break;
			case "inputAccepted":
				if (typeof d.inputId !== "string" || !["now", "steer", "after", "propose"].includes(d.when)) say(e, "needs data.inputId and data.when");
				break;
			case "modelRequest":
				if (typeof e.stepId !== "string" || !d.model?.provider || typeof d.safeToRepeat !== "boolean") say(e, "needs stepId, data.model and data.safeToRepeat");
				break;
			case "jobStarted":
				if (typeof e.jobId !== "string" || typeof d.kind !== "string") say(e, "needs jobId and data.kind");
				break;
			case "jobEnded":
				if (typeof e.jobId !== "string" || !d.outcome?.kind || typeof d.report !== "boolean") say(e, "needs jobId, data.outcome and data.report");
				break;
			case "plugins":
				if (!Array.isArray(d.active) || d.active.some((x) => typeof x?.name !== "string")) say(e, "needs data.active, each with a name");
				break;
			case "setting":
				if (typeof d.key !== "string" || !("value" in d)) say(e, "needs data.key and data.value");
				if (d.key === "approval" && !["off", "ask", "all", "never"].includes(d.value)) say(e, "approval is off, ask, all or never");
				if (d.key === "model" && (typeof d.value?.provider !== "string" || typeof d.value?.id !== "string")) say(e, "the model setting is { provider, id }");
				break;
		}
		if (e.kind === "toolResult" && seen.has(`started:${e.toolCallId}`) === false && entries.some((x) => x.kind === "toolStarted" && x.toolCallId === e.toolCallId) && entries.indexOf(entries.find((x) => x.kind === "toolStarted" && x.toolCallId === e.toolCallId)) > entries.indexOf(e)) say(e, "kept before its toolStarted");
		if (e.kind === "toolStarted") seen.add(`started:${e.toolCallId}`);
		if (e.kind === "input" && !String(e.data?.key ?? "").startsWith("job:") && !entries.some((x) => x.kind === "inputAccepted" && x.data?.inputId === e.data?.inputId && entries.indexOf(x) < entries.indexOf(e))) say(e, "taken without an inputAccepted before it");
		if (e.kind === "response" && !entries.some((x) => x.kind === "modelRequest" && x.stepId === e.stepId && entries.indexOf(x) < entries.indexOf(e))) say(e, "no modelRequest before it");
	}
	return out;
}

for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
rmSync(dataDir, { recursive: true, force: true });
rmSync(dataDir2, { recursive: true, force: true });
rmSync(probeDir, { recursive: true, force: true });
rmSync(project, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
