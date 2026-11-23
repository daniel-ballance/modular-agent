"""The protocol-neutral Interface executor connection for embedded bindings."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from copy import deepcopy
from typing import TYPE_CHECKING, Literal, NotRequired, TypedDict, cast
from uuid import uuid4

from ._types import AgentError, Content, ErrorCode, Json, JsonObject

if TYPE_CHECKING:
    from ._agent import Agent


class InterfaceToolSource(TypedDict):
    source_id: str
    actor_id: str
    route_id: str
    result_timeout_ms: int
    tools: Sequence[JsonObject]


class InterfaceToolHandoff(TypedDict):
    session_id: str
    call_id: str
    name: str
    input: JsonObject
    deadline: int


class InterfaceToolReport(TypedDict):
    callId: str
    status: Literal["completed", "failed"]
    content: Content
    value: NotRequired[Json]


InterfaceToolDisposition = Literal["accepted", "alreadySettled", "refused"]


class InterfaceToolConnection:
    """An operator-authenticated executor. Close this handle on disconnect."""

    def __init__(
        self,
        agent: Agent,
        actor_id: str,
        route_id: str,
        on_handoff: Callable[[InterfaceToolHandoff], None] | None,
        rights: Sequence[str] | None,
        tenants: Sequence[str | None],
    ) -> None:
        self._agent = agent
        self._id = uuid4().hex
        allowed = frozenset(tenants)
        project = str(agent._project)
        agent._h.interface_connections[self._id] = {
            "actor": actor_id,
            "route": route_id,
            "scope": (
                actor_id,
                frozenset(rights) if rights is not None else None,
                {},
                lambda session: session["project"] == project and session.get("tenant") in allowed,
            ),
            "offers": {},
            "deliver": on_handoff,
        }

    def advertise(self, session_id: str, tools: Sequence[JsonObject]) -> None:
        """Replace this connection's availability with exact registered definitions."""
        from ma_harness.interface_tools import same_json

        h = self._agent._h
        cx = h.interface_connections.get(self._id)
        s = h.sessions.get(session_id)
        if not cx or not s or cx["deliver"] is None or not cx["scope"][-1](s):
            raise AgentError(ErrorCode.FORBIDDEN, "Interface executor is unavailable in this scope")
        names = set()
        for definition in tools:
            name = definition.get("name")
            registered = h.interface_tools.get(name) if isinstance(name, str) else None
            if (
                not registered
                or name in names
                or (registered[1], registered[2]) != (cx["actor"], cx["route"])
                or not same_json(h.interface_advertisements[name], definition)
            ):
                raise AgentError(
                    ErrorCode.INVALID_REQUEST, "Not an exact registered Interface tool"
                )
            names.add(name)
        cx["offers"][session_id] = frozenset(names)

    async def report_tool_result(
        self, session_id: str, report: InterfaceToolReport
    ) -> InterfaceToolDisposition:
        """Report data for a handed-off call, without dispatching anything."""
        from ._native import _error

        try:
            return cast(
                InterfaceToolDisposition,
                await self._agent._h.report_interface_result(
                    session_id, self._id, deepcopy(report)
                ),
            )
        except Exception as exc:
            raise _error(exc) from exc

    def close(self) -> None:
        """Clear availability without cancelling or settling handed-off calls."""
        self._agent._h.interface_connections.pop(self._id, None)
