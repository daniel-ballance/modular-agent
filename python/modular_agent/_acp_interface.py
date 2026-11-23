"""ACP connection and project routing. Import this module only when serving ACP."""

from __future__ import annotations

import asyncio
import os
from collections.abc import Awaitable, Callable, Mapping, Sequence
from contextvars import ContextVar, Token
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast
from uuid import uuid4

from ma_acp import ACP, OUTPUT_SESSION, protocol_error
from ma_core import Plugin as _NativePlugin
from ma_core.wire import settings_in
from ma_harness.authority import CONNECTION_AUTHORITY

from ._agui_http import AguiServer
from ._types import Actor, JsonObject

if TYPE_CHECKING:
    from ._agent import AcpActor, Agent


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
        stdio_actor: Actor | None = None,
        connections: _AcpConnections | None = None,
        scope: Mapping[str, Any],
        rights: frozenset[str] | None = None,
    ) -> None:
        configured = principal["actor"] if principal else stdio_actor
        actor = configured["id"] if configured else os.environ.get("MODULAR_AGENT_ACTOR", "user")
        super().__init__(agent._project, agent._settings, actor=actor)
        if configured is not None:
            self.principal = configured
        self.network = principal is not None
        self.trace_trusted = principal is None or principal.get("trace_trusted") is True
        self._allowed_projects: frozenset[Path] | None = scope.get("projects")
        self._allowed_tenants: frozenset[str | None] = scope["tenants"]
        self.represents = scope["represents"]
        self._connections = connections
        self._token_rights = rights
        self._connection_grants: dict[str, set[str]] = {}
        if principal is not None:
            self.name = "acp:" + uuid4().hex
            self.principal = principal["actor"]
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
            (self.actor, self._token_rights, self._connection_grants, self._scope_allows)
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
        return (self._compose is not None or folder == self._agent._project) and (
            self._allowed_projects is None or folder in self._allowed_projects
        )

    def _scope_allows(self, session: Mapping[str, Any]) -> bool:
        return self._project_allowed(Path(session["project"])) and self.tenant_allowed(
            session.get("tenant")
        )

    def cwd(self, cwd: str, additional_directories: Any = None, **kwargs: Any) -> str:
        project = cast(str, super().cwd(cwd, additional_directories, **kwargs))
        if not self._project_allowed(Path(project)):
            raise protocol_error("forbidden", "Project outside connection scope")
        return project

    def tenant_allowed(self, tenant: Any) -> bool:
        return (tenant is None or isinstance(tenant, str)) and tenant in self._allowed_tenants

    def session_create_rights(self, tenant: str | None, has_mcp: bool) -> list[str]:
        harness = self._current()._h
        rights = set(self.principal["rights"]) & harness.admin & harness.tenant
        if self._token_rights is not None:
            rights &= self._token_rights
        if tenant is not None:
            rights &= set(harness.tenant_config(tenant)["rights"])
        if not ({"input", "tools"} if has_mcp else {"input"}) <= rights:
            raise protocol_error("forbidden", "Actor cannot create this session")
        return sorted(rights)

    def _owner(self, sid: str) -> Agent | None:
        return (
            self._agents.get(sid)
            or (self._connections.composition(sid) if self._connections else None)
            or self._agent._resumed.get(sid)
        )

    async def visible_sessions(self, project: str | None) -> list[dict[str, Any]]:
        canonical = str(Path(project).resolve()) if project is not None else None
        rows = cast(list[dict[str, Any]], await super().visible_sessions(canonical))
        agent = self._current()
        visible = []
        for row in rows:
            if not self._project_allowed(Path(row["project"])):
                continue
            sid = row["id"]
            summary = await (self._owner(sid) or agent).session_summary(
                sid,
                actor=self.actor,
                local=not self.network,
                represents=self.represents,
                approval_views={qid for session, qid in self.approval_views if session == sid},
            )
            if summary is not None:
                visible.append({**row, "waiting": summary["waiting"]})
        return visible

    async def require_visible_session(self, project: str | None, sid: str) -> None:
        agent = self._owner(sid) or self._agent
        session = agent._h.sessions.get(sid)
        if session is None:
            session = await self._agent._api.call("history", "read", {"session": sid})
        if (
            session is None
            or (not session["entries"] and sid not in agent._h.sessions)
            or not self._scope_allows(session)
            or not agent._h.can_open(session, self.actor, local=not self.network)
        ):
            raise protocol_error("forbidden", "Session inaccessible")
        if project is None:
            return
        if session["project"] != project:
            raise protocol_error("wrong_project", "Session is in a different project")
        self._claim(sid)
        if self.network and sid not in self._connection_grants and self._token_rights is not None:
            grant = session.get("actors", {}).get(self.actor)
            self._connection_grants[sid] = set(self._token_rights) & set(
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
        selected = self._owner(session_id) if session_id is not None else None
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
                if self.network or selected._h.sessions:
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
        if selected is not self._agent:
            selected._h.capacity = self._agent._h.capacity
        self._scope.set(selected)

    async def session_started(self, payload: JsonObject) -> None:
        sid = cast(str, payload["session"])
        self._bind(sid)
        if sid == self.opening:
            await self.set_presence(sid, self.actor, True)
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
                scope = self._scope.set(agent)
                try:
                    if sid in agent._h.sessions:
                        for actor in self.presence.get(sid, set()).copy():
                            await self.set_presence(sid, actor, False)
                    self._unbind(sid)
                    self.sessions.discard(sid)
                    if (
                        sid not in connections.sessions
                        and sid in agent._h.sessions
                        and not isinstance(agent._acp_server, AguiServer)
                    ):
                        await agent._h.suspend_session(sid)
                finally:
                    self._scope.reset(scope)
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
            return {
                **value,
                "keepsStateAtProvider": selected["keepsStateAtProvider"],
                "rewinding": selected["rewinding"],
                "plugins": selected["plugins"],
            }
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
            for sid, owner in list(self._agent._resumed.items()):
                if owner is agent:
                    del self._agent._resumed[sid]
            await agent.close()
