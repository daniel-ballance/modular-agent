// Opt-in ADR 0030 checks. Each profile has its own operator policy and data directory.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
const refusal = (e, code, number = -32602) => e?.code === number && e?.data?.code === code &&
	!("inputId" in e.data) && !("outcome" in e.data) && !("inputId" in (meta(e.data) ?? {})) && !("outcome" in (meta(e.data) ?? {}));
const rows = (k, entries) => entries.filter((e) => e.kind === k);
const contains = (value, text) => JSON.stringify(value)?.includes(text) === true;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const scoped = (projects, tenants, more = {}) => ({ actor, projects, tenants, ...more });
const approvalOff = async (a, s) => {
	await rpc(a, "session/set_config_option", { sessionId: s.sessionId, configId: "model", value: "conformance/echo" });
	if (s.configOptions?.some((o) => o.id === "approval")) await rpc(a, "session/set_config_option", { sessionId: s.sessionId, configId: "approval", value: "off" });
	return s.sessionId;
};
const observed = (file) => existsSync(file) ? readFileSync(file, "utf8").split("\n").slice(0, -1).filter(Boolean).map((line) => JSON.parse(line)) : [];
async function waitTrace(kit, path, pred) {
	let observer;
	try {
		return await kit.within(15000, new Promise((resolve, reject) => {
			const check = () => {
				try {
					const event = observed(path).find(pred);
					if (event) resolve(event);
				} catch (error) { reject(error); }
			};
			observer = watch(dirname(path), check);
			observer.on("error", reject);
			check();
		}), "observe committed fixture trace");
	} finally { observer?.close(); }
}
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
	const { check, attempt, project, root, invalid } = kit;
	const nested = join(project, "nested-project"), alias = join(root, "alias"), nestedAlias = join(root, "nested-alias");
	const unseen = join(nested, "unseen-project");
	mkdirSync(unseen, { recursive: true });
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
	extraEnv.MODULAR_AGENT_PLUGINS = JSON.stringify([...JSON.parse(extraEnv.MODULAR_AGENT_PLUGINS), kit.probePlugin("probe")]);
	await attempt("isolation: malformed policy", async () => {
		const bad = await invalid({ stdio: { actor, projects: "not a list" }, actors: "not a list" });
		check("isolation: malformed operator policy fails startup with a diagnostic", bad.code > 0 && /policy/i.test(bad.stderr) && /projects|actors/i.test(bad.stderr));
	});
	await attempt("isolation: scoped attachments", () => scopedAttachments(kit, {
		scopes: [broad, narrow, exact, empty, omitted, tenantOnly], nested, alias, nestedAlias, unseen, trace, mcpTrace, mcp, extraEnv,
	}));
	await attempt("isolation: configured representation", () => representation(kit));
}

