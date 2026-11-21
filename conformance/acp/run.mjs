#!/usr/bin/env node
// Conformance kit for the ACP host binding, modular-agent-acp/1 and /2 (docs/bindings/acp.md).
// Usage: node run.mjs [--verbose] [options] -- <agent command> [args...] [--then <second agent command> [args...]]
// The agent is started in conformance mode, with a fresh data folder and project, and driven with the
// official ACP client library. No external model. Service options use a disposable history service.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { historyService } from "./history.mjs";
import { portableProblems } from "./portable.mjs";
import { manageServices } from "./service.mjs";
import { capacity, erasure, isolation } from "./production.mjs";
import { ACP_PROTOCOL, checkUpgrades, CONTROL_MS, readToken, socketPeer, websocketOptions } from "../tools/websocket.mjs";

const args = process.argv.slice(2);
const dash = args.indexOf("--");
const argv = dash < 0 ? args : args.slice(0, dash);
let network, serviceCommand, expectedActor, otherToken;
try {
	const options = websocketOptions(argv);
	network = options && { ...options, tokenFile: resolve(options.tokenFile), protocol: ACP_PROTOCOL };
	const option = (key) => {
		const i = argv.indexOf(key);
		if (i < 0) return;
		if (!argv[i + 1] || argv[i + 1].startsWith("--") || argv.lastIndexOf(key) !== i) throw new Error(`${key} needs one value`);
		return argv[i + 1];
	};
	serviceCommand = option("--service-command");
	expectedActor = option("--actor");
	const otherFile = option("--other-token-file");
	if (network ? dash >= 0 : serviceCommand || expectedActor || otherFile || dash < 0 || dash === args.length - 1) throw new Error("choose a stdio command or a WebSocket URL");
	if (otherFile) {
		otherToken = readToken(otherFile);
		if (otherToken === network.token) throw new Error("--other-token-file must hold a different token");
	}
} catch (e) {
	console.error(`${e.message}\nUsage: node run.mjs [options] (-- <agent command> [args...] [--then <second command> [args...]] | --connect URL --token-file FILE [--service-command COMMAND] [--actor ID] [--other-token-file FILE])`);
	process.exit(2);
}
const canConfigure = !network || !!serviceCommand;
const verbose = argv.includes("--verbose");
// With --plugin-checks, also check the conformance plugin's hooks are in force (docs/bindings/plugin.md).
const pluginChecks = argv.includes("--plugin-checks");
// With --crash-checks, also kill the agent with SIGKILL during a bash call, reopen the session in a new
// process, and check the turn ends as the agent declared: carried on (continuesAfterRestart) or failed.
const crashChecks = argv.includes("--crash-checks") && canConfigure;
if (argv.includes("--crash-checks") && !crashChecks) console.log("SKIP  --crash-checks (killing and restarting a service requires --service-command)");
// With --probe-checks, also load the probe plugin (../plugin/probe.mjs), which checks the host side of the plugin binding.
const probeChecks = argv.includes("--probe-checks") && canConfigure;
if (argv.includes("--probe-checks") && !probeChecks) console.log("SKIP  --probe-checks (injecting fixture plugins and collecting their traces requires --service-command)");
// With --job-checks, also load the jobs plugin (../plugin/jobs.mjs): jobs recorded in the standard kinds, reported,
// cancelled, and taken up after a kill -9 by whichever agent reopens the session (with --then, the second).
const jobChecks = argv.includes("--job-checks") && canConfigure;
if (argv.includes("--job-checks") && !jobChecks) console.log("SKIP  --job-checks (injecting the jobs fixture requires --service-command)");
// With --portable-checks, sample the persisted fixture sessions against the shared shapes
// (docs/bindings/data.md#portable-sessions). It needs MODULAR_AGENT_HISTORY_URL and MODULAR_AGENT_HISTORY_TOKEN_FILE.
const portableChecks = argv.includes("--portable-checks");
const productionChecks = [
	["--isolation-checks", isolation], ["--capacity-checks", capacity], ["--erasure-checks", erasure],
].filter(([flag]) => argv.includes(flag));
const productionOnly = argv.includes("--production-only");
if (productionOnly && !productionChecks.length) {
	console.error("--production-only needs an ADR 0030 check option");
	process.exit(2);
}
if (productionChecks.length && !canConfigure) {
	console.error("ADR 0030 checks on WebSocket require --service-command");
	process.exit(2);
}
// With --then, load and recovery reopenings use the second stdio agent.
const rest = network ? [] : args.slice(dash + 1);
const then = rest.indexOf("--then");
const command = then < 0 ? rest : rest.slice(0, then);
const second = then < 0 ? command : rest.slice(then + 1);
if (!network && (!command.length || !second.length)) {
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

const portablePair = portableChecks || then >= 0;
const portableActor = "kit-portable-writer";
const otherActor = "kit-portable-reopener";
const home = mkdtempSync(join(tmpdir(), "ma-conf-home-"));
const env = Object.fromEntries(["PATH", "MODULAR_AGENT_HISTORY_URL", "MODULAR_AGENT_HISTORY_TOKEN_FILE"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
let store, observer;
if (env.MODULAR_AGENT_HISTORY_URL || env.MODULAR_AGENT_HISTORY_TOKEN_FILE || portableChecks || then >= 0 || argv.includes("--erasure-checks")) {
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
const probePlugin = (role, config = {}) => ({ command: [process.execPath, new URL("../plugin/probe.mjs", import.meta.url).pathname], config: { role, out: probeOut(role), ...config } });
const pluginEnv = {};
{
	const extra = [];
	if (probeChecks) extra.push(
		probePlugin("probe", { release: probeOut("release-refresh"), traceOut: probeOut("probe-events") }),
		probePlugin("output-observer", { withholdLoad: probeOut("withhold-load") }),
	);
	if (jobChecks) extra.push({ command: [process.execPath, new URL("../plugin/jobs.mjs", import.meta.url).pathname], config: { out: probeOut("jobs") } });
	const given = process.env.MODULAR_AGENT_PLUGINS ? JSON.parse(process.env.MODULAR_AGENT_PLUGINS) : [];
	if (extra.length || given.length) pluginEnv.MODULAR_AGENT_PLUGINS = JSON.stringify([...given, ...extra]);
}
const sessionsUsed = [];
// Tenants every agent is started with, for the tenant checks (docs/bindings/data.md#limits-and-tenants).
const TENANTS = readFileSync(new URL("./tenants.json", import.meta.url), "utf8");
const project = mkdtempSync(join(tmpdir(), "ma-conf-project-"));
// A git work tree, so an environment that keeps points in git can declare rewinding
// here. An environment that copies the project copies .git with it, unchanged.
spawnSync("git", ["init", "-q", project], { stdio: "ignore" });
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

const agentEnv = (which, extraEnv) => ({ ...env, ...(observer ? { MODULAR_AGENT_HISTORY_URL: observer.url } : {}), HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, LANG: "C.UTF-8", ...pluginEnv, ...(!network && portablePair ? { MODULAR_AGENT_ACTOR: portableActor } : {}), MODULAR_AGENT_TENANTS: TENANTS, MODULAR_AGENT_CONFORMANCE: "1", MODULAR_AGENT_DATA_DIR: which === command ? dataDir : dataDir2, ...extraEnv });
const managed = serviceCommand && manageServices(network, serviceCommand, project, (extraEnv) => agentEnv(command, extraEnv), verbose);

function spawnAgent(which, extraEnv, captureStderr = false) {
	const child = spawn(which[0], which.slice(1), {
		cwd: project,
		stdio: ["pipe", "pipe", captureStderr ? "pipe" : verbose ? "inherit" : "ignore"],
		env: agentEnv(which, extraEnv),
	});
	children.push(child);
	return child;
}

// The SDK takes streams of message objects, not lines. One WebSocket message
// is one object even when its JSON contains newlines.
function webTransport(service, token) {
	let peer, ended = false, input;
	const closed = service.then(async (listener) => {
		if (ended) return { code: 1006 };
		peer = socketPeer({ ...network, url: listener?.url ?? network.url, token, retry: !!listener }, (_, rpc) => {
			if (!ended && rpc && typeof rpc === "object" && !Array.isArray(rpc)) input.enqueue(rpc);
			else peer.end();
		});
		return peer.closed;
	});
	const end = () => { peer?.end(); };
	const readable = new ReadableStream({
		start(controller) {
			input = controller;
			void closed.then(() => { if (!ended) controller.close(); }, (err) => { if (!ended) controller.error(err); });
		},
		cancel() { ended = true; end(); },
	});
	const writable = new WritableStream({
		async write(rpc) {
			await service;
			if (!peer) throw new Error("WebSocket connection closed");
			await peer.ready;
			if (!peer.send(JSON.stringify(rpc), rpc)) throw new Error("WebSocket connection closed");
		},
		close: end,
		abort: end,
	});
	return { readable, writable, closed, end };
}

/** Connect the official ACP client to a process or service. */
function connect(which = command, extraEnv = {}, token = network?.token, sharedListener) {
	const child = network ? null : spawnAgent(which, extraEnv);
	const variant = !sharedListener && !!managed && Object.keys(extraEnv).length > 0;
	const service = sharedListener ?? (variant ? managed.variant(extraEnv) : Promise.resolve(managed ? managed.primary() : null));
	const wire = network && webTransport(service, token);
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
	const connection = app.connect(wire || ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
	return { child, service, variant, wire, ctx: connection.agent, updates, permissions, state };
}
async function stop(agent) {
	if (agent.wire) {
		agent.wire.end();
		try { await within(CONTROL_MS, agent.wire.closed, "WebSocket close"); }
		catch { /* still stop the managed variant */ }
		finally { if (agent.variant) await managed.stop(await agent.service); }
		return;
	}
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
async function crash(agent) {
	if (agent.wire) {
		await managed.stop(await agent.service, "SIGKILL");
		await within(CONTROL_MS, agent.wire.closed, "connection loss after service crash");
		return;
	}
	const exited = new Promise((resolve) => agent.child.once("exit", resolve));
	if (!agent.child.kill("SIGKILL")) throw Error("could not interrupt the fixture host");
	await within(CONTROL_MS, exited, "interrupted host exit");
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

// ACP: Prompts and Conformance mode. Contracts: Tool dispatch and Recovery and repeating work.
function checkDeniedTool(name, reply, entries, marker) {
	const { inputId, outcome } = meta(reply) ?? {};
	const turnId = inputId && entries.find((e) => e.kind === "input" && e.inputId === inputId)?.turnId;
	const rows = turnId ? entries.filter((e) => e.turnId === turnId) : [];
	const results = rows.filter((e) => e.kind === "toolResult");
	const refused = reply.stopReason === "end_turn" && outcome?.kind === "completed" &&
		results.length === 1 && results[0].data?.status === "refused";
	// ACP exposes a failure description, not the Provider's structured error. It can include the kind.
	const omitted = reply.stopReason === "refusal" && outcome?.kind === "failed" &&
		typeof outcome.error === "string" && /(?:^|: )Invalid tool directive$/.test(outcome.error) && results.length === 0;
	const started = rows.some((e) => e.kind === "toolStarted");
	const ran = existsSync(join(project, marker));
	check(name, !!turnId && (refused || omitted) && !started && !ran,
		JSON.stringify({ stopReason: reply.stopReason, outcome, turnId, started, ran, results: results.map((e) => e.data?.status) }));
}

let sessionId, mainSession, writerActor, tokenActor;
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
if (productionOnly) {
	await runProduction();
	await finish();
}
let agent = connect();

await attempt("initialize", async () => {
	const init = await within(15000, agent.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} }), "initialize");
	check("initialize: protocol version 1", init.protocolVersion === 1, `got ${init.protocolVersion}`);
	const m = meta(init);
	writerActor = m?.actor?.id;
	tokenActor = m?.actor;
	if (network && expectedActor) check("WebSocket: the supplied token selects the expected actor", writerActor === expectedActor);
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

if (network) {
	await checkUpgrades(network, check, attempt);
	if (!canConfigure && portableChecks) console.log("SKIP  portable fork and reopen-hold wire interception (requires a managed service)");
}

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

// Edition 4 draft. Contracts: Nested calls. ACP: Updates and Conformance mode. Runs only for an agent that declares it.
if (decl.nestedToolCalls === true) await attempt("nested calls", async () => {
	writeFileSync(join(project, "nested.txt"), "nested-harbour\n");
	const before = agent.updates.length;
	const r = await within(15000, prompt(agent, sessionId, 'tool:nest {"name":"read","input":{"path":"nested.txt"}}'), "nested prompt");
	check("nested: the turn ends", r.stopReason === "end_turn", r.stopReason);
	const seen = agent.updates.slice(before).filter((u) => u.sessionId === sessionId);
	const reply = seen.filter((u) => u.update.sessionUpdate === "agent_message_chunk").map((u) => u.update.content?.text ?? "").join("");
	check("nested: the parent settles with the nested call's content", reply.startsWith("done: nested-harbour"), JSON.stringify(reply).slice(0, 160));
	const announced = seen.filter((u) => u.update.sessionUpdate === "tool_call");
	const parent = announced.find((u) => u.update.title === "nest");
	const child = announced.find((u) => u.update.title === "read");
	check("nested: both calls are announced with tool_call", !!parent && !!child, announced.map((u) => u.update.title).join(","));
	check("nested: the nested call's first update names its parent", !!child && meta(child.update)?.parentToolCallId === parent?.update.toolCallId, JSON.stringify(meta(child?.update) ?? null));
	check("nested: the parent's first update names no parent", !!parent && meta(parent.update)?.parentToolCallId === undefined);
	const settled = seen.filter((u) => u.update.sessionUpdate === "tool_call_update" && u.update.toolCallId === child?.update.toolCallId && ["completed", "failed"].includes(u.update.status));
	check("nested: the nested call settles exactly once, completed", settled.length === 1 && settled[0].update.status === "completed", settled.map((u) => u.update.status).join(","));
	const { entries } = await history(agent, sessionId, { all: true });
	const started = entries.filter((e) => e.kind === "toolStarted" && e.toolCallId === child?.update.toolCallId);
	check("nested: one recorded start, by a tool, under its parent", started.length === 1 && started[0].data?.call?.startedBy === "tool" && started[0].data?.call?.parentCallId === parent?.update.toolCallId, JSON.stringify(started[0]?.data?.call ?? null).slice(0, 200));
	const parentStart = entries.find((e) => e.kind === "toolStarted" && e.toolCallId === parent?.update.toolCallId);
	check("nested: it shares its parent's turn and step", !!started[0] && started[0].turnId === parentStart?.turnId && started[0].stepId === parentStart?.stepId);
	const results = entries.filter((e) => e.kind === "toolResult" && e.toolCallId === child?.update.toolCallId);
	check("nested: one recorded result", results.length === 1 && results[0].data?.status === "completed", JSON.stringify(results.map((e) => e.data?.status)));
	// The model saw its own call and that call's result, not the nested one.
	const response = entries.filter((e) => e.kind === "response").at(-1);
	const callsInResponses = entries.filter((e) => e.kind === "response").flatMap((e) => (e.message?.content ?? []).filter((c) => c.type === "toolCall").map((c) => c.id));
	check("nested: no model response holds the nested call", !!response && !callsInResponses.includes(child?.update.toolCallId));

	// A name with no registered tool is still a recorded call, settled as refused.
	const b2 = agent.updates.length;
	const r2 = await within(15000, prompt(agent, sessionId, 'tool:nest {"name":"kit-no-such-tool","input":{}}'), "nested unknown prompt");
	check("nested: an unknown tool still ends the turn", r2.stopReason === "end_turn", r2.stopReason);
	const ghost = agent.updates.slice(b2).find((u) => u.sessionId === sessionId && u.update.sessionUpdate === "tool_call" && u.update.title === "kit-no-such-tool");
	const after = (await history(agent, sessionId, { all: true })).entries;
	const ghostResult = after.filter((e) => e.kind === "toolResult" && e.toolCallId === ghost?.update.toolCallId);
	check("nested: an unknown tool is recorded and refused, never started", !!ghost && ghostResult.length === 1 && ghostResult[0].data?.status === "refused" && !after.some((e) => e.kind === "toolStarted" && e.toolCallId === ghost.update.toolCallId), JSON.stringify(ghostResult.map((e) => e.data?.status)));
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
		if (network) {
			check("WebSocket: simultaneous connections with the same token have the same actor", !!writerActor && equal(meta(init)?.actor, tokenActor));
			const stillOne = await within(15000, prompt(agent, sessionId, "fail:independent WebSocket connection"), "parallel /1 turn");
			check("WebSocket: concurrent connections retain separate negotiated bindings and updates",
				stillOne.stopReason === "refusal" && meta(stillOne)?.outcome?.kind === "failed" && s2.sessionId !== sessionId &&
				!agent.updates.some((u) => u.sessionId === s2.sessionId) && !two.updates.some((u) => u.sessionId === sessionId));
		}
		await two.ctx.request(methods.agent.session.close, { sessionId: s2.sessionId });
	} finally {
		await stop(two);
	}
});

// ACP: The declaration; Several actors. The connection can offer methods
// that this session doesn't support. Parked-report methods are exempt.
if (["severalActors", "sessionLimits", "tenants"].some((feature) => decl[feature] === false)) {
	await attempt("disabled extensions", async () => {
		// An unexpected success must not leave pending work or change rights in
		// the session used by the other checks.
		const s = await within(15000, agent.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [] }), "open disabled extensions fixture");
		sessionsUsed.push(s.sessionId);
		try {
			for (const [feature, method, params] of [
				["severalActors", "input", { when: "propose", content: "unsupported proposal", key: randomUUID() }],
				["severalActors", "join", { actor: { id: `kit-disabled-${randomUUID()}`, kind: "user", rights: ["watch"] } }],
				["sessionLimits", "limit", { rights: null }],
				["tenants", "tenant", {}],
			]) {
				if (meta(s)?.declaration?.[feature] !== false) continue;
				const label = `disabled ${feature}: ${method} fails not_supported`;
				await attempt(label, async () => {
					const reply = await within(15000, agent.ctx.request(`_${NS}/${method}`, { sessionId: s.sessionId, ...params }).catch((e) => e), label);
					check(label, reply?.code === -32602 && reply?.data?.code === "not_supported", JSON.stringify(reply));
				});
			}
		} finally { await closeSession(agent, s.sessionId); }
	});
}

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
		check("withdraw: the proposal is gone, handed back, and never ran", !after.some((x) => x.inputId === p2.inputId) && es2.some((e) => e.kind === "inputHandedBack" && (e.inputId === p2.inputId || e.data?.inputIds?.includes(p2.inputId))) && !said(es2, "echo: a second proposal"), String(JSON.stringify(after)).slice(0, 200));
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
		checkDeniedTool("limits: no dispatch under a limit without tools", r, (await history(agent, sessionId, { all: true })).entries, "limited.txt");
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
		const { entries } = await history(agent, ro, { all: true });
		const first = entries[0];
		check("tenants: first persisted record names the tenant", first?.kind === "tenant" && first.data?.tenant === "kit-readonly");
		checkDeniedTool("tenants: no dispatch under a tenant ceiling without tools", r, entries, "tenant.txt");
		const broke = await open("kit-broke");
		const b = await within(15000, prompt(agent, broke, "hello broke"), "budget prompt");
		check("tenants: an exhausted budget ends the turn as tenantTokens, max_tokens", b.stopReason === "max_tokens" && meta(b)?.outcome?.limit === "tenantTokens", `${b.stopReason} ${JSON.stringify(meta(b)?.outcome)}`);
		check("tenants: without a model request", !(await history(agent, broke, { all: true })).entries.some((e) => e.kind === "response" || e.kind === "modelRequest"));
		// ACP: Authorization. The readonly session is idle and its member has no cancel right.
		const idle = await closeSession(agent, ro).then(() => true, () => false);
		check("Authorization: a member without cancel can close an idle session", !info.rights?.includes("cancel") && idle);
		await closeSession(agent, broke);
		const busy = await open("kit-no-cancel");
		const marker = join(project, "kit-close-started"), release = join(project, "kit-close-release");
		const pending = prompt(agent, busy, `tool:bash ${JSON.stringify({ command: "touch kit-close-started; for ((i=0; i<200; i++)); do if test -f kit-close-release; then echo finished >> kit-close-started; exit; fi; sleep .1; done" })}`);
		void pending.catch(() => undefined);
		try {
			for (let i = 0; i < 100 && !existsSync(marker); i++) await sleep(50);
			if (!existsSync(marker)) throw Error("the close fixture's tool did not start");
			const before = await history(agent, busy, { all: true });
			const denied = await within(6000, closeSession(agent, busy), "refuse close without cancel").catch((e) => e);
			const after = await history(agent, busy, { all: true }).catch(() => null);
			writeFileSync(release, "");
			const done = await within(6000, pending, "finish the uncancelled turn").catch(() => null);
			check("Authorization: close without cancel is forbidden during a turn and changes nothing", denied?.code === -32602 && denied?.data?.code === "forbidden" &&
				equal(before, after) && done?.stopReason === "end_turn" && readFileSync(marker, "utf8") === "finished\n",
				JSON.stringify({ code: denied?.code, dataCode: denied?.data?.code, stop: done?.stopReason, historyUnchanged: equal(before, after) }));
		} finally { writeFileSync(release, ""); }
		await closeSession(agent, busy).catch(() => undefined);
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
	check("Input admission: input that runs next in an idle session gets now", typeof a.inputId === "string" && a.taken === "now");
	const b = await agent.ctx.request(`_${NS}/input`, { sessionId, content: "different content", when: "after", key: "key-2" });
	check("input: duplicate preserves original receipt and disposition", b.duplicate === true && b.inputId === a.inputId && b.taken === a.taken);
	const p = await within(15000, prompt(agent, sessionId, "from the other method", "key-2"), "duplicate extension input via prompt");
	check("input: prompt and extension share the receipt", meta(p)?.inputId === a.inputId && meta(p)?.duplicate === true);
	const { entries } = await history(agent, sessionId, { all: true });
	const accepted = entries.filter((e) => e.kind === "inputAccepted" && e.inputId === a.inputId);
	const taken = entries.filter((e) => e.kind === "input" && e.inputId === a.inputId);
	const turnId = taken[0]?.turnId;
	check("Entry: top-level inputId links one acceptance and one consumption in one completed turn", accepted.length === 1 && taken.length === 1 && !!turnId && entries.filter((e) => e.kind === "turnStart" && e.turnId === turnId).length === 1 && entries.filter((e) => e.kind === "turnEnd").length === before + 1 && said(entries.filter((e) => e.turnId === turnId), "echo: queued"));
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
		const answers = (await history(agent, sessionId, { all: true })).entries.filter((e) => e.kind === "inputAnswer" && (e.requestId ?? e.data?.requestId) === q.id);
		const marker = join(project, "answer-race.txt");
		check("answer: only the winning approval is recorded and the call runs once", answers.length === 1 && existsSync(marker) && readFileSync(marker, "utf8") === "approved\n");
	} finally {
		release?.({ outcome: { outcome: "selected", optionId: "refuse" } });
		agent.state.permissionHandler = undefined;
		await setOption(agent, sessionId, "approval", "off");
	}
});

