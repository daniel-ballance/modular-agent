// Plugin binding: Paging history and recovery from a detached, erased settlement.
import { rpcError } from "./peer.mjs";

export function historyForSelector(view, select, agreed) {
	if (select === undefined) return view;
	const id = value => typeof value === "string" && value.length > 0;
	if (!agreed || !select || typeof select !== "object" || Array.isArray(select) ||
		!Object.keys(select).length || Object.keys(select).some(key => !["turnId", "toolCallIds"].includes(key)) ||
		("turnId" in select && !id(select.turnId)) ||
		("toolCallIds" in select && (!Array.isArray(select.toolCallIds) || !select.toolCallIds.length ||
			select.toolCallIds.length > 64 || !select.toolCallIds.every(id) || new Set(select.toolCallIds).size !== select.toolCallIds.length))) {
		throw rpcError("invalid_request");
	}
	return view.filter(e => e.turnId !== undefined && e.turnId === select.turnId || select.toolCallIds?.includes(e.toolCallId));
}

export async function lateSettlement({ start, initParams, part, runScenario, say, turn, check, before, entry, notStarted, startedCall, safeCall }) {
	const peer = start({ MODULAR_AGENT_PLUGIN_PARTS: part });
	try {
		peer.state.reg = await peer.request("plugin/initialize", { ...initParams, historySelect: 1 });
		const origin = [entry("turnStart", { turnId: "origin" }), entry("turnEnd", { turnId: "origin", data: { result: { openToolCalls: ["inherited"] } } })];
		const extra = Array.from({ length: 65 }, (_, index) => ({ type: "toolCall", id: `extra-${index}`, name: "read", arguments: { path: "extra" } }));
		const branch = [...origin, ...before.map(e => {
			if (e.kind === "turnStart") return { ...e, continuesTurnId: "origin" };
			if (e.kind === "response") return { ...e, message: { ...e.message, content: [...e.message.content, ...extra] } };
			return e;
		}), entry("toolPending", { toolCallId: safeCall.id, stepId: safeCall.stepId })];
		for (let i = 1; i < branch.length; i++) branch[i] = { ...branch[i], parentId: branch[i - 1].id };
		const later = entry("turnStart", { turnId: "later-turn", continuesTurnId: "kit-turn", parentId: branch.at(-1).id });
		const detached = [later, ...[safeCall, notStarted, { id: "inherited" }, ...extra].map(call => ({
			id: `settled-${call.id}`, kind: "toolResult", parentId: later.id,
			turnId: later.turnId, stepId: call.stepId ?? safeCall.stepId, toolCallId: call.id, erased: true,
		}))];
		const rt = peer.state.rt = runScenario({ model: () => say("carried on"), before: branch, abandoned: [startedCall] });
		const history = rt.history;
		rt.history = all => all ? [...history(), ...detached] : history();
		const resume = await peer.request("runtime/resumeTurn", { turn: turn(), interrupted: { turnId: "kit-turn", calls: [], lastStep: { stepId: "kit-step-1" } } }).catch(error => ({ error: error.message }));
		const reads = peer.hostCalls.filter(c => c.method === "host/history").map(c => c.params);
		const selected = peer.state.reg.historySelect === 1;
		const required = process.env.MODULAR_AGENT_PLUGIN_REQUIRE_HISTORY_SELECT === "1";
		const keptIds = new Set(reads.filter(p => p.all).flatMap(p => p.select?.toolCallIds ?? []));
		check("durable-runtime: resume finds detached tombstones for pending and offered calls without dispatching them",
			resume.outcome?.kind === "completed" && !resume.result.openToolCalls.length && !rt.toolCalls.length &&
			(selected
				? reads.some(p => !p.all && p.select?.turnId === "kit-turn" && !p.select.toolCallIds) &&
					reads.some(p => !p.all && p.select?.turnId === "origin") &&
					reads.some(p => p.all && p.select?.turnId === "kit-turn") &&
					[safeCall.id, notStarted.id, "inherited", ...extra.map(c => c.id)].every(id => keptIds.has(id))
				: !required && reads.length > 0 && reads.every(p => p.select === undefined)),
			JSON.stringify({ selected, outcome: resume.outcome, error: resume.error, reads }));
	} finally {
		await peer.request("plugin/shutdown", { reason: "stop" }).catch(() => undefined);
		await peer.stop();
	}
}

export async function checkHostSelectors({ ask, invalid, scope, entries, callId, deadParent }) {
	const turnId = entries.find(e => e.kind === "turnStart")?.turnId;
	const select = { turnId };
	const params = { ...scope, all: true, select };
	const expected = historyForSelector(entries, select, true);
	const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
	let after;
	for (const [i, entry] of expected.entries()) {
		const page = await ask("host/history", { ...params, after, limit: 1 });
		if (!equal(page.entries, [entry]) || page.next !== (i + 1 < expected.length ? entry.id : undefined)) return "Wrong matching entry or cursor";
		after = page.next;
	}
	if (expected.length < 2 || entries.at(-1)?.id === expected.at(-1).id) return "Fixture lacks sparse paging or a trailing unrelated entry";
	const mixed = { turnId, toolCallIds: [callId] };
	const matches = historyForSelector(entries, mixed, true);
	if (!equal(await ask("host/history", { ...params, select: mixed }), { entries: matches })) return "Mixed selectors did not return the ordered union";
	const overlap = { ...mixed, turnId: entries.find(e => e.toolCallId === callId)?.turnId };
	if (!equal(await ask("host/history", { ...params, select: overlap }), { entries: historyForSelector(entries, overlap, true) })) return "Mixed selectors duplicated a match";

	const unmatched = entries.find(e => !expected.some(match => match.id === e.id));
	if (!unmatched || !await invalid("host/history", { ...params, after: unmatched.id }) ||
		!await invalid("host/history", { ...params, after: null })) return "Invalid or nonmatching cursor was accepted";
	for (const bad of [null, [], "turn", {}, { unknown: true }, { turnId: "" }, { turnId: 1 }, { toolCallIds: [] },
		{ toolCallIds: ["dup", "dup"] }, { toolCallIds: [1] }, { toolCallIds: Array.from({ length: 65 }, (_, i) => String(i)) }]) {
		if (!await invalid("host/history", { ...params, select: bad })) return `Accepted invalid selector ${JSON.stringify(bad)}`;
	}
	const empty = { ...params, select: { turnId: "fixture-absent-turn" } };
	if (!equal(await ask("host/history", empty), { entries: [] })) return "Empty match returned data or a cursor";
	if (!await invalid("host/history", { ...empty, sessionId: "fixture-other-session" }) ||
		!await invalid("host/history", { ...empty, parentRequestId: deadParent ?? "fixture-dead-parent" }) ||
		!await invalid("host/history", { ...empty, sessionId: "fixture-unopened-session", parentRequestId: undefined })) {
		return "Empty match bypassed authority";
	}
}
