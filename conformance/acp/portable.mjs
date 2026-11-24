// Shared data: Entry fields and tombstones, Standard kinds, Recording order and ownership,
// and Append order and the branch. This samples record shapes and identities, not the full schema.
import { isDeepStrictEqual } from "node:util";

const id = (x) => typeof x === "string" && x.length > 0;
const obj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const count = (x) => Number.isSafeInteger(x) && x >= 0;
const ids = (x) => Array.isArray(x) && x.every(id);
const someIds = (x) => ids(x) && x.length > 0;
const content = (x) => Array.isArray(x) && x.every((p) => obj(p) && id(p.type) && (p.type !== "text" || typeof p.text === "string"));
export const validActor = (x) => id(x?.id) && ["user", "host", "agent", "program"].includes(x.kind) && ids(x.rights);
const model = (x) => id(x?.provider) && id(x?.id);
const usage = (x) => ["input", "output", "cacheRead", "cacheWrite"].every((k) => count(x?.[k])) && typeof x?.cost === "number" && x.cost >= 0;
const outcome = (x, job = false) => x && (["completed", "cancelled"].includes(x.kind) || (x.kind === "failed" && typeof x.error === "string") || (job ? x.kind === "outcomeUnknown" : x.kind === "limit" && id(x.limit)));
const opt = (x, k, pred) => !Object.hasOwn(x, k) || pred(x[k]);
// Shared data: Entry fields and tombstones.
const tombstoneAssocs = ["turnId", "stepId", "toolCallId", "jobId", "inputId", "requestId", "continuesTurnId"];
const assocs = [...tombstoneAssocs, "actorId"];
const tombstone = ["id", "parentId", "kind", "erased", ...tombstoneAssocs, "sources", "usage", "writer", "jobKey"];
const authority = (d) => ids(d.rights) && Array.isArray(d.authorizers) && d.authorizers.every(a =>
	obj(a) && id(a.sessionId) && (id(a.actorId) && !Object.hasOwn(a, "jobId") || id(a.jobId) && !Object.hasOwn(a, "actorId")));
const taken = v => ["now", "after", "inTurn", "proposed"].includes(v);
const deadline = (e, q) => !Object.hasOwn(q, "timeLimitMs") ? !Object.hasOwn(q, "deadlineAt") :
	count(q.timeLimitMs) && count(q.deadlineAt) && q.deadlineAt === e.time + q.timeLimitMs;
const registration = (d) => id(d.source?.plugin) && id(d.source?.toolSource) && id(d.definition?.name) && typeof d.definition.description === "string" && (typeof d.definition.parameters === "boolean" || obj(d.definition.parameters));
const status = ["completed", "failed", "refused", "cancelled", "notStarted", "outcomeUnknown"];

