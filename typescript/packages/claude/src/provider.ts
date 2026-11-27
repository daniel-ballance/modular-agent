import type { ModelEnrollment } from "@modular-agent/subscription";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountInfo, Options, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { PROVIDER_ID, REASONING_LEVELS, type AssistantMessage, type ModelInfo, type ModelRequest, type StreamEvent } from "./data.js";
import { baselineModels, discoveredModels, modelInfo, thinkingFor, type CatalogModel } from "./models.js";
import { Response, errorKind, scrub, stopFor } from "./response.js";
import { Inbox, apiRoutingReason, loadQuery, replayCacheEnabled, subscriptionEnv, type AgentQuery, type QueryFunction } from "./sdk.js";
import { SERVER_NAME, ToolBridge } from "./tools.js";
import { promptBlocks } from "./transcript.js";

export interface ProviderOptions {
	/** This sidecar's version, reported to Anthropic as the calling app. */
	version: string;
	/** Installed Agent SDK version. A catalog another version reported is fetched again. */
	sdkVersion: string;
	/** Substitute for the Agent SDK's `query()`. Tests script it. */
	query?: QueryFunction;
	/** The environment the Claude Code process is started from. */
	env: NodeJS.ProcessEnv;
	/** Whether a Claude Code login can be seen. Defaults to looking at `env` and the config directory. */
	loginVisible?: () => boolean;
	/** Diagnostics, for stderr. Never given a credential. */
	log?: (message: string) => void;
	models?: readonly ModelEnrollment[];
	onChange?: () => void;
	checkApiRouting?: boolean;
}

/** The request was cancelled by the host; there is no assistant message to return. */
export class Cancelled extends Error {
	constructor() {
		super("Request was cancelled");
	}
}

const SIGN_IN = "Run `claude auth login`, sign in with your Claude account, then try again.";
/** The account's model list changes rarely; ask Claude Code again after this long. */
const CATALOG_MAX_AGE_MS = 24 * 60 * 60_000;
/** Deadline for the entire account and model catalog probe. */
const PROBE_MS = 30_000;

/**
 * Where a Claude Code login is visible, without opening any credential file:
 * `CLAUDE_CODE_OAUTH_TOKEN`, then `<CLAUDE_CONFIG_DIR or $HOME/.claude>/.credentials.json`,
 * then on macOS (where the login is in the Keychain) `$HOME/.claude.json`.
 */
export function loginVisible(env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync, platform: NodeJS.Platform = process.platform): boolean {
	if (env.CLAUDE_CODE_OAUTH_TOKEN) return true;
	const directory = env.CLAUDE_CONFIG_DIR || (env.HOME ? join(env.HOME, ".claude") : undefined);
	if (directory && exists(join(directory, ".credentials.json"))) return true;
	return platform === "darwin" && !!env.HOME && exists(join(env.HOME, ".claude.json"));
}

function describe(account: AccountInfo | undefined): string {
	if (account?.apiProvider && account.apiProvider !== "firstParty") return ` (it is using ${account.apiProvider})`;
	if (account?.apiKeySource && account.apiKeySource !== "none") return ` (it is using an API key from ${account.apiKeySource})`;
	return "";
}

/**
 * The Provider: a model catalog, a readiness answer, and `infer`, which makes one model
 * request by starting one Claude Code process, giving it the whole request, and closing it
 * as soon as the model's message is complete. Nothing is kept between requests.
 */
export class ClaudeProvider {
	private readonly baseline: CatalogModel[];
	private models: CatalogModel[];
	private account: AccountInfo | undefined;
	private cwd = process.cwd();
	private home: string | undefined;
	private readonly running = new Set<AgentQuery>();
	private closed = false;

	private checking?: { accountChecked: Promise<void>; done: Promise<void> };
	private probeAbort?: AbortController;

	constructor(private readonly options: ProviderOptions) {
		this.baseline = baselineModels(options.models);
		this.models = structuredClone(this.baseline);
	}

	private log(message: string): void {
		this.options.log?.(message);
	}

	private get query(): Promise<QueryFunction> {
		return this.options.query ? Promise.resolve(this.options.query) : loadQuery();
	}

	project(path: string): void { this.cwd = path; }

