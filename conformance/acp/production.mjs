// Opt-in ADR 0030 checks. Each profile has its own operator policy and data directory.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual as equal } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { upgradeStatus } from "../tools/websocket.mjs";

const NS = "modular-agent";
const meta = (x) => x?._meta?.[NS];
const rpc = (a, m, p) => a.ctx.request(m, p);
const ext = (a, m, p) => rpc(a, `_${NS}/${m}`, p);
const rights = "watch propose input answer approve cancel settings tools erase grant jobs delegate administer".split(" ");
const actor = { id: "kit-policy-actor", kind: "host", rights };
const tenantA = "kit-policy-a", tenantB = "kit-policy-b";
const init = (a, version = 1) => rpc(a, "initialize", { protocolVersion: 1, clientCapabilities: {}, _meta: { [NS]: { binding: `modular-agent-acp/${version}` } } });
const open = (a, cwd, tenant, mcpServers = []) => rpc(a, "session/new", { cwd, mcpServers, ...(tenant == null ? {} : { _meta: { [NS]: { tenant } } }) });
const load = (a, sessionId, cwd, method = "load") => rpc(a, `session/${method}`, { sessionId, cwd, mcpServers: [] });
const input = (a, sessionId, content, key, when = "after", extras = {}) => ext(a, "input", { sessionId, content, key, when, ...extras });
const errorOf = (p) => p.then(() => undefined, (e) => e);
const refusal = (e, code, number = -32602) => e?.code === number && e?.data?.code === code && !meta(e.data)?.inputId && !meta(e.data)?.outcome;
const rows = (k, entries) => entries.filter((e) => e.kind === k);
const contains = (value, text) => JSON.stringify(value).includes(text);
const scoped = (projects, tenants, more = {}) => ({ actor, projects, tenants, ...more });
const approvalOff = async (a, s) => {
	await rpc(a, "session/set_config_option", { sessionId: s.sessionId, configId: "model", value: "conformance/echo" });
	if (s.configOptions?.some((o) => o.id === "approval")) await rpc(a, "session/set_config_option", { sessionId: s.sessionId, configId: "approval", value: "off" });
	return s.sessionId;
};
const observed = (file) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const fixtureEnv = (kit, role, options) => ({ MODULAR_AGENT_PLUGINS: JSON.stringify([kit.probePlugin(role, options)]),
	MODULAR_AGENT_TENANTS: JSON.stringify({ [tenantA]: { rights }, [tenantB]: { rights } }) });

// The listener deliberately has several credentials. For stdio, a new process
// loads the next profile over the same trusted data directory.
async function host(kit, scopes, { extraEnv = {}, dir, which = kit.command, limits } = {}) {
	const peers = [];
	const tokens = [];
	const actors = kit.network && scopes.map((scope) => {
		const tokenFile = join(kit.root, `token-${randomUUID()}`);
		const token = randomBytes(32).toString("hex");
		writeFileSync(tokenFile, token, { mode: 0o600 });
		tokens.push(token);
		return { tokenFile, ...scope };
	});
	const env = kit.profile({ stdio: scopes[0], ...(actors ? { actors } : {}), limits }, extraEnv, dir);
	const directory = env.MODULAR_AGENT_DATA_DIR;
	const listener = kit.network && kit.managed.variant(env);
	return {
		directory, listener, tokens,
		async peer(index = 0, version = 1) {
			const e = !kit.network && index !== 0 ? kit.profile({ stdio: scopes[index], limits }, extraEnv, directory) : env;
			const a = kit.connect(which, e, tokens[index], listener || undefined);
			peers.push(a);
			const hello = await kit.within(5000, init(a, version), "initialize ADR profile");
			return { a, hello };
		},
		async stop() {
			await Promise.all(peers.map((a) => kit.stop(a)));
			if (listener) await kit.managed.stop(await listener);
		},
	};
}

