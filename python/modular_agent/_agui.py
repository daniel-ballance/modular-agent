"""Authenticated operations on the agent service. A route is not a session grant."""

from __future__ import annotations

import asyncio
import re
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Mapping, Sequence
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast
from uuid import uuid4

from starlette.requests import Request
from starlette.responses import Response
from starlette.types import Send
from ._agui_http import Stream
from ma_core import telemetry as ot
from ma_core.wire import provider_projection
from ma_harness.authority import CONNECTION_AUTHORITY
from ma_harness.interface_tools import branch_entries, clock, handoff_fold, same_json
from opentelemetry.context import Context

from ._agui_wire import Obj, Failure, content, encode, event, fingerprint, iso, parse_run, require
from ._interface_tools import InterfaceToolConnection
from ._types import AgentError, ErrorCode, JsonObject

if TYPE_CHECKING:
    from ._agent import Agent, AguiActor


@dataclass
class Cursor:
    id: str
    size: int
    digest: bytes
    position: str | None
    revision: int
    http: bool


@dataclass
class Presence:
    route: str = field(default_factory=lambda: uuid4().hex)
    delivered: dict[str, Obj] = field(default_factory=dict)
    executor: InterfaceToolConnection | None = None
    blocked: set[str] = field(default_factory=set)


