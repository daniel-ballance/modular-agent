"""SDK history selections. The base owns persistence and the lease protocol."""

from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import dataclass
from os import PathLike
from pathlib import Path
from threading import Lock, Thread
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


class HistoryListener:
    def __init__(self, url: str, stop: Callable[[], None], thread: Thread) -> None:
        self.url = url
        self._stop = stop
        self._thread = thread
        self._lock = Lock()

    def close(self) -> None:
        with self._lock:
            if self._thread.is_alive():
                self._stop()
                self._thread.join()


def serve_history(
    store: HistoryStore | HistoryPort,
    *,
    address: tuple[str, int],
    token_file: str | PathLike[str],
    ttl: float = 2.5,
    witness: str | PathLike[str] | None = None,
) -> HistoryListener | None:
    """Serve opaque history. Port zero starts a listener and returns its handle."""
    import asyncio
    import math

    from ma_core import AgentError as NativeError
    from ma_history.service import serve

    if isinstance(store, HistoryStore) and (store._kind != "file" or store._path is None):
        raise AgentError(ErrorCode.NOT_SUPPORTED, f"Cannot serve {store._kind} history")
    if not isinstance(store, HistoryStore) and not store.persistent:
        raise AgentError(ErrorCode.NOT_SUPPORTED, f"Cannot serve {type(store).__name__} history")
    if not math.isfinite(ttl) or ttl < 0.001:
        raise AgentError(ErrorCode.INVALID_PARAMS, "History TTL must be at least one millisecond")

    if witness is not None and not isinstance(store, HistoryStore):
        raise AgentError(ErrorCode.NOT_SUPPORTED, "A custom history port owns its freshness checks")

    def run(started: Callable[[tuple[str, int], Callable[[], None]], None] | None) -> None:
        try:
            if isinstance(store, HistoryStore):
                serve(
                    store._path,
                    address,
                    token_file,
                    round(ttl * 1000),
                    started=started,
                    witness=witness,
                )
            else:
                with asyncio.Runner() as runner:

                    def dispatch(*args: object) -> object:
                        return runner.run(_route(store, *args))  # type: ignore[arg-type]

                    serve(
                        None,
                        address,
                        token_file,
                        store.ttl_ms,
                        custom_route=dispatch,
                        started=started,
                    )
        except NativeError as exc:
            raise AgentError(ErrorCode.UNAVAILABLE, str(exc)) from exc
        except (OSError, ValueError) as exc:
            raise AgentError(ErrorCode.INVALID_PARAMS, str(exc)) from exc

    if address[1] != 0:
        run(None)
        return None

    ready: Future[tuple[str, Callable[[], None]]] = Future()

    def started(bound: tuple[str, int], stop: Callable[[], None]) -> None:
        host, port = bound[:2]
        authority = f"[{host}]" if ":" in host else host
        ready.set_result((f"http://{authority}:{port}", stop))

    def background() -> None:
        try:
            run(started)
        except Exception as exc:
            if ready.done():
                raise
            ready.set_exception(exc)

    thread = Thread(target=background, name="history-service", daemon=True)
    thread.start()
    url, stop = ready.result()
    return HistoryListener(url, stop, thread)