export async function isolation(kit) {
	const { check, attempt, project, root, invalid, within, prompt, history, closeSession, reopenWatchdog } = kit;
	const nested = join(project, "nested-project"), alias = join(root, "alias"), nestedAlias = join(root, "nested-alias");
	mkdirSync(nested);
	symlinkSync(project, alias, "dir");
	symlinkSync(nested, nestedAlias, "dir");
	const broad = scoped(undefined, [null, tenantA, tenantB]);
	const narrow = scoped([project], [null, tenantA], { actor: { ...actor, rights: ["watch"] } });
	const exact = scoped([project], [null, tenantA]);
	const empty = scoped([], []);
	const omitted = scoped();
	const tenantOnly = scoped([project], [tenantA]);
	const trace = join(root, "isolation-trace");
	const mcpTrace = join(root, "mcp-starts");
	const mcp = [{ name: "isolation-counter", command: process.execPath,
		args: [fileURLToPath(new URL("../reference/mcp-fixture.mjs", import.meta.url)), mcpTrace], env: [] }];
	const extraEnv = fixtureEnv(kit, "project-observer", { traceOut: trace });
	await attempt("isolation: malformed policy", async () => {
		const bad = await invalid({ stdio: { actor, projects: "not a list" }, actors: "not a list" });
		check("isolation: malformed operator policy fails startup with a diagnostic", bad.code > 0 && /policy/i.test(bad.stderr) && /projects|actors/i.test(bad.stderr));
	});
	const h = await host(kit, [broad, narrow, exact, empty, omitted, tenantOnly], { extraEnv });
	const create = (a, cwd, tenant, servers) => within(15000, open(a, cwd, tenant, servers), "policy session/new");
	try {
		const { a: writer, hello } = await h.peer();
		check("isolation: operator config selects actor id, kind and prospective rights", meta(hello)?.actor?.id === actor.id &&
			meta(hello).actor.kind === actor.kind && rights.every((r) => meta(hello).actor.rights.includes(r)));
		const seed = async (cwd, tenant) => {
			const sid = await approvalOff(writer, await create(writer, cwd, tenant));
			await within(15000, prompt(writer, sid, `scope-${randomUUID()}`), "seed policy history");
			const entries = (await history(writer, sid, { all: true })).entries;
			await closeSession(writer, sid);
			return { sid, entries };
		};
		const plain = await seed(project), foreign = await seed(nested), hiddenTenant = await seed(project, tenantB);
		const visibleTenant = await seed(project, tenantA);
		const wideList = await rpc(writer, "session/list", {});
		const wideCursor = wideList.nextCursor;
		if (!kit.network) await kit.stop(writer);

		const { a: restricted } = await h.peer(2);
		check("isolation: canonical symlink to the listed project opens", !!(await create(restricted, alias)).sessionId);
		const before = observed(trace).length;
		const nestedRefusal = await errorOf(create(restricted, nestedAlias, undefined, mcp));
		const tenantRefusal = await errorOf(create(restricted, project, tenantB, mcp));
		const after = observed(trace).length;
		check("isolation: forbidden project and tenant do not compose the project or start MCP", [nestedRefusal, tenantRefusal].every((e) => refusal(e, "forbidden")) && before === after && !existsSync(mcpTrace));
		const list = await rpc(restricted, "session/list", {});
		const ids = new Set(list.sessions?.map((s) => s.sessionId));
		check("isolation: list filters stored projects and tenants", ids.has(plain.sid) && ids.has(visibleTenant.sid) && !ids.has(foreign.sid) && !ids.has(hiddenTenant.sid));
		if (wideCursor) {
			const page = await rpc(restricted, "session/list", { cursor: wideCursor }).catch((e) => e);
			check("isolation: broad list cursor is not authority on a narrower connection", refusal(page, "forbidden") ||
				(Array.isArray(page.sessions) && page.sessions.every((s) => ids.has(s.sessionId))));
		} else console.log("SKIP  borrowed ACP list cursor (the fixture list was not paged)");
		for (const m of ["load", "resume"]) await attempt(`isolation: ${m}`, async () => {
			const errors = await Promise.all([foreign.sid, hiddenTenant.sid, randomUUID()].map((id) => errorOf(load(restricted, id, project, m))));
			check(`isolation: ${m} masks unknown, stored project and stored tenant alike`, errors.every((e) => refusal(e, "forbidden")) &&
				errors.every((e) => e.message === errors[0].message && equal(e.data, errors[0].data)));
			const mismatch = await errorOf(load(restricted, plain.sid, nested, m));
			check(`isolation: ${m} rejects a supplied canonical project mismatch`, refusal(mismatch, "wrong_project") || refusal(mismatch, "forbidden"));
		});
		await kit.stop(restricted);
		const { a: watcher } = await h.peer(1);
		await within(await reopenWatchdog(), load(watcher, plain.sid, project), "attach with narrow rights");
		const beforeNarrow = await history(watcher, plain.sid, { all: true });
		const target = beforeNarrow.entries.findLast((e) => e.kind !== "position").id;
		const denied = await Promise.all([
			errorOf(input(watcher, plain.sid, "denied input", randomUUID(), "now")),
			errorOf(ext(watcher, "fork", { sessionId: plain.sid, entryId: target })),
			errorOf(ext(watcher, "answer", { sessionId: plain.sid, requestId: randomUUID(), value: "denied" })),
		]);
		check("isolation: recorded actor cannot exceed connection ceiling for input, fork and answer", denied.every((e) => refusal(e, "forbidden")) && equal(await history(watcher, plain.sid, { all: true }), beforeNarrow));
		await closeSession(watcher, plain.sid);
		check("isolation: detached history, requests and input return not_open", (await Promise.all([
			errorOf(history(watcher, plain.sid)), errorOf(ext(watcher, "requests", { sessionId: plain.sid })),
			errorOf(input(watcher, plain.sid, "detached", randomUUID())),
		])).every((e) => refusal(e, "not_open")));
		await kit.stop(watcher);
		const { a: emptyPeer } = await h.peer(3);
		check("isolation: empty scopes deny creation and discovery", refusal(await errorOf(create(emptyPeer, project)), "forbidden") &&
			(await rpc(emptyPeer, "session/list", {})).sessions?.length === 0);
		await kit.stop(emptyPeer);
		const { a: defaultScope } = await h.peer(4);
		check("isolation: omitted scope serves the project but not named tenants", !!(await create(defaultScope, project)).sessionId &&
			refusal(await errorOf(create(defaultScope, project, tenantA)), "forbidden"));
		await kit.stop(defaultScope);
		const { a: namedOnly } = await h.peer(5);
		check("isolation: named tenant does not permit an unassigned tenant", !!(await create(namedOnly, project, tenantA)).sessionId &&
			refusal(await errorOf(create(namedOnly, project)), "forbidden"));
		await kit.stop(namedOnly);
		if (kit.network) {
			const service = await h.listener;
			const unauthorized = await upgradeStatus(service.url, kit.network.protocol, kit.network.token);
			check("isolation: a bearer not listed in the policy is refused at upgrade", !unauthorized.upgraded && unauthorized.status === 401);
		} else kit.profile({ stdio: broad }, extraEnv, h.directory);
		const { a: reopen } = await h.peer();
		await within(await reopenWatchdog(), load(reopen, plain.sid, project), "reopen with original grants");
		const afterNarrow = (await history(reopen, plain.sid, { all: true })).entries;
		const grants = (entries) => entries.filter((e) => e.kind === "actorJoined" || e.kind === "actorLeft");
		check("isolation: narrow open and refused calls do not rewrite grants or admit work", equal(grants(plain.entries), grants(afterNarrow)) &&
			equal(rows("inputAccepted", plain.entries), rows("inputAccepted", afterNarrow)) && (await prompt(reopen, plain.sid, "wide again")).stopReason === "end_turn");
	} finally { await h.stop(); }
}

