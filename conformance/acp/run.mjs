#!/usr/bin/env node
// Conformance kit for the ACP host binding, modular-agent-acp/1 and /2 (docs/bindings/acp.md).
// Usage: node run.mjs [--verbose] [options] -- <agent command> [args...] [--then <second agent command> [args...]]
// The agent is started in conformance mode, with a fresh data folder and project, and driven with the
// official ACP client library. No external model. Service options use a disposable history service.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { historyService } from "./history.mjs";
import { portableProblems } from "./portable.mjs";

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
// With --portable-checks, sample the persisted fixture sessions against the shared shapes
// (docs/bindings/data.md#portable-sessions). It needs MODULAR_AGENT_HISTORY_URL and MODULAR_AGENT_HISTORY_TOKEN_FILE.
const portableChecks = argv.includes("--portable-checks");
const dash = argv.indexOf("--");
if (dash < 0 || dash === argv.length - 1) {
	console.error("Usage: node run.mjs [--verbose] [--plugin-checks] [--crash-checks] [--probe-checks] [--job-checks] [--portable-checks] -- <agent command> [args...] [--then <second agent command> [args...]]");
	process.exit(2);
}
// With --then, load and recovery reopenings use the second agent: one writes a session and the other,
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

const home = mkdtempSync(join(tmpdir(), "ma-conf-home-"));
const env = Object.fromEntries(["PATH", "MODULAR_AGENT_HISTORY_URL", "MODULAR_AGENT_HISTORY_TOKEN_FILE"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
let store, observer;
if (env.MODULAR_AGENT_HISTORY_URL || env.MODULAR_AGENT_HISTORY_TOKEN_FILE || portableChecks || then >= 0) {
	try { store = historyService(env.MODULAR_AGENT_HISTORY_URL, env.MODULAR_AGENT_HISTORY_TOKEN_FILE); }
	catch (e) { console.error(e.message); process.exit(2); }
	if (jobChecks) observer = await store.observe();
}
async function reopenWatchdog() {
	// History HTTP: Writing: one writer at a time. Add a harness allowance for other recovery work.
	const caps = store ? await store.json("/v1") : {};
	return 15000 + (Number.isSafeInteger(caps.ttlMs) && caps.ttlMs > 0 ? caps.ttlMs + 1000 : 15000);
}
const dataDir = mkdtempSync(join(tmpdir(), "ma-conf-data-"));
const dataDir2 = second === command ? dataDir : mkdtempSync(join(tmpdir(), "ma-conf-data-"));
const probeDir = mkdtempSync(join(tmpdir(), "ma-conf-probe-"));
const probeOut = (role) => join(probeDir, `${role}.json`);
const pluginEnv = {};
{
	const extra = [];
	if (probeChecks) {
		const probe = new URL("../plugin/probe.mjs", import.meta.url).pathname;
		for (const role of ["probe", "refuse-hook", "refuse-replace", "refuse-duplicate", "output-observer"]) extra.push({ command: [process.execPath, probe], config: { role, out: probeOut(role), ...(role === "probe" ? { release: probeOut("release-refresh"), traceOut: probeOut("probe-events") } : {}) } });
	}
	if (jobChecks) extra.push({ command: [process.execPath, new URL("../plugin/jobs.mjs", import.meta.url).pathname], config: { out: probeOut("jobs") } });
	const given = process.env.MODULAR_AGENT_PLUGINS ? JSON.parse(process.env.MODULAR_AGENT_PLUGINS) : [];
	if (extra.length || given.length) pluginEnv.MODULAR_AGENT_PLUGINS = JSON.stringify([...given, ...extra]);
}
const sessionsUsed = [];
// Tenants every agent is started with, for the tenant checks (docs/bindings/data.md#limits-and-tenants).
const TENANTS = JSON.stringify({ "kit-readonly": { rights: ["watch", "input", "answer", "settings"] }, "kit-broke": { rights: ["watch", "input", "answer", "approve", "tools", "cancel", "settings", "erase", "grant", "jobs", "delegate", "administer"], tokens: 0 } });
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
function connect(which = command, extraEnv = {}) {
	const child = spawn(which[0], which.slice(1), {
		cwd: project,
		stdio: ["pipe", "pipe", verbose ? "inherit" : "ignore"],
		env: { ...env, ...(observer ? { MODULAR_AGENT_HISTORY_URL: observer.url } : {}), HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, LANG: "C.UTF-8", ...pluginEnv, ...extraEnv, MODULAR_AGENT_TENANTS: TENANTS, MODULAR_AGENT_CONFORMANCE: "1", MODULAR_AGENT_DATA_DIR: which === command ? dataDir : dataDir2 },
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
			return state.permissionHandler ? await state.permissionHandler(params) : { outcome: { outcome: "selected", optionId: state.permissionAnswer } };
		});
	const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
	return { child, ctx: connection.agent, updates, permissions, state };
}
async function stop(agent) {
	if (hasExit(agent.child)) return;
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
	const r = await agent.ctx.request(methods.agent.session.setConfigOption, { sessionId, configId, value });
	if (sessionId === mainSession && meta(r)?.declaration) decl = meta(r).declaration;
	return r;
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

let sessionId, mainSession;
let erasedForPortable;
let portableDeclarations = [];
const hasExit = (c) => c.exitCode !== null || c.signalCode !== null;
const closeSession = (a, id) => a.ctx.request(methods.agent.session.close, { sessionId: id });
const trace = (role) => existsSync(probeOut(role)) ? readFileSync(probeOut(role), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
function validateDeclaration(label, d) {
	// ACP: The declaration.
	check(`${label}: declaration types, fixed values and implications`, !!d && BOOLEAN_KEYS.every((k) => typeof d[k] === "boolean") && Object.entries(ENUM_KEYS).every(([k, v]) => v.includes(d[k])) && d.inputKeys === true && d.pluginsDuringSession === false && (!d.waitingThroughRestart || d.continuesAfterRestart) && (!d.questionsOutlastTurns || d.lateAnswersStartTurns === true));
}
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
	validateDeclaration("initialize", d);
	// ACP: initialize.
	const caps = init.agentCapabilities;
	check("initialize: required load, list, resume and close capabilities", caps?.loadSession === true && ["list", "resume", "close"].every((k) => equal(caps.sessionCapabilities?.[k], {})));
	const missingBool = BOOLEAN_KEYS.filter((k) => typeof d[k] !== "boolean");
	check("declaration: every boolean key", missingBool.length === 0, `missing or not boolean: ${missingBool.join(", ")}`);
	const badEnum = Object.entries(ENUM_KEYS).filter(([k, values]) => !values.includes(d[k])).map(([k]) => `${k}=${JSON.stringify(d[k])}`);
	check("declaration: every declared-choice key", badEnum.length === 0, badEnum.join(", "));
	const ext = m?.extensions ?? [];
	check("initialize: required extensions listed", REQUIRED_EXTENSIONS.every((e) => ext.includes(e)), JSON.stringify(ext));
	// ACP: initialize; Shared data: Actors. The kind is configured, not inferred from ACP.
	check("initialize: configured actor has a valid id, kind and rights", ["user", "host", "agent", "program"].includes(m?.actor?.kind) && typeof m?.actor?.id === "string" && m.actor.id.length > 0 && Array.isArray(m.actor.rights) && m.actor.rights.every((r) => typeof r === "string" && r.length > 0));
});

await attempt("session/new", async () => {
	const s = await within(15000, agent.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [] }), "session/new");
	sessionId = mainSession = s.sessionId;
	sessionsUsed.push(sessionId);
	validateDeclaration("session/new", meta(s)?.declaration);
	decl = meta(s)?.declaration ?? decl;
	portableDeclarations.push(decl.portableSessions === true);
	check("session/new: a session id", typeof sessionId === "string" && sessionId.length > 0);
	const ids = (s.configOptions ?? []).map((o) => o.id);
	check("session/new: model option", ids.includes("model"), ids.join(", "));
	const model = (s.configOptions ?? []).find((o) => o.id === "model");
	const values = (model?.options ?? []).flatMap((o) => (o.options ? o.options.map((x) => x.value) : [o.value]));
	check("session/new: conformance/echo is offered", values.includes("conformance/echo"), values.slice(0, 8).join(", "));
	const approval = (s.configOptions ?? []).find((o) => o.id === "approval");
	const av = (approval?.options ?? []).map((o) => o.value);
	// ACP: Configuration options. An agent without the approval plugin omits the option.
	check("session/new: when present, approval offers the four policies", !approval || ["off", "ask", "all", "never"].every((v) => av.includes(v)), av.join(", "));
	agent.state.hasApproval = !!approval;
	check("session/new: session declaration in _meta", typeof meta(s)?.declaration === "object");
	await setOption(agent, sessionId, "model", "conformance/echo");
	if (agent.state.hasApproval) await setOption(agent, sessionId, "approval", "off");
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

if (agent.state.hasApproval) await attempt("approval", async () => {
	await setOption(agent, sessionId, "approval", "ask");
	agent.state.permissionAnswer = "refuse";
	const n = agent.permissions.length;
	const r1 = await within(15000, prompt(agent, sessionId, 'tool:bash {"command":"echo yes > refused.txt"}'), "refused tool prompt");
	check("approval: a permission request was made", agent.permissions.length === n + 1);
	const options = agent.permissions.at(-1)?.options ?? [];
	// ACP: Approvals.
	check("approval: exactly the two specified permission options", equal(options.map(({ optionId, kind, name }) => ({ optionId, kind, name })), [{ optionId: "allow", kind: "allow_once", name: "Allow" }, { optionId: "refuse", kind: "reject_once", name: "Refuse" }]), JSON.stringify(options));
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
		sessionsUsed.push(s2.sessionId);
		validateDeclaration("/2 session/new", meta(s2)?.declaration);
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
				return e?.code === -32602 && e?.data?.code === "forbidden";
			}
		};
		check("actors: the several-actors extensions are listed", ["actors", "join", "leave", "release"].every((x) => extensions.includes(x)), JSON.stringify(extensions));
		const a0 = await ask("actors", {});
		check("actors: lists the connection's actor", (a0.actors ?? []).some((a) => a.kind === "host"), String(JSON.stringify(a0)).slice(0, 200));
		await ask("join", { actor: { id: "kit-viewer", kind: "user", rights: ["watch"] } });
		const guest = `kit-guest-${randomUUID()}`;
		await ask("join", { actor: { id: guest, kind: "user", rights: ["watch", "input", "propose", "answer"] } });
		const a1 = await ask("actors", {});
		check("join: both actors are listed with their rights", (a1.actors ?? []).some((a) => a.id === "kit-viewer" && a.rights?.length === 1) && (a1.actors ?? []).some((a) => a.id === guest && a.rights.includes("input")), String(JSON.stringify(a1.actors)).slice(0, 300));
		// ACP: Several actors. No launcher config represents this fresh actor id.
		const before = await history(agent, sessionId, { all: true });
		const deniedInput = await refused(ask("input", { actorId: guest, content: "unrepresented input", when: "propose" }));
		const deniedAnswer = await refused(ask("answer", { actorId: guest, requestId: randomUUID(), value: "not represented" }));
		check("Several actors: join confers neither presence nor authority to input or answer as that actor", deniedInput && deniedAnswer && !a1.present?.includes(guest) && equal(await history(agent, sessionId, { all: true }), before));
		const turns = before.entries.filter((e) => e.kind === "turnEnd").length;
		const prop = await ask("input", { content: "kit proposal for release", when: "propose" });
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
			ran = said(es, "echo: kit proposal for release") && es.filter((e) => e.kind === "turnEnd").length > turns;
		}
		check("release: the released input ran as a turn", ran);
		check("proposals: the proposals extensions are listed", ["proposals", "withdraw"].every((x) => extensions.includes(x)), JSON.stringify(extensions));
		const p2 = await ask("input", { content: "a second proposal", when: "propose" });
		const listed = (await ask("proposals", {})).proposals ?? [];
		check("proposals: a proposal is listed with its proposer", listed.some((x) => x.inputId === p2.inputId && a0.present?.includes(x.actorId)) && !listed.some((x) => x.inputId === prop.inputId), String(JSON.stringify(listed)).slice(0, 200));
		check("proposals: content is shared-shape content, every part with a type", listed.every((x) => Array.isArray(x.content) && x.content.every((part) => typeof part?.type === "string")), String(JSON.stringify(listed.map((x) => x.content))).slice(0, 200));
		await ask("withdraw", { inputId: p2.inputId });
		await sleep(400);
		const after = (await ask("proposals", {})).proposals ?? [];
		const es2 = (await history(agent, sessionId)).entries;
		check("withdraw: the proposal is gone, handed back, and never ran", !after.some((x) => x.inputId === p2.inputId) && es2.some((e) => e.kind === "inputHandedBack" && (e.data?.inputIds ?? []).includes(p2.inputId)) && !said(es2, "echo: a second proposal"), String(JSON.stringify(after)).slice(0, 200));
		await ask("join", { actor: { id: guest, kind: "user", rights: ["watch"] } });
		check("join again: replaces recorded rights", (await ask("actors", {})).actors.some((a) => a.id === guest && equal(a.rights, ["watch"])));
		await ask("leave", { actorId: "kit-viewer" });
		const a2 = await ask("actors", {});
		check("leave: the actor is gone", !(a2.actors ?? []).some((a) => a.id === "kit-viewer"), String(JSON.stringify(a2.actors)).slice(0, 200));
		const kinds = (await history(agent, sessionId)).entries.map((e) => e.kind);
		check("actors: recorded as actorJoined and actorLeft", kinds.includes("actorJoined") && kinds.includes("actorLeft"), [...new Set(kinds)].join(","));
	});
}

