"""Composition and lifecycle for an embedded agent."""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Coroutine, Generator, Sequence
from pathlib import Path
from tempfile import TemporaryDirectory
from types import TracebackType
from typing import Any, Self, cast

from ma_acp import ACP
from ma_acp.binding import declaration as _declaration
from ma_approval import Approval as _Approval
from ma_context import Context
from ma_core.wire import model_out, settings_in
from ma_durable import Durable
from ma_harness import Harness
from ma_history import History
from ma_history.http import HTTPHistory
from ma_plugin.host import load_plugins
from ma_questions import Questions
from ma_runtime import Runtime
from ma_selection import Selection

from ._history import HistoryStore
from ._native import (
    _ConfinedLocal,
    _LocalPlugin,
    _MemoryHistory,
    _SdkTools,
    _error,
    _question,
    _reply,
)
from ._plugin import Plugin, ProcessPlugin, _SUPPORTED_HOOKS
from ._provider import ModelInfo, Provider, _ProviderAdapter
from ._session import Session, _events
from ._tool import Tool
from ._types import (
    AgentError,
    Answer,
    Approval,
    Durability,
    ErrorCode,
    JsonObject,
    ModelRef,
    QuestionHandler,
)


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


class _Questions(Questions):  # type: ignore[misc]  # Untyped base adapter.
    async def definitions(self, d: JsonObject) -> list[JsonObject]:
        return []


class _SdkRuntime(Runtime):  # type: ignore[misc]  # Untyped base adapter.
    async def _safe_to_repeat(self, sid: str, definition: JsonObject | None) -> bool:
        # Containment of environment commands does not prove cleanup of a
        # plugin's effects. This composition offers no separate repeat promise.
        return False


class _SdkDurable(Durable):  # type: ignore[misc]  # Untyped base adapter.
    async def _safe_to_repeat(self, sid: str, definition: JsonObject | None) -> bool:
        return False

    async def recover(self, data: dict[str, Any], emit: Any) -> Any:
        sid = data["session"]
        for queued in await self._pending(sid):
            await self._return(sid, queued)
        return await super().recover(data, emit)


class _Interface(ACP):  # type: ignore[misc]  # Untyped base adapter.
    def __init__(self, agent: Agent) -> None:
        super().__init__(agent._project, agent._settings, actor="user")
        self._agent = agent

    async def declaration(self, sid: str | None = None) -> JsonObject:
        return {**self._agent.declaration(), "plugins": self._agent._h.declarations()}


