"""Serve SDK registrations with the base's plugin-binding transport."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Coroutine, Mapping, Sequence
from contextvars import ContextVar
from copy import deepcopy
from os import PathLike
from pathlib import Path
from typing import Any, TypedDict, cast, overload
from inspect import signature

from ma_plugin.host import External
from ma_plugin.rpc import MAX_FRAME, Peer, WireError, exec_deadline
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
from ._runtime_port import RuntimeContext, _dispatch_runtime
from ._working import _METHODS, _dispatch_environment


async def _serve(
    plugin: Plugin,
    streams: tuple[asyncio.StreamReader, asyncio.StreamWriter] | None = None,
    *,
    frames: WebSocketFrames | None = None,
    projects: frozenset[Path] = frozenset(),
    restrict_projects: bool = False,
) -> None:
    environment_project: Path | None = None
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
        nonlocal registrar, environment_project
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
                ("history store", registrar._history_store),
                ("credential store", registrar._credential_store),
                ("configuration", registrar._configuration),
                ("interface", registrar._interface),
            )
            if part is not None
        ]
        items += [f"provider:{name}" for name in sorted(registrar._local_providers)]
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
        if registrar._runtime is not None:
            registration["runtime"] = registrar._runtime[0].declaration()
        if registrar._environment is not None:
            if frames is not None:
                project = p.get("project")
                if not isinstance(project, str) or not Path(project).is_absolute():
                    raise WireError("Environment needs an absolute project path", "not_supported")
                environment_project = Path(project).resolve()
                if environment_project not in projects:
                    raise WireError(
                        "Environment project is outside operator scope", "not_supported"
                    )
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
        arguments.update(exec_deadline(arguments.pop("timeout", None)))
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

        async def custom_event(type: str, data: Json) -> None:
            await server.peer.notify(
                "host/emit",
                {"sessionId": p["sessionId"], "parentRequestId": key, "type": type, "data": data},
            )

        context = ToolContext(
            p["sessionId"],
            call.get("actorId", "user"),
            call["id"],
            ask,
            progress,
            nested,
            environment,
            history,
            emit=custom_event,
            turn_id=p.get("turnId"),
            step_id=call.get("stepId"),
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
        if not isinstance(p.get("args"), str):
            raise WireError("Command args must be text", "invalid_request")
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

        if environment_project is not None and method != "sessionEnded":
            cwd = params.get("cwd")
            if (
                not isinstance(cwd, str)
                or not Path(cwd).is_absolute()
                or Path(cwd).resolve() != environment_project
            ):
                raise WireError("Environment cwd is outside this host project", "invalid_request")
            if method in {"read", "exists", "write", "list"}:
                path = params.get("path")
                if not isinstance(path, str) or not (
                    (environment_project / path).resolve().is_relative_to(environment_project)
                ):
                    raise WireError(
                        "Environment path is outside this host project", "invalid_request"
                    )
        return await _dispatch_environment(environment, method, params, progress)

    model_contexts: dict[str, RuntimeContext] = {}

    def bind_runtime(method: str) -> Callable[..., Awaitable[JsonObject]]:
        async def invoke(params: dict[str, Any], parent: str | int) -> JsonObject:
            installed = registered()._runtime
            if installed is None:
                raise WireError("No registered Runtime", "not_supported")

            async def callback(name: str, value: JsonObject, key: str) -> Json:
                rpc = "host/history" if name == "history" else "host/runtime/" + name
                args = {**value, "parentRequestId": parent}
                if name == "report":
                    await server.peer.notify(rpc, args)
                    return None
                if name == "model":
                    model_contexts[key] = cx
                try:
                    return cast(Json, await server.peer.request(rpc, args, key=key))
                finally:
                    model_contexts.pop(key, None)

            cx = RuntimeContext(params["turn"], callback)
            return await _dispatch_runtime(installed[0], method, params, cx)

        return invoke

    class Server(PluginServer):  # type: ignore[misc]  # Untyped base adapter.
        async def notification(self, method: str, params: dict[str, Any]) -> None:
            if method == "host/runtime/modelEvent" and (
                cx := model_contexts.get(params.get("parentRequestId", ""))
            ):
                await cx._piece(params)
            if method == "host/env/output" and isinstance(chunk := params.get("chunk"), str):
                callback = environment_output.get(params.get("parentRequestId", ""))
                if callback is not None:
                    await callback([{"type": "text", "text": chunk}])

        async def dispatch(self, method: str, params: dict[str, Any], key: str | int) -> Any:
            nonlocal attempted
            task = asyncio.current_task()
            if restrict_projects and "project" in params:
                project = params["project"]
                if (
                    not isinstance(project, str)
                    or not Path(project).is_absolute()
                    or Path(project).resolve() not in projects
                ):
                    raise WireError("Project is outside caller scope", "invalid_request", -32602)
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

    methods.update(
        {
            f"runtime/{name}": bind_runtime(name)
            for name in ("runTurn", "resumeTurn", "continueOpenCalls")
        }
    )
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
        self.peer = self.connection(*host)
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


class PluginCaller(TypedDict):
    caller_id: str
    token_file: str | PathLike[str]


class CallerContext(TypedDict):
    caller_id: str


@overload
def serve(plugin: Plugin) -> None: ...


@overload
def serve(
    plugin: Plugin | Callable[[], Plugin],
    *,
    listen: str,
    token_file: str | PathLike[str],
    tls: WebSocketTLS | None = None,
    projects: Sequence[str | PathLike[str]] = (),
) -> Coroutine[Any, Any, WebSocketServer]: ...


@overload
def serve(
    plugin: Callable[[CallerContext], Plugin],
    *,
    listen: str,
    callers: Sequence[PluginCaller],
    tls: WebSocketTLS | None = None,
    projects: Mapping[str, Sequence[str | PathLike[str]]] | Sequence[str | PathLike[str]] = (),
) -> Coroutine[Any, Any, WebSocketServer]: ...


def serve(
    plugin: Plugin | Callable[[], Plugin] | Callable[[CallerContext], Plugin] | None = None,
    *,
    callers: Sequence[PluginCaller] | None = None,
    listen: str | None = None,
    token_file: str | PathLike[str] | None = None,
    tls: WebSocketTLS | None = None,
    projects: Mapping[str, Sequence[str | PathLike[str]]] | Sequence[str | PathLike[str]] = (),
) -> None | Coroutine[Any, Any, WebSocketServer]:
    """Serve on stdio, or await a WebSocket listener with a fresh instance per host."""
    if callers is not None and (
        not listen or token_file is not None or not callable(plugin) or isinstance(plugin, Plugin)
    ):
        raise AgentError(
            ErrorCode.INVALID_COMPOSITION,
            "Named callers need a listener and a per-connection factory, not a single token",
        )
    if isinstance(plugin, Plugin):
        _check_servable(plugin)
    if listen is None:
        if not isinstance(plugin, Plugin) or token_file is not None or tls is not None or projects:
            raise ValueError("WebSocket options require listen")
        asyncio.run(_serve(plugin))
        return None

    def directories(paths: Sequence[str | PathLike[str]]) -> frozenset[Path]:
        try:
            if isinstance(paths, (str, bytes)) or any(
                not Path(p).is_absolute() or not Path(p).is_dir() for p in paths
            ):
                raise ValueError()
            return frozenset(Path(p).resolve(strict=True) for p in paths)
        except (OSError, ValueError, RuntimeError, TypeError) as exc:
            raise AgentError(
                ErrorCode.INVALID_COMPOSITION, "Invalid plugin service projects"
            ) from exc

    if callers is not None:
        try:
            assert callable(plugin)
            signature(plugin).bind({"caller_id": "caller"})
            table = [(row["token_file"], row["caller_id"]) for row in callers]
            ids = {cid for _, cid in table}
            if (
                not table
                or len(ids) != len(table)
                or not all(isinstance(cid, str) and cid for cid in ids)
            ):
                raise ValueError()
            if isinstance(projects, Mapping) and projects.keys() - ids:
                raise ValueError()
            roots_by_id = {
                cid: directories(
                    projects.get(cid, ()) if isinstance(projects, Mapping) else projects
                )
                for cid in ids
            }
        except (TypeError, ValueError, KeyError) as exc:
            raise AgentError(
                ErrorCode.INVALID_COMPOSITION, "Invalid named caller table or factory"
            ) from exc

        async def named(frames: WebSocketFrames, cid: str) -> None:
            instance = cast(Callable[[CallerContext], Plugin], plugin)({"caller_id": cid})
            _check_servable(instance)
            await _serve(
                instance, frames=frames, projects=roots_by_id[cid], restrict_projects=bool(projects)
            )

        async def listener() -> WebSocketServer:
            try:
                return await listen_websocket(listen, table, PLUGIN_PROTOCOL, named, tls)
            except (ValueError, TypeError, OSError) as exc:
                raise AgentError(
                    ErrorCode.INVALID_COMPOSITION, "Invalid named plugin listener"
                ) from exc

        return listener()
    if token_file is None or plugin is None:
        raise ValueError("WebSocket serving requires a plugin and token_file")
    if isinstance(projects, Mapping):
        raise AgentError(
            ErrorCode.INVALID_COMPOSITION, "Per-caller project bounds need named callers"
        )
    roots = directories(projects)

    async def connected(frames: WebSocketFrames, _: None) -> None:
        # Ordinary Plugin values can keep per-connection state in setup's
        # registrar. Use a factory for external resources or stateful closures.
        instance = (
            deepcopy(plugin) if isinstance(plugin, Plugin) else cast(Callable[[], Plugin], plugin)()
        )
        _check_servable(instance)
        await _serve(instance, frames=frames, projects=roots)

    return listen_websocket(listen, [(token_file, None)], PLUGIN_PROTOCOL, connected, tls)
