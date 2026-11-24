"""Full-duplex JSON-RPC lines for modular-agent-plugin/1.

Streams and acknowledged cancellation follow the Python 3.13 APIs:
https://docs.python.org/3.13/library/asyncio-stream.html
https://docs.python.org/3.13/library/asyncio-task.html#shielding-from-cancellation
No private ma-process protocol or Python serialization is used.
"""

import asyncio
import json
from contextvars import ContextVar

from ma_core import telemetry as ot
from ma_core import AgentError

MAX_FRAME = 64 * 1024 * 1024
MAX_REQUEST_IDS = 2**20
MAX_ACTIVE_REQUESTS = 256
MAX_NOTIFICATIONS = 1024
STREAMS = {
    "tools/call": "tools/progress",
    "env/exec": "env/output",
    "provider/request": "provider/event",
    "host/env/exec": "host/env/output",
    "host/runtime/model": "host/runtime/modelEvent",
}
# Inherited by child tasks, unlike a test of asyncio.current_task().
handling_notification = ContextVar("handling_plugin_notification", default=None)


def job_scope(params):
    job = params.get("jobId")
    return ("job", job) if isinstance(job, str) else None


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


def work_method(method):
    return (
        "/" in method
        and not method.startswith(("$", "plugin/"))
        and method
        not in {
            "host/problem",
            "host/credentials/read",
        }
    )


