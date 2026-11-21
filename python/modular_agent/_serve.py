"""Serve SDK registrations with the base's plugin-binding transport."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Coroutine
from contextvars import ContextVar
from copy import deepcopy
from os import PathLike
from pathlib import Path
from typing import Any, cast, overload

from ma_plugin.host import External
from ma_plugin.rpc import MAX_FRAME, Peer, WireError
from ma_plugin.server import BINDING, PluginServer
from ma_plugin.websocket import (
    PLUGIN_PROTOCOL,
    WebSocketFrames,
    WebSocketServer,
    WebSocketTLS,
    listen_websocket,
)

from ._context import HookContext
from ._jobs import Job, JobContext, JobOutcome
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
from ._provider import Provider, ProviderContext, _available, _models, _request
from ._tool import LeftOpen, Tool, ToolContext, ToolSource
from ._types import AgentError, Answer, Content, ErrorCode, Json, JsonObject, ModelRef, QuestionSpec
from ._working import _METHODS, _dispatch_environment


async def _serve(
    plugin: Plugin,
    streams: tuple[asyncio.StreamReader, asyncio.StreamWriter] | None = None,
    *,
    frames: WebSocketFrames | None = None,
) -> None:
    registrar: Registrar | None = None
    attempted = False
    stopped = False
    active: set[asyncio.Task[Any]] = set()
    environment_output: dict[str, Callable[[Content], Awaitable[None]]] = {}
    provider_locks: dict[tuple[str, str], asyncio.Lock] = {}
    changing: ContextVar[set[str] | None] = ContextVar("tool_source_changes", default=None)
    subscriptions: list[tuple[ToolSource, Callable[[], None]]] = []
    notifications: set[asyncio.Task[None]] = set()
    jobs: dict[str, Job] = {}

    def job_from(jid: str, sid: str, actor: str, kind: str, detail: Json) -> Job:
        async def progress(content: Content) -> None:
            await server.peer.notify("host/jobs/progress", {"jobId": jid, "content": content})

        async def end(outcome: JobOutcome, result: Content | None, report: bool) -> None:
            try:
                await server.peer.request(
                    "host/jobs/end",
                    {
                        "jobId": jid,
                        "outcome": {"kind": outcome},
                        "report": report,
                        **({"result": result} if result is not None else {}),
                    },
                )
            except WireError as exc:
                raise _error(exc, ErrorCode.INVALID_REQUEST) from exc
            jobs.pop(jid, None)

        return Job(jid, sid, actor, kind, detail, progress, end)

    def start_job(
        key: str | int, sid: str, actor: str
    ) -> Callable[[str, Json, str | None], Awaitable[Job]]:
        async def start(kind: str, detail: Json, dedupe: str | None) -> Job:
            try:
                reply = await server.peer.request(
                    "host/jobs/start",
                    {
                        "parentRequestId": key,
                        "kind": kind,
                        "detail": detail,
                        **({"key": dedupe} if dedupe is not None else {}),
                    },
                )
            except WireError as exc:
                raise _error(exc, ErrorCode.INVALID_REQUEST) from exc
            jid = reply["jobId"]
            if jid not in jobs:
                jobs[jid] = job_from(jid, sid, actor, kind, detail)
            return jobs[jid]

        return start

    async def invoke_job(callback: Callable[[Job, JobContext], Awaitable[None]], job: Job) -> None:
        async def history(cursor: str | None) -> JsonObject:
            return cast(
                JsonObject,
                await server.peer.request(
                    "host/history",
                    {
                        "sessionId": job.session_id,
                        **({"after": cursor} if cursor else {}),
                    },
                ),
            )

        async def emit(type: str, data: Json) -> None:
            await server.peer.notify(
                "host/emit", {"sessionId": job.session_id, "type": type, "data": data}
            )

        context = JobContext(job, history=history, emit=emit)
        try:
            await callback(job, context)
        except asyncio.CancelledError:
            context.cancelled.set()
            raise
        finally:
            context._active = False

    async def notify_source(source: str, key: str | int | None = None) -> None:
        try:
            await server.peer.notify(
                "tools/changed",
                {
                    "toolSource": source,
                    **({"parentRequestId": key} if key is not None else {}),
                },
            )
        except (ConnectionError, WireError):
            pass

    def subscribe(source: ToolSource) -> None:
        def changed() -> None:
            bucket = changing.get()
            if bucket is not None:
                bucket.add(source.id)
            elif not stopped:
                task = asyncio.create_task(notify_source(source.id))
                notifications.add(task)
                task.add_done_callback(notifications.discard)

        source._subscribers.add(changed)
        subscriptions.append((source, changed))

    async def source_tools(source: ToolSource, session: str | None) -> list[Tool]:
        result = list(await source.tools(session))
        if hidden := [t.name for t in result if t.in_process_only]:
            raise WireError("Cannot serve tools: " + ", ".join(hidden), "not_supported")
        return result

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
        items += [
            label
            for label, part in (
                ("credential store", registrar._credential_store),
                ("configuration", registrar._configuration),
                ("interface", registrar._interface),
            )
            if part is not None
        ]
        items += list(registrar._defined_hooks)
        if items:
            raise WireError("Cannot serve " + ", ".join(items), "not_supported")
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
        for source in registrar._sources.values():
            if source.id == plugin.name and registrar._tools:
                raise WireError("Duplicate tool source", "invalid_request")
            registration["toolSources"].append(
                {
                    "id": source.id,
                    "perSession": source.per_session,
                    "tools": []
                    if source.per_session
                    else [t.definition for t in await source_tools(source, None)],
                }
            )
            subscribe(source)
        if registrar._environment is not None:
            registration["workingEnvironment"] = registrar._environment.supports
        registration["hooks"] = [
            {"hook": h.point, "handlerId": n, "order": h.order}
            for n, h in enumerate(registrar._hooks, 1)
        ]
        if registrar._job_owner is not None and getattr(registrar._job_owner, "resume", None):
            registration["hooks"].append(
                {
                    "hook": "session.start",
                    "handlerId": len(registrar._hooks) + 1,
                    "order": "first",
                }
            )
        registration["providers"] = [
            {
                "id": p.id,
                "models": _models(p),
                "supports": {
                    "keepsState": p.supports.keeps_state,
                    "runsTools": False,
                    "safeToRepeat": p.supports.safe_to_repeat,
                },
            }
            for p in registrar._providers.values()
        ]
        registration["commands"] = [
            {"name": c.name, "description": c.description} for c in registrar._commands.values()
        ]

    async def stop() -> None:
        nonlocal stopped
        if stopped:
            return
        stopped = True
        for source, callback in subscriptions:
            source._subscribers.discard(callback)
        tasks = (active | notifications) - {asyncio.current_task()}
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if attempted:
            await plugin._close()

    def registered() -> Registrar:
        if registrar is None or stopped:
            raise WireError("Plugin is not accepting work", "invalid_request")
        return registrar

    async def list_tools(p: dict[str, Any], key: str | int) -> JsonObject:
        reg, sid = registered(), p.get("sessionId")
        source = reg._sources.get(p.get("toolSource", ""))
        if source is not None and source.per_session == isinstance(sid, str):
            listed = await source_tools(source, sid)
        elif source is None and p.get("toolSource") == plugin.name and sid is None:
            listed = list(reg._tools.values())
        else:
            raise WireError("Unknown tool source or invalid session scope", "invalid_request")
        return {"tools": [t.definition for t in listed]}

    async def scoped_environment(
        sid: str,
        project: str,
        key: str | int,
        progress: Callable[[Content], Awaitable[None]] | None,
        operation: str,
        params: JsonObject,
    ) -> Json:
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
        from uuid import uuid4

        callback_id = uuid4().hex
        if operation == "bash" and progress is not None:
            environment_output[callback_id] = progress
        try:
            reply = await server.peer.request(
                "host/env/" + methods[operation],
                {
                    **arguments,
                    "parentRequestId": key,
                    "sessionId": sid,
                    "cwd": project,
                },
                key=callback_id,
            )
        except WireError as exc:
            raise _error(exc, ErrorCode.INVALID_REQUEST) from exc
        finally:
            environment_output.pop(callback_id, None)
        if operation == "bash":
            return {
                "exit_code": reply["exitCode"],
                "text": reply["output"],
                "timed_out": reply["timedOut"],
            }
        return cast(Json, reply)

    async def call_tool(p: dict[str, Any], key: str | int) -> JsonObject:
        call = p["call"]
        reg = registered()
        source = reg._sources.get(p.get("toolSource", ""))
        if source is not None and isinstance(p.get("sessionId"), str):
            listed = await source_tools(source, p["sessionId"] if source.per_session else None)
            t = next((t for t in listed if t.name == call["name"]), None)
        else:
            t = reg._tools.get(call["name"]) if p.get("toolSource") == plugin.name else None
        if (
            t is None
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
            return await scoped_environment(
                p["sessionId"], p["project"], key, progress, operation, params
            )

        async def history(cursor: str | None) -> JsonObject:
            try:
                page = await server.peer.request(
                    "host/history",
                    {"parentRequestId": key, **({"after": cursor} if cursor else {})},
                )
            except WireError as exc:
                raise _error(exc, ErrorCode.INVALID_REQUEST) from exc
            return cast(JsonObject, page)

        context = ToolContext(
            p["sessionId"],
            call.get("actorId", "user"),
            call["id"],
            ask,
            progress,
            nested,
            environment,
            history,
            start_job=start_job(key, p["sessionId"], call.get("actorId", "user"))
            if reg._job_owner
            else None,
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

    def provider_for(p: dict[str, Any]) -> Provider:
        provider = registered()._providers.get(p["provider"])
        if provider is None:
            raise WireError("Unknown Provider", "invalid_request")
        return provider

    async def models(p: dict[str, Any], key: str | int) -> dict[str, Any]:
        return {"models": _models(provider_for(p))}

    async def available(p: dict[str, Any], key: str | int) -> JsonObject:
        return {"available": await _available(provider_for(p))}

    async def request_model(p: dict[str, Any], key: str | int) -> JsonObject:
        provider = provider_for(p)
        ref = p["model"]
        info = next((m for m in _models(provider) if m["id"] == ref["id"]), None)
        if info is None or ref["provider"] != provider.id:
            raise WireError("Unknown model", "invalid_request")
        sid = p.get("sessionId")
        if provider.supports.keeps_state and not sid:
            raise WireError("Stateful Provider requires a session", "invalid_request")
        scope = {"sessionId": sid, "provider": provider.id, "model": ref}

        async def infer() -> JsonObject:
            hook = await server.peer.request(
                "host/hook",
                {
                    "parentRequestId": key,
                    "hook": "provider.request",
                    "payload": {**scope, "request": p["request"]},
                },
            )
            answer = await server.peer.request("host/credentials/read", {"provider": provider.id})
            raw = answer.get("credential")
            credential = (
                raw.get("key") if isinstance(raw, dict) and raw.get("type") == "apiKey" else None
            )

            async def piece(event: JsonObject) -> None:
                await server.peer.notify("provider/event", {"parentRequestId": key, **event})

            cx = ProviderContext(sid, None, piece, lambda: credential)
            reply = await _request(
                provider,
                ModelRef(provider.id, ref["id"]),
                info,
                hook["request"],
                cx,
            )
            await server.peer.request(
                "host/hook",
                {
                    "parentRequestId": key,
                    "hook": "provider.response",
                    "payload": {**scope, "message": reply},
                },
            )
            return reply

        if provider.supports.keeps_state and isinstance(sid, str):
            async with provider_locks.setdefault((provider.id, sid), asyncio.Lock()):
                return await infer()
        return await infer()

    async def discard(p: dict[str, Any], key: str | int) -> JsonObject:
        provider = provider_for(p)
        handler = getattr(provider, "discard_state", None)
        if handler is None or p.get("erase"):
            raise WireError("Provider does not support this discard", "not_supported")
        async with provider_locks.setdefault((provider.id, p["sessionId"]), asyncio.Lock()):
            await handler(p["sessionId"])
        return {}

    async def handle_hook(p: dict[str, Any], key: str | int) -> JsonObject | None:
        reg = registered()
        registrations = reg._hooks
        n = p.get("handlerId")
        resume = getattr(reg._job_owner, "resume", None)
        if n == len(registrations) + 1 and p.get("hook") == "session.start" and resume is not None:
            payload = p["payload"]
            if payload.get("resumed"):
                sid = payload["sessionId"]
                unfinished = await server.peer.request("host/jobs/unfinished", {"sessionId": sid})
                for item in unfinished["jobs"]:
                    jid = item["jobId"]
                    if item.get("cleanup") == "unconfirmed" or jid in jobs:
                        continue
                    await server.peer.request("host/jobs/resume", {"jobId": jid})
                    job = jobs[jid] = job_from(
                        jid, sid, item["actorId"], item["kind"], item["detail"]
                    )
                    await invoke_job(resume, job)
            return None
        if (
            type(n) is not int
            or not 1 <= n <= len(registrations)
            or registrations[n - 1].point != p.get("hook")
        ):
            raise WireError("Unknown hook handler", "unknown_handler")
        hook = registrations[n - 1]
        payload = p["payload"]
        sid = payload.get("sessionId")

        async def history(cursor: str | None) -> JsonObject:
            return cast(
                JsonObject,
                await server.peer.request(
                    "host/history",
                    {
                        "sessionId": sid,
                        "parentRequestId": key,
                        **({"after": cursor} if cursor else {}),
                    },
                ),
            )

        async def emit(type: str, data: Json) -> None:
            await server.peer.notify(
                "host/emit", {"sessionId": sid, "parentRequestId": key, "type": type, "data": data}
            )

        try:
            return await _handle_hook(
                hook,
                payload,
                HookContext(payload, history=history if sid else None, emit=emit if sid else None),
            )
        except Exception as exc:
            if hook.point not in _OBSERVERS:
                raise
            logging.getLogger(__name__).warning("%s hook failed: %s", hook.point, exc)
            return None

    async def run_command(p: dict[str, Any], key: str | int) -> JsonObject:
        command = registered()._commands.get(p["name"])
        if command is None:
            raise WireError("Unknown command", "invalid_request")
        sid, actor = p["sessionId"], p["actorId"]
        session = await server.peer.request(
            "host/session", {"sessionId": sid, "parentRequestId": key}
        )

        async def environment(operation: str, params: JsonObject) -> Json:
            return await scoped_environment(sid, session["project"], key, None, operation, params)

        async def history(cursor: str | None) -> JsonObject:
            return cast(
                JsonObject,
                await server.peer.request(
                    "host/history",
                    {
                        "sessionId": sid,
                        "parentRequestId": key,
                        **({"after": cursor} if cursor else {}),
                    },
                ),
            )

        async def emit(type: str, data: Json) -> None:
            await server.peer.notify(
                "host/emit", {"sessionId": sid, "parentRequestId": key, "type": type, "data": data}
            )

        output = await _handle_command(
            command,
            p["args"],
            CommandContext(
                sid,
                actor,
                environment,
                project=Path(session["project"]),
                history=history,
                emit=emit,
                start_job=start_job(key, sid, actor) if registered()._job_owner else None,
            ),
        )
        return {"output": output} if output is not None else {}

    async def cancel_job(p: dict[str, Any], key: str | int) -> JsonObject:
        owner = registered()._job_owner
        job = jobs.get(p.get("jobId", ""))
        if owner is None or job is None:
            raise WireError("Unknown job execution", "invalid_request")
        await invoke_job(owner.cancel, job)
        if not job._settled:
            raise WireError("Job cleanup not confirmed", "lost")
        return {}

    async def call_environment(method: str, params: JsonObject, key: str | int) -> JsonObject:
        environment = registered()._environment
        if environment is None:
            raise WireError("No registered working environment", "not_supported")

        async def progress(chunk: str) -> None:
            await server.peer.notify("env/output", {"parentRequestId": key, "chunk": chunk})

        return await _dispatch_environment(environment, method, params, progress)

    class Server(PluginServer):  # type: ignore[misc]  # Untyped base adapter.
        async def notification(self, method: str, params: dict[str, Any]) -> None:
            if method == "host/env/output" and isinstance(chunk := params.get("chunk"), str):
                callback = environment_output.get(params.get("parentRequestId", ""))
                if callback is not None:
                    await callback([{"type": "text", "text": chunk}])

        async def dispatch(self, method: str, params: dict[str, Any], key: str | int) -> Any:
            nonlocal attempted
            task = asyncio.current_task()
            if method == "plugin/initialize":
                if attempted:
                    raise WireError("Already initialized", "invalid_request")
                attempted = True
            if method != "plugin/shutdown" and task is not None:
                active.add(task)
            changes: set[str] = set()
            scope = changing.set(changes)
            try:
                return await super().dispatch(method, params, key)
            except AgentError as exc:
                raise WireError(exc.message, exc.code.value) from exc
            except (KeyError, TypeError) as exc:
                raise WireError("Malformed plugin request", "invalid_request", -32602) from exc
            finally:
                changing.reset(scope)
                try:
                    if not stopped:
                        for source in sorted(changes):
                            await notify_source(source, key)
                finally:
                    if task is not None:
                        active.discard(task)

    methods: dict[str, Callable[..., Awaitable[Any]]] = {
        "tools/list": list_tools,
        "tools/call": call_tool,
        "hook/handle": handle_hook,
        "command/run": run_command,
        "jobs/cancel": cancel_job,
        "provider/models": models,
        "provider/available": available,
        "provider/request": request_model,
        "provider/discard": discard,
    }

    def bind_environment(name: str) -> Callable[..., Awaitable[JsonObject]]:
        async def invoke(params: JsonObject, key: str | int) -> JsonObject:
            return await call_environment(name, params, key)

        return invoke

    methods.update({f"env/{name}": bind_environment(name) for name in _METHODS})
    server = Server(registration, methods, initialize, stop)
    if frames is not None:
        await server.serve_frames(frames)
    elif streams is None:
        await server.serve()
    else:
        server.peer = Peer(*streams, server.dispatch, server.notification, "memory-host")
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


def _check_servable(plugin: Plugin) -> None:
    items = [f"tool:{t.name}" for t in plugin._tools if t.in_process_only]
    items += [point for point in plugin._hooks if point not in _SUPPORTED_HOOKS]
    if items:
        raise AgentError(ErrorCode.NOT_SUPPORTED, "Cannot serve " + ", ".join(items))


@overload
def serve(plugin: Plugin) -> None: ...


@overload
def serve(
    plugin: Plugin | Callable[[], Plugin],
    *,
    listen: str,
    token_file: str | PathLike[str],
    tls: WebSocketTLS | None = None,
) -> Coroutine[Any, Any, WebSocketServer]: ...


def serve(
    plugin: Plugin | Callable[[], Plugin],
    *,
    listen: str | None = None,
    token_file: str | PathLike[str] | None = None,
    tls: WebSocketTLS | None = None,
) -> None | Coroutine[Any, Any, WebSocketServer]:
    """Serve on stdio, or await a WebSocket listener with a fresh instance per host."""
    if isinstance(plugin, Plugin):
        _check_servable(plugin)
    if listen is None:
        if not isinstance(plugin, Plugin) or token_file is not None or tls is not None:
            raise ValueError("WebSocket options require listen")
        asyncio.run(_serve(plugin))
        return None
    if token_file is None:
        raise ValueError("WebSocket serving requires token_file")

    async def connected(frames: WebSocketFrames, _: None) -> None:
        # Ordinary Plugin values can keep per-connection state in setup's
        # registrar. Use a factory for external resources or stateful closures.
        instance = deepcopy(plugin) if isinstance(plugin, Plugin) else plugin()
        _check_servable(instance)
        await _serve(instance, frames=frames)

    return listen_websocket(listen, [(token_file, None)], PLUGIN_PROTOCOL, connected, tls)
