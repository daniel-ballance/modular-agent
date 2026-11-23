#!/usr/bin/env python3
"""Offline adversarial fixture for the Rust plugin host, not a build implementation."""
import asyncio
import base64
import json
import os
import sys
import traceback

ZERO_USAGE = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0}

pending = {}
tasks = set()
sequence = 0
config = {}
registration = {}
changed = False
turn_cancels = {}
saved_points = {}


def send(value):
    print(json.dumps({"jsonrpc": "2.0", **value}), flush=True)


def start_host(method, params):
    global sequence
    sequence += 1
    key = "fixture-" + str(sequence)
    future = asyncio.get_running_loop().create_future()
    pending[key] = future
    send({"id": key, "method": method, "params": params})
    return key, future


async def host(method, params):
    _, future = start_host(method, params)
    reply = await future
    if "error" in reply:
        return {"error": reply["error"]}
    return reply.get("result")


def definition(name):
    return {"name": name, "description": "test fixture", "parameters": {"type": "object"}, "hints": {"safeToRepeat": True}, "parallel": False}


async def request(message):
    global config, registration, changed
    method = message["method"]
    p = message.get("params", {})
    mid = message["id"]
    if config.get("log"):
        with open(config["log"], "a", encoding="utf8") as stream:
            stream.write(json.dumps({"method": method, "params": p}) + "\n")
    if method == "plugin/initialize":
        config = p["config"]
        registration = {"binding": "modular-agent-plugin/1", "name": "fixture", **config.get("registration", {})}
        result = registration
    elif method == "provider/discard" and config.get("mode") == "erase":
        assert p.get("erase") is True
        assert isinstance(p["entryIds"], list)
        result = {"pending": p["entryIds"], "outOfReach": ["vendor retention"]}
    elif method in ("$/ping", "plugin/shutdown", "provider/discard", "env/sessionEnded"):
        result = {}
    elif method == "runtime/runTurn" and config.get("mode") in ("runtime-parent", "runtime-changed-call", "runtime-cancel-tool", "runtime-unoffered", "runtime-latched", "runtime-open"):
        async def runtime_host(name, **params):
            return await host("host/runtime/" + name, {"parentRequestId": mid, **params})

        mode = config["mode"]
        step = (await runtime_host("newId"))["id"]
        wrong_parent = await runtime_host("newId", parentRequestId="not-the-turn")
        wrong_session = await runtime_host("newId", sessionId="not-the-session")
        request = await runtime_host("prepareStep", stepId=step, usage=ZERO_USAGE)
        response = await runtime_host("model", stepId=step, request=request)
        usage = response.get("usage", ZERO_USAGE)
        draft = {"kind": "response", "modelVisible": True, "stepId": step, "message": response}
        forged = await runtime_host("record", entry={**draft, "message": {**response, "content": []}})
        entry = await runtime_host("record", entry=draft)
        repeated = await runtime_host("record", entry=draft)
        trace = {"forged": forged, "entry": entry, "repeat": repeated}
        outcome = {"kind": "completed"}
        text = response["content"][0].get("text", "")
        open_calls = []
        if mode in ("runtime-changed-call", "runtime-cancel-tool", "runtime-unoffered", "runtime-open"):
            part = response["content"][0]
            call = {"id": part["id"], "name": part["name"], "input": part["arguments"], "startedBy": "model"}
            gate = await runtime_host("hook", hook="tool.before", stepId=step, payload={"call": call})
            trace["gate"] = gate
            allowed = gate["value"]["call"]
            if mode == "runtime-unoffered":
                pass
            elif mode == "runtime-open":
                trace["tool"] = await runtime_host("runToolCall", call=allowed)
                open_calls = config.get("openToolCalls", [call["id"]])
                outcome = config["outcome"]
            elif mode == "runtime-changed-call":
                submitted = {**allowed, **config["change"]}
                trace["tool"] = await runtime_host("runToolCall", call=submitted)
                trace["again"] = await runtime_host("runToolCall", call=allowed)
            else:
                cancel = turn_cancels[mid] = asyncio.Event()
                key, running = start_host("host/runtime/runToolCall", {"parentRequestId": mid, "call": allowed})
                await cancel.wait()
                del turn_cancels[mid]
                send({"method": "$/cancel", "params": {"id": key}})
                trace["tool"] = await running
                # A late answer cannot win against the host's confirmed cancellation.
        trace["after"] = await runtime_host("hook", hook="step.after", stepId=step, payload={"response": response})
        if mode == "runtime-latched" and config.get("prepareAgain"):
            next_step = (await runtime_host("newId"))["id"]
            denied = await runtime_host("prepareStep", stepId=next_step, usage=usage)
            trace["next"] = denied
            data = denied.get("error", {}).get("data", {})
            if data.get("code") == "turn_limit":
                outcome = {"kind": "limit", "limit": data["limit"]}
        result = {"outcome": outcome, "result": {"openToolCalls": open_calls, "text": text}, "usage": usage, "entries": [entry["id"]]}
        trace["end"] = await runtime_host("hook", hook="turn.end", payload=result)
        if mode == "runtime-parent":
            after_end = await runtime_host("newId")
            trace["errors"] = [reply.get("error", {}).get("data", {}).get("code") for reply in (wrong_parent, wrong_session, after_end)]
        with open(config["observed"], "w", encoding="utf8") as stream:
            json.dump(trace, stream)
    elif method == "runtime/runTurn" and config.get("mode") == "runtime-cancel":
        parent = {"parentRequestId": mid}
        cancel = turn_cancels[mid] = asyncio.Event()
        steps = [(await host("host/runtime/newId", parent))["id"] for _ in range(2)]
        callbacks = [start_host("host/runtime/prepareStep", {**parent, "stepId": step, "usage": ZERO_USAGE}) for step in steps]
        await cancel.wait()
        del turn_cancels[mid]
        for key, _ in callbacks:
            send({"method": "$/cancel", "params": {"id": key}})
        replies = await asyncio.gather(*(future for _, future in callbacks))
        history = await host("host/history", {**parent, "sessionId": p["turn"]["sessionId"], "limit": 1})
        result = {"outcome": {"kind": "cancelled"}, "result": {"openToolCalls": []}, "usage": ZERO_USAGE, "entries": []}
        end = await host("host/runtime/hook", {**parent, "hook": "turn.end", "payload": result})
        with open(config["observed"], "w", encoding="utf8") as stream:
            json.dump({"replies": replies, "history": history, "end": end}, stream)
    elif method == "env/read" and "readError" in config:
        send({"id": mid, "error": {"code": -32000, "message": config["readError"]["message"], "data": {"code": config["readError"]["code"]}}})
        return
    elif method == "env/save" and "points" in config:
        point = config["points"].pop(0)
        saved_points[point] = (p["cwd"], p["sessionId"])
        result = {"point": point}
    elif method == "env/checkPoint" and "points" in config:
        result = {"exists": saved_points.get(p["point"]) == (p["cwd"], p["sessionId"])}
    elif method == "env/restore" and config.get("replaceProjectOnRestore"):
        # The test project is empty. Restore it by swapping the directory itself.
        cwd = p["cwd"]
        old = cwd + ".previous"
        os.rename(cwd, old)
        os.mkdir(cwd)
        os.rmdir(old)
        result = {}
    elif method == "env/exists" and "readError" in config:
        # A file can disappear after an existence check, before the read.
        result = {"exists": True}
    elif method == "tools/list":
        result = {"tools": [definition("probe")] + ([definition(config.get("changedName", "new"))] if changed else [])}
    elif method == "tools/call":
        mode = config.get("mode")
        if mode == "lost":
            os._exit(7)
        if mode == "changing":
            changed = True
            send({"method": "tools/changed", "params": {"toolSource": "fixture", "parentRequestId": mid}})
            result = {"status": "completed", "content": [{"type": "text", "text": "changed"}]}
        elif mode == "ask":
            answer = await host("host/ask", {"parentRequestId": mid, "request": {"kind": "text", "question": "Fixture question?", "futureQuestion": 17, "details": {"hint": "retained"}, "timeLimitMs": 0, "whenTimeLimit": config.get("whenTimeLimit", "leaveOpen")}})
            result = {"pending": "question"} if answer.get("pending") else {"status": "completed", "content": [{"type": "text", "text": json.dumps(answer)}]}
        elif mode == "read":
            reply = await host("host/env/read", {**p["call"]["input"], "parentRequestId": mid, "sessionId": p["sessionId"], "cwd": p["project"]})
            result = {"status": "completed", "content": [{"type": "text", "text": json.dumps(reply)}], "value": reply}
        elif mode == "exec":
            reply = await host("host/env/exec", {**p["call"]["input"], "parentRequestId": mid, "sessionId": p["sessionId"], "cwd": p["project"]})
            result = {"status": "completed", "content": [{"type": "text", "text": json.dumps(reply)}], "value": reply}
        elif mode == "job-report":
            started = await host("host/jobs/start", {"parentRequestId": mid, "kind": "test", "detail": {}})
            job = started["jobId"]
            await host("host/jobs/end", {"jobId": job, "outcome": {"kind": "completed"}, "result": [{"type": "text", "text": "report"}], "report": True})
            history = await host("host/history", {"parentRequestId": mid, "sessionId": p["sessionId"]})
            result = {"status": "completed", "content": [{"type": "text", "text": "job ended"}], "value": history}
        elif mode == "history-boundary":
            cursor = await host("host/history", {"sessionId": p["sessionId"], "limit": 1})
            page = await host("host/history", {"sessionId": p["sessionId"], "limit": 1, "after": cursor["next"]})
            following = await host("host/history", {"sessionId": p["sessionId"], "after": page["next"]}) if "next" in page else {}
            result = {"status": "completed", "content": [{"type": "text", "text": json.dumps({"entries": len(page.get("entries", [])), "next": page.get("next"), "following": len(following.get("entries", []))})}]}
        elif mode == "oversized-history":
            cursor = await host("host/history", {"sessionId": p["sessionId"], "limit": 1})
            reply = await host("host/history", {"sessionId": p["sessionId"], "limit": 1, "after": cursor["next"]})
            result = {"status": "completed", "content": [{"type": "text", "text": json.dumps(reply)}]}
        elif mode == "callbacks":
            direct = {"sessionId": p["sessionId"]}
            lineage = {"parentRequestId": mid, "sessionId": p["sessionId"]}
            replies = {}
            for method, args in [
                ("host/session", direct),
                ("host/history", {**direct, "limit": 1}),
                ("host/declaration", direct),
                ("host/credentials/read", {"provider": "fixture"}),
                ("host/credentials/read", {"provider": "openai"}),
                ("host/session", {"sessionId": "not-authorized"}),
                ("host/session", {**lineage, "sessionId": "not-authorized"}),
                ("host/hook", {**lineage, "hook": "provider.request", "payload": {}}),
                ("host/env/write", {**lineage, "cwd": p["project"], "path": "callback.bin", "data": base64.b64encode(bytes([0, 255, 42])).decode()}),
                ("host/env/read", {**lineage, "cwd": p["project"], "path": "callback.bin"}),
                ("host/env/exists", {**lineage, "cwd": p["project"], "path": "callback.bin"}),
                ("host/env/exec", {**lineage, "cwd": p["project"], "command": "printf callback-output"}),
                ("host/env/exec", {**lineage, "cwd": p["project"], "command": "sleep 20", "timeoutMs": 20}),
                ("host/env/read", {**lineage, "cwd": "/", "path": "nope"}),
                ("host/history", {**direct, "after": None, "limit": None, "all": None, "parentRequestId": None}),
                ("host/history", direct),
                ("host/history", {**direct, "after": "missing"}),
                ("host/history", {**direct, "limit": 0}),
                ("host/history", {**direct, "all": "true"}),
                ("host/declaration", {"sessionId": None, "parentRequestId": None}),
                ("host/declaration", {}),
                ("host/credentials/read", {"provider": "fixture", "sessionId": None, "parentRequestId": None}),
            ]:
                label = method + ":" + str(len(replies))
                replies[label] = await host(method, args)
            send({"method": "host/emit", "params": {**direct, "type": "fixture.event", "data": {"ok": True}}})
            send({"method": "host/problem", "params": {"where": "fixture", "message": "deliberate test problem"}})
            result = {"status": "completed", "content": [{"type": "text", "text": json.dumps(replies)}], "value": replies, "futureResult": 42}
        else:
            result = {"status": "completed", "content": [{"type": "text", "text": "fixture result"}]}
    elif method == "hook/handle":
        result = config.get("answers", {}).get(p["hook"])
        if p["hook"] == "output" and any(e.get("type") == "reply" and e["data"].get("method") == config.get("withholdMethod") for e in p["payload"]["events"]):
            result = {"block": True}
        if p["hook"] == "output" and config.get("mode") == "numeric-output-echo":
            def echo(value):
                if isinstance(value, dict):
                    return {key: echo(value[key]) for key in sorted(value, reverse=True)}
                if isinstance(value, list):
                    return [echo(item) for item in value]
                if isinstance(value, float) and value.is_integer():
                    return int(value)
                return value

            result = {"events": echo(p["payload"]["events"])}
        if p["hook"] == "output" and config.get("mode") == "redact-turn-end":
            events = p["payload"]["events"]
            for event in events:
                if event["type"] == "entry" and event["data"]["entry"]["kind"] == "turnEnd":
                    event["data"]["entry"]["data"]["result"]["text"] = "[redacted]"
            result = {"events": events}
        if config.get("mode") == "hooks" and p["hook"] == "step.before":
            request = p["payload"]["request"]
            request["systemPrompt"] += "\nwire step hook"
            request["settings"]["futureSetting"] = "kept"
            result = {"value": {**p["payload"], "request": request}}
        if config.get("mode") == "hooks" and p["hook"] == "provider.request":
            result = {"value": p["payload"]}
    elif method == "command/run":
        result = {"output": "fixture command: " + p["args"]}
    elif method == "provider/request":
        original = {key: p[key] for key in ("provider", "model", "sessionId")}
        scope = {"sessionId": p["sessionId"], "all": True}
        result = {"role": "assistant", "content": [{"type": "text", "text": "fixture model"}], "stop": "finished"}
        before = await host("host/history", scope) if "observed" in config else None
        effective = None
        checkpoint = None
        if config.get("mode") != "provider-skips-hook":
            effective = await host("host/hook", {"parentRequestId": mid, "hook": "provider.request",
                                                 "payload": {**original, "request": p["request"]}})
            if "observed" in config:
                checkpoint = await host("host/history", scope)
            await host("host/hook", {"parentRequestId": mid, "hook": "provider.response",
                                    "payload": {**original, "message": result}})
        if "observed" in config:
            with open(config["observed"], "w", encoding="utf8") as stream:
                json.dump({"before": before, "checkpoint": checkpoint, "effective": effective}, stream)
    elif method == "provider/models":
        result = {"models": next(pv["models"] for pv in registration["providers"] if pv["id"] == p["provider"])}
    elif method == "provider/available":
        result = {"available": True}
    else:
        send({"id": mid, "error": {"code": -32601, "message": method, "data": {"code": "not_supported"}}})
        return
    send({"id": mid, "result": result})


async def answer(message):
    try:
        await request(message)
    except Exception as exc:
        traceback.print_exc()
        send({"id": message["id"], "error": {
            "code": -32603,
            "message": f"{message['method']}: {type(exc).__name__}: {exc}",
            "data": {"code": "internal"},
        }})


async def main():
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=70 * 1024 * 1024)
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)
    try:
        while line := await reader.readline():
            message = json.loads(line)
            if "method" not in message:
                waiter = pending.pop(message.get("id"), None)
                if waiter is not None:
                    waiter.set_result(message)
            elif message["method"] == "$/cancel":
                turn_cancel = turn_cancels.get(message["params"]["id"])
                if turn_cancel is not None:
                    turn_cancel.set()
            elif "id" in message:
                task = asyncio.create_task(answer(message))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


asyncio.run(main())
