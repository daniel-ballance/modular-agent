#!/usr/bin/env node
// Host-side fixtures for docs/bindings/plugin.md. The ACP kit loads these with --probe-checks.
import { randomUUID } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual as equal } from "node:util";
import { codeOf, outcome, rpcError, serve } from "./peer.mjs";

const BINDING = "modular-agent-plugin/1";
const DATA = "modular-agent-data/1";
const model = { provider: "kit-probe", id: "scripted" };
const models = [{ ...model, contextWindow: 4096, maxOutput: 512, input: ["text"], reasoning: false }];
const PROBE = { name: "probe", description: "Check the host callbacks.", parameters: { type: "object", properties: {} } };
const EFFECT = { name: "probe-effect", description: "Record a fixture invocation.", parameters: { type: "object", properties: { value: { type: "string" } } }, hints: { readOnly: true, openWorld: false } };
const trace = (data) => { const out = config.traceOut ?? config.out; if (out) appendFileSync(out, JSON.stringify(data) + "\n"); };
let config = {}, stopping = false;
let refreshed = false;
const fixtureTool = (name, description, properties = {}) => ({ name, description, parameters: { type: "object", properties } });
const QUESTION = fixtureTool("probe-question", "Ask one fixture question.", { late: { type: "boolean" } });
const REFRESH = fixtureTool("probe-refresh", "Change the fixture tool list.", { fail: { type: "boolean" } });
const currentTools = () => [PROBE, QUESTION, REFRESH, fixtureTool(refreshed ? "probe-added" : "probe-retired", "A tool from the current view.")];
let failRefresh = false;
const points = new Map();
let pointProject, pointDir;
function registration() {
	const base = { binding: BINDING, name: `probe-${config.role ?? "probe"}` };
	switch (config.role) {
		// Starting: the handshake. These negative fixtures run only in separate startups.
		case "refuse-hook": return { ...base, hooks: [{ hook: "probe.no-such-point", handlerId: 1 }] };
		case "refuse-replace": return { ...base, replaces: ["tool:probe-absent"] };
		case "refuse-duplicate": return { ...base, name: "probe-probe" };
		case "refuse-duplicate-replacement": return { ...base, replaces: ["tool:probe", "tool:probe"], toolSources: [{ id: "probe-tools", tools: [PROBE] }] };
		case "refuse-collision": return { ...base, toolSources: [{ id: "probe-tools", tools: [PROBE] }] };
		case "project-observer": return base;
		case "capacity-provider": return { ...base, toolSources: [{ id: "probe-tools", tools: [EFFECT] }],
			providers: [{ id: model.provider, models, supports: { keepsState: false, runsTools: false } }] };
		case "output-observer": return { ...base, hooks: [{ hook: "output", handlerId: 1, order: "last" }] };
		case "runtime": return { ...base, replaces: ["runtime"], runtime: { id: "probe-runtime", supports: {} }, toolSources: [{ id: "probe-tools", tools: [EFFECT] }],
			providers: [{ id: model.provider, models, supports: { keepsState: false, runsTools: false } }],
			hooks: [{ hook: "step.before", handlerId: 2 }, { hook: "tool.before", handlerId: 3 }] };
		case "steering": return { ...base, replaces: ["runtime"], runtime: { id: "probe-steering", supports: { inputDuringTurn: true } } };
		case "remote-points": return { ...base, replaces: ["working-environment"], workingEnvironment: { containment: "none", points: true } };
		default: return { ...base, toolSources: [{ id: "probe-tools", tools: currentTools() }] };
	}
}