class Peer:
    def __init__(
        self,
        reader,
        writer,
        dispatch,
        notification=None,
        label="plugin",
        *,
        frames=None,
        close_after_shutdown=False,
        prepare_notification=None,
        trace_server=False,
    ):
        self.reader, self.writer = reader, writer
        self.frames = frames
        self.close_after_shutdown = close_after_shutdown
        self.last_received = asyncio.get_running_loop().time()
        self.activity = asyncio.Event()
        self.dispatch, self.notification, self.label = dispatch, notification, label
        self.pending, self.running, self.parents, self.incoming_methods = {}, {}, {}, {}
        self.started, self.cancelled, self.answered = set(), set(), set()
        self.cancelled_outbound = set()
        self.received_ids, self.sent_ids = set(), set()
        self.sequence = 0
        self.lock = asyncio.Lock()
        self.closed = asyncio.Event()
        self.prepare_notification = prepare_notification
        self.outgoing_methods = {}
        self.trace_server = trace_server
        self.trace_name = label
        self.outgoing_traces = {}
        self.request_notes = {}
        self.notes = asyncio.Queue(MAX_NOTIFICATIONS)
        self.note_bytes = 0
        self.note_tails = {}
        self.current_note = None
        self.deliveries = set()
        self.note_worker = asyncio.create_task(self._run_notifications())
        self.reader_task = asyncio.create_task(self._read())
        self.liveness_task = None

    def start_liveness(self, interval, deadline):
        self.liveness_task = asyncio.create_task(self._liveness(interval, deadline))

    async def _liveness(self, interval, deadline):
        loop = asyncio.get_running_loop()
        while not self.closed.is_set():
            self.activity.clear()
            if not self.pending:
                await self.activity.wait()
                continue
            silence = interval - (loop.time() - self.last_received)
            if silence > 0:
                try:
                    async with asyncio.timeout(silence):
                        await self.activity.wait()
                except TimeoutError:
                    pass
                continue
            try:
                async with asyncio.timeout(deadline):
                    await self.request("$/ping", {}, cancel_on_interrupt=False)
            except (TimeoutError, ConnectionError, WireError):
                # Settle pending work without waiting for a stalled close handshake.
                self.reader_task.cancel()
                await self.frames.close()
                return

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
            if self.frames is not None:
                try:
                    await self.frames.send(raw)
                except ConnectionError as exc:
                    raise WireError(self.label + " disconnected; outcome unknown", "lost") from exc
            else:
                self.writer.write(raw + b"\n")
                await self.writer.drain()

    def _traced_params(self, method, params):
        result = {k: v for k, v in params.items() if k != "traceContext"}
        scoped = (
            not method.startswith("host/")
            or rpc_id(params.get("parentRequestId"))
            or method in {"host/jobs/progress", "host/jobs/end", "host/jobs/resume"}
        )
        if scoped and work_method(method) and (carrier := ot.inject()):
            result["traceContext"] = carrier
        return result

    async def notify(self, method, params):
        await self.send({"method": method, "params": self._traced_params(method, params)})

    def _incoming_context(self, method, params):
        parent = params.get("parentRequestId")
        tracked = self.outgoing_traces.get(parent) if rpc_id(parent) else None
        received = ot.extract(params.get("traceContext"))
        if not work_method(method):
            return ot.extract(None)
        if tracked is not None:
            return received if ot.same_trace(tracked, received) else tracked
        if self.trace_server and not method.startswith("host/"):
            return received
        return ot.extract(None)

    async def _dispatch(self, method, params, key):
        parent = self._incoming_context(method, params)
        if not self.trace_server or not work_method(method):
            return await self.dispatch(method, params, key)
        work = params.get("turn") or {}
        with ot.span(
            "modular_agent.plugin.request",
            ot.attrs(
                params.get("sessionId") or work.get("sessionId"),
                work.get("turnId"),
                **{
                    "modular_agent.plugin.name": self.trace_name,
                    "modular_agent.plugin.method": method,
                },
            ),
            parent=parent,
            kind=ot.trace.SpanKind.SERVER,
        ):
            return await self.dispatch(method, params, key)

    async def request(
        self, method, params, *, key=None, return_on_cancel=False, cancel_on_interrupt=True
    ):
        if not work_method(method):
            return await self._request(method, params, key, return_on_cancel, cancel_on_interrupt)
        work = params.get("turn") or {}
        with ot.span(
            "modular_agent.plugin.request",
            ot.attrs(
                params.get("sessionId") or work.get("sessionId"),
                work.get("turnId"),
                **{
                    "modular_agent.plugin.name": self.trace_name,
                    "modular_agent.plugin.method": method,
                },
            ),
            kind=ot.trace.SpanKind.CLIENT,
        ):
            return await self._request(method, params, key, return_on_cancel, cancel_on_interrupt)

    async def _request(self, method, params, key, return_on_cancel, cancel_on_interrupt):
        note = handling_notification.get()
        if method in STREAMS and note is not None and note is self.current_note:
            # A nested stream on this peer would need to deliver pieces behind
            # the notification currently waiting for it. Refuse before dispatch.
            raise WireError("Cyclic plugin stream routing", "internal")
        self.sequence += 1
        key = key if key is not None else "r" + str(self.sequence)
        if not rpc_id(key) or key in self.sent_ids or len(self.sent_ids) >= MAX_REQUEST_IDS:
            raise WireError("Request id unavailable", "lost")
        self.sent_ids.add(key)
        future = asyncio.get_running_loop().create_future()
        if not self.pending:
            self.last_received = asyncio.get_running_loop().time()
        self.pending[key] = future
        self.activity.set()
        self.outgoing_methods[key] = method
        if note is not None:
            self.request_notes[key] = note
        try:
            self.outgoing_traces[key] = ot.current()
            await self.send(
                {"id": key, "method": method, "params": self._traced_params(method, params)}
            )
            return await asyncio.shield(future)
        except asyncio.CancelledError:
            self.cancelled_outbound.add(key)
            if cancel_on_interrupt and not self.closed.is_set():
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
            self.outgoing_traces.pop(key, None)
            self.activity.set()
            self.answered.discard(key)
            self.cancelled_outbound.discard(key)
            self.outgoing_methods.pop(key, None)
            self.request_notes.pop(key, None)
            if future.done() and not future.cancelled():
                future.exception()

    def cancel(self, key):
        task = self.running.get(key)
        if not task or key in self.cancelled:
            return
        self.cancelled.add(key)
        if key in self.started:
            task.cancel()

    async def _answer(self, message, after, note):
        key = message["id"]
        self.started.add(key)
        token = handling_notification.set(note)
        try:
            if key in self.cancelled:
                raise asyncio.CancelledError
            if after:
                await asyncio.shield(after)
            method = message["method"]
            result = (
                {}
                if method == "$/ping"
                else await self._dispatch(method, message.get("params") or {}, key)
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
        finally:
            handling_notification.reset(token)
        self.cancelled.add(key)  # Once answering, a late cancel must not interrupt the write.
        try:
            await self.send({"id": key, **answer})
            if (
                self.close_after_shutdown
                and message["method"] == "plugin/shutdown"
                and "result" in answer
            ):
                await self.frames.close()
        except (ConnectionError, WireError):
            pass
        finally:
            self.running.pop(key, None)
            self.started.discard(key)
            self.cancelled.discard(key)
            self.parents.pop(key, None)
            self.incoming_methods.pop(key, None)

    async def _run_notifications(self):
        while not self.closed.is_set():
            work, scope, size, done = await self.notes.get()
            self.current_note = done
            token = handling_notification.set(done)
            try:
                await work()
            except (Exception, asyncio.CancelledError):
                # A failed notification has no reply and cannot poison the queue.
                if self.closed.is_set():
                    return
            finally:
                handling_notification.reset(token)
                self.current_note = None
                self.note_bytes -= size
                if self.note_tails.get(scope) is done:
                    self.note_tails.pop(scope, None)
                done.set_result(None)

    def _admit_note(self, method, params, size):
        if not (self.notification or self.prepare_notification):
            return True
        parent = params.get("parentRequestId")
        scope = None
        if method in STREAMS.values():
            if (
                not rpc_id(parent)
                or parent in self.answered
                or STREAMS.get(self.outgoing_methods.get(parent)) != method
            ):
                return True
            scope = ("stream", parent)
        elif method == "host/jobs/progress":
            scope = job_scope(params)
        if self.prepare_notification:
            work = self.prepare_notification(method, params)
            if work is None:
                return True
        else:
            parent_context = self._incoming_context(method, params)

            async def work():
                with ot.use(parent_context):
                    return await self.notification(method, params)

        if self.notes.full() or self.note_bytes + size > 2 * MAX_FRAME:
            # Progress is expendable; a catalog invalidation is not.
            return method in STREAMS.values() or method == "host/jobs/progress"
        self.note_bytes += size
        done = asyncio.get_running_loop().create_future()
        self.notes.put_nowait((work, scope, size, done))
        if scope is not None:
            self.note_tails[scope] = done
        return True

    async def _deliver_after(self, previous, message):
        await asyncio.shield(previous)
        self._deliver(message)

    def _deliver(self, message):
        future = self.pending.get(message["id"])
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

    async def _receive(self):
        if self.frames is not None:
            return await self.frames.receive()
        raw = await self.reader.readline()
        if not raw.endswith(b"\n"):
            return None
        raw = raw[:-1].removesuffix(b"\r")
        return raw if len(raw) <= MAX_FRAME else None

    async def _read(self):
        try:
            while (raw := await self._receive()) is not None:
                self.last_received = asyncio.get_running_loop().time()
                self.activity.set()
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
                    # The answer closes the parent immediately. Only its own
                    # stream holds back delivery to the caller, not the reader.
                    self.answered.add(key)
                    if after := self.note_tails.get(("stream", key)):
                        self._track(self._deliver_after(after, message))
                    else:
                        self._deliver(message)
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
                    parent = params.get("parentRequestId")
                    self.parents[key] = parent
                    self.incoming_methods[key] = method
                    after = None
                    if method in {"host/jobs/end", "host/jobs/resume"}:
                        after = self.note_tails.get(job_scope(params))
                    elif (
                        method == "host/hook"
                        and params.get("hook") == "provider.response"
                        and rpc_id(parent)
                    ):
                        after = self.note_tails.get(("stream", parent))
                    # Carry cycle information across a reentrant wire callback.
                    note = self.request_notes.get(parent) if rpc_id(parent) else None
                    self.running[key] = asyncio.create_task(self._answer(message, after, note))
                elif isinstance(params, dict):
                    if method == "$/cancel":
                        if rpc_id(params.get("id")):
                            self.cancel(params["id"])
                    elif not self._admit_note(method, params, len(raw)):
                        break
        except (Exception, asyncio.CancelledError):
            pass
        finally:
            self.closed.set()
            self.activity.set()
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(
                        WireError(self.label + " disconnected; outcome unknown", "lost")
                    )
            for key in list(self.running):
                self.cancel(key)
            self.note_worker.cancel()
            while not self.notes.empty():
                self.notes.get_nowait()
            self.note_tails.clear()
            for task in self.deliveries:
                task.cancel()

    async def close(self):
        if self.liveness_task:
            self.liveness_task.cancel()
            await asyncio.gather(self.liveness_task, return_exceptions=True)
        self.reader_task.cancel()
        await asyncio.gather(self.reader_task, return_exceptions=True)
        await asyncio.gather(*list(self.running.values()), return_exceptions=True)
        await asyncio.gather(*list(self.deliveries), return_exceptions=True)
        await asyncio.gather(self.note_worker, return_exceptions=True)
        if self.frames is not None:
            await self.frames.close()
        else:
            self.writer.close()