// ACP: Extension methods (Move); Contracts: Moving and rewinding.
if (extensions.includes("move")) await attempt("move to an entry inside a settled turn", async () => {
	const s = await agent.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
	sessionsUsed.push(s.sessionId);
	try {
		await setOption(agent, s.sessionId, "model", "conformance/echo");
		await within(15000, prompt(agent, s.sessionId, "move fixture"), "seed move fixture");
		const before = await history(agent, s.sessionId, { all: true });
		const target = before.entries.find((e) => e.kind === "response" && e.turnId && before.entries.some((end) => end.kind === "turnEnd" && end.turnId === e.turnId));
		if (!target) throw Error("fixture did not record a response inside a settled turn");
		const e = await agent.ctx.request(`_${NS}/move`, { sessionId: s.sessionId, entryId: target.id }).catch((e) => e);
		check("Moving and rewinding: a plain move to a non-quiescent entry is refused without a position record", e?.code === -32602 && e?.data?.code === "conflict" && equal(await history(agent, s.sessionId, { all: true }), before));
	} finally { await closeSession(agent, s.sessionId); }
});

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
		// Shared data: Rewinding. No new history entry intervenes before reopen.
		if (store) {
			const positions = (await store.pages(sessionId)).slice(-2);
			check("Rewinding: restore intent is followed by a completed position before success", positions.length === 2 &&
				positions.every((e) => e.kind === "position" && e.data?.to === mark) &&
				!!positions[0].data.restore?.point && !!positions[0].data.restore?.undo && !Object.hasOwn(positions[1].data, "restore") && !positions[1].data.failed);
		}
		await closeSession(agent, sessionId);
		writeFileSync(file, "edited after completed rewind\n");
		await within(await reopenWatchdog(), agent.ctx.request(methods.agent.session.load, { sessionId, cwd: project, mcpServers: [] }), "reopen after rewind");
		check("Rewinding: a completed rewind is not replayed on reopen", readFileSync(file, "utf8").trim() === "edited after completed rewind");
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
		await lim(["watch", "input", "answer", "approve", "settings", "erase", "grant", "administer", "cancel", "propose", "jobs", "delegate"]);
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
			if ((s2.configOptions ?? []).some((o) => o.id === "approval")) await setOption(agent, s2.sessionId, "approval", "off");
			sessionsUsed.push(s2.sessionId);
			return s2.sessionId;
		};
		check("tenants: the tenant extension is listed", extensions.includes("tenant"), JSON.stringify(extensions));
		let refused = false;
		try {
			await agent.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [], _meta: { [NS]: { tenant: "kit-no-such-tenant" } } });
		} catch (e) {
			refused = e?.code === -32602 && e?.data?.code === "forbidden";
		}
		check("tenants: an unknown tenant is refused", refused);
		const ro = await open("kit-readonly");
		const info = await agent.ctx.request(`_${NS}/tenant`, { sessionId: ro });
		check("tenants: the session reports its tenant", info.tenant === "kit-readonly" && Array.isArray(info.rights) && !info.rights.includes("tools"), JSON.stringify(info));
		const r = await within(15000, prompt(agent, ro, 'tool:bash {"command":"echo yes > tenant.txt"}'), "tenant prompt");
		// Shared data: Portable sessions. After the first admission, tenant precedes all other records.
		const first = (await history(agent, ro, { all: true })).entries[0];
		check("tenants: first persisted record names the tenant", first?.kind === "tenant" && first.data?.tenant === "kit-readonly");
		check("tenants: the tenant's ceiling refuses a tool call", r.stopReason === "end_turn" && !existsSync(join(project, "tenant.txt")), r.stopReason);
		const broke = await open("kit-broke");
		const b = await within(15000, prompt(agent, broke, "hello broke"), "budget prompt");
		check("tenants: an exhausted budget ends the turn as tenantTokens, max_tokens", b.stopReason === "max_tokens" && meta(b)?.outcome?.limit === "tenantTokens", `${b.stopReason} ${JSON.stringify(meta(b)?.outcome)}`);
		check("tenants: without a model request", !(await history(agent, broke, { all: true })).entries.some((e) => e.kind === "response" || e.kind === "modelRequest"));
		for (const id of [ro, broke]) await agent.ctx.request(methods.agent.session.close, { sessionId: id });
	});
}