async function runChecks(m, { ask, request, recent, signal }) {
	const { sessionId, project: cwd } = m.params;
	const scope = { sessionId, parentRequestId: m.id };
	const checks = [];
	const check = (name, ok, detail = "") => checks.push({ name, ok: !!ok, detail: ok ? "" : String(detail).slice(0, 300) });
	const group = async (name, fn) => {
		if (signal.aborted) throw rpcError("cancelled");
		try { await fn(); } catch (e) { check(name, false, JSON.stringify(e)); }
	};
	const invalid = async (method, params) => {
		const r = await outcome(ask(method, params));
		return r.error?.code === -32602 && codeOf(r.error) === "invalid_request";
	};
	// What a plugin may ask the host; Paging history; Authority.
	await group("host/session", async () => {
		const s = await ask("host/session", scope);
		check("host/session: id and project agree with the parent", s.project === cwd && s.id === sessionId);
	});
	await group("host/history: pages by after and next", async () => {
		const all = { ...scope, all: true };
		const { entries } = await ask("host/history", all);
		const first = await ask("host/history", { ...all, limit: 1 });
		const second = await ask("host/history", { ...all, limit: 1, after: first.next });
		const last = await ask("host/history", { ...all, after: entries.at(-1)?.id });
		check("host/history: pre-seeded turn and current call appear in kept order", entries.some((e, i) => e.kind === "turnEnd" && entries.slice(i + 1).some((x) => x.kind === "toolStarted" && x.toolCallId === m.params.call.id)));
		check("host/history: limit and next delimit the exact same records", equal(first, { entries: [entries[0]], next: entries[0]?.id }) && equal(second.entries, [entries[1]]) && equal(last, { entries: [] }));
		check("host/history: unknown cursor and limits 0 and 501 are invalid_request", await invalid("host/history", { ...all, after: "probe-no-such-entry" }) && await invalid("host/history", { ...all, limit: 0 }) && await invalid("host/history", { ...all, limit: 501 }));
		check("host/history: direct read of an open session is allowed", Array.isArray((await ask("host/history", { sessionId })).entries));
		check("host/history: unknown session is refused", await invalid("host/history", { sessionId: randomUUID() }));
	});
	await group("callback authority", async () => {
		check("authority: environment callback without parent is refused", await invalid("host/env/exists", { sessionId, cwd, path: "absent" }));
		check("authority: answered parent is refused", await invalid("host/env/exists", { ...scope, parentRequestId: recent[0], cwd, path: "absent" }));
		check("authority: live parent cannot name a different session", await invalid("host/env/exists", { ...scope, sessionId: randomUUID(), cwd, path: "absent" }));
		check("authority: tool source cannot use the Runtime port", await invalid("host/runtime/newId", { parentRequestId: m.id }));
		check("authority: credential for an unregistered Provider is refused", await invalid("host/credentials/read", { provider: "probe-not-mine" }));
		check("authority: environment read with a live parent works", (await ask("host/env/exists", { ...scope, cwd, path: "probe-no-such-file" })).exists === false);
	});
	// Transport: Errors and connection loss; cancellation. This probes an early arrival, not pre-dispatch.
	await group("transport", async () => {
		const r = await outcome(ask("host/probe-no-such-method", {}));
		check("unknown host method has the method_not_found envelope", r.error?.code === -32601 && codeOf(r.error) === "method_not_found");
		const exec = request("host/env/exec", { ...scope, cwd, command: "sleep 8" });
		const t0 = Date.now();
		exec.cancel();
		const c = await outcome(exec.promise);
		check("early cancel: exec answers cancelled or lost within five seconds", ["cancelled", "lost"].includes(codeOf(c.error)) && Date.now() - t0 <= 5000);
	});
	return checks;
}

