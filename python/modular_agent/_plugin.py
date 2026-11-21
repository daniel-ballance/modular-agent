"""A registration is shared by the native adapter and the stdio server."""

from __future__ import annotations

import asyncio
import inspect
import math
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from os import PathLike
from pathlib import Path
from typing import Literal, NotRequired, TypedDict, cast, overload

from ._context import CallContext, HookContext
from ._credentials import CredentialStore
from ._jobs import Job, JobManager, JobOwner
from ._parts import Configuration, Interface
from ._provider import Provider
from ._tool import Tool, ToolEnvironment, ToolSource
from ._types import AgentError, Answer, ErrorCode, Json, JsonObject, QuestionSpec
from ._working import WorkingEnvironment

type Order = Literal["first", "normal", "last"]
type HookAnswer = JsonObject | None
type HookRule = Literal["observe", "gate", "transform", "collect", "firstAnswer"]
type Handler[P] = Callable[[P, HookContext], HookAnswer | Awaitable[HookAnswer]]
type HookHandler = Callable[[JsonObject], HookAnswer | Awaitable[HookAnswer]] | Handler[JsonObject]
type _AnyHandler = HookHandler | Handler[ToolBefore] | Handler[ToolAfter] | Handler[ProviderPiece]


class ToolBefore(TypedDict):
    sessionId: str
    turnId: NotRequired[str | None]
    stepId: NotRequired[str | None]
    call: JsonObject
    definition: JsonObject | None


class ToolAfter(TypedDict):
    sessionId: str
    turnId: NotRequired[str | None]
    call: JsonObject
    result: JsonObject


class ProviderPiece(TypedDict):
    sessionId: str | None
    stepId: NotRequired[str]
    provider: str
    model: JsonObject
    event: JsonObject


type CommandHandler = Callable[[str, CommandContext], str | None | Awaitable[str | None]]
type Setup = Callable[[Registrar], None | Awaitable[None]]
type Stop = Callable[[], None | Awaitable[None]]


class ServicePlugin(TypedDict):
    url: str
    token_file: str | PathLike[str]
    config: NotRequired[JsonObject]


class CommandContext(CallContext):
    def __init__(
        self,
        session_id: str,
        actor_id: str,
        environment: Callable[[str, JsonObject], Awaitable[Json]] | None = None,
        *,
        project: Path,
        step_id: str | None = None,
        request_model: Callable[[JsonObject], Awaitable[JsonObject]] | None = None,
        ask: Callable[[QuestionSpec, float | None], Awaitable[Answer]] | None = None,
        history: Callable[[str | None], Awaitable[JsonObject]] | None = None,
        emit: Callable[[str, Json], Awaitable[None]] | None = None,
        call_hook: Callable[[str, JsonObject], Awaitable[Json]] | None = None,
        start_job: Callable[[str, Json, str | None], Awaitable[Job]] | None = None,
    ) -> None:
        super().__init__(
            session_id, actor_id, step_id=step_id, history=history, emit=emit, call_hook=call_hook
        )
        self.project = project
        self._model = request_model
        self._ask = ask
        self.environment = ToolEnvironment(self._check, environment)
        self.jobs = JobManager(self._check, start_job)

    async def request_model(self, request: JsonObject) -> JsonObject:
        self._check()
        if self._model is None:
            raise AgentError(ErrorCode.NOT_SUPPORTED, "Command did not register uses_model")
        return await self._model(request)

    async def ask(self, question: QuestionSpec, *, wait: float | None = None) -> Answer:
        self._check()
        if self._ask is None:
            raise AgentError(ErrorCode.NOT_SUPPORTED, "Command questions require in_process_only")
        if wait is not None and (not math.isfinite(wait) or wait < 0):
            raise AgentError(ErrorCode.INVALID_REQUEST, "Invalid question wait")
        return await self._ask(question, wait)


@dataclass(frozen=True)
class ProcessPlugin:
    command: Sequence[str]
    env: Mapping[str, str] = field(default_factory=dict)
    config: JsonObject = field(default_factory=dict)

    def _wire(self) -> JsonObject:
        return {"command": list(self.command), "env": dict(self.env), "config": self.config}


