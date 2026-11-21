"""An independently registered public-wire plugin, exercising more than the kit."""

import asyncio
import json
import os

from ma_core import content
from ma_plugin.rpc import WireError
from ma_plugin.server import BINDING, PluginServer


class Fixture(PluginServer):
    def __init__(self):
        self.changed_sessions = set()
        self.tools = [
            {
                "name": "probe",
                "description": "Probe host callbacks",
                "parameters": {"type": "object"},
            }
        ]
        self.config = {}
        super().__init__(
            {
                "binding": BINDING,
                "name": "wire-fixture",
                "providers": [
                    {
                        "id": "fixture",
                        "supports": {"keepsState": False, "runsTools": False},
                        "models": [],
                    }
                ],
                "toolSources": [{"id": "probes", "tools": self.tools}],
                "commands": [{"name": "probe", "description": "Probe"}],
            },
            {
                "command/run": self.run,
                "tools/call": self.run,
                "tools/list": self.list_tools,
                "provider/models": self.models,
                "provider/available": self.available,
                "provider/discard": self.discard,
                "provider/request": self.generate,
                "hook/handle": self.handle,
                "env/read": self.read,
                "env/sessionEnded": self.session_ended,
            },
            self.initialize_fixture,
        )

    async def initialize_fixture(self, p):
        self.config = p["config"]
        self.registration.update(self.config.get("registration", {}))
        if self.config.get("shutdownLog"):
            from pathlib import Path

            async def shutdown(params, key):
                Path(self.config["shutdownLog"]).write_text(params["reason"])
                return {}

            self.methods["fixture/shutdown"] = shutdown
        if self.config.get("runtimeCancel"):
            self.registration["runtime"] = {"id": "cancelling", "supports": {}}
            self.methods["runtime/runTurn"] = self.finish_failed_on_cancel
        if self.config.get("runtimePending"):
            self.registration["runtime"] = {"id": "pending-check", "supports": {}}
            self.methods["runtime/runTurn"] = self.finish_with_open_call
        if self.config.get("runtimeHistory"):
            self.registration["runtime"] = {
                "id": "history-reader",
                "supports": {"continuesAfterRestart": True},
            }
            self.methods["runtime/resumeTurn"] = self.resume_from_history
        if self.config.get("perSession"):
            self.registration["toolSources"][0]["perSession"] = True
        if self.config.get("providerTest"):
            self.registration["providers"][0]["models"] = [
                {
                    "provider": "fixture",
                    "id": "odd",
                    "contextWindow": 100000,
                    "maxOutput": 1000,
                    "input": ["text"],
                    "reasoning": False,
                }
            ]
        if self.config.get("hooks"):
            self.registration["hooks"] = [
                {"hook": h, "handlerId": i, "order": "last"}
                for i, h in enumerate(self.config["hooks"])
            ]

    async def dispatch(self, method, params, key):
        if method == "plugin/shutdown" and "fixture/shutdown" in self.methods:
            await self.methods["fixture/shutdown"](params, key)
        return await super().dispatch(method, params, key)

    async def finish_failed_on_cancel(self, p, key):
        async def ask(method, **params):
            return await self.peer.request(
                "host/runtime/" + method, {**params, "parentRequestId": key}
            )

        step = (await ask("newId"))["id"]
        request = await ask("prepareStep", stepId=step, usage={})
        try:
            await ask("model", request=request, stepId=step)
        except (asyncio.CancelledError, WireError):
            return {"outcome": {"kind": "failed", "error": "Callback stopped"}}
        raise AssertionError("Expected cancellation")

    async def finish_with_open_call(self, p, key):
        sid, turn = p["turn"]["sessionId"], p["turn"]["turnId"]

        async def host(method, **params):
            return await self.peer.request("host/" + method, {**params, "parentRequestId": key})

        step = (await host("runtime/newId"))["id"]
        request = await host("runtime/prepareStep", stepId=step, usage={})
        response = await host("runtime/model", request=request, stepId=step)
        await host(
            "runtime/record", entry={"kind": "response", "stepId": step, "message": response}
        )
        (part,) = [part for part in response["content"] if part["type"] == "toolCall"]
        call = {"id": part["id"], "name": part["name"], "input": part["arguments"], "stepId": step}
        after = {"stepId": step, "response": response}
        try:
            await host("runtime/hook", hook="step.after", payload=after)
        except WireError as exc:
            assert exc.code == "invalid_request"
        else:
            raise AssertionError("step.after accepted an unstarted call")
        before = await host("runtime/hook", hook="tool.before", payload={"call": call})
        pending = await host("runtime/runToolCall", call=before["value"]["call"])
        assert pending == {"callId": call["id"], "pending": "Waiting for fixture answer"}
        entries = (await host("history", sessionId=sid))["entries"]
        (started,) = [e for e in entries if e["kind"] == "toolStarted"]
        (question,) = [e for e in entries if e["kind"] == "inputRequest"]
        (saved,) = [e for e in entries if e["kind"] == "toolPending"]
        assert saved["toolCallId"] == call["id"]
        assert saved["turnId"] == turn and saved["stepId"] == step
        assert saved["modelVisible"] is False
        assert saved["data"] == {
            "requestIds": [question["requestId"]],
            "toolStartedId": started["id"],
        }
        await host("runtime/hook", hook="step.after", payload=after)
        entries = (await host("history", sessionId=sid))["entries"]
        (gate,) = [e for e in entries if e["kind"] == "modular-agent.stepAfter"]
        assert gate["parentId"] == saved["id"]
        mode = self.config["pendingOutcome"]
        completed = {"kind": "completed"}
        result = {"openToolCalls": [call["id"]]}
        outcome = completed
        if mode.startswith("questions-"):
            invalid = {"outcome": {"kind": "limit", "limit": "questions"}, "result": result}
            if mode == "questions-reply":
                return {**invalid, "entries": [], "usage": {}}
            try:
                if mode == "questions-hook":
                    await host("runtime/hook", hook="turn.end", payload=invalid)
                else:
                    await host("runtime/record", entry={"kind": "turnEnd", "data": invalid})
            except WireError as exc:
                assert exc.code == "invalid_request"
            else:
                raise AssertionError("Host accepted a question limit")
            # A later valid reply cannot undo the refusal.
            return {"outcome": completed, "result": result, "entries": [], "usage": {}}
        if mode == "steps":
            assert p["turn"]["settings"]["maxSteps"] == 1
            outcome = {"kind": "limit", "limit": "steps"}
        elif mode == "missing-call":
            return {
                "outcome": completed,
                "result": {"openToolCalls": []},
                "entries": [],
                "usage": {},
            }
        await host("runtime/hook", hook="turn.end", payload={"outcome": outcome, "result": result})
        return {"outcome": outcome, "result": result, "entries": [], "usage": {}}

    async def resume_from_history(self, p, key):
        sid, turn = p["turn"]["sessionId"], p["turn"]["turnId"]

        async def host(method, **params):
            return await self.peer.request(
                "host/" + method, {"sessionId": sid, "parentRequestId": key, **params}
            )

        entries, cursor = [], None
        while True:
            page = await host("history", after=cursor, limit=1)
            assert len(page["entries"]) == 1
            entry = page["entries"][0]
            entries.append(entry)
            cursor = page.get("next")
            if cursor is None:
                break
            assert cursor == entry["id"]
        (raw,) = [e for e in entries if e["kind"] == "input" and e["turnId"] == turn]
        assert raw["message"] == {"role": "user", "content": content("RAW-HISTORY-CANARY")}
        assert not any(e["kind"] == "python.off-branch" for e in entries)
        all_entries = (await host("history", all=True))["entries"]
        assert any(e["kind"] == "python.off-branch" for e in all_entries)
        for method, override in [
            ("history", {"sessionId": "different-session"}),
            ("history", {"parentRequestId": "unknown-parent"}),
            ("session", {}),
        ]:
            try:
                await host(method, **override)
            except WireError as exc:
                assert exc.code == "invalid_request"
            else:
                raise AssertionError(f"{method} escaped the Runtime turn scope")
        return {
            "outcome": {"kind": "completed"},
            "result": {"text": "rebuilt from history", "openToolCalls": []},
            "entries": [],
            "usage": {},
        }

    async def session_ended(self, p, key):
        assert p["sessionId"]
        return {}

    async def read(self, p, key):
        error = self.config["readError"]
        raise WireError(error["message"], error["code"])

    async def models(self, p, key):
        return {"models": self.registration["providers"][0].get("models", [])}

    async def generate(self, p, key):
        payload = {
            "sessionId": p.get("sessionId"),
            "provider": p["provider"],
            "model": p["model"],
            "request": p["request"],
        }
        payload = await self.peer.request(
            "host/hook", {"parentRequestId": key, "hook": "provider.request", "payload": payload}
        )
        previous = [m for m in payload["request"]["messages"] if m["role"] == "assistant"]
        if previous:
            assert previous[-1]["futureResponse"] == {"kept": True}
            assert previous[-1]["providerData"] == {"opaque": "not text"}
            assert {"type": "future-part", "payload": ["unchanged"]} in previous[-1]["content"]
        message = {
            "role": "assistant",
            "content": [
                *content("preserved" if previous else "first"),
                {"type": "future-part", "payload": ["unchanged"]},
            ],
            "stop": "finished",
            "usage": {"input": 2, "output": 1, "cacheRead": 0, "cacheWrite": 0, "cost": 0},
            "futureResponse": {"kept": True},
            "providerData": {"opaque": "not text"},
        }
        await self.peer.request(
            "host/hook",
            {
                "parentRequestId": key,
                "hook": "provider.response",
                "payload": {**payload, "message": message},
            },
        )
        return message

    async def available(self, p, key):
        return {"available": True}

    async def discard(self, p, key):
        return {}

    async def list_tools(self, p, key):
        extra = (
            [
                {
                    "name": "in-" + p["sessionId"],
                    "description": "Session tool",
                    "parameters": {"type": "object"},
                }
            ]
            if self.config.get("perSession") and p.get("sessionId")
            else []
        )
        if p.get("sessionId") and p["sessionId"] in self.changed_sessions:
            extra.append(
                {"name": "added", "description": "Added", "parameters": {"type": "object"}}
            )
        return {"tools": self.tools + extra}

    async def handle(self, p, key):
        hook, value = p["hook"], p["payload"]
        if hook == "output":
            blocked = self.config.get("blockMethod")
            if blocked and any(
                e["type"] == "reply" and e["data"]["method"] == blocked for e in value["events"]
            ):
                raise WireError("Gate failed", "internal")
            if self.config.get("redactProblem"):
                for event in value["events"]:
                    if event["type"] == "python.plugin_problem":
                        assert event["data"]["message"] == "carried on"
                        event["data"]["message"] = "gated diagnostic"
                return {"events": value["events"]}
        if hook == "turn.end" and self.config.get("turnEnd"):
            from pathlib import Path

            with Path(self.config["turnEnd"]).open("a") as log:
                log.write(json.dumps(value) + "\n")
            return None
        if hook == "turn.result":
            if self.config.get("resultMode") == "change":
                return {"change": {**value, "result": {"text": "CHANGED"}}}
            self.result_count = getattr(self, "result_count", 0) + 1
            if self.result_count == 1 and value["result"]["text"] == "CHANGED":
                return {"refuse": "TRY-AGAIN"}
            return None
        if hook == "tool.before" and self.config.get("hijack"):
            value["call"].update(
                actorId="intruder", authority=["tools", "approve"], initiator="plugin"
            )
            return {"change": {"call": value["call"]}}
        if hook == "step.before":
            value["request"]["systemPrompt"] += "\nWIRE-STEP"
            return {"value": value}
        if hook == "provider.request":
            value["request"]["systemPrompt"] += "\nWIRE-PROVIDER"
            return {"value": value}
        if hook == "tool.after":
            value["result"]["content"] = content("WIRE-AFTER")
            return {"value": value}
        if hook == "step.after":
            return {"refuse": "WIRE-STEP-REFUSAL"}
        if hook == "turn.before":
            return {"context": content("WIRE-CONTEXT")}
        if hook == "input":
            value["content"] = content("WIRE-INPUT")
            return {"value": value}
        return None

    async def run(self, p, key):
        operation = p.get("args") or p.get("call", {}).get("input", {}).get(
            "operation", "callbacks"
        )
        sid = p["sessionId"]

        async def host(method, **params):
            scope = {} if method == "credentials/read" else {"parentRequestId": key}
            if method.startswith("env/"):
                scope["sessionId"] = sid
            return await self.peer.request("host/" + method, {**scope, **params})

        if operation == "late-question":
            answer = await host(
                "ask",
                request={
                    "kind": "text",
                    "question": "Which?",
                    "timeLimitMs": 0,
                    "whenTimeLimit": "leaveOpen",
                },
            )
            assert answer["pending"] is True
            return {"pending": "Waiting for fixture answer"}
        if operation == "end-job":
            start = await host("jobs/start", kind="check", detail={})
            jid = start["jobId"]
            await self.peer.request(
                "host/jobs/end",
                {
                    "jobId": jid,
                    "outcome": {"kind": "completed"},
                    "result": content("offline job report"),
                    "report": True,
                },
            )
            es = (await host("history", sessionId=sid, all=True))["entries"]
            started = next(e for e in es if e["kind"] == "jobStarted" and e["jobId"] == jid)
            accepted = next(
                e
                for e in es
                if e["kind"] == "inputAccepted" and e["data"].get("key") == "job:" + jid
            )
            return {
                "output": json.dumps(
                    {"rights": started["data"]["rights"], "accepted": accepted["data"]["content"]}
                )
            }
        if operation == "page-edge":
            page = await host("history", sessionId=sid, after=self.config["after"])
            return {
                "output": json.dumps(
                    {"ids": [e["id"] for e in page["entries"]], "next": page.get("next")}
                )
            }
        if operation == "read-error":
            session = await host("session", sessionId=sid)
            try:
                await host("env/read", cwd=session["project"], path="AGENTS.md")
            except WireError as exc:
                return {"output": json.dumps({"code": exc.code, "message": str(exc)})}
            raise AssertionError("Expected env/read to fail")
        if operation == "large":
            return {"output": "x" * (64 * 1024 * 1024)}
        if operation == "change":
            if self.config.get("perSession"):
                self.changed_sessions.add(sid)
            else:
                self.tools.append(
                    {"name": "added", "description": "Added", "parameters": {"type": "object"}}
                )
            await self.peer.notify(
                "tools/changed", {"toolSource": "probes", "parentRequestId": key}
            )
            value = {"changed": True}
        elif operation == "die":
            # Die while the host is running a command for this tool. EOF must cancel it.
            task = asyncio.create_task(
                host("env/exec", cwd=self.config["project"], command="echo $$ > lost-pid; sleep 60")
            )
            await asyncio.sleep(0.2)
            os._exit(7)
            await task
        else:
            session = await host("session", sessionId=sid)
            declaration = await host("declaration", sessionId=sid)
            history = await host("history", sessionId=sid, limit=2)
            question = await host("ask", request={"kind": "text", "question": "Unattended?"})
            credential = await host("credentials/read", provider="fixture")
            foreign = None
            try:
                await host("credentials/read", provider="claude")
            except Exception as exc:
                foreign = exc.code
            await host("env/write", cwd=session["project"], path="binary", data="AP+A")
            binary = await host("env/read", cwd=session["project"], path="binary")
            exists = await host("env/exists", cwd=session["project"], path="binary")
            executed = await host("env/exec", cwd=session["project"], command="printf CALLBACK")
            timed = await host(
                "env/exec",
                cwd=session["project"],
                command="printf BEFORE; sleep 60",
                timeoutMs=1000,
            )
            denied = []
            for method, params in [
                (
                    "env/exec",
                    {
                        "parentRequestId": "forged",
                        "cwd": session["project"],
                        "command": "touch forbidden",
                    },
                ),
                ("hook", {"hook": "provider.request", "payload": {}}),
                ("session", {"sessionId": "not-open"}),
            ]:
                try:
                    await host(method, **params)
                except Exception as exc:
                    denied.append(exc.code)
            await self.peer.notify(
                "host/emit", {"sessionId": sid, "type": "wire-event", "data": {"ok": True}}
            )
            await self.peer.notify("host/problem", {"where": "fixture", "message": "carried on"})
            value = {
                "session": session,
                "declaration": declaration,
                "history": history,
                "question": question,
                "credential": credential,
                "foreign": foreign,
                "binary": binary,
                "exists": exists,
                "exec": executed,
                "timed": timed,
                "denied": denied,
            }
        return (
            {"output": json.dumps(value)}
            if "args" in p
            else {"status": "completed", "content": content(json.dumps(value)), "value": value}
        )


asyncio.run(Fixture().serve())
