import type {
	Answer,
	CredentialStore,
	ExecResult,
	HandlerOrder,
	InputRequestDraft,
	Plugin,
	PluginApi,
	Provider,
	ToolCall,
	ToolSource,
	WorkingEnvironment,
} from "@modular-agent/harness";
import { fromWire, toWire } from "./translate.js";
import { PLUGIN_BINDING, WireError, WirePeer } from "./wire.js";

export interface ServeOptions {
	/** The plugin's name in its registration. */
	name: string;
	/** Ordinary plugins of this build, to serve as one external plugin. */
	plugins: Plugin[];
	/** What the host leaves out of its own plugins in favour of these. */
	replaces?: string[];
	/** How strongly the working environment, if one is served, keeps "nothing outlives the agent". */
	containment?: "strong" | "processGroup" | "none";
	/** Where messages come from and go to. Defaults to this process's stdin and stdout. */
	input?: NodeJS.ReadableStream;
	output?: (line: string) => void;
}

/**
 * Serve ordinary TypeScript plugins over modular-agent-plugin/1, so a Harness in
 * any language can host them. Each plugin is set up against an API that collects
 * what it provides and the hook points it handles, and reaches the host for the
 * rest. Calls a plugin makes that this binding doesn't carry fail plainly.
 */
export function servePlugins(options: ServeOptions): Promise<void> {
	const write = options.output ?? ((line: string) => process.stdout.write(line));
	const peer = new WirePeer(write);
	const providers: Provider[] = [];
	const toolSources: ToolSource[] = [];
	let environment: WorkingEnvironment | undefined;
	const handlers = new Map<number, { hook: string; handler: (payload: any) => unknown; order: HandlerOrder }>();
	const commands = new Map<string, { description: string; run: (args: string, ctx: any) => unknown }>();
	const stops: (() => unknown)[] = [];
	let nextHandler = 1;
	let initialized = false;

	/** The host's working environment, reached through host/env/*, for a request the host sent. */
	const hostEnvironment = (parentRequestId: number | string, cwd: string): WorkingEnvironment => ({
		id: `host:${cwd}`,
		cwd,
		at: (other: string) => hostEnvironment(parentRequestId, other),
		readFile: async (path) => Buffer.from((await peer.request<{ data: string }>("host/env/read", { parentRequestId, cwd, path })).data, "base64"),
		writeFile: async (path, data) => void (await peer.request("host/env/write", { parentRequestId, cwd, path, data: Buffer.from(data).toString("base64") })),
		exists: async (path) => (await peer.request<{ exists: boolean }>("host/env/exists", { parentRequestId, cwd, path })).exists,
		exec: async (command, o) => {
			const req = peer.request<ExecResult>("host/env/exec", { parentRequestId, cwd, command, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) }, o.signal);
			outputs.set(req.id, (chunk) => o.onOutput?.(chunk));
			try {
				return await req;
			} catch (error) {
				if (o.signal.aborted) return { exitCode: null, output: "", timedOut: false };
				throw error;
			} finally {
				outputs.delete(req.id);
			}
		},
	});
	const outputs = new Map<number, (chunk: string) => void>();
	peer.onNotification("host/env/output", (p) => outputs.get(p?.parentRequestId)?.(String(p.chunk)));

	const unavailable = (what: string) => () => {
		throw new Error(`${what} isn't carried by ${PLUGIN_BINDING}`);
	};

	function apiFor(plugin: Plugin, init: { project: string; home: string; config: Record<string, unknown> }): PluginApi {
		const credentialStore: CredentialStore = {
			read: async (providerId) => (await peer.request<{ credential: unknown }>("host/credentials/read", { provider: providerId })).credential ?? undefined,
			list: async () => [],
			modify: unavailable("Writing credentials") as never,
			delete: unavailable("Deleting credentials") as never,
		};
		const api: Record<string, unknown> = {
			name: plugin.name,
			project: init.project,
			home: init.home,
			config: () => (init.config[plugin.name] as Record<string, unknown> | undefined) ?? init.config,
			projectOf: () => init.project,
			provide: (capability: string, impl: unknown) => {
				if (capability === "provider") providers.push(impl as Provider);
				else if (capability === "tool-source") toolSources.push(impl as ToolSource);
				else if (capability === "working-environment") environment = impl as WorkingEnvironment;
				else throw new Error(`${capability} isn't carried by ${PLUGIN_BINDING}`);
			},
			use: (capability: string) => (capability === "credential-store" ? credentialStore : undefined),
			useAll: () => [],
			on: (hook: string, handler: (payload: any) => unknown, order: HandlerOrder = "normal") => {
				const id = nextHandler++;
				handlers.set(id, { hook, handler, order });
				return () => handlers.delete(id);
			},
			defineHook: unavailable("Defining a hook point"),
			runHook: async (hook: string, payload: unknown) => fromWire(await peer.request("host/hook", { parentRequestId: currentParent, hook, payload: toWire(payload) })),
			reportProblem: (where: string, error: unknown) => peer.notify("host/problem", { where, message: error instanceof Error ? error.message : String(error) }),
			emit: (sessionId: string, type: string, data?: unknown) => peer.notify("host/emit", { sessionId, type, data: toWire(data) }),
			onEvent: () => () => undefined,
			registerCommand: (name: string, command: { description: string; run: (args: string, ctx: any) => unknown }) => commands.set(name, command),
		};
		for (const name of ["commands", "runCommand", "startSession", "openSession", "join", "leave", "listSessions", "forkSession", "closeSession", "session", "input", "withdraw", "cancel", "waitForIdle", "moveTo", "setSetting", "history", "gatedHistory", "append", "transaction", "erase", "tools", "callTool", "ask", "answer", "openRequests", "startJob", "unfinishedJobs", "resumeJob", "jobs", "cancelJob", "follow", "declaration", "modelAccess"]) {
			api[name] = unavailable(`${name}()`);
		}
		return api as unknown as PluginApi;
	}
	// The host request a provider is serving, so its runHook calls name their parent.
	let currentParent: number | string | undefined;

	peer.handle("plugin/initialize", async (p) => {
		if (p.binding !== PLUGIN_BINDING) throw new WireError("not_supported", `This plugin speaks ${PLUGIN_BINDING}, not ${p.binding}`);
		if (initialized) throw new WireError("invalid_request", "Already initialized");
		initialized = true;
		const init = { project: String(p.project), home: String(p.home), config: (p.config ?? {}) as Record<string, unknown> };
		for (const plugin of options.plugins) {
			await plugin.setup(apiFor(plugin, init));
			if (plugin.stop) stops.push(() => plugin.stop!());
		}
		return {
			binding: PLUGIN_BINDING,
			name: options.name,
			...(providers.length ? { providers: providers.map((x) => ({ id: x.id, supports: x.supports, models: toWire(x.models()) })) } : {}),
			...(toolSources.length ? { toolSources: toolSources.map((t) => ({ id: t.id, tools: toWire(t.tools()) })) } : {}),
			...(environment ? { workingEnvironment: { containment: options.containment ?? "none", platforms: [process.platform] } } : {}),
			...(handlers.size ? { hooks: [...handlers].map(([handlerId, h]) => ({ hook: h.hook, handlerId, order: h.order })) } : {}),
			...(commands.size ? { commands: [...commands].map(([name, c]) => ({ name, description: c.description })) } : {}),
			...(options.replaces?.length ? { replaces: options.replaces } : {}),
		};
	});

	const provider = (id: string) => {
		const p = providers.find((x) => x.id === id);
		if (!p) throw new WireError("invalid_request", `No provider ${id}`);
		return p;
	};
	peer.handle("provider/models", async (p) => ({ models: toWire(provider(p.provider).models()) }));
	peer.handle("provider/available", async (p) => ({ available: (await provider(p.provider).available?.()) ?? true }));
	peer.handle("provider/discard", async (p) => (await provider(p.provider).discardState?.(String(p.sessionId)), {}));
	peer.handle("provider/request", async (p, ctx) => {
		currentParent = ctx.id;
		const message = await provider(p.provider).request(p.model, fromWire(p.request), {
			signal: ctx.signal,
			sessionId: p.sessionId,
			onEvent: (event) => peer.notify("provider/event", { parentRequestId: ctx.id, event }),
		});
		return toWire(message);
	});

	const source = (id: string) => {
		const t = toolSources.find((x) => x.id === id);
		if (!t) throw new WireError("invalid_request", `No tool source ${id}`);
		return t;
	};
	peer.handle("tools/list", async (p) => ({ tools: toWire(source(p.toolSource).tools(p.sessionId)) }));
	peer.handle("tools/call", async (p, ctx) => {
		const call = fromWire(p.call) as ToolCall;
		const result = await source(p.toolSource).run(call, {
			sessionId: String(p.sessionId),
			signal: ctx.signal,
			call,
			progress: (content) => peer.notify("tools/progress", { parentRequestId: ctx.id, content: toWire(content) }),
			environment: hostEnvironment(ctx.id, String(p.project)),
			ask: async (request: InputRequestDraft) => fromWire(await peer.request<Answer>("host/ask", { parentRequestId: ctx.id, request: toWire(request) }, ctx.signal)) as Answer,
		});
		return toWire(result);
	});

	const env = () => {
		if (!environment) throw new WireError("not_supported", "This plugin is not a working environment");
		return environment;
	};
	const envAt = (cwd: string) => {
		const e = env();
		return cwd && e.cwd !== cwd && e.at ? (e.at(cwd) as WorkingEnvironment) : e;
	};
	peer.handle("env/read", async (p) => ({ data: (await envAt(p.cwd).readFile(p.path)).toString("base64") }));
	peer.handle("env/write", async (p) => (await envAt(p.cwd).writeFile(p.path, Buffer.from(p.data, "base64")), {}));
	peer.handle("env/exists", async (p) => ({ exists: await envAt(p.cwd).exists(p.path) }));
	peer.handle("env/exec", async (p, ctx) =>
		envAt(p.cwd).exec(String(p.command), { signal: ctx.signal, timeoutMs: p.timeoutMs, onOutput: (chunk) => peer.notify("env/output", { parentRequestId: ctx.id, chunk }) }),
	);

	peer.handle("hook/handle", async (p, ctx) => {
		const h = handlers.get(Number(p.handlerId));
		if (!h) throw new WireError("unknown_handler", `No handler ${p.handlerId}`);
		currentParent = ctx.id;
		const answer = await h.handler(fromWire(p.payload));
		return answer === undefined ? null : toWire(answer);
	});

	peer.handle("command/run", async (p) => {
		const c = commands.get(String(p.name));
		if (!c) throw new WireError("invalid_request", `No command ${p.name}`);
		const output = await c.run(String(p.args ?? ""), { sessionId: p.sessionId, actorId: p.actorId });
		return typeof output === "string" ? { output } : {};
	});

	const shutdown = async () => {
		for (const stop of stops.reverse()) await Promise.resolve(stop()).catch(() => undefined);
		stops.length = 0;
	};
	peer.handle("plugin/shutdown", async () => (await shutdown(), {}));

	const input = options.input ?? process.stdin;
	input.setEncoding?.("utf8");
	return new Promise((resolve) => {
		input.on("data", (chunk: string) => peer.feed(chunk));
		const end = () => {
			peer.close("the host closed the connection");
			void shutdown().then(() => resolve());
		};
		input.on("end", end);
		input.on("close", end);
	});
}
