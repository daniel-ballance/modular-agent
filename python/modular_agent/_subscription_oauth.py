"""OAuth helpers shared by the subscription sign-ins."""

import asyncio
from collections.abc import Awaitable, Callable, Collection
from dataclasses import dataclass
import re
from typing import Literal

from httpx2 import Response

from ._subscription_logins import OAuth
from ._types import AgentError, ErrorCode, JsonObject

DEFAULT_CLIENT_IDENTITY = "modular-agent"


def validate_client_identity(value: str, code: ErrorCode = ErrorCode.INVALID_COMPOSITION) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", value):
        raise AgentError(
            code,
            "client_identity must be 1 to 64 ASCII letters, digits, dots, underscores or hyphens",
        )
    return value


@dataclass(frozen=True)
class SignInStep:
    kind: Literal["openAndPaste", "deviceCode", "waiting"]
    url: str = ""
    code: str | None = None
    message: str | None = None


type Show = Callable[[SignInStep], None]
type Paste = Callable[[], Awaitable[str | None]]


def json_body(response: Response) -> JsonObject:
    try:
        data = response.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def oauth_error(data: JsonObject) -> str | None:
    error = data.get("error")
    if isinstance(error, dict):
        error = error.get("code")
    return error if isinstance(error, str) else None


# Keep the polling delay separate so offline tests can advance it without waiting.
_sleep = asyncio.sleep


async def poll_device(
    send: Callable[[], Awaitable[Response]],
    finish: Callable[[JsonObject], Awaitable[OAuth]],
    failure: Callable[[str | None, int], ValueError],
    *,
    delay: int,
    expires: int,
    pending_statuses: Collection[int] = (),
) -> OAuth:
    async with asyncio.timeout(expires):
        while True:
            await _sleep(delay)
            response = await send()
            data = json_body(response)
            if response.is_success:
                return await finish(data)
            error = oauth_error(data)
            if error == "slow_down":
                delay += 5
            elif error in ("access_denied", "authorization_denied", "expired_token"):
                raise failure(error, response.status_code)
            elif (
                error
                not in (
                    "authorization_pending",
                    "deviceauth_authorization_pending",
                )
                and response.status_code not in pending_statuses
            ):
                raise failure(error, response.status_code)
