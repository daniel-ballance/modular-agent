// Drive `ma --acp` over stdio with the official ACP client, as an editor or T3 Code would.
// Usage: node scripts/acp-smoke.mjs <cwd> "<prompt>" [extra ma args...]
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk";

const [cwd, prompt, ...extra] = process.argv.slice(2);
const child = spawn(process.execPath, [new URL("../packages/agent/dist/src/cli.js", import.meta.url).pathname, "--acp", ...extra], { cwd, stdio: ["pipe", "pipe", "inherit"] });
const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
const app = client({ name: "acp-smoke" })
	.onNotification(methods.client.session.update, ({ params }) => {
		const u = params.update;
		if (u.sessionUpdate === "agent_message_chunk") process.stdout.write(u.content.text);
		else if (u.sessionUpdate === "tool_call") console.log(`\n[tool_call ${u.title} ${u.status}]`);
		else if (u.sessionUpdate === "tool_call_update" && u.status) console.log(`[tool_call_update ${u.status}]`);
	})
	.onRequest(methods.client.session.requestPermission, ({ params }) => {
		console.log(`\n[permission asked: ${params.toolCall.title}; allowing]`);
		return { outcome: { outcome: "selected", optionId: "allow" } };
	});
await app.connectWith(stream, async (ctx) => {
	const init = await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
	console.log(`[agent ${init.agentInfo?.name}; declares ${Object.keys(init._meta?.["modular-agent/declaration"] ?? {}).length} features]`);
	const { sessionId, configOptions } = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
	console.log(`[session ${sessionId}; ${configOptions.find((o) => o.id === "model").options.length} models offered]`);
	const r = await ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: prompt }] });
	console.log(`\n[stopReason ${r.stopReason}]`);
});
child.kill();