// ACP: Cancelling; Plugin binding: Command lifetime. Witness execution, not a tool announcement.
await attempt("cancel", async () => {
	const marker = join(project, "cancel-test.txt");
	const pending = prompt(agent, sessionId, 'tool:bash {"command":"echo started > cancel-test.txt; sleep 6; echo finished >> cancel-test.txt"}');
	void pending.catch(() => undefined);
	for (let i = 0; i < 100 && !existsSync(marker); i++) await sleep(50);
	check("cancel: fixture command actually started", existsSync(marker));
	const t0 = Date.now();
	await agent.ctx.notify(methods.agent.session.cancel, { sessionId });
	const r = await within(10000, pending, "cancelled prompt");
	check("cancel: stopReason and outcome are cancelled", r.stopReason === "cancelled" && meta(r)?.outcome?.kind === "cancelled");
	check("cancel: prompt answers within five seconds", Date.now() - t0 <= 5000);
	if (["strong", "processGroup"].includes(decl.commandContainment)) {
		await sleep(6500);
		check("cancel: the managed command does not finish", existsSync(marker) && readFileSync(marker, "utf8").trim() === "started");
	}
});

// ACP: Input admission. Both methods share the first receipt, and it runs exactly once.
await attempt("input extension", async () => {
	const before = (await history(agent, sessionId, { all: true })).entries.filter((e) => e.kind === "turnEnd").length;
	const a = await agent.ctx.request(`_${NS}/input`, { sessionId, content: "queued", when: "now", key: "key-2" });
	check("input: receipt", typeof a.inputId === "string" && ["now", "inTurn", "after"].includes(a.taken));
	const b = await agent.ctx.request(`_${NS}/input`, { sessionId, content: "different content", when: "after", key: "key-2" });
	check("input: duplicate preserves original receipt and disposition", b.duplicate === true && b.inputId === a.inputId && b.taken === a.taken);
	const p = await within(15000, prompt(agent, sessionId, "from the other method", "key-2"), "duplicate extension input via prompt");
	check("input: prompt and extension share the receipt", meta(p)?.inputId === a.inputId && meta(p)?.duplicate === true);
	const { entries } = await history(agent, sessionId, { all: true });
	const accepted = entries.filter((e) => e.kind === "inputAccepted" && e.data?.inputId === a.inputId);
	const taken = entries.filter((e) => e.kind === "input" && e.data?.inputId === a.inputId);
	const turnId = taken[0]?.turnId;
	check("input: one acceptance and one consumption in one completed turn", accepted.length === 1 && taken.length === 1 && !!turnId && entries.filter((e) => e.kind === "turnStart" && e.turnId === turnId).length === 1 && entries.filter((e) => e.kind === "turnEnd").length === before + 1 && said(entries.filter((e) => e.turnId === turnId), "echo: queued"));
});

