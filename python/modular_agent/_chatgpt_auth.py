"""ChatGPT OAuth through browser and device sign-in."""

import asyncio
import base64
import errno
import hashlib
import json
import secrets
from urllib.parse import parse_qs, urlencode, urlsplit

from httpx2 import AsyncClient, HTTPError, Response

from ._provider import ModelFailure
from ._subscription_logins import OAuth, now_ms
from ._subscription_oauth import Paste, Show, SignInStep, json_body, poll_device
from ._types import JsonObject

_AUTH = "https://auth.openai.com"
_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
_SCOPE = "openid profile email offline_access"
_PORT = 1455
_WAIT = 900


def _pasted_code(line: str, state: str) -> str | None:
    text = line.strip()
    if not text:
        return None
    query_fields = {field.split("=", 1)[0] for field in text.split("&") if "=" in field}
    if "?" in text or query_fields & {"code", "error", "state"}:
        query = text.partition("?")[2] if "?" in text else text
        fields = parse_qs(query.partition("#")[0], keep_blank_values=True)
        if "error" in fields:
            raise ValueError("The sign-in did not complete. Paste a new return address.")
        code = fields.get("code", [""])[0]
        found = fields.get("state", [None])[0]
    else:
        code, marker, tail = text.partition("#")
        found = tail if marker else None
    if found is not None and not secrets.compare_digest(found.encode(), state.encode()):
        raise ValueError(
            "That address is from a different sign-in. Paste the one from this sign-in."
        )
    if not code:
        raise ValueError("No code found. Paste the return address or code.")
    return code


def account(access: str) -> str:
    try:
        payload = access.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        value = claims["https://api.openai.com/auth"]["chatgpt_account_id"]
    except (IndexError, KeyError, TypeError, ValueError):
        value = None
    if not isinstance(value, str) or not value:
        raise ValueError("The ChatGPT token names no account. Sign in again.")
    return value


def _field(data: JsonObject, name: str) -> str:
    value = data.get(name)
    if not isinstance(value, str) or not value:
        raise ValueError(f"The ChatGPT sign-in answer has no {name}.")
    return value


def _tokens(data: JsonObject, previous: str | None = None) -> OAuth:
    access = _field(data, "access_token")
    refresh = data.get("refresh_token") or previous
    if not isinstance(refresh, str) or not refresh:
        raise ValueError("The ChatGPT sign-in answer has no refresh token.")
    expires = data.get("expires_in")
    ttl = expires if type(expires) is int and 0 <= expires < 2**53 else 3600
    return OAuth(access, refresh, max(0, now_ms() + ttl * 1000 - 300_000), account(access))


async def refresh(client: AsyncClient, login: OAuth) -> OAuth:
    try:
        response = await client.post(
            _AUTH + "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "refresh_token": login.refresh,
                "client_id": _CLIENT_ID,
            },
            headers={"Accept": "application/json"},
        )
    except HTTPError:
        raise ModelFailure(
            {"kind": "temporary", "message": "Could not reach the ChatGPT token endpoint."}
        ) from None
    data = json_body(response)
    status = response.status_code
    if data.get("error") == "invalid_grant" or status in {400, 401, 403}:
        raise ModelFailure(
            {"kind": "credentials", "message": "ChatGPT refused the token refresh. Sign in again."}
        )
    if not response.is_success:
        raise ModelFailure(
            {"kind": "temporary", "message": f"ChatGPT token refresh failed (HTTP {status})."}
        )
    try:
        return _tokens(data, login.refresh)
    except ValueError:
        raise ModelFailure(
            {"kind": "credentials", "message": "ChatGPT returned an invalid token. Sign in again."}
        ) from None


async def _exchange(client: AsyncClient, code: str, verifier: str, redirect: str) -> OAuth:
    response = await client.post(
        _AUTH + "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "client_id": _CLIENT_ID,
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": redirect,
        },
        headers={"Accept": "application/json"},
    )
    if not response.is_success:
        raise ValueError(f"ChatGPT sign-in failed (HTTP {response.status_code}).")
    return _tokens(json_body(response))