	/** Take the project and state folder from `plugin/initialize`, and the catalog kept there if it is current. */
	start(init: { project: string; home: string }): void {
		this.project(init.project);
		this.home = init.home;
		let fresh = false;
		try {
			const stored: unknown = JSON.parse(readFileSync(join(init.home, "catalog.json"), "utf8"));
			const models = storedModels(stored);
			if (models.length) {
				this.models = models;
				const { sdkVersion, checkedAt } = stored as { sdkVersion?: unknown; checkedAt?: unknown };
				fresh = sdkVersion === this.options.sdkVersion && typeof checkedAt === "number" && Date.now() - checkedAt < CATALOG_MAX_AGE_MS;
			}
		} catch {
			// No stored catalog yet, or one that cannot be read: the built-in list stands.
		}
		if (!fresh) void this.refresh();
	}

	catalog(): ModelInfo[] {
		return this.models.map(modelInfo);
	}

	model(id: unknown): CatalogModel | undefined {
		return this.models.find((model) => model.id === id);
	}

	/** Whether requests can be taken: a login is visible and Claude Code has not said it is no subscription. */
	available(): boolean {
		const visible = this.options.loginVisible ? this.options.loginVisible() : loginVisible(this.options.env);
		return visible && !this.routingReason() && (this.account === undefined || this.usesPlan(this.account));
	}

	private routingReason() { return this.options.checkApiRouting ? apiRoutingReason(this.options.env) : undefined; }
	private usesPlan(account?: AccountInfo) { return !!account?.subscriptionType && !describe(account); }

	unavailableReason(): string | undefined {
		return this.routingReason() ?? (!this.usesPlan(this.account) ?
			`Claude Code is not signed in with a Claude subscription${describe(this.account)}. ${SIGN_IN}` : undefined);
	}

	async ready(): Promise<boolean> {
		if (!this.closed && this.account === undefined && this.available()) {
			await this.check().accountChecked;
		}
		return !this.closed && this.available() && this.usesPlan(this.account);
	}

	/** Stop every Claude Code process this Provider started. */
	close(): void {
		this.closed = true;
		this.probeAbort?.abort(new Cancelled());
		for (const query of [...this.running]) query.close();
		this.running.clear();
	}

	/**
	 * Ask Claude Code which models the account offers, without sending a prompt, and narrow
	 * the list to those. Each one's context window is Claude Code's own, which can be smaller
	 * than the API's.
	 */
	refresh(): Promise<void> {
		return this.check().done;
	}

	private check(): NonNullable<ClaudeProvider["checking"]> {
		if (this.checking) return this.checking;
		let checked!: () => void;
		const accountChecked = new Promise<void>((resolve) => { checked = resolve; });
		const done = this.probe(checked).finally(() => {
			checked(); // Also release readiness if the handshake fails or the provider closes.
			this.checking = undefined;
		});
		void done.catch((error) => {
			if (!this.closed) this.log(`The model list was not refreshed: ${scrub(error instanceof Error ? error.message : String(error))}`);
		});
		return this.checking = { accountChecked, done };
	}

