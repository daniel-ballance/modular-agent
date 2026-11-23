#!/usr/bin/env python3
"""Offline legacy MCP stdio fixture. No inference or credentials."""
import json
import os
import sys
import time

if len(sys.argv) > 1:
    with open(sys.argv[1], "w") as f:
        f.write(str(os.getpid()))
changed = False
for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if wire := os.environ.get("MCP_FIXTURE_WIRE"):
        with open(wire, "a") as f:
            f.write(line)
    if "id" not in request:
        continue
    response = {"jsonrpc": "2.0", "id": request["id"]}
    if method == "initialize":
        response["result"] = {"protocolVersion": "2025-11-25", "capabilities": {"tools": {"listChanged": True}}, "serverInfo": {"name": "offline-fixture", "version": "1"}}
    elif method == "tools/list":
        names = ["echo", "mutate", "fail", "slow"] + (["added"] if changed else [])
        if "MCP_FIXTURE_WIRE" in os.environ:
            second_page = request.get("params", {}).get("cursor") == "next"
            names = names[2:] if second_page else names[:2]
        response["result"] = {"tools": [{"name": name, "description": "Offline " + name, "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}}, "annotations": {"readOnlyHint": name != "mutate", "destructiveHint": name == "mutate", "idempotentHint": name == "mutate", "openWorldHint": False}} for name in names]}
        if "MCP_FIXTURE_WIRE" in os.environ and not second_page:
            response["result"]["nextCursor"] = "next"
    elif method == "tools/call":
        name = request["params"]["name"]
        if name == "slow":
            time.sleep(0.2)
        response["result"] = {"content": [{"type": "text", "text": os.environ.get("MCP_PREFIX", "echo:") + request["params"].get("arguments", {}).get("text", "")}, {"type": "resource_link", "uri": "file:///offline", "name": "opaque-link"}], "structuredContent": {"fixture": True}, "isError": name == "fail"}
        if name == "echo":
            changed = True
            print(json.dumps({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}), flush=True)
    else:
        response["error"] = {"code": -32601, "message": "Method not found"}
    print(json.dumps(response), flush=True)
