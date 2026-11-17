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
// With --portable-checks, also check every entry the agents kept in the history service is in the shared shapes
// (docs/bindings/data.md#portable-sessions). It needs MODULAR_AGENT_HISTORY_URL and MODULAR_AGENT_HISTORY_TOKEN_FILE.
const portableChecks = argv.includes("--portable-checks");
const dash = argv.indexOf("--");
if (dash < 0 || dash === argv.length - 1) {
	console.error("Usage: node run.mjs [--verbose] [--plugin-checks] [--crash-checks] [--probe-checks] [--portable-checks] -- <agent command> [args...] [--then <second agent command> [args...]]");
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
if (probeChecks) {
	const probe = new URL("../plugin/probe.mjs", import.meta.url).pathname;
	const given = process.env.MODULAR_AGENT_PLUGINS ? JSON.parse(process.env.MODULAR_AGENT_PLUGINS) : [];
	const roles = ["probe", "refuse-hook", "refuse-replace"];
	pluginEnv.MODULAR_AGENT_PLUGINS = JSON.stringify([...given, ...roles.map((role) => ({ command: [process.execPath, probe], config: { role, out: probeOut(role) } }))]);
}
const sessionsUsed = [];
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
		env: { ...process.env, ...pluginEnv, MODULAR_AGENT_CONFORMANCE: "1", MODULAR_AGENT_DATA_DIR: which === command ? dataDir : dataDir2 },
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

if (pluginChecks) {
	await attempt("plugin hooks", async () => {
		const r = await within(15000, prompt(agent, sessionId, 'tool:bash {"command":"echo conformance-forbidden > forbidden.txt"}'), "forbidden prompt");
		check("plugin: the conformance plugin's gate refused the call", !existsSync(join(project, "forbidden.txt")));
		check("plugin: the turn still ends", r.stopReason === "end_turn", r.stopReason);
		const { entries } = await history(agent, sessionId);
		const refused = entries.filter((e) => e.kind === "toolResult").at(-1);
		check("plugin: the refusal reason reached the record", JSON.stringify(refused ?? {}).includes("refused by the conformance plugin"), JSON.stringify(refused?.message ?? refused).slice(0, 160));
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

if (probeChecks) {
	await attempt("probe", async () => {
		const r = await within(30000, prompt(agent, sessionId, "tool:probe {}"), "probe prompt");
		check("probe: the turn ends", r.stopReason === "end_turn", r.stopReason);
		const checks = existsSync(probeOut("probe")) ? JSON.parse(readFileSync(probeOut("probe"), "utf8")) : [];
		check("probe: the probe ran", checks.length > 0, "no results; was the tool called?");
		for (const c of checks) check(`probe: ${c.name}`, c.ok, c.detail);
		for (const role of ["refuse-hook", "refuse-replace"]) {
			const lines = existsSync(probeOut(role)) ? readFileSync(probeOut(role), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
			const why = role === "refuse-hook" ? "a handler for a hook point the host doesn't offer" : "naming a replacement it doesn't register";
			check(`probe: ${why} gets plugin/shutdown, reason refused`, lines.some((l) => l.params?.reason === "refused"), JSON.stringify(lines));
		}
		const tools = agent.updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "tool_call").map((u) => u.update.title);
		check("probe: the refused plugins left nothing behind, and the host carried on", r.stopReason === "end_turn" && tools.includes("probe"), tools.join(","));
	});
}

await attempt("load in a new process", async () => {
	await agent.ctx.request(methods.agent.session.close, { sessionId });
	await stop(agent);
	agent = connect(second);
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
	});
}

/** What breaks the shared shapes in one session's kept entries (docs/bindings/data.md). */
function portableProblems(sid, entries) {
	const out = [];
	const say = (e, what) => out.push(`${e.kind ?? "?"} ${String(e.id).slice(0, 8)}: ${what}`);
	const STANDARD = ["input", "turnStart", "response", "toolStarted", "toolResult", "inputRequest", "inputAnswer", "turnEnd", "summary", "setting", "actorJoined", "actorLeft", "position", "erasure"];
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
			case "setting":
				if (typeof d.key !== "string" || !("value" in d)) say(e, "needs data.key and data.value");
				if (d.key === "model" && (typeof d.value?.provider !== "string" || typeof d.value?.id !== "string")) say(e, "the model setting is { provider, id }");
				break;
		}
		if (e.kind === "toolResult" && seen.has(`started:${e.toolCallId}`) === false && entries.some((x) => x.kind === "toolStarted" && x.toolCallId === e.toolCallId) && entries.indexOf(entries.find((x) => x.kind === "toolStarted" && x.toolCallId === e.toolCallId)) > entries.indexOf(e)) say(e, "kept before its toolStarted");
		if (e.kind === "toolStarted") seen.add(`started:${e.toolCallId}`);
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