	private async probe(accountChecked: () => void): Promise<void> {
		if (!this.available() || this.closed) return;
		const abort = this.probeAbort = new AbortController();
		const { signal } = abort;
		const timer = setTimeout(() => abort.abort(new Error("Claude Code did not answer in time")), PROBE_MS);
		const stopped = new Promise<never>((_, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
		const beforeStop = <T>(run: () => Promise<T>): Promise<T> => {
			signal.throwIfAborted();
			return Promise.race([stopped, run()]);
		};
		const inbox = new Inbox();
		let query: AgentQuery | undefined;
		try {
			const start = await beforeStop(() => this.query);
			signal.throwIfAborted();
			const active = query = start({
				prompt: inbox,
				options: {
					cwd: this.cwd,
					env: subscriptionEnv(this.options.env, this.options.version),
					tools: [],
					settingSources: [],
					strictMcpConfig: true,
					persistSession: false,
				},
			});
			this.running.add(active);
			const { account, models: reported } = await beforeStop(() => active.initializationResult());
			signal.throwIfAborted();
			this.account = account ?? {};
			accountChecked();
			if (!this.usesPlan(account)) return;

			// Make newly discovered models usable before asking for their windows.
			const previous = new Map(this.models.map((model) => [model.id, model.contextWindow]));
			const found = discoveredModels(reported ?? [], this.baseline).map((model) => ({
				...model, contextWindow: previous.get(model.id) ?? model.contextWindow,
			}));
			if (!found.length) return;
			this.models = found;
			this.options.onChange?.();
			for (const model of found) {
				let window: number;
				try {
					await beforeStop(() => active.setModel(model.id));
					window = (await beforeStop(() => active.getContextUsage({ detail: "summary" }))).rawMaxTokens;
				} catch {
					signal.throwIfAborted();
					// Keep the previous window if Claude Code would not describe this model.
					continue;
				}
				signal.throwIfAborted();
				if (window > 0 && window !== model.contextWindow) {
					model.contextWindow = window;
					this.options.onChange?.();
				}
			}
			signal.throwIfAborted();
			this.log(`Claude Code reported ${found.length} models for this account.`);
			if (this.home) {
				try {
					mkdirSync(this.home, { recursive: true });
					writeFileSync(join(this.home, "catalog.json"), JSON.stringify({ sdkVersion: this.options.sdkVersion, checkedAt: Date.now(), models: found }, null, "\t"));
				} catch {
					// The list still applies to this process.
				}
			}
		} finally {
			clearTimeout(timer);
			this.probeAbort = undefined;
			inbox.end();
			if (query && this.running.delete(query)) query.close();
		}
	}

	/** The options of the one Claude Code process a request gets. */
	queryOptions(model: CatalogModel, request: ModelRequest, bridge: ToolBridge, stderr: (data: string) => void, hasReplayBreakpoint: boolean): Options {
		const cap = request.settings.maxOutput;
		const capped = typeof cap === "number" && Number.isSafeInteger(cap) && cap > 0 ? Math.min(cap, model.maxOutput) : undefined;
		const level = REASONING_LEVELS.find(level => level === request.settings.reasoning);
		const thinking = thinkingFor(model, level, capped);
		const env = subscriptionEnv(this.options.env, this.options.version, capped ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(capped) } : {});
		// The pinned CLI still forwards our explicit breakpoint with its own caching disabled.
		// This avoids TTL ordering errors and leaves room under the API's four-breakpoint limit.
		if (hasReplayBreakpoint) env.DISABLE_PROMPT_CACHING = "1";
		return {
			model: model.id,
			cwd: this.cwd,
			env,
			// The host's system prompt replaces Claude Code's; the host's tools are the only tools.
			systemPrompt: request.systemPrompt,
			tools: [],
			mcpServers: request.tools.length ? { [SERVER_NAME]: bridge.config } : {},
			strictMcpConfig: true,
			// The host gates its own tools. Nothing else is offered, and anything else would be denied.
			allowedTools: request.tools.length ? bridge.allowedTools : [],
			toolAliases: bridge.aliases,
			permissionMode: "default",
			permissionPrompts: "none",
			// No user or project Claude Code configuration: hooks, memory files, skills and MCP servers stay out.
			settingSources: [],
			settings: {
				// The host compacts its own history; a second compaction here would hide history from it.
				autoCompactEnabled: false,
				idleCompaction: false,
				// Claude Code's memory directory is not a settings source, so it is switched off by name.
				autoMemoryEnabled: false,
				// The skills that ship with Claude Code are removed, not only left without a tool to run them.
				disableBundledSkills: true,
			},
			// No skill is listed to the model.
			skills: [],
			// Nothing about the conversation is written to disk.
			persistSession: false,
			// A given title spares the model call that would otherwise name the session.
			title: "Modular Agent",
			// Deliver the host's text as written, without slash-command or @file handling.
			verbatimPrompts: true,
			includePartialMessages: true,
			...(thinking.thinking ? { thinking: thinking.thinking } : {}),
			...(thinking.effort ? { effort: thinking.effort } : {}),
			stderr,
		};
	}

	/**
	 * One model request. Returns the assistant message, with `stop: "failed"` and an error
	 * for anything the model service or Claude Code got wrong. Throws `Cancelled` when the
	 * host cancelled.
	 */
	async infer(model: CatalogModel, request: ModelRequest, signal: AbortSignal, emit: (event: StreamEvent) => void): Promise<AssistantMessage> {
		const bridge = new ToolBridge(request.tools);
		const response = new Response({ provider: PROVIDER_ID, id: model.id }, emit, (name) => bridge.hostName(name));
		const inbox = new Inbox();
		let stderr = "";
		let query: AgentQuery | undefined;
		let cancel: (() => void) | undefined;
		const cancelled = new Promise<never>((_, reject) => {
			cancel = () => reject(new Cancelled());
		});
		cancelled.catch(() => {});
		signal.addEventListener("abort", cancel!, { once: true });
		try {
			if (signal.aborted) throw new Cancelled();
			const routing = this.routingReason();
			if (routing) return response.finish("failed", { kind: "credentials", message: routing });
			const start = await this.query;
			if (signal.aborted || this.closed) throw new Cancelled();
			const blocks = promptBlocks(request, replayCacheEnabled(this.options.env, model.id));
			const options = this.queryOptions(model, request, bridge, (data) => { stderr = (stderr + data).slice(-2_000); },
				blocks.some(block => block.cache_control));
			query = start({ prompt: inbox, options });
			this.running.add(query);
			const messages = query[Symbol.asyncIterator]();
			// The login is Claude Code's own; refuse anything that is not a subscription before sending a prompt.
			const { account } = await Promise.race([cancelled, query.initializationResult()]);
			this.account = account ?? {};
			if (!this.usesPlan(account)) {
				return response.finish("failed", { kind: "credentials", message: `Claude Code is not signed in with a Claude subscription${describe(account)}. ${SIGN_IN}` });
			}
			inbox.push({ type: "user", message: { role: "user", content: blocks }, parent_tool_use_id: null, uuid: randomUUID() });
			let failure: { name: string; text: string } | undefined;
			for (;;) {
				const next = await Promise.race([cancelled, messages.next()]);
				if (next.done) throw new Error(`Claude Code exited before the turn finished.${stderr ? ` ${stderr.trim()}` : ""}`);
				const message = next.value;
				if (message.type === "system" && message.subtype === "init") {
					this.log(`Claude Code ${message.claude_code_version} started: model ${message.model}; tools [${message.tools.join(", ")}]; MCP servers [${message.mcp_servers.map((s) => `${s.name}:${s.status}`).join(", ")}]; agents [${(message.agents ?? []).join(", ")}]; skills [${message.skills.join(", ")}]; plugins [${message.plugins.map((p) => p.name).join(", ")}].`);
				} else if (message.type === "stream_event") {
					if (message.parent_tool_use_id !== null) continue;
					if (message.event.type === "content_block_start") this.log(`Claude sent a ${message.event.content_block.type} block.`);
					// The model asked for tools. The message is complete, so the request ends here; the host runs them.
					if (response.apply(message.event) && response.rawStopReason === "tool_use" && response.calledTools.length) {
						return response.finish("toolUse");
					}
				} else if (message.type === "assistant") {
					// Claude Code reports a failed request as a synthetic message; its text is the error.
					if (message.error && message.parent_tool_use_id === null) {
						const text = message.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
						failure = { name: message.error, text: text || `Claude request failed: ${message.error}` };
					}
				} else if (message.type === "result") {
					this.learn(message);
					if (message.is_error || message.subtype !== "success") {
						let text = failure?.text || (message.subtype === "success" ? message.result : message.errors.join("; ")) || "Claude Code reported an error";
						if (failure?.name === "authentication_failed") text += ` ${SIGN_IN}`;
						return response.finish("failed", { kind: errorKind(failure?.name, text), message: scrub(text) });
					}
					const stop = stopFor(response.rawStopReason);
					return response.finish(stop, stop === "refused" ? { kind: "refused", message: "The model refused to complete the request." } : undefined);
				}
			}
		} catch (error) {
			if (error instanceof Cancelled || signal.aborted) throw new Cancelled();
			const text = error instanceof Error ? error.message : String(error);
			return response.finish("failed", { kind: errorKind(undefined, text), message: scrub(text) });
		} finally {
			signal.removeEventListener("abort", cancel!);
			inbox.end();
			bridge.close();
			if (query) {
				query.close();
				this.running.delete(query);
			}
			if (bridge.held) this.log(`Claude Code tried ${bridge.held} tool call(s) before the request ended; none ran.`);
		}
	}

	/** Take a model's real context window from Claude Code's accounting of a finished turn. */
	private learn(result: SDKResultMessage): void {
		for (const [id, usage] of Object.entries(result.modelUsage ?? {})) {
			const model = this.models.find((candidate) => candidate.id === id);
			if (model && usage.contextWindow > 0 && usage.contextWindow !== model.contextWindow) {
				model.contextWindow = usage.contextWindow;
				this.options.onChange?.();
			}
		}
	}
}

/** Catalog models read back from the state folder; anything that is not one is dropped. */
function storedModels(stored: unknown): CatalogModel[] {
	const list = typeof stored === "object" && stored !== null && "models" in stored && Array.isArray(stored.models) ? stored.models : [];
	return list.filter((m: unknown): m is CatalogModel => {
		if (typeof m !== "object" || m === null) return false;
		const model = m as Record<string, unknown>;
		return typeof model.id === "string" && !!model.id && typeof model.name === "string"
			&& Number.isSafeInteger(model.contextWindow) && (model.contextWindow as number) > 0
			&& Number.isSafeInteger(model.maxOutput) && (model.maxOutput as number) > 0
			&& typeof model.adaptive === "boolean"
			&& Array.isArray(model.thinking) && model.thinking.every((level) => REASONING_LEVELS.includes(level as never));
	});
}
