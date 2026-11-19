"""The shared Rust-compatible auth file and refresh transaction."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
import fcntl
import json
import os
from pathlib import Path
import tempfile
import time

from .config import read_object


def now_ms() -> int:
    return time.time_ns() // 1_000_000


@dataclass(frozen=True)
class OAuth:
    access: str
    refresh: str
    expires: int
    account: str | None = None

    @property
    def expired(self) -> bool:
        return self.expires <= now_ms()

    @property
    def secret(self) -> str:
        return self.access

    def wire(self) -> dict[str, str | int]:
        record: dict[str, str | int] = {
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
    secret: str
    expired = False

    def wire(self) -> dict[str, str | int]:
        return {"type": "api_key", "key": self.secret}


type Login = OAuth | ApiKey


class AuthFile:
    def __init__(self, path: Path) -> None:
        self.path = path

    def _read(self) -> tuple[dict[str, Login], dict[str, str]]:
        try:
            doc = read_object(self.path)
            logins, answers = doc.get("logins", {}), doc.get("answers", {})
            if not isinstance(logins, dict) or not isinstance(answers, dict):
                raise ValueError
            parsed: dict[str, Login] = {}
            for name, v in logins.items():
                match v:
                    case {
                        "type": "oauth",
                        "access": str(access),
                        "refresh": str(refresh),
                        "expires": int(expires),
                        **extra,
                    } if type(expires) is int and 0 <= expires < 2**64:
                        account = extra.get("account")
                        if account is not None and not isinstance(account, str):
                            raise ValueError
                        parsed[name] = OAuth(access, refresh, expires, account)
                    case {"type": "api_key", "key": str(key)}:
                        parsed[name] = ApiKey(key)
                    case _:
                        raise ValueError
            saved: dict[str, str] = {}
            for name, value in answers.items():
                if not isinstance(value, str):
                    raise ValueError
                saved[name] = value
            return parsed, saved
        except ValueError:
            raise ValueError(f"{self.path} is not a valid credential file") from None

    def login(self, provider: str) -> Login | None:
        return self._read()[0].get(provider)

    def answer(self, name: str) -> str | None:
        return self._read()[1].get(name)

    async def set_answer(self, name: str, value: str) -> None:
        async with self._locked():
            logins, answers = self._read()
            answers[name] = value
            self._write(logins, answers)

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

    def _write(self, logins: dict[str, Login], answers: dict[str, str]) -> None:
        temp: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                prefix=".auth-",
                suffix=".tmp",
                dir=self.path.parent,
                delete=False,
            ) as f:
                temp = Path(f.name)
                os.fchmod(f.fileno(), 0o600)
                json.dump(
                    {
                        "logins": {name: logins[name].wire() for name in sorted(logins)},
                        "answers": dict(sorted(answers.items())),
                    },
                    f,
                    ensure_ascii=False,
                    indent=2,
                )
                f.flush()
                os.fsync(f.fileno())
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
            logins, answers = self._read()
            if login is None:
                logins.pop(provider, None)
            else:
                logins[provider] = login
            self._write(logins, answers)

    async def current(
        self,
        provider: str,
        refresh: Callable[[OAuth], Awaitable[OAuth]],
        *,
        rejected: str | None = None,
    ) -> Login:
        def require(login: Login | None) -> Login:
            if login is None:
                raise ValueError(f"not signed in to {provider}; run `ma login {provider}`")
            return login

        login = require(self.login(provider))
        if not login.expired and rejected is None:
            return login
        async with self._locked():
            logins, answers = self._read()
            login = require(logins.get(provider))
            if isinstance(login, OAuth) and (login.expired or login.access == rejected):
                logins[provider] = login = await refresh(login)
                self._write(logins, answers)
            return login