// Shared data: General rules; ACP: Starting and Errors. Count the JSON-RPC object as level 1.
for (const depth of [64, 65]) await attempt(`Starting: JSON nesting at ${depth} levels`, async () => {
	const peer = connect(command, network ? {} : { MODULAR_AGENT_PLUGINS: "[]" });
	try {
		const opaque = Array.from({ length: depth - 3 }).reduce((inner) => [inner], 1);
		const r = await within(6000, peer.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {}, _meta: { "kit.depth": opaque } }), "initialize with nested metadata").catch((e) => e);
		check(`Starting: ${depth} JSON levels ${depth === 64 ? "are accepted" : "are accepted or refused as invalid_request"}`,
			r?.protocolVersion === 1 || (depth > 64 && r?.code === -32602 && r?.data?.code === "invalid_request"));
	} finally { await stop(peer); }
});

await attempt("unused session", async () => {
	const s = await agent.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
	await agent.ctx.request(methods.agent.session.close, { sessionId: s.sessionId });
	const l = await agent.ctx.request(methods.agent.session.list, { cwd: project });
	const ids = (l.sessions ?? []).map((x) => x.sessionId);
	check("unused session: not listed after close", !ids.includes(s.sessionId));
	check("session/list: the used session is listed", ids.includes(sessionId), ids.join(", "));
});

