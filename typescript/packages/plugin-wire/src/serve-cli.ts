#!/usr/bin/env node
// Serve this build's conformance plugin over modular-agent-plugin/1 on stdin and stdout.
// MODULAR_AGENT_PLUGIN_PARTS chooses the parts: provider, tools, environment, hooks (default: all).
import { localEnvironment } from "@modular-agent/env-local";
import { durableRuntime } from "@modular-agent/runtime-durable";
import { transientRuntime } from "@modular-agent/runtime-transient";
import type { Plugin } from "@modular-agent/harness";
import { conformanceHooks, conformanceProvider, conformanceTools } from "./conformance.js";
import { servePlugins } from "./serve.js";

// stdout carries the connection: nothing else may write to it.
console.log = console.error;
console.info = console.error;
const requested = (process.env.MODULAR_AGENT_PLUGIN_PARTS ?? "provider,tools,environment,hooks").split(",");
const parts = new Set(requested);
if (parts.size !== requested.length || requested.some((p) => !["provider", "tools", "environment", "hooks", "runtime", "durable-runtime"].includes(p))) throw new Error("Invalid conformance plugin part selection");
const plugins: Plugin[] = [];
const replaces: string[] = [];
if (parts.has("provider")) plugins.push(conformanceProvider()), replaces.push("provider:conformance");
if (parts.has("tools")) plugins.push(conformanceTools()), replaces.push("tool:bash", "tool:read", "tool:nest");
if (parts.has("environment")) plugins.push(localEnvironment({ points: "copy" })), replaces.push("working-environment");
if (parts.has("hooks")) plugins.push(conformanceHooks());
if (parts.has("runtime") && parts.has("durable-runtime")) throw new Error("runtime and durable-runtime are never served together");
if (parts.has("runtime")) plugins.push(transientRuntime()), replaces.push("runtime");
if (parts.has("durable-runtime")) plugins.push(durableRuntime()), replaces.push("runtime");
const name = `conformance-typescript:${[...parts].sort().join(",")}`;
await servePlugins({ name, plugins, replaces, containment: process.platform === "linux" ? "strong" : "processGroup" });
process.exit(0);