class Binding:
    def __init__(
        self,
        agent: Agent,
        actors: Sequence[AguiActor],
        tenant: str | None,
        state_plugin: str | None,
        state_snapshot: Callable[[str], Awaitable[JsonObject | None]] | None,
        raw_sources: Mapping[str, str],
        trace_keys: Sequence[str],
    ) -> None:
        from ._agent import _acp_rights, _acp_scope

        self.agent = agent
        self.actors = deepcopy(list(actors))
        self.tenant = tenant
        if state_snapshot and not state_plugin:
            raise AgentError(ErrorCode.INVALID_COMPOSITION, "Select the plugin that owns the state")
        self.state_plugin = state_plugin
        self.state_snapshot = state_snapshot
        self.raw_sources = dict(raw_sources)
        self.trace_keys = frozenset(trace_keys)
        self.active: set[tuple[str, str]] = set()
        self.presence: dict[tuple[str, str], Presence] = {}
        self.cursors: OrderedDict[tuple[str, str], Cursor] = OrderedDict()
        self.admission = asyncio.Lock()
        self.decision_runs: OrderedDict[tuple[str, str, str], None] = OrderedDict()
        self.scopes: dict[str, Obj] = {}
        clients: dict[str, Any] = {}
        kinds: dict[str, str] = {}
        try:
            if not actors or tenant is not None and tenant not in agent._h.tenants:
                raise ValueError()
            for a in self.actors:
                aid, kind, cid = a["actor"]["id"], a["actor"]["kind"], a["client_id"]
                if (
                    not isinstance(aid, str)
                    or not aid
                    or not isinstance(cid, str)
                    or not cid
                    or kind not in ("user", "agent", "program", "host")
                    or kinds.setdefault(aid, kind) != kind
                    or agent._h.interface_routes.get(cid, aid) != aid
                ):
                    raise ValueError()
                scope = _acp_scope(a)
                principal = (
                    aid,
                    _acp_rights(a["actor"]["rights"]),
                    scope,
                    a.get("trace_trusted", False),
                )
                if clients.setdefault(cid, principal) != principal:
                    raise ValueError()
                self.scopes[cid] = scope
        except (KeyError, ValueError, TypeError) as exc:
            raise AgentError(
                ErrorCode.INVALID_COMPOSITION,
                "Invalid or ambiguous AG-UI principal, client or scope",
            ) from exc

    def close(self) -> None:
        for p in self.presence.values():
            if p.executor:
                p.executor.close()
        self.decision_runs.clear()
        self.presence.clear()
        self.cursors.clear()
        self.agent._acp_server = None

    async def error_allowed(self, actor: AguiActor, code: str) -> bool:
        try:
            scope = View(self, actor)
            return await scope.gate("error", {"code": code}) == {"code": code}
        except Exception:
            return False

    async def request(
        self, req: Request, actor: AguiActor, raw: Obj, headers: dict[str, str], send: Send
    ) -> Response | None:
        from ._agui_run import Exchange

        view = View(self, actor)
        token = CONNECTION_AUTHORITY.set((view.actor, view.rights, view.grants, view.in_scope))
        try:
            path = req.url.path.removeprefix("/agui/v1")
            require(path != req.url.path, "not_found")
            status = 200
            if req.method == "GET" and not path:
                reply = await view.required(
                    "discovery",
                    {
                        "binding": "modular-agent-agui/1",
                        "protocolVersion": "1.0",
                        "declaration": self.agent.declaration(),
                    },
                )
            elif req.method == "POST" and path == "/threads":
                require(not raw)
                require(
                    view.in_scope({"project": str(self.agent._project), "tenant": self.tenant}),
                    "refused",
                )
                rights = set(view.rights) & self.agent._h.admin & self.agent._h.tenant
                if self.tenant is not None:
                    rights &= set(self.agent._h.tenant_config(self.tenant)["rights"])
                require({"input", "watch"} <= rights, "refused")
                state = await self.agent._session(
                    "create",
                    project=str(self.agent._project),
                    actor=view.actor,
                    actor_kind=actor["actor"]["kind"],
                    authority=sorted(rights),
                    settings=self.agent._settings,
                    tenant=self.tenant,
                    defer_setup=True,
                )
                view.sid = state["id"]
                status = 201
                reply = await view.required(
                    "threads", {"threadId": view.sid, "declaration": self.agent.declaration()}
                )
            elif req.method == "GET" and (
                match := re.fullmatch(r"/threads/([\w-]+)(/presence)?", path)
            ):
                await view.attach(match[1])
                if match[2]:
                    await view.keep_present(Stream(send, headers))
                    return None
                self.cursors.pop(view.key, None)
                reply, cursor = await view.snapshot(http=True)
                response = Response(encode(reply), media_type="application/json", headers=headers)
                view.remember(cursor)
                return response
            elif req.method == "POST" and path == "/run":
                d = parse_run(raw)
                await view.attach(d["threadId"])
                require(view.key not in self.active, "conflict")
                self.active.add(view.key)
                try:
                    carrier = {}
                    if actor.get("trace_trusted") is True:
                        carrier["traceparent"] = req.headers.get("traceparent", "")
                        vendor = [
                            v.strip()
                            for v in req.headers.get("tracestate", "").split(",")
                            if v.partition("=")[0].strip() in self.trace_keys
                        ]
                        if vendor:
                            carrier["tracestate"] = ",".join(vendor)
                    with ot.use(ot.TRACE.extract(carrier, context=Context())):
                        await Exchange(view, req, d, Stream(send, headers)).serve()
                        return None
                finally:
                    self.active.remove(view.key)
            else:
                raise Failure("not_found")
            return Response(
                encode(reply), status_code=status, media_type="application/json", headers=headers
            )
        finally:
            CONNECTION_AUTHORITY.reset(token)


