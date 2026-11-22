"""Grok sign-in and the ma account commands."""

import asyncio
from collections.abc import AsyncGenerator, Awaitable, Callable
from dataclasses import dataclass
import os
import subprocess
import sys
from typing import cast
import webbrowser

from httpx2 import AsyncClient, Response
from modular_agent import (
    JsonObject,
    OAuth,
    SignInStep,
    SubscriptionLogins,
    sign_in as chatgpt_sign_in,
    sign_out,
)

from .config import PROVIDER_ALIASES
from .identity import DEFAULT_CLIENT_IDENTITY, validate_client_identity


@dataclass(frozen=True)
class Step:
    address: str
    code: str


type Show = Callable[[Step], None]

LABELS = {"chatgpt": "ChatGPT subscription", "grok": "Grok subscription"}
XAI = "https://auth.x.ai"
CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
SCOPE = "openid profile email offline_access grok-cli:access api:access"
WAIT = 900


def _tokens(data: JsonObject, previous: str | None = None) -> OAuth:
    import time

    access, refresh = data.get("access_token"), data.get("refresh_token") or previous
    if not isinstance(access, str) or not access:
        raise ValueError("the sign-in answer has no access token")
    if not isinstance(refresh, str) or not refresh:
        raise ValueError("the sign-in answer has no refresh token")
    expires = data.get("expires_in")
    ttl = expires if type(expires) is int and expires >= 0 else 3600
    return OAuth(access, refresh, max(0, time.time_ns() // 1_000_000 + ttl * 1000 - 300_000))


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


async def refresh(client: AsyncClient, old: OAuth) -> OAuth:
    response = await client.post(
        XAI + "/oauth2/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": old.refresh,
            "client_id": CLIENT_ID,
        },
        headers={"Accept": "application/json"},
    )
    data = _json(response)
    if not response.is_success:
        raise _error(
            "refreshing the Grok subscription sign-in (run `ma login grok`)", response, data
        )
    return _tokens(data, old.refresh)


def _interval(data: JsonObject, fallback: int = 5) -> int:
    value = data.get("interval")
    try:
        return max(1, int(value)) if isinstance(value, (str, int)) else fallback
    except ValueError:
        return fallback


async def _device(client: AsyncClient, show: Show, *, client_identity: str) -> OAuth:
    first = await client.post(
        XAI + "/oauth2/device/code",
        data={"client_id": CLIENT_ID, "scope": SCOPE, "referrer": client_identity},
        headers={"Accept": "application/json"},
    )
    if not first.is_success:
        raise _error("starting the Grok sign-in", first, _json(first))
    data = _json(first)

    def field(name: str) -> str:
        value = data.get(name)
        if not isinstance(value, str) or not value:
            raise ValueError(f"the Grok sign-in answer has no {name}")
        return value

    device, code = field("device_code"), field("user_code")
    address = str(data.get("verification_uri_complete") or field("verification_uri"))
    if not address.startswith("https://"):
        raise ValueError("the Grok sign-in gave an address that is not https")
    show(Step(address, code))
    interval = _interval(data)
    expiry = data.get("expires_in")
    try:
        async with asyncio.timeout(expiry if type(expiry) is int and expiry >= 0 else WAIT):
            while True:
                await asyncio.sleep(interval)
                response = await client.post(
                    XAI + "/oauth2/token",
                    data={
                        "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                        "client_id": CLIENT_ID,
                        "device_code": device,
                    },
                    headers={"Accept": "application/json"},
                )
                data = _json(response)
                if response.is_success:
                    return _tokens(data)
                error = data.get("error")
                if isinstance(error, dict):
                    error = error.get("code")
                if error in ("authorization_pending", "deviceauth_authorization_pending"):
                    continue
                if error == "slow_down":
                    interval += 5
                    continue
                if error in ("access_denied", "authorization_denied"):
                    raise ValueError("the Grok sign-in was denied")
                if error == "expired_token":
                    raise ValueError("the Grok sign-in code expired")
                raise _error("the Grok sign-in", response, data)
    except TimeoutError:
        raise ValueError("the sign-in was not completed in time") from None


async def sign_in(show: Show, *, client_identity: str = DEFAULT_CLIENT_IDENTITY) -> OAuth:
    validate_client_identity(client_identity)
    async with AsyncClient(timeout=30, follow_redirects=False, trust_env=False) as client:
        return await _device(client, show, client_identity=client_identity)


async def _terminal_lines(fd: int) -> AsyncGenerator[str]:
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


def _open_browser(address: str) -> None:
    if (
        address.startswith("https://")
        and not ({"MA_NO_BROWSER", "SSH_CONNECTION", "SSH_TTY"} & os.environ.keys())
        and ({"DISPLAY", "WAYLAND_DISPLAY"} & os.environ.keys())
    ):
        try:
            webbrowser.open(address)
        except (OSError, webbrowser.Error):
            pass


def _show_code(address: str, code: str | None) -> None:
    print(
        f"Open this address in a browser:\n\n  {address}\n\nand enter the code: {code}\n",
        file=sys.stderr,
    )
    _open_browser(address)


def _show_grok(step: Step) -> None:
    _show_code(step.address, step.code)
    print("Waiting for the sign-in to finish...", file=sys.stderr)


def _chatgpt_steps(paste: bool) -> Callable[[SignInStep], None]:
    shown = False

    def show(step: SignInStep) -> None:
        nonlocal shown
        if step.message:
            print(step.message, file=sys.stderr)
        if step.kind == "deviceCode":
            _show_code(step.url, step.code)
        elif step.kind == "waiting":
            print("Waiting for the sign-in to finish...", file=sys.stderr)
        elif not shown:
            print(f"Open this address in a browser to sign in:\n\n  {step.url}\n", file=sys.stderr)
            _open_browser(step.url)
            if paste:
                print(
                    "If the browser's localhost page does not load, copy the whole address and paste it here.",
                    file=sys.stderr,
                )
            else:
                print("Waiting for the sign-in to finish...", file=sys.stderr)
            shown = True
        if step.kind == "openAndPaste" and paste:
            print("Paste the address (or the code): ", end="", file=sys.stderr, flush=True)

    return show


async def account_command(
    command: str,
    provider: str | None,
    device: bool,
    auth: SubscriptionLogins,
    claude_status: Callable[[], Awaitable[str]],
    *,
    client_identity: str = DEFAULT_CLIENT_IDENTITY,
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
        print(f"{'claude':<13} {'Claude subscription':<22} {await claude_status()}")
        return
    if not provider:
        raise ValueError(
            "which provider? chatgpt, grok or claude" if command == "login" else "which provider?"
        )
    provider = PROVIDER_ALIASES.get(provider, provider)
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
            + ("; use chatgpt, grok or claude" if command == "login" else "")
        )
    if command == "logout":
        if provider == "chatgpt":
            await sign_out(provider, auth)
        else:
            await auth.set_login(provider, None)
        print(f"Signed out of {LABELS[provider]}.", file=sys.stderr)
        return
    if provider == "chatgpt":
        lines = _terminal_lines(sys.stdin.fileno()) if not device and sys.stdin.isatty() else None

        async def paste() -> str | None:
            return await anext(lines, None) if lines is not None else None

        try:
            await chatgpt_sign_in(
                provider,
                auth,
                device=device,
                on_step=_chatgpt_steps(lines is not None),
                paste=paste if lines is not None else None,
                client_identity=client_identity,
            )
        finally:
            if lines is not None:
                await lines.aclose()
    else:
        await auth.set_login(provider, await sign_in(_show_grok, client_identity=client_identity))
    print(f"Signed in to {LABELS[provider]} ({provider}).", file=sys.stderr)
