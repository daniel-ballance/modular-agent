"""Private, full-duplex JSON frames. No Python objects cross this channel.

Streams: https://docs.python.org/3.13/library/asyncio-stream.html
Cancellation: https://docs.python.org/3.13/library/asyncio-task.html#task-cancellation
"""

import asyncio
import json
import struct

from ma_core import AgentError, Stop

MAX_FRAME = 64 * 1024 * 1024


def pack(value):
    if isinstance(value, Stop):
        return {"stop": True, "value": value.value}
    return {"value": value}


def unpack(value):
    return Stop(value["value"]) if value.get("stop") else value["value"]


def failure(exc):
    return {
        "type": type(exc).__name__,
        "code": getattr(exc, "code", "failed"),
        "message": str(exc),
    }


def exception(data):
    kind, message = data["type"], data["message"]
    if kind == "CancelledError":
        return asyncio.CancelledError()
    if kind == "TimeoutError":
        return TimeoutError(message)
    return AgentError(message, data["code"])


class Peer:
    def __init__(self, reader, writer, dispatch, label):
        self.reader, self.writer, self.dispatch, self.label = reader, writer, dispatch, label
        self.pending, self.running = {}, {}
        self.sequence = 0
        self.lock = asyncio.Lock()
        self.closed = asyncio.Event()
        self.reader_task = asyncio.create_task(self._read())

    async def send(self, frame):
        if self.closed.is_set():
            raise AgentError(self.label + " process disconnected", "process_lost")
        raw = json.dumps(frame, ensure_ascii=True, allow_nan=False).encode()
        if len(raw) > MAX_FRAME:
            raise AgentError("Plugin frame exceeds 64 MiB", "protocol_error")
        async with self.lock:
            self.writer.write(struct.pack("!I", len(raw)) + raw)
            await self.writer.drain()

    async def request(self, operation, data):
        self.sequence += 1
        key = str(self.sequence)
        future = asyncio.get_running_loop().create_future()
        self.pending[key] = future
        try:
            try:
                await self.send(
                    {"kind": "request", "id": key, "operation": operation, "data": data}
                )
                return await asyncio.shield(future)
            except asyncio.CancelledError:
                # Cancellation is an acknowledged operation, not fire-and-forget.
                # The far end finishes its finally blocks and nested calls first.
                await self.send({"kind": "cancel", "id": key})
                try:
                    await asyncio.shield(future)
                except BaseException:
                    pass
                raise
        finally:
            self.pending.pop(key, None)
            if future.done() and not future.cancelled():
                future.exception()  # Retrieve even when cancellation won a race.

    async def _answer(self, frame):
        key = frame["id"]
        try:
            result = pack(await self.dispatch(frame["operation"], frame["data"]))
            answer = {"result": result}
        except BaseException as exc:
            answer = {"error": failure(exc)}
        try:
            await self.send({"kind": "answer", "id": key, **answer})
        except (ConnectionError, AgentError):
            pass
        finally:
            self.running.pop(key, None)

    async def _read(self):
        try:
            while True:
                size = struct.unpack("!I", await self.reader.readexactly(4))[0]
                if not 0 < size <= MAX_FRAME:
                    raise AgentError("Invalid plugin frame length", "protocol_error")
                frame = json.loads(await self.reader.readexactly(size))
                key, kind = frame["id"], frame["kind"]
                if kind == "request":
                    if key in self.running:
                        raise AgentError("Duplicate plugin request", "protocol_error")
                    self.running[key] = asyncio.create_task(self._answer(frame))
                elif kind == "cancel":
                    if key in self.running:
                        self.running[key].cancel()
                elif kind == "answer":
                    future = self.pending.get(key)
                    if future is not None and not future.done():
                        if "error" in frame:
                            future.set_exception(exception(frame["error"]))
                        else:
                            future.set_result(unpack(frame["result"]))
                else:
                    raise AgentError("Invalid plugin frame kind", "protocol_error")
        except (Exception, asyncio.CancelledError):
            pass
        finally:
            self.closed.set()
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(
                        AgentError(
                            self.label + " process disconnected; outcome unknown", "process_lost"
                        )
                    )
            for task in list(self.running.values()):
                task.cancel()
            self.writer.close()

    async def close(self):
        self.writer.close()
        self.reader_task.cancel()
        await asyncio.gather(self.reader_task, return_exceptions=True)
        await asyncio.gather(*list(self.running.values()), return_exceptions=True)
        await self.writer.wait_closed()
