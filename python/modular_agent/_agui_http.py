"""AG-UI HTTP and ACP upgrades on one ASGI listener (HTTP/1.1, no proxy trust)."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import socket
import ssl
from collections.abc import Awaitable, Callable, Sequence
from contextlib import suppress
from os import PathLike
from typing import TYPE_CHECKING, Any, NotRequired
from urllib.parse import urlsplit

import uvicorn
from ma_plugin.websocket import ACP_PROTOCOL, WebSocketTLS, _loopback, read_token
from starlette.datastructures import Headers
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocket

from ._agui_wire import MAX, STATUS, encode, decode, require
from ._types import AgentError, ErrorCode

if TYPE_CHECKING:
    from ._agui import Binding
    from ._agent import AcpActor, AguiActor


class AguiTLS(WebSocketTLS):
    client_ca_file: NotRequired[str | PathLike[str]]


class Stream:
    def __init__(self, send: Send, headers: dict[str, str]) -> None:
        self._send = send
        self._headers = headers

    async def start(self) -> None:
        headers = Headers({**self._headers, "Content-Type": "text/event-stream"})
        await self._send({"type": "http.response.start", "status": 200, "headers": headers.raw})

    async def write(self, data: bytes) -> None:
        await self._send({"type": "http.response.body", "body": data, "more_body": True})


class AguiServer:
    def __init__(
        self, server: uvicorn.Server, url: str, shutdown: Callable[[], Awaitable[None]]
    ) -> None:
        self._server = server
        self.url = url
        self._shutdown = shutdown
        self._closed = False

    async def close(self) -> None:
        if not self._closed:
            self._closed = True
            for listener in self._server.servers:
                listener.close()
            await self._shutdown()
            await self._server.shutdown()


async def listen_asgi(
    host: str,
    port: int,
    app: ASGIApp,
    shutdown: Callable[[], Awaitable[None]],
    tls: AguiTLS | None = None,
) -> AguiServer:
    # Start in the application's event loop, without installing signal handlers
    # or changing its logging configuration. Hand a bound socket to Uvicorn so
    # bind failures are exceptions, not process exits. See uvicorn.org/deployment/.
    config = uvicorn.Config(
        app,
        http="h11",
        ws="websockets-sansio",
        ws_per_message_deflate=False,
        ws_max_size=MAX,
        access_log=False,
        log_config=None,
        proxy_headers=False,
        lifespan="off",
        interface="asgi3",
        ssl_certfile=tls["cert_file"] if tls else None,
        ssl_keyfile=tls["key_file"] if tls else None,
        ssl_ca_certs=str(tls["client_ca_file"]) if tls and "client_ca_file" in tls else None,
        ssl_cert_reqs=ssl.CERT_REQUIRED if tls and "client_ca_file" in tls else ssl.CERT_NONE,
    )
    config.load()
    server = uvicorn.Server(config)
    server.lifespan = config.lifespan_class(config)
    info = (await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM))[0]
    sock = socket.socket(*info[:3])
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(info[4])
        port = sock.getsockname()[1]
        await server.startup(sockets=[sock])
    except BaseException:
        sock.close()
        raise
    authority = f"[{host}]" if ":" in host else host
    return AguiServer(server, f"{'https' if tls else 'http'}://{authority}:{port}", shutdown)


class _Frames:
    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws

    async def receive(self) -> bytes | None:
        msg = await self.ws.receive()
        if msg.get("text") is not None:
            return str(msg["text"]).encode()
        if msg.get("bytes") is not None:
            await self.ws.close(code=1003)
        return None

    async def send(self, raw: bytes) -> None:
        await self.ws.send_text(raw.decode())

    async def close(self) -> None:
        with suppress(RuntimeError, OSError):
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
    before_listen: Callable[[], Awaitable[None]],
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

    async def handle(scope: Scope, receive: Receive, send: Send) -> None:
        headers = {"Cache-Control": "no-store", "X-Accel-Buffering": "no", "Vary": "Origin"}
        entry: AguiActor | None = None
        task = asyncio.current_task()
        assert task is not None
        ws = WebSocket(scope, receive, send) if scope["type"] == "websocket" else None
        fields = Headers(scope=scope)
        try:
            origin = fields.get("Origin")
            same = f"{scheme}://{fields.get('Host', '')}"
            origin_ok = origin is None or (
                len(fields.getlist("Origin")) == 1 and (origin in allowed or origin == same)
            )
            if origin and origin_ok:
                headers["Access-Control-Allow-Origin"] = origin
            if scope.get("method") == "OPTIONS" and origin_ok and origin:
                await Response(
                    status_code=204,
                    headers={
                        **headers,
                        "Access-Control-Allow-Methods": "GET, POST",
                        "Access-Control-Allow-Headers": "Authorization, Content-Type, MA-History-Cursor",
                    },
                )(scope, receive, send)
                return
            auth = fields.getlist("Authorization")
            supplied = hashlib.sha256((auth[0] if len(auth) == 1 else "").encode()).digest()
            for digest, actor in principals:
                if hmac.compare_digest(digest, supplied):
                    entry = actor
            require(entry is not None, "unauthenticated")
            assert entry is not None
            require(origin_ok, "refused")
            require(
                not scope["query_string"]
                or (
                    scope.get("method") == "GET"
                    and (
                        scope["path"] == "/agui/v1/threads"
                        or scope["path"].endswith(("/wait-closures", "/run-receipt"))
                    )
                )
            )
            require(len(active) < 128, "busy")
            active.add(task)
            if ws is not None:
                require(upgrade and scope["path"] == "/", "not_found")
                assert upgrade is not None
                require(ACP_PROTOCOL in scope["subprotocols"])
                await ws.accept(subprotocol=ACP_PROTOCOL)
                await upgrade(_Frames(ws), entry)
                return
            req = Request(scope, receive)
            raw = {}
            if req.method == "POST":
                require(
                    fields.get("content-type", "").lower().replace(" ", "")
                    in ("application/json", "application/json;charset=utf-8")
                    and not fields.get("content-encoding")
                )
                require(int(fields.get("content-length", "0")) <= MAX, "result_too_large")
                body = bytearray()
                async for part in req.stream():
                    require(len(body) + len(part) <= MAX, "result_too_large")
                    body.extend(part)
                raw = decode(body)

            async def disconnected() -> None:
                while (await receive())["type"] != "http.disconnect":
                    pass

            watch = asyncio.create_task(disconnected())
            operation = asyncio.create_task(binding.request(req, entry, raw, headers, send))
            try:
                done, _ = await asyncio.wait(
                    (watch, operation), return_when=asyncio.FIRST_COMPLETED
                )
                if operation in done:
                    reply = operation.result()
                    if reply is None:
                        await send({"type": "http.response.body", "body": b""})
                    else:
                        await reply(scope, receive, send)
            finally:
                operation.cancel()
                watch.cancel()
                await asyncio.gather(watch, operation, return_exceptions=True)
        except (OSError, asyncio.CancelledError):
            pass
        except Exception as exc:
            code = problem(exc)
            if entry is not None and not await binding.error_allowed(entry, code):
                code = "output_withheld"
            error = Response(
                encode({"code": code}),
                status_code=STATUS[code],
                media_type="application/json",
                headers=headers,
            )
            if ws:
                await ws.send_denial_response(error)
            else:
                await error(scope, receive, send)
        finally:
            active.discard(task)

    async def shutdown() -> None:
        running = tuple(active)
        for task in running:
            task.cancel()
        await asyncio.gather(*running, return_exceptions=True)
        binding.close()

    await before_listen()
    return await listen_asgi(host, addr.port, handle, shutdown, tls)
