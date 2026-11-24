"""Adapter for working environments implementing the public plugin port."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Literal, Protocol, TypedDict, NotRequired, cast

from ma_core import Plugin as _NativePlugin
from ma_plugin.host import Environment as _NativePort
from ma_plugin.rpc import exec_timeout

from ._types import AgentError, ErrorCode, JsonObject


class EnvironmentSupports(TypedDict):
    containment: Literal["strong", "processGroup", "none"]
    platforms: NotRequired[list[str]]
    points: NotRequired[bool]
    confinesFiles: NotRequired[bool]


class WorkingEnvironment(Protocol):
    supports: EnvironmentSupports

    async def read(self, params: JsonObject) -> JsonObject: ...
    async def exists(self, params: JsonObject) -> JsonObject: ...
    async def write(self, params: JsonObject) -> JsonObject: ...
    async def exec(
        self, params: JsonObject, progress: Callable[[str], Awaitable[None]]
    ) -> JsonObject: ...
    async def session_ended(self, params: JsonObject) -> None: ...


_METHODS = {
    "read": "read",
    "write": "write",
    "exists": "exists",
    "exec": "exec",
    "list": "list",
    "save": "save_point",
    "checkPoint": "check_point",
    "restore": "restore_point",
    "sessionEnded": "session_ended",
}


async def _dispatch_environment(
    environment: WorkingEnvironment,
    name: str,
    params: JsonObject,
    progress: Callable[[str], Awaitable[None]],
) -> JsonObject:
    if name == "exec":
        exec_timeout(params)
    operation = getattr(environment, _METHODS.get(name, ""), None)
    if operation is None:
        raise AgentError(ErrorCode.NOT_SUPPORTED, f"Environment does not implement {name}")
    result = await (operation(params, progress) if name == "exec" else operation(params))
    return {} if result is None else cast(JsonObject, result)


class _WorkingPart(_NativePlugin):  # type: ignore[misc]  # Base adapter.
    role = "environment"

    def __init__(self, name: str, environment: WorkingEnvironment) -> None:
        self.name = "sdk:environment:" + name
        self.environment = environment
        support = environment.supports
        self.declarations = {
            "containment": support["containment"],
            "stops_commands_on_crash": support["containment"] == "strong",
            "platforms": support.get("platforms", []),
            "rewind": support.get("points", False),
            "confines_files": support.get("confinesFiles", False),
        }

    async def start(self, api: Any) -> None:
        self.api = api
        api.provide("environment", _NativePort(self))
        api.on("session.end", self.session_ended)
        api.on("session.suspend", self.session_ended)

    async def session_ended(self, d: JsonObject) -> None:
        await self.environment.session_ended({"sessionId": d["session"]})

    async def request(
        self, method: str, params: JsonObject, context: JsonObject, emit: Any
    ) -> JsonObject:
        from ma_core import AgentError as NativeError

        async def progress(chunk: str) -> None:
            await emit({"text": chunk})

        try:
            return await _dispatch_environment(
                self.environment, method.removeprefix("env/"), params, progress
            )
        except AgentError as exc:
            raise NativeError(exc.message, exc.code.value, exc.data) from exc
