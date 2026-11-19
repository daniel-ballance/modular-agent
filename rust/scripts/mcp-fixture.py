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
    if "id" not in request:
        continue
    response = {"jsonrpc": "2.0", "id": request["id"]}
    if method == "initialize":
        response["result"] = {"protocolVersion": "2025-11-25", "capabilities": {"tools": {"listChanged": True}}, "serverInfo": {"name": "offline-fixture", "version": "1"}}
    elif method == "tools/list":
        names = ["echo", "mutate", "fail", "slow"] + (["added"] if changed else [])
        response["result"] = {"tools": [{"name": name, "description": "Offline " + name, "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}}, "annotations": {"readOnlyHint": name != "mutate", "destructiveHint": name == "mutate", "idempotentHint": name == "mutate", "openWorldHint": False}} for name in names]}
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