// ACP: Questions; Extension methods (answer); Shared data: Questions.
await attempt("requests and answer", async () => {
	const requests = () => agent.ctx.request(`_${NS}/requests`, { sessionId }).then((r) => r.requests);
	const answer = (requestId, value) => agent.ctx.request(`_${NS}/answer`, { sessionId, requestId, value });
	check("requests: an array", Array.isArray(await requests()));
	check("answer: unknown request returns not_open", equal(await answer("no-such-request", "x"), { accepted: false, reason: "not_open" }));
	if (!agent.state.hasApproval) return;
	await setOption(agent, sessionId, "approval", "all");
	let release;
	agent.state.permissionHandler = () => new Promise((resolve) => { release = resolve; });
	const pending = prompt(agent, sessionId, 'tool:bash {"command":"echo approved >> answer-race.txt"}');
	void pending.catch(() => undefined);
	try {
		let q;
		for (let i = 0; i < 100 && !q; i++) {
			q = (await requests()).find((r) => r.kind === "approval" && r.answerable);
			if (!q) await sleep(50);
		}
		check("requests: live approval is listed and answerable", !!q?.id && typeof q.toolCallId === "string");
		if (!q) return;
		const winner = await answer(q.id, "allow");
		check("answer: extension accepts the first valid answer", winner.accepted === true);
		release?.({ outcome: { outcome: "selected", optionId: "refuse" } });
		check("answer: closed request rejects a later answer", equal(await answer(q.id, "refuse"), { accepted: false, reason: "not_open" }));
		await within(12000, pending, "tool after the winning approval");
		const answers = (await history(agent, sessionId, { all: true })).entries.filter((e) => e.kind === "inputAnswer" && e.data?.requestId === q.id);
		const marker = join(project, "answer-race.txt");
		check("answer: only the winning approval is recorded and the call runs once", answers.length === 1 && existsSync(marker) && readFileSync(marker, "utf8") === "approved\n");
	} finally {
		release?.({ outcome: { outcome: "selected", optionId: "refuse" } });
		agent.state.permissionHandler = undefined;
		await setOption(agent, sessionId, "approval", "off");
	}
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
		await within(15000, prompt(agent, sessionId, "probe seed"), "pre-seed probe history");
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
		// Plugin binding: Held output; ACP: Output gate.
		check("output events: every batch is final and fits 4 MiB", seen.every((x) => (typeof x?.sessionId === "string" || x?.sessionId === null) && typeof x?.recipient === "string" && Array.isArray(x?.events) && x?.final === true && Buffer.byteLength(JSON.stringify(x.events)) <= 4 * 1024 * 1024), String(JSON.stringify(seen.find((x) => !(typeof x?.sessionId === "string" && Array.isArray(x?.events))))).slice(0, 200));
		const OUT = { text: (d) => typeof d?.delta === "string", reasoning: (d) => typeof d?.delta === "string", toolCall: (d) => typeof d?.call?.id === "string" && typeof d?.call?.name === "string", toolOutput: (d) => typeof d?.toolCallId === "string" && typeof d?.chunk === "string", toolResult: (d) => typeof d?.toolCallId === "string" && typeof d?.status === "string" && Array.isArray(d?.content), entry: (d) => typeof d?.entry?.id === "string", request: (d) => typeof d?.method === "string" && typeof d?.params === "object", turnEnded: (d) => typeof d?.outcome?.kind === "string", reply: (d) => typeof d?.method === "string" };
		const bad = events.filter((e) => (OUT[e?.type] ? !OUT[e.type](e.data) : !String(e?.type ?? "").includes(".")));
		check("output events: every event is a standard type in its shape, or a build's own type with a dot", bad.length === 0, String(JSON.stringify(bad.slice(0, 2))).slice(0, 300));
		const types = new Set(events.map((e) => e?.type));
		check("output events: ACP supplies text, toolCall, toolResult and reply projections", ["text", "toolCall", "toolResult", "reply"].every((t) => types.has(t)), [...types].join(","));
	});
}

if (probeChecks) {
	// Plugin binding: The host asks a tool source. The latch makes the refresh barrier observable.
	await attempt("tool refresh barrier", async () => {
		let settled = false;
		const pending = prompt(agent, sessionId, "tool:probe-refresh {}");
		void pending.then(() => { settled = true; }, () => { settled = true; });
		const requested = () => {
			try { return trace("probe-events").some((e) => e.refreshRequested); } catch { return false; }
		};
		try {
			for (let i = 0; i < 75 && !requested() && !settled; i++) await sleep(50);
			check("refresh: triggering tool reply waits for the new list", !settled && requested());
		} finally { writeFileSync(probeOut("release-refresh"), "release"); }
		await within(15000, pending, "tool list refresh");
		const before = agent.updates.length;
		await within(15000, prompt(agent, sessionId, "tool:probe-added {}"), "tool newly offered by refresh");
		check("refresh: subsequent turn can use a newly listed tool", agent.updates.slice(before).some((u) => u.sessionId === sessionId && u.update.sessionUpdate === "tool_call" && u.update.title === "probe-added"));
	});

	// ACP: Questions; Shared data: Questions and Context and interrupted work.
	for (const late of decl.questionsOutlastTurns && decl.lateAnswersStartTurns ? [false, true] : [false]) await attempt(late ? "late text question" : "in-turn text question", async () => {
		const pending = prompt(agent, sessionId, `tool:probe-question {"late":${late}}`);
		void pending.catch(() => undefined);
		const requests = () => agent.ctx.request(`_${NS}/requests`, { sessionId }).then((r) => r.requests);
		let question;
		for (let i = 0; i < 100 && !question; i++) {
			question = (await requests()).find((r) => r.kind === "text" && r.question === "Fixture question");
			if (!question) await sleep(50);
		}
		check(`${late ? "late" : "in-turn"} question: visible without a form route`, question?.answerable === true && typeof question?.toolCallId === "string");
		if (!question) return;
		let originatingTurn;
		if (late) {
			await within(10000, pending, "original turn leaves a question open");
			originatingTurn = (await history(agent, sessionId, { all: true })).entries.find((e) => e.kind === "turnEnd" && e.data?.result?.openToolCalls?.includes(question.toolCallId))?.turnId;
			check("late question: the original turn ends with its call open", typeof originatingTurn === "string");
		}
		const answer = () => agent.ctx.request(`_${NS}/answer`, { sessionId, requestId: question.id, value: "fixture value" });
		const pair = await Promise.all([answer(), answer()]);
		check(`${late ? "late" : "in-turn"} question: two valid replies produce one acceptance`, pair.filter((r) => r.accepted === true).length === 1 && pair.some((r) => equal(r, { accepted: false, reason: "not_open" })));
		if (!late) await within(10000, pending, "tool receives its text answer");
		const entries = await waitFor(agent, sessionId, (es) => es.some((e) => e.kind === "toolResult" && e.toolCallId === question.toolCallId && JSON.stringify(e.message?.content).includes("fixture answer: fixture value")), 8000);
		check(`${late ? "late" : "in-turn"} question: one value record and one tool result for the original call`, entries.filter((e) => e.kind === "inputAnswer" && e.data?.requestId === question.id && e.data.value === "fixture value").length === 1 && entries.filter((e) => e.kind === "toolResult" && e.toolCallId === question.toolCallId).length === 1);
		if (late) check("late question: exactly one continuation names the originating turn", !!originatingTurn && entries.filter((e) => e.kind === "turnStart" && e.data?.continuesTurnId === originatingTurn && e.data?.startedBy?.id === question.id).length === 1);
	});

	// ACP: Output gate. Separate sessions keep blocked history replies away from other checks.
	for (const field of ["id", "type"]) await attempt(`output gate: change ${field}`, async () => {
		const s = await agent.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
		sessionsUsed.push(s.sessionId);
		await setOption(agent, s.sessionId, "model", "conformance/echo");
		await within(15000, prompt(agent, s.sessionId, `kit-gate-change-${field}`), "seed gate fixture");
		const got = await history(agent, s.sessionId, { all: true }).catch((e) => e);
		const hit = trace("output-observer").some((p) => p?.fixtureMutation === field && p.sessionId === s.sessionId);
		check(`output gate: changing a reply event ${field} withholds history`, hit && got?.code === -32000 && got?.data?.code === "withheld" && !JSON.stringify(got).includes(`kit-gate-change-${field}`));
		await closeSession(agent, s.sessionId);
	});

	// ACP: Approvals and Questions. Reject both forms of the changed view.
	if (agent.state.hasApproval) await attempt("approval view rejected by the gate", async () => {
		const s = await agent.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
		sessionsUsed.push(s.sessionId);
		const sid = s.sessionId;
		const permissions = agent.permissions.length;
		let release;
		agent.state.permissionHandler = () => new Promise((r) => { release = r; });
		try {
			await setOption(agent, sid, "model", "conformance/echo");
			await setOption(agent, sid, "approval", "all");
			const pending = prompt(agent, sid, 'tool:bash {"command":"echo ran > kit-gated-approval.txt"}');
			void pending.catch(() => undefined);
			const find = (es) => es.find((e) => e.kind === "inputRequest" && e.data?.request?.kind === "approval");
			const question = find(await waitFor(agent, sid, (es) => !!find(es), 5000));
			const id = question?.requestId ?? question?.data?.request?.id;
			if (!id) throw Error("fixture approval request not recorded");
			const view = await agent.ctx.request(`_${NS}/requests`, { sessionId: sid }).catch((e) => e);
			const answer = await agent.ctx.request(`_${NS}/answer`, { sessionId: sid, requestId: id, value: "allow" }).catch((e) => e);
			const gated = trace("output-observer").some((p) => p.approvalView && p.sessionId === sid);
			check("Approvals / Questions: an altered approval view cannot authorize this recipient's answer", gated &&
				agent.permissions.length === permissions && !view?.requests?.some((q) => q.id === id && q.answerable) &&
				equal(answer, { accepted: false, reason: "not_open" }));
			release?.({ outcome: { outcome: "cancelled" } });
			await within(10000, pending, "approval with no usable route");
			const { entries } = await history(agent, sid, { all: true });
			check("Questions: with no exact approval route the call is refused without dispatch", !!question.toolCallId &&
				entries.some((e) => e.kind === "toolResult" && e.toolCallId === question.toolCallId && e.data?.status === "refused") &&
				!existsSync(join(project, "kit-gated-approval.txt")));
		} finally {
			release?.({ outcome: { outcome: "cancelled" } });
			delete agent.state.permissionHandler;
			await closeSession(agent, sid);
		}
	});

	// Plugin binding: Runtime records and effects and Runtime callbacks.
	await attempt("remote Runtime host", async () => {
		const plugin = { command: [process.execPath, new URL("../plugin/probe.mjs", import.meta.url).pathname], config: { role: "runtime", out: probeOut("runtime") } };
		const remote = connect(command, { MODULAR_AGENT_PLUGINS: JSON.stringify([plugin]) });
		try {
			await remote.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
			const s = await remote.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
			sessionsUsed.push(s.sessionId);
			await setOption(remote, s.sessionId, "model", "conformance/echo");
			if ((s.configOptions ?? []).some((o) => o.id === "approval")) await setOption(remote, s.sessionId, "approval", "off");
			for (const name of ["omitted", "changed", "exact"]) {
				const before = trace("runtime").filter((x) => x.effect).length;
				await within(15000, prompt(remote, s.sessionId, 'tool:probe-effect {"value":"original"}'), `remote Runtime fixture: ${name}`).catch(() => undefined);
				const log = trace("runtime");
				const c = log.find((x) => x.test === name)?.checks ?? {};
				check(`remote Runtime ${name}: host rejects record of a host-owned setting`, c.hostKind);
				check(`remote Runtime ${name}: host commits exact modelRequest`, c.modelIntent);
				check(`remote Runtime ${name}: dispatch requires exact allowed decision`, c.dispatch && equal(log.filter((x) => x.effect).slice(before).map((x) => x.effect), name === "changed" ? [] : [{ value: "original" }]));
				check(`remote Runtime ${name}: host commits toolResult before replying`, c.resultCommit);
				if (name === "omitted") check("Runtime callbacks: runToolCall before allowance returns invalid_request without writing", c.earlyDispatch);
				if (name === "exact") {
					check("Runtime callbacks: tool.before on an allowed or settled call returns invalid_request without writing", c.repeatedGate && c.settledGate);
					check("Runtime callbacks: runToolCall after settlement returns invalid_request without writing", c.settledDispatch);
					check("remote Runtime exact: repeating the matching record returns the committed result", c.cachedResult);
				}
			}
			await closeSession(remote, s.sessionId);
		} finally { await stop(remote); }
	});
}

