import { registerExternalPlugin, servePluginService, servePlugins, WireError, WirePeer, type ErrorCode, type PluginListenOptions, type AnonymousPluginListenOptions, type NamedPluginListenOptions, type NamedCaller } from "@modular-agent/plugin-wire";
import { PassThrough } from "node:stream";
import { collect, unservableTool, type Plugin } from "./plugin.js";
import { AgentError, sdkError } from "./errors.js";

import type { ServiceServer } from "@modular-agent/plugin-wire";

function checkServable(plugin: Plugin): void {
  const blocked = unservableTool(plugin);
  if (blocked) throw new AgentError("not_supported", `${plugin.name}: cannot serve tool ${blocked.definition.name}`);
}

function bindings(plugin: Plugin, failed?: (error: AgentError) => void) {
  return { name: plugin.name, replaces: plugin.replaces, directConfig: true,
    plugins: [{ name: plugin.name, stop: plugin.stop?.bind(plugin), async setup(api: import("@modular-agent/harness").PluginApi) {
      try { await (await collect(plugin, api.config(), true)).base.setup(api); }
      catch (error) {
        const failure = sdkError(error);
        failed?.(failure);
        const code = failure.code === "invalid_composition" || failure.code === "invalid_params" ? "invalid_request" : failure.code as ErrorCode;
        throw new WireError(code, failure.message);
      }
    } }],
  };
}

async function endpoint(plugin: Plugin, input?: NodeJS.ReadableStream, output?: (line: string) => void, acceptTraceContext?: boolean): Promise<void> {
  let failure: AgentError | undefined;
  await servePlugins({ ...bindings(plugin, error => { failure = error; }), input, output, acceptTraceContext });
  if (failure) throw failure;
}

/** Serve on stdio or create a WebSocket listener. Setup runs once per connection. */
export function serve(plugin: Plugin, options?: { acceptTraceContext: boolean }): Promise<void>;
export function serve(plugin: Plugin | (() => Plugin), options: AnonymousPluginListenOptions): Promise<ServiceServer>;
export function serve(factory: (caller:NamedCaller) => Plugin, options:NamedPluginListenOptions):Promise<ServiceServer>;
export async function serve(plugin: Plugin | (() => Plugin) | ((caller:NamedCaller) => Plugin), options?: PluginListenOptions | { acceptTraceContext: boolean }): Promise<void | ServiceServer> {
  if (options && "callers" in options) {
    if (typeof plugin !== "function") throw new AgentError("invalid_composition","Named callers require a per-connection plugin factory");
    try { return await servePluginService(({callerId}:NamedCaller) => {
      const instance = plugin({callerId}); checkServable(instance); return bindings(instance);
    },options); }
    catch (cause) { throw new AgentError("invalid_composition","Invalid named plugin listener",undefined,cause); }
  }
  if (typeof plugin !== "function") checkServable(plugin);
  if (options && !("acceptTraceContext" in options)) return servePluginService(() => {
    const instance = typeof plugin === "function" ? (plugin as () => Plugin)() : plugin;
    checkServable(instance);
    return bindings(instance);
  }, options);
  if (typeof plugin !== "function") await endpoint(plugin, undefined, undefined, options?.acceptTraceContext);
}

const onWire = new WeakMap<Plugin, Plugin>();

export function overWire(plugin: Plugin): Plugin {
  const wrapper: Plugin = { ...plugin, setup() {
    throw new AgentError("not_supported", "Load the testing plugin through createAgent");
  } };
  onWire.set(wrapper, plugin);
  return wrapper;
}

export function wirePlugin(plugin: Plugin, info: { project: string; home: string }) {
  const source = onWire.get(plugin);
  return source && pluginPipe(source, info, plugin.config ?? {});
}

// A transport for testing the actual server without spawning a program.
async function pluginPipe(plugin: Plugin, info: { project: string; home: string }, config: Record<string, unknown>) {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = endpoint(plugin, input, line => { output.write(line); }).finally(() => output.end());
  // Delay delivery to preserve the same request-parent lifetimes as a real pipe.
  const peer = new WirePeer(line => queueMicrotask(() => { if (!input.writableEnded) input.write(line); }), () => input.end());
  output.on("data", chunk => peer.feed(chunk));
  output.on("end", () => peer.close());
  void done.catch(() => {});
  return registerExternalPlugin(peer, info, config, async reason => {
    try { if (!peer.closed) await peer.request("plugin/shutdown", { reason: reason ?? "stop" }); }
    finally { input.end(); }
    await done.catch(() => {});
  });
}
