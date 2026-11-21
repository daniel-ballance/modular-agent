"""Public protocols for uncommon in-process parts."""

from __future__ import annotations

import inspect
from collections.abc import Awaitable
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

from ma_core import Plugin as _NativePlugin
from ma_core.wire import settings_in

from ._types import JsonObject

if TYPE_CHECKING:
    from ._agent import Agent


class Configuration(Protocol):
    def settings(self, project: Path) -> JsonObject | Awaitable[JsonObject]: ...

    def trusted(self, project: Path) -> bool | Awaitable[bool]: ...


class Interface(Protocol):
    def start(self, agent: Agent) -> None | Awaitable[None]: ...

    def stop(self) -> None | Awaitable[None]: ...


class _Configuration(_NativePlugin):  # type: ignore[misc]  # Base adapter.
    role = "configuration"
    declarations = {"project_trust": True}

    def __init__(self, owner: str, source: Configuration) -> None:
        self.name = "sdk:config:" + owner
        self.source = source

    async def start(self, api: Any) -> None:
        api.provide("config", self)

    async def load(self, d: JsonObject, emit: Any) -> JsonObject:
        result = self.source.settings(Path(str(d["project"])))
        return settings_in(await result if inspect.isawaitable(result) else result)  # type: ignore[no-any-return]


class _InterfacePart(_NativePlugin):  # type: ignore[misc]  # Base adapter.
    role = "interface"

    def __init__(self, owner: str, interface: Interface, agent: Agent) -> None:
        self.name = "sdk:interface:" + owner
        self.interface, self.agent = interface, agent

    async def start(self, api: Any) -> None:
        result = self.interface.start(self.agent)
        if inspect.isawaitable(result):
            await result

    async def stop(self) -> None:
        result = self.interface.stop()
        if inspect.isawaitable(result):
            await result
