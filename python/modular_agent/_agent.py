"""Composition and lifecycle for an embedded agent."""

from __future__ import annotations

import asyncio
import json
import math
import os
from collections.abc import Awaitable, Callable, Coroutine, Generator, Mapping, Sequence
from contextvars import ContextVar, Token
from copy import deepcopy
from dataclasses import dataclass
from os import PathLike
from pathlib import Path
from tempfile import TemporaryDirectory
from types import TracebackType
from typing import Any, NotRequired, Self, TypedDict, cast, overload
from uuid import uuid4

from jsonschema import Draft202012Validator
from referencing import Registry

from ma_acp import ACP, OUTPUT_SESSION, protocol_error
from ma_core import Plugin as _NativePlugin
from ma_acp.binding import declaration as _declaration
from ma_approval import Approval as _Approval
from ma_core import plain
from ma_core.wire import model_out, settings_in, settings_out
from ma_durable import Durable
from ma_harness import Harness
from ma_harness.authority import CONNECTION_AUTHORITY, PERMISSIONS
from ma_history import History
from ma_history.http import HTTPHistory
from ma_jobs import Jobs
from ma_local import Local, ProcessGroupLocal
from ma_local.containment import delegated_root
from ma_fake.conformance import Echo, Nest
from ma_commands import Commands
from ma_mcp import MCP
from ma_plugin.host import External, configure_binding_hooks, load_plugins, wrap_native_providers
from ma_plugin.websocket import (
    ACP_PROTOCOL,
    WebSocketFrames,
    WebSocketServer,
    WebSocketTLS,
    listen_websocket,
)
from ma_questions import Questions
from ma_runtime import Runtime
from ma_selection import Selection

