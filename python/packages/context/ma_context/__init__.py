"""Context is a view. Compaction appends a copy-tracked summary and erases nothing."""

import json

from ma_core import AgentError, Plugin


def in_call_order(entries):
    """Keep the record in completion order but give the model each round in call order."""
    results = {e["call"]: e for e in entries if e["kind"] == "tool_result"}
    ordered = {}
    for e in entries:
        if e["kind"] != "response":
            continue
        rs = [results[c["id"]] for c in e["data"].get("calls", []) if c["id"] in results]
        ordinary = [r for r in rs if not r["data"].get("late") and r.get("turn") == e.get("turn")]
        if ordinary:
            ordered[e["id"]] = ordinary
    moved = {r["id"] for rs in ordered.values() for r in rs}
    return [
        item for e in entries if e["id"] not in moved for item in (e, *ordered.get(e["id"], ()))
    ]


class Context(Plugin):
    name = "context"

    async def start(self, api):
        await super().start(api)
        api.provide("context", self)
        api.define_hook("context.compacting", "observe")
        api.on("step.before", self.prepare)
        api.on("model.failed", self.failed)
        api.command("compact", "Summarize older history without deleting it", self.command)

    @staticmethod
    def _view(branch):
        visible = [
            e
            for e in branch
            if e.get("visible")
            and not (
                e["kind"] == "response"
                and e["data"].get("stop") in {"failed", "aborted"}
                and not e["content"]
                and not e["data"].get("calls")
            )
        ]
        summaries = [e for e in visible if e["kind"] == "summary"]
        covered = set()
        if summaries:
            latest = summaries[-1]
            covered.update(latest["data"]["covers"])
        view = in_call_order([e for e in visible if e["id"] not in covered])
        done = {e["call"] for e in branch if e["kind"] == "tool_result"}
        for e in branch:
            if e["kind"] == "tool_call" and e["call"] not in done:
                view.append(
                    {
                        **e,
                        "id": e["id"] + ":waiting",
                        "kind": "waiting",
                        "content": [
                            {"type": "text", "text": "Tool call is still waiting for an answer."}
                        ],
                        "data": {"call": e["call"], "status": "waiting"},
                    }
                )
        return view

    def _messages(self, entries):
        return (
            [
                {
                    "id": e["id"],
                    "role": (
                        "assistant"
                        if e["kind"] == "response"
                        else "tool"
                        if e["kind"] == "tool_result"
                        else "user"
                    ),
                    "kind": e["kind"],
                    "content": e["content"],
                    "data": e.get("data", {}),
                    **({"call": e["call"]} if "call" in e else {}),
                }
                for e in entries
                if e["kind"] != "tool_call"
            ]
            + [
                # Tool calls are also separate messages, preserving IDs and schemas.
            ]
        )

    async def prepare(self, d):
        sid = d["session"]
        branch = await self.api.session("context_records", session=sid, turn=d.get("turn"))
        view = self._view(branch)
        budget = d["settings"].get("context_budget", int(d["access"]["context_window"] * 0.75))
        if len(json.dumps(view)) // 4 > budget:
            await self.compact({"session": sid, "access": d["access"]}, None)
            branch = await self.api.session("context_records", session=sid, turn=d.get("turn"))
            view = self._view(branch)
        messages = [
            {"kind": "context", "content": a["context"], "data": {}}
            for a in d["additions"]
            if a.get("context")
        ]
        for e in view:
            messages.append(
                {
                    "id": e["id"],
                    "kind": e["kind"],
                    "content": e["content"],
                    "data": e.get("data", {}),
                    **({"call": e["call"]} if "call" in e else {}),
                }
            )
        for entry in reversed(branch):
            if entry.get("turn") != d.get("turn"):
                continue
            if entry["kind"] == "model_started":
                break
            if entry["kind"] == "result_feedback":
                feedback = {
                    "id": entry["id"],
                    "kind": "result_feedback",
                    "content": [{"type": "text", "text": entry["data"]["reason"]}],
                }
                messages.append(feedback)
        return {
            **d,
            "system": "\n\n".join(a.get("system", "") for a in d["additions"]),
            "messages": messages,
            "provider_tools": False,
        }

    async def compact(self, d, emit):
        sid = d["session"]
        view = self._view(await self.api.session("context_records", session=sid))
        if not view:
            return {"summary": None}
        await self.api.hook("context.compacting", {"session": sid})
        # Prefer older complete turns. A single overlarge turn is summarized as a whole
        # at a step boundary, where all its tool calls have already been settled.
        last_input = max((i for i, e in enumerate(view) if e["kind"] == "input"), default=0)
        older = view[:last_input] if last_input else view
        access = d.get("access") or await self.api.call("selection", "access", {"session": sid})
        response = await self.api.call(
            access["target"],
            "generate",
            {
                "session": sid + ":summary",
                "purpose": "summary",
                "access": access,
                "system": "Summarize this agent history accurately. Preserve task, facts, paths, "
                "tool outcomes and unfinished work. Do not call tools.",
                "messages": older,
                "tools": [],
                "settings": {"thinking": "off"},
                "provider_tools": False,
            },
        )
        if response.get("calls") or response.get("stop") in {"failed", "refused"}:
            raise AgentError("Summary request failed")
        covers = list(
            dict.fromkeys(
                [e["id"] for e in older]
                + [x for e in older if e["kind"] == "summary" for x in e["data"]["covers"]]
            )
        )
        summary = await self.api.session(
            "append",
            session=sid,
            kind="summary",
            visible=True,
            writer=self.name,
            content=response["content"],
            copies=[e["id"] for e in older],
            data={"covers": covers},
        )
        await self.api.session("invalidate", session=sid, reason="compaction")
        return {"summary": summary["id"]}

    async def failed(self, d):
        if d["code"] == "context_too_large":
            await self.compact({"session": d["session"], "access": d["access"]}, None)
            return {"retry": True}
        return None

    async def command(self, d):
        s = await self.api.session("get", session=d["session"], include_entries=False)
        if s.get("busy"):
            raise AgentError("Compact only between turns")
        return await self.compact(d, None)
