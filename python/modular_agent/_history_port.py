"""Opaque records and writer leases at the public history port."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from os import PathLike
from pathlib import Path
from typing import Any, Protocol, cast
from urllib.parse import parse_qsl, unquote, urlsplit

from ma_history.http import HTTPHistory, ServiceError
from ma_history.service import Refusal, sqlite_store

from ._types import AgentError, ErrorCode, JsonObject


class HistoryPort(Protocol):
    """The history binding's opaque store, including atomic, fenced mutation.

    Parameters and returned dictionaries keep the history HTTP binding's
    shapes; implementations own locking, expiry, and durable settlement.
    A refusal from renew reports lost writer access. A store with independent
    revocation notices also implements async `wait_writer_lost(session_id, lease)`:
    return once the named lease is lost. The agent cancels the wait on close.
    """

    persistent: bool
    ttl_ms: int

    async def create(self, session_id: str, metadata: JsonObject) -> None: ...
    async def acquire(self, session_id: str, owner: str) -> JsonObject: ...
    async def renew(self, session_id: str, lease: str) -> JsonObject: ...
    async def release(self, session_id: str, lease: str) -> None: ...
    async def append(
        self, session_id: str, lease: str, entries: Sequence[JsonObject]
    ) -> JsonObject: ...
    async def read(self, session_id: str, *, after: str | None, limit: int) -> JsonObject: ...
    async def list(self, *, project: str | None, after: str | None, limit: int) -> JsonObject: ...
    async def erase(
        self, session_id: str, entry_ids: Sequence[str], *, lease: str | None
    ) -> JsonObject: ...


_STATUS = {
    "invalid_request": 400,
    "unknown_session": 404,
    "unknown_entry": 404,
    "held": 409,
    "lost": 409,
    "conflict": 409,
    "entry_too_large": 413,
    "request_too_large": 413,
    "unavailable": 503,
}


async def _route(
    store: HistoryPort,
    method: str,
    route: str,
    sid: str,
    lease: str,
    query: dict[str, str],
    body: dict[str, Any] | None,
) -> JsonObject:
    data = body or {}
    try:
        if route == "version":
            return {"binding": "modular-agent-history/1", "ttlMs": store.ttl_ms}
        if method == "PUT":
            await store.create(sid, data)
            return {}
        if route == "list":
            return await store.list(
                project=query.get("project"),
                after=query.get("after"),
                limit=int(query.get("limit", 500)),
            )
        if route == "session":
            return await store.read(
                sid, after=query.get("after"), limit=int(query.get("limit", 500))
            )
        if route == "acquire":
            return await store.acquire(sid, data["owner"])
        if route == "renew":
            return await store.renew(sid, lease)
        if route == "release":
            await store.release(sid, lease)
            return {}
        if route == "erase":
            return await store.erase(sid, data["entryIds"], lease=data.get("lease"))
        if route == "append":
            return await store.append(sid, data["lease"], data["entries"])
        raise RuntimeError("Unknown history route")
    except AgentError as exc:
        code = getattr(exc, "history_code", exc.code.value)
        if code not in _STATUS:
            raise  # The acknowledgement is uncertain; do not invent a refusal.
        details = exc.data if isinstance(exc.data, dict) else {}
        raise Refusal(_STATUS[code], code, **details) from exc


class HistoryError(AgentError):
    """A binding refusal which guarantees the request changed nothing."""

    def __init__(self, code: str, message: str, data: JsonObject | None = None) -> None:
        if code not in _STATUS:
            raise ValueError(f"Unknown history refusal: {code}")
        self.history_code = code
        super().__init__(
            ErrorCode(code) if code in ErrorCode._value2member_map_ else ErrorCode.INTERNAL,
            message,
            data,
        )


class _SQLitePort:
    persistent = True

    def __init__(self, store: Any) -> None:
        self._store = store
        self.ttl_ms: int = store.ttl_ms

    def _call(
        self, method: str, route: str, sid: str = "", lease: str = "", **params: Any
    ) -> JsonObject:
        try:
            return cast(
                JsonObject,
                self._store.request(
                    method,
                    route,
                    sid,
                    lease or None,
                    {
                        key: str(value)
                        for key, value in params.get("query", {}).items()
                        if value is not None
                    },
                    params.get("body"),
                ),
            )
        except Refusal as exc:
            code = exc.body["code"]
            raise HistoryError(
                code,
                exc.body["error"],
                {k: v for k, v in exc.body.items() if k not in {"code", "error"}},
            ) from exc

    async def create(self, session_id: str, metadata: JsonObject) -> None:
        self._call("PUT", "session", session_id, body=metadata)

    async def acquire(self, session_id: str, owner: str) -> JsonObject:
        return self._call("POST", "acquire", session_id, body={"owner": owner})

    async def renew(self, session_id: str, lease: str) -> JsonObject:
        return self._call("POST", "renew", session_id, lease)

    async def release(self, session_id: str, lease: str) -> None:
        self._call("DELETE", "release", session_id, lease)

    async def append(
        self, session_id: str, lease: str, entries: Sequence[JsonObject]
    ) -> JsonObject:
        return self._call("POST", "append", session_id, body={"lease": lease, "entries": entries})

    async def read(self, session_id: str, *, after: str | None, limit: int) -> JsonObject:
        return self._call("GET", "session", session_id, query={"after": after, "limit": limit})

    async def list(self, *, project: str | None, after: str | None, limit: int) -> JsonObject:
        return self._call("GET", "list", query={"project": project, "after": after, "limit": limit})

    async def erase(
        self, session_id: str, entry_ids: Sequence[str], *, lease: str | None
    ) -> JsonObject:
        body: JsonObject = {"entryIds": list(entry_ids)}
        if lease is not None:
            body["lease"] = lease
        return self._call("POST", "erase", session_id, body=body)


@contextmanager
def sqlite_history_port(
    directory: str | PathLike[str], *, ttl_ms: int = 2500
) -> Iterator[HistoryPort]:
    """Open the built-in opaque SQLite records and leases for custom adapters."""
    if type(ttl_ms) is not int or not 0 < ttl_ms <= 2**53 - 1:
        raise ValueError("History TTL must be positive milliseconds")
    with sqlite_store(Path(directory), ttl_ms, check_same_thread=False) as store:
        yield _SQLitePort(store)


class _PortHistory(HTTPHistory):  # type: ignore[misc]  # Native history adapter.
    def __init__(self, port: HistoryPort) -> None:
        super().__init__("http://127.0.0.1", Path())
        self.port = port
        self.declarations = {
            **HTTPHistory.declarations,
            **({} if port.persistent else {"retention": "process"}),
        }

    async def start(self, api: Any) -> None:
        self.api = api
        self.ttl = self.port.ttl_ms
        if type(self.ttl) is not int or not 0 < self.ttl <= 2**53 - 1:
            raise ValueError("History TTL must be positive milliseconds")
        api.provide("history", self)

    def _watch_writer(self, sid: str, lease: dict[str, Any]) -> asyncio.Task[None] | None:
        wait = getattr(self.port, "wait_writer_lost", None)
        if wait is None:
            return None

        async def watch() -> None:
            try:
                await wait(sid, lease["id"])
            except Exception:
                # A broken revocation signal cannot vouch for this writer.
                pass
            self._lose(sid, lease)

        return asyncio.create_task(watch())

    async def request(
        self, method: str, path: str, body: dict[str, Any] | None = None
    ) -> JsonObject:
        parsed = urlsplit(path)
        parts = [unquote(x) for x in parsed.path.split("/")]
        sid = parts[3] if len(parts) > 3 else ""
        lease = parts[5] if len(parts) > 5 else ""
        route = {
            3: "list",
            4: "session",
            5: {"lease": "acquire", "entries": "append", "erase": "erase"}.get(parts[-1], ""),
            6: "release",
            7: "renew",
        }[len(parts)]
        try:
            return await _route(
                self.port, method, route, sid, lease, dict(parse_qsl(parsed.query)), body
            )
        except Refusal as exc:
            raise ServiceError(exc.status, exc.body) from exc