from .compaction import _CompactionPlugin
from .mcp import _McpPlugin
from ._credentials import CredentialStore, _CredentialAdapter, environment_credentials
from ._environment import LocalEnvironment, MemoryEnvironment
from ._history import HistoryStore
from ._history_port import HistoryPort, _PortHistory
from ._runtime_port import _LocalRuntime
from ._native import (
    _LocalPlugin,
    _MemoryHistory,
    _SdkTools,
    _error,
    _question,
    _reply,
)
from ._plugin import Plugin, ProcessPlugin, ServicePlugin, _SUPPORTED_HOOKS
from ._parts import Interface, _Configuration, _InterfacePart
from ._provider import ModelInfo, Provider, _ProviderAdapter
from ._serve import _MemoryExternal, _OverWire
from ._session import Session, _events
from ._tool import Tool
from ._working import _WorkingPart
from ._types import (
    Actor,
    AgentError,
    Answer,
    Approval,
    Durability,
    ErrorCode,
    JsonObject,
    ModelRef,
    QuestionHandler,
    Tenant,
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


@dataclass(frozen=True)
class RuntimeChoice:
    continues_after_restart: bool


def transient_runtime() -> RuntimeChoice:
    """Choose the SDK Runtime that does not resume interrupted turns."""
    return RuntimeChoice(False)


def durable_runtime() -> RuntimeChoice:
    """Choose the SDK Runtime that resumes interrupted turns with persistent history."""
    return RuntimeChoice(True)


class _SdkRuntime(Runtime):  # type: ignore[misc]  # Untyped base adapter.
    def __init__(self, job_reports_start_turns: bool) -> None:
        super().__init__()
        self.declarations = dict(Runtime.declarations)
        if job_reports_start_turns:
            self.declarations["queued_job_reports_after_restart"] = "run"

    async def _safe_to_repeat(self, sid: str, definition: JsonObject | None) -> bool:
        # Containment of environment commands does not prove cleanup of a
        # plugin's effects. This composition offers no separate repeat promise.
        return False


class _SdkDurable(Durable):  # type: ignore[misc]  # Untyped base adapter.
    def __init__(self, job_reports_start_turns: bool) -> None:
        super().__init__()
        self.declarations = {**Durable.declarations, "queued_input_after_restart": "handedBack"}
        if job_reports_start_turns:
            self.declarations["queued_job_reports_after_restart"] = "run"

    async def _safe_to_repeat(self, sid: str, definition: JsonObject | None) -> bool:
        return False

    async def recover(self, data: dict[str, Any], emit: Any) -> Any:
        sid = data["session"]
        for queued in await self._restart_pending(data):
            if not (
                self.declarations.get("queued_job_reports_after_restart") == "run"
                and (queued["data"].get("source") or {}).get("job")
            ):
                await self._return(sid, queued)
        return await super().recover(data, emit)


class AcpActor(TypedDict):
    token_file: str | PathLike[str]
    actor: Actor
    tenants: NotRequired[Sequence[str | None]]
    projects: NotRequired[Sequence[str | PathLike[str]]]


class _AcpProject(_NativePlugin):  # type: ignore[misc]  # Untyped base adapter.
    name = "acp"
    role = "interface"

    def __init__(self, agent: Agent, interface: _Interface) -> None:
        self.agent = agent
        self.interface = interface
        self.name = interface.name

    async def start(self, api: Any) -> None:
        await super().start(api)
        self.interface.register_project(self.agent, api)


class _AcpConnections:
    """One writer per session, with independent views on that writer."""

    def __init__(self) -> None:
        self.busy: dict[str, tuple[asyncio.Task[Any] | None, asyncio.Event]] = {}
        self.sessions: dict[str, dict[_Interface, Agent]] = {}
        self.projects: dict[Agent, set[_Interface]] = {}

    def composition(self, sid: str) -> Agent | None:
        return next(iter(self.sessions.get(sid, {}).values()), None)


class _Interface(ACP):  # type: ignore[misc]  # Untyped base adapter.
    def __init__(
        self,
        agent: Agent,
        compose: Callable[[Path], Awaitable[Agent]] | None,
        compose_reopen: Callable[[Path, str], Awaitable[Agent]] | None,
        project_settings: Callable[[Path], JsonObject] | None,
        project_mcp: Callable[[Path], Sequence[JsonObject]] | None,
        *,
        principal: AcpActor | None = None,
        connections: _AcpConnections | None = None,
    ) -> None:
        actor = (
            principal["actor"]["id"] if principal else os.environ.get("MODULAR_AGENT_ACTOR", "user")
        )
        super().__init__(agent._project, agent._settings, actor=actor)
        self.network = principal is not None
        self._allowed_projects: set[Path] | None = None
        self._allowed_tenants: set[str | None] = {None}
        self._connections = connections
        self._token_rights: set[str] = set()
        self._connection_grants: dict[str, set[str]] = {}
        if principal is not None:
            self.name = "acp:" + uuid4().hex
            self.principal = principal["actor"]
            self._token_rights = set(self.principal["rights"])
            if "projects" in principal:
                self._allowed_projects = {Path(p).resolve() for p in principal["projects"]}
            self._allowed_tenants = set(principal.get("tenants", [None]))
        self._agent = agent
        self._compose = compose
        self._compose_reopen = compose_reopen
        self._project_settings = project_settings
        self._project_mcp = project_mcp
        self.declarations = {**ACP.declarations, "one_project_per_process": compose is None}
        if self.network:
            self.declarations.update(transport="websocket", authentication="bearer token")
        self._scope: ContextVar[Agent | None] = ContextVar("acp_project", default=None)
        self._agents: dict[str, Agent] = {}
        self._apis: dict[Agent, Any] = {}

    @property
    def api(self) -> Any:
        return self._apis[self._current()]

    @api.setter
    def api(self, api: Any) -> None:
        self._apis[self._agent] = api

    def _current(self) -> Agent:
        return self._scope.get() or self._agents.get(OUTPUT_SESSION.get() or "", self._agent)

    def _authority_scope(self) -> Any:
        return CONNECTION_AUTHORITY.set(
            (self.actor, self._token_rights, self._connection_grants) if self.network else None
        )

    def project_scope(self) -> tuple[Token[Agent | None], Any]:
        return self._scope.set(None), self._authority_scope()

    def reset_project_scope(self, token: tuple[Token[Agent | None], Any]) -> None:
        self._scope.reset(token[0])
        CONNECTION_AUTHORITY.reset(token[1])

    def register_project(self, agent: Agent, api: Any) -> None:
        self._apis[agent] = api

        def scoped(handler: Callable[[Any], Awaitable[Any]]) -> Callable[[Any], Awaitable[Any]]:
            async def run(payload: Any) -> Any:
                sid = payload.get("session")
                if self.network and self._scope.get() is not agent and sid not in self._agents:
                    return None
                token = self._scope.set(agent), self._authority_scope()
                try:
                    return await handler(payload)
                finally:
                    self.reset_project_scope(token)

            return run

        api.follow(self.actor, scoped(self.event))
        api.on("session.start", scoped(self.session_started), "last")
        api.on("session.end", scoped(self.session_ended), "last")
        api.on("session.suspend", scoped(self.session_ended), "last")
        api.on("session.invalidate", scoped(self.invalidate))

    async def start(self, api: Any) -> None:
        self.register_project(self._agent, api)
        if not self.network:
            api.provide("acp", self)

    def _project_allowed(self, folder: Path) -> bool:
        return self._allowed_projects is None or folder in self._allowed_projects

    def cwd(self, cwd: str, additional_directories: Any = None, **kwargs: Any) -> str:
        project = cast(str, super().cwd(cwd, additional_directories, **kwargs))
        if not self._project_allowed(Path(project)):
            raise protocol_error("forbidden", "Project outside connection scope")
        return project

    def tenant_allowed(self, tenant: Any) -> bool:
        return not self.network or (
            (tenant is None or isinstance(tenant, str)) and tenant in self._allowed_tenants
        )

    def session_create_rights(self, tenant: str | None, has_mcp: bool) -> list[str]:
        if not self.network:
            return cast(list[str], super().session_create_rights(tenant, has_mcp))
        harness = self._current()._h
        rights = set(self.principal["rights"]) & harness.admin & harness.tenant
        if tenant is not None:
            rights &= set(harness.tenant_config(tenant)["rights"])
        if not ({"input", "tools"} if has_mcp else {"input"}) <= rights:
            raise protocol_error("forbidden", "Actor cannot create this session")
        return sorted(rights)

    async def visible_sessions(self, project: str | None) -> list[dict[str, Any]]:
        rows = cast(list[dict[str, Any]], await super().visible_sessions(project))
        if not self.network:
            return rows
        agent = self._current()
        visible = []
        for row in rows:
            if not self._project_allowed(Path(row["project"])):
                continue
            if self._compose is None and Path(row["project"]) != self._agent._project:
                continue
            owner = self._connections.composition(row["id"]) if self._connections else None
            session = (owner or agent)._h.sessions.get(row["id"])
            if session is None:
                session = await agent._api.call("history", "read", {"session": row["id"]})
            if (
                session is not None
                and self.tenant_allowed(session.get("tenant"))
                and "watch" in agent._h.permissions(session, self.actor)
            ):
                visible.append(row)
        return visible

    async def require_visible_session(self, project: str, sid: str) -> None:
        await super().require_visible_session(project, sid)
        self._claim(sid)
        if self.network and sid not in self._connection_grants:
            owner = self._connections.composition(sid) if self._connections else None
            session = (owner or self._agent)._h.sessions.get(sid)
            if session is None:
                session = await self._agent._api.call("history", "read", {"session": sid})
            if session is not None:
                grant = session.get("actors", {}).get(self.actor)
                self._connection_grants[sid] = self._token_rights & set(
                    grant["authority"] if grant else ()
                )

    async def _open(
        self,
        cwd: str,
        sid: str,
        mcp_servers: Any,
        replay: bool,
        additional_directories: Any,
        kwargs: Any,
    ) -> Any:
        try:
            response = await super()._open(
                cwd, sid, mcp_servers, replay, additional_directories, kwargs
            )
            if self.network:
                self._bind(sid)
            return response
        finally:
            self._release_claim(sid)

    def _claim(self, sid: str) -> None:
        if self._connections is not None:
            if sid in self._connections.busy:
                raise protocol_error("busy", "Session lifecycle operation in progress")
            self._connections.busy[sid] = (asyncio.current_task(), asyncio.Event())

    def _release_claim(self, sid: str) -> None:
        if self._connections is not None:
            claim = self._connections.busy.get(sid)
            if claim is not None and claim[0] is asyncio.current_task():
                del self._connections.busy[sid]
                claim[1].set()

    async def select_project(self, project: str, session_id: str | None = None) -> None:
        folder = Path(project)
        selected = self._agents.get(session_id or "")
        if selected is None and session_id is not None and self._connections is not None:
            selected = self._connections.composition(session_id)
        if selected is None:
            if self._compose_reopen is not None and session_id is not None:
                selected = await self._compose_reopen(folder, session_id)
            else:
                selected = await self._compose(folder) if self._compose else self._agent
        if selected._project != folder:
            if selected is not self._agent and selected not in self._apis:
                await selected.close()
            raise ValueError("Session is not in this project")
        if selected not in self._apis:
            clients = None
            if self._connections is not None:
                clients = self._connections.projects.setdefault(selected, set())
            first = not clients
            if clients is not None:
                clients.add(self)
            try:
                if first:
                    await selected._install_acp_mcp(self._project_mcp)
                if self.network:
                    await selected._h.attach_interface(_AcpProject(selected, self))
                else:
                    await selected._h.load(_AcpProject(selected, self))
            except BaseException:
                if clients is not None:
                    clients.discard(self)
                if first:
                    if self._connections is not None:
                        self._connections.projects.pop(selected, None)
                    await selected.close()
                raise
        self._scope.set(selected)

    async def session_started(self, payload: JsonObject) -> None:
        sid = cast(str, payload["session"])
        self._bind(sid)
        if sid == self.opening:
            await self.api.call("questions", "connect", {"session": sid, "actor": self.actor})
        await super().session_started(payload)

    def _bind(self, sid: str) -> None:
        agent = self._current()
        self._agents[sid] = agent
        if self._connections is not None:
            self._connections.sessions.setdefault(sid, {})[self] = agent

    def _unbind(self, sid: str) -> None:
        self._agents.pop(sid, None)
        if self._connections is not None:
            refs = self._connections.sessions.get(sid, {})
            refs.pop(self, None)
            if not refs:
                self._connections.sessions.pop(sid, None)

    async def session_ended(self, payload: JsonObject) -> None:
        sid = cast(str, payload["session"])
        if self.network and sid not in self._agents:
            return
        try:
            await super().session_ended(payload)
        finally:
            if self.network:
                self._unbind(sid)

    async def close_session(self, session_id: str, **kwargs: Any) -> Any:
        if session_id not in self.sessions:
            return await super().close_session(session_id, **kwargs)
        self._claim(session_id)
        try:
            return await super().close_session(session_id, **kwargs)
        finally:
            self._release_claim(session_id)

    async def close_connection(self) -> None:
        self.client = None
        connections = self._connections
        assert connections is not None
        try:
            await self._cancel_requests()
            for sid, agent in list(self._agents.items()):
                while claim := connections.busy.get(sid):
                    await claim[1].wait()
                self._claim(sid)
                try:
                    refs = connections.sessions.get(sid, {})
                    if sid in agent._h.sessions and not any(
                        peer.actor == self.actor for peer in refs if peer is not self
                    ):
                        await self._apis[agent].call(
                            "questions", "disconnect", {"session": sid, "actor": self.actor}
                        )
                    self._unbind(sid)
                    self.sessions.discard(sid)
                    if sid not in connections.sessions and sid in agent._h.sessions:
                        await agent._h.suspend_session(sid)
                finally:
                    self._release_claim(sid)
        finally:
            try:
                await self.close_projects()
            finally:
                if self.name in self._agent._h.plugins:
                    await self._agent._h.unload(self.name)

    def new_session_settings(self, project: str) -> JsonObject:
        defaults = self._current()._settings
        if self._project_settings is not None:
            return {**defaults, **settings_in(self._project_settings(Path(project)))}
        return defaults

    async def declaration(self, sid: str | None = None) -> JsonObject:
        agent = self._current()
        value = agent.declaration()
        if sid:
            selected = await super().declaration(sid)
            for key in ("keepsStateAtProvider", "runsToolsAtProvider", "liveSessions", "rewinding"):
                value[key] = selected[key]
            return {**value, "plugins": selected["plugins"]}
        return {**value, "plugins": agent._h.declarations(str(agent._project))}

    async def close_projects(self) -> None:
        for agent in reversed(list(self._apis)):
            if agent is self._agent:
                continue
            if self._connections is not None:
                clients = self._connections.projects[agent]
                if self.name in agent._h.plugins:
                    await agent._h.unload(self.name)
                clients.discard(self)
                if clients:
                    continue
                del self._connections.projects[agent]
            await agent.close()


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
        self._enable_plugin_host: Callable[[], Awaitable[None]] | None = None
        self._acp_server: WebSocketServer | None = None
        self._conformance = False
        self._late_answers = False
        self._several_actors = False
        self._session_limits = False
        self._tenants = False
        self._credentials: CredentialStore = environment_credentials()
        self._restart: Callable[[], Awaitable[Agent]] | None = None
        self._memory_store: _MemoryHistory | None = None

    async def _session(self, operation: str, **data: Any) -> Any:
        if self._closed:
            raise AgentError(ErrorCode.NOT_OPEN, "Agent is closed")
        try:
            if "actor" in data and operation != "append":
                await self._h.authorize("@harness", operation, data)
            return await self._api.session(operation, **data)
        except Exception as exc:
            raise _error(exc) from exc

    async def _call(self, target: str, operation: str, **data: Any) -> Any:
        if self._closed:
            raise AgentError(ErrorCode.NOT_OPEN, "Agent is closed")
        try:
            if "actor" in data:
                await self._h.authorize(target, operation, data)
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

    async def _answer(
        self, sid: str, question_id: str, answer: Answer, actor: str = "user"
    ) -> None:
        value = (
            "allow"
            if answer.kind == "allow"
            else answer.value
            if answer.kind == "value"
            else "declined"
        )
        acting = {"acting_for": "user"} if actor != "user" else {}
        if answer.kind == "value" and self._credentials.stage is not None:
            try:
                question = await self._h.call(
                    "embedding",
                    "questions",
                    "validate",
                    {"session": sid, "actor": actor, "request": question_id, **acting},
                )
            except Exception as exc:
                raise _error(exc) from exc
            if question["kind"] == "secret":
                try:
                    await self._h.call(
                        "embedding",
                        "credentials",
                        "answer",
                        {
                            "session": sid,
                            "actor": actor,
                            "request": question_id,
                            "value": value,
                            **acting,
                        },
                    )
                except Exception as exc:
                    raise _error(exc) from None
                return
        await self._call(
            "questions",
            "answer",
            session=sid,
            actor=actor,
            request=question_id,
            value=value,
            declined=answer.kind == "decline",
            **acting,
            reason=answer.reason,
        )

    async def _interrupted(self, d: dict[str, Any]) -> None:
        if (reason := d.get("interrupted")) and (session := self._sessions.get(d["session"])):
            session._interruption = reason
            session._changed.set()
            for stream in session._prompt_streams:
                stream.push(AgentError(ErrorCode.LOST, "Session interrupted", {"reason": reason}))

    async def _event(self, d: dict[str, Any]) -> None:
        sid = d.get("session")
        if sid is None:
            return
        if (session := self._sessions.get(sid)) is not None:
            if d["kind"] == "session_interrupted":
                session._interruption = d["reason"]
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

    async def session(
        self,
        *,
        settings: JsonObject | None = None,
        tenant: str | None = None,
        actors: Sequence[Actor] = (),
    ) -> Session:
        if tenant is not None and not self._tenants:
            raise AgentError(ErrorCode.NOT_SUPPORTED, "Tenants are not enabled")
        if actors and not self._several_actors:
            raise AgentError(ErrorCode.NOT_SUPPORTED, "Several actors are not enabled")
        async with self._lock:
            defaults = {**self._settings, **settings_in(settings or {})}
            data = await self._session(
                "create", project=str(self._project), settings=defaults, tenant=tenant
            )
            session = self._attach(data["id"])
            try:
                for actor in actors:
                    await session.join(actor)
            except BaseException:
                await session.close()
                raise
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
            if (old := self._sessions.get(id)) is not None and old._interruption:
                old._closed = True
                self._detached(id)
            await self._session("open", session=id, actor="user")
            await self._call("runtime", "wait", session=id)
            return self._attach(id)

    async def sessions(self, *, project: Path | None = None) -> list[JsonObject]:
        rows = cast(
            list[JsonObject],
            await self._session("list", project=str(project.resolve()) if project else None),
        )
        return [
            {**row, "model": settings_out({"model": row.get("model")})["model"]} for row in rows
        ]

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
            "created": state["created"],
            "lastActivity": max(
                (entry["time"] for entry in state["entries"]), default=state["created"]
            ),
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
        parts = self._h.declarations(str(self._project))
        value = _declaration(parts)
        runtime = parts[self._h.capabilities["runtime"][0]]
        environment = parts[self._h.capabilities["environment"][0]]
        store = parts[self._h.capabilities["history"][0]]
        value.pop("plugins", None)
        value.update(
            waitingThroughRestart=bool(
                value["waitingThroughRestart"] and self._late_answers and "questions" in parts
            ),
            mixedActorInput="refused",
            holdsOutput=bool(self._h.holds_output()),
            severalActors=self._several_actors,
            sessionLimits=self._session_limits,
            tenants=self._tenants,
            questionsOutlastTurns=bool(
                self._late_answers and runtime.get("open_calls") and "questions" in parts
            ),
            lateAnswersStartTurns=bool(
                self._late_answers and runtime.get("open_calls") and "questions" in parts
            ),
            erasure=bool(store.get("erasure")),
            portableSessions=store.get("retention") != "process",
            settingsDuringTurn="refused",
            confinesFiles=bool(environment.get("confines_files")),
            commandContainment=environment.get("containment", "none"),
            nestedToolCalls=bool(runtime.get("nested_tools")),
            queuedInputAfterRestart=runtime.get("queued_input_after_restart", "handedBack"),
            startsTurnsUnasked=(
                "jobReports" if parts.get("jobs", {}).get("job_reports_start_turns") else "never"
            ),
        )
        queued_jobs = runtime.get(
            "queued_job_reports_after_restart", value["queuedInputAfterRestart"]
        )
        if queued_jobs != value["queuedInputAfterRestart"]:
            value["queuedJobReportsAfterRestart"] = queued_jobs
        return cast(JsonObject, value)

    async def _install_acp_mcp(
        self, resolver: Callable[[Path], Sequence[JsonObject]] | None
    ) -> None:
        if resolver is None:
            return
        if "mcp" in self._h.plugins:
            self._h.plugins["mcp"].project_servers = resolver
        else:
            await self._h.load(
                MCP(standard_names=True, project_servers=resolver, prepare_hook="session.prepare")
            )

    @overload
    async def serve_acp(
        self,
        *,
        compose: Callable[[Path], Awaitable[Agent]] | None = None,
        compose_reopen: Callable[[Path, str], Awaitable[Agent]] | None = None,
        project_settings: Callable[[Path], JsonObject] | None = None,
        project_mcp: Callable[[Path], Sequence[JsonObject]] | None = None,
    ) -> None: ...

    @overload
    async def serve_acp(
        self,
        *,
        listen: str,
        actors: Sequence[AcpActor],
        tls: WebSocketTLS | None = None,
        compose: Callable[[Path], Awaitable[Agent]] | None = None,
        compose_reopen: Callable[[Path, str], Awaitable[Agent]] | None = None,
        project_settings: Callable[[Path], JsonObject] | None = None,
        project_mcp: Callable[[Path], Sequence[JsonObject]] | None = None,
    ) -> WebSocketServer: ...

    async def serve_acp(
        self,
        *,
        listen: str | None = None,
        actors: Sequence[AcpActor] = (),
        tls: WebSocketTLS | None = None,
        compose: Callable[[Path], Awaitable[Agent]] | None = None,
        compose_reopen: Callable[[Path, str], Awaitable[Agent]] | None = None,
        project_settings: Callable[[Path], JsonObject] | None = None,
        project_mcp: Callable[[Path], Sequence[JsonObject]] | None = None,
    ) -> WebSocketServer | None:
        """Serve ACP on stdio or start an authenticated WebSocket listener."""
        if self._closed:
            raise AgentError(ErrorCode.NOT_OPEN, "Agent is closed")
        if self._handler is not None:
            raise AgentError(ErrorCode.INVALID_COMPOSITION, "ACP answers its own questions")
        async with self._lock:
            if self._h.sessions or "acp" in self._h.plugins or self._acp_server is not None:
                raise AgentError(ErrorCode.BUSY, "ACP must start before any sessions open")
            if listen is None and (actors or tls is not None):
                raise ValueError("Network ACP options require listen")
            if not self._plugin_host and self._enable_plugin_host is not None:
                try:
                    await self._enable_plugin_host()
                except Exception as exc:
                    raise AgentError(ErrorCode.INVALID_COMPOSITION, str(exc)) from exc
                self._plugin_host = True
            if listen is not None:
                kinds: dict[str, str] = {}
                connections = _AcpConnections()
                principals = deepcopy(actors)
                for entry in principals:
                    actor = entry["actor"]
                    aid, kind, allowed = actor["id"], actor["kind"], set(actor["rights"])
                    if (
                        not aid
                        or kind not in {"user", "host", "agent", "program"}
                        or not allowed <= PERMISSIONS
                    ):
                        raise ValueError("Each WebSocket actor needs an id, kind and valid rights")
                    if aid in kinds and kind != kinds[aid]:
                        raise ValueError("Tokens for the same actor id must agree on kind")
                    kinds[aid] = kind
                if not actors:
                    raise ValueError("WebSocket ACP requires at least one configured actor")
                await self._install_acp_mcp(project_mcp)

                async def handle(frames: WebSocketFrames, entry: AcpActor) -> None:
                    interface = _Interface(
                        self,
                        compose,
                        compose_reopen,
                        project_settings,
                        project_mcp,
                        principal=entry,
                        connections=connections,
                    )
                    await self._h.attach_interface(interface)
                    try:
                        await interface.serve_frames(frames)
                    finally:
                        await interface.close_connection()

                self._acp_server = await listen_websocket(
                    listen,
                    [(entry["token_file"], entry) for entry in principals],
                    ACP_PROTOCOL,
                    handle,
                    tls,
                )
                return self._acp_server
            await self._install_acp_mcp(project_mcp)
            interface = _Interface(self, compose, compose_reopen, project_settings, project_mcp)
            await self._h.load(interface)
        try:
            await interface.serve()
        finally:
            try:
                await interface.close_projects()
            finally:
                await self.close()
        return None

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
                if self._acp_server is not None:
                    await self._acp_server.close()
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
    history: HistoryStore | HistoryPort | None = None,
    runtime: RuntimeChoice | None = None,
    environment: MemoryEnvironment | LocalEnvironment | None = None,
    credentials: CredentialStore | None = None,
    providers: Sequence[Provider] = (),
    tools: Sequence[Tool] = (),
    plugins: Sequence[Plugin] = (),
    process_plugins: Sequence[ProcessPlugin | JsonObject] | None = None,
    service_plugins: Sequence[ServicePlugin] | None = None,
    service_ping_interval: float = 30.0,
    service_control_timeout: float = 5.0,
    plugin_host: bool | None = None,
    model: str | ModelRef | None = None,
    settings: JsonObject | None = None,
    approval: Approval | None = None,
    on_question: QuestionHandler | None = None,
    local_process_groups: bool = False,
    commands: bool = False,
    conformance: bool = False,
    several_actors: bool = False,
    session_limits: bool = False,
    tenants: Mapping[str, Tenant] | None = None,
    job_reports_start_turns: bool = False,
    late_answers_start_turns: bool = False,
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

        if runtime is not None and runtime.continues_after_restart != (durability == "durable"):
            raise AgentError(ErrorCode.INVALID_COMPOSITION, "Runtime does not match durability")
        persistent = (
            history._kind != "memory"
            if isinstance(history, HistoryStore)
            else history.persistent
            if history is not None
            else None
        )
        if persistent is not None and persistent == (durability == "ephemeral"):
            raise AgentError(
                ErrorCode.INVALID_COMPOSITION,
                "Persistent history requires kept or durable"
                if durability == "ephemeral"
                else "History does not match durability",
            )
        external_placement = bool(process_plugins or service_plugins)
        if plugin_host is False and external_placement:
            raise AgentError(
                ErrorCode.INVALID_COMPOSITION,
                "process_plugins and service_plugins require a plugin host",
            )
        if any(
            not math.isfinite(n) or n <= 0 for n in (service_ping_interval, service_control_timeout)
        ):
            raise AgentError(
                ErrorCode.INVALID_COMPOSITION, "Service deadlines must be finite and positive"
            )
        scratch = TemporaryDirectory(prefix="modular-agent-")
        h = Harness(process_plugins=(), tenants=tenants or {})
        h.lazy_setup = True
        try:
            root = Path(data_dir).resolve() if data_dir is not None else Path(scratch.name)
            environment_root = (
                environment.root if isinstance(environment, LocalEnvironment) else None
            )
            folder = Path(project or environment_root or Path.cwd()).resolve(strict=True)
            if environment_root is not None and environment_root.resolve() != folder:
                raise AgentError(
                    ErrorCode.INVALID_COMPOSITION, "Local environment root must match project"
                )
            if not folder.is_dir():
                raise ValueError("Project must be a directory")
            defaults = settings_in(settings or {})
            if approval is not None:
                defaults.update(settings_in({"approval": approval}))
            agent = Agent(h, folder, defaults, on_question, scratch)
            agent._plugin_host = plugin_host is True or external_placement
            if history is not None and not isinstance(history, HistoryStore):
                store = _PortHistory(history)
            elif isinstance(history, HistoryStore) and history._kind == "http":
                store = HTTPHistory(history._url, history._path)
            elif durability == "ephemeral" or (history is None and data_dir is None):
                store = agent._memory_store = memory_store or _MemoryHistory()
            else:
                store_root = history._path if history is not None else root
                if store_root is None:
                    raise ValueError("File history needs a directory")
                store_root.mkdir(parents=True, exist_ok=True, mode=0o700)
                store = History(store_root)
            await h.load(store)
            local_root = Path(scratch.name) if durability == "ephemeral" else root
            local = Local(local_root, point_store="git")
            if not isinstance(environment, MemoryEnvironment) and local_process_groups:
                try:
                    delegated_root()
                except Exception:
                    local = ProcessGroupLocal(local_root, point_store="git")
            await h.load(environment if isinstance(environment, MemoryEnvironment) else local)
            dispatcher = _SdkTools()
            dispatcher.conformance = conformance
            await h.load(dispatcher)
            agent._conformance = conformance
            agent._late_answers = late_answers_start_turns
            agent._several_actors = several_actors
            agent._session_limits = session_limits
            agent._tenants = tenants is not None
            await h.load(
                _SdkDurable(job_reports_start_turns)
                if durability == "durable"
                else _SdkRuntime(job_reports_start_turns)
            )
            jobs = Jobs()
            jobs.declarations = {
                **Jobs.declarations,
                "job_reports_start_turns": job_reports_start_turns,
            }
            await h.load(jobs)
            configure_binding_hooks(h)
            h.on("embedding", "result.ready", _structured_result, "last")
            if conformance:
                await h.load(Echo())
                await h.load(Nest())
            questions = Questions() if conformance else _Questions()
            questions.wait_for_unconnected = not conformance
            await h.load(questions)
            agent._credentials = credentials or environment_credentials()
            await h.load(_CredentialAdapter(agent._credentials))
            h.on("embedding", "session.start", agent._present, "first")
            h.on("embedding", "session.suspend", agent._interrupted, "first")
            h.follow("embedding", "user", agent._event)
            for provider in providers:
                await h.load(_ProviderAdapter(provider, agent._credentials))
            selection = Selection(
                [p.id for p in providers] + (["conformance"] if conformance else [])
            )
            await h.load(selection)
            compaction_parts = [p for p in plugins if isinstance(p, _CompactionPlugin)]
            mcp_parts = [p for p in plugins if isinstance(p, _McpPlugin)]
            if len(compaction_parts) > 1 or len(mcp_parts) > 1:
                raise ValueError("Duplicate official plugin")
            await h.load(
                (compaction_parts[0] if compaction_parts else _CompactionPlugin())._native()
            )
            if commands:
                await h.load(Commands())
            if mcp_parts:
                await h.load(mcp_parts[0]._native())
            elif conformance:
                await h.load(MCP(standard_names=True))
            if approval is not None or conformance:
                await h.load(_Approval())
            registered_tools: dict[str, _LocalPlugin] = {}
            interfaces: list[tuple[str, Interface]] = []
            credential_registered = credentials is not None
            history_registered = history is not None
            for plugin in [
                *(Plugin(t.name, tools=[t]) for t in tools),
                *(
                    p
                    for p in plugins
                    if not isinstance(p, (_OverWire, _CompactionPlugin, _McpPlugin))
                ),
            ]:
                if plugin.name in h.plugins:
                    raise AgentError(
                        ErrorCode.INVALID_COMPOSITION, f"Duplicate plugin: {plugin.name}"
                    )
                try:
                    registrar = await plugin._register(plugin.config)
                    if registrar._history_store is not None:
                        if history_registered:
                            raise ValueError("Duplicate history store")
                        port = registrar._history_store
                        if port.persistent == (durability == "ephemeral"):
                            raise ValueError(
                                "Persistent history requires kept or durable"
                                if port.persistent
                                else "Kept history needs a persistent store"
                            )
                        history_registered = True
                        await h.unload(h.capabilities["history"][0])
                        await h.load(_PortHistory(port))
                        agent._memory_store = None
                    if registrar._credential_store is not None:
                        if credential_registered:
                            raise ValueError("Duplicate credential store")
                        credential_registered = True
                        agent._credentials = registrar._credential_store
                        await h.unload("credentials")
                        await h.load(_CredentialAdapter(agent._credentials))
                        for owner in h.plugins.values():
                            if isinstance(owner, _ProviderAdapter):
                                owner.credentials = agent._credentials
                    if registrar._configuration is not None:
                        if "config" in h.capabilities:
                            raise ValueError("Duplicate configuration source")
                        await h.load(_Configuration(plugin.name, registrar._configuration))
                    if registrar._interface is not None:
                        interfaces.append((plugin.name, registrar._interface))
                    if registrar._environment is not None:
                        if "working-environment" not in plugin.replaces:
                            raise ValueError("Unlisted working-environment replacement")
                        await h.unload(h.capabilities["environment"][0])
                        await h.load(_WorkingPart(plugin.name, registrar._environment))
                    for provider in registrar._providers.values():
                        prior_provider = h.capabilities.get(provider.id)
                        if prior_provider is not None:
                            if (
                                f"provider:{provider.id}" not in plugin.replaces
                                or prior_provider[1].role != "provider"
                            ):
                                raise ValueError(f"Duplicate Provider: {provider.id}")
                            await h.unload(prior_provider[0])
                        await h.load(_ProviderAdapter(provider, agent._credentials))
                        await selection.add_provider({"provider": provider.id}, None)
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
                adapter = _LocalPlugin(
                    plugin, registrar, folder, late_answers=late_answers_start_turns
                )
                if registrar._runtime is not None:
                    if "runtime" not in plugin.replaces:
                        await plugin._close()
                        raise ValueError("Unlisted Runtime replacement")
                    runtime_port, queued_input, queued_jobs = registrar._runtime
                    await h.unload(h.capabilities["runtime"][0])
                    await h.load(
                        _LocalRuntime(
                            h,
                            plugin.name,
                            runtime_port,
                            adapter._history_page,
                            queued_input=queued_input,
                            queued_jobs=queued_jobs,
                        )
                    )
                await h.load(adapter)
                registered_tools.update((name, adapter) for name in registrar._tools)
            specs: list[dict[str, Any]] = [
                {"command": [p.name], "config": p.config, "_over_wire": p.original}
                for p in plugins
                if isinstance(p, _OverWire)
            ]

            for adapter in (p for p in h.plugins.values() if isinstance(p, _LocalPlugin)):
                for hook in adapter.registrar._hooks:
                    if hook.point not in _SUPPORTED_HOOKS and hook.point not in h.hooks:
                        raise AgentError(ErrorCode.NOT_SUPPORTED, f"Unsupported hook: {hook.point}")

            async def load_configured_plugins(initial: list[dict[str, Any]], *, host: bool) -> None:
                configured = list(initial)
                if not host:
                    if configured:
                        await load_plugins(h, configured, folder, root, external_factory=factory)
                    return
                processes = [
                    p._wire() if isinstance(p, ProcessPlugin) else p for p in process_plugins or ()
                ]
                env = json.loads(os.environ.get("MODULAR_AGENT_PLUGINS") or "[]")
                if not isinstance(env, list):
                    raise ValueError("MODULAR_AGENT_PLUGINS must be an array")
                services = [
                    {
                        "url": p["url"],
                        "tokenFile": str(Path(p["token_file"]).absolute()),
                        "config": p.get("config", {}),
                    }
                    for p in service_plugins or ()
                ]
                configured.extend([*processes, *services, *env])
                if configured:
                    await load_plugins(h, configured, folder, root, external_factory=factory)

            def factory(
                harness: Any, spec: dict[str, Any], project: Path, home: Path, index: int
            ) -> Any:
                kind = _MemoryExternal if isinstance(spec.get("_over_wire"), Plugin) else External
                plugin = kind(harness, spec, project, home, index)
                if "url" in spec:
                    plugin.ping_interval = service_ping_interval
                    plugin.control_timeout = service_control_timeout
                return plugin

            await load_configured_plugins(specs, host=agent._plugin_host)

            async def enable_plugin_host() -> None:
                await load_configured_plugins([], host=True)

            agent._enable_plugin_host = enable_plugin_host
            wrap_native_providers(h)
            if durability != "ephemeral" and agent._memory_store is not None:
                raise ValueError("Kept history needs a persistent store")
            environment_owner = h.capabilities["environment"][0]
            if (
                data_dir is None
                and durability != "ephemeral"
                and h.plugins[environment_owner] is local
            ):
                raise ValueError("Local environment recovery needs data_dir")
            runtime_owner = h.capabilities["runtime"][0]
            continues = bool(h.plugins[runtime_owner].declarations.get("durable"))
            # Offline ACP fixtures exercise both Runtime kinds with persistent
            # history. The registered Runtime still determines recovery.
            if not (conformance and durability != "ephemeral") and continues != (
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
            if not specs and not agent._plugin_host and not interfaces:
                agent._restart = lambda: build_with_store(agent._memory_store)
            for owner_name, implementation in interfaces:
                await h.load(_InterfacePart(owner_name, implementation, agent))
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
