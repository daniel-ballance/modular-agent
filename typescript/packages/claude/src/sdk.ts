import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
	Options,
	SDKControlGetContextUsageResponse,
	SDKControlInitializeResponse,
	SDKMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

/** The part of an Agent SDK query this sidecar drives. */
export interface AgentQuery extends AsyncIterable<SDKMessage> {
	initializationResult(): Promise<SDKControlInitializeResponse>;
	setModel(model?: string): Promise<void>;
	getContextUsage(options?: { detail?: "summary" | "full" }): Promise<SDKControlGetContextUsageResponse>;
	close(): void;
}

/** The Agent SDK's `query()`, narrowed to streaming input. Tests substitute a scripted one. */
export type QueryFunction = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AgentQuery;

let loaded: Promise<QueryFunction> | undefined;

/** Load the SDK on first use, so the handshake does not wait for it. */
export function loadQuery(): Promise<QueryFunction> {
	loaded ??= import("@anthropic-ai/claude-agent-sdk").then((sdk) => sdk.query as unknown as QueryFunction);
	return loaded;
}

export const { version: packageVersion } = createRequire(import.meta.url)("../../package.json") as { version: string };

/** The installed Agent SDK's version, read from its manifest. */
export function installedSdkVersion(): string {
	try {
		const path = join(dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk")), "package.json");
		const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof manifest === "object" && manifest !== null && "version" in manifest && typeof manifest.version === "string" ? manifest.version : "unknown";
	} catch {
		return "unknown";
	}
}

/**
 * Variables that would move Claude Code off the claude.ai login and onto an API key,
 * a gateway or a cloud provider, all of which bill per token.
 */
const API_ROUTING = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
];

/** Variables a running Claude Code session sets for its own children; they describe that session, not ours. */
export function apiRoutingReason(env: NodeJS.ProcessEnv): string | undefined {
	const source = API_ROUTING.find(name => env[name]);
	return source && `Claude Code is configured for API use by ${source}, not a Claude plan.`;
}

const PARENT_SESSION = [
	"CLAUDECODE",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_CODE_EXECPATH",
	"CLAUDE_CODE_SESSION_ID",
	"CLAUDE_CODE_CHILD_SESSION",
	"CLAUDE_CODE_SESSION_ATTENDED",
	"CLAUDE_CODE_MESSAGING_SOCKET",
	"CLAUDE_CODE_MESSAGING_TOKEN",
	"CLAUDE_AGENT_SDK_VERSION",
	"CLAUDE_EFFORT",
	"CLAUDE_PID",
];

/**
 * Environment for the Claude Code process: this process's, minus per-token API routing and
 * another session's identity, plus the name this sidecar reports as the calling app.
 */
export function subscriptionEnv(source: NodeJS.ProcessEnv, version: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...source, ...extra };
	for (const name of [...API_ROUTING, ...PARENT_SESSION]) delete env[name];
	env.CLAUDE_AGENT_SDK_CLIENT_APP = `modular-agent-claude-sidecar/${version}`;
	return env;
}

/** User turns for a running query. The SDK needs its input left open while it serves an in-process MCP server. */
export class Inbox implements AsyncIterable<SDKUserMessage> {
	private readonly queue: SDKUserMessage[] = [];
	private wake: (() => void) | undefined;
	private ended = false;

	push(message: SDKUserMessage): void {
		this.queue.push(message);
		this.wake?.();
	}

	end(): void {
		this.ended = true;
		this.wake?.();
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage, void> {
		for (;;) {
			const next = this.queue.shift();
			if (next) yield next;
			else if (this.ended) return;
			else await new Promise<void>((settle) => { this.wake = settle; });
		}
	}
}