// Plugin binding: Choosing plugins at start. Keep these entries out of positive runs.
if (probeChecks) for (const [name, plugins] of [
	["plugin exits before registration", [{ command: [process.execPath, "-e", "process.exit(0)"] }]],
	["unknown hook", [probePlugin("refuse-hook")]],
	["replacement without a registration", [probePlugin("refuse-replace")]],
	["duplicate replacement", [probePlugin("refuse-duplicate-replacement")]],
	["duplicate plugin name", [probePlugin("probe"), probePlugin("refuse-duplicate")]],
	["unlisted tool collision", [probePlugin("probe"), probePlugin("refuse-collision")]],
]) await attempt(`Choosing plugins at start (${name})`, async () => {
	const settings = { MODULAR_AGENT_PLUGINS: JSON.stringify(plugins), MODULAR_AGENT_DATA_DIR: mkdtempSync(join(probeDir, "startup-")) };
	if (network) {
		const peer = connect(command, settings);
		try {
			const init = peer.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
			const seen = await within(15000, Promise.race([init.then(() => ({ initialized: true }), () => peer.wire.closed), peer.wire.closed]), "startup failure or successful initialize");
			const service = await peer.service;
			const exit = seen.code === 1006 && await Promise.race([service.exited, sleep(50).then(() => null)]);
			check(`Choosing plugins at start (${name}): refuses the connection or closes with failure before initialize`,
				!seen.initialized && (seen.code === 1011 || (exit?.code != null && exit.code !== 0)), JSON.stringify(seen));
		} finally { await stop(peer); }
		return;
	}
	const child = spawnAgent(command, settings);
	const lines = createInterface({ input: child.stdout });
	try {
		// Observe the wire and the natural exit. Do not close stdin or signal the host to make it exit.
		const result = new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => resolve({ code, signal }));
			lines.on("line", (line) => {
				let m;
				try { m = JSON.parse(line); } catch { return; }
				if (m?.jsonrpc === "2.0" && m.id === 1 && Object.hasOwn(m, "result") && !Object.hasOwn(m, "error")) resolve({ initialized: true });
			});
		});
		child.stdin.on("error", () => {}); // The host can exit before reading initialize.
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }) + "\n");
		const seen = await within(15000, result, "startup failure or successful initialize");
		check(`Choosing plugins at start (${name}): exits nonzero without a successful initialize`, Number.isInteger(seen.code) && seen.code !== 0, JSON.stringify(seen));
	} finally { lines.close(); await stop({ child }); }
});

