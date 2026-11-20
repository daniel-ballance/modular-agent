"""Pi-compatible subscription sign-in, over browser PKCE or a device code."""

import asyncio
import base64
from collections.abc import AsyncIterable, AsyncIterator, Callable
from dataclasses import dataclass
import errno
import hashlib
import json
import os
import secrets
import subprocess
import sys
from typing import Literal, cast
from urllib.parse import parse_qs, urlencode, urlsplit
import webbrowser

from httpx2 import AsyncClient, Response
from modular_agent import JsonObject

from .auth import AuthFile, OAuth, now_ms
from .config import claude_launch

type Vendor = Literal["openai-codex", "xai"]


@dataclass(frozen=True)
class Step:
    address: str = ""
    code: str | None = None
    note: str | None = None
    open_and_paste: bool = False


type Show = Callable[[Step], None]

# Pi's value is a placeholder until the services accept this client's own name.
CLIENT_IDENTITY = "pi"
LABELS = {"openai-codex": "ChatGPT subscription", "xai": "Grok subscription"}
CODEX = "https://auth.openai.com"
XAI = "https://auth.x.ai"
CLIENTS: dict[Vendor, str] = {
    "openai-codex": "app_EMoamEEZ73f0CkXaXp7hrann",
    "xai": "b1a00492-073a-47ea-816f-4c329264a828",
}
SCOPE = "openid profile email offline_access"
REDIRECT = "http://localhost:1455/auth/callback"
WAIT = 900


def pasted_code(line: str, state: str) -> str | None:
    """Read a redirect address, its query, code#state or a bare code."""
    text = line.strip()
    if not text:
        return None
    _, question, query = text.partition("?")
    if question or "code=" in text:
        fields = parse_qs(query.partition("#")[0] if question else text, keep_blank_values=True)
        if question and "error" in fields:
            detail = fields.get("error_description", fields["error"])[0]
            raise ValueError(f"the sign-in was not completed: {detail}")
        code = fields.get("code", [""])[0]
        found = fields["state"][0] if "state" in fields else None
    else:
        code, marker, tail = text.partition("#")
        found = tail if marker else None
    if found is not None and found != state:
        raise ValueError(
            "that address is from a different sign-in; paste the one from this sign-in"
        )
    if not code:
        raise ValueError("no code found in what was pasted")
    return code


def account(access: str) -> str:
    try:
        payload = access.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (IndexError, ValueError):
        raise ValueError("the ChatGPT token is not in the expected form") from None
    try:
        value: object = claims["https://api.openai.com/auth"]["chatgpt_account_id"]
    except (KeyError, TypeError):
        value = None
    if not isinstance(value, str) or not value:
        raise ValueError("the ChatGPT token names no account; sign in again")
    return value


def _tokens(vendor: Vendor, data: JsonObject, previous: str | None = None) -> OAuth:
    access, refresh = data.get("access_token"), data.get("refresh_token") or previous
    if not isinstance(access, str) or not access:
        raise ValueError("the sign-in answer has no access token")
    if not isinstance(refresh, str) or not refresh:
        raise ValueError("the sign-in answer has no refresh token")
    expires = data.get("expires_in")
    ttl = expires if type(expires) is int and expires >= 0 else 3600
    return OAuth(
        access,
        refresh,
        max(0, now_ms() + ttl * 1000 - 300_000),
        account(access) if vendor == "openai-codex" else None,
    )


def _json(response: Response) -> JsonObject:
    try:
        data: object = response.json()
    except ValueError:
        return {"error": response.text}
    return cast(JsonObject, data) if isinstance(data, dict) else {}


def _error(action: str, response: Response, data: JsonObject) -> ValueError:
    detail = ": ".join(
        str(data[key]) for key in ("error", "error_description") if isinstance(data.get(key), str)
    )
    return ValueError(
        f"{action} failed (HTTP {response.status_code})" + (f": {detail}" if detail else "")
    )


def _base(vendor: Vendor) -> str:
    return CODEX if vendor == "openai-codex" else XAI


def _token_url(vendor: Vendor) -> str:
    return _base(vendor) + ("/oauth/token" if vendor == "openai-codex" else "/oauth2/token")


