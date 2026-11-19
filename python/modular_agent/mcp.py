"""The official MCP tool source for stdio and Streamable HTTP servers."""

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ma_mcp import MCP

from ._plugin import Plugin
from ._types import JsonObject


@dataclass(frozen=True)
class _McpOptions:
    servers: tuple[JsonObject, ...]
    project_servers: Callable[[Path], Sequence[JsonObject]] | None


class _McpPlugin(Plugin):
    def __init__(self, options: _McpOptions) -> None:
        super().__init__("mcp")
        self.options = options

    def _native(self) -> Any:
        return MCP(
            self.options.servers,
            standard_names=True,
            project_servers=self.options.project_servers,
            prepare_hook="session.prepare",
        )


def mcp(
    servers: Sequence[JsonObject] = (),
    *,
    project_servers: Callable[[Path], Sequence[JsonObject]] | None = None,
) -> Plugin:
    """Connect configured servers. A project resolver must check trust before returning programs."""
    return _McpPlugin(_McpOptions(tuple(servers), project_servers))
