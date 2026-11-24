"""ACP stdio Interface. The official SDK owns framing, routing and schema validation."""

import asyncio
from contextvars import ContextVar
import functools
from importlib.metadata import version as _package_version
from inspect import signature
import json
from pathlib import Path

import acp
from acp import schema as s
from ma_core import telemetry as ot
from ma_core import AgentError, Plugin, content, lower_reasoning

from ma_harness.authority import PERMISSIONS

from . import binding
from .stdio import MAX_FRAME, REPLY_VIEW, UPDATE_VIEW, Stdio, encode


NAMESPACE = "modular-agent"
OUTPUT_SESSION = ContextVar("acp_output_session", default=None)
EXTENSIONS = [
    "history",
    "input",
    "requests",
    "cancel-job",
    "interrupted",
    "actors",
    "join",
    "leave",
    "release",
    "proposals",
    "limit",
    "tenant",
    # Pre-binding Python host aliases remain available for existing clients.
    "declaration",
    "follow",
    "submit",
    "withdraw",
    "command",
    "move",
    "fork",
    "erase",
    "jobs",
    "job_cancel",
    "questions",
    "answer",
    "tool",
]


def withheld():
    return acp.RequestError(-32000, "Output withheld", {"code": "withheld"})


def protocol_error(code, message, **details):
    return acp.RequestError(
        -32000
        if code in {"lost", "held", "withheld", "message_too_large", "result_too_large"}
        else -32602,
        message,
        {"code": code, **details},
    )


def lease_refused_open(method, details):
    return (
        method in {"session/load", "session/resume"}
        and isinstance(details, dict)
        and details.get("code") in {"held", "lost"}
    )


def rpc(fn):
    methods = {
        "new_session": "session/new",
        "load_session": "session/load",
        "resume_session": "session/resume",
        "list_sessions": "session/list",
        "close_session": "session/close",
        "set_config_option": "session/set_config_option",
        "prompt": "session/prompt",
        "cancel": "session/cancel",
        "initialize": "initialize",
    }

    parameters = signature(fn)

    @functools.wraps(fn)
    async def checked(self, *args, **kwargs):
        bound = parameters.bind_partial(self, *args, **kwargs).arguments
        params = bound.get("params") or {}
        token = OUTPUT_SESSION.set(
            bound.get("session_id") or params.get("sessionId") or params.get("session")
        )
        scope = self.project_scope()
        try:
            metadata = params.get("_meta") if fn.__name__ == "ext_method" else kwargs
            trusted = self.trace_trusted
            parent = ot.extract(metadata if trusted and fn.__name__ != "initialize" else None)
            with ot.use(parent):
                return await gated(self, *args, **kwargs)
        finally:
            self.reset_project_scope(scope)
            OUTPUT_SESSION.reset(token)

    async def gated(self, *args, **kwargs):
        method = "_" + args[0] if fn.__name__ == "ext_method" else methods[fn.__name__]
        try:
            sid = OUTPUT_SESSION.get()
            if (
                (prepared := REPLY_VIEW.get()) is not None
                and sid in self.sessions
                and self.guards_frame(method)
            ):
                prepared[:] = [sid, await self.frame_revision(sid)]
            result = await fn(self, *args, **kwargs)
            if result is None:
                return None
            raw = (
                result.model_dump(mode="json", by_alias=True, exclude_none=True)
                if hasattr(result, "model_dump")
                else result
            )
            sid = OUTPUT_SESSION.get()
            if method == "session/new":
                sid = raw["sessionId"]
            await self.check_delivery(sid, method)
            view = await self.view(raw, sid, method=method)
            if view is None:
                raise withheld()
            try:
                if method in {"_modular-agent/requests", "_modular-agent/history"}:
                    await self.finish_question_view(method, raw, view)
                if method == "_modular-agent/history":
                    while len(encode(view)) > 4 << 20:
                        if len(view["entries"]) <= 1:
                            raise protocol_error(
                                "result_too_large", "History entry exceeds page size"
                            )
                        view["entries"].pop()
                        view["nextEntryId"] = view["entries"][-1]["id"]
                outgoing = (
                    type(result).model_validate(view) if hasattr(result, "model_validate") else view
                )
                if method in {"session/load", "session/resume"}:
                    sid = OUTPUT_SESSION.get()
                    if sid and sid not in self.sessions:
                        await self.attach(sid, replay=method == "session/load")
                await self.check_delivery(sid, method)
                return outgoing
            except ValueError:
                raise withheld() from None
        except acp.RequestError as exc:
            if isinstance(exc.data, dict) and exc.data.get("code") == "withheld":
                raise
            error = exc
        except AgentError as exc:
            code = {
                "invalid_request": "invalid_params",
                "unknown_session": "forbidden",
                "locked": "busy",
            }.get(exc.code, exc.code)
            wait = getattr(exc, "body", {}).get("retryAfterMs")
            if method == "_modular-agent/fork" and code == "result_too_large":
                error = acp.RequestError(-32602, str(exc), {"code": code})
            else:
                error = protocol_error(
                    code, str(exc), **({"retryAfterMs": wait} if code == "held" and wait else {})
                )
        except (ValueError, KeyError, TypeError):
            error = protocol_error("invalid_params", "Invalid parameters")
        except Exception as exc:
            error = acp.RequestError.internal_error({"reason": type(exc).__name__})
        if isinstance(error.data, dict) and error.data.get("code") in {
            "forbidden",
            "not_open",
            "wrong_project",
        }:
            raise error from None
        try:
            # A lease refusal follows visibility authorization but precedes
            # attachment. It has no session content and still uses the output gate.
            needs_attachment = not lease_refused_open(method, error.data)
            if needs_attachment:
                await self.check_delivery(OUTPUT_SESSION.get(), method)
            view = await self.view(error.to_error_obj(), method=method)
            if needs_attachment:
                await self.check_delivery(OUTPUT_SESSION.get(), method)
            if view is None:
                raise ValueError("Blocked error")
            outgoing = acp.RequestError(view["code"], view["message"], view.get("data"))
        except acp.RequestError as exc:
            outgoing = exc
        except Exception:
            outgoing = withheld()
        raise outgoing from None

    return checked


def text_block(text):
    return s.TextContentBlock(type="text", text=text)


def tool_content(parts):
    return [
        s.ContentToolCallContent(
            type="content",
            content=text_block(p["text"] if p.get("type") == "text" else json.dumps(p)),
        )
        for p in parts
    ]


