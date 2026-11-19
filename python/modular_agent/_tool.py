"""Typed tool declarations and placement-independent result mapping."""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import math
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, cast, get_type_hints, overload

from jsonschema import Draft202012Validator
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, create_model
from referencing import Registry

from ._types import (
    AgentError,
    Answer,
    Content,
    ErrorCode,
    Input,
    Json,
    JsonObject,
    QuestionSpec,
    ToolResult,
    ToolStatus,
    _content,
)


@dataclass(frozen=True)
class ToolOutput:
    content: Content = field(default_factory=list)
    status: Literal["completed", "failed", "refused", "outcomeUnknown"] | ToolStatus = "completed"
    value: Json = None


class _Refusal(Exception):
    pass


class _NestedTools:
    def __init__(self, context: ToolContext) -> None:
        self._context = context

    async def list(self) -> list[JsonObject]:
        cx = self._context
        cx._check()
        return cast(list[JsonObject], await cx._nested("list", {}))

    async def call(self, name: str, input: JsonObject) -> ToolResult:
        cx = self._context
        cx._check()
        if not isinstance(name, str) or not name or not isinstance(input, dict):
            raise AgentError(ErrorCode.INVALID_REQUEST, "Nested tools need a name and object input")
        result = cast(dict[str, Any], await cx._nested("call", {"name": name, "input": input}))
        return ToolResult(
            name,
            ToolStatus(result["status"]),
            result["callId"],
            result["content"],
            result.get("value"),
        )


class ToolContext:
    def __init__(
        self,
        session_id: str,
        actor_id: str,
        call_id: str,
        ask: Callable[[QuestionSpec, int, float | None], Awaitable[Answer]],
        progress: Callable[[Content], Awaitable[None]],
        nested: Callable[[str, JsonObject], Awaitable[Json]],
    ) -> None:
        self.session_id = session_id
        self.actor_id = actor_id
        self.call_id = call_id
        self.cancelled = asyncio.Event()
        self._ask = ask
        self._progress = progress
        self._nested = nested
        self.tools = _NestedTools(self)
        self._question_index = 0
        self._active = True

    def _check(self) -> None:
        if not self._active:
            raise AgentError(ErrorCode.INVALID_REQUEST, "The call has settled")

    def refuse(self, reason: str) -> _Refusal:
        self._check()
        raise _Refusal(reason)

    async def ask(
        self,
        question: QuestionSpec,
        *,
        wait: float | None = None,
        then: Literal["leaveOpen"] | None = None,
    ) -> Answer:
        self._check()
        if then is not None:
            raise AgentError(ErrorCode.NOT_SUPPORTED, "Leaving tool calls open is not supported")
        if wait is not None and (not math.isfinite(wait) or wait < 0):
            raise AgentError(
                ErrorCode.INVALID_REQUEST, "Question wait must be finite, nonnegative seconds"
            )
        self._question_index += 1
        return await self._ask(question, self._question_index, wait)

    async def progress(self, content: Input) -> None:
        self._check()
        await self._progress(_content(content))

    def log(self, message: str) -> None:
        self._check()
        logging.getLogger("modular_agent.plugin").warning("%s", message)


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    parameters: JsonObject
    _parse: Callable[[JsonObject], dict[str, Any]]
    _handler: Callable[..., Awaitable[Any]]
    _context: str | None
    _output: TypeAdapter[Any] | None = None
    read_only: bool = False
    destructive: bool = True
    open_world: bool = True
    safe_to_repeat: bool = False
    parallel: bool = False
    callers: Sequence[Literal["model", "ui", "plugin"]] = ("model", "ui", "plugin")
    presentation: JsonObject | None = None
    in_process_only: bool = False

    @property
    def definition(self) -> JsonObject:
        result: JsonObject = {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
            "hints": {
                "readOnly": self.read_only,
                "destructive": self.destructive,
                "openWorld": self.open_world,
                "safeToRepeat": self.safe_to_repeat,
            },
            "parallel": self.parallel,
            "callers": list(self.callers),
        }
        if self._output is not None:
            result["returns"] = _schema(self._output.json_schema(mode="serialization"))
        if self.presentation is not None:
            result["presentation"] = self.presentation
        return result

    async def _run(self, arguments: Json, context: ToolContext) -> JsonObject:
        try:
            Draft202012Validator(self.parameters, registry=Registry()).validate(arguments)
            kwargs = self._parse(cast(JsonObject, arguments))
            if self._context:
                kwargs[self._context] = context
            value = await self._handler(**kwargs)
            if isinstance(value, ToolOutput):
                result: JsonObject = {
                    "status": value.status,
                    "content": value.content,
                    **({"value": value.value} if value.value is not None else {}),
                }
            elif isinstance(value, str):
                result = {"status": "completed", "content": _content(value)}
                if self._output is not None:
                    result["value"] = value
            elif isinstance(value, list) and all(
                isinstance(p, dict) and "type" in p for p in value
            ):
                result = {"status": "completed", "content": value}
            elif self._output is not None:
                result = {"status": "completed", "value": value, "content": []}
            else:
                raise ValueError("A structured tool value needs an output schema")
            if self._output is not None and result["status"] == "completed":
                checked = self._output.validate_python(result.get("value"), strict=True)
                encoded = cast(Json, self._output.dump_python(checked, mode="json"))
                Draft202012Validator(self.definition["returns"], registry=Registry()).validate(
                    encoded
                )
                result["value"] = encoded
                if not result["content"]:
                    result["content"] = _content(
                        json.dumps(encoded, ensure_ascii=False, allow_nan=False)
                    )
            if result["status"] not in {"completed", "failed", "refused", "outcomeUnknown"}:
                raise ValueError("Tool returned a status it cannot set")
            if result["status"] != "completed" and not result["content"]:
                result["content"] = _content(
                    {
                        "failed": "Tool failed",
                        "refused": "Tool refused",
                        "outcomeUnknown": "Tool outcome is unknown",
                    }[str(result["status"])]
                )
            return result
        except _Refusal as exc:
            return {"status": "refused", "content": _content(str(exc) or "Tool refused")}
        except asyncio.CancelledError:
            context.cancelled.set()
            raise
        except Exception as exc:
            return {"status": "failed", "content": _content(str(exc) or type(exc).__name__)}
        finally:
            context._active = False
            if (task := asyncio.current_task()) is not None and task.cancelling():
                context.cancelled.set()
                raise asyncio.CancelledError


