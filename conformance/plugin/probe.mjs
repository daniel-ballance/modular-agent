#!/usr/bin/env node
// The probe plugin: checks the host side of modular-agent-plugin/1 (docs/bindings/plugin.md) from inside a host.
// The ACP kit loads it with --probe-checks. It has no dependencies.
//
// Its config chooses what it does:
//   { "role": "probe", "out": "<file>" }   registers the tool `probe`. Calling it runs the host checks, and
//                                          writes them to <file> as JSON: [{ name, ok, detail }].
//   { "role": "refuse-hook", "out": "<file>" }     registers a handler for a hook point no host offers.
//   { "role": "refuse-replace", "out": "<file>" }  names `tool:probe-absent` in replaces, and registers no such tool.
// A refused probe appends the plugin/shutdown it gets to <file>, as one JSON line.
import { appendFileSync, writeFileSync } from "node:fs";

const BINDING = "modular-agent-plugin/1";
let config = {};
let nextId = 1;
const pending = new Map();
const answered = []; // ids of host requests this plugin has answered
let buffer = "";

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const reply = (id, result) => {
	answered.push(id);
	send({ id, result });
};
function request(method, params, ms = 15000) {
	const id = `probe-${nextId++}`;
	const p = new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject({ timeout: true, message: `timed out after ${ms} ms: ${method}` });
		}, ms);
		pending.set(id, { resolve: (r) => (clearTimeout(timer), resolve(r)), reject: (e) => (clearTimeout(timer), reject(e)) });
	});
	p.id = id;
	return { id, promise: p, write: () => send({ id, method, params }) };
}
async function ask(method, params, ms) {
	const r = request(method, params, ms);
	r.write();
	return r.promise;
}
const outcome = (p) => p.then((result) => ({ result }), (error) => ({ error }));
const codeOf = (e) => e?.data?.code;

function registration() {
	const base = { binding: BINDING, name: `probe-${config.role ?? "probe"}` };
	if (config.role === "refuse-hook") return { ...base, hooks: [{ hook: "probe.no-such-point", handlerId: 1, order: "normal" }] };
	if (config.role === "refuse-replace") return { ...base, replaces: ["tool:probe-absent"] };
	return {
		...base,
		toolSources: [
			{ id: "probe-tools", perSession: false, tools: [{ name: "probe", description: "Checks the host side of the plugin binding.", parameters: { type: "object", properties: {} } }] },
		],
	};
}