async function scopedAttachments(kit, { scopes, nested, alias, nestedAlias, unseen, trace, mcpTrace, mcp, extraEnv }) {
	const { check, attempt, project, within, prompt, history, closeSession, reopenWatchdog } = kit;
	const h = await host(kit, scopes, { extraEnv });
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
		const plain = await seed(project);
		let foreign, hiddenTenant, visibleTenant;
		await attempt("isolation: seed second project", async () => { foreign = await seed(nested); });
		await attempt("isolation: seed hidden tenant", async () => { hiddenTenant = await seed(project, tenantB); });
		await attempt("isolation: seed visible tenant", async () => { visibleTenant = await seed(project, tenantA); });
		const wideList = await rpc(writer, "session/list", {});
		const wideCursor = wideList.nextCursor;
		if (!kit.network) await kit.stop(writer);

		const { a: restricted } = await h.peer(2);
		check("isolation: canonical symlink to the listed project opens", !!(await create(restricted, alias)).sessionId);
		const before = observed(trace).length;
		const nestedRefusal = await errorOf(create(restricted, nestedAlias, undefined, mcp));
		const unseenRefusal = await errorOf(create(restricted, unseen, undefined, mcp));
		const tenantRefusal = await errorOf(create(restricted, project, tenantB, mcp));
		const after = observed(trace).length;
		check("isolation: forbidden project and tenant do not compose the project or start MCP", [nestedRefusal, unseenRefusal, tenantRefusal].every((e) => refusal(e, "forbidden")) && before === after && !existsSync(mcpTrace));
		const list = await rpc(restricted, "session/list", {});
		const ids = new Set(list.sessions?.map((s) => s.sessionId));
		check("isolation: list filters stored projects and tenants", ids.has(plain.sid) && (!visibleTenant || ids.has(visibleTenant.sid)) && !ids.has(foreign?.sid) && !ids.has(hiddenTenant?.sid));
		if (wideCursor) {
			const page = await rpc(restricted, "session/list", { cursor: wideCursor }).catch((e) => e);
			check("isolation: broad list cursor is not authority on a narrower connection", refusal(page, "forbidden") ||
				(Array.isArray(page.sessions) && page.sessions.every((s) => ids.has(s.sessionId))));
		} else console.log("SKIP  borrowed ACP list cursor (the fixture list was not paged)");
		for (const m of ["load", "resume"]) await attempt(`isolation: ${m}`, async () => {
			const errors = await Promise.all([foreign?.sid, hiddenTenant?.sid, randomUUID()].filter(Boolean).map((id) => errorOf(load(restricted, id, project, m))));
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
		const authorizedKey = randomUUID();
		const denied = await Promise.all([
			errorOf(input(watcher, plain.sid, "denied input", randomUUID(), "now")),
			errorOf(ext(watcher, "fork", { sessionId: plain.sid, entryId: target })),
			errorOf(ext(watcher, "answer", { sessionId: plain.sid, requestId: randomUUID(), value: "denied" })),
		]);
		check("isolation: recorded actor cannot exceed connection ceiling for input, fork and answer", denied.every((e) => refusal(e, "forbidden")) && equal(await history(watcher, plain.sid, { all: true }), beforeNarrow));
		if (kit.network) await attempt("isolation: cancellation uses the connection ceiling", async () => {
			await within(await reopenWatchdog(), load(writer, plain.sid, project), "owner attaches during narrow view");
			const turn = settled(prompt(writer, plain.sid, "tool:probe-question {}", authorizedKey));
			const requestId = await question(kit, writer, plain.sid, turn);
			await watcher.ctx.notify("session/cancel", { sessionId: plain.sid });
			const deniedAnswer = await errorOf(ext(watcher, "answer", { sessionId: plain.sid, requestId, value: "denied" }));
			const accepted = await ext(writer, "answer", { sessionId: plain.sid, requestId, value: "only owner may answer" });
			check("isolation: cancellation and an answer without rights do not settle the owner's question", refusal(deniedAnswer, "forbidden") &&
				accepted.accepted === true && (await within(15000, turn, "settle owner question")).result?.stopReason === "end_turn");
		});
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
		} else kit.profile({ stdio: scopes[0] }, extraEnv, h.directory);
		const { a: reopen } = await h.peer();
		await within(await reopenWatchdog(), load(reopen, plain.sid, project), "reopen with original grants");
		const afterNarrow = (await history(reopen, plain.sid, { all: true })).entries;
		const grants = (entries) => entries.filter((e) => e.kind === "actorJoined" || e.kind === "actorLeft");
		check("isolation: narrow open and refused calls do not rewrite grants or admit work", equal(grants(plain.entries), grants(afterNarrow)) &&
			equal(rows("inputAccepted", plain.entries), rows("inputAccepted", afterNarrow).filter((e) => e.data?.key !== authorizedKey)) && (await prompt(reopen, plain.sid, "wide again")).stopReason === "end_turn");
	} finally { await h.stop(); }
}