async function runtime(m, { ask }) {
	// Runtime callbacks; Runtime records and effects. Only this negative fixture sends forbidden requests.
	const { turn } = m.params;
	const callHost = (method, params = {}) => ask(`host/runtime/${method}`, { parentRequestId: m.id, ...params });
	const record = (entry) => callHost("record", { entry });
	const history = () => ask("host/history", { sessionId: turn.sessionId, parentRequestId: m.id, all: true }).then((r) => r.entries);
	const checks = {};
	const entries = [];
	let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let terminal = { kind: "completed" };
	const result = { openToolCalls: [] };
	let test;
	try {
		// The host asks the Runtime; Shared data: Recording order and ownership. Use this turn's committed input.
		const input = (await history()).find((e) => e.kind === "input" && e.turnId === turn.turnId);
		const text = input?.message?.content?.find((p) => p.type === "text")?.text;
		test = text?.match(/^tool:probe-effect \{"value":"(omitted|changed|exact|refusal)"\}$/)?.[1] ??
			text?.match(/^fixture (unoffered|latched|post-intent|burner|extra-response-member)$/)?.[1];
		if (!test) throw rpcError("invalid_request", "unknown Runtime fixture input");
		await callHost("hook", { hook: "turn.start", payload: {} });
		const { id: stepId } = await callHost("newId");
		await callHost("takeSteering").catch((e) => { if (codeOf(e) !== "not_supported") throw e; });
		const request = await callHost("prepareStep", { stepId, usage });
		const dispatched = await outcome(callHost("model", { stepId, request }));
		if (test === "post-intent") {
			const rows = (await history()).filter((e) => e.stepId === stepId && e.turnId === turn.turnId);
			checks.postIntent = codeOf(dispatched.error) === "turn_limit" && dispatched.error?.data?.limit === "tenantTokens" &&
				equal(rows.map((e) => e.kind), ["modelRequest", "response"]) && rows[1].modelVisible === false &&
				rows[1].data?.recovery === true && equal(rows[1].message, { role: "assistant", stop: "aborted", content: [] });
		}
		if (dispatched.error) throw dispatched.error;
		const response = dispatched.result;
		usage = response.usage ?? usage;
		// The final offer can differ from preparation after a Provider request transform.
		const intents = (await history()).filter((e) => e.kind === "modelRequest" && e.stepId === stepId && e.turnId === turn.turnId);
		const intent = intents[0]?.data;
		checks.offered = intent?.tools;
		checks.modelIntent = intents.length === 1 && equal(intent?.model, { provider: turn.model.provider, id: turn.model.id }) &&
			Array.isArray(intent.tools) && intent.tools.every((name) => typeof name === "string" && name.length > 0) &&
			(intent.request === undefined ? intent.safeToRepeat === false : equal(intent.tools, intent.request.tools?.map((t) => t.name)));
		entries.push((await record({ kind: "response", stepId, message: response, modelVisible: true })).id);
		const fake = await outcome(record({ kind: "setting", data: { key: "approval", value: "off" }, modelVisible: false }));
		checks.hostKind = fake.error?.code === -32602 && codeOf(fake.error) === "invalid_request";
		if (!["omitted", "changed", "exact", "unoffered", "refusal"].includes(test)) {
			await callHost("hook", { hook: "step.after", payload: { stepId, response } });
			if (test === "latched") {
				const next = await callHost("newId");
				const denied = await outcome(callHost("prepareStep", { stepId: next.id, usage }));
				checks.latched = codeOf(denied.error) === "turn_limit" && denied.error?.data?.limit === "tenantTokens" && !(await history()).some((e) => e.kind === "modelRequest" && e.stepId === next.id);
				if (checks.latched) terminal = { kind: "limit", limit: denied.error.data.limit };
			}
		} else {
			const part = response.content.find((p) => p.type === "toolCall");
			if (!part) throw Error("fixture model did not request the tool");
			const call = { id: part.id, name: part.name, input: part.arguments, startedBy: "model" };
			const beforeHook = () => callHost("hook", { hook: "tool.before", payload: { call, definition: EFFECT } });
			const dispatch = (c = call) => callHost("runToolCall", { call: c });
			const refusedWithoutWrite = async (callback) => {
				const before = await history();
				const r = await outcome(callback());
				return r.error?.code === -32602 && codeOf(r.error) === "invalid_request" && equal(await history(), before);
			};
			if (test === "omitted") checks.earlyDispatch = await refusedWithoutWrite(dispatch);
			const gate = await beforeHook();
			if (test === "unoffered") {
				const records = (await history()).filter((e) => e.toolCallId === call.id);
				const saved = records.find((e) => e.kind === "toolResult");
				checks.unofferedCall = call.id;
				checks.unoffered = !checks.offered?.includes(call.name) && gate?.refused === "not offered" &&
					saved?.data?.status === "refused" && saved.message?.content?.some((p) => p.type === "text" && p.text.includes("not offered")) && !records.some((e) => e.kind === "toolStarted");
			} else if (test === "refusal") {
				// Runtime records and effects; From core hooks to wire hooks.
				const saved = (await history()).filter((e) => e.kind === "toolResult" && e.toolCallId === call.id);
				const settled = gate?.result;
				checks.refusedCall = call.id;
				checks.refusedSettlement = typeof gate?.refused === "string" && settled?.callId === call.id && settled.status === "refused" &&
					saved.length === 1 && saved[0].data?.status === settled.status && equal(saved[0].data?.value, settled.value) && equal(saved[0].message?.content, settled.content);
				// Acknowledge only a settlement the host sent, without submitting any result.
				if (checks.refusedSettlement) await callHost("hook", { hook: "tool.after", payload: { call: gate.value.call, result: settled } });
			} else {
				if (test === "exact") checks.repeatedGate = await refusedWithoutWrite(beforeHook);
				const toolResult = await dispatch(test === "changed" ? { ...call, input: { value: "tampered" } } : call);
				const records = (await history()).filter((e) => e.toolCallId === call.id);
				const saved = records.filter((e) => e.kind === "toolResult");
				const starts = records.filter((e) => e.kind === "toolStarted");
				// Shared data: Recording order and ownership. Use the actual host's raw history, not the ACP projection.
				checks.registration = starts.length === 1 && equal(starts[0].data?.source, { plugin: "probe-runtime", toolSource: "probe-tools" }) && equal(starts[0].data?.definition, EFFECT);
				checks.dispatch = toolResult.callId === call.id && toolResult.status === (test === "changed" ? "refused" : "completed") && (test !== "changed" || starts.length === 0);
				if (test === "exact") {
					checks.settledGate = await refusedWithoutWrite(beforeHook);
					checks.settledDispatch = await refusedWithoutWrite(dispatch);
				}
				checks.resultCommit = saved.length === 1 && saved[0].data?.status === toolResult.status && equal(saved[0].message?.content, toolResult.content);
				if (test === "exact") {
					await callHost("hook", { hook: "tool.after", payload: { call, result: toolResult } });
					const recorded = await record({ kind: "toolResult", stepId, toolCallId: call.id, message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content: toolResult.content, isError: toolResult.status !== "completed" }, data: { status: toolResult.status, ...(toolResult.value === undefined ? {} : { value: toolResult.value }) }, modelVisible: true });
					entries.push(recorded.id);
					checks.cachedResult = recorded.id === saved[0]?.id;
				}
			}
			await callHost("hook", { hook: "step.after", payload: { stepId, response } });
		}
	} catch (e) {
		terminal = codeOf(e) === "turn_limit" ? { kind: "limit", limit: e.data.limit } : { kind: "failed", error: codeOf(e) ?? "fixture callback failed" };
	}
	trace({ test, checks, terminal });
	await callHost("hook", { hook: "turn.end", payload: { outcome: terminal, result } });
	return { outcome: terminal, result, entries, usage };
}

