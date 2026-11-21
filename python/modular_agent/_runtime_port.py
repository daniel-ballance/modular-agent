"""Custom turn execution with the same checked callbacks in both placements."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any, Literal, NotRequired, Protocol, TypedDict, cast
from uuid import uuid4

from ma_plugin.rpc import WireError
from ma_plugin.runtime_host import HostedRuntime

from ._context import CallContext
from ._types import AgentError, ErrorCode, Json, JsonObject


class RuntimeSupports(TypedDict):
    continuesAfterRestart: bool
    waitingThroughRestart: bool
    inputDuringTurn: bool
    rewinding: NotRequired[bool]


class RuntimeDeclaration(TypedDict):
    id: str
    supports: RuntimeSupports


type QueuePolicy = Literal["run", "handedBack"]
type _Callback = Callable[[str, JsonObject, str], Awaitable[Json]]


class RuntimePort(Protocol):
    def declaration(self) -> RuntimeDeclaration: ...
    async def run_turn(self, turn: JsonObject, context: RuntimeContext) -> JsonObject: ...
    async def resume_turn(
        self, turn: JsonObject, interrupted: JsonObject, context: RuntimeContext
    ) -> JsonObject: ...
    async def continue_open_calls(
        self, turn: JsonObject, calls: list[JsonObject], context: RuntimeContext
    ) -> JsonObject: ...


class RuntimeContext(CallContext):
    """Callbacks checked against this Runtime's one active turn."""

    def __init__(self, turn: dict[str, Any], callback: _Callback) -> None:
        by = turn["startedBy"]
        super().__init__(
            turn["sessionId"], by["id"] if by["kind"] == "actor" else None, turn_id=turn["turnId"]
        )
        self._callback = callback
        self._listeners: dict[str, Callable[[JsonObject], Awaitable[None]]] = {}

    async def _ask(self, name: str, params: JsonObject, key: str | None = None) -> Json:
        self._check()
        try:
            return await self._callback(name, params, key or uuid4().hex)
        except WireError as exc:
            from ._native import _error

            raise _error(exc, ErrorCode.INVALID_REQUEST) from exc

    async def new_id(self) -> str:
        return cast(str, cast(JsonObject, await self._ask("newId", {}))["id"])

    async def prepare_step(self, step_id: str, usage: JsonObject) -> JsonObject:
        return cast(JsonObject, await self._ask("prepareStep", {"stepId": step_id, "usage": usage}))

    async def model(
        self,
        request: JsonObject,
        step_id: str,
        *,
        on_piece: Callable[[JsonObject], Awaitable[None]] | None = None,
    ) -> JsonObject:
        key = uuid4().hex
        if on_piece is not None:
            self._listeners[key] = on_piece
        try:
            return cast(
                JsonObject, await self._ask("model", {"stepId": step_id, "request": request}, key)
            )
        finally:
            self._listeners.pop(key, None)

    async def hook(self, name: str, payload: JsonObject) -> Json:
        return await self._ask("hook", {"hook": name, "payload": payload})

    async def definition(self, name: str) -> JsonObject | None:
        return cast(JsonObject | None, await self._ask("definition", {"toolName": name}))

    async def run_tool_call(self, call: JsonObject) -> JsonObject:
        return cast(JsonObject, await self._ask("runToolCall", {"call": call}))

    async def record(self, entry: JsonObject) -> JsonObject:
        return cast(JsonObject, await self._ask("record", {"entry": entry}))

    async def take_steering(self, *, final: bool = False) -> JsonObject:
        return cast(JsonObject, await self._ask("takeSteering", {"final": final}))

    async def has_steering(self) -> bool:
        return bool(cast(JsonObject, await self._ask("hasSteering", {}))["waiting"])

    async def history(self, cursor: str | None = None) -> JsonObject:
        return cast(JsonObject, await self._ask("history", {"after": cursor} if cursor else {}))

    async def report(
        self, type: str, data: Json, *, step_id: str | None = None, call_id: str | None = None
    ) -> None:
        await self._ask(
            "report",
            {
                "type": type,
                "data": data,
                **({"stepId": step_id} if step_id else {}),
                **({"toolCallId": call_id} if call_id else {}),
            },
        )

    async def emit(self, type: str, data: Json) -> None:
        if "." not in type:
            raise AgentError(ErrorCode.INVALID_REQUEST, "A custom event needs a dotted name")
        await self.report(type, data)

    async def _piece(self, params: dict[str, Any]) -> None:
        if handler := self._listeners.get(params["parentRequestId"]):
            await handler(params["event"])


async def _dispatch_runtime(
    port: RuntimePort, method: str, params: dict[str, Any], cx: RuntimeContext
) -> JsonObject:
    try:
        if method == "runTurn":
            return await port.run_turn(params["turn"], cx)
        if method == "resumeTurn":
            return await port.resume_turn(params["turn"], params["interrupted"], cx)
        return await port.continue_open_calls(params["turn"], params["calls"], cx)
    except asyncio.CancelledError:
        cx.cancelled.set()
        raise
    finally:
        cx._active = False


class _LocalRuntimeBridge:
    def __init__(self, h: Any, name: str, port: RuntimePort, history: Callable[..., Any]) -> None:
        self.h, self.name, self.port = h, name, port
        self.peer = self
        self._history = history
        self.active: dict[str, RuntimeContext] = {}

    async def notify(self, method: str, params: dict[str, Any]) -> None:
        if cx := self.active.get(params["parentRequestId"]):
            await cx._piece(params)

    async def request(
        self, method: str, params: dict[str, Any], d: dict[str, Any], **options: Any
    ) -> JsonObject:
        keys: set[str] = set()

        async def callback(name: str, value: JsonObject, key: str) -> Json:
            if name == "history":
                return cast(JsonObject, await self._history(d["session"], value.get("after")))
            keys.add(key)
            self.active[key] = cx
            try:
                return cast(Json, await d["runtime"].callback(name, value, key))
            finally:
                self.active.pop(key, None)
                keys.discard(key)

        cx = RuntimeContext(params["turn"], callback)
        try:
            return await _dispatch_runtime(self.port, method.removeprefix("runtime/"), params, cx)
        finally:
            for key in keys:
                self.active.pop(key, None)


class _LocalRuntime(HostedRuntime):  # type: ignore[misc]  # Native Runtime bridge.
    role = "runtime"

    def __init__(
        self,
        h: Any,
        name: str,
        port: RuntimePort,
        history: Callable[..., Any],
        *,
        queued_input: QueuePolicy,
        queued_jobs: QueuePolicy | None,
    ) -> None:
        super().__init__(
            _LocalRuntimeBridge(h, f"sdk:runtime:{name}", port, history), port.declaration()
        )
        self.declarations["queued_input_after_restart"] = queued_input
        if queued_jobs is not None:
            self.declarations["queued_job_reports_after_restart"] = queued_jobs
