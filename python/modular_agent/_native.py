"""Only this layer names native capabilities and translates native records."""

from __future__ import annotations

import asyncio
import inspect
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, cast

from ma_core import AgentError as _NativeError, Plugin as _NativePlugin, identity
from ma_core.wire import (
    model_out,
    model_request_fields,
    request_in,
    request_out,
    response_out,
    result_in,
    tool_in,
    usage_out,
)
from ma_plugin import hooks
from ma_plugin.rpc import WireError
from ma_tools import Tools

from ._context import HookContext
from ._jobs import Job, JobContext, JobOutcome
from ._plugin import (
    CommandContext,
    Plugin,
    Registrar,
    _OBSERVERS,
    _handle_command,
    _handle_hook,
    _invoke_hook,
    _SUPPORTED_HOOKS,
)
from ._tool import LeftOpen, ToolContext
from ._types import (
    AgentError,
    Answer,
    Content,
    ErrorCode,
    Json,
    JsonObject,
    Question,
    QuestionContext,
    QuestionHandler,
    QuestionSpec,
    _answer,
    _text,
)


def _error(exc: Exception, default: ErrorCode = ErrorCode.INTERNAL) -> AgentError:
    if isinstance(exc, AgentError):
        return exc
    code = getattr(exc, "code", None) or default
    if isinstance(exc, FileNotFoundError):
        code = "not_found"
    code = {
        "locked": "held",
        "unknown_session": "not_found",
        "process_lost": "lost",
        "refused": "forbidden",
        "failed": default,
        "unavailable": "not_supported",
    }.get(code, code)
    try:
        return AgentError(
            ErrorCode(code), str(exc), {"retryAfterMs": 0} if code == "held" else None
        )
    except (ValueError, TypeError):
        return AgentError(default, str(exc))


class _SdkTools(Tools):  # type: ignore[misc]  # Untyped base adapter.
    name = "sdk-tools"

    async def definitions(self, d: JsonObject, emit: Any) -> list[JsonObject]:
        groups = await self.api.hook("tools.list", d)
        tools = [t for group in groups for t in group]
        if getattr(self, "conformance", False):
            from ma_tools import DEFINITIONS

            tools.extend(t for t in DEFINITIONS if t["name"] == "bash")
        if len({t["name"] for t in tools}) != len(tools):
            raise _NativeError("Duplicate tool name")
        return tools


class _MemoryHistory(_NativePlugin):  # type: ignore[misc]  # Untyped base adapter.
    name = "history"
    role = "history_store"
    declarations = {"erasure": False, "retention": "process", "single_writer": True}

    def __init__(self) -> None:
        self._sessions: dict[str, dict[str, Any]] = {}

    async def start(self, api: Any) -> None:
        await super().start(api)
        api.provide("history", self)

    async def keep(self, d: dict[str, Any], emit: Any) -> JsonObject:
        meta = d["session"]
        prior = self._sessions.get(meta["id"], {}).get("entries", [])
        self._sessions[meta["id"]] = {**meta, "entries": [*prior, *d["entries"]]}
        return {}

    async def read(self, d: dict[str, Any], emit: Any) -> dict[str, Any] | None:
        return self._sessions.get(d["session"])

    async def open(self, d: dict[str, Any], emit: Any) -> dict[str, Any] | None:
        session = self._sessions.get(d["session"])
        if session is None:
            return None
        return {
            k: v for k, v in session.items() if k not in {"busy", "closing", "suspending", "moving"}
        }

    async def list(self, d: dict[str, Any], emit: Any) -> list[JsonObject]:
        return [
            {
                **{k: s[k] for k in ("id", "project", "position")},
                "model": s["settings"].get("model"),
                "lastActivity": max((e["time"] for e in s["entries"]), default=s["created"]),
            }
            for s in self._sessions.values()
            if not d.get("project") or s["project"] == d["project"]
        ]

    async def close(self, d: JsonObject, emit: Any) -> JsonObject:
        return {}

    async def erase(self, d: JsonObject, emit: Any) -> JsonObject:
        raise _NativeError("Memory erasure is not supported", "not_supported")