@dataclass(frozen=True)
class _Hook:
    point: str
    handler: _AnyHandler
    order: Order
    in_process_only: bool


@dataclass(frozen=True)
class _Command:
    name: str
    description: str
    handler: CommandHandler
    in_process_only: bool
    uses_model: bool


class Registrar:
    def __init__(self, config: JsonObject) -> None:
        self._config = config
        self._tools: dict[str, Tool] = {}
        self._sources: dict[str, ToolSource] = {}
        self._providers: dict[str, Provider] = {}
        self._hooks: list[_Hook] = []
        self._commands: dict[str, _Command] = {}
        self._credential_store: CredentialStore | None = None
        self._configuration: Configuration | None = None
        self._interface: Interface | None = None
        self._environment: WorkingEnvironment | None = None
        self._job_owner: JobOwner | None = None
        self._defined_hooks: dict[str, HookRule] = {}

    def define_hook(self, name: str, rule: HookRule) -> None:
        if "." not in name or name in self._defined_hooks or name in _SUPPORTED_HOOKS:
            raise AgentError(ErrorCode.INVALID_COMPOSITION, f"Invalid custom hook: {name}")
        if rule not in {"observe", "gate", "transform", "collect", "firstAnswer"}:
            raise AgentError(ErrorCode.INVALID_COMPOSITION, f"Invalid hook rule for {name}")
        self._defined_hooks[name] = rule

    def jobs(self, owner: JobOwner) -> None:
        if self._job_owner is not None:
            raise AgentError(ErrorCode.INVALID_COMPOSITION, "Duplicate job owner")
        self._job_owner = owner

    def environment(self, environment: WorkingEnvironment) -> None:
        if self._environment is not None:
            raise AgentError(ErrorCode.INVALID_COMPOSITION, "Duplicate working environment")
        self._environment = environment

    def credential_store(self, store: CredentialStore) -> None:
        if self._credential_store is not None:
            raise AgentError(ErrorCode.INVALID_COMPOSITION, "Duplicate credential store")
        self._credential_store = store

    def configuration(self, source: Configuration) -> None:
        if self._configuration is not None:
            raise AgentError(ErrorCode.INVALID_COMPOSITION, "Duplicate configuration source")
        self._configuration = source

    def interface(self, interface: Interface) -> None:
        if self._interface is not None:
            raise AgentError(ErrorCode.INVALID_COMPOSITION, "Duplicate Interface")
        self._interface = interface

    def config(self) -> JsonObject:
        return self._config

    def tool(self, tool: Tool) -> None:
        if not tool.name or not tool.description or tool.name in self._tools:
            raise AgentError(
                ErrorCode.INVALID_COMPOSITION, f"Invalid tool registration: {tool.name}"
            )
        self._tools[tool.name] = tool

    def tools(self, source: ToolSource) -> None:
        if not source.id or source.id in self._sources:
            raise AgentError(ErrorCode.INVALID_COMPOSITION, f"Invalid tool source: {source.id}")
        self._sources[source.id] = source

    def provider(self, provider: Provider) -> None:
        if not provider.id or provider.id in self._providers:
            raise AgentError(
                ErrorCode.INVALID_COMPOSITION, f"Invalid Provider registration: {provider.id}"
            )
        self._providers[provider.id] = provider

    @overload
    def on(
        self,
        point: Literal["tool.before"],
        handler: Handler[ToolBefore],
        order: Order = "normal",
        *,
        in_process_only: bool = False,
    ) -> None: ...

    @overload
    def on(
        self,
        point: Literal["tool.after"],
        handler: Handler[ToolAfter],
        order: Order = "normal",
        *,
        in_process_only: bool = False,
    ) -> None: ...

    @overload
    def on(
        self,
        point: Literal["provider.piece"],
        handler: Handler[ProviderPiece],
        order: Order = "normal",
        *,
        in_process_only: bool = False,
    ) -> None: ...

    @overload
    def on(
        self,
        point: str,
        handler: HookHandler,
        order: Order = "normal",
        *,
        in_process_only: bool = False,
    ) -> None: ...

    def on(
        self,
        point: str,
        handler: _AnyHandler,
        order: Order = "normal",
        *,
        in_process_only: bool = False,
    ) -> None:
        if order not in {"first", "normal", "last"}:
            raise AgentError(ErrorCode.INVALID_COMPOSITION, f"Invalid hook order: {order}")
        self._hooks.append(_Hook(point, handler, order, in_process_only or point in _LOCAL_HOOKS))

    def command(
        self,
        name: str,
        description: str,
        handler: CommandHandler,
        *,
        uses_model: bool = False,
        in_process_only: bool = False,
    ) -> None:
        if (
            not name
            or name in self._commands
            or name.startswith("/")
            or any(c.isspace() for c in name)
        ):
            raise AgentError(ErrorCode.INVALID_COMPOSITION, f"Invalid command registration: {name}")
        self._commands[name] = _Command(
            name, description, handler, uses_model or in_process_only, uses_model
        )


