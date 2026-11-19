#!/usr/bin/env node
import { serve } from "@modular-agent/core";
import { fixture } from "./index.js";

try { await serve(fixture(process.argv[2])); }
catch (error) { console.error(error); process.exitCode = 1; }
