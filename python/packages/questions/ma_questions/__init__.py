"""Recorded keyed input requests. Raw secret values never enter this plugin."""

import asyncio
import json

from ma_core import AgentError, Plugin, content, identity

ASK_USER = {
    "name": "ask_user",
    "description": "Ask the user for approval, a choice, free text or a named secret.",
    "schema": {
        "type": "object",
        "properties": {
            "question": {"type": "string"},
            "kind": {"enum": ["approval", "choice", "text", "secret"]},
            "options": {"type": "array", "items": {"type": "string"}},
            "name": {"type": "string"},
            "timeout": {"type": "number", "minimum": 0},
            "key": {"type": "string"},
        },
        "required": ["question"],
        "additionalProperties": False,
    },
    "hints": {"safe_to_repeat": True},
    "parallel": True,
    "callers": ["model", "interface", "plugin"],
    "target": "questions",
}


class Questions(Plugin):
    name = "questions"
    role = "tool_source"
    declarations = {
        "recorded_questions": True,
        "several_actors": True,
        "secret_intake": "credentials.answer",
    }

    def __init__(self):
        self.connected = {}
        self.signals = {}

    async def start(self, api):
        await super().start(api)
        api.provide("questions", self)
        api.on("tools.list", self.definitions)
        api.on("session.start", self.recover)
        api.on("session.ready", self.announce_parked)
        api.on("session.end", self.close)
        api.on("session.moving", self.close)
        api.on("session.invalidate", self.invalidate)

    async def definitions(self, d):
        return [ASK_USER]

    async def connect(self, d, emit):
        s = await self.api.session("get", session=d["session"], actor=d.get("actor", "user"))
        actor = d.get("actor", s["actor"])
        self.connected.setdefault(s["id"], set()).add(actor)
        return {}

    async def present(self, d, emit):
        return sorted(self.connected.get(d["session"], set()))

    async def disconnect(self, d, emit):
        sid = d["session"]
        self.connected.get(sid, set()).discard(d.get("actor", "user"))
        for q in (await self._state(sid)).values():
            if (
                not q.get("answer")
                and not q.get("closed")
                and (q["kind"] == "approval" or q.get("timeout") is None)
            ):
                if not any(
                    [await self._eligible(sid, q, a) for a in self.connected.get(sid, set())]
                ):
                    await self._accept(sid, q, q["actor"], "declined", "noLongerAnswerable")
        return {}

    async def _state(self, sid):
        es = await self.api.session("branch", session=sid)
        requests = {
            e["data"]["id"]: {**e["data"], "entry": e["id"]}
            for e in es
            if e["kind"] == "question_open"
        }
        for e in es:
            if e["kind"] in {"question_answer", "question_closed"}:
                q = requests.get(e["data"]["request"])
                if q:
                    q["answer" if e["kind"] == "question_answer" else "closed"] = e["data"]
        return requests

    async def _eligible(self, sid, q, actor, ceiling=None):
        allowed = await self.api.session("authority", session=sid, actor=actor, ceiling=ceiling)
        responders = q.get("restrictedResponders")
        return (responders is None or actor in responders) and (
            "approve" if q["kind"] == "approval" else "answer"
        ) in allowed

    async def list(self, d, emit):
        qs = await self._state(d["session"])
        return [
            {
                **q,
                "answerable": "answer" not in q
                and "closed" not in q
                and (
                    not d.get("recipientView")
                    or "actor" not in d
                    or await self._eligible(d["session"], q, d["actor"], d.get("authority"))
                ),
            }
            for q in qs.values()
        ]

    async def _record(self, sid, kind, data, actor=None):
        es = await self.api.session("branch", session=sid)
        copies = [
            e["id"]
            for e in es
            if (
                kind == "question_open"
                and data.get("call")
                and e["kind"] == "tool_call"
                and e.get("call") == data["call"]
            )
            or (
                kind == "question_answer"
                and e["kind"] == "question_open"
                and e["data"]["id"] == data["request"]
            )
        ]
        if kind == "question_open" and data.get("child"):
            child = data["child"]
            copies.extend(
                e["id"]
                for e in await self.api.session("branch", session=child["session"])
                if e["kind"] == "question_open" and e["data"]["id"] == child["request"]
            )
        return await self.api.session(
            "append",
            session=sid,
            kind=kind,
            writer=self.name,
            data=data,
            copies=copies,
            **{k: data[k] for k in ("call", "turn", "step") if data.get(k)},
            **({"actor": actor} if actor else {}),
        )

    async def _publish(self, sid, q):
        await self.api.event("input_request_opened", session=sid, request={**q, "answerable": True})
        s = await self.api.session("get", session=sid)
        parent = (s.get("origin") or {}).get("parent")
        if parent:
            for proxy in (await self._state(parent)).values():
                if (
                    proxy.get("child") == {"session": sid, "request": q["id"]}
                    and not proxy.get("answer")
                    and not proxy.get("closed")
                ):
                    await self._publish(parent, proxy)

    async def _open(self, d):
        sid = d["session"]
        s = await self.api.session("get", session=sid)
        actor = d.get("actor", s["actor"])
        kind = d.get("kind", "text")
        if kind not in {"approval", "choice", "text", "secret"}:
            raise AgentError("Unknown question kind")
        if kind == "choice" and not d.get("options"):
            raise AgentError("A choice needs options")
        if kind == "secret":
            declarations = await self.api.session("declaration", session=sid)
            if (
                not d.get("name")
                or d["name"] == "claude_login"
                or not any(p.get("stores_secrets") for p in declarations.values())
            ):
                return None
        asker = d.get("_caller", self.name)
        key = d.get("key") or ("call:" + d["call"] + ":1" if d.get("call") else identity())
        details = {
            "kind": kind,
            "question": d["question"],
            "options": ["allow", "refuse"] if kind == "approval" else d.get("options", []),
            "name": d.get("name"),
            "binding": d.get("binding"),
            **{k: d[k] for k in ("approval_call", "approval_registration") if k in d},
        }
        signature = json.dumps(details, sort_keys=True)
        for q in reversed(list((await self._state(sid)).values())):
            if q["key"] != key or (not key.startswith("call:") and q["asker"] != asker):
                continue
            if q["signature"] != signature:
                raise AgentError("Question key reused for different details")
            if "answer" in q and await self._eligible(sid, q, q["answer"]["actor"]):
                return q
            if "closed" not in q and "answer" not in q:
                await self._sync_parent(sid, q)
                current = (await self._state(sid))[q["id"]]
                if not current.get("answer") and not current.get("closed"):
                    await self._publish(sid, current)
                return (await self._state(sid))[q["id"]]
            break
        authority = await self.api.session(
            "authority", session=sid, actor=actor, ceiling=d.get("authority")
        )
        q = {
            **details,
            "id": identity(),
            "key": key,
            "signature": signature,
            "asker": asker,
            "actor": actor,
            "authority": authority,
            "responders": d.get("responders", list(s["actors"])),
            "restrictedResponders": d.get("responders"),
            "call": d.get("call"),
            "turn": d.get("turn"),
            "step": d.get("step"),
            "timeout": d.get("timeout"),
            "park": d.get("park", True),
            "child": d.get("child"),
        }
        self.signals[(sid, q["id"])] = asyncio.Event()
        await self._record(sid, "question_open", q, actor)
        await self._publish(sid, q)
        origin = s.get("origin") or {}
        if origin.get("parent"):
            parent = await self._open(
                {
                    **details,
                    "session": origin["parent"],
                    "actor": origin["actor"],
                    "authority": authority,
                    "key": "forward:" + sid + ":" + q["id"],
                    "_caller": "forward:" + sid,
                    "child": {"session": sid, "request": q["id"]},
                    "timeout": d.get("timeout"),
                    "park": d.get("park", True),
                }
            )
            if parent is None:
                await self._accept(sid, q, actor, "declined")
            elif parent.get("answer"):
                await self._accept(sid, q, actor, parent["answer"]["value"])
        elif kind == "approval" or d.get("timeout") is None:
            present = self.connected.get(sid, set())
            if not any([await self._eligible(sid, q, a) for a in present]):
                await self._accept(
                    sid,
                    q,
                    actor,
                    "declined",
                    "refused" if kind == "approval" else "noLongerAnswerable",
                )
        return (await self._state(sid))[q["id"]]

    async def ask(self, d, emit):
        sid = d["session"]
        q = await self._open(d)
        if q is None:
            return {"value": "declined"}
        if q.get("answer"):
            return q["answer"]
        if q["kind"] == "approval" and not any(
            [await self._eligible(sid, q, a) for a in self.connected.get(sid, set())]
        ):
            await self._accept(sid, q, q["actor"], "declined", "refused")
            return {"value": "declined"}
        signal = self.signals.setdefault((sid, q["id"]), asyncio.Event())
        try:
            async with asyncio.timeout(d.get("timeout")):
                while True:
                    current = (await self._state(sid)).get(q["id"])
                    if not current or current.get("closed"):
                        return {"value": "declined"}
                    if current.get("answer"):
                        return current["answer"]
                    await signal.wait()
                    signal.clear()
        except TimeoutError:
            if d.get("park", True):
                return {"open": True, "request": q["id"]}
            await self._accept(sid, q, q["actor"], "declined", "timeLimit")
            return {"value": "declined", "reason": "timeLimit", "request": q["id"]}

    async def valid_answer(self, d, emit):
        q = (await self._state(d["session"])).get(d["request"])
        return bool(
            q
            and q.get("answer")
            and not q.get("closed")
            and await self._eligible(d["session"], q, q["answer"]["actor"])
        )

    async def validate(self, d, emit):
        q = (await self._state(d["session"])).get(d["request"])
        if not q or q.get("answer") or q.get("closed"):
            raise AgentError("Question is closed or no longer answerable", "refused")
        if not await self._eligible(d["session"], q, d["actor"], d.get("authority")):
            raise AgentError(
                "Actor may see this question but lacks authority to answer it", "forbidden"
            )
        return q

    async def answer(self, d, emit):
        q = await self.validate(d, emit)
        if q["kind"] == "secret" and d.get("value") != "declined":
            raise AgentError("Secret answers must go directly to the credential store", "forbidden")
        value = d.get("value") if d.get("value") is not None else "declined"
        if not isinstance(value, str) or (
            q["kind"] in {"approval", "choice"} and value not in [*q["options"], "declined"]
        ):
            raise AgentError("Answer is not one of the offered options")
        accepted = await self._accept(d["session"], q, d["actor"], value, d.get("reason"))
        if accepted is False:
            raise AgentError("Question is closed or no longer answerable", "refused")
        return {"accepted": True}

    async def record_secret(self, d, emit):
        if d.get("_caller_role") != "credential_store":
            raise AgentError("Only the credential store can confirm secret intake", "forbidden")
        q = await self.validate(d, emit)
        if q["kind"] != "secret" or q["name"] != d["name"]:
            raise AgentError("Credential name does not match")
        if not await self._accept(d["session"], q, d["actor"], {"credential": d["name"]}):
            raise AgentError("Question is closed or no longer answerable", "refused")
        return {"accepted": True, "credential": d["name"]}

    async def _accept(self, sid, q, actor, value, reason=None):
        if q["kind"] == "approval" and value == "refuse":
            value = "declined"
        current = (await self._state(sid)).get(q["id"])
        if not current or current.get("answer") or current.get("closed"):
            return False
        answer = {
            "request": q["id"],
            "value": value,
            "actor": actor,
            **({"reason": reason} if reason else {}),
            **{k: q[k] for k in ("call", "turn", "step") if q.get(k)},
        }
        try:
            await self._record(sid, "question_answer", answer, actor)
        except AgentError as exc:
            if exc.code == "refused":
                return False
            raise
        self.signals.setdefault((sid, q["id"]), asyncio.Event()).set()
        await self.api.event("input_request_answered", session=sid, answer=answer)
        child = q.get("child")
        if child:
            try:
                cq = (await self._state(child["session"])).get(child["request"])
            except AgentError:
                cq = None  # Its parent answer is durable; intake syncs it on reopen.
            if cq and not cq.get("answer") and not cq.get("closed"):
                if not await self._eligible(child["session"], cq, cq["actor"]):
                    value = "declined"
                await self._accept(child["session"], cq, cq["actor"], value)
        if q.get("call"):
            await self.api.call("runtime", "wake", {"session": sid})
        return True

    async def run(self, d, emit):
        c = d["call"]
        answer = await self.ask(
            {
                **c["input"],
                "session": d["session"],
                "call": c["id"],
                "actor": c["actor"],
                "authority": c.get("authority"),
                "turn": d.get("turn"),
                "step": d.get("step"),
                "_caller": self.name,
                "key": c["input"].get("key", "call:" + c["id"] + ":1"),
            },
            emit,
        )
        if answer.get("open"):
            return answer
        return {
            "call": c["id"],
            "status": "completed",
            "content": content(json.dumps(answer["value"])),
            "value": answer["value"],
        }

    async def _sync_parent(self, sid, q):
        s = await self.api.session("get", session=sid)
        parent = (s.get("origin") or {}).get("parent")
        if not parent:
            return
        for proxy in (await self._state(parent)).values():
            if proxy.get("child") != {"session": sid, "request": q["id"]}:
                continue
            if proxy.get("answer"):
                value = proxy["answer"]["value"]
                if not await self._eligible(
                    parent, proxy, proxy["answer"]["actor"]
                ) or not await self._eligible(sid, q, q["actor"]):
                    value = "declined"
                await self._accept(sid, q, q["actor"], value)
            elif proxy.get("closed"):
                await self._close_question(sid, q)
            return

    async def announce_parked(self, d):
        es = await self.api.session("branch", session=d["session"])
        deferred = {e["call"] for e in es if e["kind"] == "tool_deferred"}
        for q in (await self._state(d["session"])).values():
            if (
                not q.get("answer")
                and not q.get("closed")
                and (q.get("child") or q.get("call") in deferred)
            ):
                await self._publish(d["session"], q)

    async def recover(self, d):
        sid = d["session"]
        declarations = await self.api.session("declaration", session=sid)
        durable = any(p.get("durable") for p in declarations.values() if "parallel_tools" in p)
        es = await self.api.session("branch", session=sid)
        deferred = {e["call"] for e in es if e["kind"] == "tool_deferred"}
        for q in (await self._state(sid)).values():
            if (
                not durable
                and not q.get("answer")
                and not q.get("closed")
                and not q.get("child")
                and q.get("call") not in deferred
            ):
                await self._close_question(sid, q)
            elif not q.get("answer") and not q.get("closed"):
                await self._sync_parent(sid, q)

    async def _close_question(self, sid, q, reason="noLongerAnswerable"):
        try:
            await self._record(
                sid,
                "question_closed",
                {
                    "request": q["id"],
                    "reason": reason,
                    **{k: q[k] for k in ("call", "turn", "step") if q.get(k)},
                },
            )
        except AgentError as exc:
            if exc.code == "refused":
                return
            raise
        self.signals.setdefault((sid, q["id"]), asyncio.Event()).set()
        await self.api.event("input_request_unanswerable", session=sid, request=q["id"])
        s = await self.api.session("get", session=sid)
        parent = (s.get("origin") or {}).get("parent")
        if parent:
            for proxy in (await self._state(parent)).values():
                if (
                    proxy.get("child") == {"session": sid, "request": q["id"]}
                    and not proxy.get("answer")
                    and not proxy.get("closed")
                ):
                    await self._close_question(parent, proxy)

    async def close(self, d):
        for q in (await self._state(d["session"])).values():
            if not q.get("answer") and not q.get("closed"):
                await self._close_question(d["session"], q, "cancelled")
        self.connected.pop(d["session"], None)

    async def invalidate(self, d):
        if d.get("reason") == "cancelled":
            for q in (await self._state(d["session"])).values():
                if q.get("call") and not q.get("answer") and not q.get("closed"):
                    await self._close_question(d["session"], q)
        elif d.get("reason") == "move":
            await self.close(d)
