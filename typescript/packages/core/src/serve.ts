import { registerExternalPlugin, servePlugins, WireError, WirePeer, type ErrorCode } from "@modular-agent/plugin-wire";
import { PassThrough } from "node:stream";
import { collect, unservableTool, type Plugin } from "./plugin.js";
import { AgentError, sdkError } from "./errors.js";

async function endpoint(plugin: Plugin, input?: NodeJS.ReadableStream, output?: (line: string) => void): Promise<void> {
  let failure: AgentError | undefined;
  // When stdin is in use, an initialization error must be sent before exit.
  // The base sends it as the reply; the host then closes the connection.
  await servePlugins({ name: plugin.name, replaces: plugin.replaces, directConfig: true, input, output,
    plugins: [{ name: plugin.name, stop: plugin.stop?.bind(plugin), async setup(api) {
      try { await (await collect(plugin, api.config(), true)).base.setup(api); }
      catch (error) {
        failure = sdkError(error);
        const code = failure.code === "invalid_composition" || failure.code === "invalid_params" ? "invalid_request" : failure.code as ErrorCode;
        throw new WireError(code, failure.message);
      }
    } }],
  });
  if (failure) throw failure;
}

/** Serve an SDK plugin on stdin and stdout. Setup runs after initialize supplies config. */
export async function serve(plugin: Plugin): Promise<void> {
  const blocked = unservableTool(plugin);
  if (blocked) throw new AgentError("not_supported", `${plugin.name}: cannot serve tool ${blocked.definition.name}`);
  await endpoint(plugin);
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