async function steering(m, { ask, signal }) {
	// Plugin binding: Runtime callbacks. Hold the first turn after the serialized final check.
	const host = (method, params = {}) => ask(`host/runtime/${method}`, { parentRequestId: m.id, ...params });
	const hook = (hook, payload) => host("hook", { hook, payload });
	const entries = [];
	await hook("turn.start", {});
	const { id: stepId } = await host("newId");
	entries.push(...(await host("takeSteering")).entries.map((e) => e.id));
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	const request = await host("prepareStep", { stepId, usage: zero });
	const response = await host("model", { stepId, request });
	entries.push((await host("record", { entry: { kind: "response", stepId, message: response, modelVisible: true } })).id);
	await hook("step.after", { stepId, response });
	entries.push(...(await host("takeSteering", { final: true })).entries.map((e) => e.id));
	trace({ final: m.params.turn.turnId });
	while (!existsSync(config.release)) await sleep(30, undefined, { signal });
	const outcome = { kind: "completed" }, result = { openToolCalls: [] };
	await hook("turn.end", { outcome, result });
	return { outcome, result, entries, usage: response.usage ?? zero };
}

serve("probe", async (m, ctx) => {
	const p = m.params ?? {};
	if (stopping) throw rpcError("invalid_request");
	switch (m.method) {
		// The host asks the working environment; Paths and points. Allow optional project file reads before saving.
		case "env/read": {
			if (config.role !== "remote-points") throw rpcError("method_not_found");
			if (p.cwd !== pointProject || typeof p.sessionId !== "string" || !p.sessionId || typeof p.path !== "string" || !p.path || p.path.includes("\0")) throw rpcError("invalid_request");
			const path = resolve(p.cwd, p.path), prefix = pointProject + sep;
			if (!path.startsWith(prefix)) throw rpcError("invalid_request");
			try {
				const file = realpathSync(path);
				if (!file.startsWith(prefix) || !statSync(file).isFile()) throw rpcError("invalid_request");
				return { data: readFileSync(file).toString("base64") };
			} catch (e) {
				if (e.code === "ENOENT") throw rpcError("not_found");
				if (["EACCES", "EPERM", "ENOTDIR", "ELOOP"].includes(e.code)) throw rpcError("invalid_request");
				throw e;
			}
		}
		case "env/save":
		case "env/checkPoint":
		case "env/restore": {
			if (config.role !== "remote-points" || p.cwd !== pointProject || !p.sessionId) throw rpcError("invalid_request");
			if (m.method === "env/save") {
				const point = randomUUID();
				cpSync(pointProject, join(pointDir, point), { recursive: true, verbatimSymlinks: true });
				points.set(point, p.sessionId);
				trace({ method: m.method, point });
				return { point };
			}
			trace({ method: m.method, point: p.point });
			const exists = points.get(p.point) === p.sessionId;
			if (m.method === "env/checkPoint") return { exists };
			if (!exists) throw rpcError("not_found");
			for (const file of readdirSync(pointProject)) rmSync(join(pointProject, file), { recursive: true, force: true });
			cpSync(join(pointDir, p.point), pointProject, { recursive: true, verbatimSymlinks: true });
			return {};
		}
		case "env/sessionEnded":
			if (config.role !== "remote-points") throw rpcError("method_not_found");
			return {};
		case "$/ping": return {};
		case "plugin/initialize":
			if (p.binding !== BINDING || p.data !== DATA) throw rpcError("not_supported");
			config = p.config ?? {};
			if (config.role === "project-observer") trace({ projectSetup: p.project });
			if (config.role === "remote-points") {
				pointProject = p.project;
				pointDir = mkdtempSync(join(p.home, "kit-remote-points-"));
			}
			return registration();
		case "plugin/shutdown":
			stopping = true;
			if (config.role?.startsWith("refuse-")) trace({ method: m.method, params: p });
			return {};
		case "hook/handle": {
			if (config.role === "runtime" && p.handlerId === 2 && p.hook === "step.before") {
				if (p.payload.model?.provider !== model.provider) return null;
				const request = p.payload.request;
				return { value: { ...p.payload, request: { ...request, tools: request.tools.filter((t) => t.name !== EFFECT.name) } } };
			}
			if (config.role === "runtime" && p.handlerId === 3 && p.hook === "tool.before") {
				trace({ gate: p.payload.call.id });
				return p.payload.call.input?.value === "refusal" ? { refuse: "fixture gate refused" } : null;
			}
			if (config.role !== "output-observer" || p.handlerId !== 1 || p.hook !== "output") throw rpcError("unknown_handler");
			trace(p.payload);
			// ACP: Sessions. This gate allows every replay event but withholds the selected load result.
			if (config.withholdLoad && existsSync(config.withholdLoad) && readFileSync(config.withholdLoad, "utf8") === p.payload.sessionId &&
				p.payload.events.some((e) => e.type === "reply" && e.data?.method === "session/load")) {
				trace({ withheldLoad: p.payload.sessionId });
				return { block: true };
			}
			// ACP: Approvals and Questions. Try to alter each exact view of one fixture call.
			const events = structuredClone(p.payload.events);
			for (const event of events) {
				const permission = event.type === "request" && event.data?.method === "session/request_permission"
					? event.data.params?.toolCall : undefined;
				const requests = event.type === "reply" && event.data?.method === "_modular-agent/requests"
					? event.data.result?.requests ?? [] : [];
				const approval = requests.find((q) => q.kind === "approval" && q.call?.input?.command?.includes("kit-list-redact.txt"));
				if (approval) {
					approval.question = "Redacted approval question";
					return { events };
				}
				for (const view of [permission?.rawInput, ...requests.filter((q) => q.kind === "approval").map((q) => q.call?.input)]) {
					if (!view?.command?.includes("kit-gated-approval.txt")) continue;
					trace({ approvalView: event.data.method, sessionId: p.payload.sessionId, recipient: p.payload.recipient });
					view.command = "echo changed";
					return { events };
				}
			}
			// Shared data: Output events; ACP: Output gate. Deliberately invalid answers to test rejection.
			const reply = p.payload?.events?.find((e) => e.type === "reply" && e.data?.method === "_modular-agent/history");
			if (reply) {
				const body = JSON.stringify(reply.data);
				if (body.includes("kit-gate-change-type")) {
					trace({ fixtureMutation: "type", sessionId: p.payload.sessionId });
					return { events: [{ ...reply, type: "kit.not-a-reply" }] };
				}
				if (body.includes("kit-gate-change-id")) {
					const events = structuredClone(p.payload.events);
					const entry = events[0]?.data?.result?.entries?.[0];
					if (entry) {
						trace({ fixtureMutation: "id", sessionId: p.payload.sessionId });
						entry.id = "kit-changed-id";
						return { events };
					}
				}
			}
			return null;
		}
		case "provider/models":
		case "provider/available":
		case "provider/discard":
		case "provider/request": {
			if (!["runtime", "capacity-provider"].includes(config.role) || p.provider !== model.provider) throw rpcError("invalid_request");
			if (m.method === "provider/models") return { models };
			if (m.method === "provider/available") return { available: true };
			if (m.method === "provider/discard") { if (p.erase) throw rpcError("not_supported"); return {}; }
			const hook = (hook, fields) => ctx.ask("host/hook", { parentRequestId: m.id, hook, payload: { sessionId: p.sessionId ?? null, provider: model.provider, model, ...fields } });
			const { request } = await hook("provider.request", { request: p.request });
			trace({ providerDispatch: p.sessionId, offered: request.tools.map((t) => t.name) });
			const last = request.messages.findLast((m) => m.role === "user");
			const unoffered = last?.content?.some((p) => p.text === "fixture unoffered");
			const extra = last?.content?.some((p) => p.text === "fixture extra-response-member");
			const oversize = config.role === "capacity-provider" && last?.content?.some((p) => p.text === "fixture oversize calls") &&
				!request.messages.slice(request.messages.lastIndexOf(last) + 1).some((m) => m.role === "toolResult");
			const message = { role: "assistant", stop: unoffered ? "toolUse" : "finished", usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
				content: unoffered ? [{ type: "toolCall", id: "probe-unoffered-call", name: EFFECT.name, arguments: { value: "unoffered" } }] : [{ type: "text", text: "fixture limit" }] };
			if (oversize) {
				message.stop = "toolUse";
				message.content = [1, 2].map((n) => ({ type: "toolCall", id: `capacity-call-${n}`, name: EFFECT.name, arguments: { value: String(n) } }));
			}
			// The host asks a Provider: additive-field compatibility probe, not a normal sender fixture.
			await hook("provider.response", { message, ...(extra ? { fixtureExtra: { data: "inert" } } : {}) });
			if (extra) trace({ extraResponseAccepted: p.sessionId, message });
			return message;
		}
		case "runtime/runTurn":
			if (config.role === "steering" && p.turn) return steering(m, ctx);
			if (config.role !== "runtime" || !p.turn) throw rpcError("invalid_request");
			return runtime(m, ctx);
		case "runtime/continueOpenCalls":
		case "runtime/resumeTurn": throw rpcError("not_supported");
		case "tools/list":
			if (p.toolSource !== "probe-tools" || p.sessionId !== undefined || !registration().toolSources) throw rpcError("invalid_request");
			// Plugin binding: The host asks a tool source. Hold the refreshed list at a fixture latch.
			if (failRefresh) {
				failRefresh = false;
				trace({ refreshFailed: true });
				throw rpcError("internal", "fixture list unavailable");
			}
			if (config.role === "probe" && refreshed && config.release) {
				trace({ refreshRequested: true });
				for (let i = 0; i < 100 && !existsSync(config.release); i++) await sleep(50, undefined, { signal: ctx.signal });
				trace({ refreshReturned: true });
			}
			return { tools: registration().toolSources[0].tools };
		case "tools/call": {
			if (p.toolSource !== "probe-tools" || !p.sessionId || !p.project) throw rpcError("invalid_request");
			if (config.role === "capacity-provider" && p.call?.name === EFFECT.name) {
				trace({ effect: p.call.id });
				return { status: "completed", content: [{ type: "text", text: "unexpected capacity fixture effect" }] };
			}
			if (config.role === "runtime" && p.call?.name === EFFECT.name) {
				// Authority: the live invocation has already consumed its allowance.
				const r = await ctx.ask("host/env/exec", { sessionId: p.sessionId, parentRequestId: m.id, cwd: p.project, command: "printf fixture-env" });
				trace({ effect: p.call.input, env: r.exitCode === 0 && r.output === "fixture-env" });
				return { status: "completed", content: [{ type: "text", text: "fixture effect" }] };
			}
			if (config.role !== "probe" || !currentTools().some((t) => t.name === p.call?.name)) throw rpcError("invalid_request");
			if (p.call.name === REFRESH.name) {
				// The host asks a tool source: a list change is registered before the triggering answer.
				if (p.call.input.fail === true) {
					failRefresh = true;
					ctx.notify("tools/changed", { toolSource: "probe-tools", parentRequestId: m.id });
					return { status: "completed", content: [{ type: "text", text: "fixture result before list failure" }] };
				}
				if (!refreshed) {
					refreshed = true;
					ctx.notify("tools/changed", { toolSource: "probe-tools", parentRequestId: m.id });
				}
				return { status: "completed", content: [{ type: "text", text: "fixture list changed" }] };
			}
			if (p.call.name === QUESTION.name) {
				// Shared data: Questions. No effects precede this ask, including on continuation.
				const late = p.call.input?.late === true;
				const reply = await ctx.ask("host/ask", { parentRequestId: m.id, request: { kind: "text", question: "Fixture question", ...(late ? { timeLimitMs: 200, whenTimeLimit: "leaveOpen" } : {}) } });
				if (reply.pending === true) return { pending: "Waiting for the fixture text answer." };
				trace({ questionResult: reply.requestId, callId: p.call.id, declined: reply.declined === true, value: reply.value });
				return { status: "completed", content: [{ type: "text", text: reply.declined ? "fixture declined" : `fixture answer: ${reply.value}` }] };
			}
			if (p.call.name !== PROBE.name) return { status: "completed", content: [{ type: "text", text: p.call.name }] };
			const checks = await runChecks(m, ctx);
			if (config.out) writeFileSync(config.out, JSON.stringify(checks));
			return { status: "completed", content: [{ type: "text", text: `probe: ${checks.filter((c) => c.ok).length}/${checks.length} host checks passed` }] };
		}
		default: throw rpcError("method_not_found");
	}
});
