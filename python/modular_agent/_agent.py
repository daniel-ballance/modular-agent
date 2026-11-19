"""Composition and lifecycle for an embedded agent."""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Awaitable, Callable, Coroutine, Generator, Sequence
from pathlib import Path
from tempfile import TemporaryDirectory
from types import TracebackType
from typing import Any, Self, cast

from jsonschema import Draft202012Validator
from referencing import Registry

from ma_acp import ACP
from ma_acp.binding import declaration as _declaration
from ma_approval import Approval as _Approval
from ma_context import Context
from ma_core import plain
from ma_core.wire import model_out, settings_in, settings_out
from ma_durable import Durable
from ma_harness import Harness
from ma_history import History
from ma_history.http import HTTPHistory
from ma_local import Local, ProcessGroupLocal
from ma_local.containment import delegated_root
from ma_fake.conformance import Echo, Nest
from ma_commands import Commands
from ma_mcp import MCP
from ma_plugin.host import External, load_plugins
from ma_questions import Questions
from ma_runtime import Runtime
from ma_selection import Selection

from ._environment import MemoryEnvironment
from ._history import HistoryStore
from ._native import (
    _LocalPlugin,
    _MemoryHistory,
    _SdkTools,
    _error,
    _question,
    _reply,
)
from ._plugin import Plugin, ProcessPlugin, _SUPPORTED_HOOKS
from ._provider import ModelInfo, Provider, _ProviderAdapter
from ._serve import _MemoryExternal, _OverWire
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


async def _structured_result(d: dict[str, Any]) -> JsonObject | None:
    if (schema := d.get("result_schema")) is None:
        return None
    try:

        def reject_constant(value: str) -> None:
            raise ValueError(f"Invalid JSON constant: {value}")

        value = json.loads(plain(d["result"]), parse_constant=reject_constant)
        json.dumps(value, allow_nan=False)
        error = next(Draft202012Validator(schema, registry=Registry()).iter_errors(value), None)
        if error is not None:
            return {
                "retry": True,
                "reason": f"Structured result does not match the schema: {error.message}",
            }
    except Exception as exc:
        return {
            "retry": True,
            "reason": f"Expected one JSON value matching the result schema: {exc}",
        }
    return {"value": value}


class _Questions(Questions):  # type: ignore[misc]  # Untyped base adapter.
    async def definitions(self, d: JsonObject) -> list[JsonObject]:
        return []


class _SdkRuntime(Runtime):  # type: ignore[misc]  # Untyped base adapter.
    async def _safe_to_repeat(self, sid: str, definition: JsonObject | None) -> bool:
        # Containment of environment commands does not prove cleanup of a
        # plugin's effects. This composition offers no separate repeat promise.
        return False


class _SdkDurable(Durable):  # type: ignore[misc]  # Untyped base adapter.
    declarations = {**Durable.declarations, "queued_input_after_restart": "handedBack"}

    async def _safe_to_repeat(self, sid: str, definition: JsonObject | None) -> bool:
        return False

    async def recover(self, data: dict[str, Any], emit: Any) -> Any:
        sid = data["session"]
        for queued in await self._pending(sid):
            await self._return(sid, queued)
        return await super().recover(data, emit)


