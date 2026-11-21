"""The call-scoped operations shared by SDK handlers."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

from ._types import AgentError, ErrorCode, Json, JsonObject


class CallContext:
    def __init__(
        self,
        session_id: str | None,
        actor_id: str | None,
        *,
        step_id: str | None = None,
        turn_id: str | None = None,
        history: Callable[[str | None], Awaitable[JsonObject]] | None = None,
        emit: Callable[[str, Json], Awaitable[None]] | None = None,
        call_hook: Callable[[str, JsonObject], Awaitable[Json]] | None = None,
    ) -> None:
        self.session_id, self.actor_id = session_id, actor_id
        self.step_id, self.turn_id = step_id, turn_id
        self.cancelled = asyncio.Event()
        self._active = True
        self._history, self._emit, self._hook = history, emit, call_hook

    def _check(self) -> None:
        if not self._active:
            raise AgentError(ErrorCode.INVALID_REQUEST, "This call has settled")

    def log(self, message: str) -> None:
        self._check()
        logging.getLogger("modular_agent.plugin").warning("%s", message)

    async def history(self, cursor: str | None = None) -> JsonObject:
        self._check()
        if self._history is None:
            raise AgentError(ErrorCode.NOT_SUPPORTED, "History is not available in this context")
        return await self._history(cursor)

    async def emit(self, type: str, data: Json) -> None:
        self._check()
        if "." not in type or type.startswith(".") or type.endswith("."):
            raise AgentError(ErrorCode.INVALID_REQUEST, "A custom event needs a dotted name")
        if self._emit is None:
            raise AgentError(ErrorCode.NOT_SUPPORTED, "Events are not available in this context")
        await self._emit(type, data)

    async def call_hook(self, name: str, payload: JsonObject) -> Json:
        self._check()
        if self._hook is None:
            raise AgentError(ErrorCode.NOT_SUPPORTED, "Custom hooks require an in-process plugin")
        return await self._hook(name, payload)


class HookContext(CallContext):
    """Identity and scoped operations of the hook invocation."""

    def __init__(
        self,
        payload: JsonObject,
        *,
        history: Callable[[str | None], Awaitable[JsonObject]] | None = None,
        emit: Callable[[str, Json], Awaitable[None]] | None = None,
        call_hook: Callable[[str, JsonObject], Awaitable[Json]] | None = None,
    ) -> None:
        def part(name: str) -> str | None:
            value = payload.get(name)
            return value if isinstance(value, str) else None

        super().__init__(
            part("sessionId"),
            part("actorId"),
            step_id=part("stepId"),
            turn_id=part("turnId"),
            history=history,
            emit=emit,
            call_hook=call_hook,
        )
