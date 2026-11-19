import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { interruptedCalls, lowerReasoning, pendingToolCalls, restoreAnsweredStep } from "@modular-agent/harness";
import type {
	Answer,
	AssistantMessage,
	HistoryEntry,
	InterruptedTurn,
	ModelRequest,
	Runtime,
	RuntimeHost,
	ToolResult,
	TurnInput,
	TurnOutcome,
	CredentialStore,
	DirEntry,
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
import { listDirectory, notFoundAsEnoent, optionalMethod, PLUGIN_BINDING, WireError, WirePeer } from "./wire.js";

export interface ServeOptions {
	/** The plugin's name in its registration. */
	name: string;
	/** Pass the whole initialize config to a single plugin. */
	directConfig?: boolean;
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

async function validateResume(input: TurnInput, host: RuntimeHost, interrupted: InterruptedTurn, runtime: Runtime) {
	const invalid = () => new WireError("invalid_request", "Interrupted turn does not match its checkpoint");
	if (interrupted?.turnId !== input.turnId || !Array.isArray(interrupted.calls)) throw invalid();
	const branch = await host.history();
	const kept = await host.history({ all: true });
	let lastStep;
	try { lastStep = restoreAnsweredStep(branch, input.turnId, kept)?.lastStep; }
	catch { throw invalid(); }
	if (!isDeepStrictEqual(lastStep, interrupted.lastStep)) throw invalid();
	const settled = new Set(kept.filter((e) => e.kind === "toolResult").map((e) => e.toolCallId));
	const pending = new Set(pendingToolCalls(branch, input.turnId, kept));
	const expected = interruptedCalls(branch, input.turnId).filter((c) => !settled.has(c.id) && !pending.has(c.id));
	if (expected.length !== interrupted.calls.length || expected.some((c, i) => {
		const sent = interrupted.calls[i];
		return !sent || !runtime.supports.continuesAfterRestart || c.started && (!c.safeToRepeat || sent.safeToRepeat !== true) ||
			c.started !== sent.started || c.id !== sent.id || c.name !== sent.name || c.stepId !== sent.stepId || !isDeepStrictEqual(c.input, sent.input);
	})) throw invalid();
}

/**
 * Serve ordinary TypeScript plugins over modular-agent-plugin/1, so a Harness in
 * any language can host them. Each plugin is set up against an API that collects
 * what it provides and the hook points it handles, and reaches the host for the
 * rest. Calls a plugin makes that this binding doesn't carry fail plainly.
 */
export function servePlugins(options: ServeOptions): Promise<void> {
	const write = options.output ?? ((line: string) => process.stdout.write(line));
	let closed = () => {};
	const peer = new WirePeer(write, () => closed());
	const providers: Provider[] = [];
	const toolSources: ToolSource[] = [];
	let environment: WorkingEnvironment | undefined;
	let runtime: Runtime | undefined;
	const handlers = new Map<number, { hook: string; handler: (payload: any, work?: unknown) => unknown; order: HandlerOrder }>();
	const commands = new Map<string, { description: string; run: (args: string, ctx: any) => unknown }>();
	const stops: (() => unknown)[] = [];
	let nextHandler = 1;
	let initialized = false;

	/** The host's working environment, reached through host/env/*, for a request the host sent. */
	const hostEnvironment = (parentRequestId: number | string, cwd: string, sessionId: string): WorkingEnvironment => ({
		id: `host:${cwd}`,
		cwd,
		at: (other: string) => hostEnvironment(parentRequestId, other, sessionId),
		readFile: async (path) => {
			try {
				return Buffer.from((await peer.request<{ data: string }>("host/env/read", { parentRequestId, cwd, sessionId, path })).data, "base64");
			} catch (error) {
				throw notFoundAsEnoent(error, path);
			}
		},
		writeFile: async (path, data) => void (await peer.request("host/env/write", { parentRequestId, cwd, sessionId, path, data: Buffer.from(data).toString("base64") })),
		list: async path => (await peer.request<{ entries: DirEntry[] }>("host/env/list", { parentRequestId, cwd, sessionId, path }).catch(optionalMethod)).entries,
		exists: async (path) => (await peer.request<{ exists: boolean }>("host/env/exists", { parentRequestId, cwd, sessionId, path })).exists,
		exec: async (command, o) => {
			const req = peer.request<ExecResult>("host/env/exec", { parentRequestId, cwd, sessionId, command, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) }, o.signal);
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
			config: () => options.directConfig ? init.config : (init.config[plugin.name] as Record<string, unknown> | undefined) ?? init.config,
			projectOf: () => init.project,
			provide: (capability: string, impl: unknown) => {
				if (capability === "provider") providers.push(impl as Provider);
				else if (capability === "tool-source") {
					const source = impl as ToolSource;
					toolSources.push(source);
					const off = source.onChange?.(() => peer.notify("tools/changed", { toolSource: source.id, parentRequestId: currentParent.getStore() }));
					if (off) stops.push(off);
				}
				else if (capability === "working-environment") environment = impl as WorkingEnvironment;
				else if (capability === "runtime") runtime = impl as Runtime;
				else throw new Error(`${capability} isn't carried by ${PLUGIN_BINDING}`);
			},
			use: (capability: string) => (capability === "credential-store" ? credentialStore : undefined),
			useAll: () => [],
			on: (hook: string, handler: (payload: any, work?: unknown) => unknown, order: HandlerOrder = "normal") => {
				const id = nextHandler++;
				handlers.set(id, { hook, handler, order });
				return () => handlers.delete(id);
			},
			defineHook: unavailable("Defining a hook point"),
			runHook: async (hook: string, payload: unknown) => {
				const answer = fromWire(await peer.request("host/hook", { parentRequestId: currentParent.getStore(), hook, payload: toWire(payload) }));
				return answer;
			},
			reportProblem: (where: string, error: unknown) => peer.notify("host/problem", { where, message: error instanceof Error ? error.message : String(error) }),
			emit: (sessionId: string, type: string, data?: unknown) => peer.notify("host/emit", { sessionId, type, data: toWire(data) }),
			onEvent: () => () => undefined,
			registerCommand: (name: string, command: { description: string; run: (args: string, ctx: any) => unknown }) => commands.set(name, command),
		};
		for (const name of ["presentActors", "releaseInput", "recoveredInput", "commands", "runCommand", "startSession", "openSession", "join", "leave", "listSessions", "forkSession", "closeSession", "session", "input", "withdraw", "cancel", "waitForIdle", "moveTo", "setSetting", "history", "gatedHistory", "append", "transaction", "erase", "tools", "callTool", "ask", "answer", "openRequests", "startJob", "unfinishedJobs", "resumeJob", "jobs", "cancelJob", "follow", "declaration", "modelAccess"]) {
			api[name] = unavailable(`${name}()`);
		}
		return api as unknown as PluginApi;
	}
	// The host request a provider is serving, so its runHook calls name their parent.
	const currentParent = new AsyncLocalStorage<number | string>();

	peer.handle("plugin/initialize", async (p) => {
		if (p.binding !== PLUGIN_BINDING) throw new WireError("not_supported", `This plugin speaks ${PLUGIN_BINDING}, not ${p.binding}`);
		if (initialized) throw new WireError("invalid_request", "Already initialized");
		initialized = true;
		const init = { project: String(p.project), home: String(p.home), config: (p.config ?? {}) as Record<string, unknown> };
		for (const plugin of options.plugins) {
			await plugin.setup(apiFor(plugin, init));
			if (plugin.stop) stops.push(() => plugin.stop!());
		}
		const { inputDuringTurn, waitingThroughRestart, continuesAfterRestart } = runtime?.supports ?? {};
		return {
			binding: PLUGIN_BINDING,
			name: options.name,
			...(providers.length ? { providers: providers.map((x) => ({ id: x.id, supports: x.supports, models: toWire(x.models()) })) } : {}),
			...(toolSources.length ? { toolSources: toolSources.map((t) => ({ id: t.id, tools: toWire(t.tools()) })) } : {}),
			...(environment ? { workingEnvironment: { containment: environment.containment ?? options.containment ?? "none", platforms: [process.platform], ...(environment.points && environment.save && environment.hasPoint && environment.restore ? { points: true } : {}), ...(environment.confinesFiles === true ? { confinesFiles: true } : {}) } } : {}),
			...(runtime ? { runtime: { id: runtime.id, supports: { inputDuringTurn, waitingThroughRestart, continuesAfterRestart } } } : {}),
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
	peer.handle("provider/discard", async (p) => (await provider(p.provider).discardState?.(String(p.sessionId), p.erase === true ? { erase: true, entryIds: p.entryIds } : undefined)) ?? {});
	peer.handle("provider/request", async (p, ctx) => {
		const impl = provider(p.provider);
		if (p.model?.provider !== impl.id || !impl.models().some((m) => m.id === p.model.id) ||
			(impl.supports.keepsState && !p.sessionId)) throw new WireError("invalid_request", "Invalid model or session");
		const scope = { provider: impl.id, model: p.model, sessionId: p.sessionId ?? null };
		const prepared = await peer.request<{ request: unknown }>("host/hook", {
			parentRequestId: ctx.id, hook: "provider.request", payload: { ...scope, request: p.request },
		}, ctx.signal);
		const checkCancelled = () => {
			if (ctx.signal.aborted) throw new WireError("cancelled", "Provider request cancelled");
		};
		checkCancelled();
		const request = fromWire(prepared.request) as ModelRequest;
		const modelInfo = impl.models().find(m => m.id === p.model.id);
		request.settings = { ...request.settings, reasoning: lowerReasoning(request.settings?.reasoning, modelInfo) };
		let message: unknown;
		try {
			message = toWire(await currentParent.run(ctx.id, () => impl.request(p.model, request, {
				signal: ctx.signal,
				sessionId: p.sessionId,
				requestPrepared: true,
				onEvent: (event) => { if (!ctx.signal.aborted) peer.notify("provider/event", { parentRequestId: ctx.id, event }); },
			})));
		} catch (error) {
			checkCancelled();
			throw error;
		}
		checkCancelled();
		await peer.request("host/hook", { parentRequestId: ctx.id, hook: "provider.response", payload: { ...scope, message } });
		return message;
	});

	const source = (id: string) => {
		const t = toolSources.find((x) => x.id === id);
		if (!t) throw new WireError("invalid_request", `No tool source ${id}`);
		return t;
	};
	peer.handle("tools/list", async (p) => ({ tools: toWire(source(p.toolSource).tools(p.sessionId)) }));
	peer.handle("tools/call", async (p, ctx) => {
		const call = fromWire(p.call) as ToolCall;
		const result = await currentParent.run(ctx.id, () => source(p.toolSource).run(call, {
			sessionId: String(p.sessionId),
			signal: ctx.signal,
			call,
			progress: (content) => peer.notify("tools/progress", { parentRequestId: ctx.id, content: toWire(content) }),
			environment: hostEnvironment(ctx.id, String(p.project), String(p.sessionId)),
			tools: {
				list: async () => fromWire((await peer.request("host/tools/list", { parentRequestId: ctx.id }, ctx.signal).catch(optionalMethod)).tools),
				call: async (name, input, signal) => fromWire(await peer.request("host/tools/call", { parentRequestId: ctx.id, name, input: toWire(input) },
					signal ? AbortSignal.any([ctx.signal, signal]) : ctx.signal).catch(optionalMethod)),
			},
			ask: async (request: InputRequestDraft) => fromWire(await peer.request<Answer>("host/ask", { parentRequestId: ctx.id, request: toWire(request) }, ctx.signal)) as Answer,
		}));
		return toWire(result);
	});

	const env = () => {
		if (!environment) throw new WireError("not_supported", "This plugin is not a working environment");
		return environment;
	};
	const envAt = async ({ cwd, sessionId }: { cwd: string; sessionId: string }) => {
		if (typeof sessionId !== "string" || !sessionId) throw new WireError("invalid_request", "A session is required");
		const base = env();
		const e = await base.forSession?.(sessionId) ?? base;
		return cwd && e.cwd !== cwd && e.at ? (e.at(cwd) as WorkingEnvironment) : e;
	};
	const missing = (error: unknown) => ((error as NodeJS.ErrnoException)?.code === "ENOENT" ? new WireError("not_found", `No file ${(error as NodeJS.ErrnoException).path ?? ""}`) : error);
	peer.handle("env/read", async (p) => {
		try {
			return { data: (await (await envAt(p)).readFile(p.path)).toString("base64") };
		} catch (error) {
			throw missing(error);
		}
	});
	peer.handle("env/write", async (p) => (await (await envAt(p)).writeFile(p.path, Buffer.from(p.data, "base64")), {}));
	peer.handle("env/list", async p => listDirectory(await envAt(p), p.path));
	peer.handle("env/exists", async (p) => ({ exists: await (await envAt(p)).exists(p.path) }));
	peer.handle("env/save", async (p) => {
		const e = await envAt(p);
		if (!e.points || !e.save) throw new WireError("not_supported", "This environment does not save points");
		return { point: await e.save() };
	});
	peer.handle("env/checkPoint", async (p) => {
		if (typeof p?.cwd !== "string" || !p.cwd || typeof p.point !== "string" || !p.point) throw new WireError("invalid_request", "Invalid point scope");
		const e = await envAt(p);
		if (!e.points || !e.hasPoint) throw new WireError("not_supported", "This environment does not check points");
		return { exists: await e.hasPoint(p.point) };
	});
	peer.handle("env/restore", async (p) => {
		const e = await envAt(p);
		if (!e.points || !e.restore) throw new WireError("not_supported", "This environment does not restore points");
		try { await e.restore(p.point); }
		catch (error) { throw missing(error); }
		return {};
	});
	peer.handle("env/exec", async (p, ctx) => {
		const env = await envAt(p);
		ctx.signal.throwIfAborted();
		const result = await env.exec(String(p.command), { signal: ctx.signal, timeoutMs: p.timeoutMs,
			onOutput: (chunk) => { if (!ctx.signal.aborted) peer.notify("env/output", { parentRequestId: ctx.id, chunk }); } });
		ctx.signal.throwIfAborted();
		return result;
	});

	peer.handle("env/sessionEnded", async (p) => {
		if (typeof p.sessionId !== "string" || !p.sessionId) throw new WireError("invalid_request", "A session is required");
		await env().sessionEnded?.(p.sessionId);
		return {};
	});

	const work = (ctx: { id: number | string; signal: AbortSignal }, sessionId: string) => ({
		signal: ctx.signal,
		history: (after?: string) => peer.request("host/history", { parentRequestId: ctx.id, sessionId, after, limit: 100, all: true }, ctx.signal),
		emit: (type: string, data: unknown) => peer.notify("host/emit", { parentRequestId: ctx.id, sessionId, type, data }),
	});
	peer.handle("hook/handle", async (p, ctx) => {
		const h = handlers.get(Number(p.handlerId));
		if (!h || h.hook !== p.hook) throw new WireError("unknown_handler", `No handler ${p.handlerId}`);
		const answer = await currentParent.run(ctx.id, () => h.handler(fromWire(p.payload), work(ctx, p.payload?.sessionId)));
		if (h.hook === "output") {
			const gate = answer as import("@modular-agent/harness").OutputAnswer;
			if (gate?.action === "pass") return gate.events ? { events: toWire(gate.events) } : null;
			if (gate?.action === "block" || gate?.action === "hold") return { block: true };
		}
		return answer === undefined ? null : toWire(answer);
	});

	peer.handle("command/run", async (p, ctx) => {
		const c = commands.get(String(p.name));
		if (!c) throw new WireError("invalid_request", `No command ${p.name}`);
		const output = await currentParent.run(ctx.id, () => c.run(String(p.args ?? ""), { sessionId: p.sessionId, actorId: p.actorId, ...work(ctx, p.sessionId) }));
		return typeof output === "string" ? { output } : {};
	});

	// ---------- the Runtime: a turn is one host request; everything it needs comes through host/runtime/* ----------
	const modelEvents = new Map<number, (event: any) => void>();
	peer.onNotification("host/runtime/modelEvent", (p) => modelEvents.get(p?.parentRequestId)?.(p.event));
	const turnFor = (p: any, ctx: { signal: AbortSignal; id: number | string }): { input: TurnInput; host: RuntimeHost } => {
		const parentRequestId = ctx.id;
		const t = p.turn ?? {};
		const call = <T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal) => peer.request<T>(method, { parentRequestId, ...params }, signal);
		let currentStep: string | undefined;
		const input: TurnInput = {
			sessionId: String(t.sessionId),
			turnId: String(t.turnId),
			startedBy: t.startedBy,
			settings: t.settings ?? {},
			resultShape: t.resultShape,
			model: {
				model: fromWire(t.model),
				supports: t.modelSupports ?? {},
				request: async (request: ModelRequest, opts) => {
					const req = call<AssistantMessage>("host/runtime/model", { request: toWire(request), ...((opts.stepId ?? currentStep) ? { stepId: opts.stepId ?? currentStep } : {}) }, opts.signal);
					modelEvents.set(req.id, (event) => opts.onEvent?.(event));
					try {
						return fromWire(await req) as AssistantMessage;
					} catch (error) {
						throw error;
					} finally {
						modelEvents.delete(req.id);
					}
				},
			},
		};
		const host: RuntimeHost = {
			hostSettlesTools: true,
			newId: async () => (await call<{ id: string }>("host/runtime/newId")).id,
			prepareStep: async (info) => {
				currentStep = info.stepId;
				return fromWire(await call("host/runtime/prepareStep", { stepId: info.stepId, usage: info.usage })) as ModelRequest;
			},
			hook: async (hook, payload) => fromWire(await call("host/runtime/hook", { hook, payload: toWire(payload) })),
			runToolCall: async (c, signal) => fromWire(await call("host/runtime/runToolCall", { call: toWire(c) }, signal)) as ToolResult,
			definition: async (toolName) => fromWire(await call("host/runtime/definition", { toolName })) ?? undefined,
			record: async (entry) => {
				const { turnId: _t, ...rest } = entry as Record<string, unknown>;
				return fromWire(await call("host/runtime/record", { entry: toWire(rest) })) as HistoryEntry;
			},
			history: async (options) => {
				const entries: HistoryEntry[] = [];
				let after: string | undefined;
				do {
					const page: { entries: HistoryEntry[]; next?: string } = await call("host/history", { sessionId: input.sessionId, after, all: options?.all });
					entries.push(...fromWire(page.entries));
					after = page.next ?? undefined;
				} while (after);
				return entries;
			},
			takeSteering: async (final) => fromWire((await call<{ entries: unknown[] }>("host/runtime/takeSteering", final ? { final } : {})).entries) as HistoryEntry[],
			hasSteering: async () => (await call<{ waiting: boolean }>("host/runtime/hasSteering")).waiting,
			report: (type, data, ids) => {
				if (!["step.started", "step.ended", "model.output", "tool.result", "tool.open"].includes(type)) peer.notify("host/runtime/report", { parentRequestId, type: `${runtime?.id}.${type}`, data: toWire(data), ...(ids ?? {}) });
			},
		};
		return { input, host };
	};
	const needRuntime = () => {
		if (!runtime) throw new WireError("not_supported", "This plugin is not a Runtime");
		return runtime;
	};
	const outcome = (o: TurnOutcome) => toWire(o);
	peer.handle("runtime/runTurn", async (p, ctx) => {
		const { input, host } = turnFor(p, ctx);
		return outcome(await needRuntime().runTurn(input, host, ctx.signal));
	});
	peer.handle("runtime/resumeTurn", async (p, ctx) => {
		const { input, host } = turnFor(p, ctx);
		const interrupted = fromWire(p.interrupted) as InterruptedTurn;
		await validateResume(input, host, interrupted, needRuntime());
		return outcome(await needRuntime().resumeTurn(input, host, ctx.signal, interrupted));
	});
	peer.handle("runtime/continueOpenCalls", async (p, ctx) => {
		const { input, host } = turnFor(p, ctx);
		return outcome(await needRuntime().continueOpenCalls(input, host, ctx.signal, fromWire(p.calls) as InterruptedTurn["calls"]));
	});

	const shutdown = async () => {
		for (const stop of stops.reverse()) await Promise.resolve(stop()).catch(() => undefined);
		stops.length = 0;
	};
	peer.handle("plugin/shutdown", async () => (await shutdown(), {}));

	const input = options.input ?? process.stdin;
	return new Promise((resolve) => {
		closed = () => { input.pause?.(); void shutdown().then(() => resolve()); };
		input.on("data", (chunk: Buffer | string) => peer.feed(chunk));
		const end = () => peer.close("the host closed the connection");
		input.on("end", end);
		input.on("close", end);
	});
}