const valid = {
	inputAccepted: (e, d) => authority(d) && opt(d, "releasedBy", id) && opt(d, "taken", taken) && (id(d.releasedBy) || (e.jobId ? typeof d.parked === "boolean" : taken(d.taken))) && id(e.actorId) && id(e.inputId) && content(d.content) && opt(d, "key", id) && opt(d, "parked", (p) => typeof p === "boolean") && ["now", "steer", "after", "propose"].includes(d.when),
	inputHandedBack: (e, d) => id(e.inputId) && ["withdrawn", "declined", "cancelled", "restart", "conflict", "handled", "turnEnded"].includes(d.reason),
	input: (e) => id(e.actorId) && id(e.turnId) && id(e.inputId) && e.message?.role === "user" && content(e.message.content),
	turnStart: (e, d) => authority(d) && id(e.turnId) && id(d.startedBy?.id) && ["actor", "job", "plugin", "answer", "toolResult"].includes(d.startedBy.kind) && (!["answer", "toolResult"].includes(d.startedBy.kind) || id(e.continuesTurnId)) && (d.model === null || model(d.model)) && typeof d.system === "string" && Array.isArray(d.tools) && obj(d.settings) && opt(d, "context", content) && opt(d, "point", id),
	modelRequest: (e, d) => id(e.stepId) && model(d.model) && typeof d.safeToRepeat === "boolean" && ids(d.tools) && Object.hasOwn(d, "request") === d.safeToRepeat && opt(d, "request", (r) => obj(r) && typeof r.systemPrompt === "string" && Array.isArray(r.messages) && obj(r.settings) && Array.isArray(r.tools) && r.tools.length === d.tools.length && r.tools.every((t, i) => t?.name === d.tools[i])),
	"modular-agent.stepAfter": (e, d) => id(e.stepId) && id(e.turnId) && !e.modelVisible && (d.decision === null || typeof d.decision?.refuse === "string"),
	response: (e) => id(e.stepId) && e.message?.role === "assistant" && content(e.message.content) && id(e.message.stop) && opt(e.message, "usage", usage),
	toolStarted: (e, d) => authority(d) && registration(d) && d.definition.name === d.call?.name && id(e.toolCallId) && id(e.actorId) && d.call?.actorId === e.actorId && d.call?.id === e.toolCallId && id(d.call.name) && obj(d.call.input) && typeof d.safeToRepeat === "boolean",
	toolPending: (e, d) => id(e.toolCallId) && id(e.turnId) && e.modelVisible === false && someIds(d.requestIds) && opt(d, "toolStartedId", id),
	toolResult: (e, d) => id(e.toolCallId) && status.includes(d.status) && e.message?.role === "toolResult" && e.message.toolCallId === e.toolCallId && id(e.message.toolName) && content(e.message.content) && e.message.isError === (d.status !== "completed"),
	inputRequest: (e, d) => id(d.request?.id) && e.requestId === d.request.id && id(d.request.askedBy) && deadline(e, d.request) && id(d.request.kind) && id(d.request.sessionId) && typeof d.request.question === "string" && typeof d.request.answerable === "boolean" && opt(d.request, "answerers", ids) && (d.request.kind !== "approval" || (registration(d) && d.call?.id === e.toolCallId && id(d.call?.id) && d.definition.name === d.call.name && obj(d.call.input))),
	secretAnswerAccepted: (e) => id(e.requestId) && id(e.actorId) && e.modelVisible === false && !Object.hasOwn(e, "data"),
	inputAnswer: (e, d) => id(e.requestId) && opt(d, "actorId", id),
	// Shared data: Standard kinds.
	resultFeedback: (e, d) => id(e.turnId) && e.modelVisible === true && typeof d.reason === "string",
	turnEnd: (e, d) => id(e.turnId) && outcome(d.outcome) && ids(d.result?.openToolCalls) && usage(d.usage),
	summary: (e, d) => ids(e.sources) && e.sources.length > 0 && typeof d.summary === "string",
	setting: (_, d) => id(d.key) && Object.hasOwn(d, "value") && (d.key !== "model" || model(d.value)),
	actorJoined: (_, d) => validActor(d.actor),
	actorLeft: (_, d) => id(d.actorId),
	limit: (e, d) => id(e.actorId) && (d.rights === null || ids(d.rights)),
	tenant: (_, d) => id(d.tenant),
	position: (_, d) => d.failed !== true && (d.to === null || id(d.to)) && opt(d, "restore", (v) => id(v?.point) && id(v?.undo)),
	erasure: (_, d) => ids(d.entryIds),
	jobStarted: (e, d) => id(e.jobId) && id(e.actorId) && id(d.kind) && Object.hasOwn(d, "detail") && authority(d),
	jobCleanupUnconfirmed: (e) => id(e.jobId) && e.modelVisible === false && !Object.hasOwn(e, "data"),
	jobEnded: (e, d) => id(e.jobId) && outcome(d.outcome, true) && typeof d.report === "boolean" && (!d.report || content(d.result)),
	plugins: (_, d) => Array.isArray(d.active) && d.active.every((p) => id(p?.name) && opt(p, "origin", (x) => typeof x === "string")),
};
const protectedKinds = new Set(["actorJoined", "actorLeft", "limit", "tenant", "position", "jobCleanupUnconfirmed", "erasure"]);

