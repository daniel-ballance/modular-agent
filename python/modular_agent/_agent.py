"""Composition and lifecycle for an embedded agent."""

from __future__ import annotations

import asyncio
import json
import math
import os
from collections.abc import Awaitable, Callable, Collection, Coroutine, Generator, Mapping, Sequence
from copy import deepcopy
from dataclasses import dataclass
from os import PathLike
from pathlib import Path
from tempfile import TemporaryDirectory
from types import TracebackType
from typing import TYPE_CHECKING, Any, NotRequired, Self, TypedDict, cast, overload

if TYPE_CHECKING:
    from ._acp_interface import _AcpConnections

from jsonschema import Draft202012Validator
from referencing import Registry

from ma_approval import Approval as _Approval
from ma_core import plain
from ma_core import telemetry as ot
from ma_core.wire import json_equal, model_out, settings_in, settings_out
from ma_durable import Durable
from ma_harness import Harness
from ma_harness.authority import PERMISSIONS, read_tenants
from ma_harness.interface_tools import SOURCE, registrations as interface_registrations
from ma_history import History
from ma_history.http import HTTPHistory
from ma_jobs import Jobs
from ma_local import local_for_platform
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
    read_token,
)
from ma_questions import Questions
from ma_runtime import Runtime
from ma_selection import Selection

from ._agui_http import AguiServer, AguiTLS
from .compaction import _CompactionPlugin
from .mcp import _McpPlugin
from ._credentials import CredentialStore, _CredentialAdapter, environment_credentials
from ._environment import LocalEnvironment, MemoryEnvironment
from ._agui_receipts import ReceiptStore
from ._history import HistoryStore
from ._listing import SessionSummary, summarize
from ._resume import ResumeOpen, resume_sessions
from ._history_port import HistoryPort, _PortHistory
from ._interface_tools import InterfaceToolConnection, InterfaceToolHandoff, InterfaceToolSource
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
from ._time import duration_ms
from ._types import (
    Actor,
    AgentError,
    Answer,
    Approval,
    Durability,
    ErrorCode,
    JsonObject,
    ModelRef,
    Question,
    QuestionHandler,
    Tenant,
)


ACP_RIGHTS = tuple(sorted(PERMISSIONS))


def read_service_token(path: str | PathLike[str]) -> str:
    """Read an operator-owned service token with the binding's file checks."""
    return read_token(path)


def tenants_from_environment() -> dict[str, Tenant]:
    """Read the operator's tenant configuration, outside client settings."""
    try:
        return cast(dict[str, Tenant], read_tenants(os.getenv("MODULAR_AGENT_TENANTS", "{}")))
    except Exception as exc:
        raise AgentError(ErrorCode.INVALID_COMPOSITION, str(exc)) from exc


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
    represents: NotRequired[Sequence[str]]
    trace_trusted: NotRequired[bool]


def _acp_list(value: Any, check: Callable[[Any], bool], name: str) -> list[Any]:
    if (
        not isinstance(value, Sequence)
        or isinstance(value, (str, bytes))
        or not all(check(item) for item in value)
    ):
        raise AgentError(ErrorCode.INVALID_COMPOSITION, f"Invalid ACP {name} list")
    return list(value)


def _actor_id(value: Any) -> bool:
    return isinstance(value, str) and bool(value)


def _acp_scope(options: Mapping[str, Any]) -> dict[str, Any]:
    scope: dict[str, Any] = {}
    if "projects" in options:
        paths = _acp_list(
            options["projects"], lambda path: isinstance(path, (str, PathLike)), "projects"
        )
        try:
            if any(not Path(path).is_absolute() or not Path(path).is_dir() for path in paths):
                raise ValueError("Expected absolute project directories")
            scope["projects"] = frozenset(Path(path).resolve(strict=True) for path in paths)
        except (OSError, ValueError, RuntimeError, TypeError) as exc:
            raise AgentError(ErrorCode.INVALID_COMPOSITION, "Invalid ACP project path") from exc
    scope["tenants"] = frozenset(
        _acp_list(options.get("tenants", [None]), lambda t: t is None or _actor_id(t), "tenants")
    )
    scope["represents"] = frozenset(
        _acp_list(options.get("represents", []), _actor_id, "represents")
    )
    return scope


def _acp_rights(value: Any) -> frozenset[str]:
    return frozenset(_acp_list(value, lambda r: _actor_id(r) and r in PERMISSIONS, "rights"))


