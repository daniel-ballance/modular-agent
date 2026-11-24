"""The writer owns parked approval gates, route deliveries and first-dispatch checks."""

import asyncio
import contextvars
import time
from datetime import UTC, datetime

from jsonschema import Draft202012Validator
from referencing import Registry

from ma_core import AgentError, identity
from ma_core import telemetry as ot
from ma_core.wire import json_equal, recorded_as, tool_out

from .authority import CONNECTION_AUTHORITY
from .interface_tools import branch_entries, continuation_origin


UNTIL = "untilDeadline"
MAX_COUNT = 2**53 - 1
# Python approval routes display UTC with datetime's four-digit year.
MAX_DEADLINE = 253402300799999  # 9999-12-31T23:59:59.999Z


def marked(e):
    return e["kind"] == "question_open" and e["data"].get("approvalWait") == UNTIL


def clock_ms():
    return time.time_ns() // 1_000_000


def waiting_entries(s):
    return [e for e in branch_entries(s) if not e.get("fork_source") and marked(e)]


def call_view(call):
    return {"name": call["name"], "input": call["input"]}


class WaitingApprovals:
    def init_waiting_approvals(self):
        self.max_approval_wait_ms = None
        self.approval_routes = {}  # stable route ID -> operator's scope and output policy
        self.approval_deliveries = {}  # (session, route instance, actor, entry) -> stable route
        self.approval_deadlines = {}

    def validate_wait_setting(self, changes):
        if "approvalWait" not in changes:
            return
        if self.max_approval_wait_ms is None:
            raise AgentError("Waiting approvals are not supported", "not_supported")
        if changes["approvalWait"] not in ("live", UNTIL):
            raise AgentError("Unknown approvalWait setting", "invalid_params")

    def registration(self, sid, definition):
        name = definition["name"]
        owner, source = getattr(self, "external_tool_names", {}).get(name, ("local", "files"))
        plugin = self.plugins.get(owner)
        if (
            plugin
            and definition.get("target") == owner + ":tools:" + source
            and source in getattr(plugin, "sources", {})
        ):
            cache = plugin.sources[source]["cache"]
            for item in cache.get(sid, cache.get(None, [])):
                if item["name"] == name:
                    return {"plugin": plugin.registration["name"], "toolSource": source}, item
        return definition.get("source") or {"plugin": owner, "toolSource": source}, tool_out(
            {k: v for k, v in definition.items() if k != "source"}
        )

    @staticmethod
    def waiting_request(s, cid):
        return next((e for e in waiting_entries(s) if e.get("call") == cid), None)

    @staticmethod
    def wait_state(s, e):
        """Decisions and terminal identities survive moves. Proof must also be on branch."""
        entries = [r for r in s["entries"] if not r.get("fork_source")]
        cid = e["call"]
        answer = next(
            (
                r
                for r in entries
                if r["kind"] in ("question_answer", "question_closed")
                and r["data"]["request"] == e["data"]["id"]
            ),
            None,
        )
        started = next(
            (r for r in entries if r.get("call") == cid and recorded_as(r, "tool_started")), None
        )
        result = next(
            (r for r in entries if r.get("call") == cid and recorded_as(r, "tool_result")), None
        )
        return answer, started, result

    @staticmethod
    def wait_ended(branch, e):
        return any(
            r.get("turn") == e["turn"]
            and not r.get("fork_source")
            and r["kind"] == "turn_end"
            and r["data"].get("outcome") == "completed"
            and e["call"] in r["data"].get("open_calls", ())
            for r in branch
        )

    def wait_eligible(self, s, q, actor, principal, ceiling=None):
        rights = self.permissions(s, actor, ceiling) & self.permissions(s, principal)
        restricted = q.get("restrictedResponders")
        if (restricted is not None and actor not in restricted) or not {
            "watch",
            "approve",
        } <= rights:
            return set()
        return rights

    def prune_wait_deliveries(self, sid):
        s = self.sessions[sid]
        entries = {e["id"]: e for e in waiting_entries(s)}
        for key, (_, principal) in list(self.approval_deliveries.items()):
            if key[0] == sid and (
                not (entry := entries.get(key[3]))
                or not self.wait_eligible(s, entry["data"], key[2], principal)
            ):
                self.approval_deliveries.pop(key)

    def wait_members(self, s, q):
        token = CONNECTION_AUTHORITY.set(None)
        try:
            return any(self.wait_eligible(s, q, actor, actor) for actor in s["actors"])
        finally:
            CONNECTION_AUTHORITY.reset(token)

    def wait_reason(self, s, e):
        q = e["data"]
        limit, deadline = q.get("timeLimitMs"), q.get("deadlineAt")
        recorded = int(datetime.fromisoformat(e["time"]).timestamp() * 1000)
        if (
            type(limit) is not int
            or not 0 <= limit <= MAX_COUNT
            or type(deadline) is not int
            or not 0 <= deadline <= MAX_DEADLINE
            or deadline != recorded + limit
        ):
            return "noLongerAnswerable", "not_started"
        if clock_ms() >= deadline:
            return "timeLimit", "not_started"
        if self.max_approval_wait_ms is None:
            return "noLongerAnswerable", "not_started"
        if s["settings"].get("approvalWait") != UNTIL or limit > self.max_approval_wait_ms:
            return "refused", "refused"
        if not self.wait_members(s, q):
            return "noLongerAnswerable", "refused"
        return None

    async def waiting_gate(self, d, ask, question, covers_nested):
        sid, turn, step, call = (d[k] for k in ("session", "turn", "step", "call"))
        s = self.sessions[sid]
        if request := self.waiting_request(s, call["id"]):
            # Verify at the gate that asked, and independently after all gates.
            status, _ = await self.check_wait_dispatch(sid, turn, step, call, d.get("definition"))
            if status:
                return {
                    **d,
                    "refused": True,
                    "wait_status": status,
                    "reason": "The recorded approval no longer applies",
                }
            if covers_nested and request["data"].get("coversNested") is True:
                return {**d, "covering_request": request["data"]["id"]}
            return d
        definition = d.get("definition")
        if not (
            ask
            and self.max_approval_wait_ms
            and s["settings"].get("approvalWait") == UNTIL
            and turn
            and step
            and not call.get("parentCallId")
            and definition
            and not definition.get("interfaceSource")
            and call.get("initiator", "model") == "model"
        ):
            return None
        async with self.append_locks.setdefault(sid, asyncio.Lock()):
            s = self.sessions[sid]
            branch = branch_entries(s)
            response = next(
                (
                    e
                    for e in branch
                    if e.get("turn") == turn
                    and e.get("step") == step
                    and e["kind"] == "response"
                    and not e.get("fork_source")
                    and any(c["id"] == call["id"] for c in e["data"].get("calls", []))
                ),
                None,
            )
            if not response or any(
                r.get("call") == call["id"] and recorded_as(r, "tool_started") for r in s["entries"]
            ):
                return None
            rights = self.interface_work_rights(s, turn, call["actor"], call.get("authority"))
            if "tools" not in rights or not self.wait_members(s, {}):
                return {**d, "refused": True, "reason": "Call or approver lacks authority"}
            maximum = self.max_approval_wait_ms
            requested = s["settings"].get("approval_timeout")
            limit = min(maximum, round(requested * 1000)) if requested is not None else maximum
            ms = clock_ms()
            if limit < 0 or ms + limit > MAX_DEADLINE:
                return {**d, "refused": True, "reason": "Unrepresentable approval deadline"}
            qid = identity()
            source, offered = self.registration(sid, definition)
            binding = call_view(call)
            q = {
                "id": qid,
                "key": "approval:" + call["id"],
                "kind": "approval",
                "question": question,
                "options": [],
                "asker": "approval",
                "actor": call["actor"],
                "authority": sorted(rights),
                "call": call["id"],
                "turn": turn,
                "step": step,
                "approval_call": binding,
                "approval_registration": {
                    "call": {
                        "id": call["id"],
                        **binding,
                        "actorId": call["actor"],
                        "startedBy": "model",
                        "stepId": step,
                    },
                    "source": source,
                    "definition": offered,
                },
                "approvalWait": UNTIL,
                **({"coversNested": True} if covers_nested else {}),
                "answerable": False,
                "timeout": limit / 1000,
                "timeLimitMs": limit,
                "deadlineAt": ms + limit,
                "park": False,
            }
            batch = await self._append(
                {
                    "session": sid,
                    "turn": turn,
                    "step": step,
                    "call": call["id"],
                    "kind": "question_open",
                    "writer": "@harness",
                    "actor": call["actor"],
                    "data": q,
                    "copies": [response["id"]],
                    "approval_time": datetime.fromtimestamp(ms / 1000, UTC).isoformat(),
                    "gate_pending": True,
                }
            )
        ot.question_event("open", sid, q)
        self.arm_wait(sid, batch[0])
        await self.emit_wait_entries(sid, batch)
        await self._emit({"kind": "input_request_opened", "session": sid, "request": q})
        return {**d, "open": True, "request": qid, "gate_checkpoint": True}

    async def emit_wait_entries(self, sid, entries):
        for entry in entries:
            await self._emit({"kind": "history_entry", "session": sid, "entry": entry})

    def arm_wait(self, sid, e):
        key = (sid, e["id"])
        if key not in self.approval_deadlines:
            delay = max(0, (e["data"]["deadlineAt"] - clock_ms()) / 1000)

            def expire():
                self.approval_deadlines.pop(key, None)
                if sid in self.sessions:
                    asyncio.create_task(self.reconcile_waits(sid))

            self.approval_deadlines[key] = asyncio.get_running_loop().call_later(
                delay, expire, context=contextvars.Context()
            )

    def forget_waits(self, sid, *, token=None):
        for key in list(self.approval_deliveries):
            if key[0] == sid and (token is None or key[1] == token):
                del self.approval_deliveries[key]
        if token is None:
            for key in list(self.approval_deadlines):
                if key[0] == sid:
                    self.approval_deadlines.pop(key).cancel()

    async def wait_route_rights(self, s, e, actor, principal, route, ceiling):
        check = self.approval_routes.get(route)
        if not check:
            return set()
        allowed = await check(s["id"], e, actor, principal)
        s = self.sessions[s["id"]]
        return self.wait_eligible(s, e["data"], actor, principal, ceiling) & set(allowed)

    def remember_wait(self, sid, token, actor, entry, route, exact, principal=None):
        key = (sid, token, actor, entry)
        if exact:
            self.approval_deliveries[key] = (route, principal or actor)
        else:
            self.approval_deliveries.pop(key, None)

    async def waiting_answer(self, d, q):
        sid, actor = d["session"], d["actor"]
        principal = d.get("acting_for") or actor
        token = d.get("delivery_token")
        accepted = False
        await self.guard_erasure(sid, reconcile=True)
        async with self.append_locks.setdefault(sid, asyncio.Lock()):
            s = self.sessions[sid]
            e = self.waiting_request(s, q["call"])
            if (
                not e
                or e["data"]["id"] != q["id"]
                or any(self.wait_state(s, e))
                or not self.wait_ended(branch_entries(s), e)
            ):
                raise AgentError("This approval is not open for an answer", "conflict")
            key = (sid, token, actor, e["id"])
            delivery = self.approval_deliveries.get(key)
            route = delivery[0] if delivery and delivery[1] == principal else None
            rights = await self.wait_route_rights(s, e, actor, principal, route, d.get("authority"))
            await self._assert_writable(sid)
            if await self._pending_erasure(sid) or any(
                s.get(k) for k in ("closing", "moving", "writer_lost", "suspending")
            ):
                raise AgentError("Approval route is no longer available", "conflict")
            why = self.wait_reason(s, e)
            if why:
                records = await self.settle_wait(s, e, *why)
            elif (
                not route
                or self.approval_deliveries.get(key) != delivery
                or not {"watch", "approve"} <= rights
            ):
                self.approval_deliveries.pop(key, None)
                raise AgentError("This route has not delivered the unchanged approval", "forbidden")
            else:
                allow = d.get("value") == "allow" and not d.get("declined")
                if not allow and not d.get("declined"):
                    raise AgentError("Expected allow or decline", "invalid_request")
                decision = {
                    "request": q["id"],
                    "actor": actor,
                    "value": "allow" if allow else "declined",
                    "declined": not allow,
                    "call": e["call"],
                    "turn": e["turn"],
                    "step": e["step"],
                }
                if not allow and isinstance(d.get("reason"), str):
                    decision["reason"] = d["reason"]
                    decision["system"] = False
                if allow:
                    decision["approvalView"] = {
                        "requestEntryId": e["id"],
                        "submittedBy": principal,
                        "routeId": route,
                        "rights": sorted(rights),
                    }
                records = await self._append(
                    {
                        "session": sid,
                        "writer": "@harness",
                        "kind": "question_answer",
                        **({"id": d["_entry_id"]} if d.get("_entry_id") else {}),
                        "copies": [e["id"]],
                        "actor": actor,
                        **{k: e[k] for k in ("call", "turn", "step")},
                        "data": decision,
                        **({} if allow else {"wait_result": self.wait_result(e, "refused")}),
                    }
                )
                accepted = True
        await self.after_wait_decision(sid, e, records)
        await self.interface_kick(sid)
        if not accepted:
            raise AgentError("Approval is no longer answerable", "conflict")
        return {"accepted": True}

    @staticmethod
    def wait_result(e, status):
        call = e["data"].get("approval_call") or {}
        return {
            "kind": "tool_result",
            "visible": True,
            "content": [],
            "data": {"status": status, "toolName": call.get("name", "unknown")},
        }

    async def settle_wait(self, s, e, reason, status, turn=None, *, erasing=False):
        """Called under the append lock. Keep an earlier answer."""
        decision, started, result = self.wait_state(s, e)
        if result or started:
            return []
        base = {
            "session": s["id"],
            "turn": turn or e["turn"],
            "step": e["step"],
            "call": e["call"],
            "writer": "@harness",
            "copies": [e["id"]],
        }
        result = self.wait_result(e, status)
        tombstone = {}
        if erasing:
            # The registry already fences new copies. Publish only terminal identities.
            tombstone = {
                "erased": True,
                "originalKind": "inputAnswer",
                "requestId": e["data"]["id"],
            }
            result.update(visible=False, data={"erased": True, "originalKind": "toolResult"})
        if decision:
            return await self._append({**base, **result, "copies": [e["id"], decision["id"]]})
        return await self._append(
            {
                **base,
                "kind": "question_closed",
                "data": {"request": e["data"]["id"], "reason": reason, **tombstone},
                "wait_result": result,
            }
        )

    async def after_wait_decision(self, sid, e, records):
        with ot.question_answer(sid, e["data"]):
            for record in records:
                d = record["data"]
                if record["kind"] in ("question_answer", "question_closed"):
                    disposition = (
                        d["reason"]
                        if record["kind"] == "question_closed"
                        else ("declined" if d.get("declined") else "answered")
                    )
                    ot.question_event("close", sid, e["data"], disposition)
                    for key in list(self.approval_deliveries):
                        if key[0] == sid and key[3] == e["id"]:
                            del self.approval_deliveries[key]
                if record["kind"] == "tool_result":
                    ot.tool_disposition(sid, record["turn"], e["step"], {"id": e["call"]}, None, d)
                    if timer := self.approval_deadlines.pop((sid, e["id"]), None):
                        timer.cancel()
            await self.emit_wait_entries(sid, records)
            if records and records[0]["kind"] == "question_answer":
                answer = {k: v for k, v in records[0]["data"].items() if k != "approvalView"}
                await self._emit(
                    {"kind": "input_request_answered", "session": sid, "answer": answer}
                )

    async def reconcile_waits(self, sid, *, reason=None, turn=None, affected=None, kick=True):
        closures = []
        async with self.append_locks.setdefault(sid, asyncio.Lock()):
            s = self.sessions.get(sid)
            if not s or s.get("writer_lost") or s.get("suspending"):
                return
            for e in waiting_entries(s):
                answer, started, result = self.wait_state(s, e)
                if result or started:
                    continue
                executing = next(
                    (
                        r["turn"]
                        for r in branch_entries(s)
                        if r["kind"] == "turn_start" and continuation_origin(r) == e["turn"]
                    ),
                    None,
                )
                if turn and turn not in (executing, e["turn"]):
                    continue
                if affected is not None and not any(
                    r["id"] in affected
                    for r in s["entries"]
                    if r.get("call") == e["call"] or r["id"] in e["copies"]
                ):
                    continue
                why = (reason, "not_started") if reason else self.wait_reason(s, e)
                if not why:
                    if answer and not self.wait_answer_authorized(s, e, answer):
                        why = ("refused", "refused")
                    else:
                        self.arm_wait(sid, e)
                if why:
                    records = await self.settle_wait(
                        s, e, *why, turn=executing, erasing=affected is not None
                    )
                    closures.append((e, records))
                    s = self.sessions[sid]
        for e, records in closures:
            await self.after_wait_decision(sid, e, records)
        if closures and kick:
            await self.interface_kick(sid)

    def wait_answer_authorized(self, s, entry, answer):
        data = answer["data"]
        proof = data.get("approvalView")
        if not (
            answer["kind"] == "question_answer"
            and data.get("value") == "allow"
            and isinstance(proof, dict)
            and isinstance(proof.get("rights"), list)
            and proof.get("requestEntryId") == entry["id"]
            and entry["id"] in answer["copies"]
        ):
            return False
        scope = CONNECTION_AUTHORITY.set(None)
        try:
            return bool(
                self.wait_eligible(
                    s, entry["data"], data.get("actor"), proof.get("submittedBy"), proof["rights"]
                )
            )
        finally:
            CONNECTION_AUTHORITY.reset(scope)

    async def check_wait_dispatch(self, sid, turn, step, call, definition, *, started=False):
        """Return the terminal status, or None and the proof sources for this handoff."""
        s = self.sessions[sid]
        e = self.waiting_request(s, call["id"])
        if e is None:
            return None, []
        q = e["data"]
        answer, start, result = self.wait_state(s, e)
        branch = branch_entries(s)
        sources = [e["id"], *([answer["id"]] if answer else [])]
        denied = ("refused", sources)
        if why := self.wait_reason(s, e):
            return why[1], sources
        if not (
            definition
            and answer
            and not result
            and bool(start) == started
            and answer in branch
            and (not start or start.get("turn") == turn)
            and self.wait_ended(branch, e)
            and any(
                r.get("turn") == turn
                and r["kind"] == "turn_start"
                and continuation_origin(r) == e["turn"]
                for r in branch
            )
            and any(
                r.get("step") == step
                and r["kind"] == "model_started"
                and call["name"] in r["data"].get("tools", [])
                for r in branch
            )
            and any(
                r["id"] in e["copies"]
                and r["kind"] == "response"
                and r.get("step") == step
                and any(
                    c["id"] == call["id"] and c["name"] == call["name"]
                    for c in r["data"].get("calls", [])
                )
                for r in branch
            )
            and any(
                r["kind"] == "tool_deferred"
                and r["parent"] == e["id"]
                and r["data"].get("requestIds") == [q["id"]]
                and not r["data"].get("toolStartedId")
                for r in branch
            )
        ):
            return denied
        data = answer["data"]
        proof = data.get("approvalView") or {}
        if not (
            self.wait_answer_authorized(s, e, answer)
            and s["settings"].get("approval") in ("off", "ask always", "ask unless read-only")
        ):
            return denied
        rights = await self.wait_route_rights(
            s, e, data["actor"], proof.get("submittedBy"), proof.get("routeId"), proof["rights"]
        )
        if not {"watch", "approve"} <= rights:
            return denied
        tools = await self.call("@harness", "tools", "definitions", {"session": sid, "turn": turn})
        current = next((t for t in tools if t["name"] == call["name"]), None)
        if not current or current.get("interfaceSource"):
            return denied
        source, offer = self.registration(sid, current)
        binding = q.get("approval_registration") or {}
        bound = binding.get("call") or {}
        if not (
            json_equal(self.registration(sid, definition)[0], source)
            and json_equal(self.registration(sid, definition)[1], offer)
            and json_equal(source, binding.get("source"))
            and json_equal(offer, binding.get("definition"))
            and bound.get("id") == call["id"]
            and bound.get("actorId") == call["actor"]
            and bound.get("stepId", step) == step == e["step"]
            and bound.get("startedBy") == "model"
            and json_equal(call_view(bound), call_view(call))
            and json_equal(q.get("approval_call"), call_view(call))
            and Draft202012Validator(current["schema"], registry=Registry()).is_valid(call["input"])
        ):
            return denied
        await self._assert_writable(sid)
        if await self._pending_erasure(sid):
            return denied
        s = self.sessions[sid]
        if (
            any(s.get(k) for k in ("moving", "closing", "writer_lost", "suspending"))
            or "tools"
            not in self.interface_work_rights(s, e["turn"], call["actor"], q.get("authority"))
            or not self.wait_eligible(s, q, data["actor"], proof["submittedBy"], rights)
        ):
            return denied
        why = self.wait_reason(s, e)
        return (why[1] if why else None), sources