class Plugin:
    def __init__(
        self,
        name: str,
        *,
        tools: Sequence[Tool] = (),
        hooks: Mapping[str, HookHandler] | None = None,
        config: JsonObject | None = None,
        replaces: Sequence[str] = (),
        setup: Setup | None = None,
        stop: Stop | None = None,
    ) -> None:
        self.name = name
        self.config = config if config is not None else {}
        self.replaces = tuple(replaces)
        self._tools = tuple(tools)
        self._hooks = dict(hooks or {})
        self._setup = setup
        self._stop = stop

    def setup(self, registrar: Registrar) -> None | Awaitable[None]:
        return self._setup(registrar) if self._setup else None

    def stop(self) -> None | Awaitable[None]:
        return self._stop() if self._stop else None

    async def _register(self, config: JsonObject) -> Registrar:
        if not self.name:
            raise AgentError(ErrorCode.INVALID_COMPOSITION, "A plugin needs a name")
        registrar = Registrar(config)
        for tool in self._tools:
            registrar.tool(tool)
        for point, handler in self._hooks.items():
            registrar.on(point, handler)
        result = self.setup(registrar)
        if inspect.isawaitable(result):
            await result
        items = {
            *(f"tool:{n}" for n in registrar._tools),
            *(f"command:{n}" for n in registrar._commands),
            *(f"provider:{n}" for n in registrar._providers),
            *(["working-environment"] if registrar._environment is not None else []),
        }
        if len(set(self.replaces)) != len(self.replaces) or set(self.replaces) - items:
            raise AgentError(ErrorCode.INVALID_COMPOSITION, f"Invalid replacements in {self.name}")
        return registrar

    async def _close(self) -> None:
        result = self.stop()
        if inspect.isawaitable(result):
            await result


def _hook_reply(point: str, answer: JsonObject | None) -> JsonObject | None:
    if answer is None or not answer or answer == {"allow": True} or answer == {"continue": True}:
        return None
    if point == "output":
        if answer.get("block") is True:
            return {"block": True}
        if isinstance(events := answer.get("redact"), list):
            return {"events": events}
    if point == "model.failed":
        if answer.get("stop") is True:
            return {"retry": False}
        if answer.get("retry") is True:
            return {"retry": True}
        if isinstance(retry := answer.get("retry"), dict):
            return {"retry": True, "request": retry}
    if point == "turn.result" and answer == {"accept": True}:
        return None
    if point in {"plugin.load", "turn.result"} and isinstance(answer.get("refuse"), str):
        return answer
    if point == "step.after" and isinstance(answer.get("end"), str):
        return {"refuse": answer["end"]}
    if point == "turn.before" and isinstance(add := answer.get("add"), dict):
        return add
    if point == "tool.before" and isinstance(answer.get("refuse"), str):
        return answer
    if point == "input" and answer == {"handle": True}:
        return answer
    if point in {
        "input",
        "tool.before",
        "tool.after",
        "step.before",
        "provider.request",
    } and isinstance(answer.get("change"), dict):
        return answer
    if point in _OBSERVERS:
        return None
    raise AgentError(ErrorCode.INVALID_REQUEST, f"Invalid answer at {point}")