class View:
    def __init__(self, binding: Binding, principal: AguiActor) -> None:
        self.binding = binding
        self.agent = binding.agent
        self.h = self.agent._h
        self.principal = principal
        self.actor = principal["actor"]["id"]
        self.client = principal["client_id"]
        self.rights = frozenset(principal["actor"]["rights"])
        self.grants: dict[str, set[str]] = {}
        self.scope = binding.scopes[self.client]
        self.sid = ""

    @property
    def key(self) -> tuple[str, str]:
        return self.client, self.sid

    def in_scope(self, state: Obj) -> bool:
        project = Path(state["project"])
        return (
            project == self.agent._project
            and project in self.scope.get("projects", (project,))
            and state.get("tenant") in self.scope["tenants"]
        )

    async def attach(self, sid: str) -> None:
        require(sid.isalnum(), "not_found")
        async with self.agent._lock:
            saved = self.h.sessions.get(sid)
            reopen = saved is None or sid in self.h.interruptions
            if saved is None:
                saved = await self.agent._call("history", "read", session=sid)
            require(
                saved
                and self.in_scope(saved)
                and self.h.can_open(saved, self.actor)
                and saved["actors"][self.actor]["kind"] == self.principal["actor"]["kind"],
                "not_found",
            )
            self.sid = sid
            self.grants[sid] = set(self.rights).intersection(
                saved["actors"][self.actor]["authority"]
            )
            if reopen:
                await self.agent._session("open", session=sid, actor=self.actor)
        if reopen:
            await self.agent._call("runtime", "wait", session=sid)
        await self.check()

    def rights_now(self) -> set[str]:
        s = self.h.sessions.get(self.sid)
        return (
            set(self.h.permissions(s, self.actor, self.grants.get(self.sid, self.rights)))
            if s and self.in_scope(s)
            else set()
        )

    async def check(self, permission: str = "watch") -> None:
        await self.h.guard_erasure(self.sid)
        rights = self.rights_now()
        require("watch" in rights, "not_found")
        require(permission in rights, "refused")
        require(not self.h.sessions[self.sid].get("writer_lost"), "unavailable")

    async def gate(self, method: str, value: Obj) -> Obj | None:
        if self.sid:
            await self.check()
        events = await self.h.output(
            self.sid or None,
            self.actor,
            [
                {
                    "type": "reply",
                    "data": {"method": "agui." + method, "clientId": self.client, "result": value},
                }
            ],
        )
        if self.sid:
            await self.check()
        return cast(Obj, events[0]["data"]["result"]) if events else None

    async def required(self, method: str, value: Obj, *, exact: bool = False) -> Obj:
        gated = await self.gate(method, value)
        if gated is None or (exact and not same_json(value, gated)):
            raise Failure("output_withheld")
        return gated

    async def entry(self, raw: Obj) -> Obj | None:
        if raw["kind"] in ("tool_result", "tool_started"):
            # Replay must pass the same toolCall/toolResult gates as live delivery.
            gated = await self.h.output(
                self.sid,
                self.actor,
                [
                    {
                        "type": "history_entry",
                        "data": {
                            "kind": "history_entry",
                            "session": self.sid,
                            "entry": provider_projection(raw),
                        },
                    }
                ],
            )
            return cast(Obj, gated[0]["data"]["entry"]) if gated else None
        return cast(
            Obj | None,
            await self.agent._api.session(
                "view", session=self.sid, recipient=self.actor, type="entry", value=raw
            ),
        )

    def branch(self) -> list[Obj]:
        return cast(list[Obj], branch_entries(self.h.sessions[self.sid]))

    async def messages(self, branch: list[Obj]) -> list[Obj]:
        messages = []
        starts: dict[str, Obj] = {}
        results: dict[str, Obj] = {}
        for e in branch:
            if e["kind"] not in ("tool_started", "tool_result") or not e.get("call"):
                continue
            visible = await self.entry(e)
            if visible is None:
                continue
            if e["kind"] == "tool_started":
                starts[e["call"]] = visible["data"]["call"]
            else:
                results[e["call"]] = visible
        for e in branch:
            kind = e["kind"]
            if kind not in ("input", "response", "tool_result") or e.get("data", {}).get("erased"):
                continue
            projected = (
                results.get(e.get("call", "")) if kind == "tool_result" else await self.entry(e)
            )
            if projected is None:
                continue
            d, mid = projected["data"], e["id"]
            body = content(projected.get("content", []))
            if kind == "input":
                messages.append(
                    {"id": "ma:u:" + d.get("input", mid), "role": "user", "content": body}
                )
            elif kind == "response" and e.get("step"):
                body = await self.assistant_text(e["step"], projected.get("content", []))
                calls = []
                for c in d.get("calls", []):
                    cid = c["id"]
                    if (
                        cid in starts
                        and cid in results
                        and starts[cid]["name"] not in self.h.interface_tools
                    ):
                        call = starts[cid]
                        calls.append(
                            {
                                "id": cid,
                                "type": "function",
                                "function": {
                                    "name": call["name"],
                                    "arguments": encode(call["input"]).decode(),
                                },
                            }
                        )
                if isinstance(body, str) and body or calls:
                    messages.append(
                        {
                            "id": "ma:a:" + e["step"],
                            "role": "assistant",
                            "content": body if isinstance(body, str) else "",
                            **({"toolCalls": calls} if calls else {}),
                        }
                    )
            elif kind == "tool_result":
                cid = e["call"]
                messages.append(
                    {
                        "id": "ma:t:" + cid,
                        "role": "tool",
                        "toolCallId": cid,
                        "content": body,
                        **(
                            {"error": body if isinstance(body, str) and body else "Tool failed"}
                            if d["status"] != "completed"
                            else {}
                        ),
                    }
                )
        return messages

    async def assistant_text(self, step: str, parts: list[Obj]) -> str:
        text = "".join(p["text"] for p in parts if p["type"] == "text")
        if text and self.h.holds_output():
            pieces = await self.h.output(
                self.sid,
                self.actor,
                [
                    {
                        "type": "model_output",
                        "data": {
                            "step": step,
                            "stream_type": "text",
                            "text": text,
                            "final": True,
                        },
                    }
                ],
            )
            if not pieces:
                return ""
            text = pieces[0]["data"]["text"]
            # A withheld protocol-specific piece may not return via replay either.
            piece = await self.gate(
                "event", event("TEXT_MESSAGE_CONTENT", messageId="ma:a:" + step, delta=text)
            )
            return str(piece["delta"]) if piece else ""
        return text

    def open_calls(self, branch: list[Obj]) -> dict[str, Obj]:
        calls = {}
        for cid in handoff_fold(branch):
            start, cp, terminal = self.h.interface_state(self.sid, cid)
            if terminal or not self.h.restored_interface(start, cp):
                continue
            d = cp["data"]
            if (
                (d["executorActorId"], d["routeId"]) == (self.actor, self.client)
                and {"watch", "tools"} <= self.rights_now().intersection(d["rights"])
                and clock() < d["deadline"]
            ):
                calls[cid] = start | {"deadline": d["deadline"]}
        return calls

    async def questions(self, branch: list[Obj]) -> dict[str, tuple[Obj, Obj]]:
        ended = {e.get("turn") for e in branch if e["kind"] == "turn_end"}
        presence = self.binding.presence.get(self.key)
        qs = await self.agent._call(
            "questions",
            "list",
            session=self.sid,
            actor=self.actor,
            openOnly=True,
            recipientView=True,
        )
        result = {}
        for q in qs:
            kind = q["kind"]
            late = q.get("turn") in ended and kind != "approval"
            if (
                not q["answerable"]
                or kind == "secret"
                or (not late and (not presence or q["id"] not in presence.delivered))
            ):
                continue
            interrupt = await self.interrupt(q)
            if interrupt is not None and (
                late or (presence and interrupt == presence.delivered[q["id"]])
            ):
                result[q["id"]] = q, interrupt
        return result

    async def interrupt(self, q: Obj) -> Obj | None:
        kind = q["kind"]
        i = {"id": q["id"], "reason": kind, "message": q["question"]}
        if q.get("deadline") and not q["park"]:
            i["expiresAt"] = q["deadline"]
        if kind == "approval":
            i["toolCallId"] = q["call"]
            i["responseSchema"] = {
                "type": "object",
                "properties": {"allow": {"type": "boolean"}},
                "required": ["allow"],
                "additionalProperties": False,
            }
        elif kind == "choice":
            i["responseSchema"] = {"type": "string", "enum": q["options"]}
        else:
            i["responseSchema"] = {"type": "string"}
            if kind == "link" and isinstance(uri := q.get("details"), str):
                i["metadata"] = {"modular-agent.link": uri}
        gated = await self.gate("interrupt", i)
        return gated if same_json(i, gated) else None

    async def snapshot(
        self, *, http: bool, cursor_id: str | None = None, through: str | None = None
    ) -> tuple[Obj, Cursor]:
        rev = await self.h.erasure_revision(self.sid)
        branch = self.branch()
        if through is not None:
            stop = next((i for i, e in enumerate(branch) if e["id"] == through), None)
            require(stop is not None, "conflict")
            assert stop is not None
            branch = branch[: stop + 1]
        pos = branch[-1]["id"] if branch else None
        messages = await self.messages(branch)
        cursor = cursor_id or uuid4().hex
        if http:
            qs = await self.questions(branch)
            calls = self.open_calls(branch)
            reply = await self.required(
                "snapshot",
                {
                    "threadId": self.sid,
                    "declaration": self.agent.declaration(),
                    "messages": messages,
                    "cursor": cursor,
                    "lastMessageId": messages[-1]["id"] if messages else None,
                    "waiting": {
                        "questions": [i for _, i in qs.values()],
                        "toolCalls": [
                            {"toolCallId": cid, "expiresAt": iso(c["deadline"])}
                            for cid, c in calls.items()
                        ],
                    },
                },
            )
        else:
            reply = await self.required("event", event("MESSAGES_SNAPSHOT", messages=messages))
        # Redactions may edit display content, not a cursor or answer route.
        require(
            not http
            or (
                reply["cursor"] == cursor
                and same_json(
                    reply["waiting"],
                    {
                        "questions": [i for _, i in qs.values()],
                        "toolCalls": [
                            {"toolCallId": cid, "expiresAt": iso(c["deadline"])}
                            for cid, c in calls.items()
                        ],
                    },
                )
            ),
            "output_withheld",
        )
        for before, after in zip(messages, reply["messages"], strict=True):
            require(
                same_json(
                    {k: v for k, v in before.items() if k not in ("content", "error")},
                    {k: v for k, v in after.items() if k not in ("content", "error")},
                ),
                "output_withheld",
            )
        require(rev == await self.h.erasure_revision(self.sid), "conflict")
        return reply, Cursor(cursor, len(messages), fingerprint(reply["messages"]), pos, rev, http)

    def remember(self, cursor: Cursor) -> None:
        cache = self.binding.cursors
        cache[self.key] = cursor
        cache.move_to_end(self.key)
        if len(cache) > 4096:
            cache.popitem(last=False)

    async def reconcile(self, messages: list[Obj], supplied: str | None) -> list[Obj]:
        old = self.binding.cursors.get(self.key)
        require(supplied is None or old and supplied == old.id, "cursor_expired")
        current, stamp = await self.snapshot(
            http=bool(old and old.http), cursor_id=old.id if old else None
        )
        if old is None:
            require(not current["messages"], "cursor_expired")
            return messages
        require(
            (stamp.digest, stamp.revision) == (old.digest, old.revision)
            and (not old.position or any(e["id"] == old.position for e in self.branch()))
            and same_json(messages[: old.size], current["messages"]),
            "conflict",
        )
        return messages[old.size :]

    async def mark_present(self, route: str, presence: Presence | None) -> None:
        questions = self.h.capabilities["questions"][1]

        def eligible(q: Obj) -> bool:
            return bool(
                presence
                and q["kind"] != "secret"
                and q["id"] not in presence.blocked
                and (self.key in self.binding.active or q["id"] in presence.delivered)
                and ("approve" if q["kind"] == "approval" else "answer") in self.rights_now()
            )

        questions.route_eligibility[route] = eligible
        try:
            await self.agent._call(
                "questions", "connect", session=self.sid, actor=self.actor, route=route
            )
        except BaseException:
            questions.route_eligibility.pop(route, None)
            raise

    async def detach(self, route: str) -> None:
        try:
            if self.sid in self.h.sessions:
                await self.agent._api.call(
                    "questions",
                    "disconnect",
                    {"session": self.sid, "actor": self.actor, "route": route},
                )
        finally:
            self.h.capabilities["questions"][1].route_eligibility.pop(route, None)

    async def keep_present(self, response: Stream) -> None:
        active = self.binding.presence
        require(self.key not in active, "conflict")
        p = active[self.key] = Presence()
        try:
            await self.mark_present(p.route, p)
            await response.start()
            while True:
                await self.check()
                await response.write(b": present\n\n")
                await asyncio.sleep(10)
        finally:
            active.pop(self.key, None)
            if p.executor:
                p.executor.close()
            await self.detach(p.route)