async function runChecks(callRequestId, sessionId) {
	const checks = [];
	const check = (name, ok, detail = "") => checks.push({ name, ok: !!ok, detail: ok ? "" : String(detail).slice(0, 300) });
	const tryCheck = async (name, fn) => {
		try {
			await fn();
		} catch (e) {
			check(name, false, JSON.stringify(e));
		}
	};
	let cwd = ".";
	await tryCheck("host/session", async () => {
		const s = await ask("host/session", { sessionId });
		check("host/session: gives the session's project", typeof s.project === "string" && s.id === sessionId, JSON.stringify(s).slice(0, 200));
		cwd = s.project ?? cwd;
	});

	await tryCheck("host/history: pages by after and next", async () => {
		const all = await ask("host/history", { sessionId, parentRequestId: callRequestId, all: true });
		const entries = all.entries ?? [];
		check("host/history: entries for the session", entries.length >= 2, `${entries.length} entries`);
		const first = await ask("host/history", { sessionId, parentRequestId: callRequestId, all: true, limit: 1 });
		check("host/history: limit 1 gives one entry", first.entries?.length === 1, JSON.stringify(first).slice(0, 200));
		check("host/history: next is the last entry's id when more remain", first.next === first.entries?.[0]?.id, JSON.stringify({ next: first.next, id: first.entries?.[0]?.id }));
		const second = await ask("host/history", { sessionId, parentRequestId: callRequestId, all: true, limit: 1, after: first.next });
		check("host/history: after next gives the following entry", second.entries?.[0]?.id === entries[1]?.id, JSON.stringify({ got: second.entries?.[0]?.id, want: entries[1]?.id }));
		const last = await ask("host/history", { sessionId, parentRequestId: callRequestId, all: true, after: entries.at(-1)?.id });
		check("host/history: no next on the last page", (last.entries ?? []).length === 0 && last.next == null, JSON.stringify(last).slice(0, 200));
	});
	await tryCheck("host/history: an unknown after", async () => {
		const r = await outcome(ask("host/history", { sessionId, parentRequestId: callRequestId, after: "probe-no-such-entry" }));
		check("host/history: an unknown after is invalid_request, -32602", codeOf(r.error) === "invalid_request" && r.error?.code === -32602, JSON.stringify(r));
	});
	await tryCheck("host/history: limit 0", async () => {
		const r = await outcome(ask("host/history", { sessionId, parentRequestId: callRequestId, limit: 0 }));
		check("host/history: limit 0 is invalid_request", codeOf(r.error) === "invalid_request", JSON.stringify(r));
	});
	await tryCheck("host/history: by session", async () => {
		const r = await outcome(ask("host/history", { sessionId }));
		check("host/history: may name an open session directly", Array.isArray(r.result?.entries), JSON.stringify(r).slice(0, 200));
	});
	await tryCheck("authority: no parent", async () => {
		const r = await outcome(ask("host/env/exists", { cwd, sessionId, path: "x" }));
		check("authority: host/env/* without a parent is invalid_request", codeOf(r.error) === "invalid_request", JSON.stringify(r));
	});
	await tryCheck("authority: an answered parent", async () => {
		const stale = answered.find((id) => id !== callRequestId);
		const r = await outcome(ask("host/ask", { parentRequestId: stale, request: { kind: "text", question: "never shown" } }));
		check("authority: a parent already answered is invalid_request", stale !== undefined && codeOf(r.error) === "invalid_request", JSON.stringify({ stale, r }));
	});
	await tryCheck("authority: another provider's credential", async () => {
		const r = await outcome(ask("host/credentials/read", { provider: "probe-not-mine" }));
		check("authority: another plugin's provider credential is invalid_request", codeOf(r.error) === "invalid_request", JSON.stringify(r));
	});
	await tryCheck("unknown host method", async () => {
		const r = await outcome(ask("host/probe-no-such-method", { parentRequestId: callRequestId }));
		check("an unknown host method is JSON-RPC -32601", r.error?.code === -32601, JSON.stringify(r));
	});
	await tryCheck("cancel before start", async () => {
		// The request and its cancel in one write, so the host reads both before it starts the work.
		const r = request("host/env/exec", { parentRequestId: callRequestId, cwd, sessionId, command: "sleep 20" }, 8000);
		process.stdout.write(
			JSON.stringify({ jsonrpc: "2.0", id: r.id, method: "host/env/exec", params: { parentRequestId: callRequestId, cwd, sessionId, command: "sleep 20" } }) +
				"\n" +
				JSON.stringify({ jsonrpc: "2.0", method: "$/cancel", params: { id: r.id } }) +
				"\n",
		);
		const t0 = Date.now();
		const o = await outcome(r.promise);
		check("cancelling: a request cancelled before it started is still answered", !o.error?.timeout, JSON.stringify(o));
		check("cancelling: that answer is a result or cancelled, within 5 s", (o.result !== undefined || codeOf(o.error) === "cancelled") && Date.now() - t0 < 5000, JSON.stringify({ o, ms: Date.now() - t0 }));
	});
	await tryCheck("parent in flight", async () => {
		const r = await outcome(ask("host/env/exists", { parentRequestId: callRequestId, cwd, sessionId, path: "probe-no-such-file" }));
		check("authority: host/env/* with a live parent works", r.result?.exists === false, JSON.stringify(r));
	});
	return checks;
}

async function onRequest(m) {
	const p = m.params ?? {};
	switch (m.method) {
		case "plugin/initialize":
			config = p.config ?? {};
			if (p.binding !== BINDING) return send({ id: m.id, error: { code: -32000, message: "unknown binding", data: { code: "not_supported" } } });
			return reply(m.id, registration());
		case "plugin/shutdown":
			if (config.out && config.role !== "probe") appendFileSync(config.out, JSON.stringify({ method: m.method, params: p }) + "\n");
			return reply(m.id, {});
		case "$/ping":
			return reply(m.id, {});
		case "tools/list":
			return reply(m.id, { tools: registration().toolSources?.[0]?.tools ?? [] });
		case "tools/call": {
			const checks = await runChecks(m.id, p.sessionId);
			if (config.out) writeFileSync(config.out, JSON.stringify(checks, null, 1));
			const failed = checks.filter((c) => !c.ok);
			return reply(m.id, { status: "completed", content: [{ type: "text", text: `probe: ${checks.length - failed.length}/${checks.length} host checks passed` }] });
		}
		default:
			return send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}`, data: { code: "unknown_handler" } } });
	}
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
		const line = buffer.slice(0, i).trim();
		buffer = buffer.slice(i + 1);
		if (!line) continue;
		let m;
		try {
			m = JSON.parse(line);
		} catch {
			continue;
		}
		if (m.method && m.id !== undefined) void onRequest(m);
		else if (m.method) continue; // notifications: $/cancel for a tools/call is ignored; the checks are short
		else if (pending.has(m.id)) {
			const { resolve, reject } = pending.get(m.id);
			pending.delete(m.id);
			if (m.error) reject(m.error);
			else resolve(m.result);
		}
	}
});
process.stdin.on("end", () => process.exit(0));