// Plugin binding: The host asks a tool source. Run last for this source: its catalog stays unavailable.
if (probeChecks) await attempt("tool catalog refresh fails", async () => {
	const sid = sessionId;
	const n = trace("probe-events").filter((e) => e.refreshFailed).length;
	await within(15000, prompt(agent, sid, 'tool:probe-refresh {"fail":true}'), "tool returns despite failed refresh").catch(() => undefined);
	const { entries } = await history(agent, sid, { all: true });
	const result = entries.find((e) => e.kind === "toolResult" && e.message?.content?.some((p) => p.text === "fixture result before list failure"));
	check("The host asks a tool source: failed refresh does not replace or withhold the triggering result", trace("probe-events").filter((e) => e.refreshFailed).length > n &&
		result?.data?.status === "completed" &&
		agent.updates.some((u) => u.sessionId === sid && u.update.sessionUpdate === "tool_call_update" &&
			u.update.toolCallId === result.toolCallId && u.update.status === "completed"));
});

if (jobChecks) {
	await attempt("jobs", async () => {
		const r = await within(15000, prompt(agent, sessionId, 'tool:background {"text":"kit-job","ms":300}'), "background prompt");
		check("jobs: the turn that started the job ends", r.stopReason === "end_turn", r.stopReason);
		const entries = await waitFor(agent, sessionId, (es) => decl.startsTurnsUnasked === "jobReports" ? said(es, "echo: background: kit-job") : es.some((e) => e.kind === "jobEnded" && e.data?.report));
		const started = entries.find((e) => e.kind === "jobStarted" && e.data?.kind === "background");
		const jobId = started?.jobId;
		check("jobs: jobStarted, by the plugin's name", !!jobId && started.writer === "conformance-jobs" && started.data?.detail?.text === "kit-job", String(JSON.stringify(started)).slice(0, 200));
		const ended = entries.filter((e) => e.kind === "jobEnded" && e.jobId === jobId);
		check("jobs: one jobEnded, completed and reported", ended.length === 1 && ended[0].data?.outcome?.kind === "completed" && ended[0].data?.report === true, String(JSON.stringify(ended)).slice(0, 200));
		// Shared data: Job reports; Plugin binding: Jobs.
		const report = entries.filter((e) => e.kind === "inputAccepted" && e.data?.key === `job:${jobId}`);
		check("jobs: one admitted report follows the end with exact content", report.length === 1 && report[0].jobId === jobId && entries.indexOf(report[0]) > entries.indexOf(ended[0]) && equal(report[0].data?.content, [{ type: "text", text: "background: kit-job" }]));
		for (let i = 0; i < 100 && !trace("jobs").some((x) => x.repeatedEnd === jobId || x.endFailed === jobId); i++) await sleep(50);
		const log = trace("jobs");
		check("jobs: start acknowledged after commit and same-key start deduplicates", log.some((x) => x.started === jobId && x.fresh === true && x.commit && x.duplicate));
		check("jobs: end acknowledgment sees both records and identical retry adds neither", log.some((x) => x.ended === jobId && x.commit && x.admission) && log.some((x) => x.repeatedEnd === jobId && x.once));
		// Shared data: Job reports. The service observes batch boundaries, which history order cannot prove.
		if (observer) {
			const relevant = observer.batches.map((es) => es.filter((e) => e.jobId === jobId || e.key === `job:${jobId}`)).filter((es) => es.length);
			check("jobs: reported end and admission share one append batch", relevant.length > 0 && relevant.every((es) => es.length === 2 && es[0].kind === "jobEnded" && es[1].kind === "inputAccepted" && es[1].key === `job:${jobId}`));
		}
		if (decl.startsTurnsUnasked === "jobReports") {
			check("jobs: the report started a turn, startedBy the job", entries.some((e) => e.kind === "turnStart" && e.data?.startedBy?.kind === "job" && e.data?.startedBy?.id === jobId));
			check("jobs: the report reached the model", said(entries, "echo: background: kit-job"));
		}
		if (extensions.includes("cancel-job")) {
			await within(15000, prompt(agent, sessionId, 'tool:background {"text":"kit-cancel","ms":600000}'), "long background prompt");
			const es = await waitFor(agent, sessionId, (x) => x.some((e) => e.kind === "jobStarted" && e.data?.detail?.text === "kit-cancel"));
			const id = es.find((e) => e.kind === "jobStarted" && e.data?.detail?.text === "kit-cancel")?.jobId;
			await agent.ctx.request(`_${NS}/cancel-job`, { sessionId, jobId: id });
			// ACP: Extension methods (cancel-job). The long fixture timer cannot win this race.
			const after = (await history(agent, sessionId, { all: true })).entries;
			const end = after.filter((e) => e.kind === "jobEnded" && e.jobId === id);
			check("jobs: cancel-job ends the job once, as cancelled, without a report", end.length === 1 && end[0].data?.outcome?.kind === "cancelled" && !after.some((e) => e.kind === "inputAccepted" && e.data?.key === `job:${id}`), String(JSON.stringify(end)).slice(0, 200));
		}
	});
}

