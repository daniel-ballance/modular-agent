"""The ACP frame boundary. The SDK still routes and validates each message."""

import asyncio
import json

from acp import RequestError
from acp._jsonrpc import decode_message, error_response

MAX_FRAME = 64 << 20


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()


class Stdio:
    def __init__(self, reader, writer):
        self.reader, self.writer = reader, writer
        self.lock = asyncio.Lock()
        self.requests = set()

    async def receive(self):
        while True:
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
            if not raw.strip():
                continue
            try:
                message = decode_message(raw)
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
                    self.requests.add(key)
                return message

    async def send(self, message):
        raw = encode(message)
        if len(raw) > MAX_FRAME:
            if "method" in message:
                if "id" in message:
                    raise ConnectionError("ACP request was withheld because it exceeds 64 MiB")
                return
            raw = encode(
                {
                    "jsonrpc": "2.0",
                    "id": message.get("id"),
                    "error": {
                        "code": -32000,
                        "message": "Result exceeds 64 MiB",
                        "data": {"code": "result_too_large"},
                    },
                }
            )
        async with self.lock:
            self.writer.write(raw + b"\n")
            await self.writer.drain()

    async def close(self):
        # The SDK stdout pipe protocol does not provide a close waiter.
        self.writer.close()