async def device_sign_in(client: AsyncClient, show: Show) -> OAuth:
    first = await client.post(
        _AUTH + "/api/accounts/deviceauth/usercode", json={"client_id": _CLIENT_ID}
    )
    if not first.is_success:
        raise ValueError(
            f"ChatGPT device sign-in is not available (HTTP {first.status_code}); use browser sign-in."
        )
    data = json_body(first)
    device = _field(data, "device_auth_id")
    code = _field(data, "user_code")
    interval = data.get("interval", 5)
    try:
        delay = max(1, int(interval)) if isinstance(interval, (int, str)) else 5
    except ValueError:
        delay = 5
    show(SignInStep("deviceCode", "https://auth.openai.com/codex/device", code))
    show(SignInStep("waiting"))

    async def send() -> Response:
        return await client.post(
            _AUTH + "/api/accounts/deviceauth/token",
            json={"device_auth_id": device, "user_code": code},
        )

    async def finish(data: JsonObject) -> OAuth:
        return await _exchange(
            client,
            _field(data, "authorization_code"),
            _field(data, "code_verifier"),
            "https://auth.openai.com/deviceauth/callback",
        )

    def failure(error: str | None, status: int) -> ValueError:
        if error in ("access_denied", "authorization_denied", "expired_token"):
            return ValueError("ChatGPT device sign-in was denied or expired.")
        return ValueError(f"ChatGPT device sign-in failed (HTTP {status}).")

    return await poll_device(
        send, finish, failure, delay=delay, expires=_WAIT, pending_statuses={403, 404}
    )


async def browser_sign_in(
    client: AsyncClient, show: Show, paste: Paste | None, identity: str
) -> OAuth:
    state, verifier = secrets.token_urlsafe(16), secrets.token_urlsafe(32)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    )
    done: asyncio.Future[str] = asyncio.get_running_loop().create_future()
    callbacks: set[asyncio.Task[None]] = set()

    async def callback(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        if task is not None:
            callbacks.add(task)
        try:
            async with asyncio.timeout(5):
                line = (await reader.readline()).decode(errors="replace").split()
                target = urlsplit(line[1] if len(line) > 1 and line[0] == "GET" else "")
                code = None
                status, text = "404 Not Found", "Not found."
                if target.path == "/auth/callback" and not done.done():
                    fields = parse_qs(target.query, keep_blank_values=True)
                    if fields.get("state", [""])[0] == state and "error" not in fields:
                        code = fields.get("code", [""])[0]
                    status, text = (
                        ("200 OK", "You can close this tab and return to the terminal.")
                        if code
                        else (
                            "400 Bad Request",
                            "That sign-in did not match or did not complete. Try again.",
                        )
                    )
                writer.write(
                    f"HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {len(text)}\r\nConnection: close\r\n\r\n{text}".encode()
                )
                await writer.drain()
                if code and not done.done():
                    done.set_result(code)
        except (TimeoutError, OSError, ValueError):
            pass
        finally:
            writer.close()
            if task is not None:
                callbacks.discard(task)

    try:
        server = await asyncio.start_server(callback, "127.0.0.1", _PORT)
    except OSError as exc:
        if exc.errno != errno.EADDRINUSE:
            raise
        if paste is None:
            return await device_sign_in(client, show)
        server = None
    port = server.sockets[0].getsockname()[1] if server is not None else _PORT
    redirect = f"http://localhost:{port}/auth/callback"
    url = "https://auth.openai.com/oauth/authorize?" + urlencode(
        {
            "response_type": "code",
            "client_id": _CLIENT_ID,
            "redirect_uri": redirect,
            "scope": _SCOPE,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
            "id_token_add_organizations": "true",
            "codex_cli_simplified_flow": "true",
            "originator": identity,
        }
    )

    async def read_paste(read: Paste) -> None:
        try:
            while not done.done():
                line = await read()
                if done.done():
                    return
                if line is None:
                    if server is None:
                        raise ValueError("The redirect port is in use and no address was pasted.")
                    return
                try:
                    code = _pasted_code(line, state)
                except ValueError as exc:
                    show(SignInStep("openAndPaste", url, message=str(exc)))
                    continue
                if code is not None:
                    done.set_result(code)
                    return
        except Exception as exc:
            if not done.done():
                done.set_exception(exc)

    paste_task = None
    try:
        show(
            SignInStep(
                "openAndPaste",
                url,
                message="The redirect port is in use; paste the return address."
                if server is None
                else None,
            )
        )
        if paste is not None:
            paste_task = asyncio.create_task(read_paste(paste))
        code = await asyncio.wait_for(done, _WAIT)
    finally:
        if server is not None:
            server.close()
            server.close_clients()
        pending = [*callbacks, *([paste_task] if paste_task is not None else [])]
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        if server is not None:
            await server.wait_closed()
    return await _exchange(client, code, verifier, redirect)
