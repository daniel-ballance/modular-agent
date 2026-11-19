// A real run, kept tiny: plays the host against the built sidecar with the real Agent SDK and
// the Claude Code login. Two model requests on a Haiku model. Run with `npm run live`.
// It starts the sidecar the way a host does: a minimal environment with PATH and HOME only
// (or CLAUDE_CONFIG_DIR / CLAUDE_CODE_OAUTH_TOKEN when those are set here). Prints no credential.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WirePeer } from "./wire.js";

const scratch = mkdtempSync(join(tmpdir(), "claude-sidecar-live-"));
const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", CLAUDE_SIDECAR_DEBUG: "1" };
for (const name of ["HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"]) if (process.env[name]) env[name] = process.env[name]!;
console.log(`launch environment variables: ${Object.keys(env).join(", ")}`);

const child = spawn(process.execPath, [fileURLToPath(new URL("./main.js", import.meta.url))], { env, cwd: scratch, stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => process.stderr.write(String(d)));
const peer = new WirePeer((line) => void child.stdin.write(line));
child.stdout.on("data", (d: Buffer) => peer.feed(d));
const events: { type: string }[] = [];
const hooks: string[] = [];
peer.handle("host/hook", async (p) => {
	hooks.push(p.hook);
	return p.hook === "provider.request" ? p.payload : null;
});
peer.onNotification("provider/event", (p) => events.push(p.event));

let failed = false;
const check = (name: string, ok: boolean, detail = ""): void => {
	if (!ok) failed = true;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

try {
	const registration = await peer.request("plugin/initialize", {
		binding: "modular-agent-plugin/1", data: "modular-agent-data/1", host: { name: "live-check", version: "0" },
		project: scratch, home: join(scratch, "home"), config: {},
	});
	check("registers Provider claude, stateless, runsTools false", registration.providers?.[0]?.id === "claude" && registration.providers[0].supports.keepsState === false && registration.providers[0].supports.runsTools === false);
	const { available } = await peer.request("provider/available", { provider: "claude" });
	check("provider/available is true in the minimal environment", available === true);
	if (!available) throw new Error("Claude Code's login was not found; nothing was sent.");

	// The model list narrows once Claude Code has reported the account's models. No prompt is sent for that.
	let models: { id: string; contextWindow: number; maxOutput: number; thinking?: string[] }[] = registration.providers[0].models;
	const initial = models.length;
	for (let i = 0; i < 80 && models.length === initial; i++) {
		await new Promise((r) => setTimeout(r, 250));
		models = (await peer.request("provider/models", { provider: "claude" })).models;
	}
	check("the catalog was narrowed to the account's models", models.length !== initial, `${initial} built in, ${models.length} reported`);
	for (const m of models) console.log(`  model ${m.id}  context ${m.contextWindow}  maxOutput ${m.maxOutput}  thinking ${m.thinking?.join(",")}`);
	const haiku = models.find((m) => m.id.includes("haiku"));
	if (!haiku) throw new Error("The account offers no Haiku model; nothing was sent.");
	const model = { provider: "claude", id: haiku.id };
	const tool = { name: "get_weather", description: "Get the current weather for a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false } };
	const systemPrompt = "You are a terse test assistant. For any weather question, call the get_weather tool, then answer in one short sentence.";
	const user = { role: "user", content: [{ type: "text", text: "What is the weather in Paris right now?" }] };
	const settings = { reasoning: haiku.thinking?.includes("off") ? "off" : haiku.thinking?.[0], maxOutput: 1024 };

	console.log(`request 1: ${haiku.id}, one user message, one tool`);
	const first = await peer.request("provider/request", { provider: "claude", model, sessionId: "live-1", request: { systemPrompt, messages: [user], tools: [tool], settings } });
	const calls = first.content.filter((p: { type: string }) => p.type === "toolCall");
	console.log(`  stop=${first.stop} usage=${JSON.stringify(first.usage)} content=${JSON.stringify(first.content)}`);
	check("request 1 stops with toolUse", first.stop === "toolUse");
	check("request 1 has one toolCall for get_weather with a city", calls.length === 1 && calls[0].name === "get_weather" && /paris/i.test(String(calls[0].arguments?.city)), JSON.stringify(calls));
	check("request 1 reported usage", first.usage?.output > 0);
	check("hooks ran in order around request 1", JSON.stringify(hooks) === JSON.stringify(["provider.request", "provider.response"]), hooks.join(","));
	console.log(`  streamed events: ${events.length} (${[...new Set(events.map((e) => e.type))].join(", ")})`);
	if (first.stop !== "toolUse" || calls.length !== 1) throw new Error("Stopping after one request: the first did not produce a tool call.");

	events.length = 0;
	console.log("request 2: the same conversation plus the tool result");
	const result = { role: "toolResult", toolCallId: calls[0].id, toolName: "get_weather", content: [{ type: "text", text: "Paris: 18 degrees Celsius, light rain, wind 7 km/h." }], isError: false };
	const second = await peer.request("provider/request", { provider: "claude", model, sessionId: "live-1", request: { systemPrompt, messages: [user, first, result], tools: [tool], settings } });
	const text = second.content.filter((p: { type: string }) => p.type === "text").map((p: { text: string }) => p.text).join("");
	console.log(`  stop=${second.stop} usage=${JSON.stringify(second.usage)} text=${JSON.stringify(text)}`);
	check("request 2 finishes with text that uses the tool result", second.stop === "finished" && /18/.test(text));
	check("request 2 streamed text", events.some((e) => e.type === "text"));
	check("request 2 made no further tool call", !second.content.some((p: { type: string }) => p.type === "toolCall"));
	check("the catalog is unchanged after a request", (await peer.request("provider/models", { provider: "claude" })).models.some((m: { id: string }) => m.id === haiku.id));
} catch (error) {
	failed = true;
	console.log(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
} finally {
	await peer.request("plugin/shutdown", { reason: "stop" }).catch(() => undefined);
	child.stdin.end();
	const code = await new Promise((resolve) => {
		const timer = setTimeout(() => { child.kill(); resolve("killed"); }, 5_000);
		child.on("exit", (c) => { clearTimeout(timer); resolve(c); });
	});
	console.log(`sidecar exit: ${code}`);
	rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