if (probeChecks) {
	await attempt("probe", async () => {
		await within(15000, prompt(agent, sessionId, "probe seed"), "pre-seed probe history");
		const r = await within(30000, prompt(agent, sessionId, "tool:probe {}"), "probe prompt");
		check("probe: the turn ends", r.stopReason === "end_turn", r.stopReason);
		const checks = existsSync(probeOut("probe")) ? JSON.parse(readFileSync(probeOut("probe"), "utf8")) : [];
		check("probe: the probe ran", checks.length > 0, "no results; was the tool called?");
		for (const c of checks) check(`probe: ${c.name}`, c.ok, c.detail);
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
			// Contracts, Hook execution: step.after runs once the step's calls are settled or left open, so leaving a call open is a normal end.
			const originatingEnd = (await history(agent, sessionId, { all: true })).entries.find((e) => e.kind === "turnEnd" && e.turnId === originatingTurn);
			check("late question: the original turn completed, with step.after accepted for its open call", originatingEnd?.data?.outcome?.kind === "completed", JSON.stringify(originatingEnd?.data?.outcome ?? null));
		}
		const answer = () => agent.ctx.request(`_${NS}/answer`, { sessionId, requestId: question.id, value: "fixture value" });
		const pair = await Promise.all([answer(), answer()]);
		check(`${late ? "late" : "in-turn"} question: two valid replies produce one acceptance`, pair.filter((r) => r.accepted === true).length === 1 && pair.some((r) => equal(r, { accepted: false, reason: "not_open" })));
		if (!late) await within(10000, pending, "tool receives its text answer");
		const entries = await waitFor(agent, sessionId, (es) => es.some((e) => e.kind === "toolResult" && e.toolCallId === question.toolCallId && JSON.stringify(e.message?.content).includes("fixture answer: fixture value")), 8000);
		check(`${late ? "late" : "in-turn"} question: one value record and one tool result for the original call`, entries.filter((e) => e.kind === "inputAnswer" && (e.requestId ?? e.data?.requestId) === question.id && e.data?.value === "fixture value").length === 1 && entries.filter((e) => e.kind === "toolResult" && e.toolCallId === question.toolCallId).length === 1);
		if (late) check("late question: exactly one continuation names the originating turn", !!originatingTurn && entries.filter((e) => e.kind === "turnStart" && (e.continuesTurnId ?? e.data?.continuesTurnId) === originatingTurn && e.data?.startedBy?.id === question.id).length === 1);
		if (late && portableChecks && decl.portableSessions) {
			const raw = await store.pages(sessionId);
			const callRows = raw.filter((e) => e.toolCallId === question.toolCallId);
			const opened = callRows.find((e) => e.kind === "inputRequest" && e.requestId === question.id);
			const start = callRows.find((e) => e.kind === "toolStarted" && e.turnId === originatingTurn);
			const held = callRows.filter((e) => e.kind === "toolPending" && e.turnId === originatingTurn);
			const end = raw.find((e) => e.kind === "turnEnd" && e.turnId === originatingTurn);
			check("Recording order and ownership: toolPending names the call, relinquished start and question before turnEnd", !!start && !!opened && held.length === 1 && held[0].stepId === start.stepId &&
				held[0].data?.toolStartedId === start.id && equal(held[0].data?.requestIds, [question.id]) && raw.indexOf(opened) < raw.indexOf(held[0]) && raw.indexOf(held[0]) < raw.indexOf(end));
			const next = raw.find((e) => e.kind === "turnStart" && e.continuesTurnId === originatingTurn);
			const invoked = callRows.find((e) => e.kind === "toolStarted" && e.turnId === next?.turnId);
			const settled = callRows.find((e) => e.kind === "toolResult");
			const answer = callRows.find((e) => e.kind === "inputAnswer" && e.requestId === question.id);
			check("Call identities and mappings: continuation records retain the old step and call but use the executing turn", !!next && !!start && !!invoked && !!settled &&
				invoked.stepId === start.stepId && settled.stepId === start.stepId && settled.turnId === next.turnId && answer?.turnId === originatingTurn && answer?.stepId === start.stepId);
		}
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

	// ACP: Sessions and Output gate. Withhold only the complete open result, not the replay events.
	await attempt("withheld load replay", async () => {
		const s = await agent.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
		const sid = s.sessionId;
		sessionsUsed.push(sid);
		await setOption(agent, sid, "model", "conformance/echo");
		await within(15000, prompt(agent, sid, "fixture load replay"), "seed load replay");
		await closeSession(agent, sid);
		writeFileSync(probeOut("withhold-load"), sid);
		const load = () => agent.ctx.request(methods.agent.session.load, { sessionId: sid, cwd: project, mcpServers: [] });
		const mark = agent.updates.length;
		try {
			const reply = await within(await reopenWatchdog(), load(), "withheld load").catch((e) => e);
			check("Sessions: withheld session/load does not replay any updates", reply?.code === -32000 && reply?.data?.code === "withheld" &&
				trace("output-observer").some((e) => e.withheldLoad === sid) && !agent.updates.slice(mark).some((u) => u.sessionId === sid));
		} finally { rmSync(probeOut("withhold-load"), { force: true }); }
		const retry = agent.updates.length;
		await within(await reopenWatchdog(), load(), "retry gated load");
		check("Sessions: successful retry replays the withheld session", textOf(agent.updates.slice(retry), sid).includes("echo: fixture load replay"));
		await closeSession(agent, sid);
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
			if (portableChecks && meta(s)?.declaration?.portableSessions) {
				const raw = (await store.pages(sid)).find((e) => e.kind === "inputRequest" && (e.requestId ?? e.data?.request?.id) === id);
				const binding = raw?.data;
				check("Standard kinds / Questions: approval records the exact call, registration source and definition", !!raw?.toolCallId && binding?.call?.id === raw.toolCallId && binding?.call?.name === "bash" &&
					equal(binding.call.input, { command: "echo ran > kit-gated-approval.txt" }) &&
					["plugin", "toolSource"].every((k) => typeof binding.source?.[k] === "string" && binding.source[k].length > 0) && binding.definition?.name === binding.call.name &&
					typeof binding.definition.description === "string" && Object.hasOwn(binding.definition, "parameters"));
			}
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

	// ACP: Request. Keep the standard permission route exact and change only the polling view.
	if (agent.state.hasApproval) await attempt("Request: approval projection after gating", async () => {
		const s = await agent.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
		const sid = s.sessionId;
		sessionsUsed.push(sid);
		let release;
		agent.state.permissionHandler = () => new Promise((resolve) => { release = resolve; });
		try {
			await setOption(agent, sid, "model", "conformance/echo");
			await setOption(agent, sid, "approval", "all");
			const pending = prompt(agent, sid, 'tool:bash {"command":"echo ran > kit-list-redact.txt"}');
			void pending.catch(() => undefined);
			let view;
			for (let i = 0; i < 100 && !release; i++) await sleep(50);
			if (release) view = await agent.ctx.request(`_${NS}/requests`, { sessionId: sid }).catch((e) => e);
			const gateViews = trace("output-observer").filter((p) => p.sessionId === sid).flatMap((p) => p.events ?? [])
				.filter((e) => e.type === "reply" && e.data?.method === `_${NS}/requests`)
				.flatMap((e) => e.data.result?.requests ?? []).filter((q) => q.kind === "approval");
			check("Request: the output gate does not see answerable on the approval projection", !!release && gateViews.length > 0 && gateViews.every((q) => !Object.hasOwn(q, "answerable")));
			check("Request: the redacted approval projection is returned with answerable false", view?.requests?.some((q) => q.kind === "approval" && q.id === gateViews[0]?.id && q.question === "Redacted approval question" && q.answerable === false));
			release?.({ outcome: { outcome: "selected", optionId: "allow" } });
			await within(10000, pending, "finish after the exact permission view answers");
		} finally {
			release?.({ outcome: { outcome: "cancelled" } });
			delete agent.state.permissionHandler;
			await closeSession(agent, sid);
		}
	});

	// Contracts: Moving and rewinding; Plugin binding: Paths and points.
	await attempt("Moving and rewinding: remote point preflight", async () => {
		const role = "remote-points";
		const plugin = { command: [process.execPath, new URL("../plugin/probe.mjs", import.meta.url).pathname], config: { role, out: probeOut(role) } };
		const remote = connect(command, { MODULAR_AGENT_PLUGINS: JSON.stringify([plugin]) });
		try {
			await remote.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
			const s = await remote.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
			if (!meta(s)?.declaration?.rewinding) {
				console.log("SKIP  Moving and rewinding: remote point preflight (session does not declare rewinding)");
				return;
			}
			const sid = s.sessionId;
			sessionsUsed.push(sid);
			await setOption(remote, sid, "model", "conformance/echo");
			await within(15000, prompt(remote, sid, "before remote rewind"), "first rewind fixture turn");
			const mark = (await history(remote, sid)).entries.findLast((e) => e.kind === "turnEnd")?.id;
			if (!mark) throw Error("rewind fixture has no quiescent entry");
			const file = join(project, "kit-rewind-remote.txt");
			writeFileSync(file, "before");
			await within(15000, prompt(remote, sid, "second remote rewind turn"), "second rewind fixture turn");
			writeFileSync(file, "after");
			await within(15000, prompt(remote, sid, "third remote rewind turn"), "third rewind fixture turn");
			const before = trace(role);
			const points = before.filter((e) => e.method === "env/save").slice(-2).map((e) => e.point);
			const r = await remote.ctx.request(`_${NS}/move`, { sessionId: sid, entryId: mark, rewind: true }).catch((e) => e);
			const calls = trace(role).slice(before.length);
			const firstChange = calls.findIndex((e) => e.method === "env/save" || e.method === "env/restore");
			const checked = calls.slice(0, firstChange).filter((e) => e.method === "env/checkPoint").map((e) => e.point);
			check("Moving and rewinding / Paths and points: every later point is checked before saving or restoring",
				firstChange >= 0 && points.length === 2 && points.every((p) => checked.includes(p)) && !r?.code &&
				calls.some((e) => e.method === "env/restore" && e.point === points[0]) && readFileSync(file, "utf8") === "before",
				JSON.stringify({ calls, code: r?.code, dataCode: r?.data?.code }));
			await closeSession(remote, sid);
		} finally { await stop(remote); }
	});

	// Plugin binding: Runtime records and effects and Runtime callbacks.
	await attempt("remote Runtime host", async () => {
		const plugin = { command: [process.execPath, new URL("../plugin/probe.mjs", import.meta.url).pathname], config: { role: "runtime", out: probeOut("runtime") } };
		let racePath, heldIntent, releaseIntent;
		const committed = new Promise((resolve) => { heldIntent = resolve; });
		const released = new Promise((resolve) => { releaseIntent = resolve; });
		const tap = store && await store.observe({ beforeReply: async ({ path, entries }) => {
			if (path !== racePath || !entries?.some((e) => e.kind === "modelRequest")) return;
			racePath = undefined;
			heldIntent();
			await released;
		} });
		const remote = connect(command, { MODULAR_AGENT_PLUGINS: JSON.stringify([plugin]), ...(tap ? { MODULAR_AGENT_HISTORY_URL: tap.url } : {}) });
		try {
			await remote.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
			const s = await remote.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
			sessionsUsed.push(s.sessionId);
			await setOption(remote, s.sessionId, "model", "conformance/echo");
			if ((s.configOptions ?? []).some((o) => o.id === "approval")) await setOption(remote, s.sessionId, "approval", "off");
			for (const name of ["omitted", "changed", "exact"]) {
				const before = trace("runtime").filter((x) => x.effect).length;
				await within(15000, prompt(remote, s.sessionId, `tool:probe-effect ${JSON.stringify({ value: name })}`), `remote Runtime fixture: ${name}`).catch(() => undefined);
				const log = trace("runtime");
				const c = log.find((x) => x.test === name)?.checks ?? {};
				check(`remote Runtime ${name}: host rejects record of a host-owned setting`, c.hostKind);
				check(`remote Runtime ${name}: host commits modelRequest with the named tool offer`, c.modelIntent, JSON.stringify(log.find((x) => x.test === name)?.terminal ?? null));
				check(`Runtime callbacks (${name}): dispatch requires exact allowed decision and settles changes as refused`, c.dispatch && equal(log.filter((x) => x.effect).slice(before).map((x) => x.effect), name === "changed" ? [] : [{ value: name }]));
				check(`remote Runtime ${name}: host commits toolResult before replying`, c.resultCommit);
				if (name === "omitted") check("Runtime callbacks: runToolCall before allowance returns invalid_request without writing", c.earlyDispatch);
				if (name === "exact") {
					check("Runtime callbacks: tool.before on an allowed or settled call returns invalid_request without writing", c.repeatedGate && c.settledGate);
					check("Runtime callbacks: runToolCall after settlement returns invalid_request without writing", c.settledDispatch);
					check("remote Runtime exact: repeating the matching record returns the committed result", c.cachedResult);
					check("Recording order and ownership: toolStarted preserves the dispatch source and definition", c.registration);
					check("Authority: a dispatched tool can call host/env/exec without a second allowance", log.filter((x) => x.effect).slice(before).some((x) => x.env === true));
				}
			}
			const refusal = await within(15000, prompt(remote, s.sessionId, 'tool:probe-effect {"value":"refusal"}'), "refused call settlement");
			const refused = trace("runtime").find((x) => x.test === "refusal")?.checks;
			const refusedRows = (await history(remote, s.sessionId, { all: true })).entries.filter((e) => e.toolCallId === refused?.refusedCall);
			check("Runtime records and effects / From core hooks to wire hooks: tool.before returns the one committed refused result", refused?.refusedSettlement &&
				meta(refusal)?.outcome?.kind === "completed" && refusedRows.filter((e) => e.kind === "toolResult").length === 1 && !refusedRows.some((e) => e.kind === "toolStarted"));
			const openProbe = async (tenant) => {
				const session = await remote.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [], ...(tenant ? { _meta: { [NS]: { tenant } } } : {}) });
				await setOption(remote, session.sessionId, "model", "kit-probe/scripted");
				return session.sessionId;
			};
			// Shared data: Recording order and ownership; Plugin binding: Runtime callbacks.
			const unoffered = await openProbe();
			await within(15000, prompt(remote, unoffered, "fixture unoffered"), "unoffered model call");
			const log = trace("runtime"), missing = log.find((x) => x.test === "unoffered")?.checks;
			const finalOffer = log.find((x) => x.providerDispatch === unoffered)?.offered;
			check("Runtime callbacks: a registered but unoffered tool is refused without the gate or dispatch", missing?.unoffered && missing.modelIntent && equal(missing.offered, finalOffer) &&
				!log.some((x) => x.gate === missing.unofferedCall || x.effect?.value === "unoffered"));
			await closeSession(remote, unoffered);
			const extra = await openProbe();
			const projected = await within(15000, prompt(remote, extra, "fixture extra-response-member"), "Provider response with extra member");
			const accepted = trace("runtime").find((x) => x.extraResponseAccepted === extra);
			const responses = (await history(remote, extra, { all: true })).entries.filter((e) => e.kind === "response");
			check("The host asks a Provider / General rules: provider.response accepts an extra member without changing the answer", !!accepted && meta(projected)?.outcome?.kind === "completed" &&
				responses.some((e) => equal(e.message, accepted.message)));
			await closeSession(remote, extra);
			if (meta(s)?.declaration?.tenants) {
				const sid = await openProbe("kit-latch");
				const p = await within(15000, prompt(remote, sid, "fixture latched"), "latched limit");
				check("Runtime callbacks: limit reached after a step is signalled at the next prepareStep", trace("runtime").find((x) => x.test === "latched")?.checks?.latched &&
					equal(meta(p)?.outcome, { kind: "limit", limit: "tenantTokens" }));
				await closeSession(remote, sid);
				if (tap) await attempt("Runtime records and effects: post-intent limit", async () => {
					const target = await openProbe("kit-race"), burner = await openProbe("kit-race");
					racePath = store.path(target) + "/entries";
					const pending = prompt(remote, target, "fixture post-intent");
					void pending.catch(() => undefined);
					try {
						await within(5000, committed, "target model intent commit");
						await within(5000, prompt(remote, burner, "fixture burner"), "other session exhausts the budget");
					} finally { releaseIntent(); }
					const result = await within(15000, pending, "post-intent limit settles");
					const actual = trace("runtime");
					check("Runtime records and effects: post-intent turn_limit has an aborted host response before the callback returns", actual.find((x) => x.test === "post-intent")?.checks?.postIntent &&
						!actual.some((x) => x.providerDispatch === target) && actual.some((x) => x.providerDispatch === burner) && equal(meta(result)?.outcome, { kind: "limit", limit: "tenantTokens" }));
					await closeSession(remote, target);
					await closeSession(remote, burner);
				});
			}
			await closeSession(remote, s.sessionId);
		} finally { releaseIntent(); await stop(remote); tap?.stop(); }
	});
}

// ACP: Input admission; Plugin binding: Runtime callbacks; Contracts: Input.
if (probeChecks) await attempt("Input admission: steering cutoff", async () => {
	const release = probeOut("release-steering");
	const plugin = { command: [process.execPath, new URL("../plugin/probe.mjs", import.meta.url).pathname], config: { role: "steering", out: probeOut("steering"), release } };
	const remote = connect(command, { MODULAR_AGENT_PLUGINS: JSON.stringify([plugin]) });
	try {
		await remote.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
		const s = await remote.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
		if (!check("Runtime callbacks: fixture Runtime advertises steering through the host", meta(s)?.declaration?.inputDuringTurn === true)) return;
		await setOption(remote, s.sessionId, "model", "conformance/echo");
		const opening = prompt(remote, s.sessionId, "first fixture input").catch((e) => e);
		let finalTurn;
		for (let i = 0; i < 200 && !finalTurn; i++) {
			finalTurn = trace("steering").find((e) => e.final)?.final;
			if (!finalTurn) await sleep(30);
		}
		if (!finalTurn) throw Error("fixture Runtime never acknowledged its final steering check");
		const late = await within(5000, remote.ctx.request(`_${NS}/input`, { sessionId: s.sessionId, when: "steer", content: "input after the cutoff" }), "late steering receipt");
		writeFileSync(release, "continue");
		const first = await within(10000, opening, "first steering fixture turn");
		const es = await waitFor(remote, s.sessionId, (rows) => rows.filter((e) => e.kind === "turnEnd").length >= 2 ||
			rows.some((e) => e.kind === "inputHandedBack" && (e.inputId === late.inputId || e.data?.inputIds?.includes(late.inputId))));
		const input = es.filter((e) => e.kind === "input" && (e.inputId ?? e.data?.inputId) === late.inputId);
		const firstEnd = es.findIndex((e) => e.kind === "turnEnd" && e.turnId === finalTurn);
		check("Input admission: steering after the final check queues after and cannot enter the ending turn", !!late.inputId && late.taken === "after" &&
			first.stopReason === "end_turn" && firstEnd >= 0 && input.length === 1 && input[0].turnId !== finalTurn && es.indexOf(input[0]) > firstEnd, JSON.stringify(late));
		await closeSession(remote, s.sessionId);
	} finally {
		writeFileSync(release, "continue");
		await stop(remote);
	}
});

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
		check("Entry: the job start appears in ACP history", !!jobId, JSON.stringify(started));
		const ended = entries.filter((e) => e.kind === "jobEnded" && e.jobId === jobId);
		check("jobs: one jobEnded, completed and reported", ended.length === 1 && ended[0].data?.outcome?.kind === "completed" && ended[0].data?.report === true, String(JSON.stringify(ended)).slice(0, 200));
		// Shared data: Job reports; Plugin binding: Jobs.
		const report = entries.filter((e) => e.kind === "inputAccepted" && e.jobId === jobId);
		check("jobs: one admitted report follows the end with exact content", report.length === 1 && report[0].jobId === jobId && entries.indexOf(report[0]) > entries.indexOf(ended[0]) && equal(report[0].data?.content, [{ type: "text", text: "background: kit-job" }]));
		// Shared data: Job reports. Inspect the store if present; the ACP projection also carries parked.
		const admission = store ? (await store.pages(sessionId)).find((e) => e.kind === "inputAccepted" && e.jobId === jobId) : report[0];
		if (decl.startsTurnsUnasked === "jobReports") {
			console.log('SKIP  Job reports: parked disposition (session declares startsTurnsUnasked: "jobReports")');
			check("Job reports: a session that starts report turns records a ready disposition", !!jobId && admission?.data?.parked === false);
		} else check("Job reports: the initial report disposition is parked", !!jobId && admission?.data?.parked === true);
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
			const newJob = (e) => e.kind === "jobStarted" && e.data?.kind === "background" && e.jobId !== jobId;
			const es = await waitFor(agent, sessionId, (x) => x.some(newJob));
			const id = es.find(newJob)?.jobId;
			await agent.ctx.request(`_${NS}/cancel-job`, { sessionId, jobId: id });
			// ACP: Extension methods (cancel-job). The long fixture timer cannot win this race.
			const after = (await history(agent, sessionId, { all: true })).entries;
			const end = after.filter((e) => e.kind === "jobEnded" && e.jobId === id);
			check("jobs: cancel-job ends the job once, as cancelled, without a report", end.length === 1 && end[0].data?.outcome?.kind === "cancelled" && !after.some((e) => e.kind === "inputAccepted" && e.jobId === id), String(JSON.stringify(end)).slice(0, 200));
		}
	});
}