def _schema(schema: dict[str, Any]) -> JsonObject:
    return {"$schema": "https://json-schema.org/draft/2020-12/schema", **schema}


@overload
def tool(function: Callable[..., Awaitable[Any]], /) -> Tool: ...


@overload
def tool(
    *,
    name: str | None = None,
    read_only: bool = False,
    destructive: bool = True,
    open_world: bool = True,
    safe_to_repeat: bool = False,
    parallel: bool = False,
    callers: Sequence[Literal["model", "ui", "plugin"]] = ("model", "ui", "plugin"),
    presentation: JsonObject | None = None,
    in_process_only: bool = False,
    output: type[Any] | None = None,
) -> Callable[[Callable[..., Awaitable[Any]]], Tool]: ...


def tool(
    function: Callable[..., Awaitable[Any]] | None = None,
    /,
    *,
    name: str | None = None,
    read_only: bool = False,
    destructive: bool = True,
    open_world: bool = True,
    safe_to_repeat: bool = False,
    parallel: bool = False,
    callers: Sequence[Literal["model", "ui", "plugin"]] = ("model", "ui", "plugin"),
    presentation: JsonObject | None = None,
    in_process_only: bool = False,
    output: type[Any] | None = None,
) -> Tool | Callable[[Callable[..., Awaitable[Any]]], Tool]:
    """Make a Tool from an async function. A ToolContext parameter is not model input."""

    def decorate(func: Callable[..., Awaitable[Any]]) -> Tool:
        if not inspect.iscoroutinefunction(func):
            raise AgentError(ErrorCode.INVALID_PARAMS, "A tool handler must be async")
        doc = inspect.getdoc(func) or ""
        description = doc.split("\n\n", 1)[0].replace("\n", " ")
        args = doc.partition("\nArgs:\n")[2]
        fields_doc = dict(re.findall(r"^\s+(\w+):\s*(.+)$", args, re.MULTILINE))
        hints = get_type_hints(func, include_extras=True)
        fields: dict[str, Any] = {}
        context = None
        for key, parameter in inspect.signature(func).parameters.items():
            if key not in hints or parameter.kind not in {
                inspect.Parameter.KEYWORD_ONLY,
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
            }:
                raise AgentError(ErrorCode.INVALID_PARAMS, f"Invalid tool parameter: {key}")
            if hints[key] is ToolContext:
                if context is not None:
                    raise AgentError(ErrorCode.INVALID_PARAMS, "Only one ToolContext is allowed")
                context = key
                continue
            default = ... if parameter.default is inspect.Parameter.empty else parameter.default
            fields[key] = (hints[key], Field(default=default, description=fields_doc.get(key)))
        model_param = next(iter(fields), "")
        declared = hints.get(model_param)
        if len(fields) == 1 and isinstance(declared, type) and issubclass(declared, BaseModel):
            schema = declared.model_json_schema()

            def parse(arguments: JsonObject) -> dict[str, Any]:
                return {
                    model_param: declared.model_validate_json(json.dumps(arguments), strict=True)
                }
        else:
            model = create_model(func.__name__, __config__=ConfigDict(extra="forbid"), **fields)
            schema = model.model_json_schema()

            def parse(arguments: JsonObject) -> dict[str, Any]:
                return dict(model.model_validate_json(json.dumps(arguments), strict=True))

        return Tool(
            name or func.__name__,
            description,
            _schema(schema),
            parse,
            func,
            context,
            TypeAdapter(output) if output is not None else None,
            read_only,
            destructive,
            open_world,
            safe_to_repeat,
            parallel,
            tuple(callers),
            presentation,
            in_process_only,
        )

    return decorate if function is None else decorate(function)
