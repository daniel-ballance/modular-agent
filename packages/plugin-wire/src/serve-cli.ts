#!/usr/bin/env node
// Serve this build's conformance plugin over modular-agent-plugin/1 on stdin and stdout.
// MODULAR_AGENT_PLUGIN_PARTS chooses the parts: provider, tools, environment, hooks (default: all).
import { localEnvironment } from "@modular-agent/env-local";
import type { Plugin } from "@modular-agent/harness";
import { conformanceHooks, conformanceProvider, conformanceTools } from "./conformance.js";
import { servePlugins } from "./serve.js";

// stdout carries the connection: nothing else may write to it.
console.log = console.error;
console.info = console.error;
const parts = new Set((process.env.MODULAR_AGENT_PLUGIN_PARTS ?? "provider,tools,environment,hooks").split(",").map((s) => s.trim()).filter(Boolean));
const plugins: Plugin[] = [];
const replaces: string[] = [];
if (parts.has("provider")) plugins.push(conformanceProvider()), replaces.push("provider:conformance");
if (parts.has("tools")) plugins.push(conformanceTools()), replaces.push("tool:bash", "tool:read");
if (parts.has("environment")) plugins.push(localEnvironment()), replaces.push("working-environment");
if (parts.has("hooks")) plugins.push(conformanceHooks());
await servePlugins({ name: "conformance-typescript", plugins, replaces, containment: "strong" });
process.exit(0);
