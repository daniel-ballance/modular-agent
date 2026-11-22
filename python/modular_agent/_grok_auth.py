"""Grok device sign-in and token refresh."""

from httpx2 import AsyncClient, HTTPError, Response

from ._provider import ModelFailure
from ._subscription_logins import OAuth, now_ms
from ._subscription_oauth import SignInStep, Show, json_body, oauth_error, poll_device
from ._types import JsonObject

_DEVICE = "https://auth.x.ai/oauth2/device/code"
_TOKEN = "https://auth.x.ai/oauth2/token"
_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
_SCOPE = "openid profile email offline_access grok-cli:access api:access"


def _seconds(value: object, default: int) -> int:
    return value if type(value) is int and 0 <= value < 2**53 else default


def _tokens(data: JsonObject, previous: str | None = None) -> OAuth:
    access, refresh = data.get("access_token"), data.get("refresh_token")
    if not isinstance(access, str) or not access:
        raise ValueError("The Grok answer has no access token.")
    if not isinstance(refresh, str) or not refresh:
        if previous is None:
            raise ValueError("The Grok answer has no refresh token.")
        refresh = previous
    ttl = _seconds(data.get("expires_in"), 3600)
    return OAuth(access, refresh, max(0, now_ms() + ttl * 1000 - 300_000))


async def refresh(client: AsyncClient, old: OAuth) -> OAuth:
    try:
        response = await client.post(
            _TOKEN,
            data={
                "grant_type": "refresh_token",
                "refresh_token": old.refresh,
                "client_id": _CLIENT_ID,
            },
            headers={"Accept": "application/json"},
        )
    except HTTPError:
        raise ModelFailure(
            {"kind": "temporary", "message": "Could not reach the Grok token endpoint."}
        ) from None
    data = json_body(response)
    status = response.status_code
    if oauth_error(data) == "invalid_grant" or status in {400, 401, 403}:
        raise ModelFailure(
            {"kind": "credentials", "message": "Grok refused the token refresh. Sign in again."}
        )
    if not response.is_success:
        raise ModelFailure(
            {"kind": "temporary", "message": f"Grok token refresh failed (HTTP {status})."}
        )
    try:
        return _tokens(data, old.refresh)
    except ValueError:
        raise ModelFailure(
            {"kind": "credentials", "message": "Grok returned an invalid token. Sign in again."}
        ) from None


async def device_sign_in(client: AsyncClient, show: Show, identity: str) -> OAuth:
    first = await client.post(
        _DEVICE,
        data={"client_id": _CLIENT_ID, "scope": _SCOPE, "referrer": identity},
        headers={"Accept": "application/json"},
    )
    if not first.is_success:
        raise ValueError(f"Could not start Grok sign-in (HTTP {first.status_code}).")
    data = json_body(first)

    def field(name: str) -> str:
        value = data.get(name)
        if not isinstance(value, str) or not value:
            raise ValueError(f"The Grok sign-in answer has no {name}.")
        return value

    device, code = field("device_code"), field("user_code")
    address = data.get("verification_uri_complete")
    if not isinstance(address, str) or not address:
        address = field("verification_uri")
    if not address.startswith("https://"):
        raise ValueError("The Grok sign-in gave an address that is not https.")
    show(SignInStep("deviceCode", address, code))
    show(SignInStep("waiting"))

    async def send() -> Response:
        return await client.post(
            _TOKEN,
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "client_id": _CLIENT_ID,
                "device_code": device,
            },
            headers={"Accept": "application/json"},
        )

    async def finish(data: JsonObject) -> OAuth:
        return _tokens(data)

    def failure(error: str | None, status: int) -> ValueError:
        if error in ("access_denied", "authorization_denied"):
            return ValueError("The Grok sign-in was denied.")
        if error == "expired_token":
            return ValueError("The Grok sign-in code expired.")
        return ValueError(f"Grok device sign-in failed (HTTP {status}).")

    return await poll_device(
        send,
        finish,
        failure,
        delay=_seconds(data.get("interval"), 5) or 5,
        expires=_seconds(data.get("expires_in"), 900),
    )