export function portableProblems(sessionId, entries) {
	const out = [];
	const say = (e, message) => out.push(`${e.kind ?? "?"} ${String(e.id).slice(0, 8)}: ${message}`);
	const byId = new Map(), turns = new Set(), attempts = new Map(), replies = new Set(), tools = new Set(), jobs = new Set(), admitted = new Map();
	const terminals = new Map([["turnEnd", new Set()], ["toolResult", new Set()], ["jobEnded", new Set()]]);
	const questions = new Map(), pending = new Map(), decisions = new Set();
	const sameScope = (a, b) => a && b && ["turnId", "stepId", "toolCallId"].every((k) => a[k] === b[k]);
	const members = new Map();
	let head = null, tenant, limit = null;
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
			if (["inputAccepted", "inputHandedBack", "input"].includes(e.kind) && !id(e.inputId) ||
				["inputRequest", "inputAnswer"].includes(e.kind) && !id(e.requestId)) say(e, "missing tombstone association");
		} else {
			if (e.sessionId !== sessionId || !count(e.time) || !id(e.writer) || typeof e.modelVisible !== "boolean" || !(standard || (custom && !e.modelVisible))) say(e, "invalid live entry envelope");
			if (standard && !valid[e.kind](e, d)) say(e, "invalid standard payload");
			if (!opt(e, "sources", (a) => ids(a) && a.every((i) => byId.has(i)))) say(e, "source is not an earlier entry");
			// Shared data: Standard kinds, Append order and the branch, Session state.
			// Contracts: Authority. Tenant policy comes from the operator, not the log.
			if (e.kind === "actorJoined") {
				const operator = d.operatorAdmission === true && !Object.hasOwn(e, "actorId");
				const member = !Object.hasOwn(d, "operatorAdmission") && id(e.actorId) && e.actorId !== d.actor?.id &&
					members.get(e.actorId)?.includes("grant") && (limit === null || limit.includes("grant"));
				if (!operator && !member) say(e, "Standard kinds / Authority: actorJoined lacks operator admission or an earlier member with grant");
				if (validActor(d.actor)) members.set(d.actor.id, d.actor.rights);
			} else if (e.kind === "actorLeft") members.delete(d.actorId);
			else if (e.kind === "limit" && (d.rights === null || ids(d.rights))) limit = d.rights;
			if (e.kind === "tenant") {
				if (tenant !== undefined && tenant !== d.tenant) say(e, "tenant changed");
				tenant = d.tenant;
			}
			if (e.kind === "inputRequest") questions.set(e.requestId, e);
			if (e.kind === "inputAnswer") {
				const question = questions.get(e.requestId);
				if (question && !sameScope(e, question)) say(e, "answer changes the question scope");
			}
			if (e.kind === "toolPending") {
				const seen = pending.get(e.turnId) ?? new Set();
				if (seen.has(e.toolCallId)) say(e, "repeated pending checkpoint in the same turn");
				seen.add(e.toolCallId);
				pending.set(e.turnId, seen);
				const start = byId.get(d.toolStartedId);
				if (d.toolStartedId !== undefined && !start?.erased && (start?.kind !== "toolStarted" || !sameScope(start, e))) say(e, "pending checkpoint does not name its own invocation's start");
				if (Array.isArray(d.requestIds) && d.requestIds.some((i) => questions.has(i) && !sameScope(questions.get(i), e))) say(e, "pending checkpoint changes the question scope");
			}
		}
		if (e.kind === "inputAccepted") {
			if (d.releasedBy && !admitted.has(e.inputId)) say(e, "release without an earlier admission");
			admitted.set(e.inputId, e);
		}
		if (["input", "inputHandedBack"].includes(e.kind) && !admitted.has(e.inputId)) say(e, "no earlier admission");
		if (e.continuesTurnId !== undefined && e.kind === "turnStart" && !turns.has(e.continuesTurnId)) say(e, "unknown continuation origin");
		if (e.kind === "turnStart") {
			if (turns.has(e.turnId)) say(e, "duplicate turn start");
			turns.add(e.turnId);
		} else if (e.turnId !== undefined && !turns.has(e.turnId)) say(e, "unknown turn");
		if (e.kind === "modelRequest") {
			if (attempts.has(e.stepId)) say(e, "reused step ID");
			attempts.set(e.stepId, e);
		} else if (e.kind === "response") {
			const intent = attempts.get(e.stepId);
			if (!intent || intent.turnId !== e.turnId || (!Array.isArray(e.sources) || !e.sources.includes(intent.id)) || replies.has(e.stepId)) say(e, "unknown, mismatched or repeated model attempt");
			replies.add(e.stepId);
		} else if (e.kind === "modular-agent.stepAfter") {
			const intent = attempts.get(e.stepId);
			if (!replies.has(e.stepId) || intent?.turnId !== e.turnId || intent?.data?.auxiliary || decisions.has(e.stepId))
				say(e, "step decision needs one answered step attempt");
			decisions.add(e.stepId);
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
	for (const [i, e] of entries.entries()) {
		if (e?.kind !== "jobEnded" || e.erased || e.data?.report !== true) continue;
		// Atomicity is checked against observed append batches in the jobs transcript.
		const a = entries.slice(i + 1).find(x => x?.kind === "inputAccepted" && x.jobId === e.jobId);
		if (!a || !id(a.inputId) ||
			!a.erased && (a.data?.key !== `job:${e.jobId}` || a.data?.releasedBy !== undefined || typeof a.data?.parked !== "boolean" || !isDeepStrictEqual(a.data?.content, e.data.result)))
			say(e, "missing or inconsistent report admission");
	}
	return out;
}