async function representation(kit) {
	const { check, project, history, closeSession, reopenWatchdog, within, prompt } = kit;
	const principal = scoped([project], [null]);
	const member = { id: "kit-represented", kind: "user", rights: ["watch", "input", "answer", "propose"] };
	const h = await host(kit, [principal]);
	let sessionId, represented;
	try {
		const { a, hello } = await h.peer();
		if (!meta(hello)?.declaration?.severalActors) {
			console.log("SKIP  configured representation (severalActors not declared)");
			return;
		}
		sessionId = await approvalOff(a, await open(a, project));
		// A session is persisted only from its first admitted input, so admit one before the
		// close and reopen below (docs/bindings/history-http.md, Sessions).
		check("isolation: the principal's first input is admitted", (await within(15000, prompt(a, sessionId, "first input"), "first input")).stopReason === "end_turn");
		await ext(a, "join", { sessionId, actor: member, present: true });
		const grants = await ext(a, "actors", { sessionId });
		const before = await history(a, sessionId, { all: true });
		const key = randomUUID(), requestId = randomUUID();
		const [invalidInput, invalidAnswer] = await Promise.all([
			errorOf(input(a, sessionId, "unrepresented input", key, "propose", { actorId: member.id })),
			errorOf(ext(a, "answer", { sessionId, requestId, value: "unrepresented answer", actorId: member.id })),
		]);
		check("isolation: joining an unrepresented actor cannot grant presence, input or answer", grants.actors.some((a) => a.id === member.id) &&
			!grants.present.includes(member.id) && refusal(invalidInput, "forbidden") && refusal(invalidAnswer, "forbidden") &&
			equal(await history(a, sessionId, { all: true }), before));
		await closeSession(a, sessionId);
		await h.stop();
		const scope = { ...principal, represents: [member.id], actor: { ...actor, rights: ["watch", "answer", "propose"] } };
		represented = await host(kit, [scope], { dir: h.directory });
		const { a: route } = await represented.peer();
		await within(await reopenWatchdog(), load(route, sessionId, project), "attach authorized represented route");
		const refused = await errorOf(input(route, sessionId, "intersection denies now", randomUUID(), "now", { actorId: member.id }));
		const receipt = await input(route, sessionId, "represented proposal", key, "propose", { actorId: member.id });
		const stale = await ext(route, "answer", { sessionId, requestId, value: "stale answer", actorId: member.id });
		const entries = (await history(route, sessionId, { all: true })).entries;
		const admitted = rows("inputAccepted", entries).find((e) => e.inputId === receipt.inputId);
		check("isolation: represented work applies the rights intersection and records both actors", refusal(refused, "forbidden") &&
			receipt.taken === "proposed" && admitted?.actorId === member.id && admitted.data?.submittedBy === actor.id &&
			!admitted.data.rights?.includes("input") && equal(stale, { accepted: false, reason: "not_open" }));
	} finally { await Promise.all([h.stop(), represented?.stop()]); }
	if (kit.network) await kit.attempt("isolation: recheck authority after the delivery gate", () => revokedDelivery(kit));
}

