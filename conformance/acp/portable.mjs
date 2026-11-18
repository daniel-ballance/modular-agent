// Shared data: Entry fields and tombstones, Standard kinds, Recording order and ownership,
// and Append order and the branch. This samples record shapes and identities, not the full schema.
const id = (x) => typeof x === "string" && x.length > 0;
const obj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const count = (x) => Number.isSafeInteger(x) && x >= 0;
const ids = (x) => Array.isArray(x) && x.every(id);
const content = (x) => Array.isArray(x) && x.every((p) => obj(p) && id(p.type) && (p.type !== "text" || typeof p.text === "string"));
const actor = (x) => id(x?.id) && ["user", "host", "agent", "program", "plugin"].includes(x.kind) && ids(x.rights);
const model = (x) => id(x?.provider) && id(x?.id);
const usage = (x) => ["input", "output", "cacheRead", "cacheWrite"].every((k) => count(x?.[k])) && typeof x?.cost === "number" && x.cost >= 0;
const outcome = (x, job = false) => x && (["completed", "cancelled"].includes(x.kind) || (x.kind === "failed" && typeof x.error === "string") || (job ? x.kind === "outcomeUnknown" : x.kind === "limit" && id(x.limit)));
const opt = (x, k, pred) => !Object.hasOwn(x, k) || pred(x[k]);
// Shared data: Entry fields and tombstones.
const tombstoneAssocs = ["turnId", "stepId", "toolCallId", "jobId", "inputId", "requestId", "continuesTurnId"];
const assocs = [...tombstoneAssocs, "actorId"];
const tombstone = ["id", "parentId", "kind", "erased", ...tombstoneAssocs, "sources", "usage", "writer", "jobKey"];
const inputIdOf = (e) => e.inputId ?? e.data?.inputId;
const status = ["completed", "failed", "refused", "cancelled", "notStarted", "outcomeUnknown"];

const valid = {
	inputAccepted: (e, d) => id(e.actorId) && id(inputIdOf(e)) && content(d.content) && opt(d, "key", id) && opt(d, "parked", (p) => typeof p === "boolean") && ["now", "steer", "after", "propose"].includes(d.when),
	inputHandedBack: (e, d) => id(inputIdOf(e)) || ids(d.inputIds),
	input: (e) => id(e.actorId) && id(e.turnId) && id(inputIdOf(e)) && e.message?.role === "user" && content(e.message.content),
	turnStart: (e, d) => id(e.turnId) && id(d.startedBy?.id) && ["actor", "job", "plugin", "answer"].includes(d.startedBy.kind) && (d.model === null || model(d.model)) && typeof d.system === "string" && Array.isArray(d.tools) && obj(d.settings) && opt(d, "context", content) && opt(d, "point", id),
	modelRequest: (e, d) => id(e.stepId) && model(d.model) && typeof d.safeToRepeat === "boolean" && opt(d, "request", obj),
	response: (e) => id(e.stepId) && e.message?.role === "assistant" && content(e.message.content) && id(e.message.stop) && opt(e.message, "usage", usage),
	toolStarted: (e, d) => id(e.toolCallId) && id(e.actorId) && d.call?.actorId === e.actorId && d.call?.id === e.toolCallId && id(d.call.name) && obj(d.call.input) && typeof d.safeToRepeat === "boolean",
	toolResult: (e, d) => id(e.toolCallId) && status.includes(d.status) && e.message?.role === "toolResult" && e.message.toolCallId === e.toolCallId && id(e.message.toolName) && content(e.message.content) && e.message.isError === (d.status !== "completed"),
	inputRequest: (_, d) => id(d.request?.id) && id(d.request.kind) && id(d.request.sessionId) && typeof d.request.question === "string" && typeof d.request.answerable === "boolean" && opt(d.request, "answerers", ids),
	inputAnswer: (e, d) => id(e.requestId ?? d.requestId) && opt(d, "actorId", id),
	turnEnd: (e, d) => id(e.turnId) && outcome(d.outcome) && ids(d.result?.openToolCalls) && usage(d.usage),
	summary: (e, d) => ids(e.sources) && e.sources.length > 0 && typeof d.summary === "string",
	setting: (_, d) => id(d.key) && Object.hasOwn(d, "value") && (d.key !== "model" || model(d.value)),
	actorJoined: (_, d) => actor(d.actor),
	actorLeft: (_, d) => id(d.actorId),
	limit: (e, d) => id(e.actorId) && (d.rights === null || ids(d.rights)),
	tenant: (_, d) => id(d.tenant),
	position: (_, d) => (d.to === null || id(d.to)) && opt(d, "restore", (v) => id(v?.point) && id(v?.undo)),
	erasure: (_, d) => ids(d.entryIds),
	jobStarted: (e, d) => id(e.jobId) && id(e.actorId) && id(d.kind) && Object.hasOwn(d, "detail") && opt(d, "rights", ids),
	jobCleanupUnconfirmed: (e) => id(e.jobId) && e.modelVisible === false && !Object.hasOwn(e, "data"),
	jobEnded: (e, d) => id(e.jobId) && outcome(d.outcome, true) && typeof d.report === "boolean" && (!d.report || content(d.result)),
	plugins: (_, d) => Array.isArray(d.active) && d.active.every((p) => id(p?.name) && opt(p, "origin", (x) => typeof x === "string")),
};
const protectedKinds = new Set(["actorJoined", "actorLeft", "limit", "tenant", "position", "turnStart", "modelRequest", "toolStarted", "turnEnd", "jobStarted", "jobCleanupUnconfirmed", "jobEnded", "erasure"]);

