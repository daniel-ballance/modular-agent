"""One authenticated aiohttp listener for AG-UI and the optional ACP upgrade."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import ssl
from collections.abc import Awaitable, Callable, Sequence
from os import PathLike
from typing import TYPE_CHECKING, Any, NotRequired
from urllib.parse import urlsplit

from aiohttp import WSMsgType, web
from ma_plugin.websocket import ACP_PROTOCOL, WebSocketTLS, _loopback, read_token

from ._agui_wire import MAX, STATUS, Failure, decode, encode, require
from ._types import AgentError, ErrorCode

if TYPE_CHECKING:
    from ._agui import Binding
    from ._agent import AcpActor, AguiActor


class AguiTLS(WebSocketTLS):
    client_ca_file: NotRequired[str | PathLike[str]]


class AguiServer:
    def __init__(self, runner: web.AppRunner, url: str, binding: Binding) -> None:
        self._runner = runner
        self.url = url
        self._binding = binding

    async def close(self) -> None:
        await self._runner.cleanup()
        self._binding.close()


class _Frames:
    def __init__(self, ws: web.WebSocketResponse) -> None:
        self.ws = ws

    async def receive(self) -> bytes | None:
        msg = await self.ws.receive()
        if msg.type == WSMsgType.TEXT:
            return str(msg.data).encode()
        if msg.type == WSMsgType.BINARY:
            await self.ws.close(code=1003)
        return None

    async def send(self, raw: bytes) -> None:
        await self.ws.send_str(raw.decode())

    async def close(self) -> None:
        await self.ws.close(code=1000)


def problem(exc: Exception) -> str:
    code = str(getattr(exc, "code", "unavailable"))
    return (
        code
        if code in STATUS
        else {
            "forbidden": "refused",
            "withheld": "output_withheld",
            "invalid_params": "invalid_request",
            "unknown_session": "not_found",
            "held": "busy",
            "not_open": "not_found",
        }.get(code, "unavailable")
    )


async def listen_agui(
    listen: str,
    tls: AguiTLS | None,
    origins: Sequence[str],
    binding: Binding,
    upgrade: Callable[[Any, AcpActor], Awaitable[None]] | None,
) -> AguiServer:
    scheme = "https" if tls else "http"
    addr = urlsplit(listen if "://" in listen else "//" + listen)
    if (
        not addr.hostname
        or addr.port is None
        or addr.scheme not in ("", scheme)
        or addr.username is not None
        or addr.path not in ("", "/")
        or addr.query
        or addr.fragment
    ):
        raise AgentError(ErrorCode.INVALID_COMPOSITION, "Expected HOST:PORT matching TLS options")
    host = addr.hostname if tls else _loopback(addr.hostname)
    context = None
    if tls:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(tls["cert_file"], tls["key_file"])
        if "client_ca_file" in tls:
            context.load_verify_locations(tls["client_ca_file"])
            context.verify_mode = ssl.CERT_REQUIRED
    allowed = frozenset(origins)
    for origin in allowed:
        url = urlsplit(origin)
        if not (
            url.scheme in ("http", "https")
            and url.hostname
            and url.username is None
            and origin == f"{url.scheme}://{url.netloc}"
        ):
            raise AgentError(ErrorCode.INVALID_COMPOSITION, "Expected HTTP origins without paths")
    principals = [
        (hashlib.sha256(("Bearer " + read_token(a["token_file"])).encode()).digest(), a)
        for a in binding.actors
    ]
    if len({d for d, _ in principals}) != len(principals):
        raise AgentError(ErrorCode.INVALID_COMPOSITION, "Duplicate bearer token")

    active: set[asyncio.Task[Any]] = set()

    async def handle(req: web.Request) -> web.StreamResponse:
        headers = {"Cache-Control": "no-store", "X-Accel-Buffering": "no", "Vary": "Origin"}
        entry: AguiActor | None = None
        counted = False
        task = asyncio.current_task()
        assert task is not None
        try:
            origin = req.headers.get("Origin")
            same = f"{scheme}://{req.host}"
            origin_ok = origin is None or (
                len(req.headers.getall("Origin")) == 1 and (origin in allowed or origin == same)
            )
            if origin and origin_ok:
                headers["Access-Control-Allow-Origin"] = origin
            if req.method == "OPTIONS" and origin_ok and origin:
                return web.Response(
                    status=204,
                    headers={
                        **headers,
                        "Access-Control-Allow-Methods": "GET, POST",
                        "Access-Control-Allow-Headers": "Authorization, Content-Type, MA-History-Cursor",
                    },
                )
            auth = req.headers.getall("Authorization", [])
            supplied = hashlib.sha256((auth[0] if len(auth) == 1 else "").encode()).digest()
            for digest, actor in principals:
                if hmac.compare_digest(digest, supplied):
                    entry = actor
            require(entry is not None, "unauthenticated")
            assert entry is not None
            require(origin_ok, "refused")
            require(not req.query_string)
            require(len(active) < 128, "busy")
            active.add(task)
            counted = True
            if req.path == "/" and upgrade and req.method == "GET":
                ws = web.WebSocketResponse(
                    protocols=[ACP_PROTOCOL], max_msg_size=MAX, compress=False
                )
                require(ws.can_prepare(req).protocol == ACP_PROTOCOL)
                await ws.prepare(req)
                await upgrade(_Frames(ws), entry)
                return ws
            raw = {}
            if req.method == "POST":
                require(
                    req.content_type == "application/json"
                    and req.charset in (None, "utf-8", "UTF-8")
                    and not req.headers.get("Content-Encoding")
                )
                require(req.content_length is None or req.content_length <= MAX, "result_too_large")
                try:
                    raw = decode(await req.read())
                except web.HTTPRequestEntityTooLarge:
                    raise Failure("result_too_large") from None
            return await binding.request(req, entry, raw, headers)
        except (ConnectionError, asyncio.CancelledError):
            raise
        except Exception as exc:
            code = problem(exc)
            if entry is not None and not await binding.error_allowed(entry, code):
                code = "output_withheld"
            return web.Response(
                body=encode({"code": code}),
                status=STATUS[code],
                content_type="application/json",
                headers=headers,
            )
        finally:
            if counted:
                active.discard(task)

    async def shutdown(_: web.Application) -> None:
        running = tuple(active)
        for task in running:
            task.cancel()
        await asyncio.gather(*running, return_exceptions=True)

    app = web.Application(client_max_size=MAX + 1)
    app.on_shutdown.append(shutdown)
    app.router.add_route("*", "/{path:.*}", handle)
    runner = web.AppRunner(app, access_log=None, handler_cancellation=True, auto_decompress=False)
    await runner.setup()
    try:
        await web.TCPSite(runner, host, addr.port, ssl_context=context).start()
    except BaseException:
        await runner.cleanup()
        raise
    authority = f"[{host}]" if ":" in host else host
    return AguiServer(runner, f"{scheme}://{authority}:{runner.addresses[0][1]}", binding)