class Agent:
    def __init__(
        self,
        harness: Any,
        project: Path,
        settings: JsonObject,
        handler: QuestionHandler | None,
        scratch: TemporaryDirectory[str],
    ) -> None:
        self._h = harness
        self._api = harness.api()
        self._project = project
        self._settings = settings
        self._handler = handler
        self._handlers: dict[str, QuestionHandler | None] = {}
        self._scratch = scratch
        self._test_project: TemporaryDirectory[str] | None = None
        self._sessions: dict[str, Session] = {}
        self._question_tasks: dict[tuple[str, str], asyncio.Task[None]] = {}
        self._lock = asyncio.Lock()
        self._closed = False
        self._plugin_host = False

    async def _session(self, operation: str, **data: Any) -> Any:
        if self._closed:
            raise AgentError(ErrorCode.NOT_OPEN, "Agent is closed")
        try:
            return await self._api.session(operation, **data)
        except Exception as exc:
            raise _error(exc) from exc

    async def _call(self, target: str, operation: str, **data: Any) -> Any:
        if self._closed:
            raise AgentError(ErrorCode.NOT_OPEN, "Agent is closed")
        try:
            return await self._api.call(target, operation, data)
        except Exception as exc:
            raise _error(exc) from exc

    def _attach(self, sid: str) -> Session:
        if sid not in self._sessions:
            self._sessions[sid] = Session(self, sid)
        return self._sessions[sid]

    def _detached(self, sid: str) -> None:
        self._sessions.pop(sid, None)
        self._handlers.pop(sid, None)
        for key, task in self._question_tasks.items():
            if key[0] == sid and task is not asyncio.current_task():
                task.cancel()

    async def _present(self, d: dict[str, Any]) -> None:
        sid = d["session"]
        if self._handlers.get(sid, self._handler) is not None:
            await self._call("questions", "connect", session=sid, actor="user")

    async def _set_handler(self, sid: str, handler: QuestionHandler | None) -> None:
        self._handlers[sid] = handler
        await self._call(
            "questions", "connect" if handler else "disconnect", session=sid, actor="user"
        )

    async def _answer(self, sid: str, question_id: str, answer: Answer) -> None:
        value = (
            "allow"
            if answer.kind == "allow"
            else answer.value
            if answer.kind == "value"
            else "declined"
        )
        await self._call(
            "questions",
            "answer",
            session=sid,
            actor="user",
            request=question_id,
            value=value,
            reason=answer.reason,
        )

    async def _event(self, d: dict[str, Any]) -> None:
        sid = d.get("session")
        if sid is None:
            return
        if (session := self._sessions.get(sid)) is not None:
            session._changed.set()
            if session._streams:
                for event in _events(d):
                    for stream in session._streams:
                        stream.push(event)
        if (
            d["kind"] == "input_request_opened"
            and (handler := self._handlers.get(sid, self._handler)) is not None
        ):
            q = _question(sid, d["request"])
            key = (sid, q.id)
            if key in self._question_tasks:
                return

            async def answer() -> None:
                try:
                    reply = await _reply(handler, q)
                    try:
                        await self._answer(sid, q.id, reply)
                    except AgentError:
                        if reply.kind != "decline":
                            await self._answer(sid, q.id, Answer("decline"))
                except AgentError:
                    pass  # The question may already have closed.
                finally:
                    self._question_tasks.pop(key, None)

            self._question_tasks[key] = asyncio.create_task(answer())

    async def session(self, *, settings: JsonObject | None = None) -> Session:
        async with self._lock:
            defaults = {**self._settings, **settings_in(settings or {})}
            data = await self._session("create", project=str(self._project), settings=defaults)
            # Persist empty sessions too; lazy setup writes the actor and settings with this entry.
            await self._session(
                "append",
                session=data["id"],
                kind="plugins",
                writer="@harness",
                data={"active": self._h.active_plugins()},
            )
            return self._attach(data["id"])

    async def open_session(self, id: str) -> Session:
        if not id or not id.isalnum():
            raise AgentError(ErrorCode.INVALID_PARAMS, "Invalid session id")
        async with self._lock:
            if (
                id not in self._h.sessions
                and await self._call("history", "read", session=id) is None
            ):
                raise AgentError(ErrorCode.NOT_FOUND, "Unknown session")
            await self._session("open", session=id, actor="user")
            await self._call("runtime", "wait", session=id)
            return self._attach(id)

    async def sessions(self) -> list[JsonObject]:
        return cast(list[JsonObject], await self._session("list"))

    async def models(self) -> list[ModelInfo]:
        catalog = await self._call("selection", "catalog")
        return [
            cast(
                ModelInfo,
                {
                    k: v
                    for k, v in model_out(row, row["target"]).items()
                    if k
                    in {
                        "provider",
                        "id",
                        "contextWindow",
                        "maxOutput",
                        "input",
                        "reasoning",
                        "thinking",
                    }
                },
            )
            for row in catalog
        ]

    def declaration(self) -> JsonObject:
        if self._closed:
            raise AgentError(ErrorCode.NOT_OPEN, "Agent is closed")
        value = _declaration(self._h.declarations())
        environment_owner, environment = self._h.capabilities["environment"]
        local = isinstance(environment, _ConfinedLocal)
        remote_environment = getattr(self._h.plugins[environment_owner], "registration", {}).get(
            "workingEnvironment", {}
        )
        value.pop("plugins", None)
        value.update(
            waitingThroughRestart=False,
            mixedActorInput="refused",
            severalActors=False,
            sessionLimits=False,
            tenants=False,
            questionsOutlastTurns=False,
            lateAnswersStartTurns=False,
            nestedToolCalls=False,
            erasure=not isinstance(self._h.capabilities["history"][1], _MemoryHistory),
            portableSessions=not isinstance(self._h.capabilities["history"][1], _MemoryHistory),
            settingsDuringTurn="refused",
            confinesFiles=local or bool(remote_environment.get("confinesFiles")),
            queuedInputAfterRestart="handedBack",
            startsTurnsUnasked="never",
        )
        return cast(JsonObject, value)

    async def serve_acp(self) -> None:
        """Drive this agent over ACP on stdin/stdout until the client disconnects."""
        if self._closed:
            raise AgentError(ErrorCode.NOT_OPEN, "Agent is closed")
        if not self._plugin_host:
            raise AgentError(ErrorCode.INVALID_COMPOSITION, "ACP requires plugin_host=True")
        if self._handler is not None:
            raise AgentError(ErrorCode.INVALID_COMPOSITION, "ACP answers its own questions")
        async with self._lock:
            if self._h.sessions or "acp" in self._h.plugins:
                raise AgentError(ErrorCode.BUSY, "ACP must start before any sessions open")
            interface = _Interface(self)
            await self._h.load(interface)
        try:
            await interface.serve()
        finally:
            await self.close()

    async def close(self) -> None:
        async with self._lock:
            if self._closed:
                return
            failure: Exception | None = None
            try:
                for session in list(self._sessions.values()):
                    try:
                        await session.close()
                    except Exception as exc:
                        failure = failure or exc
                await self._h.stop()
            finally:
                self._closed = True
                tasks = list(self._question_tasks.values())
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                self._scratch.cleanup()
                if self._test_project is not None:
                    self._test_project.cleanup()
            if failure:
                raise failure

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self, typ: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        await self.close()


