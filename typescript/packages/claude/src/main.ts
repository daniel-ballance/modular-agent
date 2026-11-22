#!/usr/bin/env node
// Serve the Provider `claude` over modular-agent-plugin/1 on stdin and stdout.
import { readFileSync } from "node:fs";
import { ClaudeProvider } from "./provider.js";
import { installedSdkVersion, type QueryFunction } from "./sdk.js";
import { serve } from "./serve.js";

// stdout carries the connection: nothing else may write to it.
const log = (message: string): void => void process.stderr.write(`[claude-sidecar] ${message}\n`);
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const version = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

// TEST ONLY. Any value replaces the Agent SDK with the scripted one in testing/fake-sdk.ts, so
// no Claude Code process starts and no request leaves the machine. `signed-out` also reports no login.
const fake = process.env.CLAUDE_SIDECAR_TEST_FAKE_SDK;
let query: QueryFunction | undefined;
if (fake) {
	query = (await import("./testing/fake-sdk.js")).fakeQuery;
	log("TEST MODE: the Agent SDK is replaced by a scripted fake. No model is reached.");
}

const provider = new ClaudeProvider({
	version,
	sdkVersion: fake ? "fake" : installedSdkVersion(),
	query,
	env: process.env,
	checkApiRouting: !fake,
	...(fake ? { loginVisible: () => fake !== "signed-out" } : {}),
	log: process.env.CLAUDE_SIDECAR_DEBUG ? log : undefined,
});
process.on("uncaughtException", (error) => log(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`));
process.on("unhandledRejection", (error) => log(`Unexpected rejection: ${error instanceof Error ? error.message : String(error)}`));
await serve({ provider });
process.exit(0);
