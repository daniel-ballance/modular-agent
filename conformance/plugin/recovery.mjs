#!/usr/bin/env node
// Host-side fixture for Plugin binding: Model attempt sequences (crash recovery).
import { appendFileSync } from "node:fs";
import { codeOf, rpcError, serve } from "./peer.mjs";

const binding = "modular-agent-plugin/1";
const name = "kit-recovery";
const model = { provider: name, id: "echo" };
const models = [{ ...model, contextWindow: 4096, maxOutput: 512, input: ["text"], reasoning: false }];
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const text = (text) => [{ type: "text", text }];
let config, stopping = false;
const trace = (row) => appendFileSync(config.out, JSON.stringify(row) + "\n");
const history = (ask, sessionId) => ask("host/history", { sessionId, all: true }).then((r) => r.entries);

async function resume(m, ask) {
	const { turn, interrupted } = m.params;
	const { sessionId, turnId } = turn;
	const host = (method, params = {}) => ask(`host/runtime/${method}`, { parentRequestId: m.id, ...params });
	const hook = (hook, payload) => host("hook", { hook, payload });
	const log = await history(ask, sessionId);
	trace({ resume: interrupted, turnId, log });
	const checkpoint = log.find((e) => e.kind === "turnStart" && e.turnId === turnId);
	const input = log.find((e) => e.kind === "input" && e.turnId === turnId);
	const old = log.find((e) => e.kind === "modelRequest" && e.stepId === "old-step" && e.turnId === turnId);
	if (!checkpoint || !input || !old || interrupted.turnId !== turnId || interrupted.calls.length) throw rpcError("invalid_request");
	let outcome = { kind: "failed", error: "Interrupted fixture turn" };
	const result = { openToolCalls: [] }, entries = [];
	if (config.mode !== "transient") {
		const { id: stepId } = await host("newId");
		let request;
		if (config.mode === "repeat") {
			request = old.data.request;
		} else {
			await host("takeSteering").catch((e) => { if (codeOf(e) !== "not_supported") throw e; });
			request = await host("prepareStep", { stepId, usage });
			trace({ prepared: stepId, request, log: await history(ask, sessionId) });
		}
		const response = await host("model", { stepId, request });
		entries.push((await host("record", { entry: { kind: "response", stepId, message: response, modelVisible: true } })).id);
		await hook("step.after", { stepId, response });
		outcome = { kind: "completed" };
		result.text = "Recovered fixture turn";
	}
	await hook("turn.end", { outcome, result });
	return { outcome, result, entries, usage };
}

serve(name, async (m, { ask }) => {
	const p = m.params ?? {};
	if (stopping) throw rpcError("invalid_request");
	switch (m.method) {
		case "plugin/initialize":
			if (config) throw rpcError("invalid_request");
			if (p.binding !== binding || p.data !== "modular-agent-data/1") throw rpcError("not_supported");
			config = p.config;
			return { binding, name, replaces: ["runtime"],
				runtime: { id: name, supports: { continuesAfterRestart: config.mode !== "transient" } },
				providers: [{ id: name, models, supports: { keepsState: false, runsTools: false, safeToRepeat: config.safe } }],
				...(config.transform ? { hooks: [{ hook: "provider.request", handlerId: 1 }] } : {}) };
		case "plugin/shutdown": stopping = true; return {};
		case "$/ping": return {};
		case "hook/handle": {
			if (!config.transform || p.handlerId !== 1 || p.hook !== "provider.request") throw rpcError("unknown_handler");
			return { value: { ...p.payload, request: { ...p.payload.request, systemPrompt: "Transformed fixture checkpoint" } } };
		}
		case "provider/models":
		case "provider/available":
		case "provider/discard":
		case "provider/request": {
			if (p.provider !== name) throw rpcError("invalid_request");
			if (m.method === "provider/models") return { models };
			if (m.method === "provider/available") return { available: true };
			if (m.method === "provider/discard") {
				if (p.erase) throw rpcError("not_supported");
				return {};
			}
			if (p.model?.provider !== name || p.model.id !== model.id) throw rpcError("invalid_request");
			const scope = { sessionId: p.sessionId ?? null, provider: name, model };
			const hook = (hook, fields) => ask("host/hook", { parentRequestId: m.id, hook, payload: { ...scope, ...fields } });
			const before = await history(ask, config.sessionId);
			const message = { role: "assistant", stop: "finished", content: text("Recovered fixture turn"), usage };
			// Deliberately violate the Provider sequence in the two rejection probes.
			if (config.mode === "no-request-hook") {
				trace({ returnedWithoutHook: true });
				return message;
			}
			if (config.mode === "early-response-hook") {
				const r = await hook("provider.response", { message }).catch((e) => e);
				trace({ earlyResponse: codeOf(r) ?? "accepted" });
				return message;
			}
			const { request } = await hook("provider.request", { request: p.request });
			trace({ provider: request, before, log: await history(ask, config.sessionId) });
			await hook("provider.response", { message });
			return message;
		}
		case "runtime/resumeTurn": return resume(m, ask);
		default: throw rpcError("method_not_found");
	}
});