await attempt(network ? "load on a new connection" : "load in a new process", async () => {
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
	check(network ? "load: history survives reconnect" : "load: history survives a restart", entries.some((e) => e.kind === "turnEnd"));
	// ACP: Starting and Input admission. Both principals in the tuple default to the connection actor.
	const readerActor = meta(init)?.actor?.id;
	const sameScope = network ? !!writerActor && readerActor === writerActor : !portablePair || (writerActor === portableActor && readerActor === portableActor);
	if (sameScope) {
		const r = await within(15000, prompt(agent, sessionId, "hello", "key-1"), "resent prompt after restart");
		check("Input admission: the same principal gets the original receipt after reopen", meta(r)?.duplicate === true && meta(r)?.inputId === firstInputId, JSON.stringify(meta(r)));
	} else {
		check(network ? "WebSocket: reconnecting with the same token selects the same actor" : "Starting: portable writer and reopener honor MODULAR_AGENT_ACTOR for a same-scope retry", false, JSON.stringify({ writerActor, readerActor }));
	}
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

if (portablePair && network && !otherToken) console.log("SKIP  retry by a different principal (requires --other-token-file configured for another actor)");
if (portablePair && (!network || otherToken)) await attempt("Input admission: key retry by a different principal", async () => {
	const peer = network ? connect(second, {}, otherToken) : connect(second, { MODULAR_AGENT_ACTOR: otherActor });
	try {
		const init = await within(15000, peer.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} }), "initialize different principal");
		const readerActor = meta(init)?.actor?.id;
		if (!check(network ? "WebSocket: the other token has a different principal" : "Starting: a different MODULAR_AGENT_ACTOR changes the reopener's principal", network ? !!writerActor && !!readerActor && writerActor !== readerActor : writerActor === portableActor && readerActor === otherActor, JSON.stringify({ writerActor, readerActor }))) return;
		await within(await reopenWatchdog(), peer.ctx.request(methods.agent.session.load, { sessionId, cwd: project, mcpServers: [] }), "reopen as different principal");
		const r = await within(15000, prompt(peer, sessionId, "retry with a different principal", "key-1"), "key in new scope").catch((e) => e);
		const m = meta(r);
		check("Input admission: a different principal gets a new admission, not the old receipt", !!firstInputId && m?.duplicate !== true && typeof m?.inputId === "string" && m.inputId !== firstInputId && m?.outcome?.kind === "completed", JSON.stringify(m ?? { code: r?.code, data: r?.data, message: r?.message }));
		await closeSession(peer, sessionId);
	} finally { await stop(peer); }
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
		const erased = await agent.ctx.request(`_${NS}/erase`, { sessionId: sid, entryIds: [input.id, input.id] });
		// ACP: Extension methods (erase).
		const pairs = (rows) => Array.isArray(rows) && rows.every((p) => typeof p?.sessionId === "string" && p.sessionId && typeof p.id === "string" && p.id && equal(Object.keys(p).sort(), ["id", "sessionId"])) &&
			new Set(rows.map((p) => JSON.stringify([p.sessionId, p.id]))).size === rows.length;
		check("Extension methods: erase returns deduplicated session-qualified pairs", pairs(erased.erased) && pairs(erased.pending) && erased.erased.some((p) => p.sessionId === sid && p.id === input.id));
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
	if (!(ttlMs >= 1000 && ttlMs <= 15000)) {
		console.log("SKIP  delayed renewal fixture needs a service TTL between 1 and 15 seconds");
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
		if (network) await crash(agent);
		else agent.child.kill("SIGKILL");
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

// ACP: Errors; History HTTP: Writing: one writer at a time. Simulate the hold after a TTL decrease.
if (canConfigure && store && (crashChecks || portableChecks)) await attempt("Errors: reopening during a restart hold", async () => {
	const caps = await store.json("/v1"), ttlMs = 1000;
	const base = store.path(mainSession);
	let heldAt, holdEnds;
	const tap = await store.observe({ fixtureReply: ({ method, path }) => {
		if (method === "GET" && path === "/v1") return { status: 200, body: { ...caps, ttlMs } };
		if (method !== "POST" || path !== base + "/lease") return;
		heldAt ??= performance.now();
		holdEnds ??= heldAt + 8000;
		return { status: 409, body: { error: "Restart hold", code: "held", retryAfterMs: Math.ceil(holdEnds - performance.now()) } };
	} });
	const opener = connect(second, { MODULAR_AGENT_HISTORY_URL: tap.url });
	try {
		await opener.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
		const loaded = await within(6000, opener.ctx.request(methods.agent.session.load, { sessionId: mainSession, cwd: project, mcpServers: [] }), "open budget during restart hold").catch((e) => e);
		check("Errors / Writing: one writer at a time: a hold beyond the reopen budget is retryable", heldAt !== undefined && performance.now() - heldAt <= ttlMs + 1000 + 500 &&
			loaded?.code === -32000 && loaded?.data?.code === "held" && Number.isSafeInteger(loaded.data.retryAfterMs) && loaded.data.retryAfterMs > 0,
			JSON.stringify({ code: loaded?.code, data: loaded?.data, message: loaded?.message }));
	} finally { await stop(opener); tap.stop(); }
});

// ACP: Extension methods (fork); History HTTP: Sessions (preflight before destination PUT).
if (portableChecks && canConfigure) await attempt("Extension methods: oversized fork", async () => {
	const mutations = [];
	const tap = await store.observe({ onRequest: (req) => { if (req.method === "PUT" || req.method === "POST") mutations.push(req); } });
	const s = connect(command, { MODULAR_AGENT_HISTORY_URL: tap.url });
	try {
		const init = await s.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
		const principal = meta(init)?.actor;
		if (!meta(init)?.extensions?.includes("fork")) {
			console.log("SKIP  oversized fork (fork extension unavailable)");
			return;
		}
		let actor = principal;
		if (!principal?.rights && meta(init)?.extensions?.includes("actors")) {
			// Read the effective fixture actor from a provisional session on older builds.
			const provisional = await s.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
			const { actors } = await s.ctx.request(`_${NS}/actors`, { sessionId: provisional.sessionId });
			actor = actors.find((a) => a.id === principal?.id);
			await closeSession(s, provisional.sessionId);
		}
		if (!actor?.rights?.includes("settings") || !actor.rights.includes("watch") || !actor.rights.includes("input"))
			throw Error("fixture requires a principal with watch, settings and input");
		const sid = `kit-fork-${randomUUID()}`, base = store.path(sid), time = Date.now();
		const content = [{ type: "text", text: "x".repeat(4_000_000) }];
		const authorizers = [{ sessionId: sid, actorId: actor.id }];
		let head = null;
		const entry = (kind, fields) => {
			const row = { id: randomUUID(), parentId: head, sessionId: sid, time, writer: "kit-history-fixture", modelVisible: false, kind, ...fields };
			head = row.id;
			return row;
		};
		await store.json(base, "PUT", { project, created: time });
		const { lease } = await store.json(base + "/lease", "POST", { owner: randomUUID() });
		const leasePath = `${base}/lease/${encodeURIComponent(lease)}`;
		await store.json(base + "/entries", "POST", { lease, entries: [entry("actorJoined", { data: { actor, operatorAdmission: true } })] });
		for (let i = 0; i < 17; i++) {
			await store.json(leasePath + "/renew", "POST");
			const inputId = randomUUID();
			const accepted = entry("inputAccepted", { actorId: actor.id, inputId, data: { content, authorizers, rights: actor.rights, when: "now" } });
			await store.json(base + "/entries", "POST", { lease, entries: [accepted, entry("inputHandedBack", { inputId, data: { reason: "handled" } })] });
		}
		await store.json(leasePath, "DELETE");
		const loaded = await within((await reopenWatchdog()) + 30000, s.ctx.request(methods.agent.session.load, { sessionId: sid, cwd: project, mcpServers: [] }), "load oversized fork source");
		if (!meta(loaded)?.declaration?.forking) {
			console.log("SKIP  oversized fork (source session does not declare forking)");
			return;
		}
		mutations.length = 0;
		const r = await within(30000, s.ctx.request(`_${NS}/fork`, { sessionId: sid, entryId: head }), "fork size refusal").catch((e) => e);
		const destinationWrite = mutations.some((req) => req.path.startsWith("/v1/sessions/") && req.path !== base && !req.path.startsWith(base + "/"));
		check("Extension methods: oversized history fork refuses before any destination write", r?.code === -32602 && r?.data?.code === "result_too_large" && !destinationWrite,
			JSON.stringify({ code: r?.code, dataCode: r?.data?.code, message: r?.message, destinationWrite }));
		await closeSession(s, sid);
	} finally {
		await stop(s);
		tap.stop();
	}
});

// Shared data: Setting keys, Append order and the branch, and Session state; Contracts: Authority.
if (portableChecks) await attempt("portable authority fixture", async () => {
	const s = connect(second);
	try {
		const init = await s.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
		const principal = meta(init)?.actor;
		if (!principal?.id) throw Error("reopener did not identify a principal");
		const actor = { ...principal, rights: ["watch", "input", "settings", "tools", "approve", "jobs", "cancel"] };
		const seed = async (mode) => {
			const sessionId = `kit-portable-${randomUUID()}`;
			const rows = [
				{ kind: "actorJoined", data: { actor: { id: "kit-granter", kind: "user", rights: [...actor.rights, "grant"] }, operatorAdmission: true } },
				{ kind: "actorJoined", actorId: "kit-granter", data: { actor } },
				{ kind: "setting", data: { key: "model", value: { provider: "conformance", id: "echo" } } },
				{ kind: "inputAccepted", inputId: "initial-input", actorId: actor.id, data: { when: "after", key: "fixture-old", content: [{ type: "text", text: "old input" }], authorizers: [{ sessionId, actorId: actor.id }], rights: actor.rights } },
				{ kind: "inputHandedBack", data: { inputIds: ["initial-input"] } },
			];
			if (mode === "approval") rows.push({ kind: "setting", data: { key: "approval", value: "kit-unrecognized-policy" } });
			if (mode === "rights") rows.push({ kind: "actorJoined", actorId: "kit-granter", data: { actor: { ...actor, rights: ["watch", "input"] } } });
			if (mode === "revoked") rows.push({ kind: "actorLeft", actorId: "kit-granter", data: { actorId: actor.id } });
			if (mode === "cleanup") {
				const jobId = randomUUID(), reported = randomUUID(), report = [{ type: "text", text: "parked fixture report" }];
				const start = (jobId) => ({ kind: "jobStarted", jobId, actorId: actor.id, writer: "kit-absent-job-owner", data: { kind: "fixture", detail: null, rights: ["watch", "input"], authorizers: [{ sessionId, actorId: actor.id }] } });
				rows.push(
					start(jobId), { kind: "jobCleanupUnconfirmed", jobId }, start(reported),
					{ kind: "jobEnded", jobId: reported, data: { outcome: { kind: "completed" }, report: true, result: report } },
					{ kind: "inputAccepted", jobId: reported, inputId: randomUUID(), actorId: actor.id, data: { key: `job:${reported}`, when: "after", content: report, parked: true, authorizers: [{ sessionId, actorId: actor.id, jobId: reported }], rights: ["watch", "input"] } },
				);
			}
			if (mode === "queue") rows.push({ kind: "inputAccepted", inputId: "older-ready", actorId: actor.id, data: {
				when: "after", taken: "after", key: "fixture-ready", content: [{ type: "text", text: "older ready input" }], authorizers: [{ sessionId, actorId: actor.id }], rights: actor.rights,
			} });
			rows.push({ kind: "position", data: { to: `${sessionId}-e3` } });
			const entries = rows.map((e, i) => ({ ...e, id: `${sessionId}-e${i}`, parentId: i ? `${sessionId}-e${i - 1}` : null, sessionId, time: Date.now(), writer: e.writer ?? "kit-history-fixture", modelVisible: false }));
			const base = store.path(sessionId);
			await store.json(base, "PUT", { project, created: Date.now() });
			const { lease } = await store.json(base + "/lease", "POST", { owner: randomUUID() });
			await store.json(base + "/entries", "POST", { lease, entries });
			if (mode === "queue") await store.json(base + "/erase", "POST", { lease, entryIds: [entries[4].id] });
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
		const cleanup = await seed("cleanup");
		const raw = await store.pages(cleanup);
		const job = raw.find((e) => e.kind === "jobCleanupUnconfirmed");
		const problems = portableProblems(cleanup, raw);
		check("Standard kinds: a payload-free jobCleanupUnconfirmed is a shared record", !!job?.jobId && problems.length === 0, problems.join("; "));
		const openedCleanup = await load(cleanup);
		const loadedCleanup = !openedCleanup?.code && !(openedCleanup instanceof Error);
		check("Session state: a portable session with a cleanup marker reopens", loadedCleanup, loadedCleanup ? "" : openedCleanup?.data?.code ?? openedCleanup?.message);
		if (loadedCleanup && meta(init)?.extensions?.includes("jobs")) {
			const { jobs } = await s.ctx.request(`_${NS}/jobs`, { sessionId: cleanup });
			check("Extension methods: off-branch job cleanup is still unconfirmed after reopen", jobs.some((j) => j.id === job.jobId && j.state === "cleanupUnconfirmed"));
		}
		if (loadedCleanup) {
			const { entries } = await history(s, cleanup, { all: true });
			const report = entries.find((e) => e.kind === "inputAccepted" && e.jobId);
			check("Job reports: the parked disposition is still recorded after reopen", report?.data?.parked === true &&
				!entries.some((e) => e.kind === "input" && e.jobId === report.jobId));
			await attempt("Several actors: parked report release", async () => {
				const reportId = report?.inputId;
				const methodsOffered = meta(init)?.extensions ?? [];
				check("Several actors: a parked report requires proposals, release and withdraw even without severalActors", ["proposals", "release", "withdraw"].every((name) => methodsOffered.includes(name)));
				const proposals = () => s.ctx.request(`_${NS}/proposals`, { sessionId: cleanup }).then((r) => r.proposals);
				const listed = (await proposals()).filter((p) => p.inputId === reportId);
				check("Several actors: proposals lists the parked report with its original actor and content", listed.length === 1 && listed[0].actorId === actor.id && equal(listed[0].content, report?.data?.content));
				const released = await s.ctx.request(`_${NS}/release`, { sessionId: cleanup, inputId: reportId, when: "now" });
				const finished = await waitFor(s, cleanup, (es) => es.some((e) => e.kind === "turnStart" && e.data?.startedBy?.id === report?.jobId));
				const admissions = (await store.pages(cleanup)).filter((e) => e.kind === "inputAccepted" && e.jobId === report?.jobId);
				check("Several actors / Job reports: release consumes the parked proposal once and preserves job attribution", released.inputId === reportId &&
					!(await proposals()).some((p) => p.inputId === reportId) && admissions.length === 2 &&
					(admissions[1].inputId ?? admissions[1].data?.inputId) === reportId && admissions[1].data?.releasedBy === actor.id &&
					finished.some((e) => e.kind === "turnStart" && equal(e.data?.startedBy, { kind: "job", id: report.jobId })));
			});
			await closeSession(s, cleanup);
		}

		// Shared data: Legacy associations and Session state; ACP: Input admission.
		const queued = await seed("queue");
		const queueOpen = await load(queued);
		if (!meta(queueOpen)?.declaration) throw Error("could not open queue fixture");
		const fresh = await s.ctx.request(`_${NS}/input`, { sessionId: queued, when: "now", key: "fixture-fresh", content: "fresh input" });
		await waitFor(s, queued, (es) => es.some((e) => e.kind === "turnEnd" && es.some((input) => input.kind === "input" && input.inputId === fresh.inputId && input.turnId === e.turnId)));
		const kept = await store.pages(queued);
		const isFor = (e, inputId) => (e.inputId ?? e.data?.inputId) === inputId;
		const tomb = kept.find((e) => e.id === `${queued}-e4`);
		check("Legacy associations: a tombstoned batch hand-back keeps its IDs and stays terminal on reopen", tomb?.erased === true && equal(tomb.inputIds, ["initial-input"]) &&
			!kept.some((e) => e !== tomb && ((e.kind === "input" || e.kind === "inputHandedBack") && isFor(e, "initial-input") || e.kind === "inputHandedBack" && e.data?.inputIds?.includes("initial-input"))));
		if (meta(queueOpen).declaration.queuedInputAfterRestart === "run") {
			const admission = kept.find((e) => e.kind === "inputAccepted" && isFor(e, fresh.inputId));
			const older = kept.find((e) => e.kind === "input" && isFor(e, "older-ready"));
			const taken = kept.find((e) => e.kind === "input" && isFor(e, fresh.inputId));
			const end = older && kept.find((e) => e.kind === "turnEnd" && e.turnId === older.turnId);
			check("Input admission: fresh input queues behind recovered input and gets after while it cannot run next", !!admission && !!end && !!taken && kept.indexOf(end) < kept.indexOf(taken) &&
				(kept.indexOf(admission) > kept.indexOf(end) || fresh.taken === "after"));
		} else console.log("SKIP  recovered queue receipt (session does not declare queuedInputAfterRestart: run)");
		await closeSession(s, queued);
	} finally { await stop(s); }
});

// Plugin binding: Model attempt sequences (crash recovery). Seed interrupted attempts in shared data.
// Plugin binding: The host asks the Runtime. Contracts: Recovery and repeating work and Hook execution.
if (probeChecks && crashChecks) for (const boundary of ["before", "after"]) {
	const label = `The host asks the Runtime (crash ${boundary} step.after)`;
	await attempt(label, async () => {
		const role = `gate-recovery-${boundary}`;
		const plugin = { command: [process.execPath, new URL("../plugin/gate-recovery.mjs", import.meta.url).pathname], config: { boundary, out: probeOut(role) } };
		const start = () => connect(command, { MODULAR_AGENT_PLUGINS: JSON.stringify([plugin]) });
		const init = (a) => within(15000, a.ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} }), "initialize gate recovery fixture");
		let remote = start();
		try {
			await init(remote);
			const session = await remote.ctx.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
			const sid = session.sessionId;
			await setOption(remote, sid, "model", "kit-gate-recovery/echo");
			if (session.configOptions?.some((o) => o.id === "approval")) await setOption(remote, sid, "approval", "off");
			const pending = prompt(remote, sid, "fixture gate recovery").then(() => true, () => true);
			let latch;
			for (const t0 = Date.now(); !latch && Date.now() - t0 < 10000;) {
				latch = trace(role).find((x) => x.latch === boundary);
				if (!latch && await Promise.race([pending, sleep(50).then(() => false)])) break;
			}
			if (!latch) throw Error(`fixture did not reach the ${boundary} crash boundary`);
			await crash(remote);
			remote = start();
			await init(remote);
			await within(await reopenWatchdog(), remote.ctx.request(methods.agent.session.load, { sessionId: sid, cwd: project, mcpServers: [] }), "load step.after crash fixture");
			const kept = await waitFor(remote, sid, (es) => es.some((e) => e.kind === "turnEnd"), 8000);
			const log = trace(role), resumed = log.find((x) => x.resumed);
			const { lastStep, calls } = resumed?.interrupted ?? {};
			const step = kept.find((e) => e.kind === "response" && e.turnId === resumed?.resumed);
			const end = kept.find((e) => e.kind === "turnEnd" && e.turnId === resumed?.resumed);
			const gates = log.filter((x) => x.gate !== undefined).map((x) => x.gate);
			const replies = log.filter((x) => x.gateReply !== undefined);
			const detail = JSON.stringify({ ...resumed, gates, replies, outcome: end?.data?.outcome });
			if (boundary === "before") {
				check(`${label}: the unsafe call is settled before handoff and not passed or repeated`, equal(calls, []) &&
					equal(resumed?.terminalCalls, [{ id: latch.callId, status: "outcomeUnknown" }]) && log.filter((x) => x.latch === "before").length === 1, detail);
				check(`${label}: the resumed step runs its due gate once and completes`, !!lastStep && !!step && lastStep.stepId === step.stepId && !Object.hasOwn(lastStep, "decision") &&
					equal(gates, [step.stepId]) && equal(replies, [{ gateReply: step.stepId, accepted: true }]) && end?.data?.outcome?.kind === "completed", detail);
			} else {
				check(`${label}: resume supplies the committed allow decision without a second gate`, !!lastStep && lastStep.stepId === latch.stepId && lastStep.decision === null &&
					equal(gates, [latch.stepId]) && replies.length === 0 && end?.data?.outcome?.kind === "completed", detail);
			}
			await closeSession(remote, sid);
		} finally { await stop(remote); }
	});
}

