#!/usr/bin/env node
// Disposable background-job fixture for Plugin binding: Jobs. It does not run an external executor.
import { appendFileSync } from "node:fs";
import { isDeepStrictEqual as equal } from "node:util";
import { rpcError, serve } from "./peer.mjs";

const binding = "modular-agent-plugin/1";
const name = "conformance-jobs";
const toolSource = "conformance-jobs-tools";
const tools = [{ name: "background", description: "Start a test job that reports later.", parameters: { type: "object", properties: { text: { type: "string" }, ms: { type: "number", minimum: 0 } }, required: ["text", "ms"] } }];
const running = new Map();
let config = {}, stopping = false;
const note = (event) => config.out && appendFileSync(config.out, JSON.stringify(event) + "\n");
const text = (value) => [{ type: "text", text: value }];
const all = async (ask, sessionId) => {
	const entries = [];
	for (let after, page = 0; page < 50; page++) {
		const r = await ask("host/history", { sessionId, all: true, ...(after ? { after } : {}) });
		entries.push(...r.entries);
		if (!r.next) return entries;
		after = r.next;
	}
	throw rpcError("internal", "fixture history too long");
};

function end(job, kind, result) {
	if (job.ending) return job.ending;
	clearTimeout(job.timer);
	const { jobId, sessionId } = job;
	const p = { jobId, outcome: { kind }, ...(result ? { result } : {}), report: !!result };
	job.ending = (async () => {
		await peer.ask("host/jobs/end", p);
		// Jobs and Shared data: Job reports. The first read after acknowledgement sees the end and its admission.
		const entries = await all(peer.ask, sessionId);
		const ended = entries.filter((e) => e.kind === "jobEnded" && e.jobId === jobId);
		const receipts = entries.filter((e) => e.kind === "inputAccepted" && e.data?.key === `job:${jobId}`);
		const commit = ended.length === 1 && ended[0].data?.report === !!result && ended[0].data?.outcome?.kind === kind;
		const admission = result ? receipts.length === 1 && equal(receipts[0].data?.content, result) && receipts[0].jobId === jobId && receipts[0].data?.when === "after" && entries.indexOf(ended[0]) < entries.indexOf(receipts[0]) : receipts.length === 0;
		note({ ended: jobId, outcome: kind, commit, admission });
		// Jobs: an identical end is an acknowledgement, not a second transition.
		if (result) {
			await peer.ask("host/jobs/end", p);
			const after = await all(peer.ask, sessionId);
			note({ repeatedEnd: jobId, once: after.filter((e) => e.kind === "jobEnded" && e.jobId === jobId).length === 1 && after.filter((e) => e.kind === "inputAccepted" && e.data?.key === `job:${jobId}`).length === 1 });
		}
		if (!commit || !admission) throw rpcError("lost", "job transition not visible at acknowledgement");
	})().catch((error) => { note({ endFailed: jobId, code: error?.data?.code }); throw error; });
	return job.ending;
}

async function takeUp(sessionId, jobs) {
	for (const j of jobs) {
		await peer.ask("host/jobs/resume", { jobId: j.jobId });
		// Jobs: the first successful resume is still running on this connection.
		const duplicate = await peer.ask("host/jobs/resume", { jobId: j.jobId }).then(
			() => false, (e) => e?.code === -32602 && e?.data?.code === "invalid_request",
		);
		note({ resumed: j.jobId, duplicateRefused: duplicate });
		const job = { jobId: j.jobId, sessionId };
		running.set(j.jobId, job);
		await end(job, "completed", text(`background: ${j.detail?.text} (taken up)`));
	}
}

const peer = serve("jobs", async (m, { ask, signal }) => {
	const p = m.params ?? {};
	if (stopping) throw rpcError("invalid_request");
	switch (m.method) {
		case "plugin/initialize":
			if (p.binding !== binding || p.data !== "modular-agent-data/1") throw rpcError("not_supported");
			config = p.config ?? {};
			return { binding, name, toolSources: [{ id: toolSource, tools }], hooks: [{ hook: "session.start", handlerId: 1 }] };
		case "plugin/shutdown":
			stopping = true;
			for (const j of running.values()) clearTimeout(j.timer);
			await Promise.allSettled([...running.values()].map((j) => j.ending));
			return {};
		case "$/ping": return {};
		case "tools/list":
			if (p.toolSource !== toolSource || p.sessionId !== undefined) throw rpcError("invalid_request");
			return { tools };
		case "tools/call": {
			const { call, sessionId } = p;
			if (p.toolSource !== toolSource || call?.name !== "background" || typeof call.id !== "string" || !sessionId) throw rpcError("invalid_request");
			const { text: message, ms } = call.input ?? {};
			if (typeof message !== "string" || !Number.isFinite(ms) || ms < 0) throw rpcError("invalid_request");
			try {
				const start = { parentRequestId: m.id, kind: "background", key: `background:${call.id}`, detail: { text: message, ms } };
				const { jobId, started } = await ask("host/jobs/start", start);
				if (started) {
					const job = { jobId, sessionId };
					running.set(jobId, job);
					job.timer = setTimeout(() => void end(job, "completed", text(`background: ${message}`)).catch(() => undefined), ms);
				}
				if (signal.aborted) throw rpcError("cancelled");
				// Jobs: commit before start acknowledgement, then same-key start is idempotent.
				const saved = (await all(ask, sessionId)).filter((e) => e.kind === "jobStarted" && e.jobId === jobId);
				const duplicate = await ask("host/jobs/start", start);
				note({ started: jobId, fresh: started, commit: saved.length === 1 && saved[0].writer === name, duplicate: duplicate.jobId === jobId && duplicate.started === false });
				return { status: "completed", content: text(`started job ${jobId}`) };
			} catch (error) {
				if (signal.aborted) throw rpcError("cancelled");
				note({ startFailed: call.id, code: error?.data?.code });
				return { status: "failed", content: text("Could not start the fixture job.") };
			}
		}
		case "hook/handle": {
			if (p.hook !== "session.start" || p.handlerId !== 1) throw rpcError("unknown_handler");
			if (!p.payload?.resumed) return null;
			// Jobs: list while session.start is still live. An idle session can close as soon as it opens.
			const { sessionId } = p.payload;
			const failed = (e) => note({ takeUpFailed: e?.data?.code ?? "internal" });
			const { jobs } = await ask("host/jobs/unfinished", { sessionId }).catch((e) => { failed(e); throw e; });
			note({ unfinished: jobs.map((j) => j.jobId) });
			if (jobs.length) setImmediate(() => void takeUp(sessionId, jobs).catch(failed));
			return null;
		}
		case "jobs/cancel": {
			const job = running.get(p.jobId);
			if (!job) throw rpcError("invalid_request");
			await end(job, "cancelled");
			return {};
		}
		default: throw rpcError("method_not_found");
	}
});
