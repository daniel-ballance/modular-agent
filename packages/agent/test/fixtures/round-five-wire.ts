import { createInterface } from "node:readline";
import { PLUGIN_BINDING, WirePeer } from "@modular-agent/plugin-wire";
import { text } from "@modular-agent/harness";

const peer = new WirePeer((line) => process.stdout.write(line));
const initial = { name: "grow", description: "Change the tool list", parameters: { type: "object" } };
const added = { name: "grown", description: "Visible after grow", parameters: { type: "object" } };
let grown = false;
const model = { provider: "wire-test", id: "sample", reasoning: false, contextWindow: 100000, maxOutput: 1000, input: ["text"] };
peer.handle("plugin/initialize", () => ({
	binding: PLUGIN_BINDING, name: "wire-test",
	toolSources: [{ id: "changing", tools: [initial] }],
	providers: [{ id: model.provider, models: [model], supports: { keepsState: true, runsTools: false } }],
	commands: [{ name: "wire-page", description: "Measure the first page after an entry" }],
}));
peer.handle("plugin/shutdown", () => ({}));
peer.handle("provider/available", () => ({ available: true }));
peer.handle("provider/discard", (p) => ({ pending: p.entryIds?.slice(0, 1) }));
peer.handle("tools/list", () => ({ tools: grown ? [initial, added] : [initial] }));
peer.handle("tools/call", (_p, ctx) => {
	grown = true;
	peer.notify("tools/changed", { toolSource: "changing", parentRequestId: ctx.id });
	return { status: "completed", content: [] };
});
peer.handle("provider/request", (_p, ctx) => {
	for (const delta of ["split conformance-", "secret end"]) peer.notify("provider/event", { parentRequestId: ctx.id, event: { type: "text", delta } });
	return { role: "assistant", stop: "finished", content: [text("split conformance-secret end")] };
});
peer.handle("command/run", async (p, ctx) => {
	const { sessionId, args: after } = p;
	const page = await peer.request<{ entries: { id: string }[]; next?: string }>("host/history", { sessionId, after, parentRequestId: ctx.id });
	return { output: JSON.stringify({ bytes: Buffer.byteLength(JSON.stringify(page)), next: page.next, ids: page.entries.map((e) => e.id) }) };
});
createInterface({ input: process.stdin }).on("line", (line) => peer.feed(line + "\n"));
