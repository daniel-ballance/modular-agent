"""A registration is shared by the native adapter and the stdio server."""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal

from ._provider import Provider
from ._tool import Tool, ToolEnvironment
from ._types import AgentError, ErrorCode, Json, JsonObject

type Order = Literal["first", "normal", "last"]
type HookHandler = Callable[[JsonObject], JsonObject | None | Awaitable[JsonObject | None]]
type CommandHandler = Callable[[str, CommandContext], str | None | Awaitable[str | None]]
type Setup = Callable[[Registrar], None | Awaitable[None]]
type Stop = Callable[[], None | Awaitable[None]]


class CommandContext:
    def __init__(
        self,
        session_id: str,
        actor_id: str,
        environment: Callable[[str, JsonObject], Awaitable[Json]] | None = None,
    ) -> None:
        self.session_id = session_id
        self.actor_id = actor_id
        self._active = True
        self.environment = ToolEnvironment(self._check, environment)

    def _check(self) -> None:
        if not self._active:
            raise AgentError(ErrorCode.INVALID_REQUEST, "The command has settled")


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
    handler: HookHandler
    order: Order
    in_process_only: bool


@dataclass(frozen=True)
class _Command:
    name: str
    description: str
    handler: CommandHandler
    in_process_only: bool


class Registrar:
    def __init__(self, config: JsonObject) -> None:
        self._config = config
        self._tools: dict[str, Tool] = {}
        self._providers: dict[str, Provider] = {}
        self._hooks: list[_Hook] = []
        self._commands: dict[str, _Command] = {}

    def config(self) -> JsonObject:
        return self._config

    def tool(self, tool: Tool) -> None:
        if not tool.name or not tool.description or tool.name in self._tools:
            raise AgentError(
                ErrorCode.INVALID_COMPOSITION, f"Invalid tool registration: {tool.name}"
            )
        self._tools[tool.name] = tool

    def provider(self, provider: Provider) -> None:
        if not provider.id or provider.id in self._providers:
            raise AgentError(
                ErrorCode.INVALID_COMPOSITION, f"Invalid Provider registration: {provider.id}"
            )
        self._providers[provider.id] = provider

    def on(
        self,
        point: str,
        handler: HookHandler,
        order: Order = "normal",
        *,
        in_process_only: bool = False,
    ) -> None:
        if order not in {"first", "normal", "last"}:
            raise AgentError(ErrorCode.INVALID_COMPOSITION, f"Invalid hook order: {order}")
        self._hooks.append(
            _Hook(point, handler, order, in_process_only or point == "session.prepare")
        )

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
        self._commands[name] = _Command(name, description, handler, uses_model or in_process_only)


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


async def _handle_hook(hook: _Hook, payload: JsonObject) -> JsonObject | None:
    reply = hook.handler(payload)
    if inspect.isawaitable(reply):
        reply = await reply
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
    finally:
        context._active = False


_SUPPORTED_HOOKS = {
    "input",
    "plugin.load",
    "step.before",
    "model.failed",
    "turn.result",
    "provider.request",
    "provider.response",
    "output",
    "session.prepare",
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
    "session.prepare",
    "session.start",
    "session.end",
    "turn.start",
    "turn.end",
    "provider.response",
}
