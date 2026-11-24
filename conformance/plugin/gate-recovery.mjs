#!/usr/bin/env node
// Host-side fixture for Plugin binding: The host asks the Runtime, and Contracts:
// Recovery and repeating work and Hook execution. The ACP kit kills the host at the traced latch.
import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { codeOf, outcome, rpcError, serve } from "./peer.mjs";

const binding = "modular-agent-plugin/1", name = "kit-gate-recovery";
const model = { provider: name, id: "echo" };
const models = [{ ...model, contextWindow: 4096, maxOutput: 512, input: ["text"], reasoning: false }];
const tool = { name: "kit-unsafe", description: "Fixture call that cannot be repeated.", parameters: { type: "object" }, hints: { openWorld: true } };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
let config;
const trace = (row) => appendFileSync(config.out, JSON.stringify(row) + "\n");
const hold = (signal) => sleep(60000, undefined, { signal }); // Fixture watchdog, not work policy.

async function run(m, { ask, signal }) {
	const host = (method, params = {}) => ask(`host/runtime/${method}`, { parentRequestId: m.id, ...params });
	const hook = (hook, payload) => host("hook", { hook, payload });
	const { turn, interrupted } = m.params;
	const result = { openToolCalls: [] }, entries = [];
	let terminal = { kind: "completed" };
	if (!interrupted) {
		await hook("turn.start", {});
		const { id: stepId } = await host("newId");
		await host("takeSteering").catch((e) => { if (codeOf(e) !== "not_supported") throw e; });
		const request = await host("prepareStep", { stepId, usage });
		const response = await host("model", { stepId, request });
		entries.push((await host("record", { entry: { kind: "response", stepId, message: response, modelVisible: true } })).id);
		const part = response.content.find((p) => p.type === "toolCall");
		if (part) {
			const call = { id: part.id, name: part.name, input: part.arguments, startedBy: "model" };
			const gate = await hook("tool.before", { call, definition: tool });
			if (gate.refused || gate.pending) throw rpcError("invalid_request", "fixture call was not allowed");
			await host("runToolCall", { call: gate.value.call });
		}
		await hook("step.after", { stepId, response });
		trace({ latch: "after", turnId: turn.turnId, stepId });
		await hold(signal);
	} else {
		const { lastStep, calls } = interrupted;
		const { entries: log } = await ask("host/history", { sessionId: turn.sessionId, parentRequestId: m.id, all: true });
		const response = log.find((e) => e.kind === "response" && e.turnId === turn.turnId && e.stepId === lastStep?.stepId);
		const terminalCalls = log.filter((e) => e.kind === "toolResult" && e.turnId === turn.turnId).map((e) => ({ id: e.toolCallId, status: e.data?.status }));
		trace({ resumed: turn.turnId, interrupted, terminalCalls });
		if (!response || calls.length) throw rpcError("invalid_request", "fixture has no settled last step");
		if (Object.hasOwn(lastStep, "decision")) {
			if (lastStep.decision?.refused) terminal = { kind: "failed", error: lastStep.decision.refused };
		} else {
			const step = await outcome(hook("step.after", { stepId: lastStep.stepId, response: response.message }));
			trace({ gateReply: lastStep.stepId, accepted: !step.error });
			if (step.error || step.result?.refused) terminal = { kind: "failed", error: step.result?.refused ?? "Fixture gate rejected" };
		}
	}
	await hook("turn.end", { outcome: terminal, result });
	return { outcome: terminal, result, entries, usage };
}

serve(name, async (m, ctx) => {
	const p = m.params ?? {};
	switch (m.method) {
		case "plugin/initialize":
			if (p.binding !== binding) throw rpcError("not_supported");
			config = p.config;
			return { binding, name, replaces: ["runtime"], runtime: { id: name, supports: { continuesAfterRestart: true } },
				providers: [{ id: name, models, supports: { keepsState: false, runsTools: false } }],
				toolSources: [{ id: name, tools: [tool] }], hooks: [{ hook: "step.after", handlerId: 1 }] };
		case "plugin/shutdown":
		case "$/ping": return {};
		case "provider/models": return { models };
		case "provider/available": return { available: true };
		case "provider/discard": if (p.erase) throw rpcError("not_supported"); return {};
		case "provider/request": {
			const scope = { sessionId: p.sessionId ?? null, provider: name, model };
			const hook = (hook, fields) => ctx.ask("host/hook", { parentRequestId: m.id, hook, payload: { ...scope, ...fields } });
			await hook("provider.request", { request: p.request });
			const before = config.boundary === "before";
			const message = { role: "assistant", stop: before ? "toolUse" : "finished", usage,
				content: before ? [{ type: "toolCall", id: "kit-unsafe-call", name: tool.name, arguments: {} }] : [{ type: "text", text: "Fixture answer" }] };
			await hook("provider.response", { message });
			return message;
		}
		case "tools/list": return { tools: [tool] };
		case "tools/call":
			if (config.boundary !== "before" || p.toolSource !== name || p.call?.name !== tool.name) throw rpcError("invalid_request");
			trace({ latch: "before", callId: p.call.id });
			await hold(ctx.signal);
			return { status: "completed", content: [{ type: "text", text: "Fixture result" }] };
		case "hook/handle":
			if (p.handlerId !== 1 || p.hook !== "step.after") throw rpcError("unknown_handler");
			trace({ gate: p.payload.stepId });
			return null;
		case "runtime/runTurn":
		case "runtime/resumeTurn": return run(m, ctx);
		default: throw rpcError("method_not_found");
	}
});
