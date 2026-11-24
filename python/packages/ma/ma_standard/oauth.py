"""Terminal account commands."""

import asyncio
from collections.abc import AsyncGenerator, Awaitable, Callable
import os
import subprocess
import sys
import webbrowser

from modular_agent import SignInStep, SubscriptionLogins, sign_in, sign_out

from .identity import DEFAULT_CLIENT_IDENTITY


LABELS = {"chatgpt": "ChatGPT subscription", "grok": "Grok subscription"}


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


def _terminal_steps(paste: bool) -> Callable[[SignInStep], None]:
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
        await sign_out(provider, auth)
        print(f"Signed out of {LABELS[provider]}.", file=sys.stderr)
        return
    lines = (
        _terminal_lines(sys.stdin.fileno())
        if provider == "chatgpt" and not device and sys.stdin.isatty()
        else None
    )

    async def paste() -> str | None:
        return await anext(lines, None) if lines is not None else None

    try:
        await sign_in(
            provider,
            auth,
            device=device,
            on_step=_terminal_steps(lines is not None),
            paste=paste if lines is not None else None,
            client_identity=client_identity,
        )
    finally:
        if lines is not None:
            await lines.aclose()
    print(f"Signed in to {LABELS[provider]} ({provider}).", file=sys.stderr)
