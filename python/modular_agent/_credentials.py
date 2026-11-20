"""Credential stores and the authorized secret-answer path."""

import asyncio
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from ma_core import AgentError
from ma_credentials import StagedCredentials
from ma_credentials.staging import StagedFile


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


def file_credentials(path: str | os.PathLike[str]) -> CredentialStore:
    """Read and stage named answers in an owner-only JSON file."""
    file = StagedFile(path)
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
