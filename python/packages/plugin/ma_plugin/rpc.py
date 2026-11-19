"""Full-duplex JSON-RPC lines for modular-agent-plugin/1.

Streams and acknowledged cancellation follow the Python 3.13 APIs:
https://docs.python.org/3.13/library/asyncio-stream.html
https://docs.python.org/3.13/library/asyncio-task.html#shielding-from-cancellation
No private ma-process protocol or Python serialization is used.
"""

import asyncio
import json

from ma_core import AgentError

MAX_FRAME = 64 * 1024 * 1024
MAX_REQUEST_IDS = 2**20
MAX_ACTIVE_REQUESTS = 256


def rpc_id(value):
    return isinstance(value, str) or (type(value) is int and abs(value) < 2**53)


def json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON member")
        result[key] = value
    return result


def invalid_constant(value):
    raise ValueError("Invalid JSON constant")


class WireError(AgentError):
    def __init__(self, message, code="internal", number=None, *, details=None):
        super().__init__(message, code)
        self.number = (
            number if number is not None else (-32602 if code == "invalid_request" else -32000)
        )
        self.details = details or {}


class Peer:
    def __init__(self, reader, writer, dispatch, notification=None, label="plugin"):
        self.reader, self.writer = reader, writer
        self.dispatch, self.notification, self.label = dispatch, notification, label
        self.pending, self.running, self.parents, self.incoming_methods = {}, {}, {}, {}
        self.started, self.cancelled, self.answered = set(), set(), set()
        self.received_ids, self.sent_ids = set(), set()
        self.sequence = 0
        self.lock = asyncio.Lock()
        self.closed = asyncio.Event()
        self.notes = None
        self.note_requests = set()
        self.note_tasks = set()
        self.deliveries = set()
        self.reader_task = asyncio.create_task(self._read())

    async def send(self, message):
        if self.closed.is_set():
            raise WireError(self.label + " disconnected; outcome unknown", "lost")
        raw = json.dumps(
            {"jsonrpc": "2.0", **message}, ensure_ascii=False, allow_nan=False
        ).encode()
        if len(raw) > MAX_FRAME:
            if "result" not in message:
                raise WireError("Message exceeds 64 MiB", "result_too_large")
            raw = json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": message["id"],
                    "error": {
                        "code": -32000,
                        "message": "Result exceeds 64 MiB",
                        "data": {"code": "result_too_large"},
                    },
                }
            ).encode()
        async with self.lock:
            self.writer.write(raw + b"\n")
            await self.writer.drain()

    async def notify(self, method, params):
        await self.send({"method": method, "params": params})

    async def request(self, method, params, *, key=None, return_on_cancel=False):
        self.sequence += 1
        key = key if key is not None else "r" + str(self.sequence)
        if not rpc_id(key) or key in self.sent_ids or len(self.sent_ids) >= MAX_REQUEST_IDS:
            raise WireError("Request id unavailable", "lost")
        self.sent_ids.add(key)
        future = asyncio.get_running_loop().create_future()
        self.pending[key] = future
        if asyncio.current_task() in self.note_tasks:
            self.note_requests.add(key)
        try:
            await self.send({"id": key, "method": method, "params": params})
            return await asyncio.shield(future)
        except asyncio.CancelledError:
            if not self.closed.is_set():
                await self.notify("$/cancel", {"id": key})
                children = [
                    task
                    for rid, task in list(self.running.items())
                    if self.parents.get(rid) == key
                    and self.incoming_methods.get(rid) != "host/runtime/record"
                    and not task.done()
                ]
                for rid, task in list(self.running.items()):
                    if task in children:
                        self.cancel(rid)
                await asyncio.gather(*children, return_exceptions=True)
                try:
                    result = await asyncio.shield(future)
                    if return_on_cancel:
                        return result
                except BaseException:
                    pass
            raise
        finally:
            self.pending.pop(key, None)
            self.answered.discard(key)
            self.note_requests.discard(key)
            if future.done() and not future.cancelled():
                future.exception()

    def cancel(self, key):
        task = self.running.get(key)
        if not task or key in self.cancelled:
            return
        self.cancelled.add(key)
        if key in self.started:
            task.cancel()

    async def _answer(self, message):
        key = message["id"]
        self.started.add(key)
        try:
            if key in self.cancelled:
                raise asyncio.CancelledError
            method = message["method"]
            result = (
                {}
                if method == "$/ping"
                else await self.dispatch(method, message.get("params") or {}, key)
            )
            answer = {"result": result}
        except BaseException as exc:
            code = (
                "cancelled"
                if isinstance(exc, asyncio.CancelledError)
                else getattr(exc, "code", "internal")
            )
            answer = {
                "error": {
                    "code": getattr(exc, "number", -32602 if code == "invalid_request" else -32000),
                    "message": "Request cancelled" if code == "cancelled" else str(exc),
                    "data": {**getattr(exc, "details", {}), "code": code},
                }
            }
        self.cancelled.add(key)  # Once answering, a late cancel must not interrupt the write.
        try:
            await self.send({"id": key, **answer})
        except (ConnectionError, WireError):
            pass
        finally:
            self.running.pop(key, None)
            self.started.discard(key)
            self.cancelled.discard(key)
            self.parents.pop(key, None)
            self.incoming_methods.pop(key, None)

    async def _note(self, previous, message):
        task = asyncio.current_task()
        self.note_tasks.add(task)
        try:
            if previous:
                await previous
            if self.notification:
                await self.notification(message["method"], message.get("params") or {})
        finally:
            self.note_tasks.discard(task)

    async def _deliver(self, previous, message):
        future = self.pending.get(message["id"])
        try:
            if previous:
                await previous
        except Exception as exc:
            if future is not None and not future.done():
                future.set_exception(exc)
            return
        if future is not None and not future.done():
            if "error" in message:
                error = message["error"]
                future.set_exception(
                    WireError(
                        error.get("message", "Error"),
                        (error.get("data") or {}).get("code", "internal"),
                        error["code"],
                        details=error.get("data"),
                    )
                )
            else:
                future.set_result(message.get("result"))

    def _track(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.deliveries.add(task)
        task.add_done_callback(self.deliveries.discard)

    async def _protocol_error(self, key, number, code, text):
        await self.send(
            {"id": key, "error": {"code": number, "message": text, "data": {"code": code}}}
        )

    async def _read(self):
        try:
            while raw := await self.reader.readline():
                if (
                    not raw.endswith(b"\n")
                    or len(raw.removesuffix(b"\n").removesuffix(b"\r")) > MAX_FRAME
                ):
                    break
                try:
                    message = json.loads(
                        raw.decode("utf-8"),
                        object_pairs_hook=json_object,
                        parse_constant=invalid_constant,
                    )
                except (ValueError, UnicodeError, RecursionError):
                    await self._protocol_error(None, -32700, "parse_error", "Invalid JSON")
                    continue
                key = message.get("id") if isinstance(message, dict) else None
                if isinstance(message, dict) and ("result" in message or "error" in message):
                    error = message.get("error")
                    if (
                        message.get("jsonrpc") != "2.0"
                        or "method" in message
                        or ("result" in message) == ("error" in message)
                        or not rpc_id(key)
                        or key not in self.pending
                        or key in self.answered
                        or (
                            "error" in message
                            and (
                                not isinstance(error, dict)
                                or type(error.get("code")) is not int
                                or not isinstance(error.get("message"), str)
                                or not isinstance(error.get("data"), dict)
                                or not isinstance(error["data"].get("code"), str)
                            )
                        )
                    ):
                        break
                    self.answered.add(key)
                    self._track(
                        self._deliver(None if key in self.note_requests else self.notes, message)
                    )
                    continue
                if (
                    not isinstance(message, dict)
                    or message.get("jsonrpc") != "2.0"
                    or not isinstance(message.get("method"), str)
                    or ("id" in message and not rpc_id(key))
                ):
                    await self._protocol_error(
                        key if rpc_id(key) else None,
                        -32600,
                        "invalid_request",
                        "Invalid request envelope",
                    )
                    continue
                method = message["method"]
                params = message.get("params", {})
                if key is not None:
                    if key in self.received_ids or len(self.received_ids) >= MAX_REQUEST_IDS:
                        break
                    self.received_ids.add(key)
                    if not isinstance(params, dict):
                        await self._protocol_error(key, -32602, "invalid_request", "Invalid params")
                        continue
                    if len(self.running) >= MAX_ACTIVE_REQUESTS:
                        await self._protocol_error(key, -32000, "internal", "Peer is busy")
                        continue
                    self.parents[key] = params.get("parentRequestId")
                    self.incoming_methods[key] = method
                    self.running[key] = asyncio.create_task(self._answer(message))
                elif isinstance(params, dict):
                    if method == "$/cancel":
                        if rpc_id(params.get("id")):
                            self.cancel(params["id"])
                    else:
                        self.notes = asyncio.create_task(self._note(self.notes, message))
        except (Exception, asyncio.CancelledError):
            pass
        finally:
            self.closed.set()
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(
                        WireError(self.label + " disconnected; outcome unknown", "lost")
                    )
            for key in list(self.running):
                self.cancel(key)

    async def close(self):
        self.reader_task.cancel()
        await asyncio.gather(self.reader_task, return_exceptions=True)
        await asyncio.gather(*list(self.running.values()), return_exceptions=True)
        await asyncio.gather(*list(self.deliveries), return_exceptions=True)
        if self.notes:
            await asyncio.gather(self.notes, return_exceptions=True)
        self.writer.close()
