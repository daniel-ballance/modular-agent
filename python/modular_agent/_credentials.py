"""Bridge a credential store to the question and Provider lifecycles."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from ma_core import AgentError, Plugin
from ma_credentials import Credentials


@dataclass(frozen=True)
class CredentialStore:
    """Read a named secret and persist an accepted answer, without returning its value."""

    read: Callable[[str], str | None]
    write_answer: Callable[[str, str], Awaitable[None]]


class _CredentialAdapter(Credentials):  # type: ignore[misc]  # Untyped base adapter.
    def __init__(self, store: CredentialStore) -> None:
        import asyncio

        self.store = store
        self.intake = asyncio.Lock()

    async def start(self, api: Any) -> None:
        await Plugin.start(self, api)
        api.provide("credentials", self)

    async def answer(self, d: dict[str, Any], emit: Any) -> Any:
        async with self.intake:
            identity = {k: d[k] for k in ("session", "request", "actor")}
            q = await self.api.call("questions", "validate", identity)
            name, value = q.get("name"), d.get("value")
            if q["kind"] != "secret" or not isinstance(name, str) or not isinstance(value, str):
                raise AgentError("Invalid secret intake", "invalid_request")
            try:
                await self.store.write_answer(name, value)
            except Exception:
                raise AgentError("Credential could not be stored", "credentials") from None
            return await self.api.call("questions", "record_secret", {**identity, "name": name})

    async def get(self, d: dict[str, Any], emit: Any) -> str | None:
        return self.store.read(d["name"])