async function revokedDelivery(kit) {
	const { root, project, prompt, history, within, reopenWatchdog, check } = kit;
	const viewer = { id: "kit-viewer", kind: "host", rights: ["watch"] };
	const release = join(root, "allow-gated-delivery"), traceOut = join(root, "held-delivery.jsonl");
	const h = await host(kit, [scoped([project], [null]), scoped([project], [null], { actor: viewer })], {
		extraEnv: fixtureEnv(kit, "delivery-barrier", { recipient: viewer.id, release, traceOut }),
	});
	try {
		const { a: owner } = await h.peer();
		const sid = await approvalOff(owner, await open(owner, project));
		const marker = `held-content-${randomUUID()}`;
		await prompt(owner, sid, marker);
		await ext(owner, "join", { sessionId: sid, actor: viewer });
		const { a: reader } = await h.peer(1);
		await within(await reopenWatchdog(), load(reader, sid, project, "resume"), "attach viewer without replay");
		const reply = settled(history(reader, sid, { all: true }));
		await waitTrace(kit, traceOut, (e) => e.beforeDelivery === sid);
		await within(15000, ext(owner, "leave", { sessionId: sid, actorId: viewer.id }), "commit revocation while reply is held");
		writeFileSync(release, "allow\n");
		const resumed = await within(15000, reply, "release the held reply after revocation");
		check("isolation: a reply withheld at the gate cannot disclose history after revocation",
			!resumed.result && (refusal(resumed.error, "forbidden") || refusal(resumed.error, "withheld", -32000)) &&
			!contains(resumed.error?.data, marker) && refusal(await errorOf(history(reader, sid)), "forbidden") &&
			contains(await history(owner, sid, { all: true }), marker));
	} finally {
		writeFileSync(release, "cleanup\n");
		await h.stop();
	}
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
			const create = async (tenant, cwd = project) => {
				const s = await open(a, cwd, tenant);
				check(`capacity: ${scope} ceiling is declared for the session`, equal(meta(s)?.declaration?.resourceReservations, limits));
				return approvalOff(a, s);
			};
			const sid1 = await create(scope === "session" ? undefined : tenantA);
			const otherProject = join(project, "capacity-project");
			if (scope === "agent") mkdirSync(otherProject, { recursive: true });
			const sid2 = scope === "session" ? sid1 : scope === "tenant" ? await create(tenantA) : await create(undefined, otherProject);
			const ids = [...new Set([sid1, sid2])];
			const turns = [], questions = [];
			// A seed prompt uses a pending slot until the turn takes it. Hold
			// each turn before starting the next; only the admissions below race.
			for (const sid of ids) {
				const turn = settled(prompt(a, sid, "tool:probe-question {}"));
				turns.push(turn);
				questions.push(await question(kit, a, sid, turn));
			}
			const keys = [randomUUID(), randomUUID()];
			const admit = (i) => input(a, [sid1, sid2][i], `concurrent capacity ${i}`, keys[i]);
			const outcomes = await Promise.all(keys.map((_, i) => settled(admit(i))));
			const winner = outcomes.findIndex((o) => o.result?.inputId), loser = 1 - winner;
			const raced = winner >= 0 && refusal(outcomes[loser].error, "busy");
			check(`capacity: ${scope} last slot has one winner and one busy without receipt`, raced, JSON.stringify(outcomes));
			const entries = (await Promise.all(ids.map((sid) => history(a, sid, { all: true })))).flatMap((r) => r.entries);
			if (raced) {
				const dup = await admit(winner);
				const afterDuplicate = (await Promise.all(ids.map((sid) => history(a, sid, { all: true })))).flatMap((r) => r.entries);
				check(`capacity: ${scope} duplicate consumes no slot and refused key has no record`, dup.duplicate === true &&
					dup.inputId === outcomes[winner].result.inputId && equal(afterDuplicate, entries) && !entries.some((e) => e.data?.key === keys[loser]));
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
				const winnerId = outcomes[winner].result.inputId;
				await within(15000, (async () => {
					// Reuse the refused key only after the winner's slot is transferred to a turn.
					for (;;) {
						const r = await history(a, [sid1, sid2][winner], { all: true });
						if (r.entries.some((e) => (e.kind === "input" || e.kind === "inputHandedBack") && e.inputId === winnerId)) return;
						await delay(25);
					}
				})(), "observe disposition of the winning admission");
				const reused = await admit(loser);
				check(`capacity: ${scope} refused key can be used after capacity is released`, !!reused.inputId && !reused.duplicate);
			}
		} finally { await h.stop(); }
	});
	for (const [version, wireRuntime] of [[1, false], [2, false], [2, true]]) {
		const label = `capacity: /${version} ${wireRuntime ? "wire Runtime" : "model call list"}`;
		await attempt(label, () => callCapacity(kit, scopeAll, { version, wireRuntime, label }));
	}
	await attempt("capacity: reserve and transfer a job report", () => jobCapacity(kit, scopeAll));
}

async function callCapacity(kit, scope, { version, wireRuntime, label }) {
	const { root, project, prompt, history, within, check } = kit;
	const trace = join(root, `call-capacity-${version}-${wireRuntime}`);
	const h = await host(kit, [scope], { limits: ceiling("session", "calls"),
		extraEnv: fixtureEnv(kit, wireRuntime ? "runtime" : "capacity-provider", { traceOut: trace, capacityCase: wireRuntime }) });
	let stage = "initialize";
	try {
		const { a } = await h.peer(0, version);
		stage = "session/new";
		const s = await open(a, project);
		const sid = s.sessionId;
		stage = "select the remote Provider";
		await rpc(a, "session/set_config_option", { sessionId: sid, configId: "model", value: "kit-probe/scripted" });
		if (s.configOptions?.some((o) => o.id === "approval")) await rpc(a, "session/set_config_option", { sessionId: sid, configId: "approval", value: "off" });
		stage = "prompt and inspect the bounded response";
		const reply = await within(15000, prompt(a, sid, "fixture oversize calls"), "bounded Provider response");
		const entries = (await history(a, sid, { all: true })).entries;
		const responses = rows("response", entries), events = observed(trace);
		const outcome = { kind: "limit", limit: "capacity" };
		check(`${label}: one bounded response preserves usage, dispatches nothing and ends at capacity`,
			(!wireRuntime || events.some((e) => e.test === "oversize calls" && e.checks.capacity === true)) &&
			reply.stopReason === "max_turn_requests" && equal(meta(reply)?.outcome, outcome) &&
			responses.length === 1 && responses[0].message?.stop === "failed" && responses[0].message.usage?.input === 2 && responses[0].message.usage?.output === 1 &&
			!responses[0].message.content.some((p) => p.type === "toolCall") && !rows("toolStarted", entries).length &&
			events.filter((e) => e.providerDispatch === sid).length === 1 && !events.some((e) => e.effect) &&
			equal(rows("turnEnd", entries)[0]?.data?.outcome, outcome), JSON.stringify({ outcome: meta(reply)?.outcome, events }));
	} catch (error) {
		throw Error(`${stage}: ${error.message}; fixture trace: ${JSON.stringify(observed(trace))}`);
	} finally { await h.stop(); }
}