def _question(sid: str, q: dict[str, Any]) -> Question:
    return Question(
        q["id"],
        sid,
        q["kind"],
        q["question"],
        tuple(q.get("options") or ()),
        q.get("details"),
        q.get("approval_call"),
        q.get("deadline"),
        q.get("answerable", True),
    )


async def _reply(handler: QuestionHandler, q: Question) -> Answer:
    try:
        value = handler(q, QuestionContext(q.session_id))
        return _answer(await value if inspect.isawaitable(value) else value)
    except Exception:
        return Answer("decline")


def _read_answer(result: dict[str, Any], kind: str) -> Answer:
    value = result.get("value")
    if result.get("declined", False) or value is None:
        return Answer("decline", reason=result.get("reason"))
    if kind == "secret" and isinstance(value, dict) and isinstance(value.get("credential"), str):
        return Answer("value", value["credential"])
    if kind == "approval" and value == "allow":
        return Answer("allow")
    return Answer("value", value)


class _LocalPlugin(_NativePlugin):  # type: ignore[misc]  # Untyped base adapter.
    role = "tool_source"

    def __init__(
        self, plugin: Plugin, registrar: Registrar, project: Path, *, late_answers: bool
    ) -> None:
        self.plugin = plugin
        self.name = plugin.name
        self.project = project
        self.registrar = registrar
        self.late_answers = late_answers
        self.target = "sdk:tools:" + self.name

    async def start(self, api: Any) -> None:
        await super().start(api)
        if self.registrar._tools or self.registrar._sources:
            api.provide(self.target, self)
            api.on("tools.list", self.definitions)
        if self.registrar._job_owner is not None:
            api.provide("job-owner:" + self.name, self)
            api.on("session.start", self._resume_jobs)
        for name, rule in self.registrar._defined_hooks.items():
            api.define_hook(name, "first" if rule == "firstAnswer" else rule)
        for hook in self.registrar._hooks:

            def bind(item: Any) -> Callable[[dict[str, Any]], Awaitable[Any]]:
                async def run(d: dict[str, Any]) -> Any:
                    try:
                        custom = item.point not in _SUPPORTED_HOOKS
                        payload = d if custom else await hooks.payload(self, item.point, d)
                        sid = cast(str, payload.get("sessionId", ""))

                        async def history(cursor: str | None) -> JsonObject:
                            return await self._history_page(sid, cursor)

                        async def emit(type: str, data: Json) -> None:
                            if item.point != "output":
                                await self._emit_custom(sid, type, data)

                        context = HookContext(
                            payload,
                            history=history if sid else None,
                            emit=emit if sid else None,
                            call_hook=self._call_hook,
                        )
                        if custom:
                            reply = await _invoke_hook(item, payload, context)
                            if reply is None:
                                return None
                            rule = api._harness.hooks[item.point][1]
                            if rule == "gate":
                                if isinstance(reply.get("refuse"), str):
                                    return {**d, "refused": True, "reason": reply["refuse"]}
                                if reply == {"allow": True}:
                                    return None
                                raise ValueError("Expected allow or refuse")
                            if rule == "transform":
                                if not isinstance(reply.get("change"), dict):
                                    raise ValueError("Expected change")
                                return reply["change"]
                            return reply
                        if item.in_process_only and item.point in {"turn.before", "input"}:
                            state = await self.api.session("get", session=d["session"])
                            payload["project"] = state["project"]
                            if item.point == "turn.before":
                                from ma_core.wire import tool_out

                                definitions = await self.api.call("tools", "definitions", d)
                                payload["nestedTools"] = [
                                    tool_out(t) for t in definitions if "plugin" in t["callers"]
                                ]
                        if item.in_process_only and item.point == "step.before":
                            payload["history"] = (await self._history_page(sid, None))["entries"]
                            payload["usage"] = usage_out(d.get("usage", {}))
                        return hooks.answer(
                            item.point, d, await _handle_hook(item, payload, context)
                        )
                    except Exception as exc:
                        if item.point not in _OBSERVERS:
                            raise _NativeError(
                                f"{self.name} {item.point}: {exc}", "invalid_request"
                            ) from exc
                        logging.getLogger(__name__).warning("%s hook failed: %s", item.point, exc)
                        return None

                return run

            api.on(hooks.NAMES.get(hook.point, hook.point), bind(hook), hook.order)
        for command in self.registrar._commands.values():

            def bind_command(item: Any) -> Callable[[dict[str, Any]], Awaitable[JsonObject]]:
                async def run(d: dict[str, Any]) -> JsonObject:
                    session = await self.api.session("get", session=d["session"])

                    async def environment(operation: str, params: JsonObject) -> Json:
                        try:
                            return cast(
                                Json,
                                await self.api.call(
                                    "environment", operation, {"session": d["session"], **params}
                                ),
                            )
                        except Exception as exc:
                            raise _error(exc, ErrorCode.INVALID_REQUEST) from exc

                    step = cast(str, identity())

                    async def request_model(request: JsonObject) -> JsonObject:
                        try:
                            return await self._command_model(d, step, request)
                        except AgentError:
                            raise
                        except Exception as exc:
                            raise _error(exc, ErrorCode.INVALID_REQUEST) from exc

                    async def ask(question: QuestionSpec, timeout: float | None) -> Answer:
                        if question["kind"] == "approval":
                            raise AgentError(
                                ErrorCode.INVALID_REQUEST, "An approval needs an exact tool call"
                            )
                        answer = await self.api.call(
                            "questions",
                            "ask",
                            {
                                **question,
                                "session": d["session"],
                                "step": step,
                                "actor": d["actor"],
                                "name": question.get("credential"),
                                "park": False,
                                "timeout": timeout,
                                **(
                                    {"responders": question["answerers"]}
                                    if "answerers" in question
                                    else {}
                                ),
                            },
                        )
                        return _read_answer(answer, question["kind"])

                    async def history(cursor: str | None) -> JsonObject:
                        return await self._history_page(d["session"], cursor)

                    async def emit(type: str, data: Json) -> None:
                        await self._emit_custom(d["session"], type, data)

                    reply = await _handle_command(
                        item,
                        d["args"],
                        CommandContext(
                            d["session"],
                            d["actor"],
                            environment,
                            project=Path(session["project"]),
                            step_id=step,
                            request_model=request_model if item.uses_model else None,
                            ask=ask if item.in_process_only else None,
                            history=history,
                            emit=emit,
                            call_hook=self._call_hook,
                            start_job=self._job_start(d) if self.registrar._job_owner else None,
                        ),
                    )
                    return {"output": reply} if reply is not None else {}

                return run

            api.command(command.name, command.description, bind_command(command))

    def _job(self, data: dict[str, Any]) -> Job:
        args = {"session": data["session"], "job": data["id"]}

        async def progress(content: Content) -> None:
            await self.api.call("jobs", "progress", {**args, "content": content})

        async def end(outcome: JobOutcome, result: Content | None, report: bool) -> None:
            try:
                await self.api.call(
                    "jobs",
                    "report",
                    {
                        **args,
                        "state": "outcome_unknown" if outcome == "outcomeUnknown" else outcome,
                        "result": result or [],
                        "report": report,
                        "strict": True,
                    },
                )
            except Exception as exc:
                raise _error(exc) from exc

        return Job(
            data["id"], data["session"], data["actor"], data["kind"], data["detail"], progress, end
        )

    def _job_start(self, d: dict[str, Any]) -> Callable[[str, Json, str | None], Awaitable[Job]]:
        async def start(kind: str, detail: Json, key: str | None) -> Job:
            scope: dict[str, Any] = {
                k: d[k] for k in ("session", "actor", "authority", "turn", "call") if k in d
            }
            if acting := d.get("acting_for"):
                scope["authority"] = await self.api.session(
                    "authority", session=d["session"], actor=acting, ceiling=d.get("authority")
                )
            try:
                job = await self.api.call(
                    "jobs",
                    "create",
                    {**scope, "kind": kind, "detail": detail, "key": key},
                )
            except Exception as exc:
                raise _error(exc, ErrorCode.INVALID_REQUEST) from exc
            return self._job(job)

        return start

    async def _owner_invocation(self, callback: Any, job: Job) -> None:
        async def history(cursor: str | None) -> JsonObject:
            return await self._history_page(job.session_id, cursor)

        async def emit(type: str, data: Json) -> None:
            await self._emit_custom(job.session_id, type, data)

        context = JobContext(job, history=history, emit=emit)
        try:
            await callback(job, context)
        finally:
            context._active = False

    async def _resume_jobs(self, d: dict[str, Any]) -> None:
        resume = getattr(self.registrar._job_owner, "resume", None)
        if not d.get("resumed") or resume is None:
            return
        for data in await self.api.call("jobs", "unfinished", d):
            if data.get("historical") or data.get("state") != "running":
                continue
            await self.api.call("jobs", "take_up", {"session": data["session"], "job": data["id"]})
            await self._owner_invocation(resume, self._job(data))

    async def cancel_job(self, d: dict[str, Any], emit: Any) -> JsonObject:
        owner = self.registrar._job_owner
        jobs = await self.api.call("jobs", "list", d)
        found = next((j for j in jobs if j["id"] == d["job"] and j["owner"] == self.name), None)
        if owner is None or found is None:
            raise _NativeError("Not a job owned by this plugin", "invalid_request")
        job = self._job(found)
        try:
            async with asyncio.timeout(5):
                await self._owner_invocation(owner.cancel, job)
        except TimeoutError as exc:
            raise _NativeError("Job cleanup not confirmed", "lost") from exc
        if not job._settled:
            current = next(j for j in await self.api.call("jobs", "list", d) if j["id"] == job.id)
            if current["state"] == "running":
                raise _NativeError("Job cleanup not confirmed", "lost")
        return {}

    async def _history_page(self, sid: str, cursor: str | None) -> JsonObject:
        from ma_core.wire import entry_out, provider_projection

        records = await self.api.session("branch", session=sid)
        if cursor is not None:
            for i, record in enumerate(records):
                if record["id"] == cursor:
                    records = records[i + 1 :]
                    break
            else:
                raise AgentError(ErrorCode.INVALID_REQUEST, "Unknown history cursor")
        return {
            "entries": [provider_projection(entry_out(e)) for e in records[:500]],
            **({"next": records[499]["id"]} if len(records) > 500 else {}),
        }

    async def _emit_custom(self, sid: str, type: str, data: Json) -> None:
        await self.api.event(type, session=sid, plugin=self.name, data=data)

    async def _call_hook(self, name: str, payload: JsonObject) -> Json:
        if name not in self.registrar._defined_hooks:
            raise AgentError(ErrorCode.INVALID_REQUEST, "Only the custom hook owner may call it")
        return cast(Json, await self.api.hook(name, payload))

    async def _command_model(
        self, command: dict[str, Any], step: str, request: JsonObject
    ) -> JsonObject:
        sid, actor = command["session"], command["actor"]
        api = self.api
        state = await api.session("get", session=sid)
        rights = set(await api.session("authority", session=sid, actor=actor))
        if acting := command.get("acting_for"):
            rights &= set(await api.session("authority", session=sid, actor=acting))
        if "input" not in rights:
            raise AgentError(ErrorCode.FORBIDDEN, "Actor lacks authority: input")
        for key, type_ in (
            ("systemPrompt", str),
            ("messages", list),
            ("tools", list),
            ("settings", dict),
        ):
            if not isinstance(request.get(key), type_):
                raise AgentError(ErrorCode.INVALID_REQUEST, f"Invalid model request {key}")

        async def check_limit() -> None:
            await api.session("assert_writable", session=sid)
            if await api.session("tenant_exhausted", session=sid):
                raise AgentError(
                    ErrorCode.TURN_LIMIT, "Tenant token budget reached", {"limit": "tenantTokens"}
                )
            if (budget := state["settings"].get("max_tokens")) is not None:
                usage = [
                    usage_out(entry.get("data", {}).get("usage", {}))
                    for entry in (await api.session("get", session=sid))["entries"]
                    if entry["kind"] == "response" and not entry.get("fork_source")
                ]
                if sum(item["input"] + item["output"] for item in usage) >= budget:
                    raise AgentError(ErrorCode.TURN_LIMIT, "Session token budget reached")

        await check_limit()
        access = await api.call("selection", "access", {"session": sid})
        model = model_out(access, access["target"])
        attempt = identity()
        data = request_in(
            request,
            {
                "session": sid,
                "actor": actor,
                "step": step,
                "access": access,
                "attempt_id": attempt,
                "provider_tools": False,
            },
        )
        wire = access["provider"].get("wire_provider")
        if wire:
            data["auxiliary_step"] = step
        else:
            data = await api.session("prepare_model_request", **data)
            final = data.get("_shared_request") or request_out(data)
            await api.session(
                "append",
                session=sid,
                actor=actor,
                step=step,
                id=attempt,
                kind="model_started",
                writer=self.name,
                **model_request_fields(
                    {k: model[k] for k in ("provider", "id")}, final, False, auxiliary=True
                ),
            )
        try:
            await check_limit()
            response = await api.call(access["target"], "generate", data)
        except BaseException as exc:
            entries = (await api.session("get", session=sid))["entries"]
            if any(entry["id"] == attempt for entry in entries) and not any(
                entry["kind"] == "response" and attempt in entry.get("copies", [])
                for entry in entries
            ):
                response = (
                    {"stop": "aborted", "recovery": True}
                    if not isinstance(exc, Exception)
                    or isinstance(exc, AgentError)
                    and exc.code == ErrorCode.TURN_LIMIT
                    else {"stop": "failed", "error": {"kind": "other", "message": str(exc)}}
                )
                await api.session(
                    "append",
                    session=sid,
                    actor=actor,
                    step=step,
                    copies=[attempt],
                    kind="response",
                    writer=self.name,
                    data=response,
                )
            if not isinstance(exc, Exception) or isinstance(exc, AgentError):
                raise
            if "response" not in locals():
                raise
        else:
            if not wire:
                await api.session(
                    "append",
                    session=sid,
                    actor=actor,
                    step=step,
                    copies=[attempt],
                    kind="response",
                    writer=self.name,
                    content=response.get("content", []),
                    data={k: v for k, v in response.items() if k != "content"},
                )
        return cast(JsonObject, response_out(response))

    async def definitions(self, d: JsonObject) -> list[JsonObject]:
        session = d.get("session")
        groups = {self.name: list(self.registrar._tools.values())}
        for source in self.registrar._sources.values():
            if not source.per_session or isinstance(session, str):
                groups.setdefault(source.id, []).extend(
                    await source.tools(
                        session if source.per_session and isinstance(session, str) else None
                    )
                )
        names = [t.name for group in groups.values() for t in group]
        if len(set(names)) != len(names):
            raise AgentError(ErrorCode.INVALID_REQUEST, f"Duplicate tool in {self.name}")
        return [
            {
                **tool_in(t.definition),
                "target": self.target,
                "source": {"plugin": self.name, "toolSource": id},
            }
            for id, group in groups.items()
            for t in group
        ]

    async def run(self, d: dict[str, Any], emit: Any) -> JsonObject:
        call, sid = d["call"], d["session"]

        async def ask(
            question: QuestionSpec, index: int, wait: float | None, leave_open: bool
        ) -> Answer:
            if leave_open and not self.late_answers:
                raise AgentError(ErrorCode.NOT_SUPPORTED, "Leaving tool calls open is not enabled")
            try:
                params = {
                    **question,
                    "session": sid,
                    "actor": call["actor"],
                    "call": call["id"],
                    "authority": call.get("authority"),
                    "turn": d.get("turn"),
                    "step": d.get("step"),
                    "key": f"call:{call['id']}:{index}",
                    "timeout": wait,
                    "park": leave_open,
                    "kind": question["kind"],
                    "name": question.get("credential"),
                    **({"responders": question["answerers"]} if "answerers" in question else {}),
                }
                if question["kind"] == "approval":
                    params["approval_call"] = {"name": call["name"], "input": call["input"]}
                response = await self.api.call("questions", "ask", params)
                if response.get("open"):
                    raise LeftOpen(response["request"])
                return _read_answer(response, question["kind"])
            except (_NativeError, WireError) as exc:
                raise _error(exc, ErrorCode.INVALID_REQUEST) from exc

        async def progress(content: Content) -> None:
            await emit({"text": _text(content), "content": content})

        async def nested(operation: str, params: JsonObject) -> Json:
            from ma_core.wire import result_out, tool_out

            try:
                if operation == "list":
                    return [tool_out(t) for t in await self.api.nested_tools(d["dispatch"])]
                return cast(
                    Json,
                    result_out(
                        await self.api.nested_tools(d["dispatch"], params["name"], params["input"])
                    ),
                )
            except _NativeError as exc:
                raise _error(exc, ErrorCode.INVALID_REQUEST) from exc

        async def environment(operation: str, params: JsonObject) -> Json:
            try:
                return cast(
                    Json,
                    await self.api.call("environment", operation, {"session": sid, **params}, emit),
                )
            except Exception as exc:
                raise _error(exc, ErrorCode.INVALID_REQUEST) from exc

        async def history(cursor: str | None) -> JsonObject:
            from ma_core.wire import entry_out, provider_projection

            records = await self.api.session("branch", session=sid)
            if cursor is not None:
                for i, record in enumerate(records):
                    if record["id"] == cursor:
                        records = records[i + 1 :]
                        break
                else:
                    raise AgentError(ErrorCode.INVALID_REQUEST, "Unknown history cursor")
            page = [provider_projection(entry_out(e)) for e in records[:500]]
            return {
                "entries": page,
                **({"next": records[499]["id"]} if len(records) > 500 else {}),
            }

        async def credential(name: str) -> str | None:
            try:
                return cast(str | None, await self.api.call("credentials", "get", {"name": name}))
            except Exception as exc:
                raise _error(exc, ErrorCode.INVALID_REQUEST) from exc

        async def custom_event(type: str, data: Json) -> None:
            await self._emit_custom(sid, type, data)

        context = ToolContext(
            sid,
            call["actor"],
            call["id"],
            ask,
            progress,
            nested,
            environment,
            history,
            credential=credential,
            emit=custom_event,
            call_hook=self._call_hook,
            turn_id=d.get("turn"),
            step_id=d.get("step"),
            start_job=(
                self._job_start({**d, **call, "call": call["id"]})
                if self.registrar._job_owner is not None
                else None
            ),
        )
        try:
            t = self.registrar._tools.get(call["name"])
            if t is None:
                source = self.registrar._sources.get(d["definition"]["source"]["toolSource"])
                if source is not None:
                    t = next(
                        (
                            t
                            for t in await source.tools(sid if source.per_session else None)
                            if t.name == call["name"]
                        ),
                        None,
                    )
            if t is None:
                raise AgentError(ErrorCode.NOT_FOUND, "Tool no longer offered")
            result = await t._run(call["input"], context)
        except LeftOpen as exc:
            return {"open": True, "requestIds": [exc.question_id]}
        return cast(JsonObject, result_in(result, call["id"]))

    async def stop(self) -> None:
        await self.plugin._close()
