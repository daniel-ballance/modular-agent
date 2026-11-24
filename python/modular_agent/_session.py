"""Session operations over the base's admission and recorded turn boundaries."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Sequence
from copy import copy
from typing import TYPE_CHECKING, Any, Self, cast
from uuid import uuid4

from ma_core.wire import (
    entry_in,
    entry_out,
    json_equal,
    result_out,
    settings_in,
    settings_out,
    turn_end_out,
    usage_out,
)

from ._event_types import EntryEvent, Event, InputHandedBackEvent, SessionInterruptedEvent, _event
from ._native import _error
from ._types import (
    Actor,
    AgentError,
    AnswerInput,
    Disposition,
    ErrorCode,
    ErasureReport,
    Input,
    InputReceipt,
    Json,
    JsonObject,
    Outcome,
    OutcomeKind,
    PromptResult,
    Proposal,
    Question,
    QuestionHandler,
    Timing,
    ToolResult,
    ToolStatus,
    _answer,
    _content,
    _text,
)

if TYPE_CHECKING:
    from ._agent import Agent


_EVENT_NAMES = {
    "input_accepted": "inputAccepted",
    "input_returned": "inputHandedBack",
    "turn_started": "turnStarted",
    "turn_ended": "turnEnded",
    "step_ended": "stepEnded",
    "job_started": "jobStarted",
    "job_progress": "jobProgress",
    "job_ended": "jobEnded",
    "entries_erased": "entriesErased",
    "position_moved": "positionMoved",
    "plugin_loaded": "pluginLoaded",
    "plugin_replaced": "pluginReplaced",
    "plugin_unloaded": "pluginUnloaded",
    "input_request_opened": "questionOpened",
    "input_request_answered": "questionAnswered",
    "input_request_closed": "questionClosed",
    "input_request_unanswerable": "questionNoLongerAnswerable",
    "history_entry": "entry",
    "session_started": "sessionStarted",
    "session_ended": "sessionEnded",
    "session_interrupted": "sessionInterrupted",
}
_RECORD_EVENTS = {
    "turn_start": "turnStarted",
    "question_closed": "questionClosed",
    "model_started": "stepStarted",
    "tool_call": "toolCall",
    "tool_started": "toolStarted",
    "tool_result": "toolResult",
    "setting": "settingChanged",
    "authority": "actorJoined",
    "actor_left": "actorLeft",
    "input_withdrawn": "inputWithdrawn",
}


def _events(d: dict[str, Any]) -> list[Event]:
    kind = d["kind"]
    ids = d["entry"] if kind == "history_entry" else d
    args = {
        "time": d.get("time") or ids.get("time", ""),
        "session_id": d["session"],
        "turn_id": ids.get("turn"),
        "step_id": ids.get("step"),
        "call_id": ids.get("call"),
    }
    if kind == "model_output":
        return (
            []
            if d.get("final")
            else [
                _event(
                    d.get("stream_type", "text"),
                    {
                        "delta": d.get("delta", d.get("text", "")),
                        **({"toolCallId": d["call"]} if d.get("call") else {}),
                    },
                    **args,
                )
            ]
        )
    if kind == "tool_progress":
        if d.get("final"):
            return []
        return [
            _event(
                "toolOutput",
                {
                    "toolCallId": d["call"],
                    "content": d["content"],
                },
                **args,
            )
        ]
    if kind == "turn_ended":
        data = turn_end_out(d)
    elif kind == "history_entry":
        entry = entry_out(ids)
        evt = _RECORD_EVENTS.get(ids["kind"])
        return [_event("entry", {"entry": entry}, **args)] + (
            [_event(evt, entry["data"], **args)] if evt else []
        )
    else:
        data = {
            k: v
            for k, v in d.items()
            if k not in {"kind", "time", "session", "turn", "step", "call"}
        }
    event_name = _EVENT_NAMES.get(kind)
    if "." in kind:
        return [
            _event(kind, d.get("data", data) if isinstance(d.get("data"), dict) else data, **args)
        ]
    return [_event(event_name, data, **args)] if event_name else []


class _Stream:
    def __init__(self) -> None:
        self.queue: asyncio.Queue[Event | AgentError] = asyncio.Queue(maxsize=512)
        self.overflowed = False
        self.cursor: Json = None

    def push(self, event: Event | AgentError) -> None:
        if self.overflowed:
            return
        if self.queue.full():
            self.overflowed = True
            while not self.queue.empty():
                self.queue.get_nowait()
            self.queue.put_nowait(
                AgentError(ErrorCode.LOST, "Event reader fell behind", {"fromEntry": self.cursor})
            )
        else:
            self.queue.put_nowait(event)

    async def next(self) -> Event:
        event = await self.queue.get()
        if isinstance(event, AgentError):
            if self.overflowed:
                raise AgentError(ErrorCode.LOST, event.message, {"fromEntry": self.cursor})
            raise event
        return event

    def delivered(self, event: Event) -> None:
        if isinstance(event, EntryEvent):
            entry = event.data.fields["entry"]
            self.cursor = entry.get("id")


def _tool_result(e: dict[str, Any], name: str, call_id: str) -> ToolResult:
    status = {"outcome_unknown": "outcomeUnknown", "not_started": "notStarted"}.get(
        e["status"], e["status"]
    )
    return ToolResult(name, ToolStatus(status), call_id, e.get("content", []), e.get("value"))


def _turn(e: dict[str, Any], records: list[dict[str, Any]]) -> PromptResult:
    turn_id = e["turn"]
    end = e["data"]
    start = next(
        (r for r in records if r.get("turn") == turn_id and r["kind"] == "turn_start"), None
    )
    picked = end.get("input") or (start and start["data"].get("input")) or ""
    outcome = turn_end_out(end)["outcome"]
    results = {
        r["call"]: r
        for r in records
        if r.get("turn") == turn_id
        and r["kind"] == "tool_result"
        and not r["data"].get("parentCallId")
    }
    tools = []
    for r in records:
        if (
            r.get("turn") == turn_id
            and r["kind"] == "tool_call"
            and r["data"].get("initiator", "model") == "model"
            and r["call"] in results
        ):
            result = results.pop(r["call"])
            tools.append(
                _tool_result(
                    {**result["data"], "content": result["content"]}, r["data"]["name"], r["call"]
                )
            )
    for call_id, r in results.items():
        tools.append(
            _tool_result(
                {**r["data"], "content": r["content"]},
                r["data"].get("toolName", "unknown"),
                call_id,
            )
        )
    return PromptResult(
        picked,
        Disposition.TURN,
        Outcome(OutcomeKind(outcome["kind"]), outcome.get("error"), outcome.get("limit")),
        _text(end.get("content", [])),
        turn_end_out(end)["result"].get("value"),
        turn_id,
        tuple(end.get("open_calls", [])),
        usage_out(end.get("usage", {})),
        tuple(tools),
    )


class Session:
    def __init__(self, agent: Agent, session_id: str) -> None:
        self._agent = agent
        self.id = session_id
        self._changed = asyncio.Event()
        self._interruption: str | None = None
        self._prompt_streams: set[_Stream] = set()
        self._streams: set[_Stream] = set()
        self._closed = False
        self._root = self
        self._delivery_token = uuid4().hex
        self._actor = "user"

    def _actor_id(self, actor: str) -> str:
        if not isinstance(actor, str) or not actor:
            raise AgentError(ErrorCode.INVALID_PARAMS, "Expected a nonempty actor id")
        if not self._agent._several_actors and actor != "user":
            raise AgentError(ErrorCode.NOT_SUPPORTED, "Several actors are not enabled")
        return actor

    def as_actor(self, actor_id: str) -> Self:
        """Use the named actor's current rights on the same session."""
        view = copy(self)
        view._actor = self._actor_id(actor_id)
        view._delivery_token = uuid4().hex
        return view

    async def join(self, actor: Actor, granted_by: str | None = None) -> None:
        if not self._agent._several_actors:
            raise AgentError(ErrorCode.NOT_SUPPORTED, "Several actors are not enabled")
        subject = self._actor_id(actor["id"])
        if actor["kind"] not in {"user", "host", "agent", "program"}:
            raise AgentError(ErrorCode.INVALID_PARAMS, "Invalid actor kind")
        await self._native(
            "grant",
            acting=self._actor if granted_by is None else self._actor_id(granted_by),
            subject=subject,
            kind=actor["kind"],
            authority=actor["rights"],
        )

    async def leave(self, actor_id: str) -> None:
        if not self._agent._several_actors:
            raise AgentError(ErrorCode.NOT_SUPPORTED, "Several actors are not enabled")
        await self._native("leave", subject=self._actor_id(actor_id))

    async def set_limit(self, rights: Sequence[str] | None = None) -> None:
        if not self._agent._session_limits:
            raise AgentError(ErrorCode.NOT_SUPPORTED, "Session limits are not enabled")
        await self._native("limit", rights=None if rights is None else list(rights))

    async def _native(self, op: str, *, acting: str | None = None, **data: Any) -> Any:
        if self._root._closed:
            raise AgentError(ErrorCode.NOT_OPEN, "Session is not open")
        actor = self._actor if acting is None else acting
        return await self._agent._session(
            op, session=self.id, actor=actor, **self._acting(actor), **data
        )

    @staticmethod
    def _acting(actor: str) -> dict[str, str]:
        return {} if actor == "user" else {"acting_for": "user"}

    async def _state(self) -> dict[str, Any]:
        return cast(dict[str, Any], await self._native("get"))

    async def send(
        self, input: Input, timing: Timing, *, key: str | None = None, actor: str | None = None
    ) -> InputReceipt:
        return await (self if actor is None else self.as_actor(actor))._send(input, timing, key=key)

    async def _send(
        self,
        input: Input,
        timing: Timing,
        *,
        key: str | None = None,
        result: JsonObject | None = None,
    ) -> InputReceipt:
        if result is not None:
            from jsonschema import Draft202012Validator
            from jsonschema.exceptions import SchemaError  # type: ignore[import-untyped]

            try:
                Draft202012Validator.check_schema(result)
            except SchemaError as exc:
                raise AgentError(ErrorCode.INVALID_PARAMS, exc.message) from exc
        if self._root._closed:
            raise AgentError(ErrorCode.NOT_OPEN, "Session is not open")
        if timing == "propose" and not self._agent._several_actors:
            raise AgentError(ErrorCode.NOT_SUPPORTED, "Proposed input is not enabled")
        if timing not in {"now", "steer", "after", "propose"}:
            raise AgentError(ErrorCode.INVALID_PARAMS, "Invalid input timing")
        if key is not None and (not isinstance(key, str) or not key):
            raise AgentError(ErrorCode.INVALID_PARAMS, "Expected a nonempty input key")
        if not isinstance(input, str) and (
            not isinstance(input, list)
            or not all(
                isinstance(part, dict) and isinstance(part.get("type"), str) for part in input
            )
        ):
            raise AgentError(ErrorCode.INVALID_PARAMS, "Expected text or shared Content parts")
        data = await self._agent._call(
            "runtime",
            "submit",
            session=self.id,
            actor=self._actor,
            **self._acting(self._actor),
            when=timing,
            content=_content(input),
            key=key,
            commands=False,
            **({"result_schema": result} if result is not None else {}),
        )
        if data.get("handled"):
            return InputReceipt(
                data.get("input", uuid4().hex), timing, disposition=Disposition.HANDLED
            )
        if data.get("erased"):
            return InputReceipt(data.get("input", ""), timing, True, Disposition.HANDED_BACK)
        return InputReceipt(data["input"], data["when"], data.get("duplicate", False))

    async def _result(self, receipt: InputReceipt) -> PromptResult:
        if receipt.disposition is not None:
            return PromptResult(receipt.input_id, receipt.disposition)
        while True:
            self._changed.clear()
            if self._root._interruption:
                raise AgentError(
                    ErrorCode.LOST, "Session interrupted", {"reason": self._root._interruption}
                )
            state = await self._agent._session("get", session=self.id)
            records = state["entries"]
            turn_id = next(
                (
                    e["turn"]
                    for e in records
                    if e["kind"] in {"turn_start", "input"}
                    and not e.get("fork_source")
                    and e["data"].get("input") == receipt.input_id
                ),
                None,
            )
            for entry in reversed(records):
                if entry.get("turn") == turn_id and turn_id and entry["kind"] == "turn_end":
                    return _turn(entry, records)
                if entry["kind"] == "input_withdrawn" and receipt.input_id in (
                    entry["data"].get("inputIds") or [entry["data"].get("input")]
                ):
                    return PromptResult(receipt.input_id, Disposition.HANDED_BACK)
            if state.get("writer_lost"):
                raise AgentError(
                    ErrorCode.LOST, "Session interrupted", {"reason": state["interruption"]}
                )
            if not state.get("busy"):
                await self._agent._call("runtime", "wait", session=self.id)
                raise AgentError(ErrorCode.LOST, "Input settled without a recorded outcome")
            await self._changed.wait()

    async def prompt(
        self,
        input: Input,
        *,
        key: str | None = None,
        result: JsonObject | None = None,
        actor: str | None = None,
    ) -> PromptResult:
        session = self if actor is None else self.as_actor(actor)
        return await session._result(await session._send(input, "now", key=key, result=result))

    async def prompt_stream(
        self,
        input: Input,
        *,
        key: str | None = None,
        result: JsonObject | None = None,
        actor: str | None = None,
    ) -> AsyncIterator[Event]:
        if actor is not None:
            async for event in self.as_actor(actor).prompt_stream(input, key=key, result=result):
                yield event
            return
        stream, unsubscribe = await self._subscribe()
        self._root._prompt_streams.add(stream)
        try:
            receipt = await self._send(input, "now", key=key, result=result)
            if receipt.disposition is not None:
                return
            if receipt.duplicate:
                settled = await self._result(receipt)
                if settled.disposition is Disposition.TURN and settled.outcome is not None:
                    yield _event(
                        "turnEnded",
                        {
                            "outcome": {"kind": settled.outcome.kind},
                            "result": {"text": settled.text},
                        },
                        "",
                        self.id,
                        settled.turn_id,
                    )
                return
            turn_id = None
            while True:
                event = await stream.next()
                if isinstance(event, SessionInterruptedEvent):
                    raise AgentError(
                        ErrorCode.LOST,
                        "Session interrupted",
                        {"reason": event.data.fields["reason"]},
                    )
                entry = event.data.fields["entry"] if isinstance(event, EntryEvent) else None
                if isinstance(entry, dict) and entry.get("kind") == "turnStart":
                    data = entry.get("data")
                    if isinstance(data, dict) and data.get("input") == receipt.input_id:
                        turn_id = event.turn_id
                if (
                    isinstance(event, InputHandedBackEvent)
                    and event.data.fields["input"] == receipt.input_id
                ):
                    return
                if turn_id is not None and event.turn_id == turn_id:
                    stream.delivered(event)
                    yield event
                    if event.type == "turnEnded":
                        return
        finally:
            self._root._prompt_streams.discard(stream)
            unsubscribe()

    async def _subscribe(self) -> tuple[_Stream, Callable[[], None]]:
        await self._state()
        stream = _Stream()
        if self._actor == "user":
            self._streams.add(stream)
            return stream, lambda: self._streams.discard(stream)

        async def receive(data: dict[str, Any]) -> None:
            if data.get("session") != self.id:
                return
            for event in _events(data):
                stream.push(event)

        follower = ("embedding", self._actor, receive)
        self._agent._h.follow(*follower)

        def unsubscribe() -> None:
            if follower in self._agent._h.followers:
                self._agent._h.followers.remove(follower)

        return stream, unsubscribe

    async def _erasure_revision(self) -> int:
        try:
            return int(await self._agent._h.erasure_revision(self.id))
        except Exception as exc:
            raise _error(exc) from exc

    async def _check_revision(self, revision: int) -> None:
        if revision != await self._erasure_revision():
            raise AgentError(ErrorCode.UNAVAILABLE, "Session view changed during erasure")

    async def events(self, from_entry: str | None = None) -> AsyncIterator[Event]:
        stream, unsubscribe = await self._subscribe()
        try:
            snapshot = (await self._state())["entries"]
            revision = await self._erasure_revision()
            entry_ids = {e["id"] for e in snapshot}
            if from_entry is not None and from_entry not in entry_ids:
                raise AgentError(ErrorCode.NOT_FOUND, "Unknown history cursor")
            replay = from_entry is None
            stream.cursor = from_entry
            for raw in snapshot:
                if not replay:
                    replay = raw["id"] == from_entry
                    continue
                entry = await self._agent._session(
                    "view",
                    session=self.id,
                    recipient=self._actor,
                    type="entry",
                    value=entry_out(raw),
                )
                if entry is not None:
                    event = _event(
                        "entry",
                        {"entry": entry},
                        raw["time"],
                        self.id,
                        raw.get("turn"),
                        raw.get("step"),
                        raw.get("call"),
                    )
                    await self._check_revision(revision)
                    stream.delivered(event)
                    yield event
            while not self._root._closed:
                event = await stream.next()
                await self._check_revision(revision)
                if (
                    isinstance(event, EntryEvent)
                    and (entry := event.data.fields["entry"])
                    and entry.get("id") in entry_ids
                ):
                    continue
                stream.delivered(event)
                yield event
                if event.type in {"sessionEnded", "sessionInterrupted"}:
                    return
        finally:
            unsubscribe()

    async def last_turn(self) -> PromptResult | None:
        records = await self._native("branch")
        end = next((entry for entry in reversed(records) if entry["kind"] == "turn_end"), None)
        if end is None:
            return None
        visible = []
        terminal = None
        for raw in records:
            if raw.get("turn") != end["turn"]:
                continue
            if raw["kind"] not in {"turn_start", "turn_end", "tool_call", "tool_result"}:
                continue
            entry = await self._agent._session(
                "view", session=self.id, recipient=self._actor, type="entry", value=entry_out(raw)
            )
            if entry is not None:
                record = entry_in(entry, self.id)
                visible.append(record)
                if raw["id"] == end["id"]:
                    terminal = record
        if terminal is None:
            raise AgentError(ErrorCode.WITHHELD, "The turn result was withheld")
        return _turn(terminal, visible)

    async def history(self) -> list[JsonObject]:
        state = await self._state()
        revision = await self._erasure_revision()
        result = []
        for entry in state["entries"]:
            visible = await self._agent._session(
                "view", session=self.id, recipient=self._actor, type="entry", value=entry_out(entry)
            )
            if visible is not None:
                result.append(visible)
        await self._check_revision(revision)
        return result

    async def wait_idle(self) -> None:
        """Wait for the running turn and any inputs queued behind it."""
        await self._state()
        await self._agent._call(
            "runtime", "wait", session=self.id, actor=self._actor, **self._acting(self._actor)
        )

    async def cancel(self) -> list[InputReceipt]:
        state = await self._state()
        before = {e["id"] for e in state["entries"]}
        await self._agent._call(
            "runtime", "cancel", session=self.id, actor=self._actor, **self._acting(self._actor)
        )
        return [
            InputReceipt(e["data"]["input"], "now", disposition=Disposition.HANDED_BACK)
            for e in (await self._state())["entries"]
            if e["kind"] == "input_withdrawn" and e["id"] not in before
        ]

    async def settings(self) -> JsonObject:
        return cast(JsonObject, settings_out((await self._state())["settings"]))

    async def set_setting(self, key: str, value: Json) -> None:
        if (await self._state()).get("busy"):
            raise AgentError(ErrorCode.BUSY, "Settings may change only between turns")
        await self._native("settings", changes=settings_in({key: value}))

    async def fork(self, entry_id: str | None = None) -> Session:
        state = await self._state()
        if state.get("busy"):
            raise AgentError(ErrorCode.BUSY, "Cannot fork during a turn")
        if entry_id is not None and not any(
            e["id"] == entry_id for e in await self._native("branch")
        ):
            raise AgentError(ErrorCode.NOT_FOUND, "Fork entry is not on the current branch")
        result = await self._native("fork", **({"point": entry_id} if entry_id is not None else {}))
        return self._agent._attach(result["id"]).as_actor(self._actor)

    async def move_to(self, entry_id: str, *, rewind: bool = False) -> JsonObject:
        entries = await self._native("branch")
        done = {
            "jobs": {e.get("job") for e in entries if e["kind"] == "job_end"},
            "calls": {e.get("call") for e in entries if e["kind"] == "tool_result"},
            "questions": {
                (e.get("data") or {}).get("request")
                for e in entries
                if e["kind"] in {"question_answer", "question_closed"}
            },
        }
        if any(
            (e["kind"] == "tool_deferred" and e.get("call") not in done["calls"])
            or (e["kind"] == "job_start" and e.get("job") not in done["jobs"])
            or (
                e["kind"] == "question_open"
                and (e.get("data") or {}).get("id") not in done["questions"]
            )
            for e in entries
        ):
            raise AgentError(ErrorCode.CONFLICT, "Cannot move with unfinished work")
        result = await self._native("move", point=entry_id, rewind=rewind)
        return {"outOfReach": result.get("outOfReach", [])}

    async def erase(self, entry_ids: Sequence[str]) -> ErasureReport:
        if not self._agent.declaration()["erasure"]:
            raise AgentError(ErrorCode.NOT_SUPPORTED, "History does not support erasure")
        if (
            not entry_ids
            or isinstance(entry_ids, str)
            or any(not isinstance(id, str) or not id for id in entry_ids)
        ):
            raise AgentError(ErrorCode.INVALID_PARAMS, "Erasure requires entry IDs")
        outcome = await self._native("erase", entries=list(entry_ids))
        return {
            "erased": outcome.get("erasedPairs", []),
            "pending": outcome.get("pendingPairs", []),
            "outOfReach": outcome.get("out_of_reach", []),
        }

    async def proposals(self) -> list[Proposal]:
        if not self._agent._several_actors:
            raise AgentError(ErrorCode.NOT_SUPPORTED, "Proposed input is not enabled")
        await self._state()
        data = await self._agent._call(
            "runtime", "proposals", session=self.id, actor=self._actor, **self._acting(self._actor)
        )
        reply = await self._agent._session(
            "view",
            session=self.id,
            recipient=self._actor,
            type="reply",
            method="proposals",
            value={"proposals": data},
        )
        if reply is None:
            raise AgentError(ErrorCode.WITHHELD, "Proposals were withheld")
        return cast(list[Proposal], reply.get("proposals", []))

    async def release(
        self, input_id: str, timing: Timing = "now", *, declined: bool = False
    ) -> InputReceipt:
        if not self._agent._several_actors:
            raise AgentError(ErrorCode.NOT_SUPPORTED, "Proposed input is not enabled")
        if timing not in {"now", "steer", "after"}:
            raise AgentError(ErrorCode.INVALID_PARAMS, "Invalid proposal release timing")
        await self._state()
        receipt = await self._agent._call(
            "runtime",
            "release",
            session=self.id,
            actor=self._actor,
            **self._acting(self._actor),
            input=input_id,
            when=timing,
            declined=declined,
        )
        if receipt["when"] == "handedBack":
            return InputReceipt(input_id, timing, disposition=Disposition.HANDED_BACK)
        return InputReceipt(input_id, receipt["when"])

    async def withdraw(self, input_id: str) -> None:
        if not self._agent._several_actors:
            raise AgentError(ErrorCode.NOT_SUPPORTED, "Proposed input is not enabled")
        await self._state()
        await self._agent._call(
            "runtime",
            "withdraw_proposal",
            session=self.id,
            actor=self._actor,
            **self._acting(self._actor),
            input=input_id,
        )

    async def on_question(self, handler: QuestionHandler | None) -> None:
        if self._actor != "user":
            raise AgentError(ErrorCode.FORBIDDEN, "Question handlers represent the local actor")
        await self._state()
        await self._agent._set_handler(self.id, handler)

    async def answer(self, question_id: str, answer: AnswerInput) -> None:
        if self._root._closed:
            raise AgentError(ErrorCode.NOT_OPEN, "Session is not open")
        await self._agent._answer(
            self.id, question_id, _answer(answer), self._actor, delivery_token=self._delivery_token
        )

    async def questions(self, *, present: bool = False) -> list[Question]:
        await self._state()
        if present and not self._agent._h.max_approval_wait_ms:
            raise AgentError(
                ErrorCode.NOT_SUPPORTED, "This agent does not support waiting approval"
            )
        from ._native import _question

        questions = await self._agent._call(
            "questions",
            "list",
            session=self.id,
            actor=self._actor,
            openOnly=True,
            recipientView=True,
            **self._acting(self._actor),
        )
        result = []
        for q in questions:
            visible = await self._agent._session(
                "view",
                session=self.id,
                recipient=self._actor,
                type="reply",
                method="questions",
                value=q,
            )
            if q.get("approvalWait"):
                exact = q["answerable"] and json_equal(q, visible)
                if present or not exact:
                    self._agent._h.remember_wait(
                        self.id,
                        self._delivery_token,
                        self._actor,
                        q["entry"],
                        "sdk",
                        present and exact,
                        "user",
                    )
                if visible is not None:
                    visible = {**visible, "answerable": bool(present and exact)}
            elif q.get("coversNested"):
                exact = visible is not None and q["answerable"] and json_equal(q, visible)
                delivered = self._agent._live_views.setdefault(q["id"], set())
                key = (self._actor, self._delivery_token)
                if exact:
                    delivered.add(key)
                else:
                    delivered.discard(key)
                    if visible is not None:
                        visible = {**visible, "answerable": False}
            if visible is not None:
                result.append(_question(self.id, visible))
        return result

    async def call_tool(self, name: str, input: JsonObject) -> ToolResult:
        """Call a tool as the local actor through the Runtime's gates."""
        if self._root._closed:
            raise AgentError(ErrorCode.NOT_OPEN, "Session is not open")
        result = await self._agent._call(
            "runtime",
            "run_tool",
            session=self.id,
            actor=self._actor,
            **self._acting(self._actor),
            name=name,
            input=input,
        )
        public = await self._agent._session(
            "view",
            session=self.id,
            recipient=self._actor,
            value=result_out(result),
            type="reply",
            method="callTool",
        )
        if public is None:
            raise AgentError(ErrorCode.WITHHELD, "Tool result withheld")
        return ToolResult(
            name=name,
            status=ToolStatus(public["status"]),
            call_id=public["callId"],
            content=public.get("content", []),
            value=public.get("value"),
        )

    async def commands(self) -> dict[str, str]:
        await self._state()
        return cast(dict[str, str], await self._agent._session("commands"))

    async def run_command(self, line: str) -> str | None:
        name = line.removeprefix("/").partition(" ")[0]
        if name not in await self.commands():
            raise AgentError(ErrorCode.NOT_FOUND, f"Unknown command: {name}")
        response = await self._native("command", text=line)
        if isinstance(response, dict) and isinstance(output := response.get("output"), str):
            return output
        if response:
            import json

            return json.dumps(response, ensure_ascii=False, indent=2)
        return None

    async def close(self) -> None:
        if not self._root._closed:
            await self._native("close")
            self._root._closed = True
            self._changed.set()
            self._agent._detached(self.id)