async function jobCapacity(kit, scope) {
	const { root, project, prompt, history, within, check } = kit;
	const trace = join(root, "job-capacity.jsonl"), releaseFile = join(root, "release-job-report");
	const limits = ceiling("session", "inputs");
	limits.session.inputs = 2;
	limits.session.jobs = 1;
	const extraEnv = fixtureEnv(kit, "probe", {});
	extraEnv.MODULAR_AGENT_PLUGINS = JSON.stringify([...JSON.parse(extraEnv.MODULAR_AGENT_PLUGINS), {
		command: [process.execPath, fileURLToPath(new URL("../plugin/jobs.mjs", import.meta.url))], config: { out: trace, releaseFile },
	}]);
	const h = await host(kit, [scope], { limits, extraEnv });
	try {
		const { a } = await h.peer();
		const s = await open(a, project);
		const sid = await approvalOff(a, s);
		const runJob = (text) => within(15000, prompt(a, sid, `tool:background ${JSON.stringify({ text, ms: 0 })}`), "start fixture job");
		await runJob("reserved report");
		const start = await waitTrace(kit, trace, (e) => e.started && e.commit && e.duplicate);
		await runJob("must not start another job");
		const starts = rows("jobStarted", (await history(a, sid, { all: true })).entries);
		check("capacity: saturated job pool refuses a new start with busy before recording it", starts.length === 1 &&
			observed(trace).some((e) => e.startFailed && e.code === "busy" && e.number === -32000));
		const turn = settled(prompt(a, sid, "tool:probe-question {}"));
		const requestId = await question(kit, a, sid, turn);
		const ordinary = await input(a, sid, "ordinary queue slot", randomUUID());
		const rejectedKey = randomUUID();
		const full = await errorOf(input(a, sid, "reserved slot is not free", rejectedKey, meta(s)?.declaration?.inputDuringTurn ? "steer" : "after"));
		writeFileSync(releaseFile, "end\n");
		const end = await waitTrace(kit, trace, (e) => e.repeatedEnd === start.started || e.endFailed === start.started);
		const entries = (await history(a, sid, { all: true })).entries;
		const reports = rows("inputAccepted", entries).filter((e) => e.data?.key === `job:${start.started}`);
		const ends = rows("jobEnded", entries).filter((e) => e.jobId === start.started);
		check("capacity: the reserved job report transfers at saturation into exactly one matching admission", !!ordinary.inputId &&
			refusal(full, "busy") && !entries.some((e) => e.data?.key === rejectedKey) && end.once === true &&
			reports.length === 1 && ends.length === 1 && ends[0].data.report === true && equal(ends[0].data.result, reports[0].data.content));
		await a.ctx.notify("session/cancel", { sessionId: sid });
		const afterCancel = await within(15000, turn, "cancel while admission slots are full");
		const stale = await ext(a, "answer", { sessionId: sid, requestId, value: "too late" });
		const terminal = (await history(a, sid, { all: true })).entries;
		check("capacity: cancellation at saturation still closes the question and hands back accepted input", afterCancel.result?.stopReason === "cancelled" &&
			equal(stale, { accepted: false, reason: "not_open" }) && rows("inputHandedBack", terminal).some((e) =>
				e.inputId === ordinary.inputId));
	} finally { await h.stop(); }
}

async function holdLease(store, path) {
	const { ttlMs } = await store.json("/v1");
	if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw Error("history service did not declare a positive lease TTL");
	const { lease } = await store.json(`${path}/lease`, "POST", { owner: "kit-erasure-blocker" });
	const route = `${path}/lease/${encodeURIComponent(lease)}`;
	const controller = new AbortController();
	const renewed = settled((async () => {
		while (!controller.signal.aborted) {
			await delay(Math.max(1, Math.floor(ttlMs / 3)), undefined, { signal: controller.signal });
			await store.json(`${route}/renew`, "POST");
		}
	})());
	return async () => {
		controller.abort();
		const { error } = await renewed;
		await store.json(route, "DELETE");
		if (error && error.name !== "AbortError") throw error;
	};
}

