"""Run a tool's nested calls inside its live dispatch, and record a result for each."""

import asyncio

from ma_core import AgentError, clone, content, identity, silent
from ma_core.wire import recorded_as


class NestedTools:
    MAX_TOOL_DEPTH = 4

    async def nested_tools(self, token, name=None, arguments=None):
        scope = self.tool_dispatches.get(token)
        if scope is None or scope["closing"]:
            raise AgentError("Nested tools need a live dispatched parent", "invalid_request")
        runtime = self.capabilities.get("runtime", (None, None))[0]
        if runtime is None or not self.plugins[runtime].declarations.get("nested_tools"):
            raise AgentError("Nested calls are unavailable", "not_supported")
        parent = scope["data"]
        sid, turn, step = (parent.get(k) for k in ("session", "turn", "step"))
        source = parent["call"]

        async def definitions():
            return await self.call("@harness", "tools", "definitions", {"session": sid})

        if name is None:
            return [t for t in await definitions() if "plugin" in t.get("callers", [])]
        if not isinstance(name, str) or not name or not isinstance(arguments, dict):
            raise AgentError("Nested tools need a name and object input", "invalid_request")
        depth = source.get("nesting_depth", 1) + 1
        call = {
            "id": identity(),
            "name": name,
            "input": clone(arguments),
            "actor": source["actor"],
            "authority": source.get("authority"),
            "initiator": "tool",
            "parentCallId": source["id"],
            "nesting_depth": depth,
        }

        async def run():
            answer = None
            try:
                await self.handle(
                    "append",
                    {
                        "session": sid,
                        "turn": turn,
                        "step": step,
                        "actor": call["actor"],
                        "kind": "tool_call",
                        "call": call["id"],
                        "data": call,
                        "writer": "@harness",
                    },
                    silent,
                )
                if depth > self.MAX_TOOL_DEPTH:
                    answer = {
                        "status": "refused",
                        "content": content("Tool nesting depth exceeded"),
                    }
                else:
                    definition = next((t for t in await definitions() if t["name"] == name), None)
                    answer = await self.call(
                        "@harness",
                        "runtime",
                        "dispatch_nested",
                        {
                            "session": sid,
                            "turn": turn,
                            "step": step,
                            "call": call,
                            "definition": definition,
                            "covered_by": scope["covering_approval"],
                        },
                    )
                    if answer.get("open"):
                        await self._close_nested_questions(sid, call["id"])
                        answer = {
                            "status": "refused",
                            "content": content("Nested calls cannot be left open"),
                        }
            finally:
                if sid in self.sessions and not self.sessions[sid].get("suspending"):
                    await self._settle_nested(sid, only=call["id"], answer=answer, cancelled=True)
            return {**answer, "call": call["id"]}

        task = asyncio.create_task(run(), name="nested-tool:" + call["id"])
        scope["children"].add(task)
        try:
            return await task
        finally:
            scope["children"].discard(task)

    async def _close_nested_questions(self, sid, call):
        if "questions" in self.capabilities:
            await self.call("@harness", "questions", "close_call", {"session": sid, "call": call})

    async def _settle_nested(self, sid, *, only=None, answer=None, cancelled=False):
        entries = self.sessions[sid]["entries"]
        results = {e.get("call") for e in entries if recorded_as(e, "tool_result")}
        starts = {e["call"] for e in entries if e["kind"] == "tool_started"}
        receipts = {e["call"]: e["data"] for e in entries if e["kind"] == "tool_finished"}
        for e in reversed(entries):
            if e["kind"] != "tool_call" or not e["data"].get("parentCallId"):
                continue
            cid = e["call"]
            if cid in results or (only is not None and cid != only):
                continue
            await self._close_nested_questions(sid, cid)
            result = answer or receipts.get(cid)
            if result is None:
                status = (
                    ("cancelled" if cancelled else "outcome_unknown")
                    if cid in starts
                    else "not_started"
                )
                result = {
                    "status": status,
                    "content": content(
                        {
                            "cancelled": "Tool call cancelled",
                            "outcome_unknown": "Tool outcome unknown after interruption",
                            "not_started": "Tool call did not start",
                        }[status]
                    ),
                }
            await self.handle(
                "append",
                {
                    "session": sid,
                    "turn": e.get("turn"),
                    "step": e.get("step"),
                    "actor": e["data"]["actor"],
                    "kind": "tool_result",
                    "call": cid,
                    "content": result["content"],
                    "copies": [e["id"]],
                    "writer": "@harness",
                    "data": {
                        **{k: v for k, v in result.items() if k not in {"call", "content"}},
                        "toolName": e["data"]["name"],
                        "parentCallId": e["data"]["parentCallId"],
                    },
                },
                silent,
            )