await attempt("load in a new process", async () => {
	if (agent.state.hasApproval) await setOption(agent, sessionId, "approval", "never");
	await agent.ctx.request(methods.agent.session.close, { sessionId });
	await stop(agent);
	agent = connect(second);
	const init = await agent.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
	extensions = meta(init)?.extensions ?? [];
	const loaded = await within(await reopenWatchdog(), agent.ctx.request(methods.agent.session.load, { sessionId, cwd: project, mcpServers: [] }), "session/load");
	validateDeclaration("session/load", meta(loaded)?.declaration);
	decl = meta(loaded)?.declaration ?? {};
	portableDeclarations.push(decl.portableSessions === true);
	const replayed = agent.updates.filter((u) => u.sessionId === sessionId);
	check("load: replays the session before answering", replayed.length > 0 && JSON.stringify(replayed).includes("echo: hello"), `${replayed.length} updates`);
	const { entries } = await history(agent, sessionId);
	check("load: history survives a restart", entries.some((e) => e.kind === "turnEnd"));
	const r = await within(15000, prompt(agent, sessionId, "hello", "key-1"), "resent prompt after restart");
	check("load: a key survives a restart", meta(r)?.duplicate === true, JSON.stringify(meta(r)));
	const approval = (loaded.configOptions ?? []).find((o) => o.id === "approval");
	if (approval) {
		check("load: the approval setting survives", approval.currentValue === "never");
		const n = agent.permissions.length;
		const nv = await within(15000, prompt(agent, sessionId, 'tool:bash {"command":"echo yes > never.txt"}'), "prompt under never");
		check("load: under never, the call is refused without asking", nv.stopReason === "end_turn" && agent.permissions.length === n && !existsSync(join(project, "never.txt")));
		await setOption(agent, sessionId, "approval", "off");
	}
	if (portableChecks && decl.erasure && extensions.includes("erase")) {
		const result = (await history(agent, sessionId)).entries.find((e) => e.kind === "toolResult" && e.toolCallId && e.turnId);
		if (result) {
			await agent.ctx.request(`_${NS}/erase`, { sessionId, entryIds: [result.id] });
			erasedForPortable = { sid: sessionId, id: result.id, turnId: result.turnId, toolCallId: result.toolCallId };
		}
	}
	await agent.ctx.request(methods.agent.session.close, { sessionId });
});

// ACP: Input admission and Extension methods (Erase). Resend through both admission routes.
if (decl.erasure && extensions.includes("erase")) await attempt("erased input key", async () => {
	const s = await agent.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
	sessionsUsed.push(s.sessionId);
	const sid = s.sessionId;
	try {
		await setOption(agent, sid, "model", "conformance/echo");
		const key = randomUUID(), content = "erase this fixture input";
		const first = await within(15000, prompt(agent, sid, content, key), "admit erasable input");
		const id = meta(first)?.inputId;
		const log = (await history(agent, sid, { all: true })).entries;
		const input = log.find((e) => e.kind === "input" && (e.inputId ?? e.data?.inputId) === id)
			?? log.find((e) => e.kind === "input" && e.message?.content?.some((p) => p.text === content));
		if (!id || !input) throw Error("erasable fixture input was not admitted and consumed");
		const erased = await agent.ctx.request(`_${NS}/erase`, { sessionId: sid, entryIds: [input.id] });
		check("Input admission: selected input was erased", erased.erased.includes(input.id));
		await closeSession(agent, sid);
		await within(await reopenWatchdog(), agent.ctx.request(methods.agent.session.load, { sessionId: sid, cwd: project, mcpServers: [] }), "load erased input fixture");
		const before = await history(agent, sid, { all: true });
		const inputReply = await agent.ctx.request(`_${NS}/input`, { sessionId: sid, content, when: "now", key }).catch((e) => e);
		const promptReply = await within(15000, prompt(agent, sid, content, key), "resend erased prompt").catch((e) => e);
		const receipt = { duplicate: true, erased: true };
		check("Input admission: erased input key returns only the erased duplicate receipt", equal(inputReply, receipt));
		check("Input admission: erased prompt key returns end_turn without an old input id or outcome", promptReply.stopReason === "end_turn" && equal(meta(promptReply), receipt));
		check("Input admission: resending an erased key does not write or start work", equal(await history(agent, sid, { all: true }), before));
	} finally { await closeSession(agent, sid).catch(() => undefined); }
});