async def refresh(client: AsyncClient, vendor: Vendor, old: OAuth) -> OAuth:
    response = await client.post(
        _token_url(vendor),
        data={
            "grant_type": "refresh_token",
            "refresh_token": old.refresh,
            "client_id": CLIENTS[vendor],
        },
        headers={"Accept": "application/json"},
    )
    data = _json(response)
    if not response.is_success:
        raise _error(
            f"refreshing the {LABELS[vendor]} sign-in (run `ma login {vendor}`)", response, data
        )
    return _tokens(vendor, data, old.refresh)


async def _exchange(client: AsyncClient, code: str, verifier: str, redirect: str) -> OAuth:
    response = await client.post(
        _token_url("openai-codex"),
        data={
            "grant_type": "authorization_code",
            "client_id": CLIENTS["openai-codex"],
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": redirect,
        },
        headers={"Accept": "application/json"},
    )
    data = _json(response)
    if not response.is_success:
        raise _error("the ChatGPT sign-in", response, data)
    return _tokens("openai-codex", data)


def _interval(data: JsonObject, fallback: int = 5) -> int:
    value = data.get("interval")
    try:
        return max(1, int(value)) if isinstance(value, (str, int)) else fallback
    except ValueError:
        return fallback


async def _device(client: AsyncClient, vendor: Vendor, show: Show) -> OAuth:
    is_codex = vendor == "openai-codex"
    base = _base(vendor)
    if is_codex:
        first = await client.post(
            base + "/api/accounts/deviceauth/usercode", json={"client_id": CLIENTS[vendor]}
        )
        if not first.is_success:
            raise ValueError(
                f"ChatGPT device sign-in is not available (HTTP {first.status_code}); use the browser sign-in"
            )
    else:
        first = await client.post(
            base + "/oauth2/device/code",
            data={
                "client_id": CLIENTS[vendor],
                "scope": SCOPE + " grok-cli:access api:access",
                "referrer": CLIENT_IDENTITY,
            },
            headers={"Accept": "application/json"},
        )
        if not first.is_success:
            raise _error("starting the Grok sign-in", first, _json(first))
    data = _json(first)

    def field(name: str, *, source: JsonObject = data) -> str:
        value = source.get(name)
        if not isinstance(value, str) or not value:
            raise ValueError(
                f"the {'ChatGPT' if is_codex else 'Grok'} sign-in answer has no {name}"
            )
        return value

    device = field("device_auth_id" if is_codex else "device_code")
    code = field("user_code")
    address = (
        "https://auth.openai.com/codex/device"
        if is_codex
        else str(data.get("verification_uri_complete") or field("verification_uri"))
    )
    if not address.startswith("https://"):
        raise ValueError("the Grok sign-in gave an address that is not https")
    show(Step(address, code))
    interval = _interval(data)
    expiry = data.get("expires_in")
    try:
        async with asyncio.timeout(
            expiry if not is_codex and type(expiry) is int and expiry >= 0 else WAIT
        ):
            while True:
                await asyncio.sleep(interval)
                if is_codex:
                    response = await client.post(
                        base + "/api/accounts/deviceauth/token",
                        json={"device_auth_id": device, "user_code": code},
                    )
                else:
                    response = await client.post(
                        _token_url(vendor),
                        data={
                            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                            "client_id": CLIENTS[vendor],
                            "device_code": device,
                        },
                        headers={"Accept": "application/json"},
                    )
                data = _json(response)
                if response.is_success:
                    if is_codex:
                        return await _exchange(
                            client,
                            field("authorization_code", source=data),
                            field("code_verifier", source=data),
                            "https://auth.openai.com/deviceauth/callback",
                        )
                    return _tokens(vendor, data)
                error = data.get("error")
                if isinstance(error, dict):
                    error = error.get("code")
                if (
                    is_codex
                    and response.status_code in {403, 404}
                    or error in ("authorization_pending", "deviceauth_authorization_pending")
                ):
                    continue
                if error == "slow_down":
                    interval += 5
                    continue
                if error in ("access_denied", "authorization_denied"):
                    raise ValueError("the Grok sign-in was denied")
                if error == "expired_token":
                    raise ValueError("the Grok sign-in code expired")
                raise _error(f"the {'ChatGPT' if is_codex else 'Grok'} sign-in", response, data)
    except TimeoutError:
        raise ValueError("the sign-in was not completed in time") from None


