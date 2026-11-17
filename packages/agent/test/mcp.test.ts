import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { client, methods } from "@agentclientprotocol/sdk";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { Harness, Plugin } from "@modular-agent/harness";
import { acpInterface } from "@modular-agent/interface-acp";
import { mcpTools } from "@modular-agent/tools-mcp";
import { createAgent } from "../src/index.js";

/** A minimal MCP server over stdio, with one tool: add. */
function calcServer(dir: string): string {
	const file = join(dir, "calc-server.mjs");
	writeFileSync(file, `
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
	const m = JSON.parse(line);
	if (m.id === undefined) return;
	if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "calc", version: "1" } } });
	if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, annotations: { readOnlyHint: true } }] } });
	if (m.method === "tools/call") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: String(m.params.arguments.a + m.params.arguments.b) }] } });
	if (m.method === "ping") return send({ jsonrpc: "2.0", id: m.id, result: {} });
	send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no such method" } });
});
`);
	return file;
}

const dirs = () => ({ project: mkdtempSync(join(tmpdir(), "ma-p-")), home: mkdtempSync(join(tmpdir(), "ma-h-")) });
async function agent(d: { project: string; home: string }, responses: FauxResponseStep[], plugins: Plugin[]): Promise<Harness> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	return createAgent({ ...d, models, model: "faux/faux-1", plugins });
}
const lastResult: FauxResponseFactory = (c) => {
	const r = c.messages.filter((m) => m.role === "toolResult").at(-1) as { content: { text: string }[] } | undefined;
	return fauxAssistantMessage([fauxText(`Result: ${r?.content.map((p) => p.text).join("") ?? "none"}`)]);
};
const lastText = (h: Harness, s: string) => (h.api("t").history(s).filter((e) => e.kind === "turnEnd").at(-1)!.data as { result: { text?: string } }).result.text;
const toolNames = (h: Harness, s?: string) => h.api("t").tools(s).map((t) => t.name);

test("MCP: a server from the global settings gives every session its tools", async () => {
	const d = dirs();
	const server = calcServer(d.home);
	writeFileSync(join(d.home, "settings.json"), JSON.stringify({ plugins: { "tools-mcp": { servers: { calc: { command: process.execPath, args: [server] } } } } }));
	const h = await agent(d, [fauxAssistantMessage([fauxToolCall("mcp__calc__add", { a: 2, b: 3 })], { stopReason: "toolUse" }), lastResult], [mcpTools()]);
	const api = h.api("t");
	const s = await api.startSession();
	const add = api.tools(s).find((t) => t.name === "mcp__calc__add");
	assert.ok(add, "the server's tool is offered");
	assert.equal(add.hints?.readOnly, true, "MCP's annotations become the tool's hints");
	await api.input(s, { content: "add 2 and 3", actorId: "user" });
	await api.waitForIdle(s);
	assert.equal(lastText(h, s), "Result: 5");
	await h.stop();
});

test("MCP: a project's servers start only once the project is trusted", async () => {
	const d = dirs();
	const server = calcServer(d.home);
	mkdirSync(join(d.project, ".modular-agent"));
	writeFileSync(join(d.project, ".modular-agent", "settings.json"), JSON.stringify({ plugins: { "tools-mcp": { servers: { calc: { command: process.execPath, args: [server] } } } } }));
	let h = await agent(d, [], [mcpTools()]);
	assert.ok(!toolNames(h).includes("mcp__calc__add"), "an untrusted project starts no server");
	const s = await h.api("t").startSession();
	assert.match((await h.api("t").input(s, { content: "/trust", actorId: "user" })).output ?? "", /trust/i);
	await h.stop();
	h = await agent(d, [], [mcpTools()]);
	assert.ok(toolNames(h).includes("mcp__calc__add"), "once trusted, it starts");
	await h.stop();
});

test("MCP over ACP: servers a client passes serve only that session", async () => {
	const d = dirs();
	const server = calcServer(d.home);
	const acp = acpInterface();
	const h = await agent(d, [fauxAssistantMessage([fauxToolCall("mcp__calc__add", { a: 40, b: 2 })], { stopReason: "toolUse" }), lastResult], [mcpTools(), acp]);
	const ctx = client({ name: "test-client" }).connect(acp.acp.app).agent;
	const init = await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
	assert.equal(init.agentCapabilities?.mcpCapabilities?.http, true);
	const withCalc = await ctx.request(methods.agent.session.new, { cwd: d.project, mcpServers: [{ name: "calc", command: process.execPath, args: [server], env: [] }] });
	const without = await ctx.request(methods.agent.session.new, { cwd: d.project, mcpServers: [] });
	assert.ok(toolNames(h, withCalc.sessionId).includes("mcp__calc__add"));
	assert.ok(!toolNames(h, without.sessionId).includes("mcp__calc__add"), "another session doesn't get them");
	const response = await ctx.request(methods.agent.session.prompt, { sessionId: withCalc.sessionId, prompt: [{ type: "text", text: "40 + 2?" }] });
	assert.equal(response.stopReason, "end_turn");
	assert.equal(lastText(h, withCalc.sessionId), "Result: 42");
	await h.stop();
});
