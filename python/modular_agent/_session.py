"""Session operations over the base's admission and recorded turn boundaries."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Sequence
from copy import copy
from typing import TYPE_CHECKING, Any, Self, cast
from uuid import uuid4

from ma_core.wire import entry_out, result_out, settings_in, settings_out, turn_end_out, usage_out

from ._types import (
    Actor,
    AgentError,
    AnswerInput,
    Disposition,
    ErrorCode,
    Event,
    EventData,
    Input,
    InputReceipt,
    Json,
    JsonObject,
    Outcome,
    OutcomeKind,
    PromptResult,
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
    "tool_progress": "toolOutput",
    "input_request_opened": "questionOpened",
    "input_request_answered": "questionAnswered",
    "input_request_closed": "questionClosed",
    "input_request_unanswerable": "questionNoLongerAnswerable",
    "history_entry": "entry",
    "session_started": "sessionStarted",
    "session_ended": "sessionEnded",
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
            else [Event(d.get("stream_type", "text"), data=EventData({"delta": d["text"]}), **args)]
        )
    if kind == "tool_progress" and d.get("final"):
        return []
    if kind == "turn_ended":
        data = turn_end_out(d)
    elif kind == "history_entry":
        entry = entry_out(ids)
        evt = _RECORD_EVENTS.get(ids["kind"])
        return [Event("entry", data=EventData({"entry": entry}), **args)] + (
            [Event(evt, data=EventData(entry["data"]), **args)] if evt else []
        )
    else:
        data = {
            k: v
            for k, v in d.items()
            if k not in {"kind", "time", "session", "turn", "step", "call"}
        }
    event_name = _EVENT_NAMES.get(kind)
    return [Event(event_name, data=EventData(data), **args)] if event_name else []


class _Stream:
    def __init__(self) -> None:
        self.queue: asyncio.Queue[Event | AgentError] = asyncio.Queue(maxsize=512)
        self.overflowed = False
        self.cursor: Json = None

    def push(self, event: Event) -> None:
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
            raise AgentError(ErrorCode.LOST, event.message, {"fromEntry": self.cursor})
        return event

    def delivered(self, event: Event) -> None:
        if event.type == "entry" and isinstance(entry := event.data.fields.get("entry"), dict):
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
        self._streams: set[_Stream] = set()
        self._closed = False
        self._root = self
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
        try:
            receipt = await self._send(input, "now", key=key, result=result)
            if receipt.disposition is not None:
                return
            if receipt.duplicate:
                settled = await self._result(receipt)
                if settled.disposition is Disposition.TURN and settled.outcome is not None:
                    yield Event(
                        "turnEnded",
                        "",
                        self.id,
                        EventData(
                            {
                                "outcome": {"kind": settled.outcome.kind},
                                "result": {"text": settled.text},
                            }
                        ),
                        settled.turn_id,
                    )
                return
            turn_id = None
            while True:
                event = await stream.next()
                entry = event.data.fields.get("entry")
                if isinstance(entry, dict) and entry.get("kind") == "turnStart":
                    data = entry.get("data")
                    if isinstance(data, dict) and data.get("input") == receipt.input_id:
                        turn_id = event.turn_id
                if (
                    event.type == "inputHandedBack"
                    and event.data.fields.get("input") == receipt.input_id
                ):
                    return
                if turn_id is not None and event.turn_id == turn_id:
                    stream.delivered(event)
                    yield event
                    if event.type == "turnEnded":
                        return
        finally:
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

    async def events(self, from_entry: str | None = None) -> AsyncIterator[Event]:
        stream, unsubscribe = await self._subscribe()
        try:
            snapshot = (await self._state())["entries"]
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
                    event = Event(
                        "entry",
                        raw["time"],
                        self.id,
                        EventData({"entry": entry}),
                        raw.get("turn"),
                        raw.get("step"),
                        raw.get("call"),
                    )
                    stream.delivered(event)
                    yield event
            while not self._root._closed:
                event = await stream.next()
                if (
                    isinstance(entry := event.data.fields.get("entry"), dict)
                    and entry.get("id") in entry_ids
                ):
                    continue
                stream.delivered(event)
                yield event
                if event.type == "sessionEnded":
                    return
        finally:
            unsubscribe()

    async def last_turn(self) -> PromptResult | None:
        records = await self._native("branch")
        for entry in reversed(records):
            if entry["kind"] == "turn_end":
                return _turn(entry, records)
        return None

    async def history(self) -> list[JsonObject]:
        state = await self._state()
        result = []
        for entry in state["entries"]:
            visible = await self._agent._session(
                "view", session=self.id, recipient=self._actor, type="entry", value=entry_out(entry)
            )
            if visible is not None:
                result.append(visible)
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

    async def on_question(self, handler: QuestionHandler | None) -> None:
        if self._actor != "user":
            raise AgentError(ErrorCode.FORBIDDEN, "Question handlers represent the local actor")
        await self._state()
        await self._agent._set_handler(self.id, handler)

    async def answer(self, question_id: str, answer: AnswerInput) -> None:
        if self._root._closed:
            raise AgentError(ErrorCode.NOT_OPEN, "Session is not open")
        await self._agent._answer(self.id, question_id, _answer(answer), self._actor)

    async def questions(self) -> list[Question]:
        await self._state()
        from ._native import _question

        questions = await self._agent._call(
            "questions", "list", session=self.id, actor=self._actor, **self._acting(self._actor)
        )
        result = []
        for q in questions:
            if q.get("answerable"):
                visible = await self._agent._session(
                    "view",
                    session=self.id,
                    recipient=self._actor,
                    type="reply",
                    method="questions",
                    value=q,
                )
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
