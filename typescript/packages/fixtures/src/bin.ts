#!/usr/bin/env node
import { serve } from "@modular-agent/core";
import { fixture } from "./index.js";

try {
  const [name, ...extra] = process.argv.slice(2);
  if (!name || extra.length) throw new Error("Usage: modular-agent-fixtures <fixture>");
  await serve(fixture(name));
}
catch (error) { console.error(error); process.exitCode = 1; }
