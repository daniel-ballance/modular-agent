"""Shared WebSocket message boundary for the plugin and ACP bindings.

https://websockets.readthedocs.io/en/stable/reference/asyncio/server.html
https://websockets.readthedocs.io/en/stable/reference/asyncio/client.html
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import logging
import os
import ssl
import stat
from collections.abc import Awaitable, Callable, Iterable
from http import HTTPStatus
from pathlib import Path
from typing import TypedDict
from urllib.parse import urlsplit
from weakref import WeakKeyDictionary

from websockets.asyncio.client import connect
from websockets.asyncio.connection import Connection
from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request, Response

MAX_MESSAGE = 64 << 20
PLUGIN_PROTOCOL = "modular-agent-plugin-1"
ACP_PROTOCOL = "modular-agent-acp-1"

# The library's debug trace includes the HTTP headers, including Authorization.
_WIRE_LOG = logging.Logger(__name__ + ".wire", level=logging.WARNING)


class WebSocketTLS(TypedDict):
    cert_file: str | os.PathLike[str]
    key_file: str | os.PathLike[str]


def read_token(path: str | os.PathLike[str]) -> str:
    with Path(path).open("rb") as file:
        mode = os.fstat(file.fileno()).st_mode
        if not stat.S_ISREG(mode) or mode & 0o077:
            raise ValueError("Token file must be a regular file and accessible only by its owner")
        raw = file.read(4097).strip()
    if not 16 <= len(raw) <= 4096 or any(not 33 <= c <= 126 for c in raw):
        raise ValueError(
            "Expected a printable WebSocket bearer token with at least 128 bits of entropy"
        )
    return raw.decode("ascii")


def _digest(header: str) -> bytes:
    return hashlib.sha256(header.encode("utf-8", "surrogatepass")).digest()


def _loopback(host: str) -> str:
    # Do not let DNS or /etc/hosts turn a plaintext connection into a remote one.
    if host.lower() == "localhost":
        return "127.0.0.1"
    try:
        if ipaddress.ip_address(host).is_loopback:
            return host
    except ValueError:
        pass
    raise ValueError("Plain WebSocket requires a loopback address")


class WebSocketFrames:
    def __init__(self, connection: Connection) -> None:
        self.connection = connection

    async def receive(self) -> bytes | None:
        try:
            message = await self.connection.recv()
        except ConnectionClosed:
            return None
        if isinstance(message, bytes):
            await self.connection.close(1003)
            return None
        return message.encode("utf-8")

    async def send(self, raw: bytes) -> None:
        try:
            await self.connection.send(raw, text=True)
        except ConnectionClosed as exc:
            raise ConnectionError("WebSocket closed") from exc

    async def close(self) -> None:
        await self.connection.close(1000)


class WebSocketServer:
    def __init__(self, server: Server, url: str) -> None:
        self._server = server
        self.url = url

    async def wait_closed(self) -> None:
        await self._server.wait_closed()

    async def close(self) -> None:
        self._server.close(code=1000)
        await self.wait_closed()


async def listen_websocket[T](
    listen: str,
    tokens: Iterable[tuple[str | os.PathLike[str], T]],
    subprotocol: str,
    handle: Callable[[WebSocketFrames, T], Awaitable[None]],
    tls: WebSocketTLS | None,
) -> WebSocketServer:
    addr = urlsplit(listen if "://" in listen else "//" + listen)
    scheme = "wss" if tls is not None else "ws"
    if (
        addr.scheme not in {"", scheme}
        or addr.username is not None
        or addr.fragment
        or addr.query
        or not addr.hostname
        or addr.port is None
    ):
        raise ValueError("Expected a HOST:PORT or WebSocket listener URL matching the TLS options")
    host = addr.hostname if tls else _loopback(addr.hostname)
    path = addr.path or "/"
    context = None
    if tls is not None:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(tls["cert_file"], tls["key_file"])
    principals = [(_digest("Bearer " + read_token(file)), who) for file, who in tokens]
    if len({digest for digest, _ in principals}) != len(principals):
        raise ValueError("Duplicate WebSocket token")
    authenticated: WeakKeyDictionary[ServerConnection, T] = WeakKeyDictionary()

    def authenticate(ws: ServerConnection, request: Request) -> Response | None:
        headers = request.headers.get_all("Authorization")
        supplied = _digest(headers[0] if len(headers) == 1 else "")
        for expected, who in principals:
            if hmac.compare_digest(expected, supplied):
                authenticated[ws] = who
        if ws not in authenticated:
            return ws.respond(HTTPStatus.UNAUTHORIZED, "Unauthorized\n")
        if request.path != path:
            return ws.respond(HTTPStatus.NOT_FOUND, "Not Found\n")
        return None  # websockets requires a match when server subprotocols are given.

    async def serve_connection(ws: ServerConnection) -> None:
        await handle(WebSocketFrames(ws), authenticated.pop(ws))

    server = await serve(
        serve_connection,
        host,
        addr.port,
        subprotocols=[subprotocol],
        process_request=authenticate,
        ssl=context,
        max_size=MAX_MESSAGE,
        compression=None,
        logger=_WIRE_LOG,
    )
    port = server.sockets[0].getsockname()[1]
    authority = f"[{host}]" if ":" in host else host
    return WebSocketServer(server, f"{scheme}://{authority}:{port}{path}")


class _DirectConnect(connect):
    def process_redirect(self, exc: Exception) -> Exception:
        # The bearer authorizes only the configured endpoint. Never forward
        # the header to a URL chosen by an HTTP response.
        return exc


async def connect_plugin(
    url: str, token_file: str | os.PathLike[str], *, timeout: float
) -> WebSocketFrames:
    dest = urlsplit(url)
    if (
        dest.scheme not in {"ws", "wss"}
        or dest.hostname is None
        or dest.username is not None
        or dest.fragment
    ):
        raise ValueError("Expected a ws: or wss: plugin service URL")
    host_override = {"host": _loopback(dest.hostname)} if dest.scheme == "ws" else {}
    ws = await _DirectConnect(
        url,
        subprotocols=[PLUGIN_PROTOCOL],
        additional_headers={"Authorization": "Bearer " + read_token(token_file)},
        open_timeout=timeout,
        close_timeout=timeout,
        proxy=None,
        max_size=MAX_MESSAGE,
        compression=None,
        logger=_WIRE_LOG,
        **host_override,
    )
    if ws.subprotocol != PLUGIN_PROTOCOL:
        await ws.close(1002)
        raise ConnectionError("Plugin service did not select its required subprotocol")
    return WebSocketFrames(ws)


async def wait_for_stop(server: WebSocketServer) -> None:
    """CLI lifetime: on SIGTERM, close first so connection-local work stops."""
    import signal

    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    loop.add_signal_handler(signal.SIGTERM, stop.set)
    try:
        await stop.wait()
    finally:
        loop.remove_signal_handler(signal.SIGTERM)
        await server.close()
