import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Plugin, PluginApi, Provider, ToolDefinition, ToolSource } from "@modular-agent/harness";
import { lines, Peer, type RootMethods } from "./peer.js";

/** Plugin API calls that wait for an answer anyway, so they cross the connection unchanged. */
export const ASYNC_API = [
	"runHook", "startSession", "openSession", "join", "leave", "listSessions", "forkSession", "closeSession", "input", "cancel",
	"waitForIdle", "moveTo", "setSetting", "append", "transaction", "erase", "callTool", "ask", "runCommand", "cancelJob", "gatedHistory",
] as const;

/** Capabilities a plugin in another process may ask for at setup. */
const KNOWN_CAPABILITIES = ["configuration", "credential-store", "history-store", "working-environment", "provider", "runtime", "tool-source", "interface", "mcp-servers"];

/**
 * A plugin that runs in another process. The Harness sees an ordinary plugin;
 * the real one runs in a child process and reaches the plugin API over JSON-RPC.
 *
 * Two capabilities are answered from a copy kept here, because the Harness asks
 * them without waiting: a tool source's list of tools, which the contracts let a
 * tool source announce when it changes, and a Provider's list of models.
 */
export function remotePlugin(plugin: Pick<Plugin, "name" | "spawn" | "replaces" | "origin">): Plugin {
	const spec = plugin.spawn;
	if (!spec) throw new Error(`${plugin.name} doesn't say how to load it in another process`);
	let peer: Peer | undefined;
	let child: ReturnType<typeof spawn> | undefined;
	let exited: Promise<void> = Promise.resolve();
	return {
		name: plugin.name,
		replaces: plugin.replaces,
		origin: plugin.origin,
		spawn: spec,
		async setup(api) {
			const host = fileURLToPath(new URL("./host.js", import.meta.url));
			child = spawn(process.execPath, [host], { stdio: ["pipe", "pipe", "inherit"] });
			const proc = child;
			exited = new Promise((resolve) => proc.on("exit", () => resolve()));
			const copies = new Copies();
			const unsubscribe = new Map<unknown, () => void>();
			const root: RootMethods = {
				provide: (capability: string, impl: unknown) => api.provide(capability, adapt(api, capability, impl, copies)),
				useCall: (capability: string, index: number, method: string, args: unknown[]) => {
					const impl = api.useAll<Record<string, (...a: unknown[]) => unknown>>(capability)[index];
					if (!impl) throw new Error(`No ${capability} is provided`);
					return impl[method](...args);
				},
				defineHook: (name: string, rule: never) => api.defineHook(name, rule),
				on: (hook: string, handler: (p: unknown) => unknown, order?: never) => unsubscribe.set(handler, api.on(hook, handler, order)),
				onEvent: (listener: never, options?: never) => unsubscribe.set(listener, api.onEvent(listener, options)),
				follow: (sessionId: string, options: never, listener: never) => unsubscribe.set(listener, api.follow(sessionId, options, listener)),
				off: (handler: unknown) => {
					unsubscribe.get(handler)?.();
					unsubscribe.delete(handler);
				},
				emit: (sessionId: string, type: string, data?: unknown, ids?: never) => api.emit(sessionId, type, data, ids),
				registerCommand: (name: string, command: never) => api.registerCommand(name, command),
				reportProblem: (where: string, error: unknown) => api.reportProblem(where, error),
			};
			for (const name of ASYNC_API) root[name] = (...args: unknown[]) => (api[name] as (...a: unknown[]) => unknown)(...args);
			// Like a plugin in the same process, one in another process keeps the agent running only while the agent waits on it.
			const handles = [proc, proc.stdin, proc.stdout] as unknown as { ref?(): void; unref?(): void }[];
			const keepAlive = (waiting: boolean) => handles.forEach((h) => (waiting ? h.ref?.() : h.unref?.()));
			peer = new Peer((line) => proc.stdin!.write(line + "\n"), root, keepAlive);
			keepAlive(false);
			const p = peer;
			lines(proc.stdout!, (line) => p.receive(line), () => p.close(new Error(`The process running ${plugin.name} ended`)));
			// A child that dies first breaks the pipe: that ends the connection, it doesn't crash this process.
			proc.stdin!.on("error", () => p.close(new Error(`The process running ${plugin.name} ended`)));
			proc.on("exit", (code, signal) => {
				p.close(new Error(`The process running ${plugin.name} ended`));
				if (code !== 0 && signal !== "SIGTERM") api.reportProblem("process", new Error(`exited with ${signal ?? code}`));
			});
			await peer.request("setup", {
				module: spec.module,
				export: spec.export,
				options: spec.options,
				name: api.name,
				project: api.project,
				home: api.home,
				config: api.config(),
				capabilities: KNOWN_CAPABILITIES.filter((c) => api.useAll(c).length).map((c) => [c, api.useAll(c).length]),
			});
			// Anything that changed while it set up is in the copies before the Harness carries on.
			await copies.refreshAll();
		},
		async stop() {
			if (!peer || !child) return;
			await peer.request("stop").catch(() => undefined);
			// Close the connection before its stream: an answer still being worked out then has nowhere to go.
			peer.close(new Error(`${plugin.name} stopped`));
			child.stdin?.end();
			const timer = setTimeout(() => child?.kill("SIGTERM"), 2000);
			await exited;
			clearTimeout(timer);
		},
	};
}