const settled = (p) => p.then((result) => ({ result }), (error) => ({ error }));
const question = async (kit, a, sessionId, turn) => kit.within(15000, (async () => {
	// Read-only observation of the committed request. No admission is retried.
	for (;;) {
		const r = await ext(a, "requests", { sessionId });
		const q = r.requests?.find((q) => q.question === "Fixture question" && q.answerable);
		if (q) return q.id;
		const done = await Promise.race([turn, delay(25, null)]);
		if (done) throw Error("question fixture ended before an answerable question: " + JSON.stringify(done));
	}
})(), "observe committed fixture question");

const ceiling = (scope, field) => Object.fromEntries(["session", "tenant", "agent"].map((s) => [s, {
	inputs: field === "inputs" && s === scope ? 1 : 8, calls: field === "calls" && s === scope ? 1 : 16, jobs: 4,
}]));
export async function capacity(kit) {
	const { check, attempt, project, prompt, history, within } = kit;
	const scopeAll = scoped(undefined, [null, tenantA, tenantB]);
	for (const scope of ["session", "tenant", "agent"]) await attempt(`capacity: ${scope} input reservations`, async () => {
		const limits = ceiling(scope, "inputs");
		const h = await host(kit, [scopeAll], { limits, extraEnv: fixtureEnv(kit, "probe", {}) });
		try {
			const { a, hello } = await h.peer();
			check(`capacity: ${scope} input ceiling is declared at initialize`, equal(meta(hello)?.declaration?.resourceReservations, limits));
			const create = async (tenant) => {
				const s = await open(a, project, tenant);
				check(`capacity: ${scope} ceiling is declared for the session`, equal(meta(s)?.declaration?.resourceReservations, limits));
				return approvalOff(a, s);
			};
			const sid1 = await create(scope === "session" ? undefined : tenantA);
			const sid2 = scope === "session" ? sid1 : await create(scope === "tenant" ? tenantA : tenantB);
			const ids = [...new Set([sid1, sid2])];
			const turns = ids.map((sid) => settled(prompt(a, sid, "tool:probe-question {}")));
			const questions = await Promise.all(ids.map((sid, i) => question(kit, a, sid, turns[i])));
			const keys = [randomUUID(), randomUUID()];
			const admit = (i) => input(a, [sid1, sid2][i], `concurrent capacity ${i}`, keys[i]);
			const outcomes = await Promise.all(keys.map((_, i) => settled(admit(i))));
			const winner = outcomes.findIndex((o) => o.result?.inputId), loser = 1 - winner;
			const raced = winner >= 0 && refusal(outcomes[loser].error, "busy");
			check(`capacity: ${scope} last slot has one winner and one busy without receipt`, raced, JSON.stringify(outcomes));
			const entries = (await Promise.all(ids.map((sid) => history(a, sid, { all: true })))).flatMap((r) => r.entries);
			if (raced) {
				const dup = await admit(winner);
				check(`capacity: ${scope} duplicate consumes no slot and refused key has no record`, dup.duplicate === true &&
					dup.inputId === outcomes[winner].result.inputId && !entries.some((e) => e.data?.key === keys[loser]));
			}
			// The other tenant and the unassigned bucket can still run at tenant saturation.
			if (scope === "tenant") for (const tenant of [tenantB, undefined]) {
				const other = await approvalOff(a, await open(a, project, tenant));
				check("capacity: saturated tenant does not charge the other tenant bucket", (await prompt(a, other, "independent bucket")).stopReason === "end_turn");
			}
			const answers = await Promise.all(ids.map((sid, i) => ext(a, "answer", { sessionId: sid, requestId: questions[i], value: "at capacity" })));
			const ends = await within(15000, Promise.all(turns), "settle held calls at capacity");
			const closed = (await Promise.all(ids.map((sid) => history(a, sid, { all: true })))).flatMap((r) => r.entries);
			check(`capacity: ${scope} saturation leaves room for the question and call settlements`, answers.every((r) => r.accepted) && ends.every((r) => r.result?.stopReason === "end_turn") &&
				rows("inputAnswer", closed).length === ids.length && rows("toolResult", closed).length === ids.length);
			if (raced) {
				const reused = await admit(loser);
				check(`capacity: ${scope} refused key can be used after capacity is released`, !!reused.inputId && !reused.duplicate);
			}
		} finally { await h.stop(); }
	});
	for (const version of [1, 2]) await attempt(`capacity: /${version} model call list`, async () => {
		const trace = join(kit.root, `call-capacity-${version}`);
		const h = await host(kit, [scopeAll], { limits: ceiling("session", "calls"), extraEnv: fixtureEnv(kit, "capacity-provider", { traceOut: trace }) });
		try {
			const { a } = await h.peer(0, version);
			const sid = await approvalOff(a, await open(a, project));
			await rpc(a, "session/set_config_option", { sessionId: sid, configId: "model", value: "kit-probe/scripted" });
			const reply = await within(15000, prompt(a, sid, "fixture oversize calls"), "bounded Provider response");
			const entries = (await history(a, sid, { all: true })).entries;
			const responses = rows("response", entries);
			const outcome = { kind: "limit", limit: "capacity" };
			check(`capacity: /${version} rejects a call list as one bounded response, preserves usage and dispatches nothing`,
				reply.stopReason === "max_turn_requests" && equal(meta(reply)?.outcome, outcome) &&
				responses.length === 1 && responses[0].message?.stop === "failed" && responses[0].message.usage?.input === 2 && responses[0].message.usage?.output === 1 &&
				!responses[0].message.content.some((p) => p.type === "toolCall") && !rows("toolStarted", entries).length &&
				observed(trace).filter((e) => e.providerDispatch === sid).length === 1 && !observed(trace).some((e) => e.effect) &&
				equal(rows("turnEnd", entries)[0]?.data?.outcome, outcome));
		} finally { await h.stop(); }
	});
}

