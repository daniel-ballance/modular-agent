"""A working environment for tests; no host filesystem or subprocess access."""

from __future__ import annotations

import base64
import inspect
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from os import PathLike
from pathlib import Path, PurePosixPath
from typing import Any

from ma_core import AgentError as _NativeError
from ma_core import Plugin as _NativePlugin

from ._types import JsonObject


type ExecHandler = Callable[[str], JsonObject | Awaitable[JsonObject]]


@dataclass(frozen=True)
class LocalEnvironment:
    root: Path | None = None


def local_environment(root: str | PathLike[str] | None = None) -> LocalEnvironment:
    """Select the local environment, rooted at the project unless specified."""
    return LocalEnvironment(Path(root) if root is not None else None)


class MemoryEnvironment(_NativePlugin):  # type: ignore[misc]  # Untyped base adapter.
    name = "memory-environment"
    role = "environment"
    declarations = {
        "containment": "none",
        "stops_commands_on_crash": False,
        "rewind": False,
        "confines_files": True,
    }

    def __init__(self, files: Mapping[str, str | bytes] | None = None) -> None:
        self._files = {
            self._path(k): v.encode() if isinstance(v, str) else v for k, v in (files or {}).items()
        }
        self._exec: dict[str, ExecHandler] = {}

    @staticmethod
    def _path(path: str) -> str:
        name = PurePosixPath(path)
        if ".." in name.parts or "\0" in path:
            raise _NativeError("Invalid memory path", "invalid_request")
        return str(name).lstrip("/") or "."

    def on_exec(self, name: str, handler: ExecHandler) -> None:
        self._exec[name] = handler

    async def start(self, api: Any) -> None:
        await super().start(api)
        api.provide("environment", self)

    async def read(self, d: dict[str, Any], emit: Any) -> str:
        return self._read(d["path"]).decode()

    def _read(self, path: str) -> bytes:
        try:
            return self._files[self._path(path)]
        except KeyError:
            raise _NativeError("File does not exist", "not_found") from None

    async def read_bytes(self, d: dict[str, Any], emit: Any) -> JsonObject:
        return {"data": base64.b64encode(self._read(d["path"])).decode()}

    async def write(self, d: dict[str, Any], emit: Any) -> JsonObject:
        data: bytes = d["text"].encode()
        self._files[self._path(d["path"])] = data
        return {"bytes": len(data)}

    async def write_bytes(self, d: dict[str, Any], emit: Any) -> JsonObject:
        self._files[self._path(d["path"])] = base64.b64decode(d["data"], validate=True)
        return {}

    async def exists(self, d: dict[str, Any], emit: Any) -> JsonObject:
        path = self._path(d["path"])
        return {
            "exists": path == "."
            or path in self._files
            or any(p.startswith(path + "/") for p in self._files)
        }

    async def list_directory(self, d: dict[str, Any], emit: Any) -> JsonObject:
        path = self._path(d["path"])
        if path in self._files:
            raise _NativeError("Not a directory", "invalid_request")
        prefix = "" if path == "." else path + "/"
        entries = {}
        for file in self._files:
            if file.startswith(prefix):
                name, sep, _ = file[len(prefix) :].partition("/")
                entries[name] = "directory" if sep else "file"
        if path != "." and not entries:
            raise _NativeError("Directory does not exist", "not_found")
        return {"entries": [{"name": name, "kind": entries[name]} for name in sorted(entries)]}

    async def bash(self, d: dict[str, Any], emit: Any) -> JsonObject:
        command: str = d["command"]
        name, _, args = command.strip().partition(" ")
        if name not in self._exec:
            raise _NativeError(f"No memory command {name!r}", "not_supported")
        result = self._exec[name](args)
        body = await result if inspect.isawaitable(result) else result
        return {"exit_code": 0, "text": "", **body}


def memory_environment(files: Mapping[str, str | bytes] | None = None) -> MemoryEnvironment:
    return MemoryEnvironment(files)