class ACP(Plugin):
    name = "acp"
    role = "interface"
    declarations = {
        "protocol": "ACP",
        "version": 1,
        "transport": "stdio",
        "text_input": True,
        "permissions": True,
        "form_elicitation": True,
        "secret_intake": False,
        "extension_namespace": NAMESPACE,
        "extensions": EXTENSIONS,
        "authentication": "local stdio owner",
        "one_project_per_process": True,
    }

    def __init__(self, project, settings=None, *, actor="user"):
        self.actor = actor
        self.principal = {"id": actor, "kind": "host", "rights": sorted(PERMISSIONS)}
        self.network = False
        self.trace_trusted = True
        self.represents = frozenset()
        self.project = str(Path(project).resolve())
        self.settings = settings or {}
        self.client = None
        self.initialized = False
        self.client_capabilities = s.ClientCapabilities()
        self.sessions = set()
        self.presence = {}
        self.requests = {}
        self.approval_views = set()
        self.streamed = set()
        self.tool_output = {}
        self.prompts = set()
        self.lifecycle = asyncio.Lock()
        self.opening = None
        self.creating = False
        self.returned_on_open = {}

    async def start(self, api):
        await super().start(api)
        api.provide("acp", self)
        api.follow(self.actor, self.event)
        api.on("session.start", self.session_started, "last")
        api.on("session.end", self.session_ended, "last")
        api.on("session.suspend", self.session_ended, "last")
        api.on("session.invalidate", self.invalidate)

    def on_connect(self, conn):
        self.client = conn

    def ready(self):
        if not self.initialized:
            raise acp.RequestError.invalid_request({"reason": "Initialize first"})

    def project_scope(self):
        return None

    def reset_project_scope(self, token):
        pass

    async def select_project(self, project, session_id=None):
        pass

    def cwd(self, cwd, additional_directories=None, **kwargs):
        self.ready()
        project = Path(cwd).resolve()
        if (
            not Path(cwd).is_absolute()
            or (self.declarations["one_project_per_process"] and str(project) != self.project)
            or not project.is_dir()
        ):
            raise acp.RequestError.invalid_params({"project": self.project})
        if additional_directories or kwargs.get("system_prompt"):
            raise acp.RequestError.invalid_params(
                {"reason": "Additional roots and system prompt overrides are not supported"}
            )
        return str(project)

    async def check_session(self, sid):
        self.ready()
        if sid not in self.sessions:
            await self.require_visible_session(None, sid)
            raise protocol_error("not_open", "Session is not open on this connection")
        # The Harness checks the right for each operation. A proposal or
        # cancellation does not require watch.
        await self.rights(sid)

    async def get(self, sid, *, include_entries=True):
        await self.check_session(sid)
        return await self.api.session(
            "get", session=sid, actor=self.actor, include_entries=include_entries
        )

    async def rights(self, sid):
        return await self.api.session("authority", session=sid, actor=self.actor)

    async def view(self, value, sid=None, *, already_gated=False, method=None, event_type=None):
        if isinstance(value, dict):
            sid = sid or value.get("sessionId") or value.get("session")
        return await self.api.session(
            "view",
            value=value,
            recipient=self.actor,
            session=sid or OUTPUT_SESSION.get(),
            alreadyGated=already_gated,
            **({"type": "reply", "method": method} if method else {}),
            **({"type": event_type} if event_type else {}),
        )

    async def check_delivery(self, sid, method=None):
        if sid is None or method in {
            "session/close",
            "session/new",
            "_modular-agent/leave",
            "_modular-agent/input",
            "_modular-agent/answer",
        }:
            return
        if (
            sid not in self.sessions
            and sid != self.opening
            and method
            not in {
                "session/load",
                "session/resume",
            }
        ):
            # Errors for unattached sessions carry no session content.
            if method is not None:
                return
            raise protocol_error("not_open", "Session is not open on this connection")
        try:
            allowed = "watch" in await self.rights(sid)
        except AgentError:
            allowed = False
        if not allowed:
            raise protocol_error("forbidden", "Session inaccessible")

    async def update(self, sid, update, *, stream=False):
        # Event-derived updates are already gated, but configuration and other
        # directly constructed protocol updates must pass the same gate too.
        revision = await self.frame_revision(sid)
        value = await self.view(
            {
                "sessionId": sid,
                "update": update.model_dump(
                    mode="json",
                    by_alias=True,
                    exclude_none=True,
                ),
            },
            already_gated=stream,
        )
        if value is not None:
            try:
                await self.check_delivery(sid)
            except acp.RequestError:
                return
            if not self.client:
                return
            prepared = UPDATE_VIEW.set([sid, revision])
            try:
                await self.client.session_update(
                    session_id=value["sessionId"],
                    update=type(update).model_validate(value["update"]),
                )
            finally:
                UPDATE_VIEW.reset(prepared)

    async def session_started(self, d):
        if self.creating and not d.get("child"):
            await self.attach(d["session"], replay=False)

    async def attach(self, sid, *, replay):
        self.sessions.add(sid)
        if replay and "watch" in await self.rights(sid):
            # Replay is part of opening, BEFORE the Harness schedules recovery.
            for entry in await self.api.session("branch", session=sid, actor=self.actor):
                value = await self.view(entry, sid, event_type="entry")
                if value is not None:
                    await self.entry(sid, value, replay=True)
        await self.set_presence(sid, self.actor, True)
        if self.represents and "watch" in await self.rights(sid):
            for actor in sorted(self.represents & (await self.get(sid))["actors"].keys()):
                await self.set_presence(sid, actor, True)
        if replay:
            for q in await self.api.call(
                "questions", "list", {"session": sid, "actor": self.actor}
            ):
                if q["answerable"]:
                    view = await self.view(q, sid)
                    if view is not None:
                        await self.event(
                            {"kind": "input_request_opened", "session": sid, "request": view}
                        )

    async def session_ended(self, d):
        sid = d["session"]
        self.sessions.discard(sid)
        self.presence.pop(sid, None)
        self.approval_views = {key for key in self.approval_views if key[0] != sid}
        await self._cancel_requests(sid)
        if d.get("interrupted"):
            self.tool_output = {k: v for k, v in self.tool_output.items() if k[0] != sid}
            self.streamed = {k for k in self.streamed if k[0] != sid}
            return  # Do not try to commit declines with a fenced writer.
        # Runtime suspension runs first. Closed transports cannot preserve an
        # unanswered approval as permission to execute after a restart.
        questions = (
            await self.api.call("questions", "list", {"session": sid, "actor": self.actor})
            if "watch" in await self.rights(sid)
            else []
        )
        for q in questions:
            if q["kind"] == "approval" and not q.get("approvalWait") and q["answerable"]:
                await self.api.call(
                    "questions",
                    "answer",
                    {
                        "session": sid,
                        "actor": self.actor,
                        "request": q["id"],
                        "value": "declined",
                    },
                )
        self.tool_output = {k: v for k, v in self.tool_output.items() if k[0] != sid}
        self.streamed = {k for k in self.streamed if k[0] != sid}

    async def invalidate(self, d):
        if d.get("reason") in {"erasure", "move", "cancelled"}:
            self.tool_output = {k: v for k, v in self.tool_output.items() if k[0] != d["session"]}

    @rpc
    async def initialize(self, protocol_version, client_capabilities=None, **kwargs):
        if self.initialized:
            raise protocol_error("already_initialized", "Already initialized")
        requested = kwargs.get(NAMESPACE, {}).get("binding", binding.BINDING)
        if protocol_version != 1 or requested not in {binding.BINDING, "modular-agent-acp/2"}:
            raise protocol_error("unsupported_version", "Unsupported binding version")
        self.client_capabilities = client_capabilities or s.ClientCapabilities()
        self.initialized = True
        self.binding = requested if requested == "modular-agent-acp/2" else binding.BINDING
        # https://agentclientprotocol.com/protocol/v1/initialization
        return s.InitializeResponse(
            protocol_version=1,
            auth_methods=[],
            agent_info=s.Implementation(
                name="modular-agent-py", version=_package_version("ma-acp")
            ),
            field_meta={
                NAMESPACE: {
                    "binding": self.binding,
                    "declaration": await self.declaration(),
                    "extensions": EXTENSIONS,
                    "actor": self.principal,
                }
            },
            agent_capabilities=s.AgentCapabilities(
                load_session=True,
                mcp_capabilities=s.McpCapabilities(http=True, sse=False),
                session_capabilities=s.SessionCapabilities(
                    list=s.SessionListCapabilities(),
                    resume=s.SessionResumeCapabilities(),
                    close=s.SessionCloseCapabilities(),
                ),
                field_meta={
                    NAMESPACE: {
                        "version": 1,
                        **(
                            {"project": self.project}
                            if self.declarations["one_project_per_process"]
                            else {}
                        ),
                        "methods": ["_modular-agent/" + x for x in EXTENSIONS],
                        "events": "_modular-agent/event",
                        "secretIntake": False,
                    }
                },
            ),
        )

    async def options(self, sid):
        session = await self.api.session("config_view", session=sid, actor=self.actor)
        catalog = session["catalog"]
        selected = session["settings"]["model"]
        access = next((m for m in catalog if selected in {m["id"], binding.model_id(m)}), None)

        def option(id, label, category, values, current=None):
            return s.SessionConfigOptionSelect(
                id=id,
                name=label,
                category=category,
                current_value=current or session["settings"].get(id, "off"),
                options=[s.SessionConfigSelectOption(value=v, name=v) for v in values],
            )

        return [
            option(
                "model",
                "Model",
                "model",
                [binding.model_id(m) for m in catalog],
                binding.model_id(access) if access else selected,
            ),
            option(
                "thinking",
                "Thinking level",
                "thought_level",
                access.get("thinking", []) if access else [],
                lower_reasoning(session["settings"].get("thinking"), access.get("thinking", []))
                if access
                else None,
            ),
            option(
                "approval",
                "Approval policy",
                "mode",
                list(binding.APPROVAL),
                next(
                    (
                        k
                        for k, v in binding.APPROVAL.items()
                        if v == session["settings"].get("approval", "ask always")
                    ),
                    "never",
                ),
            ),
        ] + (
            [
                option(
                    "approvalWait",
                    "Approval wait",
                    "mode",
                    ["live", "untilDeadline"],
                    session["settings"].get("approvalWait", "live"),
                )
            ]
            if (await self.declaration(sid)).get("approvalsOutlastTurns")
            else []
        )

    def new_session_settings(self, project):
        return self.settings

    def tenant_allowed(self, tenant):
        return True

    def session_create_rights(self, tenant, has_mcp):
        return self.principal["rights"]

    async def visible_sessions(self, project):
        return await self.api.session("list", project=project)

    async def require_visible_session(self, project, sid):
        if not any(row["id"] == sid for row in await self.visible_sessions(project)):
            raise protocol_error("forbidden", "Session inaccessible")

    @rpc
    async def new_session(self, cwd, mcp_servers=None, additional_directories=None, **kwargs):
        project = self.cwd(cwd, additional_directories, **kwargs)
        tenant = (kwargs.get(NAMESPACE) or {}).get("tenant")
        if not self.tenant_allowed(tenant):
            raise protocol_error("forbidden", "Tenant outside connection scope")
        async with self.lifecycle:
            await self.select_project(project)
            authority = self.session_create_rights(tenant, bool(mcp_servers))
            self.creating = True
            try:
                session = await self.api.session(
                    "create",
                    project=project,
                    defer_setup=True,
                    actor=self.actor,
                    actor_kind=self.principal["kind"],
                    authority=authority,
                    settings=self.new_session_settings(project),
                    tenant=tenant,
                    mcp_servers=[
                        x.model_dump(mode="json", by_alias=True, exclude_none=True)
                        for x in mcp_servers or []
                    ],
                )
            except AgentError as exc:
                if exc.code != "invalid_request":
                    raise
                raise acp.RequestError.invalid_params({"reason": str(exc)}) from exc
            finally:
                self.creating = False
        return s.NewSessionResponse(
            session_id=session["id"],
            config_options=await self.options(session["id"]),
            field_meta={NAMESPACE: await self.session_metadata(session["id"])},
        )

    async def _open(self, cwd, sid, mcp_servers, replay, additional_directories, kwargs):
        project = self.cwd(cwd, additional_directories, **kwargs)
        if self.lifecycle.locked():
            raise protocol_error("busy", "Session lifecycle operation in progress")
        async with self.lifecycle:
            # Authorize stored scope before giving a project factory the ID.
            await self.require_visible_session(project, sid)
            await self.select_project(project, sid)
            self.opening = sid
            self.returned_on_open[sid] = []
            try:
                attachments = [
                    x.model_dump(mode="json", by_alias=True, exclude_none=True)
                    for x in mcp_servers or []
                ]
                await self.api.session(
                    "open",
                    session=sid,
                    actor=self.actor,
                    connection_host=not self.network,
                    **({"mcp_servers": attachments} if attachments or not self.network else {}),
                )
            finally:
                self.opening = None
        # https://agentclientprotocol.com/protocol/v1/session-setup
        # load replays; resume MUST NOT replay. Both restore state before replying.
        return {
            "config_options": await self.options(sid),
            "field_meta": {NAMESPACE: await self.session_metadata(sid)},
        }

    @rpc
    async def load_session(
        self, cwd, session_id, mcp_servers=None, additional_directories=None, **kwargs
    ):
        return s.LoadSessionResponse(
            **await self._open(cwd, session_id, mcp_servers, True, additional_directories, kwargs)
        )

    @rpc
    async def resume_session(
        self, session_id, cwd, mcp_servers=None, additional_directories=None, **kwargs
    ):
        return s.ResumeSessionResponse(
            **await self._open(cwd, session_id, mcp_servers, False, additional_directories, kwargs)
        )

    @rpc
    async def list_sessions(self, cwd=None, cursor=None, **kwargs):
        self.ready()
        if cwd is not None and not Path(cwd).is_absolute():
            raise acp.RequestError.invalid_params({"reason": "cwd must be absolute"})
        if cursor is not None:
            raise acp.RequestError.invalid_params({"reason": "Listing has one complete page"})
        rows = {r["id"]: r for r in await self.visible_sessions(cwd)}
        return s.ListSessionsResponse(
            sessions=[
                s.SessionInfo(
                    session_id=r["id"],
                    cwd=r["project"],
                    field_meta={NAMESPACE: {"waiting": r["waiting"]}} if "waiting" in r else None,
                )
                for r in rows.values()
            ]
        )

    @rpc
    async def close_session(self, session_id, **kwargs):
        self.ready()
        if self.lifecycle.locked():
            raise protocol_error("busy", "Session lifecycle operation in progress")
        if session_id not in self.sessions:
            raise protocol_error("not_open", "Session is not open")
        async with self.lifecycle:
            await self.api.session("close", session=session_id, actor=self.actor)
        return s.CloseSessionResponse()

    @rpc
    async def set_config_option(self, config_id, session_id, value, **kwargs):
        await self.check_session(session_id)
        option = next((o for o in await self.options(session_id) if o.id == config_id), None)
        if option is None or value not in {o.value for o in option.options}:
            raise acp.RequestError.invalid_params(
                {"reason": "Unknown configuration option or value"}
            )
        changes = {config_id: value}
        if config_id == "approval":
            changes["approval"] = binding.APPROVAL[value]
        if config_id == "model":
            session = await self.api.session("config_view", session=session_id, actor=self.actor)
            model = next(m for m in session["catalog"] if binding.model_id(m) == value)
            changes["model"] = model["id"]
            changes["thinking"] = lower_reasoning(
                session["settings"].get("thinking"), model.get("thinking", [])
            )
        await self.api.session("settings", session=session_id, actor=self.actor, changes=changes)
        options = await self.options(session_id)
        metadata = {NAMESPACE: await self.session_metadata(session_id)}
        await self.update(
            session_id, s.ConfigOptionUpdate(config_options=options, field_meta=metadata)
        )
        return s.SetSessionConfigOptionResponse(config_options=options, field_meta=metadata)

    @rpc
    async def prompt(self, session_id, prompt, **kwargs):
        await self.get(session_id, include_entries=False)
        if session_id in self.prompts:
            raise AgentError("One ACP prompt at a time; use the declared submit extension to steer")
        if any(p.type != "text" for p in prompt):
            raise acp.RequestError.invalid_params({"reason": "Only text input is supported"})
        metadata = kwargs.get(NAMESPACE, {})
        self.check_key(metadata)
        self.prompts.add(session_id)
        try:
            receipt = await self.api.call(
                "runtime",
                "submit",
                {
                    "session": session_id,
                    "actor": self.actor,
                    "commands": False,
                    "content": [
                        p.model_dump(mode="json", by_alias=True, exclude_none=True) for p in prompt
                    ],
                    **{k: metadata[k] for k in ("key", "when") if k in metadata},
                },
            )
            if receipt.get("erased"):
                return s.PromptResponse(stop_reason="end_turn", field_meta={NAMESPACE: receipt})
            if receipt.get("handled"):
                await self.update(
                    session_id,
                    s.AgentMessageChunk(
                        content=text_block(json.dumps(await self.view(receipt["result"])))
                    ),
                )
                return s.PromptResponse(
                    stop_reason="end_turn", field_meta={NAMESPACE: await self.view(receipt)}
                )
            # A duplicate describes its original turn, even if another turn is
            # now running. A closing session may disappear before wait returns.
            if receipt.get("duplicate") and any(
                e["kind"] == "input_withdrawn"
                and receipt["input"] in (e["data"].get("inputIds") or [e["data"].get("input")])
                for e in (await self.get(session_id))["entries"]
            ):
                raise protocol_error("conflict", "Input was handed back")
            results = await self.api.call(
                "runtime",
                "wait",
                {"session": session_id, "actor": self.actor, "input": receipt["input"]},
            )
            result = next(iter(results), {"outcome": "cancelled", "handed_back": []})
            metadata = {
                "inputId": receipt["input"],
                "duplicate": receipt.get("duplicate", False),
                "outcome": binding.outcome(result),
                "openToolCalls": result.get("open_calls", []),
                # Additional legacy fields for pre-binding Python hosts.
                "receipt": receipt,
                "result": result,
            }
            if result["outcome"] == "cancelled":
                metadata["handedBack"] = result.get("handed_back", [])
            if result["outcome"] == "failed" and self.binding == "modular-agent-acp/2":
                raise acp.RequestError(
                    -32000,
                    str(result.get("error") or "Turn failed"),
                    {"_meta": {NAMESPACE: metadata}},
                )
            return s.PromptResponse(
                stop_reason=binding.stop_reason(result), field_meta={NAMESPACE: metadata}
            )
        finally:
            self.prompts.discard(session_id)

    @rpc
    async def cancel(self, session_id, **kwargs):
        await self.get(session_id, include_entries=False)
        await self.api.call("runtime", "cancel", {"session": session_id, "actor": self.actor})
        await self._cancel_requests(session_id)

    async def declaration(self, sid=None):
        plugins = await self.api.session(
            "declaration", **({"session": sid, "actor": self.actor} if sid else {})
        )
        provider = None
        if sid:
            session = await self.api.session("config_view", session=sid, actor=self.actor)
            catalog = session["catalog"]
            provider = next(
                (
                    m["provider"]
                    for m in catalog
                    if session["settings"]["model"] in {m["id"], binding.model_id(m)}
                ),
                {},
            )
        return binding.declaration(plugins, provider)

    async def session_metadata(self, sid):
        declaration = await self.declaration(sid)
        returned = self.returned_on_open.pop(sid, [])
        return {
            "declaration": declaration,
            "plugins": declaration["plugins"],
            **({"handedBack": returned} if returned else {}),
        }

    async def entry(self, sid, e, replay=False):
        kind, parts = e["kind"], e.get("content", [])
        if kind == "input" and replay:
            for part in parts:
                await self.update(
                    sid, s.UserMessageChunk(content=text_block(part.get("text", json.dumps(part))))
                )
        elif kind == "response":
            for part in parts:
                kind = "reasoning" if part.get("type") == "reasoning" else "text"
                if not replay and (sid, e.get("step"), kind) in self.streamed:
                    continue
                if kind == "reasoning" and not isinstance(part.get("text"), str):
                    continue
                cls = s.AgentThoughtChunk if kind == "reasoning" else s.AgentMessageChunk
                await self.update(sid, cls(content=text_block(part.get("text", json.dumps(part)))))
        elif kind == "tool_call":
            call = e["data"]
            await self.update(
                sid,
                s.ToolCallStart(
                    tool_call_id=e["call"],
                    title=call["name"],
                    name=call["name"],
                    status="pending",
                    raw_input=call["input"],
                    field_meta={NAMESPACE: {"parentToolCallId": call["parentCallId"]}}
                    if call.get("parentCallId")
                    else None,
                ),
            )
        elif kind == "tool_started":
            await self.update(sid, s.ToolCallProgress(tool_call_id=e["call"], status="in_progress"))
        elif kind == "tool_deferred":
            await self.update(sid, s.ToolCallProgress(tool_call_id=e["call"], status="pending"))
        elif kind == "tool_result":
            status = e["data"]["status"]
            self.tool_output.pop((sid, e["call"]), None)
            await self.update(
                sid,
                s.ToolCallProgress(
                    tool_call_id=e["call"],
                    status="completed" if status == "completed" else "failed",
                    content=tool_content(parts),
                    field_meta={NAMESPACE: {"status": status}},
                ),
            )

    async def event(self, e):
        sid = e.get("session")
        if not self.client:
            return
        if e["kind"] == "input_returned" and sid == self.opening:
            if "watch" in await self.rights(sid):
                self.returned_on_open.setdefault(sid, []).append(
                    {"inputId": e["input"], "content": e["content"]}
                )
            return
        if sid not in self.sessions or "watch" not in await self.rights(sid):
            return
        # This event is already a gated view, never retrieve the raw event here.
        if e["kind"] == "session_interrupted":
            # The binding's projection (docs/bindings/acp.md, Updates); the library adds the "_".
            await self.client.ext_notification(
                "modular-agent/interrupted", {"sessionId": sid, "reason": e["reason"]}
            )
            return
        if e["kind"] == "model_output" and e.get("text"):
            stream_type = e.get("stream_type", "text")
            self.streamed.add((sid, e.get("step"), stream_type))
            cls = s.AgentThoughtChunk if stream_type == "reasoning" else s.AgentMessageChunk
            await self.update(sid, cls(content=text_block(e["text"])), stream=True)
        elif e["kind"] == "history_entry":
            entry = e["entry"]
            if entry["kind"] == "actor_left":
                self.presence.get(sid, set()).discard(entry["data"]["actorId"])
            await self.entry(sid, entry)
        elif e["kind"] == "tool_progress" and e.get("text"):
            key = sid, e["call"]
            self.tool_output[key] = self.tool_output.get(key, "") + e["text"]
            await self.update(
                sid,
                s.ToolCallProgress(
                    tool_call_id=e["call"], content=tool_content(content(self.tool_output[key]))
                ),
                stream=True,
            )
        elif e["kind"] == "turn_ended" and e.get("open_calls"):
            questions = await self.api.call(
                "questions", "list", {"session": sid, "actor": self.actor}
            )
            tasks = [
                self.requests[(sid, q["id"])]
                for q in questions
                if q.get("call") in e["open_calls"] and (sid, q["id"]) in self.requests
            ]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        elif e["kind"] == "input_request_opened":
            q = e["request"]
            key = sid, q["id"]
            entries = (await self.get(sid))["entries"]
            parked = any(
                x["kind"] == "turn_end" and x.get("turn") == q.get("turn") for x in entries
            )
            if not parked and not q.get("approvalWait") and key not in self.requests:
                task = asyncio.create_task(self.answer_request(sid, q))
                self.requests[key] = task
                task.add_done_callback(lambda done, key=key: self.requests.pop(key, None))
        elif e["kind"] in {"input_request_unanswerable", "input_request_answered"}:
            request = e.get("request") or e["answer"]["request"]
            task = self.requests.get((sid, request))
            if task and task is not asyncio.current_task():
                task.cancel()
        meta = self.client_capabilities.field_meta or {}
        if meta.get(NAMESPACE, {}).get("events") and self.client:
            await self.check_delivery(sid)
            await self.client.ext_notification("modular-agent/event", e)

    async def question_route(self, sid, q):
        for actor in (self.actor, *sorted(self.represents - {self.actor})):
            if actor not in self.presence.get(sid, ()):
                continue
            attribution = await self.attribution(sid, actor)
            questions = await self.api.call(
                "questions",
                "list",
                {"session": sid, **attribution, "recipientView": True, "openOnly": True},
            )
            if any(
                item["id"] == q["id"]
                and item["answerable"]
                and (not item.get("coversNested") or binding.question(item) == binding.question(q))
                for item in questions
            ):
                return attribution
        return None

    async def answer_request(self, sid, q):
        if q["kind"] not in {"approval", "text", "choice", "secret"}:
            return
        value = None
        try:
            attribution = await self.question_route(sid, q)
        except (AgentError, acp.RequestError):
            return
        if attribution is None:
            return
        answer = {"session": sid, "request": q["id"], **attribution}

        async def current_route():
            await self.check_delivery(sid)
            return attribution == await self.question_route(sid, q)

        try:
            if q["kind"] == "approval":
                exact = q.get("approval_call") or {}
                tool_call = s.ToolCallUpdate(
                    tool_call_id=q.get("call") or q["id"],
                    title=exact.get("name") or q["question"],
                    raw_input=exact.get("input"),
                    status="pending",
                    content=tool_content(content(q["question"])) if q.get("coversNested") else None,
                )
                options = [
                    s.PermissionOption(option_id="allow", name="Allow", kind="allow_once"),
                    s.PermissionOption(option_id="refuse", name="Refuse", kind="reject_once"),
                ]
                params = {
                    "sessionId": sid,
                    "toolCall": tool_call.model_dump(mode="json", by_alias=True, exclude_none=True),
                    "options": [
                        o.model_dump(mode="json", by_alias=True, exclude_none=True) for o in options
                    ],
                    "_meta": {
                        NAMESPACE: {
                            "requestId": q["id"],
                            "actorId": attribution["actor"],
                            **({"coversNested": True} if q.get("coversNested") is True else {}),
                        }
                    },
                }
                view = await self.view(
                    {"method": "session/request_permission", "params": params},
                    sid,
                    event_type="request",
                )
                if not await current_route():
                    return
                if view is None or view["params"] != params:
                    await self.api.call("questions", "answer", {**answer, "value": "declined"})
                    return
                self.approval_views.add((sid, q["id"]))
                response = await self.client.request_permission(
                    session_id=sid,
                    tool_call=tool_call,
                    options=options,
                    **{**params["_meta"], **(ot.inject() if self.trace_trusted else {})},
                )
                if response.outcome.outcome == "selected" and response.outcome.option_id in {
                    "allow",
                    "refuse",
                }:
                    value = response.outcome.option_id
            elif q["kind"] in {"text", "choice"}:
                capabilities = self.client_capabilities.elicitation
                if capabilities is None or capabilities.form is None:
                    return  # The host answers via requests/answer instead.
                if capabilities.form is not None:
                    prop = {"type": "string"}
                    if q["kind"] == "choice":
                        prop["enum"] = q["options"]
                    # Form mode is for non-sensitive data only, never secret questions.
                    view = await self.view(q, sid)
                    if view is None or not await current_route():
                        return
                    response = await self.client.create_elicitation(
                        message=view["question"],
                        mode=s.ElicitationFormSessionMode(
                            session_id=sid,
                            tool_call_id=q.get("call"),
                            requested_schema=s.ElicitationSchema(
                                properties={"answer": prop}, required=["answer"]
                            ),
                        ),
                        **(ot.inject() if self.trace_trusted else {}),
                    )
                    if response.action == "accept":
                        submitted = (response.content or {}).get("answer")
                        if isinstance(submitted, str) and (
                            q["kind"] == "text" or submitted in q["options"]
                        ):
                            value = submitted
            if await current_route():
                await self.api.call(
                    "questions", "answer", {**answer, "value": value, "declined": value is None}
                )
        except asyncio.CancelledError:
            raise
        except (AgentError, acp.RequestError, ConnectionError, EOFError):
            # A stale route or lost connection cannot stand in for an answer.
            return

    async def _cancel_requests(self, sid=None):
        tasks = [
            task
            for (session, _), task in list(self.requests.items())
            if sid is None or sid == session
        ]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    @rpc
    async def ext_method(self, method, params):
        self.ready()
        if not method.startswith("modular-agent/") or method.split("/", 1)[1] not in EXTENSIONS:
            raise acp.RequestError.method_not_found("_" + method)
        operation = method.split("/", 1)[1]
        if "sessionId" in params:
            return await self.bound_extension(operation, params)
        sid = params["session"]
        await self.get(sid)
        d = {k: v for k, v in params.items() if k not in {"actor", "authority", "session"}}
        base = {"session": sid, "actor": self.actor}
        if operation == "declaration":
            result = await self.declaration(sid)
        elif operation == "follow":
            es = (await self.get(sid))["entries"]
            point = params.get("after")
            if point is not None:
                if point not in {e["id"] for e in es}:
                    raise AgentError("Unknown follow point")
                es = es[next(i for i, e in enumerate(es) if e["id"] == point) + 1 :]
            result = {
                "entries": [ot.project_entry(e) for e in es],
                "questions": await self.api.call("questions", "list", base),
            }
        elif operation == "submit":
            result = await self.api.call(
                "runtime",
                "submit",
                {
                    **base,
                    "content": params["content"],
                    **{k: params[k] for k in ("key", "when") if k in params},
                },
            )
        elif operation == "withdraw":
            result = await self.api.call("runtime", "withdraw", {**base, "input": params["input"]})
        elif operation in {"move", "fork", "erase", "command"}:
            allowed = {
                "move": {"point", "rewind"},
                "fork": {"point"},
                "erase": {"entries"},
                "command": {"text"},
            }[operation]
            result = await self.api.session(
                operation, **base, **{k: d[k] for k in allowed if k in d}
            )
            if operation == "fork":
                self.sessions.add(result["id"])
                await self.api.call(
                    "questions", "connect", {"session": result["id"], "actor": self.actor}
                )
        elif operation in {"jobs", "job_cancel"}:
            result = await self.api.call(
                "jobs",
                "list" if operation == "jobs" else "cancel",
                {**base, **({"job": params["job"]} if operation == "job_cancel" else {})},
            )
        elif operation in {"questions", "answer"}:
            result = await self.api.call(
                "questions",
                "list" if operation == "questions" else "answer",
                {
                    **base,
                    **(
                        {"request": params["request"], "value": params["value"]}
                        if operation == "answer"
                        else {}
                    ),
                },
            )
        elif operation == "tool":
            result = await self.api.call(
                "runtime", "run_tool", {**base, "name": params["name"], "input": params["input"]}
            )
        else:
            raise acp.RequestError.method_not_found("_" + method)
        return {"value": await self.view(result)}

    async def bound_extension(self, operation, params):
        sid = params["sessionId"]
        await self.check_session(sid)
        # Proposals, release and withdraw also serve parked job reports.
        feature = {"limit": "sessionLimits", "tenant": "tenants"}.get(operation)
        actor = params.get("actorId", self.actor)
        represented = isinstance(actor, str) and actor != self.actor
        if (
            operation in {"actors", "join", "leave"}
            or (operation == "input" and (params.get("when") == "propose" or represented))
            or (operation == "answer" and represented)
        ):
            feature = "severalActors"
        if feature and (await self.declaration(sid)).get(feature) is not True:
            raise protocol_error("not_supported", "Feature is disabled in this session")
        base = {"session": sid, "actor": self.actor}
        if operation == "history":
            if "all" in params and not isinstance(params["all"], bool):
                raise ValueError("all must be boolean")
            entries = (
                (await self.get(sid))["entries"]
                if params.get("all", False)
                else await self.api.session("branch", **base)
            )
            after = params.get("after")
            if after is not None:
                index = next((i for i, e in enumerate(entries) if e["id"] == after), None)
                if index is None:
                    raise acp.RequestError.invalid_params({"reason": "Unknown history entry"})
                entries = entries[index + 1 :]
            limit = params.get("limit", 500)
            if type(limit) is not int or not 1 <= limit <= 500:
                raise protocol_error("invalid_params", "History limit must be 1 to 500")
            page, size = [], len(b'{"entries":[]}')
            for e in entries[:limit]:
                if e["kind"] == "question_open":
                    item = await self.view(binding.entry(e), sid, event_type="projected_entry")
                else:
                    view = await self.view(e, sid, event_type="entry")
                    item = binding.entry(view) if view is not None else None
                if item is None:
                    raise withheld()
                item_size = len(encode(item))
                cursor_size = (
                    len(encode({"nextEntryId": item["id"]})) - 1
                    if len(page) + 1 < len(entries)
                    else 0
                )
                if size + item_size + bool(page) + cursor_size > 4 * 1024 * 1024:
                    if not page:
                        raise acp.RequestError(
                            -32000, "History entry exceeds page size", {"code": "result_too_large"}
                        )
                    break
                size += item_size + bool(page)
                page.append(item)
            return {
                "entries": page,
                **({"nextEntryId": page[-1]["id"]} if len(page) < len(entries) else {}),
            }
        if operation == "limit":
            try:
                await self.api.session("limit", **base, rights=params["rights"])
            except AgentError as exc:
                raise acp.RequestError.invalid_params({"reason": str(exc)}) from exc
            return {}
        if operation == "tenant":
            return await self.api.session("tenant", **base)
        if operation == "actors":
            session = await self.get(sid)
            return {
                "actors": [
                    {"id": aid, "kind": a["kind"], "rights": a["authority"]}
                    for aid, a in session["actors"].items()
                ],
                "present": await self.api.call("questions", "present", base),
            }
        if operation in {"join", "leave"}:
            try:
                if operation == "join":
                    actor = params["actor"]
                    present = params.get("present", True)
                    if (
                        not isinstance(present, bool)
                        or not isinstance(actor["id"], str)
                        or not actor["id"]
                        or actor["kind"] not in {"user", "host", "agent", "program"}
                        or not isinstance(actor["rights"], list)
                    ):
                        raise ValueError("Invalid actor")
                    await self.api.session(
                        "grant",
                        **base,
                        subject=actor["id"],
                        kind=actor["kind"],
                        authority=actor["rights"],
                    )
                    if actor["id"] == self.actor or actor["id"] in self.represents:
                        await self.set_presence(sid, actor["id"], present)
                else:
                    await self.api.session("leave", **base, subject=params["actorId"])
                    self.presence.get(sid, set()).discard(params["actorId"])
                    await self.api.call(
                        "questions",
                        "disconnect",
                        {**base, "actor": params["actorId"], "all_routes": True},
                    )
            except AgentError as exc:
                raise acp.RequestError.invalid_params({"reason": str(exc)}) from exc
            return {}
        if operation == "proposals":
            return {"proposals": await self.api.call("runtime", "proposals", base)}
        if operation == "withdraw":
            try:
                return await self.api.call(
                    "runtime",
                    "withdraw_proposal",
                    {
                        **base,
                        "input": params["inputId"],
                        "acting_for": params.get("actorId", self.actor),
                    },
                )
            except AgentError as exc:
                raise acp.RequestError.invalid_params({"reason": str(exc)}) from exc
        if operation == "release":
            try:
                receipt = await self.api.call(
                    "runtime",
                    "release",
                    {
                        **base,
                        "input": params["inputId"],
                        "when": params.get("when", "now")
                        if params.get("declined")
                        else params["when"],
                        "declined": params.get("declined", False),
                    },
                )
            except AgentError as exc:
                raise acp.RequestError.invalid_params({"reason": str(exc)}) from exc
            return {"inputId": receipt["input"], "taken": self.taken(receipt["when"])}
        if operation == "input":
            self.check_key(params)
            parts = self.input_parts(params["content"])
            if params["when"] not in {"now", "steer", "after", "propose"}:
                raise ValueError("Unknown input timing")
            actor = params.get("actorId", self.actor)
            attribution = await self.attribution(sid, actor)
            try:
                rights = await self.api.session("authority", **base)
                receipt = await self.api.call(
                    "runtime",
                    "submit",
                    {
                        **base,
                        **attribution,
                        "authority": rights,
                        "content": parts,
                        "commands": False,
                        "when": params["when"],
                        **({"key": params["key"]} if "key" in params else {}),
                    },
                )
            except AgentError as exc:
                if exc.code != "invalid_request":
                    raise
                raise acp.RequestError.invalid_params({"reason": str(exc)}) from exc
            if receipt.get("erased"):
                return receipt
            if receipt.get("handled"):
                raise AgentError("Use the command extension for slash commands")
            return {
                "inputId": receipt["input"],
                "taken": self.taken(receipt["when"]),
                **({"duplicate": True} if receipt.get("duplicate") else {}),
            }
        if operation == "requests":
            # A withheld or changed replacement poll invalidates this delivery.
            if hasattr(self, "poll_route"):
                self.api._harness.forget_waits(sid, token=self.name)
            questions = await self.api.call("questions", "list", {**base, "recipientView": True})
            requests = [binding.question(q) for q in questions if q["answerable"]]
            return {"requests": requests}
        if operation == "answer":
            attribution = await self.attribution(sid, actor)
            answer_base = {**base, **attribution}
            rights = set(await self.rights(sid))
            if actor != self.actor:
                rights &= set(await self.api.session("authority", session=sid, actor=actor))
            if not rights.intersection({"answer", "approve"}):
                raise protocol_error("forbidden", "Actor cannot answer questions")
            try:
                question = next(
                    (
                        q
                        for q in await self.api.call("questions", "list", answer_base)
                        if q["id"] == params["requestId"] and q["answerable"]
                    ),
                    None,
                )
                if question is None:
                    return {"accepted": False, "reason": "not_open"}
                if question.get("approvalWait") and actor not in self.presence.get(sid, ()):
                    return {"accepted": False, "reason": "not_open"}
                if (
                    question["kind"] == "approval"
                    and (sid, question["id"]) not in self.approval_views
                ):
                    return {"accepted": False, "reason": "not_open"}
                return await self.api.call(
                    "questions",
                    "answer",
                    {
                        **answer_base,
                        "authority": await self.api.session("authority", **base),
                        "delivery_token": self.name,
                        "request": params["requestId"],
                        "value": params.get("value"),
                        "declined": params.get("declined", False),
                        "reason": params.get("reason"),
                    },
                )
            except AgentError as exc:
                if exc.code == "invalid_request":
                    raise protocol_error("invalid_params", str(exc)) from exc
                return {"accepted": False, "reason": "not_open"}
        if operation in {"move", "fork"}:
            try:
                if operation == "move":
                    await self.require_finished(sid)
                result = await self.api.session(
                    operation, **base, point=params["entryId"], rewind=params.get("rewind", False)
                )
            except OSError as exc:
                raise protocol_error("conflict", "Unable to restore the requested point") from exc
            if operation == "fork":
                await self.api.session("close", session=result["id"])
                return {"sessionId": result["id"]}
            return {"outOfReach": result["outOfReach"]} if result.get("outOfReach") else {}
        if operation == "erase":
            result = await self.api.session("erase", **base, entries=params["entryIds"])
            return {
                "erased": result.get("erasedPairs", []),
                "pending": result.get("pendingPairs", []),
                "outOfReach": result["out_of_reach"],
            }
        if operation == "jobs":
            return {
                "jobs": [
                    {k: j[k] for k in ("id", "kind", "state")}
                    for j in await self.api.call("jobs", "list", base)
                    if not j.get("historical")
                    and j["state"] in {"running", "unfinished", "cleanupUnconfirmed"}
                ]
            }
        if operation == "cancel-job":
            await self.api.call("jobs", "cancel", {**base, "job": params["jobId"]})
            return {}
        # Build-specific extensions also accept the binding's sessionId envelope.
        return (
            await self.ext_method(
                "modular-agent/" + operation,
                {
                    **{k: v for k, v in params.items() if k != "sessionId"},
                    "session": sid,
                },
            )
        )["value"]

    async def attribution(self, sid, actor):
        if actor == self.actor:
            return {"actor": actor}
        if not isinstance(actor, str) or actor not in self.represents:
            raise protocol_error("forbidden", "Connection does not represent that actor")
        if actor not in (await self.get(sid))["actors"]:
            raise protocol_error("forbidden", "Connection does not represent that actor")
        return {"actor": actor, "acting_for": self.actor}

    async def finish_question_view(self, method, raw, view):
        sid = OUTPUT_SESSION.get()
        if method == "_modular-agent/requests":
            pairs = zip(raw["requests"], view["requests"], strict=True)
        else:
            pairs = (
                (before["data"]["request"], after["data"]["request"])
                for before, after in zip(raw["entries"], view["entries"], strict=True)
                if before["kind"] == "inputRequest" and not before.get("erased")
            )
        pairs = list(pairs)
        if not pairs:
            return
        eligible = {
            q["id"]: q
            for q in await self.api.call(
                "questions", "list", {"session": sid, "actor": self.actor, "recipientView": True}
            )
            if q["answerable"]
        }
        for before, after in pairs:
            q = eligible.get(before["id"])
            if q is None:
                after["answerable"] = False
                continue
            approval = q["kind"] == "approval"
            from ma_core.wire import json_equal

            after["answerable"] = not approval or (
                json_equal(before, after) and json_equal(before, binding.question(q))
            )
            if q.get("approvalWait"):
                after["answerable"] = bool(
                    after["answerable"]
                    and method == "_modular-agent/requests"
                    and self.actor in self.presence.get(sid, ())
                )
                if method == "_modular-agent/requests" and hasattr(self, "poll_route"):
                    self.api._harness.remember_wait(
                        sid, self.name, self.actor, q["entry"], self.poll_route, after["answerable"]
                    )
            if approval and after["answerable"]:
                self.approval_views.add((sid, q["id"]))

    @staticmethod
    def taken(mode):
        return {"steer": "inTurn", "propose": "proposed"}.get(mode, mode)

    @staticmethod
    def check_key(metadata):
        if "key" in metadata and not isinstance(metadata["key"], str):
            raise ValueError("Input keys must be strings")

    @staticmethod
    def input_parts(value):
        parts = content(value) if isinstance(value, str) else value
        if not isinstance(parts, list) or any(
            not isinstance(p, dict) or p.get("type") != "text" or not isinstance(p.get("text"), str)
            for p in parts
        ):
            raise ValueError("Only text input is supported")
        return parts

    async def require_finished(self, sid):
        session = await self.get(sid)
        if session.get("busy"):
            raise AgentError("Cannot move during a turn", "busy")
        entries = await self.api.session("branch", session=sid, actor=self.actor)
        calls = {e["call"] for e in entries if e["kind"] == "tool_result"}
        questions = {
            e["data"]["request"]
            for e in entries
            if e["kind"] in {"question_answer", "question_closed"}
        }
        jobs = {e["job"] for e in entries if e["kind"] == "job_end"}
        if any(
            (e["kind"] == "tool_deferred" and e["call"] not in calls)
            or (e["kind"] == "question_open" and e["data"]["id"] not in questions)
            or (e["kind"] == "job_start" and e["job"] not in jobs)
            for e in entries
        ):
            raise AgentError("Cannot move pending work; finish or cancel it first")

    async def disconnect(self):
        await self._cancel_requests()
        for sid, actors in list(self.presence.items()):
            for actor in actors.copy():
                try:
                    await self.set_presence(sid, actor, False)
                except AgentError:
                    pass

    async def set_presence(self, sid, actor, present):
        await self.api.call(
            "questions",
            "connect" if present else "disconnect",
            {"session": sid, "actor": actor, "route": self.name, "principal": self.actor},
        )
        if present:
            self.presence.setdefault(sid, set()).add(actor)
        else:
            self.presence.get(sid, set()).discard(actor)
            if hasattr(self, "poll_route"):
                self.api._harness.forget_waits(sid, token=self.name)

    @staticmethod
    def guards_frame(method):
        # The open/new replies carry control metadata. Replay goes through the
        # separate update boundary. An erase reply reports plan progress.
        return method not in {
            "session/new",
            "session/load",
            "session/resume",
            "session/close",
            "_modular-agent/erase",
            "_modular-agent/leave",
            "_modular-agent/interrupted",
        }

    async def frame_revision(self, sid):
        return await self.api.session("erasure_cutoff", session=sid, actor=self.actor)

    async def authorize_frame(self, sid, method, message, prepared=None):
        if sid is None:
            return
        # The handler may have waited behind another frame since its last check.
        details = message.get("error", {}).get("data")
        if lease_refused_open(method, details) or (
            isinstance(details, dict)
            and details.get("code")
            in {"forbidden", "not_open", "wrong_project", "unavailable", "lost"}
        ):
            return
        if (
            "method" not in message
            and method
            not in {"session/load", "session/resume", "session/close", "_modular-agent/leave"}
            and sid not in self.sessions
        ):
            # A close can settle an outstanding prompt before it gets the
            # write lock. Do not include any content in this reply.
            if (
                method == "session/prompt"
                and (message.get("result") or {}).get("stopReason") == "cancelled"
            ):
                return {
                    "jsonrpc": "2.0",
                    "id": message["id"],
                    "result": {"stopReason": "cancelled"},
                }
            raise protocol_error("not_open", "Session is not open on this connection")
        scope = self.project_scope()
        token = OUTPUT_SESSION.set(sid)
        try:
            await self.check_delivery(sid, method)
            if self.guards_frame(method):
                try:
                    revision = await self.frame_revision(sid)
                except AgentError as exc:
                    raise protocol_error("unavailable", str(exc)) from exc
                if prepared and prepared != [sid, revision]:
                    raise protocol_error("unavailable", "Session view changed during delivery")
        finally:
            OUTPUT_SESSION.reset(token)
            self.reset_project_scope(scope)

    async def serve_frames(self, frames):
        await acp.run_agent(
            self,
            Stdio(None, None, frames=frames, authorize=self.authorize_frame),
            use_unstable_protocol=True,
        )

    async def serve(self):
        try:
            # SDK 1.0.0 still marks elicitation unstable; the published v1 spec has
            # stabilized it. This switch enables the documented method, not ACP v2.
            from acp.stdio import stdio_streams

            reader, writer = await stdio_streams(limit=MAX_FRAME + 2)
            await acp.run_agent(
                self,
                Stdio(reader, writer, authorize=self.authorize_frame),
                use_unstable_protocol=True,
            )
        finally:
            # EOF interrupts the process, not an answer to a pending question.
            # Composition shutdown suspends the Runtime before tearing down plugins.
            await self._cancel_requests()

    async def stop(self):
        await self._cancel_requests()
