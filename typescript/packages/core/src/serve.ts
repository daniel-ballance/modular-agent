import { servePlugins } from "@modular-agent/plugin-wire";
import { PassThrough } from "node:stream";
import { collect, type Plugin } from "./plugin.js";
import { AgentError, sdkError } from "./errors.js";

async function endpoint(plugin: Plugin, input?: NodeJS.ReadableStream, output?: (line: string) => void): Promise<void> {
  let failure: AgentError | undefined;
  // When stdin is in use, an initialization error must be sent before exit.
  // The base sends it as the reply; the host then closes the connection.
  await servePlugins({ name: plugin.name, replaces: plugin.replaces, directConfig: true, input, output,
    plugins: [{ name: plugin.name, stop: plugin.stop?.bind(plugin), async setup(api) {
      try { await (await collect(plugin, api.config(), true)).base.setup(api); }
      catch (error) { failure = sdkError(error); throw failure; }
    } }],
  });
  if (failure) throw failure;
}

/** Serve an SDK plugin on stdin and stdout. Setup runs after initialize supplies config. */
export function serve(plugin: Plugin): Promise<void> { return endpoint(plugin); }

// A transport for testing the actual server without spawning a program.
export function pluginPipe(plugin: Plugin) {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = endpoint(plugin, input, line => { output.write(line); }).finally(() => output.end());
  return { input, output, done };
}
