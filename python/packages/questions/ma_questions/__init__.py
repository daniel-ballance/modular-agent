"""Recorded keyed input requests. Raw secret values never enter this plugin."""

import asyncio
import json
from datetime import UTC, datetime, timedelta

from ma_core import telemetry as ot
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


def question_state(entries):
    requests = {}
    for entry in entries:
        if entry["kind"] == "question_open":
            q = {**entry["data"], "entry": entry["id"]}
            if q.get("approvalWait") == "untilDeadline":
                q["deadline"] = q.get("deadlineAt")
            elif q.get("timeout") is not None:
                q["deadline"] = (
                    datetime.fromisoformat(entry["time"]) + timedelta(seconds=q["timeout"])
                ).isoformat()
            requests[q["id"]] = q
        else:
            state = {
                "question_answer": "answer",
                "question_closed": "closed",
                "secret_answer_accepted": "selected",
            }.get(entry["kind"])
            if state and (q := requests.get(entry["data"]["request"])):
                q[state] = entry["data"]
    return requests


def eligible_question(q, actor, rights):
    responders = q.get("restrictedResponders")
    return (responders is None or actor in responders) and (
        "approve" if q["kind"] == "approval" else "answer"
    ) in rights


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
        self.route_eligibility = {}
        self.signals = {}
        self.wait_for_unconnected = False

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
        self.connected.setdefault(s["id"], {}).setdefault(actor, set()).add(d.get("route"))
        return {}

    async def present(self, d, emit):
        return sorted(self.connected.get(d["session"], {}))

    async def disconnect(self, d, emit):
        sid = d["session"]
        actor = d.get("actor", "user")
        routes = self.connected.get(sid, {}).get(actor)
        if routes is not None:
            if d.get("all_routes"):
                routes.clear()
            else:
                routes.discard(d.get("route"))
            if not routes:
                del self.connected[sid][actor]
        for q in (await self._state(sid)).values():
            if (
                not q.get("approvalWait")
                and not q.get("answer")
                and not q.get("closed")
                and (
                    q["kind"] == "approval"
                    or (q.get("timeout") is None and not self.wait_for_unconnected)
                )
            ):
                if not await self._answer_route(sid, q):
                    await self._accept(sid, q, q["actor"], "declined", "noLongerAnswerable")
        return {}

    async def _answer_route(self, sid, q):
        for actor, routes in self.connected.get(sid, {}).items():
            if await self._eligible(sid, q, actor) and any(
                route not in self.route_eligibility or self.route_eligibility[route](q)
                for route in routes
            ):
                return True
        return False

    async def _state(self, sid):
        return question_state(await self.api.session("branch", session=sid))

    async def _eligible(self, sid, q, actor, ceiling=None):
        allowed = await self.api.session("authority", session=sid, actor=actor, ceiling=ceiling)
        return eligible_question(q, actor, allowed)

    async def list(self, d, emit):
        sid = d["session"]
        qs = await self._state(sid)
        if d.get("recipientView") and any(q.get("approvalWait") for q in qs.values()):
            await self.api._harness.reconcile_waits(sid)
            qs = await self._state(sid)
        ceiling = d.get("authority")
        if acting := d.get("acting_for"):
            ceiling = await self.api.session(
                "authority", session=sid, actor=acting, ceiling=ceiling
            )
        result = []
        for q in qs.values():
            opened = not {"answer", "closed", "selected"}.intersection(q)
            if not opened and d.get("openOnly"):
                continue
            answerable = opened and (
                not d.get("recipientView")
                or "actor" not in d
                or await self._eligible(sid, q, d["actor"], ceiling)
            )
            if q.get("approvalWait"):
                h = self.api._harness
                s = h.sessions[sid]
                entry = h.waiting_request(s, q["call"])
                answerable = bool(
                    answerable
                    and entry
                    and not any(h.wait_state(s, entry))
                    and h.wait_ended(await self.api.session("branch", session=sid), entry)
                    and h.wait_eligible(
                        s,
                        q,
                        d.get("actor", s["actor"]),
                        d.get("acting_for") or d.get("actor", s["actor"]),
                        ceiling,
                    )
                )
                if "answer" in q:
                    q = {
                        **q,
                        "answer": {k: v for k, v in q["answer"].items() if k != "approvalView"},
                    }
            result.append({**q, "answerable": answerable})
        return result

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
        if kind not in {"approval", "choice", "text", "link", "secret"}:
            raise AgentError("Unknown question kind")
        if kind == "choice" and not d.get("options"):
            raise AgentError("A choice needs options")
        if kind == "secret":
            declarations = await self.api.session("declaration", session=sid)
            if (
                not d.get("name")
                or d["name"] == "claude_login"
                or d["name"] in await self.api.session("credential_names")
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
            **({"details": d["details"]} if d.get("details") is not None else {}),
            **{
                k: d[k]
                for k in ("approval_call", "approval_registration", "coversNested")
                if k in d
            },
        }
        signature = json.dumps(
            {
                **details,
                "responders": d.get("responders"),
                "timeout": d.get("timeout"),
                "park": d.get("park", True),
                "call": d.get("call"),
            },
            sort_keys=True,
        )
        previous = (await self._state(sid)).values()
        if details.get("coversNested") and d.get("call") and asker == "approval":
            # Reopen the same unanswered request, but never spend a covering
            # decision in a repeated or recovered gate attempt.
            key = "approval:" + d["call"] + ":" + identity()
            for q in reversed(list(previous)):
                if (
                    q.get("call") == d["call"]
                    and q["asker"] == asker
                    and not (q.get("closed") or q.get("answer"))
                ):
                    if q.get("signature") == signature:
                        key = q["key"]
                        break
                    await self._close_question(sid, q)
        for q in reversed(list(previous)):
            if q["key"] != key or (not key.startswith("call:") and q["asker"] != asker):
                continue
            signature_matches = q["signature"] == signature
            if not signature_matches:
                # Old sessions recorded the details separately from the wait policy.
                signature_matches = (
                    q["signature"] == json.dumps(details, sort_keys=True)
                    and q.get("restrictedResponders") == d.get("responders")
                    and q.get("timeout") == d.get("timeout")
                    and q.get("park", True) == d.get("park", True)
                    and q.get("call") == d.get("call")
                )
            if not signature_matches:
                raise AgentError("Question key reused for different details")
            if "answer" in q and await self._reusable(sid, q):
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
        ot.question_event("open", sid, q)
        q = (await self._state(sid))[q["id"]]
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
                answer = parent["answer"]
                await self._accept(sid, q, actor, answer["value"], declined=answer.get("declined"))
        else:
            in_turn = kind == "approval" or (
                d.get("timeout") is None and not self.wait_for_unconnected
            )
            eligible = (
                await self._answer_route(sid, q)
                if in_turn
                else any([await self._eligible(sid, q, a) for a in s["actors"]])
            )
            if not eligible:
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
            return {"value": "declined", "declined": True, "reason": "refused"}
        if q.get("answer"):
            return q["answer"]
        if q["kind"] == "approval" and not await self._answer_route(sid, q):
            await self._accept(sid, q, q["actor"], "declined", "refused")
            return {"value": "declined", "declined": True, "reason": "refused"}
        signal = self.signals.setdefault((sid, q["id"]), asyncio.Event())
        try:
            async with asyncio.timeout(self._remaining(q)):
                while True:
                    current = (await self._state(sid)).get(q["id"])
                    if not current or current.get("closed"):
                        reason = (
                            (current or {}).get("closed", {}).get("reason", "noLongerAnswerable")
                        )
                        return {"value": "declined", "declined": True, "reason": reason}
                    if current.get("answer"):
                        return current["answer"]
                    await signal.wait()
                    signal.clear()
        except TimeoutError:
            if q["park"]:
                return {"open": True, "request": q["id"]}
            await self._accept(sid, q, q["actor"], "declined", "timeLimit")
            if answer := (await self._state(sid))[q["id"]].get("answer"):
                return answer
            return {
                "value": "declined",
                "declined": True,
                "reason": "timeLimit",
                "request": q["id"],
            }

    @staticmethod
    def _remaining(q):
        deadline = q.get("deadline")
        return (
            (datetime.fromisoformat(deadline) - datetime.now(UTC)).total_seconds()
            if deadline
            else None
        )

    async def _reusable(self, sid, q):
        answer = q["answer"]
        if answer.get("system") or (answer.get("declined") and q["kind"] != "approval"):
            return True
        ceiling = None
        if acting := answer.get("actingFor"):
            ceiling = await self.api.session("authority", session=sid, actor=acting)
        return await self._eligible(sid, q, answer["actor"], ceiling)

    async def valid_answer(self, d, emit):
        q = (await self._state(d["session"])).get(d["request"])
        return bool(
            q
            and q.get("answer")
            and not q.get("closed")
            and not q["answer"].get("declined")
            and await self._reusable(d["session"], q)
        )

    async def validate(self, d, emit):
        q = (await self._state(d["session"])).get(d["request"])
        if not q:
            session = await self.api.session("get", session=d["session"])
            if any(
                e["kind"] == "question_open" and e["data"]["id"] == d["request"]
                for e in session["entries"]
            ):
                raise AgentError("Question is closed or not on the current branch", "conflict")
            raise AgentError("Unknown question", "not_found")
        if q.get("answer") or q.get("closed") or q.get("selected"):
            raise AgentError("Question is closed or no longer answerable", "conflict")
        if q.get("approvalWait"):
            raise AgentError("Use the delivered approval route", "forbidden")
        if not q["park"] and (remaining := self._remaining(q)) is not None and remaining <= 0:
            await self._accept(d["session"], q, q["actor"], "declined", "timeLimit")
            raise AgentError("Question is closed: time limit", "conflict")
        ceiling = d.get("authority")
        if acting := d.get("acting_for"):
            ceiling = await self.api.session(
                "authority", session=d["session"], actor=acting, ceiling=ceiling
            )
        if not await self._eligible(d["session"], q, d["actor"], ceiling):
            raise AgentError(
                "Actor may see this question but lacks authority to answer it", "forbidden"
            )
        return q

    async def answer(self, d, emit):
        waiting = (await self._state(d["session"])).get(d["request"])
        if waiting and waiting.get("approvalWait"):
            with ot.question_answer(d["session"], waiting):
                return await self.api._harness.waiting_answer(d, waiting)
        q = await self.validate(d, emit)
        declined = d.get("declined", d.get("value") in (None, "declined"))
        if q["kind"] == "secret" and not declined:
            raise AgentError("Secret answers must go directly to the credential store", "forbidden")
        value = "declined" if declined else d.get("value")
        if q.get("coversNested") and value == "allow" and d.get("exact_cover_view") is False:
            raise AgentError("This route has not delivered the unchanged approval", "forbidden")
        if not isinstance(value, str) or (
            not declined and q["kind"] in {"approval", "choice"} and value not in q["options"]
        ):
            raise AgentError("Answer is not one of the offered options", "invalid_request")
        accepted = await self._accept(
            d["session"],
            q,
            d["actor"],
            value,
            d.get("reason"),
            declined=declined,
            acting_for=d.get("acting_for"),
        )
        if accepted is False:
            raise AgentError("Question is closed or no longer answerable", "refused")
        return {"accepted": True}

    async def select_secret(self, d, emit):
        if d.get("_caller_role") != "credential_store":
            raise AgentError("Only the credential store can confirm secret intake", "forbidden")
        q = await self.validate(d, emit)
        if q["kind"] != "secret" or q["name"] != d["name"]:
            raise AgentError("Credential name does not match", "invalid_request")
        await self._record(
            d["session"],
            "secret_answer_accepted",
            {
                "request": q["id"],
                "actor": d["actor"],
                **{k: q[k] for k in ("call", "turn", "step") if q.get(k)},
            },
            d["actor"],
        )

    async def record_secret(self, d, emit):
        if d.get("_caller_role") != "credential_store":
            raise AgentError("Only the credential store can confirm secret intake", "forbidden")
        sid = d["session"]
        q = (await self._state(sid)).get(d["request"])
        if not q or not q.get("selected"):
            raise AgentError("Secret intake was not selected", "conflict")
        superseded = d["decision"] == "superseded"
        if not await self._accept(
            sid,
            q,
            q["selected"]["actor"],
            "declined" if superseded else {"credential": q["name"]},
            "superseded" if superseded else None,
            activation=True,
        ):
            raise AgentError("Question is closed or no longer answerable", "conflict")
        return {"accepted": not superseded, **({"credential": q["name"]} if not superseded else {})}

    async def discard_secret(self, d, emit):
        if d.get("_caller_role") != "credential_store":
            raise AgentError("Only the credential store can confirm secret intake", "forbidden")
        q = (await self._state(d["session"])).get(d["request"])
        if q and not q.get("selected"):
            await self._close_question(d["session"], q)

    async def _accept(
        self, sid, q, actor, value, reason=None, *, declined=None, activation=False, acting_for=None
    ):
        with ot.question_answer(sid, q):
            return await self._accept_answer(
                sid,
                q,
                actor,
                value,
                reason,
                declined=declined,
                activation=activation,
                acting_for=acting_for,
            )

    async def _accept_answer(
        self, sid, q, actor, value, reason=None, *, declined=None, activation=False, acting_for=None
    ):
        if q["kind"] == "approval" and value == "refuse":
            value, declined = "declined", True
        if declined is None:
            declined = value == "declined"
        current = (await self._state(sid)).get(q["id"])
        if (
            not current
            or current.get("answer")
            or current.get("closed")
            or (current.get("selected") and not activation)
        ):
            return False
        answer = {
            "request": q["id"],
            "value": value,
            "declined": declined,
            **({"activation": True} if activation else {}),
            **({"actingFor": acting_for} if acting_for else {}),
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
        ot.question_event("close", sid, q, "declined" if declined else "answered")
        await self.api.event("input_request_answered", session=sid, answer=answer)
        child = q.get("child")
        if child:
            try:
                cq = (await self._state(child["session"])).get(child["request"])
            except AgentError:
                cq = None  # Its parent answer is durable; intake syncs it on reopen.
            if cq and not cq.get("answer") and not cq.get("closed"):
                if not await self._eligible(child["session"], cq, cq["actor"]):
                    value, declined = "declined", True
                await self._accept(child["session"], cq, cq["actor"], value, declined=declined)
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
                answer = proxy["answer"]
                value, declined = answer["value"], answer.get("declined")
                if not await self._eligible(
                    parent, proxy, proxy["answer"]["actor"]
                ) or not await self._eligible(sid, q, q["actor"]):
                    value, declined = "declined", True
                await self._accept(sid, q, q["actor"], value, declined=declined)
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
                and not q.get("approvalWait")
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
            if q.get("approvalWait"):
                continue
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
        ot.question_event("close", sid, q, reason)
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

    async def close_call(self, d, emit):
        for q in (await self._state(d["session"])).values():
            if q.get("call") == d["call"] and not q.get("answer") and not q.get("closed"):
                await self._close_question(d["session"], q)
        return {}

    async def close(self, d):
        for q in (await self._state(d["session"])).values():
            if not q.get("approvalWait") and not q.get("answer") and not q.get("closed"):
                await self._close_question(d["session"], q, "cancelled")
        self.connected.pop(d["session"], None)

    async def invalidate(self, d):
        if d.get("reason") == "cancelled":
            if not d.get("preserve_waits") and any(
                q.get("approvalWait") for q in (await self._state(d["session"])).values()
            ):
                await self.api._harness.reconcile_waits(
                    d["session"], reason="cancelled", kick=False
                )
            for q in (await self._state(d["session"])).values():
                if d.get("preserve_waits") and q.get("approvalWait"):
                    continue
                if q.get("call") and not q.get("answer") and not q.get("closed"):
                    await self._close_question(d["session"], q)
        elif d.get("reason") == "move":
            await self.close(d)
