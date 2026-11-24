"""A login file shared by independent agents and languages."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import fcntl
import json
import os
from pathlib import Path
import stat
import tempfile
import time
from typing import cast

from ._provider import ModelFailure
from ._types import JsonObject


def now_ms() -> int:
    return time.time_ns() // 1_000_000


@dataclass(frozen=True)
class OAuth:
    access: str = field(repr=False)
    refresh: str = field(repr=False)
    expires: int
    account: str | None = field(default=None, repr=False)

    @property
    def expired(self) -> bool:
        return self.expires <= now_ms()

    @property
    def secret(self) -> str:
        return self.access

    def wire(self) -> JsonObject:
        record: JsonObject = {
            "type": "oauth",
            "access": self.access,
            "refresh": self.refresh,
            "expires": self.expires,
        }
        if self.account is not None:
            record["account"] = self.account
        return record


@dataclass(frozen=True)
class ApiKey:
    secret: str = field(repr=False)
    expired = False

    def wire(self) -> JsonObject:
        return {"type": "api_key", "key": self.secret}


type Login = OAuth | ApiKey


class SubscriptionLogins:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)

    def _read(self) -> tuple[JsonObject, dict[str, Login]]:
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NONBLOCK)
        except FileNotFoundError:
            return {}, {}
        try:
            with os.fdopen(fd, encoding="utf-8") as source:
                mode = os.fstat(source.fileno()).st_mode
                if not stat.S_ISREG(mode):
                    raise ValueError(f"{self.path} is not a regular credential file")
                if mode & 0o044:
                    raise ValueError(f"{self.path} is readable by others; set its mode to 0600")
                try:
                    doc: object = json.load(source)
                except ValueError:
                    doc = None
            if not isinstance(doc, dict) or not isinstance(raw := doc.get("logins", {}), dict):
                raise TypeError
            logins: dict[str, Login] = {}
            for provider, value in raw.items():
                match value:
                    case {
                        "type": "oauth",
                        "access": str(access),
                        "refresh": str(refresh),
                        "expires": int(expires),
                        **extra,
                    } if type(expires) is int and 0 <= expires < 2**64:
                        account = extra.get("account")
                        if account is not None and not isinstance(account, str):
                            raise TypeError
                        logins[provider] = OAuth(access, refresh, expires, account)
                    case {"type": "api_key", "key": str(key)}:
                        logins[provider] = ApiKey(key)
                    case _:
                        raise TypeError
            return cast(JsonObject, doc), logins
        except TypeError:
            raise ValueError(f"{self.path} is not a valid credential file") from None

    def login(self, provider: str) -> Login | None:
        return self._read()[1].get(provider)

    def metadata(self) -> JsonObject:
        """Read the other top-level members, without the logins."""
        doc, _ = self._read()
        doc.pop("logins", None)
        return doc

    async def update_metadata(self, change: Callable[[JsonObject], None]) -> None:
        """Change the other members in one locked transaction."""
        async with self._edit_metadata() as metadata:
            change(metadata)

    @asynccontextmanager
    async def _edit_metadata(self) -> AsyncIterator[JsonObject]:
        async with self._locked():
            doc, logins = self._read()
            metadata = {k: v for k, v in doc.items() if k != "logins"}
            yield metadata
            metadata.pop("logins", None)
            ordered: JsonObject = {"logins": None}
            ordered.update({k: metadata[k] for k in doc if k in metadata})
            self._write(ordered | metadata, logins)

    @asynccontextmanager
    async def _locked(self) -> AsyncIterator[None]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock = os.open(self.path.with_suffix(".lock"), os.O_WRONLY | os.O_CREAT, 0o600)
        try:
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    await asyncio.sleep(0.025)
            yield
        finally:
            os.close(lock)

    def _write(self, doc: JsonObject, logins: dict[str, Login]) -> None:
        temp: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                prefix=".auth-",
                suffix=".tmp",
                dir=self.path.parent,
                delete=False,
            ) as target:
                temp = Path(target.name)
                os.fchmod(target.fileno(), 0o600)
                json.dump(
                    {**doc, "logins": {name: logins[name].wire() for name in sorted(logins)}},
                    target,
                    ensure_ascii=False,
                    indent=2,
                )
                target.flush()
                os.fsync(target.fileno())
            temp.replace(self.path)
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except OSError:
            raise ValueError("the credential file could not be written") from None
        finally:
            if temp is not None:
                temp.unlink(missing_ok=True)

    async def set_login(self, provider: str, login: Login | None) -> None:
        async with self._locked():
            doc, logins = self._read()
            if login is None:
                logins.pop(provider, None)
            else:
                logins[provider] = login
            self._write(doc, logins)

    async def current(
        self,
        provider: str,
        refresh: Callable[[OAuth], Awaitable[OAuth]],
        *,
        rejected: str | None = None,
    ) -> Login:
        def require(login: Login | None) -> Login:
            if login is None:
                raise ModelFailure(
                    {
                        "kind": "credentials",
                        "message": f"Not signed in to {provider}; sign in again.",
                    }
                )
            return login

        def needs_refresh(login: Login) -> bool:
            return isinstance(login, OAuth) and (login.expired or login.access == rejected)

        login = require(self.login(provider))
        if not needs_refresh(login):
            return login
        async with self._locked():
            doc, logins = self._read()
            login = require(logins.get(provider))
            if isinstance(login, OAuth) and needs_refresh(login):
                logins[provider] = login = await refresh(login)
                self._write(doc, logins)
            return login


def subscription_logins(path: str | Path) -> SubscriptionLogins:
    return SubscriptionLogins(path)