// History HTTP: Writing: one writer at a time. The upstream writer is still current;
// the fault is the late reply, not service-side rejection of an expired generation.
if (crashChecks && store) await attempt("delayed history renewal", async () => {
	const { ttlMs } = await store.json("/v1");
	if (!(ttlMs >= 1000 && ttlMs <= 10000)) {
		console.log("SKIP  delayed renewal fixture needs a service TTL between 1 and 10 seconds");
		return;
	}
	let sid, markHeld, markLate;
	const held = new Promise((r) => { markHeld = r; });
	const late = new Promise((r) => { markLate = r; });
	const proxy = await store.observe({ beforeReply: async (r) => {
		if (!sid || r.method !== "POST" || !r.ok || !r.path.startsWith(store.path(sid) + "/lease/") || !r.path.endsWith("/renew")) return;
		markHeld();
		await sleep(Math.ceil(ttlMs * 0.6));
		markLate();
	} });
	const writer = connect(command, { MODULAR_AGENT_HISTORY_URL: proxy.url, MODULAR_AGENT_PLUGINS: "[]" });
	const marker = join(project, "after-late-renewal.txt");
	try {
		await writer.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
		const s = await writer.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
		sid = s.sessionId;
		await setOption(writer, sid, "model", "conformance/echo");
		if ((s.configOptions ?? []).some((o) => o.id === "approval")) await setOption(writer, sid, "approval", "off");
		await within(15000, prompt(writer, sid, "seed delayed renewal fixture"), "start history writer");
		await within(ttlMs * 2, held, "capture a successful upstream renewal");
		await within(ttlMs, late, "release the renewal after the writer's cutoff");
		await sleep(Math.ceil(ttlMs / 12));
		const prior = new Set((await store.pages(sid)).map((e) => e.id));
		await within(15000, prompt(writer, sid, 'tool:bash {"command":"echo ran > after-late-renewal.txt"}'), "input after late lease success").catch(() => undefined);
		const later = (await store.pages(sid)).filter((e) => !prior.has(e.id));
		check("Writing: one writer at a time: a delayed renewal success cannot revive dispatch authority", !existsSync(marker) && !later.some((e) => e.kind === "modelRequest" || e.kind === "toolStarted"));
	} finally { await stop(writer); proxy.stop(); }
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
		// Contracts: The working environment. Loss containment follows the session declaration.
		if (["strong", "processGroup"].includes(meta(s)?.declaration?.commandContainment)) check("crash: the managed command did not finish after agent loss", !after.includes("end"));
		agent = connect(second);
		const init = await agent.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
		// A history service holds the killed agent's lease until it runs out, so reopening may wait for it.
		const loaded = await within(await reopenWatchdog(), agent.ctx.request(methods.agent.session.load, { sessionId: sid, cwd: project, mcpServers: [] }), "session/load after the crash");
		// The agent that reopens decides how the turn ends.
		validateDeclaration("crash recovery load", meta(loaded)?.declaration);
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

// Shared data: Setting keys, Append order and the branch, and Session state; Contracts: Authority.
if (portableChecks) await attempt("portable authority fixture", async () => {
	const s = connect(second);
	try {
		const init = await s.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
		const principal = meta(init)?.actor;
		if (!principal?.id) throw Error("reopener did not identify a principal");
		const actor = { ...principal, rights: ["watch", "input", "settings", "tools", "approve"] };
		const seed = async (mode) => {
			const sessionId = `kit-portable-${randomUUID()}`;
			const rows = [
				{ kind: "actorJoined", data: { actor: { id: "kit-granter", kind: "user", rights: [...actor.rights, "grant"] } } },
				{ kind: "actorJoined", actorId: "kit-granter", data: { actor } },
				{ kind: "setting", data: { key: "model", value: { provider: "conformance", id: "echo" } } },
				{ kind: "inputAccepted", actorId: actor.id, data: { inputId: "initial-input", when: "after", key: "fixture-old", content: [{ type: "text", text: "old input" }], authorizers: [{ sessionId, actorId: actor.id }], rights: actor.rights } },
				{ kind: "inputHandedBack", data: { inputIds: ["initial-input"] } },
			];
			if (mode === "approval") rows.push({ kind: "setting", data: { key: "approval", value: "kit-unrecognized-policy" } });
			if (mode === "rights") rows.push({ kind: "actorJoined", actorId: "kit-granter", data: { actor: { ...actor, rights: ["watch", "input"] } } });
			if (mode === "revoked") rows.push({ kind: "actorLeft", actorId: "kit-granter", data: { actorId: actor.id } });
			rows.push({ kind: "position", data: { to: `${sessionId}-e4` } });
			const entries = rows.map((e, i) => ({ ...e, id: `${sessionId}-e${i}`, parentId: i ? `${sessionId}-e${i - 1}` : null, sessionId, time: Date.now(), writer: "kit-history-fixture", modelVisible: false }));
			const base = store.path(sessionId);
			await store.json(base, "PUT", { project, created: Date.now() });
			const { lease } = await store.json(base + "/lease", "POST", { owner: randomUUID() });
			await store.json(base + "/entries", "POST", { lease, entries });
			await store.json(base + "/lease/" + encodeURIComponent(lease), "DELETE");
			return sessionId;
		};
		const load = async (sessionId) => within(await reopenWatchdog(), s.ctx.request(methods.agent.session.load, { sessionId, cwd: project, mcpServers: [] }), "seeded portable load").catch((e) => e);
		const forbidden = (r) => r?.code === -32602 && r?.data?.code === "forbidden";
		const revoked = await seed("revoked");
		const denied = await load(revoked);
		check("portable: a revoked configured actor cannot reopen on another branch", forbidden(denied));
		if (!denied?.code && !(denied instanceof Error)) await closeSession(s, revoked);
		const narrowed = await seed("rights");
		const opened = await load(narrowed);
		check("portable: a known actor can reopen with its recorded narrower rights", meta(opened)?.declaration?.portableSessions === true);
		const openRights = !opened?.code && !(opened instanceof Error);
		const deniedSetting = openRights && await setOption(s, narrowed, "model", "conformance/echo").catch((e) => e);
		check("portable: reopen does not restore a recorded actor's settings right", forbidden(deniedSetting));
		if (openRights) await closeSession(s, narrowed);
		const unknown = await seed("approval");
		const r = await load(unknown);
		const approval = (r.configOptions ?? []).find((o) => o.id === "approval");
		if (approval) {
			check("portable: unknown approval value is displayed as never", approval.currentValue === "never");
			const n = s.permissions.length;
			s.state.permissionAnswer = "refuse";
			await within(15000, prompt(s, unknown, 'tool:bash {"command":"echo no > unknown-approval.txt"}'), "tool under unknown policy").catch(() => undefined);
			const raw = await store.pages(unknown);
			check("portable: unknown approval refuses without asking or dispatching", s.permissions.length === n && !existsSync(join(project, "unknown-approval.txt")) && raw.some((e) => e.kind === "toolResult" && e.data?.status === "refused"));
		}
		if (!r?.code && !(r instanceof Error)) await closeSession(s, unknown);
	} finally { await stop(s); }
});

// Plugin binding: Model attempt sequences (crash recovery). Seed interrupted attempts in shared data.
if (probeChecks && portableChecks) for (const [mode, safe] of [
	["transient", false], ["fresh", false], ["fresh", true], ["repeat", true],
]) await attempt(`remote recovery: ${mode} with ${safe ? "repeatable" : "unsafe"} attempt`, async () => {
	const sid = `kit-runtime-${randomUUID()}`, turnId = "interrupted-turn";
	const model = { provider: "kit-recovery", id: "echo" };
	const role = `runtime-${mode}-${safe}`;
	const plugin = { command: [process.execPath, new URL("../plugin/recovery.mjs", import.meta.url).pathname],
		config: { sessionId: sid, mode, safe, out: probeOut(role) } };
	const remote = connect(command, { MODULAR_AGENT_PLUGINS: JSON.stringify([plugin]) });
	try {
		const init = await remote.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
		const principal = meta(init)?.actor;
		if (!principal?.id || !principal.kind) throw Error("reopener did not identify a configured actor");
		const rights = ["watch", "input", "settings", "cancel"];
		const actor = { id: principal.id, kind: principal.kind, rights };
		const authorizers = [{ sessionId: sid, actorId: actor.id }];
		const content = [{ type: "text", text: "Recover this fixture input" }];
		const message = { role: "user", content };
		const system = "Fixture checkpoint";
		const request = { systemPrompt: system, messages: [message], tools: [], settings: {} };
		const inputId = "fixture-input";
		const entryId = (i) => `entry-${i}`;
		const rows = [
			{ kind: "actorJoined", data: { actor, operatorAdmission: true } },
			{ kind: "setting", data: { key: "model", value: model } },
			{ kind: "inputAccepted", inputId, actorId: actor.id, data: { when: "now", taken: "now", content, authorizers, rights } },
			{ kind: "turnStart", turnId, data: { startedBy: { kind: "actor", id: actor.id }, model, system, tools: [], settings: {}, authorizers, rights } },
			{ kind: "input", turnId, inputId, actorId: actor.id, message, modelVisible: true },
			{ kind: "modelRequest", turnId, stepId: "old-step", data: { model, safeToRepeat: safe, ...(safe ? { request } : {}) }, sources: [entryId(4)] },
		];
		const time = Date.now();
		const entries = rows.map((row, i) => ({ sessionId: sid, time, writer: "kit-history-fixture", modelVisible: false,
			id: entryId(i), parentId: i ? entryId(i - 1) : null, ...row }));
		const base = store.path(sid);
		await store.json(base, "PUT", { project, created: time });
		const { lease } = await store.json(base + "/lease", "POST", { owner: randomUUID() });
		await store.json(base + "/entries", "POST", { lease, entries });
		await store.json(base + "/lease/" + encodeURIComponent(lease), "DELETE");
		await within(await reopenWatchdog(), remote.ctx.request(methods.agent.session.load, { sessionId: sid, cwd: project, mcpServers: [] }), "load interrupted remote Runtime");
		const terminal = (es) => es.find((e) => e.kind === "turnEnd" && e.turnId === turnId);
		const kept = await waitFor(remote, sid, (es) => !!terminal(es), 8000);
		const aborted = (es) => es.filter((e) => e.kind === "response" && e.turnId === turnId && e.stepId === "old-step" &&
			e.message?.stop === "aborted" && e.data?.recovery === true && e.modelVisible === false).length === 1;
		const intent = (es) => es.filter((e) => e.kind === "modelRequest" && e.turnId === turnId && e.stepId !== "old-step");
		const log = trace(role);
		const resume = log.find((x) => x.resume);
		const prepared = log.find((x) => x.prepared);
		const dispatched = log.filter((x) => x.provider);
		const label = `Model attempt sequences (${mode}, safeToRepeat=${safe})`;
		check(`${label}: resume uses the interrupted turn id and checkpoint`, resume?.turnId === turnId &&
			resume.resume.turnId === turnId && equal(resume.resume.calls, []) &&
			resume.log.some((e) => e.kind === "turnStart" && e.turnId === turnId && e.data?.system === system) &&
			resume.log.some((e) => e.kind === "input" && e.turnId === turnId && equal(e.message, message)));
		if (!safe) check(`${label}: unsafe attempt is aborted before resumeTurn`, !!resume && aborted(resume.log));
		if (mode === "transient") {
			check(`${label}: transient recovery ends the turn without a new model attempt`, !!terminal(kept) &&
				terminal(kept).data?.outcome?.kind !== "completed" && !dispatched.length && intent(await store.pages(sid)).length === 0);
		} else {
			const saved = dispatched[0]?.log ?? [];
			const beforeEffect = intent(saved);
			check(`${label}: old attempt closes before one fresh checkpointed dispatch`, dispatched.length === 1 &&
				aborted(saved) && beforeEffect.length === 1 && equal(beforeEffect[0].data?.model, model) &&
				terminal(kept)?.data?.outcome?.kind === "completed");
			if (mode === "repeat") {
				check(`${label}: exact repeat stays unmatched at resume and replays the effective request without prepareStep`,
					!!resume && !resume.log.some((e) => e.kind === "response" && e.stepId === "old-step") && !prepared &&
					equal(dispatched[0]?.provider, request) && equal(beforeEffect[0]?.data?.request, request));
			} else {
				check(`${label}: fresh prepareStep has already settled the old intent`, !!prepared && aborted(prepared.log) &&
					prepared.prepared === beforeEffect[0]?.stepId);
			}
		}
		await closeSession(remote, sid);
	} finally { await stop(remote); }
});

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
		const loaded = await within(await reopenWatchdog(), agent.ctx.request(methods.agent.session.load, { sessionId: sid, cwd: project, mcpServers: [] }), "session/load after the crash");
		validateDeclaration("jobs recovery load", meta(loaded)?.declaration);
		const entries = await waitFor(agent, sid, (x) => meta(loaded)?.declaration?.startsTurnsUnasked === "jobReports" ? said(x, "echo: background: kit-survivor (taken up)") : x.some((e) => e.kind === "jobEnded" && e.jobId === jobId), 20000);
		const ended = entries.filter((e) => e.kind === "jobEnded" && e.jobId === jobId);
		check("jobs after a crash: the reopening agent's plugin took the job up, and it ended once", ended.length === 1 && ended[0].data?.outcome?.kind === "completed", String(JSON.stringify(ended)).slice(0, 200));
		// Jobs and Shared data: Job reports. Acceptance is distinct from scheduling.
		check("Jobs: resuming an already running job on the same plugin connection is invalid_request", trace("jobs").some((x) => x.resumed === jobId && x.duplicateRefused === true));
		check("jobs after a crash: one resumed execution admits one report", trace("jobs").filter((x) => x.resumed === jobId).length === 1 && entries.filter((e) => e.kind === "inputAccepted" && e.data?.key === `job:${jobId}`).length === 1);
		if (meta(loaded)?.declaration?.startsTurnsUnasked === "jobReports") check("jobs after a crash: its report ran as a turn", said(entries, "echo: background: kit-survivor (taken up)"));
		await agent.ctx.request(methods.agent.session.close, { sessionId: sid });
		await stop(agent);
	});
}