export function portableProblems(sessionId, entries) {
	const out = [];
	const say = (e, message) => out.push(`${e.kind ?? "?"} ${String(e.id).slice(0, 8)}: ${message}`);
	const byId = new Map(), turns = new Set(), attempts = new Map(), replies = new Set(), tools = new Set(), jobs = new Set(), admitted = new Map();
	const terminals = new Map([["turnEnd", new Set()], ["toolResult", new Set()], ["jobEnded", new Set()]]);
	const jobReports = new Map();
	let head = null, tenant;
	let erasedIntake = false;
	for (const e of entries) {
		if (!obj(e)) { out.push("entry is not an object"); continue; }
		const standard = Object.hasOwn(valid, e.kind);
		const custom = id(e.kind) && e.kind.includes(".");
		if (!id(e.id) || byId.has(e.id) || e.parentId !== head) say(e, "invalid id, duplicate, or parentId differs from previous head");
		if (assocs.some((k) => !opt(e, k, id))) say(e, "invalid association id");
		const d = obj(e.data) ? e.data : {};
		if (e.erased === true) {
			if ((!standard && !custom) || protectedKinds.has(e.kind) || Object.keys(e).some((k) => !tombstone.includes(k)) ||
				!opt(e, "sources", ids) || !opt(e, "usage", usage) || !opt(e, "writer", id) || !opt(e, "jobKey", id)) say(e, "invalid portable tombstone");
			if (e.kind === "inputAccepted") erasedIntake = true;
		} else {
			if (e.sessionId !== sessionId || !count(e.time) || !id(e.writer) || typeof e.modelVisible !== "boolean" || !(standard || (custom && !e.modelVisible))) say(e, "invalid live entry envelope");
			if (standard && !valid[e.kind](e, d)) say(e, "invalid standard payload");
			if (!opt(e, "sources", (a) => ids(a) && a.every((i) => byId.has(i)))) say(e, "source is not an earlier entry");
			if (e.kind === "tenant") {
				if (tenant !== undefined && tenant !== d.tenant) say(e, "tenant changed");
				tenant = d.tenant;
			}
			if (e.kind === "jobEnded" && d.report === true) jobReports.set(e.jobId, e);
			const inputId = inputIdOf(e);
			if (e.kind === "inputAccepted") admitted.set(inputId, e);
			if (e.kind === "input" && !admitted.has(inputId) && !erasedIntake) say(e, "no earlier admission");
			if (e.kind === "inputHandedBack" && !erasedIntake &&
				(inputId ? !admitted.has(inputId) : ids(d.inputIds) && d.inputIds.some((i) => !admitted.has(i)))) say(e, "no earlier admission for hand-back");
		}
		if (e.kind === "turnStart") {
			if (turns.has(e.turnId)) say(e, "duplicate turn start");
			turns.add(e.turnId);
		} else if (e.turnId !== undefined && !turns.has(e.turnId)) say(e, "unknown turn");
		if (e.kind === "modelRequest") {
			if (attempts.has(e.stepId)) say(e, "reused step ID");
			attempts.set(e.stepId, e.turnId);
		} else if (e.kind === "response") {
			if (!attempts.has(e.stepId) || attempts.get(e.stepId) !== e.turnId || replies.has(e.stepId)) say(e, "unknown, mismatched or repeated model attempt");
			replies.add(e.stepId);
		}
		if (e.kind === "toolStarted") {
			if (terminals.get("toolResult").has(e.toolCallId)) say(e, "tool started after terminal result");
			tools.add(e.toolCallId);
		}
		if (e.kind === "toolResult" && !tools.has(e.toolCallId) && entries.some((x) => x?.kind === "toolStarted" && x.toolCallId === e.toolCallId)) say(e, "tool result precedes start");
		if (e.kind === "jobStarted") {
			if (jobs.has(e.jobId)) say(e, "reused job ID");
			jobs.add(e.jobId);
		} else if (e.jobId !== undefined && !jobs.has(e.jobId)) say(e, "unknown job");
		const settled = terminals.get(e.kind);
		if (settled) {
			const i = e.kind === "turnEnd" ? e.turnId : e.kind === "jobEnded" ? e.jobId : e.toolCallId;
			if (!id(i) || settled.has(i)) say(e, "missing or duplicate terminal identity");
			settled.add(i);
		}
		if (e.kind === "position") {
			if (d.to !== null && (!byId.has(d.to) || byId.get(d.to).kind === "position")) say(e, "invalid position target");
			head = d.to;
		} else head = e.id;
		byId.set(e.id, e);
	}
	if (!erasedIntake) for (const [jobId, e] of jobReports) {
		if (![...admitted.values()].some((x) => x.jobId === jobId && x.data?.key === `job:${jobId}`)) say(e, "missing report admission");
	}
	return out;
}
