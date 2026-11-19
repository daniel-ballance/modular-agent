"""Session operations over the base's admission and recorded turn boundaries."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any, cast
from uuid import uuid4

from ma_core.wire import entry_out, settings_in, settings_out, turn_end_out, usage_out

from ._types import (
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
            raise event
        if isinstance(entry := event.data.fields.get("entry"), dict):
            self.cursor = entry.get("id")
        return event


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
        r["call"]: r for r in records if r.get("turn") == turn_id and r["kind"] == "tool_result"
    }
    tools = []
    for r in records:
        if r.get("turn") == turn_id and r["kind"] == "tool_call" and r["call"] in results:
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
        end.get("value"),
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

    async def _native(self, op: str, **data: Any) -> Any:
        if self._closed:
            raise AgentError(ErrorCode.NOT_OPEN, "Session is not open")
        return await self._agent._session(op, session=self.id, actor="user", **data)

    async def _state(self) -> dict[str, Any]:
        return cast(dict[str, Any], await self._native("get"))

    async def send(self, input: Input, timing: Timing, *, key: str | None = None) -> InputReceipt:
        if self._closed:
            raise AgentError(ErrorCode.NOT_OPEN, "Session is not open")
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
            actor="user",
            when=timing,
            content=_content(input),
            key=key,
            commands=False,
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
            state = await self._state()
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

    async def prompt(self, input: Input, *, key: str | None = None) -> PromptResult:
        return await self._result(await self.send(input, "now", key=key))

    async def prompt_stream(self, input: Input, *, key: str | None = None) -> AsyncIterator[Event]:
        stream = _Stream()
        self._streams.add(stream)
        try:
            receipt = await self.send(input, "now", key=key)
            if receipt.disposition is not None:
                return
            if receipt.duplicate:
                result = await self._result(receipt)
                if result.disposition is Disposition.TURN and result.outcome is not None:
                    yield Event(
                        "turnEnded",
                        "",
                        self.id,
                        EventData(
                            {
                                "outcome": {"kind": result.outcome.kind},
                                "result": {"text": result.text},
                            }
                        ),
                        result.turn_id,
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
                    yield event
                    if event.type == "turnEnded":
                        return
        finally:
            self._streams.discard(stream)

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
                "view", session=self.id, recipient="user", type="entry", value=entry_out(entry)
            )
            if visible is not None:
                result.append(visible)
        return result

    async def cancel(self) -> list[InputReceipt]:
        state = await self._state()
        before = {e["id"] for e in state["entries"]}
        await self._agent._call("runtime", "cancel", session=self.id, actor="user")
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
        return self._agent._attach(result["id"])

    async def on_question(self, handler: QuestionHandler | None) -> None:
        await self._state()
        await self._agent._set_handler(self.id, handler)

    async def answer(self, question_id: str, answer: AnswerInput) -> None:
        await self._state()
        await self._agent._answer(self.id, question_id, _answer(answer))

    async def questions(self) -> list[Question]:
        await self._state()
        from ._native import _question

        return [
            _question(self.id, q)
            for q in await self._agent._call("questions", "list", session=self.id, actor="user")
        ]

    async def commands(self) -> dict[str, str]:
        await self._state()
        return cast(dict[str, str], await self._agent._session("commands"))

    async def run_command(self, line: str) -> str | None:
        name = line.removeprefix("/").partition(" ")[0]
        if name not in await self.commands():
            raise AgentError(ErrorCode.NOT_FOUND, f"Unknown command: {name}")
        response = await self._native("command", text=line)
        return cast(str | None, response.get("output"))

    async def close(self) -> None:
        if not self._closed:
            await self._native("close")
            self._closed = True
            self._changed.set()
            self._agent._detached(self.id)
