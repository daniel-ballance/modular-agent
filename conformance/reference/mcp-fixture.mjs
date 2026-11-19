#!/usr/bin/env node
// A minimal MCP server on stdio with one tool, `echo`, for the reference checks.
// Newline-delimited JSON-RPC 2.0; no dependencies.
import { createInterface } from "node:readline";
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.id === undefined) return; // notifications
  switch (req.method) {
    case "initialize":
      return send({ id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } } });
    case "tools/list":
      return send({ id: req.id, result: { tools: [{ name: "echo", description: "Echo the text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } }] } });
    case "tools/call":
      return send({ id: req.id, result: { content: [{ type: "text", text: `echo: ${req.params?.arguments?.text ?? ""}` }] } });
    case "ping":
      return send({ id: req.id, result: {} });
    default:
      return send({ id: req.id, error: { code: -32601, message: "method not found" } });
  }
});
