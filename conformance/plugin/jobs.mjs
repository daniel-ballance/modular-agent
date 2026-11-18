#!/usr/bin/env node
// The jobs plugin: checks that a host records jobs in the standard kinds, reports them, and lets the same plugin
// take up an unfinished job after a restart, in whichever build reopens the session (docs/bindings/plugin.md#jobs).
// The ACP kit loads it with --job-checks. It has no dependencies.
//
// It registers the tool `background` ({ text, ms }). A call starts a job that ends after ms milliseconds with the
// result "background: <text>", reported as input. When a session starts again (session.start, resumed), the plugin
// takes up its unfinished jobs and ends each with "background: <text> (taken up)". jobs/cancel ends a job as cancelled.
import { appendFileSync } from "node:fs";

const BINDING = "modular-agent-plugin/1";
let config = {};
let nextId = 1;
const pending = new Map();
const timers = new Map(); // jobId -> timer
let buffer = "";

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const note = (what) => config.out && appendFileSync(config.out, JSON.stringify(what) + "\n");
function ask(method, params, ms = 15000) {
	const id = `jobs-${nextId++}`;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => (pending.delete(id), reject({ message: `timed out: ${method}` })), ms);
		pending.set(id, { resolve: (r) => (clearTimeout(timer), resolve(r)), reject: (e) => (clearTimeout(timer), reject(e)) });
		send({ id, method, params });
	});
}
const text = (t) => [{ type: "text", text: t }];

async function end(jobId, outcome, result, report) {
	clearTimeout(timers.get(jobId));
	timers.delete(jobId);
	try {
		await ask("host/jobs/end", { jobId, outcome, ...(result ? { result } : {}), report });
		note({ ended: jobId, outcome: outcome.kind });
	} catch (e) {
		note({ endFailed: jobId, error: e });
	}
}

async function takeUp(sessionId) {
	try {
		const { jobs } = await ask("host/jobs/unfinished", { sessionId });
		note({ unfinished: (jobs ?? []).map((j) => j.jobId) });
		for (const j of jobs ?? []) {
			await ask("host/jobs/resume", { jobId: j.jobId });
			await end(j.jobId, { kind: "completed" }, text(`background: ${j.detail?.text} (taken up)`), true);
		}
	} catch (e) {
		note({ takeUpFailed: e });
	}
}

async function onRequest(m) {
	const p = m.params ?? {};
	switch (m.method) {
		case "plugin/initialize":
			config = p.config ?? {};
			if (p.binding !== BINDING) return send({ id: m.id, error: { code: -32000, message: "unknown binding", data: { code: "not_supported" } } });
			return send({
				id: m.id,
				result: {
					binding: BINDING,
					name: "conformance-jobs",
					toolSources: [{ id: "conformance-jobs-tools", perSession: false, tools: [{ name: "background", description: "Start a background job that reports later.", parameters: { type: "object", properties: { text: { type: "string" }, ms: { type: "number" } }, required: ["text", "ms"] } }] }],
					hooks: [{ hook: "session.start", handlerId: 1, order: "normal" }],
				},
			});
		case "plugin/shutdown":
			for (const t of timers.values()) clearTimeout(t);
			return send({ id: m.id, result: {} });
		case "$/ping":
			return send({ id: m.id, result: {} });
		case "tools/list":
			return send({ id: m.id, result: { tools: [] } });
		case "tools/call": {
			const call = p.call ?? {};
			try {
				const { jobId, started } = await ask("host/jobs/start", { parentRequestId: m.id, kind: "background", key: `background:${call.id}`, detail: { text: call.input?.text, ms: call.input?.ms } });
				note({ started: jobId, fresh: started });
				if (started !== false) timers.set(jobId, setTimeout(() => void end(jobId, { kind: "completed" }, text(`background: ${call.input?.text}`), true), Number(call.input?.ms ?? 0)));
				return send({ id: m.id, result: { status: "completed", content: text(`started job ${jobId}`) } });
			} catch (e) {
				return send({ id: m.id, result: { status: "failed", content: text(`could not start a job: ${e?.message ?? JSON.stringify(e)}`) } });
			}
		}
		case "hook/handle":
			send({ id: m.id, result: null });
			if (p.hook === "session.start" && p.payload?.resumed) void takeUp(p.payload.sessionId);
			return;
		case "jobs/cancel":
			await end(p.jobId, { kind: "cancelled" }, undefined, false);
			return send({ id: m.id, result: {} });
		default:
			return send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
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
		else if (m.method) continue;
		else if (pending.has(m.id)) {
			const { resolve, reject } = pending.get(m.id);
			pending.delete(m.id);
			if (m.error) reject(m.error);
			else resolve(m.result);
		}
	}
});
process.stdin.on("end", () => process.exit(0));
