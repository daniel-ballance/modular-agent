"""One live exchange. Subscribe before admission or committing a decision."""

from __future__ import annotations

import asyncio
import json
from typing import Any, cast

from aiohttp import web
from ma_harness.interface_tools import continuation_origin, same_json

from ._agui import Cursor, View
from ._agui_http import problem
from ._agui_wire import Obj, Failure, encode, event, require, to_shared, triad, warn
from ._interface_tools import InterfaceToolConnection, InterfaceToolHandoff, InterfaceToolReport


from ._types import Content


class Exchange:
    def __init__(self, view: View, req: web.Request, data: Obj, headers: Obj) -> None:
        self.v, self.req, self.data = view, req, data
        self.response = web.StreamResponse(headers={**headers, "Content-Type": "text/event-stream"})
        self.bounds = {"threadId": view.sid, "runId": data["runId"]}
        self.queue: asyncio.Queue[Obj] = asyncio.Queue(256)
        self.lost = False
        self.turn: str | None = None
        self.origin: str | None = None
        self.input_id: str | None = None
        self.steps: set[str] = set()
        self.text: dict[str, str] = {}
        self.open_text: set[str] = set()
        self.cx: InterfaceToolConnection | None = None
        self.released: list[InterfaceToolHandoff] = []
        self.state_revision: str | None = None
        self.revision = 0
        self.finished = False
        self.p = view.binding.presence.get(view.key)

    async def receive(self, d: Obj) -> None:
        if self.lost or d.get("session") != self.v.sid:
            return
        # Internal entries, including checkpoints, are never event payloads.
        if d["kind"] == "history_entry":
            e = d["entry"]
            if e["kind"] not in (
                "turn_start",
                "response",
                "input_withdrawn",
                "tool_result",
                "tool_call",
            ) and not (
                "." in e["kind"] and e.get("visible") and not e["kind"].startswith("modular-agent.")
            ):
                return
        if self.queue.full():
            self.lost = True
        else:
            self.queue.put_nowait(d)

    async def frame(self, value: Obj, *, optional: bool = False, exact: bool = False) -> bytes:
        allowed = await self.v.gate("event", value)
        if allowed is None or exact and not same_json(value, allowed):
            if optional:
                return b""
            raise Failure("output_withheld")
        try:
            return b"data: " + encode(allowed) + b"\n\n"
        except Failure:
            if optional:
                return b""
            raise

    async def write(self, b: bytes) -> None:
        if not b:
            return
        await self.v.check()
        require(self.revision == await self.v.h.erasure_revision(self.v.sid), "conflict")
        await self.response.write(b)

    async def snapshot(self) -> tuple[bytes, Cursor]:
        snap, stamp = await self.v.snapshot(http=False)
        messages = snap["messages"]
        cursor = event(
            "CUSTOM",
            name="modular-agent.history",
            value={"cursor": stamp.id, "lastMessageId": messages[-1]["id"] if messages else None},
        )
        return b"data: " + encode(snap) + b"\n\n" + await self.frame(cursor, exact=True), stamp

    async def serve(self) -> web.StreamResponse:
        h = self.v.h
        follower = ("agui:" + self.v.client + ":" + self.v.sid, self.v.actor, self.receive)
        h.follow(*follower)
        try:
            async with self.v.binding.admission:
                await self.prepare()
            start = await self.frame(
                event("RUN_STARTED", **self.bounds, protocolVersion="1.0"), exact=True
            )
            await self.response.prepare(self.req)
            try:
                await self.write(start)
                # Snapshot the prefix sampled before admission. A fast Provider can
                # already have produced live output by the time the socket opens.
                await self.write(self.initial)
                self.v.remember(self.initial_stamp)
                while not self.finished:
                    require(not self.lost, "unavailable")
                    try:
                        async with asyncio.timeout(10):
                            d = await self.queue.get()
                    except TimeoutError:
                        await self.write(b": waiting\n\n")
                        # Do not wait forever if a required boundary was withheld.
                        branch = self.v.branch()
                        require(
                            not any(
                                e["kind"] == "turn_end" and e.get("turn") == self.turn
                                for e in branch
                            ),
                            "output_withheld",
                        )
                        if self.origin:
                            require(
                                any(
                                    e["kind"] == "turn_end" and e.get("turn") == self.origin
                                    for e in branch
                                ),
                                "conflict",
                            )
                        continue
                    await self.project(d)
            except (asyncio.CancelledError, ConnectionError):
                raise
            except Exception as exc:
                self.v.binding.cursors.pop(self.v.key, None)
                err = event("RUN_ERROR", code=problem(exc), message="Run could not be delivered.")
                data = await self.v.gate("error", err) if "watch" in self.v.rights_now() else None
                if not same_json(data, err):
                    err = event("RUN_ERROR", code="output_withheld", message="Output withheld.")
                await self.response.write(b"data: " + encode(err) + b"\n\n")
            return self.response
        finally:
            if follower in h.followers:
                h.followers.remove(follower)
            if self.cx and not (self.p and self.p.executor is self.cx):
                self.cx.close()

    async def prepare(self) -> None:
        v, d = self.v, self.data
        self.revision = await v.h.erasure_revision(v.sid)
        suffix = await v.reconcile(d["messages"], self.req.headers.get("MA-History-Cursor"))
        require(not any(m["id"].startswith("ma:") for m in suffix), "conflict")
        require(len({m["id"] for m in suffix}) == len(suffix))
        users = [m for m in suffix if m["role"] == "user"]
        reports = [m for m in suffix if m["role"] == "tool"]
        answers = d["resume"]
        require(
            len(users) + len(reports) == len(suffix)
            and len(users) <= 1
            and not (users and (reports or answers))
            and (suffix or answers)
        )
        branch = v.branch()
        calls = v.open_calls(branch)
        questions = await v.questions(branch)
        ended = {e["turn"] for e in branch if e["kind"] == "turn_end"}
        planned: list[tuple[Obj, bool, Any]] = []
        seen: set[str] = set()
        origins: set[str] = set()
        for a in answers:
            qid = a["interruptId"]
            require(qid not in seen)
            seen.add(qid)
            if qid not in questions:
                require(
                    not any(
                        e["kind"] == "question_open" and e["data"]["id"] == qid for e in branch
                    ),
                    "conflict",
                )
                warn("interruptId")
                continue
            q, _ = questions[qid]
            value = a.get("payload")
            declined = a["status"] == "cancelled"
            if not declined:
                if q["kind"] == "approval":
                    require(
                        isinstance(value, dict)
                        and type(value.get("allow")) is bool
                        and set(value) == {"allow"}
                    )
                    declined = not value["allow"]
                    value = "allow"
                else:
                    require(
                        isinstance(value, str) and (q["kind"] != "choice" or value in q["options"])
                    )
            planned.append((q, declined, value))
            origins.add(q["turn"])
        converted: list[InterfaceToolReport] = []
        for m in reports:
            cid = m["toolCallId"]
            require(
                cid in calls
                and calls[cid]["turn"] in ended
                and all(r["callId"] != cid for r in converted),
                "conflict",
            )
            origins.add(calls[cid]["turn"])
            body = to_shared(m["content"])
            if "error" in m and not any(p.get("text") or p["type"] == "image" for p in body):
                body = [{"type": "text", "text": m["error"] or "Frontend tool failed"}]
            converted.append(
                {
                    "callId": cid,
                    "status": "failed" if "error" in m else "completed",
                    "content": cast(Content, body),
                }
            )
        if not users:
            require(len(origins) == 1 and (converted or planned), "conflict")
            origin = origins.pop()
            if origin in ended:
                self.origin = origin
                require(
                    not any(
                        continuation_origin(e) == origin
                        for e in branch
                        if e["kind"] == "turn_start"
                    ),
                    "conflict",
                )
            else:
                self.turn = origin
            require(
                all(qid in seen for qid, (q, _) in questions.items() if q["turn"] == origin),
                "conflict",
            )
            require(
                {cid for cid, c in calls.items() if c["turn"] == origin and origin in ended}
                == {r["callId"] for r in converted},
                "conflict",
            )
        else:
            await v.check("input")
            require(not questions and not calls, "conflict")
        definitions = []
        for offer in d["tools"]:
            registered = getattr(v.h, "interface_advertisements", {}).get(offer["name"])
            require(
                registered
                and not registered.get("returns")
                and same_json(
                    offer,
                    {
                        "name": registered["name"],
                        "description": registered["description"],
                        "parameters": registered.get("parameters", {}),
                    },
                )
                and registered not in definitions,
                "refused",
            )
            assert registered is not None
            definitions.append(registered)
        self.initial, self.initial_stamp = await self.snapshot()
        if self.p and self.p.executor is not None and self.turn:
            self.cx = self.p.executor
        elif v.h.interface_routes.get(v.client) == v.actor:
            self.cx = v.agent.connect_interface_tools(
                actor_id=v.actor,
                route_id=v.client,
                rights=list(v.rights_now()),
                tenants=list(v.scope["tenants"]),
                on_handoff=self.released.append,
                defer=True,
            )
        require(not (definitions or converted) or self.cx, "refused")
        if definitions and self.cx:
            try:
                self.cx.advertise(v.sid, definitions)
            except Exception:
                raise Failure("refused") from None
        if users:
            key = "agui:" + json.dumps([v.client, d["runId"]], separators=(",", ":"))
            result = await v.agent._call(
                "runtime",
                "submit",
                session=v.sid,
                actor=v.actor,
                when="now",
                key=key,
                commands=False,
                content=to_shared(users[0]["content"]),
            )
            require(not result.get("duplicate"), "conflict")
            require(result.get("input"), "unavailable")
            self.input_id = result["input"]
        else:
            for q, declined, value in planned:
                require(q["id"] in await v.questions(v.branch()), "conflict")
                await v.agent._call(
                    "questions",
                    "answer",
                    session=v.sid,
                    actor=v.actor,
                    request=q["id"],
                    declined=declined,
                    value="declined" if declined else value,
                )
            for report in converted:
                assert self.cx is not None
                require(await self.cx.report_tool_result(v.sid, report) == "accepted", "conflict")
            if self.p and self.cx is self.p.executor:
                self.p.executor = None

    async def close_frames(self) -> bytes:
        b = b""
        for mid in sorted(self.open_text):
            b += await self.frame(event("TEXT_MESSAGE_END", messageId=mid))
        self.open_text.clear()
        for step in sorted(self.steps):
            b += await self.frame(event("STEP_FINISHED", stepName=step))
        self.steps.clear()
        return b

    async def finish(self, outcome: Obj, pending: list[str] | None = None) -> None:
        v = self.v
        prefix = await self.close_frames()
        frames = b""
        staged: list[str] = []
        for cid in pending or []:
            # Only this live handle knows a dispatch has been staged. Never
            # construct a dispatch from the branch or attach a new executor.
            if self.cx is None or (request := self.cx._staged(v.sid, cid)) is None:
                continue
            staged.append(cid)
            for item in triad(cid, request["name"], request["input"]):
                frames += await self.frame(item, exact=True)
        if staged:
            outcome["pendingToolCallIds"] = staged
        snap, cursor = await self.snapshot()
        end = await self.frame(event("RUN_FINISHED", **self.bounds, outcome=outcome), exact=True)
        await v.check()
        for cid in staged:
            require(self.cx and await self.cx.release(v.sid, cid), "refused")
        await self.write(prefix + frames + snap + end)
        v.remember(cursor)
        self.finished = True

    async def project(self, d: Obj) -> None:
        v = self.v
        kind = d["kind"]
        e = d.get("entry", {})
        if kind == "session_interrupted":
            raise Failure("unavailable")
        if (
            kind == "history_entry"
            and e["kind"] == "turn_start"
            and (
                (self.input_id and e["data"].get("input") == self.input_id)
                or (self.origin and continuation_origin(e) == self.origin)
            )
        ):
            self.turn = e["turn"]
        if not self.turn:
            return
        if kind == "input_request_opened":
            if not self.p or v.binding.presence.get(v.key) is not self.p:
                return
            qid = d["request"]["id"]
            qs = await v.agent._call(
                "questions", "list", session=v.sid, actor=v.actor, recipientView=True, openOnly=True
            )
            q = next(
                (
                    q
                    for q in qs
                    if q["id"] == qid
                    and q["turn"] == self.turn
                    and q["answerable"]
                    and q["kind"] != "secret"
                ),
                None,
            )
            if not q:
                return
            i = await v.interrupt(q)
            if i is None or q["question"] != d["request"]["question"]:
                if q["kind"] == "approval":
                    await v.agent._call(
                        "questions",
                        "answer",
                        session=v.sid,
                        actor=v.actor,
                        request=qid,
                        declined=True,
                        value="declined",
                        reason="refused",
                    )
                return
            self.p.delivered[qid] = i
            await self.finish({"type": "interrupt", "interrupts": [i]})
            self.p.executor = self.cx
            return
        if (e.get("turn") or d.get("turn")) != self.turn and not (
            d.get("plugin") and not d.get("turn")
        ):
            return
        step = e.get("step") or d.get("step") or ""
        mid = "ma:a:" + step if step else ""
        if kind == "step_started":
            if step not in self.steps:
                await self.write(await self.frame(event("STEP_STARTED", stepName=step)))
                self.steps.add(step)
        elif kind == "step_ended":
            await self.write(await self.close_frames())
        elif kind == "model_output" and d.get("text") and not v.h.holds_output():
            if d.get("stream_type") == "reasoning":
                await self.reasoning(step, d["text"])
            else:
                await self.append_text(mid, d["text"])
        elif kind == "history_entry":
            if e["kind"] == "response":
                text = "".join(p["text"] for p in e.get("content", []) if p["type"] == "text")
                prior = self.text.get(mid, "")
                if text.startswith(prior) and text != prior:
                    await self.append_text(mid, text[len(prior) :])
            elif e["kind"] == "tool_result":
                cid = e["call"]
                msg = next(
                    (m for m in await v.messages(v.branch()) if m.get("toolCallId") == cid), None
                )
                start = next(
                    (s for s in v.branch() if s["kind"] == "tool_started" and s.get("call") == cid),
                    None,
                )
                if (
                    start
                    and msg
                    and (s := await v.entry(start)) is not None
                    and (call := s["data"]["call"])["name"] not in v.h.interface_tools
                ):
                    group = [
                        *triad(cid, call["name"], call["input"], mid or None),
                        event(
                            "TOOL_CALL_RESULT",
                            messageId=msg["id"],
                            toolCallId=cid,
                            content=msg["content"],
                            role="tool",
                        ),
                    ]
                    frames = [await self.frame(item, optional=True, exact=True) for item in group]
                    if all(frames):
                        await self.write(b"".join(frames))
                await self.custom("toolResult", {"toolCallId": cid, "status": e["data"]["status"]})
            elif e["kind"] == "tool_call":
                await self.custom("toolCall", {"toolCallId": e.get("call")})
            elif (
                "." in e["kind"] and e.get("visible") and not e["kind"].startswith("modular-agent.")
            ):
                from ma_core.wire import entry_out

                await self.write(
                    await self.frame(
                        event("CUSTOM", name="modular-agent.entry", value=entry_out(e)),
                        optional=True,
                    )
                )
        elif kind == "turn_ended":
            require(d["outcome"] not in ("failed", "interrupted"), "unavailable")
            success = d["outcome"] == "completed"
            await self.finish(
                {"type": "success" if success else "cancelled"},
                d.get("open_calls", []) if success else [],
            )
        elif kind == "tool_progress":
            await self.custom(
                "toolOutput", {"toolCallId": d["call"], "content": d.get("content", [])}
            )
        elif d.get("plugin") and "." in kind:
            await self.plugin(d)

    async def append_text(self, mid: str, delta: str) -> None:
        piece = await self.frame(
            event("TEXT_MESSAGE_CONTENT", messageId=mid, delta=delta), optional=True
        )
        if not piece:
            return
        if mid not in self.open_text:
            await self.write(
                await self.frame(event("TEXT_MESSAGE_START", messageId=mid, role="assistant"))
            )
            self.open_text.add(mid)
        await self.write(piece)
        self.text[mid] = self.text.get(mid, "") + delta

    async def reasoning(self, step: str, text: str) -> None:
        mid = "ma:r:" + step
        group = [
            event("REASONING_START", messageId=mid),
            event("REASONING_MESSAGE_START", messageId=mid, role="reasoning"),
            event("REASONING_MESSAGE_CONTENT", messageId=mid, delta=text),
            event("REASONING_MESSAGE_END", messageId=mid),
            event("REASONING_END", messageId=mid),
        ]
        frames = [await self.frame(item, optional=True) for item in group]
        if all(frames):
            await self.write(b"".join(frames))

    async def custom(self, name: str, data: Any) -> None:
        await self.write(
            await self.frame(
                event("CUSTOM", name="modular-agent.event", value={"type": name, "data": data}),
                optional=True,
            )
        )

    async def plugin(self, d: Obj) -> None:
        name, data = d["kind"], d.get("data")
        if name in ("modular-agent.agui.stateSnapshot", "modular-agent.agui.stateDelta"):
            if d["plugin"] != self.v.binding.state_plugin or not isinstance(data, dict):
                return
            revision = data.get("revisionId")
            if not isinstance(revision, str):
                return
            if name.endswith("Snapshot") and "snapshot" in data:
                frame = event("STATE_SNAPSHOT", snapshot=data["snapshot"])
            elif (
                "delta" in data
                and self.state_revision is not None
                and self.state_revision == data.get("baseRevisionId")
            ):
                frame = event("STATE_DELTA", delta=data["delta"])
            else:
                self.state_revision = None
                return
            gated = await self.v.gate("event", frame)
            self.state_revision = revision if same_json(frame, gated) else None
            if gated and (self.state_revision or name.endswith("Snapshot")):
                await self.write(b"data: " + encode(gated) + b"\n\n")
        elif name == "modular-agent.agui.raw":
            source = self.v.binding.raw_sources.get(d["plugin"])
            if source:
                await self.write(
                    await self.frame(event("RAW", source=source, event=data), optional=True)
                )
        else:
            await self.custom(name, data)