export async function erasure(kit) {
	if (!kit.store || (await kit.store.json("/v1")).pendingErasure !== 1) throw Error("erasure fixture requires the shared HTTP pendingErasure: 1 registry");
	for (const cutoff of ["reported pending", "bookkeeping commit", "tombstone commit"]) {
		await kit.attempt(`erasure: ${cutoff}`, () => eraseAcrossWriters(kit, cutoff));
	}
}

async function eraseAcrossWriters(kit, cutoff) {
	const { project, store, prompt, history, closeSession, reopenWatchdog, within } = kit;
	const check = (label, ok, detail) => kit.check(`erasure (${cutoff}): ${label}`, ok, detail);
	const scope = scoped([project], [null]);
	const reached = deferred(), releaseReply = deferred();
	let eraseSource, sourcePath;
	let stage = "start writer", faultReached = false;
	const trace = [], started = performance.now();
	const proxy = cutoff === "reported pending" ? undefined : await store.observe({
		onTrace({ method, path, start, upstreamStatus, upstreamMs, replyMs, sent }) {
			const [, , group, session, suffix, , action] = path.split("?")[0].split("/");
			const route = group !== "sessions" ? "version" : !session ? "list" : !suffix ? "session" :
				suffix === "lease" && action === "renew" ? "renew" : ["entries", "lease", "pending-erasure", "erase"].includes(suffix) ? suffix : "other";
			trace.push({ method, route, source: session !== undefined && `/v1/sessions/${session}` === sourcePath,
				atMs: Math.round(start - started), upstreamStatus, upstreamMs: upstreamMs === undefined ? undefined : Math.round(upstreamMs),
				replyMs: Math.round(replyMs), sent });
			if (trace.length > 24) trace.shift();
		},
		async beforeReply({ method, path, ok, entries }) {
			if (!eraseSource || !ok || method !== "POST") return;
			const bookkeeping = path === `${eraseSource}/entries` && entries?.some((e) => e.kind === "erasure");
			const tombstones = path === `${eraseSource}/erase`;
			if (cutoff === "bookkeeping commit" ? bookkeeping : tombstones) {
				faultReached = true;
				reached.resolve(true);
				await releaseReply.promise;
			}
		},
	});
	const h = await host(kit, [scope], { extraEnv: proxy ? { MODULAR_AGENT_HISTORY_URL: proxy.url } : {} });
	let reader, reopener, releaseLease, dst;
	const takeoverLoad = async (peer, sid, ms, label) => {
		const started = performance.now();
		try {
			return await within(ms, load(peer, sid, project), label);
		} catch (error) {
			const elapsedMs = Math.round(performance.now() - started);
			const records = await within(1000, store.pages(sid), "read diagnostic history")
				.then((rows) => rows.map((e) => e.erased ? `${e.kind} (erased)` : e.kind), (e) => e.message);
			throw new Error(`${label} after ${elapsedMs} ms: ${error.message} ${JSON.stringify({
				code: error.code, dataCode: error.data?.code, records,
				exitCode: peer.child?.exitCode, signal: peer.child?.signalCode,
			})}`, { cause: error });
		}
	};
	try {
		const { a, hello } = await h.peer();
		const source = await open(a, project);
		check("agent and session declare coordination when the shared mechanism is configured",
			meta(hello)?.declaration?.erasure === true && meta(source)?.declaration?.erasure === true);
		const sid = await approvalOff(a, source);
		sourcePath = store.path(sid);
		stage = "commit source prompt";
		const key = randomUUID(), secret = `erase-${randomUUID()}`;
		await prompt(a, sid, secret, key);
		const prefix = await store.pages(sid);
		const target = rows("inputAccepted", prefix).find((e) => e.data?.key === key);
		if (!target) throw Error("source admission was not recorded in shared history");
		const entryId = rows("turnEnd", prefix).at(-1)?.id;
		const fork = (p, sessionId, entryId) => ext(p, "fork", { sessionId, entryId });
		stage = "create and attach both forks";
		const first = (await fork(a, sid, entryId)).sessionId;
		const loadMs = await reopenWatchdog();
		await within(loadMs, load(a, first, project), "attach first fork");
		const firstRows = await store.pages(first);
		const secondFork = (await fork(a, first, rows("turnEnd", firstRows).at(-1)?.id)).sessionId;
		dst = secondFork;
		await closeSession(a, first);
		// Release any lease obtained at fork publication before another writer takes it.
		await within(loadMs, load(a, dst, project), "attach second fork");
		await closeSession(a, dst);
		const before = await store.pages(dst);
		const firstCopy = firstRows.find(e => e.kind === "inputAccepted" && contains(e, secret));
		if (!firstCopy || !equal(firstCopy.sources, [target.id])) throw Error("first fork did not name the source admission");
		const copy = before.find((e) => e.kind === "inputAccepted" && contains(e, secret));
		if (!copy || !equal(copy.sources, [firstCopy.id])) throw Error("fork-of-fork did not name its source admission");
		stage = "hold the destination and attach the independent reader";
		releaseLease = await holdLease(store, store.path(dst));
		reader = await host(kit, [scope]);
		const { a: r } = await reader.peer();
		await within(loadMs, load(r, first, project), "independent writer attaches first fork");
		const erase = (p) => ext(p, "erase", { sessionId: sid, entryIds: [target.id] });
		const pair = (entries, sessionId, id) => entries?.some((e) => e.sessionId === sessionId && e.id === id);
		stage = "erase from the source";
		if (proxy) {
			eraseSource = sourcePath;
			const received = await within(15000, Promise.race([reached.promise, settled(erase(a))]), `observe ${cutoff} before its HTTP reply`);
			if (received !== true) throw Error(`erase settled before the fault cutoff: ${JSON.stringify(received)}`);
			check("erase cannot mutate a held destination", equal(await store.pages(dst), before));
		} else {
			const report = await within(15000, erase(a), "keep held copies pending");
			check("held copy is reported pending, not changed", pair(report.pending, dst, copy.id) &&
				!pair(report.erased, dst, copy.id) && equal(await store.pages(dst), before));
		}
		stage = "crash the eraser and inspect the independent reader";
		await kit.crash(a);
		releaseReply.resolve();
		const visible = await history(r, first, { all: true }).catch((e) => e);
		check("an attached independent reader does not disclose pending content after initiator loss",
			(Array.isArray(visible.entries) && !contains(visible, secret)) || refusal(visible, "unavailable"));
		await reader.stop();
		reader = undefined;
		// Release the raw test lease only after the reader has checked the cutoff.
		const release = releaseLease;
		releaseLease = undefined;
		await release();
		stage = "reopen and reconcile the pending intent";
		reopener = await host(kit, [scope], { which: kit.second });
		const { a: next } = await reopener.peer();
		await takeoverLoad(next, dst, loadMs, "new writer reconciles fork-of-fork");
		const kept = await store.pages(dst);
		const tombstone = kept.find((e) => e.id === copy.id);
		check("next writer reconciles durable pending intent once, before replay", tombstone?.erased === true && equal(tombstone.sources, [firstCopy.id]) &&
			!contains(kept, secret) && !contains(next.updates, secret) && rows("erasure", kept).length === 1);
		const duplicate = await input(next, dst, secret, key, "now");
		check("pending copy key survives only as an erased receipt", equal(duplicate, { duplicate: true, erased: true }) && equal(await store.pages(dst), kept));
		await takeoverLoad(next, sid, loadMs, "reopen initiating source for progress");
		const done = await erase(next);
		check("repeated authorized erase reports convergence without duplicate bookkeeping", pair(done.erased, dst, copy.id) && !pair(done.pending, dst, copy.id) &&
			rows("erasure", await store.pages(dst)).length === 1 && rows("erasure", await store.pages(sid)).length === 1);
	} catch (error) {
		const diagnostic = proxy ? `; fault reached: ${faultReached}; history HTTP: ${JSON.stringify(trace)}` : "";
		throw Error(`${stage}: ${error.message}${diagnostic}`, { cause: error });
	} finally {
		releaseReply.resolve();
		if (releaseLease) await releaseLease().catch(() => {});
		await Promise.all([reader?.stop(), reopener?.stop(), h.stop()]);
		proxy?.stop();
	}
}