class AguiActor(AcpActor):
    client_id: str


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
        harness.approval_routes["sdk"] = self._sdk_approval_rights
        self._api = harness.api()
        self._project = project
        self._settings = settings
        self._handler = handler
        self._handlers: dict[str, QuestionHandler | None] = {}
        self._scratch = scratch
        self._test_project: TemporaryDirectory[str] | None = None
        self._sessions: dict[str, Session] = {}
        self._resumed: dict[str, Agent] = {}
        self._live_views: dict[str, set[tuple[str, str | None]]] = {}
        self._question_tasks: dict[tuple[str, str], asyncio.Task[None]] = {}
        self._lock = asyncio.Lock()
        self._closed = False
        self._plugin_host = False
        self._enable_plugin_host: Callable[[], Awaitable[None]] | None = None
        self._acp_server: WebSocketServer | AguiServer | None = None
        self._conformance = False
        self._late_answers = False
        self._several_actors = False
        self._session_limits = False
        self._tenants = False
        self._credentials: CredentialStore = environment_credentials()
        self._restart: Callable[[], Awaitable[Agent]] | None = None
        self._receipt_store: ReceiptStore | None = None
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
            await self._call("questions", "connect", session=sid, actor="user", route="sdk-handler")

    async def _set_handler(self, sid: str, handler: QuestionHandler | None) -> None:
        self._handlers[sid] = handler
        if session := self._sessions.get(sid):
            self._h.forget_waits(sid, token=session._delivery_token)
        await self._call(
            "questions",
            "connect" if handler else "disconnect",
            session=sid,
            actor="user",
            route="sdk-handler",
        )
        await self._offer_waits(sid)

    async def _sdk_approval_rights(
        self, sid: str, entry: dict[str, Any], actor: str, principal: str
    ) -> set[str]:
        if principal != "user" or self._h.sessions[sid]["project"] != str(self._project):
            return set()
        q = {
            **entry["data"],
            "deadline": entry["data"].get("deadlineAt"),
            "entry": entry["id"],
            "answerable": True,
        }
        visible = await self._session(
            "view", session=sid, recipient=actor, type="reply", method="questions", value=q
        )
        return PERMISSIONS if json_equal(q, visible) else set()

    async def _answer(
        self,
        sid: str,
        question_id: str,
        answer: Answer,
        actor: str = "user",
        *,
        delivery_token: str | None = None,
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
            delivery_token=delivery_token,
            exact_cover_view=(actor, delivery_token) in self._live_views.get(question_id, ()),
            **acting,
            reason=answer.reason,
        )

    async def _interrupted(self, d: dict[str, Any]) -> None:
        if (reason := d.get("interrupted")) and (session := self._sessions.get(d["session"])):
            session._interruption = reason
            session._changed.set()
            for stream in session._prompt_streams:
                stream.push(AgentError(ErrorCode.LOST, "Session interrupted", {"reason": reason}))

    async def _delivered(self, original: dict[str, Any], view: dict[str, Any] | None) -> None:
        kind = original["kind"]
        if (
            kind == "input_request_opened"
            and (q := original["request"]).get("coversNested")
            and not q.get("approvalWait")
        ):
            exact = json_equal(original, view)
            if exact and self._handlers.get(original["session"], self._handler) is not None:
                self._live_views.setdefault(q["id"], set()).add(("user", None))
            if not exact:
                self._live_views.get(q["id"], set()).discard(("user", None))
                return  # A changed or withheld request cannot be answered on this route.
        elif kind == "input_request_answered":
            self._live_views.pop(original["answer"]["request"], None)
        elif kind == "input_request_unanswerable":
            self._live_views.pop(original["request"], None)
        if view is not None:
            await self._event(view)

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
            if d["request"].get("approvalWait"):
                return
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

        if d["kind"] == "turn_ended":
            await self._offer_waits(sid)

    async def _offer_waits(self, sid: str) -> None:
        handler = self._handlers.get(sid, self._handler)
        if not handler or not self._h.max_approval_wait_ms:
            return
        session = self._attach(sid)
        for q in await session.questions(present=True):
            key = sid, q.id
            if q.approval_wait and q.answerable and key not in self._question_tasks:

                async def respond(q: Question = q, key: tuple[str, str] = key) -> None:
                    try:
                        await session.answer(q.id, await _reply(handler, q))
                    except AgentError:
                        pass
                    finally:
                        self._question_tasks.pop(key, None)

                self._question_tasks[key] = asyncio.create_task(respond())

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
            with ot.span(
                "modular_agent.session.open", {"modular_agent.session.operation": "new"}
            ) as operation:
                defaults = {**self._settings, **settings_in(settings or {})}
                data = await self._session(
                    "create",
                    project=str(self._project),
                    settings=defaults,
                    tenant=tenant,
                    defer_setup=True,
                    trace_at_caller=True,
                )
                session = self._attach(data["id"])
                ot.set_attrs(operation, {"gen_ai.conversation.id": session.id})
                try:
                    for actor in actors:
                        await session.join(actor)
                except BaseException:
                    await session.close()
                    raise
                if not data["entries"]:
                    await self._session(
                        "append",
                        session=session.id,
                        kind="plugins",
                        writer="@harness",
                        data={"active": self._h.active_plugins()},
                    )
                return session

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
            await self._offer_waits(id)
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

    async def session_summary(
        self,
        id: str,
        *,
        actor: str = "user",
        kind: str | None = None,
        rights: Collection[str] | None = None,
        route_id: str | None = None,
        scope: Callable[[Path, str | None], bool] | None = None,
        live_questions: Collection[str] | None = None,
        approval_views: Collection[str] = (),
        represents: Collection[str] = (),
        local: bool = False,
    ) -> SessionSummary | None:
        """Inspect kept work for a viewer, without a writer lease, recovery or presence."""
        if not id or not id.isalnum():
            raise AgentError(ErrorCode.INVALID_PARAMS, "Invalid session id")
        h = self._h
        store = h.plugins[h.capabilities["history"][0]].declarations
        if store.get("retention") == "process":
            return None
        owned = h.sessions.get(id)
        if owned and not owned.get("writer_lost") and id not in h.interruptions:
            state = owned
        else:
            state = await self._call("history", "read", session=id)

        def discoverable() -> bool:
            return bool(
                state
                and state["entries"]
                and not state.get("provisional")
                and (scope is None or scope(Path(state["project"]), state.get("tenant")))
                and h.can_open(state, actor, local=local, kind=kind)
                and (rights is None or "watch" in rights)
            )

        if not discoverable():
            return None
        if h.supports_erasure():
            await self._call(
                "history",
                "erasure_revision",
                session=id,
                tombstones=state.get("_history_tombstones", []),
            )
        if owned is not None and state is owned:
            state = h.sessions.get(id)
            if not discoverable() or state.get("writer_lost"):
                return None
        row = summarize(
            h,
            state,
            running=bool(state is h.sessions.get(id) and (state.get("busy") or id in h.reopening)),
            actor=actor,
            rights=h.permissions(state, actor, rights),
            represents=represents,
            route_id=route_id,
            live_questions=live_questions,
            approval_views=approval_views,
        )
        if (
            owned is None
            and row["waiting"]["turn"] == "interrupted"
            and store.get("observes_writer")
            and await self._call("history", "writer_present", session=id)
        ):
            row["waiting"]["turn"] = "running"
        return row

    async def session_info(self, id: str) -> JsonObject:
        """Read saved local session settings without starting recovery or taking its lease."""
        if not id or not id.isalnum():
            raise AgentError(ErrorCode.INVALID_PARAMS, "Invalid session id")
        state = await self._call("history", "read", session=id, view=True)
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

    def connect_interface_tools(
        self,
        *,
        actor_id: str,
        route_id: str,
        on_handoff: Callable[[InterfaceToolHandoff], None] | None = None,
        rights: Sequence[str] | None = None,
        tenants: Sequence[str | None] = (None,),
        defer: bool = False,
    ) -> InterfaceToolConnection:
        """Bind an independently authenticated principal and operator route.

        Only trusted adapter code may call this method. A handoff callback
        receives the request synchronously and must return without blocking.
        """
        if self._closed or not self._h.interface_enabled():
            raise AgentError(ErrorCode.NOT_SUPPORTED, "Interface tools are not enabled")
        if self._h.interface_routes.get(route_id) != actor_id:
            raise AgentError(ErrorCode.FORBIDDEN, "Interface route does not belong to this actor")
        if rights is not None and not set(rights) <= PERMISSIONS:
            raise AgentError(ErrorCode.INVALID_COMPOSITION, "Unknown Interface right")
        if any(t is not None and t not in self._h.tenants for t in tenants):
            raise AgentError(ErrorCode.INVALID_COMPOSITION, "Unknown Interface tenant")
        return InterfaceToolConnection(self, actor_id, route_id, on_handoff, rights, tenants, defer)

    def reservation_limits(self) -> dict[str, dict[str, int]]:
        """Return the operator's limits, never live use or another session's state."""
        return cast(dict[str, dict[str, int]], deepcopy(self._h.capacity.limits))

    def declaration(self) -> JsonObject:
        if self._closed:
            raise AgentError(ErrorCode.NOT_OPEN, "Agent is closed")
        parts = self._h.declarations(str(self._project))
        from ma_acp.binding import declaration

        value = declaration(parts, interface_tools=self._h.interface_enabled())
        runtime = parts[self._h.capabilities["runtime"][0]]
        environment = parts[self._h.capabilities["environment"][0]]
        store = parts[self._h.capabilities["history"][0]]
        value.pop("plugins", None)
        if parts.get("approval", {}).get("covers_nested"):
            value["approvalCoversNested"] = True
        if self._h.max_approval_wait_ms:
            value["approvalsOutlastTurns"] = True
        value.update(
            waitingThroughRestart=bool(
                value["waitingThroughRestart"] and self._late_answers and "questions" in parts
            ),
            mixedActorInput="refused",
            runsToolsAtProvider=False,
            liveSessions=False,
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
            erasure=self._h.supports_erasure(),
            resourceReservations=self._h.capacity.declaration(),
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

    async def serve_agui(
        self,
        *,
        listen: str,
        actors: Sequence[AguiActor],
        tls: AguiTLS | None = None,
        tenant: str | None = None,
        acp: bool = False,
        origins: Sequence[str] = (),
        state_plugin: str | None = None,
        state_snapshot: Callable[[str], Awaitable[JsonObject | None]] | None = None,
        raw_sources: Mapping[str, str] | None = None,
        trace_state_keys: Sequence[str] = (),
        resume_open: ResumeOpen | None = None,
    ) -> AguiServer:
        """Serve HTTP + SSE for this project, optionally alongside ACP at /."""
        from ._agui import Binding
        from ._agui_http import listen_agui

        async with self._lock:
            if self._closed:
                raise AgentError(ErrorCode.NOT_OPEN, "Agent is closed")
            if self._acp_server is not None or (acp and self._h.sessions):
                raise AgentError(ErrorCode.BUSY, "Service is already in use")
            binding = Binding(
                self,
                actors,
                tenant,
                state_plugin,
                state_snapshot,
                raw_sources or {},
                trace_state_keys,
            )
            if acp and not self._plugin_host and self._enable_plugin_host is not None:
                await self._enable_plugin_host()
                self._plugin_host = True
            handle = None
            if acp:
                _, handle = await self._network_acp(binding.actors, None, None, None, None)
            server = await listen_agui(
                listen, tls, origins, binding, handle, lambda: resume_sessions(self, resume_open)
            )
            self._acp_server = server
            return server

    async def _network_acp(
        self,
        actors: Sequence[AcpActor],
        compose: Callable[[Path], Awaitable[Agent]] | None,
        compose_reopen: Callable[[Path, str], Awaitable[Agent]] | None,
        project_settings: Callable[[Path], JsonObject] | None,
        project_mcp: Callable[[Path], Sequence[JsonObject]] | None,
        connections: _AcpConnections | None = None,
    ) -> tuple[Sequence[AcpActor], Callable[[Any, AcpActor], Awaitable[None]]]:
        kinds: dict[str, str] = {}
        from ._acp_interface import _AcpConnections, _Interface, install_poll_route

        connections = connections or _AcpConnections()
        principals = actors
        scopes = {}
        routes = {}
        try:
            for index, entry in enumerate(principals):
                actor = entry["actor"]
                aid, kind = actor["id"], actor["kind"]
                if not _actor_id(aid) or kind not in ("user", "host", "agent", "program"):
                    raise ValueError("Each WebSocket actor needs an id, kind and valid rights")
                if aid in kinds and kind != kinds[aid]:
                    raise ValueError("Tokens for the same actor id must agree on kind")
                kinds[aid] = kind
                scopes[id(entry)] = _acp_scope(entry), _acp_rights(actor["rights"])
                routes[id(entry)] = f"acp:ws:{index}:{aid}"
                policy = (routes[id(entry)], aid, kind, *scopes[id(entry)])
                install_poll_route(self, *policy)
                connections.poll_policies.append(policy)
            if not principals:
                raise ValueError("WebSocket ACP requires at least one configured actor")
        except (TypeError, ValueError, KeyError) as exc:
            raise AgentError(ErrorCode.INVALID_COMPOSITION, str(exc)) from exc
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
                scope=scopes[id(entry)][0],
                rights=scopes[id(entry)][1],
                poll_route=routes[id(entry)],
            )
            await self._h.attach_interface(interface)
            try:
                await interface.serve_frames(frames)
            finally:
                await interface.close_connection()

        return principals, handle

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
        projects: Sequence[str | PathLike[str]] | None = None,
        tenants: Sequence[str | None] | None = None,
        rights: Sequence[str] | None = None,
        represents: Sequence[str] | None = None,
        actor: Actor | None = None,
        trace_trusted: bool = True,
        resume_open: ResumeOpen | None = None,
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
        resume_open: ResumeOpen | None = None,
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
        projects: Sequence[str | PathLike[str]] | None = None,
        tenants: Sequence[str | None] | None = None,
        rights: Sequence[str] | None = None,
        represents: Sequence[str] | None = None,
        actor: Actor | None = None,
        trace_trusted: bool = True,
        resume_open: ResumeOpen | None = None,
    ) -> WebSocketServer | None:
        """Serve ACP on stdio or start an authenticated WebSocket listener."""
        options = {
            name: value
            for name, value in (
                ("projects", projects),
                ("tenants", tenants),
                ("represents", represents),
            )
            if value is not None
        }
        if listen is not None and (
            options or rights is not None or actor is not None or not trace_trusted
        ):
            raise AgentError(ErrorCode.INVALID_COMPOSITION, "Set network ACP scope on each token")
        stdio_scope = _acp_scope(options)
        stdio_rights = _acp_rights(rights) if rights is not None else None
        if actor is not None:
            try:
                if not _actor_id(actor["id"]) or actor["kind"] not in (
                    "user",
                    "host",
                    "agent",
                    "program",
                ):
                    raise ValueError("Invalid stdio principal")
                maximum = _acp_rights(actor["rights"])
                stdio_rights = maximum if stdio_rights is None else stdio_rights & maximum
                stdio_actor = deepcopy(actor)
            except (ValueError, TypeError, KeyError) as exc:
                raise AgentError(ErrorCode.INVALID_COMPOSITION, "Invalid stdio principal") from exc
        else:
            stdio_actor = None
            if listen is None and not _actor_id(os.environ.get("MODULAR_AGENT_ACTOR", "user")):
                raise AgentError(ErrorCode.INVALID_COMPOSITION, "Invalid MODULAR_AGENT_ACTOR")
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
                principals, handle = await self._network_acp(
                    deepcopy(actors), compose, compose_reopen, project_settings, project_mcp
                )
                tokens = [(entry["token_file"], entry) for entry in principals]
                for filename, _ in tokens:
                    read_token(filename)
                await resume_sessions(self, resume_open, compose_reopen, project_mcp)
                self._acp_server = await listen_websocket(
                    listen,
                    tokens,
                    ACP_PROTOCOL,
                    handle,
                    tls,
                )
                return self._acp_server
            from ._acp_interface import _Interface

            await self._install_acp_mcp(project_mcp)
            interface = _Interface(
                self,
                compose,
                compose_reopen,
                project_settings,
                project_mcp,
                scope=stdio_scope,
                rights=stdio_rights,
                stdio_actor=stdio_actor,
                stdio_trace_trusted=trace_trusted,
            )
            await self._h.load(interface)
            await resume_sessions(self, resume_open, compose_reopen, project_mcp)
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
                for owner in self._resumed.values():
                    await owner.close()
                self._resumed.clear()
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
    interface_tools: Sequence[InterfaceToolSource] = (),
    plugins: Sequence[Plugin] = (),
    process_plugins: Sequence[ProcessPlugin | JsonObject] | None = None,
    service_plugins: Sequence[ServicePlugin] | None = None,
    service_ping_interval: float = 30.0,
    service_control_timeout: float = 5.0,
    plugin_host: bool | None = None,
    model: str | ModelRef | None = None,
    settings: JsonObject | None = None,
    approval: Approval | None = None,
    approval_covers_nested: bool = False,
    on_question: QuestionHandler | None = None,
    local_process_groups: bool = False,
    commands: bool = False,
    conformance: bool = False,
    several_actors: bool = False,
    session_limits: bool = False,
    tenants: Mapping[str, Tenant] | None = None,
    agent_name: str | None = None,
    job_reports_start_turns: bool = False,
    late_answers_start_turns: bool = False,
    max_approval_wait: float | None = None,
    resource_reservations: Mapping[str, Mapping[str, int]] | None = None,
) -> AgentStart:
    async def build() -> Agent:
        return await build_with_store()

    async def build_with_store(memory_store: _MemoryHistory | None = None) -> Agent:
        if not isinstance(approval_covers_nested, bool):
            raise AgentError(ErrorCode.INVALID_PARAMS, "approval_covers_nested must be a boolean")
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
        try:
            h = Harness(
                process_plugins=(),
                agent_name=agent_name,
                tenants=tenants or {},
                reservations={k: dict(v) for k, v in resource_reservations.items()}
                if resource_reservations is not None
                else None,
            )
        except Exception as exc:
            scratch.cleanup()
            raise AgentError(ErrorCode.INVALID_COMPOSITION, str(exc)) from exc
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
            local = None
            if isinstance(environment, MemoryEnvironment):
                await h.load(environment)
            else:
                local = local_for_platform(
                    local_root, point_store="git", linux_process_groups=local_process_groups
                )
                await h.load(local)
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
            if approval_covers_nested:
                questions.route_eligibility["sdk-handler"] = lambda q: (
                    not q.get("coversNested")
                    or ("user", None) in agent._live_views.get(q["id"], ())
                )
                h.observe_delivery("embedding", "user", lambda _: True, agent._delivered)
            else:
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
                await h.load(_Approval(covers_nested=approval_covers_nested))
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
            if durability != "ephemeral":
                receipt_root = (
                    store.root
                    if isinstance(store, History)
                    else root
                    if data_dir
                    else Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
                    / "modular-agent"
                )
                agent._receipt_store = ReceiptStore(receipt_root)
                h.erase_host_reads = agent._receipt_store.erase
            environment_owner = h.capabilities["environment"][0]
            if (
                data_dir is None
                and durability != "ephemeral"
                and h.plugins[environment_owner] is local
            ):
                raise ValueError("Local environment recovery needs data_dir")
            if interface_tools:
                registered, routes = interface_registrations(interface_tools)
                existing = await h.call("@harness", "tools", "definitions", {})
                if set(registered) & {tool["name"] for tool in existing} or SOURCE in h.plugins:
                    raise ValueError("Conflicting Interface tool registration")
                h.interface_tools, h.interface_routes = registered, routes
                h.interface_advertisements = {
                    tool["name"]: deepcopy(tool)
                    for spec in interface_tools
                    for tool in spec["tools"]
                }
                if not h.interface_enabled():
                    raise ValueError("The Runtime does not support Interface tools")
                if hasattr(h, "external_tool_names"):
                    h.external_tool_names.update(
                        {
                            name: (SOURCE, registration[0])
                            for name, registration in registered.items()
                        }
                    )
            runtime_owner = h.capabilities["runtime"][0]
            continues = bool(h.plugins[runtime_owner].declarations.get("durable"))
            # Offline ACP fixtures exercise both Runtime kinds with persistent
            # history. The registered Runtime still determines recovery.
            if not (conformance and durability != "ephemeral") and continues != (
                durability == "durable"
            ):
                raise ValueError("Runtime does not match the requested durability")
            if max_approval_wait is not None:
                declaration = agent.declaration()
                if (
                    "approval" not in h.plugins
                    or not all(
                        declaration.get(k)
                        for k in (
                            "portableSessions",
                            "questionsOutlastTurns",
                            "lateAnswersStartTurns",
                        )
                    )
                    or not h.plugins[runtime_owner].declarations.get("interface_tools")
                ):
                    raise AgentError(
                        ErrorCode.INVALID_COMPOSITION,
                        "Waiting approval needs a positive Duration, kept history, approval and a Runtime with late and empty-call continuations",
                    )
                h.max_approval_wait_ms = duration_ms(
                    max_approval_wait, "max_approval_wait", ErrorCode.INVALID_COMPOSITION
                )
            h.validate_wait_setting(defaults)
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
