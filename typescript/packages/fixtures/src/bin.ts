#!/usr/bin/env node
import { serve } from "@modular-agent/core";
import { fixture } from "./index.js";

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
  } else await serve(fixture(name));
}
catch (error) { console.error(error); process.exitCode = 1; }