if (probeChecks && portableChecks) for (const [mode, safe] of [

	["transient", false], ["fresh", false], ["fresh", true], ["repeat", true],
	["no-request-hook", false], ["early-response-hook", false],
]) await attempt(`remote recovery: ${mode} with ${safe ? "repeatable" : "unsafe"} attempt`, async () => {
	const sid = `kit-runtime-${randomUUID()}`, turnId = "interrupted-turn";
	const model = { provider: "kit-recovery", id: "echo" };
	const role = `runtime-${mode}-${safe}`, transform = mode === "fresh" && safe;
	const negative = mode === "no-request-hook" || mode === "early-response-hook";
	const plugin = { command: [process.execPath, new URL("../plugin/recovery.mjs", import.meta.url).pathname],
		config: { sessionId: sid, mode, safe, transform, out: probeOut(role) } };
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
			{ kind: "modelRequest", turnId, stepId: "old-step", data: { model, safeToRepeat: safe, tools: [], tracksStepAfter: true, ...(safe ? { request } : {}) }, sources: [entryId(4)] },
		];
		if (mode === "fresh" && !safe) {
			const empty = { role: "assistant", stop: "failed", content: [], error: { kind: "other", message: "Fixture failure" }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
			rows.splice(5, 0,
				{ kind: "modelRequest", turnId, stepId: "failed-step", data: { model, safeToRepeat: false, tools: [], tracksStepAfter: true }, sources: [entryId(4)] },
				{ kind: "response", turnId, stepId: "failed-step", message: empty, modelVisible: true, sources: [entryId(5)] },
				{ kind: "modular-agent.stepAfter", turnId, stepId: "failed-step", data: { decision: null } },
				{ kind: "modelRequest", turnId, stepId: "settled-step", data: { model, safeToRepeat: false, tools: [], tracksStepAfter: true }, sources: [entryId(4)] },
				{ kind: "response", turnId, stepId: "settled-step", modelVisible: true, sources: [entryId(8)], message: { role: "assistant", stop: "toolUse", usage: empty.usage, content: [{ type: "toolCall", id: "settled-call", name: "not-offered", arguments: {} }] } },
				{ kind: "toolResult", turnId, stepId: "settled-step", toolCallId: "settled-call", modelVisible: true, data: { status: "refused" }, message: { role: "toolResult", toolCallId: "settled-call", toolName: "not-offered", isError: true, content: [{ type: "text", text: "not offered" }] } },
				{ kind: "modular-agent.stepAfter", turnId, stepId: "settled-step", data: { decision: null } });
		}
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
		const intent = (es) => es.filter((e) => e.kind === "modelRequest" && e.turnId === turnId && !["old-step", "failed-step", "settled-step"].includes(e.stepId));
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
		if (mode === "fresh" && !safe) {
			check("The host asks the Runtime: settled calls are excluded from interrupted.calls", Array.isArray(resume?.resume?.calls) && !resume.resume.calls.some((c) => c.id === "settled-call"));
			check("Context and interrupted work: an empty failed or aborted attempt is not a model message", prepared?.request?.messages?.some((m) => equal(m, message)) &&
				!prepared.request.messages.some((m) => m.role === "assistant" && ["failed", "aborted"].includes(m.stop) && m.content?.length === 0));
		}
		if (negative) {
			const early = log.find((x) => x.earlyResponse);
			check(`The host asks a Provider (${mode}): an uncommitted attempt cannot return an assistant answer`,
				(mode === "early-response-hook" ? early?.earlyResponse === "invalid_request" : log.some((x) => x.returnedWithoutHook)) &&
				terminal(kept)?.data?.outcome?.kind === "failed" && !kept.some((e) => e.kind === "response" && said([e], "Recovered fixture turn")));
		} else if (mode === "transient") {
			check(`${label}: transient recovery ends the turn without a new model attempt`, !!terminal(kept) &&
				terminal(kept).data?.outcome?.kind !== "completed" && !dispatched.length && intent(await store.pages(sid)).length === 0);
		} else {
			const saved = dispatched[0]?.log ?? [];
			const beforeEffect = intent(saved);
			check(`The host asks a Provider (${mode}, safeToRepeat=${safe}): commit occurs at the provider.request callback before inference`,
				dispatched.length === 1 && intent(dispatched[0].before).length === 0 && beforeEffect.length === 1 &&
				equal(beforeEffect[0].data?.tools, dispatched[0].provider.tools.map((t) => t.name)) &&
				(!transform || (dispatched[0].provider.systemPrompt === "Transformed fixture checkpoint" && equal(beforeEffect[0].data?.request, dispatched[0].provider))));
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
		if (network) await crash(agent);
		else agent.child.kill("SIGKILL");
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
		check("jobs after a crash: one resumed execution admits one report", trace("jobs").filter((x) => x.resumed === jobId).length === 1 && entries.filter((e) => e.kind === "inputAccepted" && e.jobId === jobId).length === 1);
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


if (productionChecks.length) await runProduction();
await finish();

async function runProduction() {
	const root = join(probeDir, "production");
	mkdirSync(root);
	const profile = (policy, extraEnv = {}, dir = mkdtempSync(join(root, "profile-"))) => {
		const path = join(dir, "policy.json");
		writeFileSync(path, JSON.stringify(policy), { mode: 0o600 });
		return { MODULAR_AGENT_DATA_DIR: dir, MODULAR_AGENT_CONFORMANCE_POLICY: path, ...extraEnv };
	};
	const invalid = async (policy) => {
		const extraEnv = profile(policy);
		const service = network && await managed.variant(extraEnv, { captureStderr: true });
		const child = service ? service.child : spawnAgent(command, extraEnv, true);
		const exited = service ? service.exited : new Promise((resolve, reject) => {
			child.once("exit", (code, signal) => resolve({ code, signal }));
			child.once("error", reject);
		});
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-4096); });
		const drained = new Promise((resolve) => child.stderr.once("end", resolve));
		const successfulInit = !service && new Promise((resolve) => {
			const lines = createInterface({ input: child.stdout });
			lines.on("line", (line) => {
				let reply;
				try { reply = JSON.parse(line); } catch { return; }
				if (reply.id === 1 && reply.result) resolve({ code: 0 });
			});
			child.stdin.on("error", () => {});
			child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }) + "\n");
		});
		try {
			const exit = Promise.all([exited, drained]).then(([status]) => status);
			const { code } = await within(CONTROL_MS, successfulInit ? Promise.race([exit, successfulInit]) : exit, "invalid policy startup refusal");
			return { code, stderr };
		} finally { if (service) await managed.stop(service); else await stop({ child }); }
	};
	for (const [flag, run] of productionChecks) await attempt(flag, () => run({
		root, project, command, second, store, network, managed, profile, invalid, connect, stop, crash,
		within, check, attempt, reopenWatchdog, prompt, history, closeSession, probePlugin,
	}));
}

async function finish() {
	await managed?.stopAll();
	observer?.stop();
	for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
	for (const dir of new Set([dataDir, dataDir2, probeDir, project, home])) rmSync(dir, { recursive: true, force: true });
	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
	process.exit(failed.length ? 1 : 0);
}
