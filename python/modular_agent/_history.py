"""SDK history selections. The base owns persistence and the lease protocol."""

from __future__ import annotations

from dataclasses import dataclass
from os import PathLike
from pathlib import Path
from typing import Literal

from ._history_port import HistoryPort, _route
from ._types import AgentError, ErrorCode


@dataclass(frozen=True)
class HistoryStore:
    _kind: Literal["memory", "file", "http"]
    _path: Path | None = None
    _url: str | None = None


def memory_history() -> HistoryStore:
    return HistoryStore("memory")


def file_history(dir: str | PathLike[str]) -> HistoryStore:
    return HistoryStore("file", Path(dir))


def http_history(url: str, token_file: str | PathLike[str]) -> HistoryStore:
    return HistoryStore("http", Path(token_file), url)


def serve_history(
    store: HistoryStore | HistoryPort,
    *,
    address: tuple[str, int],
    token_file: str | PathLike[str],
    ttl: float = 2.5,
) -> None:
    """Serve a dedicated opaque record store under the file store directory."""
    import asyncio
    import math

    from ma_history.service import serve

    if isinstance(store, HistoryStore) and (store._kind != "file" or store._path is None):
        raise AgentError(ErrorCode.NOT_SUPPORTED, f"Cannot serve {store._kind} history")
    if not isinstance(store, HistoryStore) and not store.persistent:
        raise AgentError(ErrorCode.NOT_SUPPORTED, f"Cannot serve {type(store).__name__} history")
    if not math.isfinite(ttl) or ttl < 0.001:
        raise AgentError(ErrorCode.INVALID_PARAMS, "History TTL must be at least one millisecond")
    try:
        if isinstance(store, HistoryStore):
            serve(store._path, address, token_file, round(ttl * 1000))
        else:
            with asyncio.Runner() as runner:

                def dispatch(*args: object) -> object:
                    return runner.run(_route(store, *args))  # type: ignore[arg-type]

                serve(None, address, token_file, store.ttl_ms, custom_route=dispatch)
    except (OSError, ValueError) as exc:
        raise AgentError(ErrorCode.INVALID_PARAMS, str(exc)) from exc
