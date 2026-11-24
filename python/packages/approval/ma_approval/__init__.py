"""Approval policy is a feature plugin, not a Runtime policy."""

import json

from ma_core import Plugin, clone
from ma_core.wire import call_out, tool_out


class Approval(Plugin):
    name = "approval"
    declarations = {"policies": ["ask unless read-only", "ask always", "never ask, refuse", "off"]}

    def __init__(self, *, covers_nested=False):
        if covers_nested:
            self.declarations = {**self.declarations, "covers_nested": True}

    async def start(self, api):
        await super().start(api)
        api.on("tool.before", self.check, "last")

    async def check(self, d):
        s = await self.api.session("get", session=d["session"], include_entries=False)
        policy = s["settings"].get("approval", "off")
        tool = d.get("definition") or {}
        call = d["call"]
        covers = self.declarations.get("covers_nested") and not call.get("parentCallId")
        binding = json.dumps({"name": call["name"], "input": call["input"]}, sort_keys=True)
        question = "Allow tool call: " + binding
        if covers:
            question += "\nThis allow covers the nested calls this tool makes during this dispatch."
        if s["settings"].get("approvalWait") == "untilDeadline":
            ask = policy == "ask always" or (
                policy == "ask unless read-only" and not tool.get("hints", {}).get("read_only")
            )
            waiting = await self.api.session(
                "waiting_gate",
                gate=d,
                ask=ask,
                session=d["session"],
                question=question,
                covers_nested=bool(covers),
            )
            if waiting is not None:
                return waiting
        if policy == "off" or (
            policy == "ask unless read-only" and tool.get("hints", {}).get("read_only")
        ):
            return d
        if policy == "never ask, refuse":
            return {**d, "refused": True, "reason": "Approval policy refuses without asking"}
        if policy not in {"ask unless read-only", "ask always"}:
            return {**d, "refused": True, "reason": "Unknown approval policy"}
        if d.get("covered_by") and call.get("parentCallId"):
            return d  # Only this approval check is satisfied.
        answer = await self.api.call(
            "questions",
            "ask",
            {
                "session": d["session"],
                "kind": "approval",
                "question": question,
                **({"coversNested": True} if covers else {}),
                "call": call["id"],
                "turn": d.get("turn"),
                "step": d.get("step"),
                "actor": call["actor"],
                "authority": call.get("authority"),
                "key": "approval:" + call["id"] + ":" + binding,
                "binding": binding,
                "approval_call": {"name": call["name"], "input": clone(call["input"])},
                **(
                    {
                        "approval_registration": {
                            "call": call_out(call),
                            "source": d.get("source", {"plugin": "files", "toolSource": "files"}),
                            "definition": tool_out(tool),
                        }
                    }
                    if tool
                    else {}
                ),
                "timeout": s["settings"].get("approval_timeout"),
                "park": False,
            },
        )
        if answer.get("open"):
            return {**d, **answer}
        valid = answer.get("request") and await self.api.call(
            "questions", "valid_answer", {"session": d["session"], "request": answer["request"]}
        )
        if answer.get("value") != "allow" or not valid:
            return {**d, "refused": True, "reason": "Approval not explicitly allowed"}
        return {
            **d,
            "checked_input": clone(call["input"]),
            **({"covering_request": answer["request"]} if covers else {}),
        }