// Plugin binding: Jobs. Surface asynchronous fixture failures.
if (jobChecks) check("jobs fixture has no unexpected callback failures", !trace("jobs").some((x) => x.startFailed || x.endFailed || x.takeUpFailed));

if (portableChecks) {
	await attempt("portable", async () => {
		// Shared data: Portable sessions. Check both peers' session declarations.
		check("portable: writer and reopener declare portableSessions", portableDeclarations.length === 2 && portableDeclarations.every(Boolean));
		const problems = [];
		let count = 0;
		for (const sid of sessionsUsed) {
			try {
				const entries = await store.pages(sid);
				count += entries.length;
				problems.push(...portableProblems(sid, entries));
				if (!entries.some((e) => e.kind === "inputAccepted")) problems.push(`${sid}: missing input admission`);
			} catch (e) { problems.push(`${sid}: ${e.message}`); }
		}
		check("portable: exercised sessions are present in the history service", count > 0);
		check("portable: sampled logs have shared record fields, topology and key associations", problems.length === 0, problems.slice(0, 8).join("; "));
		if (erasedForPortable) {
			const kept = (await store.pages(erasedForPortable.sid)).find((e) => e.id === erasedForPortable.id);
			check("portable: an erased tool result keeps its turnId and toolCallId in the service", kept?.erased === true && kept.turnId === erasedForPortable.turnId && kept.toolCallId === erasedForPortable.toolCallId && !("message" in kept), String(JSON.stringify(kept)).slice(0, 200));
		}
	});
}


observer?.stop();
for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
rmSync(dataDir, { recursive: true, force: true });
rmSync(dataDir2, { recursive: true, force: true });
rmSync(probeDir, { recursive: true, force: true });
rmSync(project, { recursive: true, force: true });
rmSync(home, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
