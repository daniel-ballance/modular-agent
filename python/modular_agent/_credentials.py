"""Credential stores and the authorized secret-answer path."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ma_core import AgentError
from ma_credentials import StagedCredentials
from ma_credentials.staging import StagedFile

from ._types import JsonObject

if TYPE_CHECKING:
    from ._subscription_logins import SubscriptionLogins


@dataclass(frozen=True)
class CredentialStore:
    """Read credentials. Secret answers require all four staging operations."""

    read: Callable[[str], str | None]
    stage: Callable[[str, str, str, str, str], Awaitable[dict[str, str]]] | None = None
    lookup_staged: Callable[[str, str], Awaitable[dict[str, str] | None]] | None = None
    activate: Callable[[str, str], Awaitable[str]] | None = None
    discard: Callable[[str, str], Awaitable[None]] | None = None


def environment_credentials() -> CredentialStore:
    return CredentialStore(lambda name: os.getenv(name.upper().replace("-", "_") + "_API_KEY"))


class _LoginFileAnswers(StagedFile):  # type: ignore[misc]  # Untyped base store.
    def __init__(self, logins: SubscriptionLogins) -> None:
        self._logins = logins

    def document(self) -> JsonObject:
        return self._logins.metadata()

    @asynccontextmanager
    async def edit(self) -> AsyncIterator[JsonObject]:
        async with self._logins._edit_metadata() as doc:
            yield doc


def file_credentials(path: str | os.PathLike[str] | SubscriptionLogins) -> CredentialStore:
    """Read and stage named answers, optionally in a shared subscription login file."""
    from ._subscription_logins import SubscriptionLogins

    file = _LoginFileAnswers(path) if isinstance(path, SubscriptionLogins) else StagedFile(path)
    return CredentialStore(file.read, file.stage, file.lookup_staged, file.activate, file.discard)


class _CredentialAdapter(StagedCredentials):  # type: ignore[misc]  # Untyped base adapter.
    def __init__(self, store: CredentialStore) -> None:
        self.store = store
        self.intake = asyncio.Lock()
        self.declarations = {
            "stores_secrets": all(
                op is not None
                for op in (store.stage, store.lookup_staged, store.activate, store.discard)
            )
        }

    async def get(self, d: dict[str, Any], emit: Any) -> str | None:
        try:
            return self.store.read(d["name"])
        except Exception:
            raise AgentError("Credential could not be read", "credentials") from None