class AgentStart:
    """Lazy composition, awaitable once or usable as an async context manager."""

    def __init__(self, build: Coroutine[Any, Any, Agent]) -> None:
        self._build = build
        self._agent: Agent | None = None

    def __await__(self) -> Generator[Any, None, Agent]:
        return self._build.__await__()

    async def __aenter__(self) -> Agent:
        self._agent = await self
        return self._agent

    async def __aexit__(
        self, typ: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        if self._agent is not None:
            await self._agent.close()


def create_agent(
    *,
    project: str | os.PathLike[str] | None = None,
    data_dir: str | os.PathLike[str] | None = None,
    durability: Durability = "ephemeral",
    history: HistoryStore | None = None,
    providers: Sequence[Provider] = (),
    tools: Sequence[Tool] = (),
    plugins: Sequence[Plugin] = (),
    process_plugins: Sequence[ProcessPlugin | JsonObject] | None = None,
    plugin_host: bool | None = None,
    model: str | ModelRef | None = None,
    settings: JsonObject | None = None,
    approval: Approval | None = None,
    on_question: QuestionHandler | None = None,
) -> AgentStart:
    async def build() -> Agent:
        if durability not in {"ephemeral", "kept", "durable"} or approval not in {
            None,
            "off",
            "ask",
            "all",
            "never",
        }:
            raise AgentError(ErrorCode.INVALID_PARAMS, "Invalid durability or approval policy")
        if durability != "ephemeral" and data_dir is None:
            raise AgentError(
                ErrorCode.INVALID_COMPOSITION, f"{durability} durability needs data_dir"
            )
        if history is not None and (history._kind == "memory") != (durability == "ephemeral"):
            raise AgentError(ErrorCode.INVALID_COMPOSITION, "History does not match durability")
        if plugin_host is False and process_plugins is not None:
            raise AgentError(
                ErrorCode.INVALID_COMPOSITION, "process_plugins requires a plugin host"
            )
        scratch = TemporaryDirectory(prefix="modular-agent-")
        h = Harness(process_plugins=())
        h.lazy_setup = True
        try:
            root = Path(data_dir).resolve() if data_dir is not None else Path(scratch.name)
            folder = Path(project or Path.cwd()).resolve(strict=True)
            if not folder.is_dir():
                raise ValueError("Project must be a directory")
            defaults = {"thinking": "off", **settings_in(settings or {})}
            if approval is not None:
                defaults.update(settings_in({"approval": approval}))
            agent = Agent(h, folder, defaults, on_question, scratch)
            agent._plugin_host = plugin_host is True or process_plugins is not None
            if history is not None and history._kind == "http":
                store = HTTPHistory(history._url, history._path)
            elif durability == "ephemeral":
                store = _MemoryHistory()
            else:
                store_root = history._path if history is not None else root
                if store_root is None:
                    raise ValueError("File history needs a directory")
                store_root.mkdir(parents=True, exist_ok=True, mode=0o700)
                store = History(store_root)
            await h.load(store)
            await h.load(_ConfinedLocal(Path(scratch.name) if durability == "ephemeral" else root))
            await h.load(_SdkTools())
            await h.load(_SdkDurable() if durability == "durable" else _SdkRuntime())
            await h.load(_Questions())
            h.on("embedding", "session.start", agent._present, "first")
            h.follow("embedding", "user", agent._event)
            for provider in providers:
                await h.load(_ProviderAdapter(provider))
            await h.load(Selection([p.id for p in providers]))
            await h.load(Context())
            if approval is not None:
                await h.load(_Approval())
            registered_tools: dict[str, _LocalPlugin] = {}
            for plugin in [*(Plugin(t.name, tools=[t]) for t in tools), *plugins]:
                if plugin.name in h.plugins:
                    raise AgentError(
                        ErrorCode.INVALID_COMPOSITION, f"Duplicate plugin: {plugin.name}"
                    )
                try:
                    registrar = await plugin._register(plugin.config)
                    for hook in registrar._hooks:
                        if hook.point not in _SUPPORTED_HOOKS:
                            raise AgentError(
                                ErrorCode.NOT_SUPPORTED, f"Unsupported hook: {hook.point}"
                            )
                    for tool_name in registrar._tools:
                        if (prior := registered_tools.get(tool_name)) is not None:
                            if f"tool:{tool_name}" not in plugin.replaces:
                                raise ValueError(f"Duplicate tool: {tool_name}")
                            del prior.registrar._tools[tool_name]
                    for name in registrar._commands:
                        if name in h.commands:
                            if f"command:{name}" not in plugin.replaces:
                                raise ValueError(f"Duplicate command: {name}")
                            del h.commands[name]
                except BaseException:
                    await plugin._close()
                    raise
                adapter = _LocalPlugin(plugin, registrar, folder)
                await h.load(adapter)
                registered_tools.update((name, adapter) for name in registrar._tools)
            if agent._plugin_host:
                specs = [
                    p._wire() if isinstance(p, ProcessPlugin) else p for p in process_plugins or ()
                ]
                env = json.loads(os.environ.get("MODULAR_AGENT_PLUGINS") or "[]")
                if not isinstance(env, list):
                    raise ValueError("MODULAR_AGENT_PLUGINS must be an array")
                if specs or env:
                    await load_plugins(h, [*specs, *env], folder, root)
            runtime_owner = h.capabilities["runtime"][0]
            if bool(h.plugins[runtime_owner].declarations.get("durable")) != (
                durability == "durable"
            ):
                raise ValueError("Runtime does not match the requested durability")
            models = await agent.models()
            choices = {f"{m['provider']}/{m['id']}" for m in models}
            selected = str(model) if model is not None else defaults.get("model")
            if selected is None and len(choices) == 1:
                selected = next(iter(choices))
            if selected is not None and (not isinstance(selected, str) or selected not in choices):
                raise AgentError(ErrorCode.INVALID_PARAMS, f"Unknown model: {selected}")
            if selected is not None:
                defaults["model"] = selected
            return agent
        except BaseException as exc:
            try:
                await h.stop()
            finally:
                scratch.cleanup()
            if isinstance(exc, AgentError) and exc.code in {
                ErrorCode.NOT_SUPPORTED,
                ErrorCode.INVALID_PARAMS,
                ErrorCode.INVALID_COMPOSITION,
            }:
                raise
            if isinstance(exc, Exception):
                raise AgentError(ErrorCode.INVALID_COMPOSITION, str(exc)) from exc
            raise

    return AgentStart(build())
