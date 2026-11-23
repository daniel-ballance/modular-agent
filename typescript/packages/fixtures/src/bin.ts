#!/usr/bin/env node
import { serve } from "@modular-agent/core";
import { fixture } from "./index.js";
import { startTelemetry } from "./telemetry.js";

try {
  const [name, ...extra] = process.argv.slice(2);
  const [flag, listen, tokenFlag, tokenFile] = extra;
  if (!name || extra.length && (extra.length !== 4 || flag !== "--listen" || tokenFlag !== "--token-file")) {
    throw new Error("Usage: modular-agent-fixtures <fixture> [--listen ADDR --token-file FILE]");
  }
  if (extra.length) {
    const server = await serve(() => fixture(name), { listen, tokenFile });
    process.stdout.write(server.url + "\n");
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void server.close());
  } else {
    const plugin = fixture(name);
    const endpoint = process.env.MODULAR_AGENT_TELEMETRY_OTLP;
    if (!endpoint) await serve(plugin);
    else {
      const shutdown = startTelemetry(endpoint);
      let stopped: Promise<void> | undefined;
      // Flush during shutdown, before the response tells the host it can reap us.
      const stop = () => stopped ??= shutdown();
      try {
        await serve({ ...plugin, stop }, {
          acceptTraceContext: process.env.MODULAR_AGENT_TELEMETRY_HANDSHAKE !== "no-acceptance",
        });
      } finally { await stop(); }
    }
  }
}
catch (error) { console.error(error); process.exitCode = 1; }
