"""Only this layer names native capabilities and translates native records."""

from __future__ import annotations

import inspect
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, cast

from ma_core import AgentError as _NativeError, Plugin as _NativePlugin
from ma_core.wire import result_in, tool_in
from ma_plugin import hooks
from ma_plugin.rpc import WireError
from ma_tools import Tools

from ._plugin import CommandContext, Plugin, Registrar, _OBSERVERS, _handle_command, _handle_hook
from ._tool import ToolContext
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
        self._sessions[d["session"]["id"]] = d["session"]
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
            {k: s[k] for k in ("id", "project", "position")}
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
    )


async def _reply(handler: QuestionHandler, q: Question) -> Answer:
    try:
        value = handler(q, QuestionContext(q.session_id))
        return _answer(await value if inspect.isawaitable(value) else value)
    except Exception:
        return Answer("decline")


def _read_answer(result: dict[str, Any], kind: str) -> Answer:
    value = result.get("value")
    if result.get("declined") or value == "declined" or value is None:
        return Answer("decline", reason=result.get("reason"))
    if kind == "approval" and value == "allow":
        return Answer("allow")
    return Answer("value", value)


class _LocalPlugin(_NativePlugin):  # type: ignore[misc]  # Untyped base adapter.
    role = "tool_source"

    def __init__(self, plugin: Plugin, registrar: Registrar, project: Path) -> None:
        self.plugin = plugin
        self.name = plugin.name
        self.project = project
        self.registrar = registrar
        self.target = "sdk:tools:" + self.name

    async def start(self, api: Any) -> None:
        await super().start(api)
        if self.registrar._tools:
            api.provide(self.target, self)
            api.on("tools.list", self.definitions)
        for hook in self.registrar._hooks:

            def bind(item: Any) -> Callable[[dict[str, Any]], Awaitable[Any]]:
                async def run(d: dict[str, Any]) -> Any:
                    try:
                        payload = await hooks.payload(self, item.point, d)
                        if item.in_process_only and item.point in {"turn.before", "input"}:
                            state = await self.api.session("get", session=d["session"])
                            payload["project"] = state["project"]
                            if item.point == "turn.before":
                                from ma_core.wire import tool_out

                                definitions = await self.api.call("tools", "definitions", d)
                                payload["nestedTools"] = [
                                    tool_out(t) for t in definitions if "plugin" in t["callers"]
                                ]
                        return hooks.answer(item.point, d, await _handle_hook(item, payload))
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
                    reply = await _handle_command(
                        item, d["args"], CommandContext(d["session"], d["actor"])
                    )
                    return {"output": reply} if reply is not None else {}

                return run

            api.command(command.name, command.description, bind_command(command))

    async def definitions(self, d: JsonObject) -> list[JsonObject]:
        return [
            {
                **tool_in(t.definition),
                "target": self.target,
                "source": {"plugin": self.name, "toolSource": self.name},
            }
            for t in self.registrar._tools.values()
        ]

    async def run(self, d: dict[str, Any], emit: Any) -> JsonObject:
        call, sid = d["call"], d["session"]

        async def ask(question: QuestionSpec, index: int, wait: float | None) -> Answer:
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
                    "park": False,
                }
                if question["kind"] == "approval":
                    params["approval_call"] = {"name": call["name"], "input": call["input"]}
                return _read_answer(
                    await self.api.call("questions", "ask", params), question["kind"]
                )
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

        context = ToolContext(sid, call["actor"], call["id"], ask, progress, nested, environment)
        result = await self.registrar._tools[call["name"]]._run(call["input"], context)
        return cast(JsonObject, result_in(result, call["id"]))

    async def stop(self) -> None:
        await self.plugin._close()
