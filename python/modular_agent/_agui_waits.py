"""A thread follower. Buffer record identities, never a previously gated notice."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import TYPE_CHECKING
from uuid import uuid4

from ma_core.wire import entry_out
from ma_harness.interface_tools import handoff_fold, same_json

from ._agui_wire import Failure, Obj, encode, require

if TYPE_CHECKING:
    from ._agui import View
    from ._agui_http import Stream


@dataclass(frozen=True)
class WaitPosition:
    client: str
    actor: str
    thread: str
    move: str | None
    entry: str | None

    @classmethod
    def at(cls, v: View, position: str | None) -> WaitPosition:
        entries = v.h.sessions[v.sid]["entries"]
        move = next((e["id"] for e in reversed(entries) if e["kind"] == "position_move"), None)
        return cls(v.client, v.actor, v.sid, move, position)

    def save(self, v: View, token: str) -> None:
        cache = v.binding.wait_cursors
        cache[token] = self
        if len(cache) > 4096:
            cache.popitem(last=False)


def reason(answer: Obj) -> str | None:
    if answer.get("declined") is not True:
        return "answered" if "value" in answer else None
    if answer.get("actorId"):
        return "declined"
    why = answer.get("reason")
    if why == "timeLimit":
        return "expired"
    if why in ("refused", "noLongerAnswerable") and answer.get("cause") == "revoked":
        return "revoked"
    return why if why in ("refused", "cancelled", "superseded", "noLongerAnswerable") else None


async def question_fact(v: View, entry: Obj, opening: Obj) -> Obj | None:
    def project(op: Obj, decision: Obj) -> Obj | None:
        q = op["data"]
        allowed = q.get("restrictedResponders")
        if q["kind"] == "secret" or allowed is not None and v.actor not in allowed:
            return None
        answer = entry_out(decision)["data"]
        if answer.get("requestId") != q["id"] or not (why := reason(answer)):
            return None
        return {"requestId": q["id"], "reason": why}

    expected = project(opening, entry)
    if not expected:
        return None
    op, end = await v.entry(opening), await v.entry(entry)
    return expected if op and end and same_json(expected, project(op, end)) else None


async def tool_fact(v: View, entry: Obj, branch: list[Obj]) -> Obj | None:
    cid = entry["call"]
    state = handoff_fold(branch).get(cid)
    if state is None:
        return None
    start, cp, terminal = v.h.checked_interface_state(state, {e["id"] for e in branch})
    if not cp or not terminal or terminal["id"] != entry["id"]:
        return None
    route = {"executorActorId": v.actor, "routeId": v.client}

    def matches(checkpoint: Obj) -> bool:
        return all(checkpoint["data"].get(k) == value for k, value in route.items())

    if not matches(cp):
        return None
    start_view, cp_view, result = await v.entry(start), await v.entry(cp), await v.entry(entry)
    if not (start_view and cp_view and matches(cp_view) and result):
        return None
    status = entry_out(entry)["data"]["status"]
    if result.get("call") != cid or entry_out(result)["data"].get("status") != status:
        return None
    return {"toolCallId": cid, "reason": "settled", "status": status}


_CLOSING = {"question_answer", "question_closed", "tool_result"}


class WaitFeed:
    def __init__(self, view: View) -> None:
        self.v = view

    async def deliver(self, position: WaitPosition, eid: str, stream: Stream) -> None:
        v = self.v
        await v.check()
        rev = await v.h.erasure_revision(v.sid)
        branch = v.branch()
        entry = next((e for e in branch if e["id"] == eid), None)
        if not entry or entry.get("fork_source") or entry["kind"] not in _CLOSING:
            return
        if entry["kind"] == "tool_result":
            fact = await tool_fact(v, entry, branch)
        else:
            qid = entry["data"]["request"]
            opening = next(
                (e for e in branch if e["kind"] == "question_open" and e["data"]["id"] == qid),
                None,
            )
            fact = await question_fact(v, entry, opening) if opening else None
        if not fact:
            return
        token = uuid4().hex
        notice = {"type": "modular-agent.waitClosed", "data": {"cursor": token, **fact}}
        gated = await v.h.output(v.sid, v.actor, [notice])
        await v.check()
        current = WaitPosition.at(v, eid)
        require(current.move == position.move, "cursor_expired")
        if rev == await v.h.erasure_revision(v.sid) and same_json(gated, [notice]):
            current.save(v, token)
            await stream.write(b"data: " + encode(notice["data"]) + b"\n\n")

    async def serve(self, after: str, stream: Stream) -> None:
        v = self.v
        saved = v.binding.wait_cursors.get(after)
        require(saved and saved == WaitPosition.at(v, saved.entry), "cursor_expired")
        assert saved is not None
        branch = v.branch()
        i = next((i for i, e in enumerate(branch) if e["id"] == saved.entry), -1)
        require(not saved.entry or i >= 0, "cursor_expired")
        catchup = [e["id"] for e in branch[i + 1 :] if e["kind"] in _CLOSING]
        del branch
        live: asyncio.Queue[str] = asyncio.Queue(256)
        task = asyncio.current_task()
        assert task is not None

        def committed(entries: list[Obj]) -> None:
            # This runs at the commit cutoff, not from an async gated live event.
            for e in entries:
                if e["kind"] == "position_move" or "watch" not in v.rights_now():
                    task.cancel()
                    return
                if e["kind"] in _CLOSING:
                    if live.full():
                        task.cancel()
                        return
                    live.put_nowait(e["id"])

        listeners = v.h.commit_listeners.setdefault(v.sid, set())
        listeners.add(committed)  # No yield between the watermark and registration.
        try:
            await stream.start()
            await stream.write(b": watching\n\n")
            for eid in catchup:
                await self.deliver(saved, eid, stream)
            while True:
                try:
                    async with asyncio.timeout(10):
                        eid = await live.get()
                except TimeoutError:
                    await v.check()
                    await stream.write(b": watching\n\n")
                    continue
                await self.deliver(saved, eid, stream)
        except Failure:
            return  # No error frame or last cursor on loss of access.
        finally:
            listeners.remove(committed)
            if not listeners:
                del v.h.commit_listeners[v.sid]