async def _invoke_hook(hook: _Hook, payload: JsonObject, context: HookContext) -> HookAnswer:
    try:
        try:
            inspect.signature(hook.handler).bind(payload, context)
        except (ValueError, TypeError):
            reply = cast(Callable[[JsonObject], HookAnswer | Awaitable[HookAnswer]], hook.handler)(
                payload
            )
        else:
            reply = cast(Handler[JsonObject], hook.handler)(payload, context)
        return await reply if inspect.isawaitable(reply) else reply
    except asyncio.CancelledError:
        context.cancelled.set()
        raise
    finally:
        context._active = False


async def _handle_hook(
    hook: _Hook, payload: JsonObject, context: HookContext | None = None
) -> JsonObject | None:
    reply = await _invoke_hook(hook, payload, context or HookContext(payload))
    if reply is not None and hook.in_process_only:
        if hook.point == "tool.before" and isinstance(reply.get("pending"), dict):
            return {"pending": reply["pending"]}
        if hook.point == "input" and isinstance(handle := reply.get("handle"), dict):
            if set(handle) == {"command"} and isinstance(handle["command"], str):
                return {"value": {**payload, "command": handle["command"]}, "stop": True}
    result = _hook_reply(hook.point, reply)
    # The SDK changes only the documented fields, even though the edition-3
    # wire expects a replacement enclosing the whole call/result.
    if hook.point == "input" and result is not None and result.get("handle") is True:
        return {"value": payload, "stop": True}
    if result is not None and isinstance(change := result.get("change"), dict):
        if hook.point == "input" and set(change) == {"content"}:
            return {"value": {**payload, "content": change["content"]}}
        call = payload.get("call")
        if hook.point == "tool.before" and isinstance(call, dict) and set(change) == {"input"}:
            return {"change": {"call": {**call, "input": change["input"]}}}
        if hook.point in {"step.before", "provider.request"}:
            prior_request = payload.get("request")
            proposed = change.get("request", change)
            if isinstance(prior_request, dict) and isinstance(proposed, dict):
                request = {**prior_request, **proposed}
                offered = prior_request.get("tools") or []
                tools = request.get("tools")
                if (
                    not isinstance(offered, list)
                    or not isinstance(tools, list)
                    or any(item not in offered for item in tools)
                ):
                    raise AgentError(ErrorCode.INVALID_REQUEST, "Cannot widen the tool offer")
                return {"value": {**payload, "request": request}}
        prior = payload.get("result")
        if (
            hook.point == "tool.after"
            and isinstance(call, dict)
            and isinstance(prior, dict)
            and set(change) <= {"content", "value"}
        ):
            return {"value": {**payload, "result": {**prior, **change}}}
        raise AgentError(ErrorCode.INVALID_REQUEST, f"Invalid change at {hook.point}")
    return result


async def _handle_command(command: _Command, args: str, context: CommandContext) -> str | None:
    try:
        result = command.handler(args, context)
        return await result if inspect.isawaitable(result) else result
    except asyncio.CancelledError:
        context.cancelled.set()
        raise
    finally:
        context._active = False


_LOCAL_HOOKS = {"session.prepare", "session.join", "session.leave", "provider.piece"}
_SUPPORTED_HOOKS = {
    "input",
    "plugin.load",
    "step.before",
    "model.failed",
    "turn.result",
    "provider.request",
    "provider.response",
    "output",
    *_LOCAL_HOOKS,
    "session.start",
    "session.end",
    "turn.start",
    "turn.before",
    "turn.end",
    "step.after",
    "tool.before",
    "tool.after",
}
_OBSERVERS = {
    *_LOCAL_HOOKS,
    "session.start",
    "session.end",
    "turn.start",
    "turn.end",
    "provider.response",
}