class _Interface(ACP):  # type: ignore[misc]  # Untyped base adapter.
    def __init__(self, agent: Agent) -> None:
        super().__init__(
            agent._project, agent._settings, actor=os.environ.get("MODULAR_AGENT_ACTOR", "user")
        )
        self._agent = agent

    def new_session_settings(self, project: str) -> JsonObject:
        resolver = self._agent._project_settings
        if resolver is not None:
            return cast(JsonObject, settings_in(resolver(Path(project))))
        return self._agent._settings

    async def declaration(self, sid: str | None = None) -> JsonObject:
        if self._agent._conformance:
            return cast(JsonObject, await super().declaration(sid))
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
        self._conformance = False
        self._project_settings: Callable[[Path], JsonObject] | None = None
        self._restart: Callable[[], Awaitable[Agent]] | None = None
        self._memory_store: _MemoryHistory | None = None

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

    async def session_info(self, id: str) -> JsonObject:
        """Read saved local session settings without starting recovery or taking its lease."""
        if not id or not id.isalnum():
            raise AgentError(ErrorCode.INVALID_PARAMS, "Invalid session id")
        state = await self._call("history", "read", session=id)
        if state is None:
            raise AgentError(ErrorCode.NOT_FOUND, "Unknown session")
        return {
            "id": id,
            "project": state["project"],
            "settings": settings_out(state["settings"]),
        }

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
        parts = self._h.declarations()
        value = _declaration(parts)
        runtime = parts[self._h.capabilities["runtime"][0]]
        environment = parts[self._h.capabilities["environment"][0]]
        store = parts[self._h.capabilities["history"][0]]
        value.pop("plugins", None)
        value.update(
            waitingThroughRestart=False,
            mixedActorInput="refused",
            severalActors=False,
            sessionLimits=False,
            tenants=False,
            questionsOutlastTurns=False,
            lateAnswersStartTurns=False,
            erasure=bool(store.get("erasure")),
            portableSessions=store.get("retention") != "process",
            settingsDuringTurn="refused",
            confinesFiles=bool(environment.get("confines_files")),
            commandContainment=environment.get("containment", "none"),
            nestedToolCalls=bool(runtime.get("nested_tools")),
            queuedInputAfterRestart=runtime.get("queued_input_after_restart", "handedBack"),
            startsTurnsUnasked="never",
        )
        queued_jobs = runtime.get(
            "queued_job_reports_after_restart", value["queuedInputAfterRestart"]
        )
        if queued_jobs != value["queuedInputAfterRestart"]:
            value["queuedJobReportsAfterRestart"] = queued_jobs
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

    async def _interrupt_and_restart(self) -> Agent:
        async with self._lock:
            if self._closed:
                raise AgentError(ErrorCode.NOT_OPEN, "Agent is closed")
            if self._restart is None or "acp" in self._h.plugins:
                raise AgentError(
                    ErrorCode.NOT_SUPPORTED, "Restart simulation requires in-process plugins"
                )
            self._closed = True
            sessions = list(self._h.sessions)
            for sid in sessions:
                self._h.sessions[sid]["suspending"] = True
                await self._h.fire("@harness", "session.suspend", {"session": sid})
            tasks = list(self._question_tasks.values())
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            for sid in sessions:
                await self._api.call("history", "close", {"session": sid})
                self._h.sessions.pop(sid)
                if session := self._sessions.pop(sid, None):
                    session._closed = True
                    session._changed.set()
            rebuilt = await self._restart()
            rebuilt._test_project, self._test_project = self._test_project, None
            self._scratch.cleanup()
            return rebuilt

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
    environment: MemoryEnvironment | None = None,
    providers: Sequence[Provider] = (),
    tools: Sequence[Tool] = (),
    plugins: Sequence[Plugin] = (),
    process_plugins: Sequence[ProcessPlugin | JsonObject] | None = None,
    plugin_host: bool | None = None,
    model: str | ModelRef | None = None,
    settings: JsonObject | None = None,
    approval: Approval | None = None,
    on_question: QuestionHandler | None = None,
    local_process_groups: bool = False,
    mcp_servers: Sequence[JsonObject] = (),
    project_mcp: Callable[[Path], Sequence[JsonObject]] | None = None,
    project_settings: Callable[[Path], JsonObject] | None = None,
    commands: bool = False,
    conformance: bool = False,
) -> AgentStart:
    async def build() -> Agent:
        return await build_with_store()

    async def build_with_store(memory_store: _MemoryHistory | None = None) -> Agent:
        if durability not in {"ephemeral", "kept", "durable"} or approval not in {
            None,
            "off",
            "ask",
            "all",
            "never",
        }:
            raise AgentError(ErrorCode.INVALID_PARAMS, "Invalid durability or approval policy")
        if data_dir is None and durability != "ephemeral":
            if history is None:
                raise AgentError(
                    ErrorCode.INVALID_COMPOSITION, "Kept history needs a persistent store"
                )
            if environment is None:
                raise AgentError(
                    ErrorCode.INVALID_COMPOSITION, "Local environment recovery needs data_dir"
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
                store = agent._memory_store = memory_store or _MemoryHistory()
            else:
                store_root = history._path if history is not None else root
                if store_root is None:
                    raise ValueError("File history needs a directory")
                store_root.mkdir(parents=True, exist_ok=True, mode=0o700)
                store = History(store_root)
            await h.load(store)
            local = Local(root)
            if environment is None and local_process_groups:
                try:
                    delegated_root()
                except Exception:
                    local = ProcessGroupLocal(root)
            await h.load(environment or local)
            dispatcher = _SdkTools()
            dispatcher.conformance = conformance
            await h.load(dispatcher)
            agent._conformance = conformance
            agent._project_settings = project_settings
            await h.load(_SdkDurable() if durability == "durable" else _SdkRuntime())
            h.on("embedding", "result.ready", _structured_result, "last")
            if conformance:
                await h.load(Echo())
                await h.load(Nest())
            await h.load(Questions() if conformance else _Questions())
            h.on("embedding", "session.start", agent._present, "first")
            h.follow("embedding", "user", agent._event)
            for provider in providers:
                await h.load(_ProviderAdapter(provider))
            await h.load(
                Selection([p.id for p in providers] + (["conformance"] if conformance else []))
            )
            await h.load(Context())
            if commands:
                await h.load(Commands())
            if mcp_servers or project_mcp is not None or conformance:
                await h.load(MCP(mcp_servers, standard_names=True, project_servers=project_mcp))
            if approval is not None or conformance:
                await h.load(_Approval())
            registered_tools: dict[str, _LocalPlugin] = {}
            for plugin in [
                *(Plugin(t.name, tools=[t]) for t in tools),
                *(p for p in plugins if not isinstance(p, _OverWire)),
            ]:
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
            specs: list[dict[str, Any]] = [
                {"command": [p.name], "config": p.config, "_over_wire": p.original}
                for p in plugins
                if isinstance(p, _OverWire)
            ]
            if agent._plugin_host:
                processes = [
                    p._wire() if isinstance(p, ProcessPlugin) else p for p in process_plugins or ()
                ]
                env = json.loads(os.environ.get("MODULAR_AGENT_PLUGINS") or "[]")
                if not isinstance(env, list):
                    raise ValueError("MODULAR_AGENT_PLUGINS must be an array")
                specs.extend([*processes, *env])
            if specs:

                def factory(
                    harness: Any, spec: dict[str, Any], project: Path, home: Path, index: int
                ) -> Any:
                    kind = (
                        _MemoryExternal if isinstance(spec.get("_over_wire"), Plugin) else External
                    )
                    return kind(harness, spec, project, home, index)

                await load_plugins(h, specs, folder, root, external_factory=factory)
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
            if not specs and not agent._plugin_host:
                agent._restart = lambda: build_with_store(agent._memory_store)
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
