"""The ACP frame boundary. The SDK still routes and validates each message."""

import asyncio
import json
from contextvars import ContextVar

from acp import RequestError
from acp._jsonrpc import decode_message, error_response

MAX_FRAME = 64 << 20

# The ACP router handles the request and sends its reply in separate tasks.
# Both inherit this cell from the receive loop, so the reply keeps its view.
REPLY_VIEW = ContextVar("acp_reply_view", default=None)
UPDATE_VIEW = ContextVar("acp_update_view", default=None)


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()


class Stdio:
    def __init__(self, reader, writer, *, frames=None, authorize=None):
        self.reader, self.writer = reader, writer
        self.frames = frames
        self.lock = asyncio.Lock()
        self.requests = {}
        self.authorize = authorize

    async def receive(self):
        REPLY_VIEW.set(None)
        while True:
            if self.frames is not None:
                raw = await self.frames.receive()
                if raw is None:
                    return None
            else:
                try:
                    line = await self.reader.readuntil(b"\n")
                except (asyncio.LimitOverrunError, asyncio.IncompleteReadError):
                    # Without a complete bounded frame there is no safe id to answer.
                    return None
                raw = line[:-1].removesuffix(b"\r")
            if len(raw) > MAX_FRAME:
                try:
                    message = decode_message(raw)
                except (RequestError, RecursionError):
                    return None
                if not message or "method" not in message or "id" not in message:
                    return None
                await self.send(
                    {
                        "jsonrpc": "2.0",
                        "id": message["id"],
                        "error": {
                            "code": -32000,
                            "message": "Message exceeds 64 MiB",
                            "data": {"code": "message_too_large"},
                        },
                    }
                )
                continue
            if self.frames is None and not raw.strip():
                continue
            try:
                message = decode_message(raw.decode("utf-8") if self.frames is not None else raw)
            except RequestError as exc:
                await self.send(error_response(exc))
                continue
            except RecursionError:
                return None
            if message is not None:
                if "method" in message and "id" in message:
                    key = message["id"]
                    if (
                        not (isinstance(key, str) or type(key) is int and abs(key) < 2**53)
                        or key in self.requests
                    ):
                        return None
                    params = message.get("params") or {}
                    self.requests[key] = (
                        (params.get("sessionId") or params.get("session"))
                        if isinstance(params, dict)
                        else None,
                        message["method"],
                    )
                    if self.frames is not None and message["method"] == "$/ping":
                        try:
                            async with asyncio.timeout(5):
                                await self.send({"jsonrpc": "2.0", "id": key, "result": {}})
                        except TimeoutError:
                            return None
                        continue
                if "method" in message and "id" in message:
                    REPLY_VIEW.set([])
                return message

    async def send(self, message):
        raw = encode(message)
        if len(raw) > MAX_FRAME:
            if "method" in message:
                if "id" in message:
                    raise ConnectionError("ACP request was withheld because it exceeds 64 MiB")
                return
            message = {
                "jsonrpc": "2.0",
                "id": message.get("id"),
                "error": {
                    "code": -32000,
                    "message": "Result exceeds 64 MiB",
                    "data": {"code": "result_too_large"},
                },
            }
            raw = encode(message)
        async with self.lock:
            if self.authorize is not None:
                if "method" in message:
                    method = message["method"]
                    params = message.get("params") or {}
                    sid = params.get("sessionId") or params.get("session")
                else:
                    sid, method = self.requests.pop(message.get("id"), (None, None))
                    result = message.get("result")
                    if method == "session/new" and isinstance(result, dict):
                        sid = result.get("sessionId")
                try:
                    if isinstance(sid, str) or (method == "session/list" and "result" in message):
                        prepared = UPDATE_VIEW.get() if "method" in message else REPLY_VIEW.get()
                        reduced = await self.authorize(sid, method, message, prepared)
                        if reduced is not None:
                            raw = encode(reduced)
                except RequestError as exc:
                    if "method" in message:
                        if "id" in message:
                            raise
                        return  # Do not disclose an already queued update.
                    raw = encode(
                        {"jsonrpc": "2.0", "id": message.get("id"), "error": exc.to_error_obj()}
                    )
            elif "method" not in message:
                self.requests.pop(message.get("id"), None)
            if self.frames is not None:
                await self.frames.send(raw)
            else:
                self.writer.write(raw + b"\n")
                await self.writer.drain()

    async def close(self):
        # The SDK stdout pipe protocol does not provide a close waiter.
        if self.frames is not None:
            await self.frames.close()
        else:
            self.writer.close()
