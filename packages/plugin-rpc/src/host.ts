// A process that runs one plugin for a Harness in another process. Messages arrive
// on stdin and leave on stdout, one JSON-RPC message per line.
import type { Plugin, PluginApi } from "@modular-agent/harness";
import { lines, Peer } from "./peer.js";
import { ASYNC_API } from "./remote.js";

// stdout carries the connection: anything a plugin prints goes to stderr instead.
console.log = console.error;
console.info = console.error;

interface SetupInfo {
	module: string;
	export: string;
	options?: unknown;
	name: string;
	project: string;
	home: string;
	config: Record<string, unknown>;
	capabilities: [string, number][];
}

let plugin: Plugin | undefined;
const peer = new Peer((line) => process.stdout.write(line + "\n"), {
	async setup(info: SetupInfo) {
		const mod = (await import(info.module)) as Record<string, (options?: unknown) => Plugin>;
		const factory = mod[info.export];
		if (typeof factory !== "function") throw new Error(`${info.module} exports no ${info.export}`);
		plugin = factory(info.options);
		await plugin.setup(remoteApi(info));
	},
	async stop() {
		await plugin?.stop?.();
	},
});
lines(process.stdin, (line) => peer.receive(line), () => process.exit(0));

/** A capability provided in the Harness's process. Its methods are called there; it has no readable data. */
function capability(name: string, index: number): unknown {
	return new Proxy({}, {
		get: (_t, method) => (method === "then" || typeof method === "symbol" ? undefined : (...args: unknown[]) => peer.request("useCall", name, index, method, args)),
	});
}

/** Plugin API calls that answer without waiting can't cross a process. Each says so, rather than guess. */
const unavailable = (name: string) => () => {
	throw new Error(`${name}() answers without waiting, so a plugin in another process can't use it`);
};

function remoteApi(info: SetupInfo): PluginApi {
	const counts = new Map(info.capabilities);
	const off = (handler: unknown) => () => peer.notify("off", handler);
	const api: Record<string, unknown> = {
		name: info.name,
		project: info.project,
		home: info.home,
		config: () => info.config,
		provide: (cap: string, impl: unknown) => peer.notify("provide", cap, impl),
		use: (cap: string) => (counts.get(cap) ? capability(cap, 0) : undefined),
		useAll: (cap: string) => Array.from({ length: counts.get(cap) ?? 0 }, (_, i) => capability(cap, i)),
		defineHook: (name: string, rule: string) => peer.notify("defineHook", name, rule),
		on: (hook: string, handler: unknown, order?: string) => (peer.notify("on", hook, handler, order), off(handler)),
		onEvent: (listener: unknown, options?: unknown) => (peer.notify("onEvent", listener, options), off(listener)),
		follow: (sessionId: string, options: unknown, listener: unknown) => (peer.notify("follow", sessionId, options, listener), off(listener)),
		emit: (sessionId: string, type: string, data?: unknown, ids?: unknown) => peer.notify("emit", sessionId, type, data, ids),
		registerCommand: (name: string, command: unknown) => peer.notify("registerCommand", name, command),
		reportProblem: (where: string, error: unknown) => peer.notify("reportProblem", where, error),
	};
	for (const name of ASYNC_API) api[name] = (...args: unknown[]) => peer.request(name, ...args);
	for (const name of ["projectOf", "commands", "session", "withdraw", "history", "tools", "answer", "openRequests", "startJob", "unfinishedJobs", "resumeJob", "jobs", "declaration", "modelAccess"]) api[name] = unavailable(name);
	return api as unknown as PluginApi;
}