export async function erasure(kit) {
	const { check, project, store, prompt, history, closeSession, reopenWatchdog, within } = kit;
	const dir = mkdtempSync(join(kit.root, "pending-state-"));
	const scope = scoped([project], [null]);
	const env = { MODULAR_AGENT_CONFORMANCE_ERASURE_DIR: dir };
	const h = await host(kit, [scope], { extraEnv: env });
	let reader, reopener, lease, dst, heldPath;
	try {
		const { a, hello } = await h.peer();
		const source = await open(a, project);
		check("erasure: agent and session declare coordination when the shared mechanism is configured",
			meta(hello)?.declaration?.erasure === true && meta(source)?.declaration?.erasure === true);
		const sid = await approvalOff(a, source);
		const key = randomUUID(), secret = `erase-${randomUUID()}`;
		await prompt(a, sid, secret, key);
		const prefix = await store.pages(sid);
		const target = rows("inputAccepted", prefix).find((e) => e.data?.key === key);
		if (!target) throw Error("source admission was not recorded in shared history");
		const entryId = rows("turnEnd", prefix).at(-1)?.id;
		const fork = (p, sessionId, entryId) => ext(p, "fork", { sessionId, entryId });
		const first = (await fork(a, sid, entryId)).sessionId;
		const loadMs = await reopenWatchdog();
		await within(loadMs, load(a, first, project), "attach first fork");
		const firstRows = await store.pages(first);
		const secondFork = (await fork(a, first, rows("turnEnd", firstRows).at(-1)?.id)).sessionId;
		dst = secondFork;
		await closeSession(a, first);
		const before = await store.pages(dst);
		const copy = before.find((e) => e.kind === "inputAccepted" && contains(e, secret));
		if (!copy) throw Error("fork-of-fork did not retain the fixture admission");
		heldPath = store.path(dst);
		lease = (await store.json(heldPath + "/lease", "POST", { owner: "kit-erasure-blocker" })).lease;
		reader = await host(kit, [scope], { dir: h.directory, extraEnv: env });
		const { a: r } = await reader.peer();
		await within(loadMs, load(r, first, project), "independent writer attaches first fork");
		const erase = (p) => ext(p, "erase", { sessionId: sid, entryIds: [target.id] });
		const report = await erase(a);
		const pair = (entries, sessionId, id) => entries?.some((e) => e.sessionId === sessionId && e.id === id);
		check("erasure: shared pending state is declared and held copy is reported pending, not changed",
			pair(report.pending, dst, copy.id) && !pair(report.erased, dst, copy.id) && equal(await store.pages(dst), before));
		await kit.crash(a);
		const visible = await history(r, first, { all: true }).catch((e) => e);
		check("erasure: an attached independent reader does not disclose pending content after initiator loss",
			(Array.isArray(visible.entries) && !contains(visible, secret)) || refusal(visible, "unavailable"));
		await reader.stop();
		reader = undefined;
		// Release the raw test lease only after the reader has checked the cutoff.
		await store.json(`${heldPath}/lease/${encodeURIComponent(lease)}`, "DELETE");
		lease = undefined;
		reopener = await host(kit, [scope], { dir: h.directory, extraEnv: env, which: kit.second });
		const { a: next } = await reopener.peer();
		await within(loadMs, load(next, dst, project), "new writer reconciles fork-of-fork");
		const kept = await store.pages(dst);
		const tombstone = kept.find((e) => e.id === copy.id);
		check("erasure: next writer reconciles durable pending intent once, before replay", tombstone?.erased === true &&
			!contains(kept, secret) && !contains(next.updates, secret) && rows("erasure", kept).length === 1);
		const duplicate = await input(next, dst, secret, key, "now");
		check("erasure: pending copy key survives only as an erased receipt", equal(duplicate, { duplicate: true, erased: true }) && equal(await store.pages(dst), kept));
		await within(loadMs, load(next, sid, project), "reopen initiating source for progress");
		const done = await erase(next);
		check("erasure: repeated authorized erase reports convergence without duplicate bookkeeping", pair(done.erased, dst, copy.id) && !pair(done.pending, dst, copy.id) &&
			rows("erasure", await store.pages(dst)).length === 1 && rows("erasure", await store.pages(sid)).length === 1);
	} finally {
		if (lease) await store.json(`${heldPath}/lease/${encodeURIComponent(lease)}`, "DELETE").catch(() => {});
		await Promise.all([reader?.stop(), reopener?.stop(), h.stop()]);
	}
}