async def _browser(
    client: AsyncClient, show: Show, port: int = 1455, pasted: AsyncIterable[str] | None = None
) -> OAuth:
    state, verifier = secrets.token_urlsafe(16), secrets.token_urlsafe(32)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    )
    done: asyncio.Future[str] = asyncio.get_running_loop().create_future()

    async def callback(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            async with asyncio.timeout(5):
                line = (await reader.readline()).decode(errors="replace").split()
                target = urlsplit(line[1] if len(line) > 1 and line[0] == "GET" else "")
                query = parse_qs(target.query)
                status, text = "404 Not Found", "Not found."
                if target.path == "/auth/callback" and not done.done():
                    if not secrets.compare_digest(
                        query.get("state", [""])[0].encode(), state.encode()
                    ):
                        error = "the sign-in came back with the wrong state"
                    elif not query.get("code"):
                        error = (
                            "the sign-in was not completed: "
                            + query.get(
                                "error_description", query.get("error", ["no code returned"])
                            )[0]
                        )
                    else:
                        error = None
                    if error:
                        done.set_exception(ValueError(error))
                        status, text = (
                            "400 Bad Request",
                            "The sign-in did not complete. Return to the terminal.",
                        )
                    else:
                        done.set_result(query["code"][0])
                        status, text = (
                            "200 OK",
                            "Signed in. You can close this tab and return to the terminal.",
                        )
                writer.write(
                    f"HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {len(text)}\r\nConnection: close\r\n\r\n{text}".encode()
                )
                await writer.drain()
        except (TimeoutError, OSError, ValueError):
            pass
        finally:
            writer.close()
            await writer.wait_closed()

    try:
        server = await asyncio.start_server(callback, "127.0.0.1", port)
    except OSError as exc:
        if exc.errno != errno.EADDRINUSE:
            raise
        if pasted is None:
            show(
                Step(
                    note="Port 1455 is in use, so the browser sign-in cannot return here. Using a code instead."
                )
            )
            return await _device(client, "openai-codex", show)
        server = None
        show(Step(note="Port 1455 is in use, so paste the address the browser comes back to."))
    redirect = (
        f"http://localhost:{server.sockets[0].getsockname()[1]}/auth/callback"
        if server is not None and port != 1455
        else REDIRECT
    )
    params = urlencode(
        {
            "response_type": "code",
            "client_id": CLIENTS["openai-codex"],
            "redirect_uri": redirect,
            "scope": SCOPE,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
            "id_token_add_organizations": "true",
            "codex_cli_simplified_flow": "true",
            "originator": CLIENT_IDENTITY,
        }
    )

    async def read_paste(lines: AsyncIterable[str]) -> None:
        try:
            async for line in lines:
                if done.done():
                    return
                try:
                    code = pasted_code(line, state)
                except ValueError as exc:
                    show(Step(note=f"{exc}. Paste it again."))
                    continue
                if code is not None:
                    done.set_result(code)
                    return
        except Exception as exc:
            if not done.done():
                done.set_exception(exc)

    paste_task = None
    try:
        show(Step(CODEX + "/oauth/authorize?" + params, open_and_paste=pasted is not None))
        if pasted is not None:
            paste_task = asyncio.create_task(read_paste(pasted))
        try:
            code = await asyncio.wait_for(done, WAIT)
        except TimeoutError:
            raise ValueError("the sign-in was not completed in time") from None
    finally:
        if server is not None:
            server.close()
            server.close_clients()
        if paste_task is not None:
            paste_task.cancel()
            await asyncio.gather(paste_task, return_exceptions=True)
        if server is not None:
            await server.wait_closed()
    return await _exchange(client, code, verifier, redirect)


async def sign_in(
    vendor: Vendor, device: bool, show: Show, pasted: AsyncIterable[str] | None = None
) -> OAuth:
    async with AsyncClient(timeout=30, follow_redirects=False, trust_env=False) as client:
        if vendor == "xai" or device:
            return await _device(client, vendor, show)
        return await _browser(client, show, pasted=pasted)


async def _terminal_lines(fd: int) -> AsyncIterator[str]:
    # Wait for input without blocking the event loop or leaving a worker on stdin.
    loop = asyncio.get_running_loop()
    pending = b""
    while True:
        ready = asyncio.Event()
        loop.add_reader(fd, ready.set)
        try:
            await ready.wait()
            chunk = os.read(fd, 4096)
        finally:
            loop.remove_reader(fd)
        if not chunk:
            if pending:
                yield pending.decode(errors="replace")
            return
        *lines, pending = (pending + chunk).split(b"\n")
        for line in lines:
            yield line.decode(errors="replace")


def _show(step: Step) -> None:
    if step.note is not None:
        print(step.note, file=sys.stderr)
        return
    address, code = step.address, step.code
    if step.open_and_paste:
        print(
            f"Open this address in a browser, on this machine or any other:\n\n  {address}\n",
            file=sys.stderr,
        )
    elif code:
        print(
            f"Open this address in a browser:\n\n  {address}\n\nand enter the code: {code}\n",
            file=sys.stderr,
        )
    else:
        print(f"Open this address in a browser to sign in:\n\n  {address}\n", file=sys.stderr)
    if (
        address.startswith("https://")
        and not ({"MA_NO_BROWSER", "SSH_CONNECTION", "SSH_TTY"} & os.environ.keys())
        and ({"DISPLAY", "WAYLAND_DISPLAY"} & os.environ.keys())
    ):
        try:
            webbrowser.open(address)
        except (OSError, webbrowser.Error):
            pass
    if step.open_and_paste:
        print(
            "After you sign in, the browser goes to a localhost address. If the browser is on this\n"
            "machine, that finishes the sign-in. Otherwise the page will not load: copy the whole\n"
            "address from the browser's address bar and paste it here.\n",
            file=sys.stderr,
        )
        print("Paste the address (or the code): ", end="", file=sys.stderr, flush=True)
    else:
        print("Waiting for the sign-in to finish...", file=sys.stderr)


async def account_command(
    command: str,
    provider: str | None,
    device: bool,
    auth: AuthFile,
    claude_status: Callable[[], str],
) -> None:
    if command == "auth":
        for vendor, label in LABELS.items():
            current = auth.login(vendor)
            state = (
                "not signed in"
                if current is None
                else "signed in (token will refresh on next use)"
                if current.expired
                else "signed in"
            )
            print(f"{vendor:<13} {label:<22} {state}")
        print(f"{'claude':<13} {'Claude subscription':<22} {claude_status()}")
        if not claude_launch():
            print(
                "              the Claude sidecar is not installed (build typescript/sidecars/claude)"
            )
        return
    if not provider:
        raise ValueError(
            "which provider? openai-codex, xai or claude"
            if command == "login"
            else "which provider?"
        )
    if provider == "claude":
        if command == "logout":
            raise ValueError("Claude Code holds that sign-in; run `claude auth logout`")
        print("Claude signs in through Claude Code. Running `claude auth login`.", file=sys.stderr)
        try:
            status = subprocess.run(["claude", "auth", "login"], check=False).returncode
        except OSError as exc:
            raise ValueError(
                f"could not run claude: {exc}. Install Claude Code, then run `claude auth login`."
            ) from exc
        if status:
            raise ValueError("claude auth login did not complete")
        return
    if provider not in LABELS:
        raise ValueError(
            f"unknown provider {provider}"
            + ("; use openai-codex, xai or claude" if command == "login" else "")
        )
    if command == "logout":
        await auth.set_login(provider, None)
        print(f"Signed out of {LABELS[provider]}.", file=sys.stderr)
    else:
        pasted = (
            _terminal_lines(sys.stdin.fileno())
            if provider == "openai-codex" and not device and sys.stdin.isatty()
            else None
        )
        await auth.set_login(provider, await sign_in(cast(Vendor, provider), device, _show, pasted))
        print(f"Signed in to {LABELS[provider]} ({provider}).", file=sys.stderr)
