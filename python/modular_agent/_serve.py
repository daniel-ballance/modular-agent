"""Serve SDK registrations with the base's plugin-binding transport."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any, cast

from ma_plugin.host import External
from ma_plugin.rpc import MAX_FRAME, Peer, WireError
from ma_plugin.server import BINDING, PluginServer

from ._native import _error, _read_answer
from ._plugin import (
    CommandContext,
    Plugin,
    Registrar,
    _OBSERVERS,
    _SUPPORTED_HOOKS,
    _handle_command,
    _handle_hook,
)
from ._tool import LeftOpen, ToolContext
from ._types import AgentError, Answer, Content, ErrorCode, Json, JsonObject, QuestionSpec


async def _serve(
    plugin: Plugin,
    streams: tuple[asyncio.StreamReader, asyncio.StreamWriter] | None = None,
) -> None:
    registrar: Registrar | None = None
    initialized = False
    attempted = False
    stopped = False
    active: set[asyncio.Task[Any]] = set()
    registration: dict[str, Any] = {
        "binding": BINDING,
        "name": plugin.name,
        "replaces": list(plugin.replaces),
    }

    async def initialize(p: dict[str, Any]) -> None:
        nonlocal registrar
        config = p.get("config", {})
        if not isinstance(config, dict):
            raise WireError("Plugin config must be an object", "invalid_request")
        try:
            registrar = await plugin._register(config)
        except AgentError as exc:
            code = "not_supported" if exc.code is ErrorCode.NOT_SUPPORTED else "invalid_request"
            raise WireError(exc.message, code) from exc
        items = [f"tool:{t.name}" for t in registrar._tools.values() if t.in_process_only]
        items += [
            h.point
            for h in registrar._hooks
            if h.in_process_only or h.point not in _SUPPORTED_HOOKS
        ]
        items += [f"command:{c.name}" for c in registrar._commands.values() if c.in_process_only]
        if items:
            raise AgentError(ErrorCode.NOT_SUPPORTED, "Cannot serve " + ", ".join(items))
        registration["toolSources"] = (
            [
                {
                    "id": plugin.name,
                    "tools": [t.definition for t in registrar._tools.values()],
                    "perSession": False,
                }
            ]
            if registrar._tools
            else []
        )
        registration["hooks"] = [
            {"hook": h.point, "handlerId": n, "order": h.order}
            for n, h in enumerate(registrar._hooks, 1)
        ]
        registration["commands"] = [
            {"name": c.name, "description": c.description} for c in registrar._commands.values()
        ]

    async def stop() -> None:
        nonlocal stopped
        if stopped:
            return
        stopped = True
        tasks = active - {asyncio.current_task()}
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if initialized:
            await plugin._close()

    def registered() -> Registrar:
        if registrar is None or stopped:
            raise WireError("Plugin is not accepting work", "invalid_request")
        return registrar

    async def list_tools(p: dict[str, Any], key: str | int) -> JsonObject:
        if p.get("toolSource") != plugin.name or p.get("sessionId") is not None:
            raise WireError("Unknown or session-scoped tool source", "invalid_request")
        return {"tools": [t.definition for t in registered()._tools.values()]}

    async def call_tool(p: dict[str, Any], key: str | int) -> JsonObject:
        call = p["call"]
        t = registered()._tools.get(call["name"])
        if (
            t is None
            or p.get("toolSource") != plugin.name
            or not isinstance(p.get("sessionId"), str)
            or not p["sessionId"]
            or not isinstance(call.get("id"), str)
            or not call["id"]
            or ("actorId" in call and not isinstance(call["actorId"], str))
            or "input" not in call
        ):
            raise WireError("Unknown tool or invalid scope", "invalid_request")

        async def ask(q: QuestionSpec, index: int, wait: float | None, leave_open: bool) -> Answer:
            request: dict[str, Any] = dict(q)
            if wait is not None:
                request["timeLimitMs"] = round(wait * 1000)
                request["whenTimeLimit"] = "leaveOpen" if leave_open else "decline"
            try:
                reply = await server.peer.request(
                    "host/ask", {"parentRequestId": key, "request": request}
                )
            except WireError as exc:
                raise _error(exc, ErrorCode.INVALID_REQUEST) from exc
            if reply.get("pending"):
                raise LeftOpen(reply["requestId"])
            if q["kind"] == "secret" and isinstance(reply.get("stored"), str):
                return Answer("value", reply["stored"])
            if reply.get("allow") is True:
                return Answer("allow")
            return _read_answer(reply, q["kind"])

        async def progress(parts: Content) -> None:
            await server.peer.notify("tools/progress", {"parentRequestId": key, "content": parts})

        async def nested(operation: str, params: JsonObject) -> Json:
            try:
                reply: Json = await server.peer.request(
                    "host/tools/" + operation, {"parentRequestId": key, **params}
                )
            except WireError as exc:
                raise _error(exc, ErrorCode.INVALID_REQUEST) from exc
            return reply["tools"] if operation == "list" and isinstance(reply, dict) else reply

        async def environment(operation: str, params: JsonObject) -> Json:
            methods = {
                "read_bytes": "read",
                "write_bytes": "write",
                "list_directory": "list",
                "bash": "exec",
            }
            arguments = dict(params)
            timeout = arguments.pop("timeout", None)
            if isinstance(timeout, (int, float)):
                arguments["timeoutMs"] = round(timeout * 1000)
            try:
                reply = await server.peer.request(
                    "host/env/" + methods[operation],
                    {
                        **arguments,
                        "parentRequestId": key,
                        "sessionId": p["sessionId"],
                        "cwd": p["project"],
                    },
                )
            except WireError as exc:
                raise _error(exc, ErrorCode.INVALID_REQUEST) from exc
            if operation == "bash":
                return {
                    "exit_code": reply["exitCode"],
                    "text": reply["output"],
                    "timed_out": reply["timedOut"],
                }
            return cast(Json, reply)

        context = ToolContext(
            p["sessionId"],
            call.get("actorId", "user"),
            call["id"],
            ask,
            progress,
            nested,
            environment,
        )
        try:
            return await t._run(call["input"], context)
        except LeftOpen as exc:
            return {"pending": str(exc)}
        except asyncio.CancelledError:
            return {
                "status": "cancelled",
                "content": [{"type": "text", "text": "Tool call cancelled"}],
            }

    async def handle_hook(p: dict[str, Any], key: str | int) -> JsonObject | None:
        registrations = registered()._hooks
        n = p.get("handlerId")
        if (
            type(n) is not int
            or not 1 <= n <= len(registrations)
            or registrations[n - 1].point != p.get("hook")
        ):
            raise WireError("Unknown hook handler", "unknown_handler")
        hook = registrations[n - 1]
        try:
            return await _handle_hook(hook, p["payload"])
        except Exception as exc:
            if hook.point not in _OBSERVERS:
                raise
            logging.getLogger(__name__).warning("%s hook failed: %s", hook.point, exc)
            return None

    async def run_command(p: dict[str, Any], key: str | int) -> JsonObject:
        command = registered()._commands.get(p["name"])
        if command is None:
            raise WireError("Unknown command", "invalid_request")
        output = await _handle_command(
            command, p["args"], CommandContext(p["sessionId"], p["actorId"])
        )
        return {"output": output} if output is not None else {}

    class Server(PluginServer):  # type: ignore[misc]  # Untyped base adapter.
        async def dispatch(self, method: str, params: dict[str, Any], key: str | int) -> Any:
            nonlocal initialized, attempted
            task = asyncio.current_task()
            if method == "plugin/initialize":
                if attempted:
                    raise WireError("Already initialized", "invalid_request")
                attempted = True
            if method != "plugin/shutdown" and task is not None:
                active.add(task)
            try:
                value = await super().dispatch(method, params, key)
                if method == "plugin/initialize":
                    initialized = True
                return value
            except AgentError as exc:
                raise WireError(exc.message, exc.code.value) from exc
            except (KeyError, TypeError) as exc:
                raise WireError("Malformed plugin request", "invalid_request", -32602) from exc
            finally:
                if task is not None:
                    active.discard(task)

    methods: dict[str, Callable[..., Awaitable[Any]]] = {
        "tools/list": list_tools,
        "tools/call": call_tool,
        "hook/handle": handle_hook,
        "command/run": run_command,
    }
    server = Server(registration, methods, initialize, stop)
    if streams is None:
        await server.serve()
    else:
        server.peer = Peer(*streams, server.dispatch, None, "memory-host")
        try:
            await server.peer.closed.wait()
        finally:
            await server.peer.close()
            await stop()


class _OverWire(Plugin):
    def __init__(self, plugin: Plugin) -> None:
        super().__init__(plugin.name, config=plugin.config)
        self.original = plugin


class _MemoryExternal(External):  # type: ignore[misc]  # Untyped base adapter.
    def __init__(
        self, harness: Any, spec: dict[str, Any], project: Any, home: Any, index: int
    ) -> None:
        super().__init__(harness, spec, project, home, index)
        self._task: asyncio.Task[None] | None = None

    async def open_transport(self) -> None:
        import socket

        left, right = socket.socketpair()
        try:
            host = await asyncio.open_connection(sock=left, limit=MAX_FRAME + 2)
            plugin = await asyncio.open_connection(sock=right, limit=MAX_FRAME + 2)
        except BaseException:
            left.close()
            right.close()
            raise
        self.peer = Peer(*host, self.callback, self.notification, self.name)
        self._task = asyncio.create_task(_serve(self.spec["_over_wire"], plugin))

    async def stop(self) -> None:
        try:
            await super().stop()
        finally:
            if self._task is not None:
                await self._task


def serve(plugin: Plugin) -> None:
    """Speak the plugin binding on stdin/stdout until the host disconnects."""
    items = [f"tool:{t.name}" for t in plugin._tools if t.in_process_only]
    items += [point for point in plugin._hooks if point not in _SUPPORTED_HOOKS]
    if items:
        raise AgentError(ErrorCode.NOT_SUPPORTED, "Cannot serve " + ", ".join(items))
    asyncio.run(_serve(plugin))