/**
 * The copies kept of a remote plugin's lists, and the refreshes still running.
 * The plugin announces a change before it answers the call that caused it, so a
 * call into the plugin ends only once the refreshes it set off have ended. The
 * Harness then never sees a list older than what it has just done.
 */
class Copies {
	private running = new Set<Promise<unknown>>();
	private refreshers: (() => Promise<unknown>)[] = [];
	track<T>(p: Promise<T>): Promise<T> {
		this.running.add(p);
		void p.finally(() => this.running.delete(p)).catch(() => undefined);
		return p;
	}
	add(refresh: () => Promise<unknown>): void {
		this.refreshers.push(refresh);
	}
	async settled(): Promise<void> {
		while (this.running.size) await Promise.allSettled([...this.running]);
	}
	async refreshAll(): Promise<void> {
		await Promise.all(this.refreshers.map((r) => this.track(r())));
	}
}

/** Put a copy in front of what the Harness asks without waiting, and settle copies after every call. */
function adapt(api: PluginApi, capability: string, impl: unknown, copies: Copies): unknown {
	const settled = settleAfterCalls(impl as Record<string, unknown>, copies);
	// Refreshing a copy calls the plugin directly: waiting for refreshes to settle would wait for itself.
	if (capability === "tool-source") return cachedToolSource(api, impl as RemoteToolSource, settled as unknown as RemoteToolSource, copies);
	if (capability === "provider") {
		const raw = impl as { models(): Promise<ReturnType<Provider["models"]>> };
		let models: ReturnType<Provider["models"]> = [];
		copies.add(async () => (models = await raw.models()));
		return { ...settled, models: () => models };
	}
	return settled;
}

function settleAfterCalls(impl: Record<string, unknown>, copies: Copies): Record<string, unknown> {
	if (!impl || typeof impl !== "object") return impl;
	const out: Record<string, unknown> = { ...impl };
	for (const [k, v] of Object.entries(impl)) {
		if (typeof v !== "function") continue;
		out[k] = async (...args: unknown[]) => {
			const result = await (v as (...a: unknown[]) => unknown)(...args);
			await copies.settled();
			return result;
		};
	}
	return out;
}

interface RemoteToolSource {
	id: string;
	tools(sessionId?: string): Promise<ToolDefinition[]>;
	run: ToolSource["run"];
	onChange?(listener: () => void): Promise<unknown>;
}

function cachedToolSource(api: PluginApi, impl: RemoteToolSource, settled: RemoteToolSource, copies: Copies): ToolSource {
	let everywhere: ToolDefinition[] = [];
	const bySession = new Map<string, ToolDefinition[]>();
	const listeners = new Set<() => void>();
	const fetchSession = async (sessionId: string) => bySession.set(sessionId, await impl.tools(sessionId));
	const refresh = async () => {
		everywhere = await impl.tools();
		await Promise.all([...bySession.keys()].map(fetchSession));
		for (const l of listeners) l();
	};
	copies.add(refresh);
	void impl.onChange?.(() => void copies.track(refresh()));
	// A session's own tools are fetched before its first turn can ask for them.
	api.on("session.start", (p: { sessionId: string }) => fetchSession(p.sessionId));
	api.on("session.end", (p: { sessionId: string }) => void bySession.delete(p.sessionId));
	return {
		id: impl.id,
		tools: (sessionId) => (sessionId && bySession.get(sessionId)) || everywhere,
		run: (call, ctx) => settled.run(call, ctx),
		onChange: (l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
	};
}
