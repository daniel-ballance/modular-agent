"""Host-owned Interface dispatch, deadlines, and result admission."""

import asyncio
import json
import time
from contextvars import Context

from jsonschema import Draft202012Validator, ValidationError
from ma_core import AgentError, clone, content
from ma_core import telemetry as ot
from ma_core.recovery import HANDOFF
from ma_core.wire import call_out, recorded_as, tool_in, tool_out

from .authority import CONNECTION_AUTHORITY

SOURCE = "modular-agent.interface-tools"
MAX_COUNT = 2**53 - 1
REQUIRED = {"watch", "tools"}
UNKNOWN = "The Interface tool may have run. Its outcome is unknown."


def clock():
    return time.time_ns() // 1_000_000


def same_json(a, b):
    if type(a) in (int, float) and type(b) in (int, float):
        return a == b
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(same_json(v, b[k]) for k, v in a.items())
    if isinstance(a, list):
        return len(a) == len(b) and all(same_json(x, y) for x, y in zip(a, b, strict=True))
    return a == b


def registrations(sources):
    tools, ids, routes = {}, set(), {}
    for spec in sources:
        source, actor, route = (spec[k] for k in ("source_id", "actor_id", "route_id"))
        timeout = spec["result_timeout_ms"]
        if not all(isinstance(v, str) and v for v in (source, actor, route)):
            raise ValueError("Interface sources need a source, actor and route ID")
        if source in ids or (route in routes and routes[route] != actor):
            raise ValueError("Conflicting Interface source or executor route")
        if type(timeout) is not int or not 0 < timeout <= MAX_COUNT - clock():
            raise ValueError("Interface result timeout must fit a positive Duration and deadline")
        ids.add(source)
        routes[route] = actor
        for wire in spec["tools"]:
            definition = clone(wire)
            json.dumps(definition, allow_nan=False)
            name = definition["name"]
            hints = definition.get("hints", {})
            if (
                not isinstance(name, str)
                or not name
                or name in tools
                or not isinstance(definition["description"], str)
                or definition.get("callers") != ["model"]
                or hints.get("safeToRepeat", False) is not False
                or hints.get("openWorld", True) is not True
                or type(definition.get("parallel", False)) is not bool
            ):
                raise ValueError("Invalid or duplicate model-only Interface tool definition")
            for key in ("parameters", "returns"):
                if key in definition:
                    Draft202012Validator.check_schema(definition[key])
            tools[name] = (
                source,
                actor,
                route,
                timeout,
                {**tool_in(definition), "interfaceSource": source},
            )
    return tools, routes


def branch_entries(s):
    by_id = {e["id"]: e for e in s["entries"]}
    branch, pos = [], s["position"]
    while pos:
        entry = by_id[pos]
        branch.append(entry)
        pos = entry["parent"]
    return branch[::-1]


def handoff_fold(entries):
    starts, checkpoints, terminal = {}, {}, {}
    for e in entries:
        cid = e.get("call")
        if not cid or e.get("fork_source"):
            continue
        if recorded_as(e, "tool_started"):
            starts[cid] = e
        if recorded_as(e, HANDOFF):
            checkpoints.setdefault(cid, []).append(e)
        if recorded_as(e, "tool_result"):
            terminal.setdefault(cid, e)
    ids = checkpoints.keys() | {
        cid
        for cid, e in starts.items()
        if (e.get("data", {}).get("source") or {}).get("plugin") == SOURCE
    }
    return {cid: (starts.get(cid), checkpoints.get(cid, []), terminal.get(cid)) for cid in ids}


def valid_report(report):
    if not isinstance(report, dict) or not report.keys() <= {
        "callId",
        "status",
        "content",
        "value",
    }:
        return False
    cid, status, parts = (report.get(k) for k in ("callId", "status", "content"))
    if not isinstance(cid, str) or not cid or status not in ("completed", "failed"):
        return False
    if not isinstance(parts, list) or not all(
        isinstance(p, dict)
        and isinstance(p.get("type"), str)
        and bool(p["type"])
        and (p["type"] != "text" or isinstance(p.get("text"), str))
        for p in parts
    ):
        return False
    if status == "failed" and not parts:
        return False
    try:
        json.dumps(report, allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        return False
    return True


class InterfaceTools:
    def init_interface_tools(self):
        self.interface_tools = {}
        self.interface_routes = {}
        self.interface_connections = {}
        self.interface_locks = {}
        self.interface_timers = {}
        self.interface_traces = {}
        self.interface_report_contexts = {}

    def interface_enabled(self):
        runtime = self.capabilities.get("runtime")
        return bool(
            self.interface_routes
            and runtime
            and self.plugins[runtime[0]].declarations.get("interface_tools")
        )

    def interface_lock(self, sid):
        return self.interface_locks.setdefault(sid, asyncio.Lock())

    def interface_executor(self, sid, name):
        if name not in self.interface_tools:
            return None
        _, actor, route, _, _ = self.interface_tools[name]
        s = self.sessions[sid]
        for cx in reversed(tuple(self.interface_connections.values())):
            if (
                cx["actor"] == actor
                and cx["route"] == route
                and cx["deliver"] is not None
                and name in cx["offers"].get(sid, ())
                and cx["scope"][-1](s)
            ):
                rights = self.permissions(s, actor, cx["scope"][1])
                if REQUIRED <= rights:
                    return cx, rights
        return None

    def interface_definitions(self, sid, turn=None):
        if sid not in self.sessions or not self.interface_enabled():
            return []
        pinned = None
        if turn:
            start = next(
                (
                    e
                    for e in self.sessions[sid]["entries"]
                    if e["kind"] == "turn_start" and e.get("turn") == turn
                ),
                None,
            )
            pinned = {t["name"]: t for t in (start or {}).get("data", {}).get("tools", [])}
        return [
            d
            for name, (*_, d) in self.interface_tools.items()
            if (pinned is None or same_json(pinned.get(name), tool_out(d)))
            and self.interface_executor(sid, name)
        ]

    async def interface_dispatch(self, d):
        sid, turn, step, call = (d[k] for k in ("session", "turn", "step", "call"))
        cid, name = call["id"], call["name"]
        source, actor, route, timeout, definition = self.interface_tools[name]

        def refused(reason, status="refused"):
            return {"call": cid, "status": status, "content": content(reason)}

        def current(expected=None):
            s = self.sessions[sid]
            if s.get("closing") or s.get("moving") or s.get("suspending") or s.get("writer_lost"):
                return None
            if not turn or call.get("parentCallId") or call.get("initiator", "model") != "model":
                return None
            if not same_json(
                d["definition"], definition
            ) or definition not in self.interface_definitions(sid, turn):
                return None
            if any(e.get("turn") == turn and recorded_as(e, "turn_end") for e in s["entries"]):
                return None
            if "tools" not in self.interface_work_rights(
                s, turn, call["actor"], call.get("authority")
            ):
                return None
            found = self.interface_executor(sid, name)
            if found and (expected is None or found[0] is expected):
                return found
            return None

        # Validate before creating a start or exposing the request to the gate.
        try:
            Draft202012Validator(definition["schema"]).validate(call["input"])
        except ValidationError:
            return refused("Interface tool input does not match its schema", "failed")
        async with self.interface_lock(sid):
            if not (executor := current()):
                return refused("Interface tool is no longer available or authorized")
            cx, rights = executor
            event = {"type": "toolCall", "data": {"call": call_out(call)}}
            if not same_json(await self.output(sid, actor, [event]), [event]):
                return refused("Interface handoff was withheld or changed")
            deadline = clock() + timeout
            if deadline > MAX_COUNT:
                return refused("Interface tool deadline is out of range")
            async with self.append_locks.setdefault(sid, asyncio.Lock()):
                await self.guard_erasure(sid)
                await self._assert_writable(sid)
                if not (executor := current(cx)):
                    return refused("Interface tool is no longer available or authorized")
                rights = executor[1]
                entries = self.sessions[sid]["entries"]
                if any(
                    e.get("call") == cid
                    and (recorded_as(e, "tool_started") or recorded_as(e, "tool_result"))
                    for e in entries
                ):
                    raise AgentError("Interface call was already started or settled", "conflict")
                start, checkpoint = await self._append(
                    {
                        "session": sid,
                        "turn": turn,
                        "step": step,
                        "call": cid,
                        "actor": call["actor"],
                        "kind": "tool_started",
                        "writer": "@harness",
                        "copies": [
                            e["id"]
                            for e in entries
                            if e.get("call") == cid and e["kind"] == "tool_call"
                        ],
                        "data": {
                            "call": call,
                            "definition": tool_out(definition),
                            "source": {"plugin": SOURCE, "toolSource": source},
                            "openWorld": True,
                            "safeToRepeat": False,
                        },
                        "interface_handoff": {
                            "executorActorId": actor,
                            "routeId": route,
                            "rights": sorted(rights),
                            "deadline": deadline,
                        },
                    }
                )
            self.arm_interface_deadline(sid, cid, deadline)
            attributes = ot.tool_attrs(sid, turn, step, call, name)
            if provider_id := ot.name(self.provider_trace_ids.pop((sid, cid), None)):
                attributes["gen_ai.tool.call.id"] = provider_id
            try:
                await self._assert_writable(sid)
                await self.guard_erasure(sid)
                deliver = clock() < deadline and current(cx) is not None
            except AgentError:
                deliver = False
            if not deliver:
                await self._settle_interface(
                    sid, cid, reason="Interface handoff became unavailable", undispatched=True
                )
                return {"interface": True, "status": "refused"}
            label = "execute_tool " + name if ot.name(name) else "execute_tool"
            with ot.span(label, attributes) as operation:
                ot.set_attrs(operation, {"modular_agent.tool.status": "pending"})
                self.interface_traces[sid, cid] = ot.own_context(operation)
                try:
                    if cx.get("deferred") is not None:
                        cx["deferred"][sid, cid] = (
                            turn,
                            {
                                "session_id": sid,
                                "call_id": cid,
                                "name": name,
                                "input": clone(call["input"]),
                                "deadline": deadline,
                            },
                        )
                    else:
                        cx["deliver"](
                            {
                                "call_id": cid,
                                "session_id": sid,
                                "name": name,
                                "input": clone(call["input"]),
                                "deadline": deadline,
                            }
                        )
                except Exception:
                    # The receiver may have acted before its callback failed.
                    pass
        for e in (start, checkpoint):
            await self._emit({"kind": "history_entry", "session": sid, "entry": e})
        return {"interface": True, "open": True, "pending": "Waiting for an Interface tool result"}

    async def release_interface(self, sid, token, cid):
        """A live deferred handle, never a reconstructed dispatch from history."""
        cx = self.interface_connections.get(token)
        if not cx or not (staged := (cx.get("deferred") or {}).get((sid, cid))):
            return False
        turn = staged[0]

        def current():
            s = self.sessions.get(sid)
            if (
                not s
                or self.interface_connections.get(token) is not cx
                or not cx["scope"][-1](s)
                or any(s.get(k) for k in ("closing", "moving", "suspending", "writer_lost"))
            ):
                return None
            start, cp, result = self.interface_state(sid, cid)
            if result or not self.restored_interface(start, cp):
                return None
            d, call = cp["data"], start["data"]["call"]
            if (
                (cx["actor"], cx["route"]) != (d["executorActorId"], d["routeId"])
                or clock() >= d["deadline"]
                or not REQUIRED <= self.permissions(s, cx["actor"], d["rights"])
                or "tools"
                not in self.interface_work_rights(s, turn, call["actor"], call.get("authority"))
                or not any(
                    e["kind"] == "turn_end"
                    and e.get("turn") == turn
                    and e["data"]["outcome"] == "completed"
                    and cid in e["data"].get("open_calls", [])
                    for e in branch_entries(s)
                )
            ):
                return None
            return call, d["deadline"]

        async with self.interface_lock(sid):
            scope = CONNECTION_AUTHORITY.set(cx["scope"])
            try:
                if (sid, cid) not in cx["deferred"] or not (pair := current()):
                    return False
                event = {"type": "toolCall", "data": {"call": call_out(pair[0])}}
                if not same_json(await self.output(sid, cx["actor"], [event]), [event]):
                    return False
                await self._assert_writable(sid)
                await self.guard_erasure(sid)
                if not (pair := current()):
                    return False
                call, deadline = pair
                del cx["deferred"][sid, cid]
                cx["deliver"](
                    {
                        "call_id": cid,
                        "session_id": sid,
                        "name": call["name"],
                        "input": clone(call["input"]),
                        "deadline": deadline,
                    }
                )
                return True
            finally:
                CONNECTION_AUTHORITY.reset(scope)

    def interface_work_rights(self, s, turn, actor, ceiling=None):
        rights = self.permissions(s, actor, ceiling)
        turns = set()
        entries = s["entries"]
        while turn and turn not in turns:
            turns.add(turn)
            for e in entries:
                if e.get("turn") == turn and not e.get("fork_source") and e["kind"] == "input":
                    data = e["data"]
                    rights &= self.permissions(
                        s, e["actor"], data.get("authority", data.get("rights"))
                    )
                    for key in ("releasedBy", "acting_for"):
                        if data.get(key):
                            rights &= self.permissions(s, data[key])
            start = next(
                (e for e in entries if e.get("turn") == turn and e["kind"] == "turn_start"), {}
            )
            turn = continuation_origin(start)
        return rights

    def interface_state(self, sid, cid):
        s = self.sessions[sid]
        start, checkpoints, terminal = handoff_fold(s["entries"]).get(cid, (None, [], None))
        checkpoint = checkpoints[0] if len(checkpoints) == 1 else None
        branch = {e["id"] for e in branch_entries(s)}
        if not (
            start
            and checkpoint
            and start["kind"] == "tool_started"
            and checkpoint["kind"] == HANDOFF
            and start["id"] in branch
            and checkpoint["id"] in branch
            and start["id"] == checkpoint["parent"] == checkpoint["data"].get("toolStartedId")
            and all(
                start.get(k) == checkpoint.get(k) and start.get(k) for k in ("turn", "step", "call")
            )
            and start["data"].get("safeToRepeat") is False
            and start["data"].get("openWorld") is True
        ):
            checkpoint = None
        return start, checkpoint, terminal

    def restored_interface(self, start, checkpoint):
        if not self.interface_enabled() or checkpoint is None:
            return False
        data = checkpoint["data"]
        registered = self.interface_tools.get(start["data"].get("call", {}).get("name"))
        return bool(
            registered
            and (registered[1], registered[2]) == (data.get("executorActorId"), data.get("routeId"))
            and isinstance(data.get("rights"), list)
            and REQUIRED <= set(data["rights"])
            and type(data.get("deadline")) is int
            and 0 < data["deadline"] <= MAX_COUNT
            and (start["data"].get("source") or {}).get("toolSource") == registered[0]
            and same_json(start["data"].get("definition"), tool_out(registered[-1]))
        )

    def arm_interface_deadline(self, sid, cid, deadline):
        key = sid, cid
        if key not in self.interface_timers:
            self.interface_timers[key] = asyncio.create_task(
                self._interface_deadline(sid, cid, deadline), context=Context()
            )

    async def _interface_deadline(self, sid, cid, deadline):
        try:
            while (remaining := deadline - clock()) > 0:
                await asyncio.sleep(min(remaining / 1000, 86_400))
            async with self.interface_lock(sid):
                if sid not in self.sessions or self.sessions[sid].get("closing"):
                    return
                await self.guard_erasure(sid)
                entry = await self._settle_interface(sid, cid, "Interface result deadline expired")
            if entry:
                await self.interface_kick(sid)
        except AgentError:
            # A lost writer reconciles on reopen; an erasure intent takes precedence.
            return
        finally:
            if self.interface_timers.get((sid, cid)) is asyncio.current_task():
                self.interface_timers.pop((sid, cid), None)

    def forget_interface_session(self, sid):
        for key in list(self.interface_timers):
            if key[0] == sid:
                self.interface_timers.pop(key).cancel()
        for key in list(self.interface_report_contexts):
            if key[0] == sid:
                del self.interface_report_contexts[key]
        for key in list(self.interface_traces):
            if key[0] == sid:
                del self.interface_traces[key]
        for cx in self.interface_connections.values():
            cx["offers"].pop(sid, None)

    async def interface_recover(self, sid):
        async with self.interface_lock(sid):
            for cid, (_, _, terminal) in handoff_fold(self.sessions[sid]["entries"]).items():
                if terminal:
                    continue
                start, checkpoint, _ = self.interface_state(sid, cid)
                if (
                    not self.restored_interface(start, checkpoint)
                    or checkpoint["data"]["deadline"] <= clock()
                ):
                    await self._settle_interface(
                        sid, cid, "Interface handoff cannot be restored or has expired"
                    )
                else:
                    self.arm_interface_deadline(sid, cid, checkpoint["data"]["deadline"])

    async def interface_settle(self, sid, reason, *, turn=None, affected=None):
        async with self.interface_lock(sid):
            for cid, (start, checkpoints, terminal) in handoff_fold(
                self.sessions[sid]["entries"]
            ).items():
                if terminal or (
                    turn is not None and (start or next(iter(checkpoints), {})).get("turn") != turn
                ):
                    continue
                if affected is not None and not any(
                    e["id"] in affected for e in ([start] if start else []) + checkpoints
                ):
                    continue
                await self._settle_interface(
                    sid, cid, reason, suppress_continuation=affected is not None
                )

    async def _settle_interface(
        self, sid, cid, reason, *, undispatched=False, suppress_continuation=False
    ):
        return await self._commit_interface_result(
            sid,
            cid,
            {
                "status": "refused" if undispatched else "outcome_unknown",
                "content": content(reason if undispatched else f"{reason}. {UNKNOWN}"),
            },
            suppress_continuation=suppress_continuation,
        )

    async def _commit_interface_result(
        self, sid, cid, result, *, actor=None, suppress_continuation=False
    ):
        entries = self.sessions[sid]["entries"]
        start, checkpoints, terminal = handoff_fold(entries).get(cid, (None, [], None))
        if terminal or (not start and not checkpoints):
            return None
        provenance = start or checkpoints[0]
        key = sid, cid
        with ot.span(
            "modular_agent.tool.settle",
            ot.attrs(
                sid,
                provenance.get("turn"),
                provenance.get("step"),
                **{
                    "modular_agent.tool.call.id": cid,
                    "modular_agent.tool.status": ot.tool_status(result),
                },
            ),
            links=ot.link(self.interface_traces.get(key)),
        ) as operation:
            if result.get("_result_error"):
                ot.error(operation, "tool_result_processing_failed")
            entry = await self.handle(
                "append",
                {
                    "session": sid,
                    "turn": provenance.get("turn"),
                    "step": provenance.get("step"),
                    "call": cid,
                    "actor": actor,
                    "kind": "tool_result",
                    "writer": "@harness",
                    "visible": not suppress_continuation,
                    "copies": [e["id"] for e in ([start] if start else []) + checkpoints],
                    "content": [] if suppress_continuation else result["content"],
                    "data": {"erased": True, "originalKind": "toolResult", "interfaceErasure": True}
                    if suppress_continuation
                    else {
                        "status": result["status"],
                        "toolName": (start or {})
                        .get("data", {})
                        .get("call", {})
                        .get("name", "unknown"),
                        **{k: result[k] for k in ("value", "resultUnavailable") if k in result},
                        **(
                            {"continuationUnavailable": True}
                            if suppress_continuation or result.get("_result_error")
                            else {}
                        ),
                    },
                },
                None,
            )
        timer = self.interface_timers.pop(key, None)
        if timer is not None and timer is not asyncio.current_task():
            timer.cancel()
        self.interface_traces.pop(key, None)
        return entry

    async def report_interface_result(self, sid, token, report):
        if not valid_report(report):
            return "refused"
        cx = self.interface_connections.get(token)
        if not cx or sid not in self.sessions:
            return "refused"
        cid = report["callId"]
        actor = cx["actor"]

        def eligible():
            s = self.sessions.get(sid)
            if (
                not s
                or s.get("closing")
                or s.get("moving")
                or s.get("suspending")
                or not cx["scope"][-1](s)
            ):
                return None
            start, checkpoint, terminal = self.interface_state(sid, cid)
            if not self.restored_interface(start, checkpoint):
                return None
            cp = checkpoint["data"]
            if (actor, cx["route"]) != (
                cp["executorActorId"],
                cp["routeId"],
            ) or not REQUIRED <= self.permissions(s, actor, cp["rights"]):
                return None
            branch = branch_entries(s)
            if not any(
                e["kind"] == "turn_end"
                and e.get("turn") == start["turn"]
                and cid in e["data"].get("open_calls", [])
                for e in branch
            ):
                return None
            return start, checkpoint, terminal

        from ma_runtime.turns import checked_tool_result, require_processed_result

        scope = CONNECTION_AUTHORITY.set(cx["scope"])
        try:
            with ot.span("modular_agent.tool.report", ot.attrs(sid)):
                async with self.interface_lock(sid):
                    if self.interface_connections.get(token) is not cx or not (state := eligible()):
                        return "refused"
                    try:
                        revision = await self.erasure_revision(sid)
                        await self._assert_writable(sid)
                    except AgentError:
                        return "refused"
                    start, checkpoint, terminal = state
                    if terminal:
                        return (
                            "alreadySettled"
                            if terminal["kind"] == "tool_result" and terminal.get("actor") == actor
                            else "refused"
                        )
                    if clock() >= checkpoint["data"]["deadline"]:
                        return "refused"
                    call = start["data"]["call"]
                    proposed = {
                        "call": cid,
                        **{
                            k: clone(report[k])
                            for k in ("status", "content", "value")
                            if k in report
                        },
                    }
                    try:
                        answer = (
                            await self.fire(
                                self.hooks["tool.after"][0],
                                "tool.after",
                                {
                                    "session": sid,
                                    "turn": start["turn"],
                                    "step": start["step"],
                                    "call": call,
                                    "result": proposed,
                                },
                            )
                        )["result"]
                        if answer.get("callId", cid) != cid:
                            raise ValueError("Invalid tool.after call ID")
                        answer = {k: v for k, v in answer.items() if k != "callId"}
                        if not same_json(
                            {k: v for k, v in answer.items() if k not in {"content", "value"}},
                            {"call": cid, "status": proposed["status"]},
                        ) or not valid_report(
                            {"callId": cid, **{k: v for k, v in answer.items() if k != "call"}}
                        ):
                            raise ValueError("Invalid tool.after result")
                        result = checked_tool_result(tool_in(start["data"]["definition"]), answer)
                    except Exception:
                        result = {
                            "status": proposed["status"],
                            "content": content("Interface tool result processing failed"),
                            "_result_error": "Interface tool result processing failed",
                        }
                    try:
                        await self._assert_writable(sid)
                        if (
                            revision != await self.erasure_revision(sid)
                            or not eligible()
                            or clock() >= checkpoint["data"]["deadline"]
                        ):
                            return "refused"
                    except AgentError:
                        return "refused"
                    # Carry the authorized report, not a later polling or recovery request.
                    # The ephemeral context is never part of the portable result.
                    self.interface_report_contexts[sid, cid] = ot.inject()
                    await self._commit_interface_result(sid, cid, result, actor=actor)
                require_processed_result(result)
        finally:
            CONNECTION_AUTHORITY.reset(scope)
        await self.interface_kick(sid)
        return "accepted"

    async def interface_ready(self, sid):
        if not self.interface_enabled():
            return []
        s = self.sessions[sid]
        handoffs = handoff_fold(s["entries"])
        if not handoffs or s.get("closing") or s.get("moving"):
            return []
        branch = branch_entries(s)
        order = {e["id"]: index for index, e in enumerate(s["entries"])}
        by_id = {e["id"]: e for e in branch}
        consumed = {continuation_origin(e) for e in s["entries"] if recorded_as(e, "turn_start")}
        ready = []
        for end in branch:
            origin = end.get("turn")
            ids = end.get("data", {}).get("open_calls", [])
            if (
                end["kind"] != "turn_end"
                or origin in consumed
                or not any(cid in handoffs for cid in ids)
            ):
                continue
            start = next(
                (e for e in branch if e.get("turn") == origin and e["kind"] == "turn_start"), None
            )
            if start is None:
                continue
            triggers, resume, lineage = [], [], [start["id"], end["id"]]
            for cid in ids:
                if cid in handoffs:
                    dispatch, checkpoints, result = handoffs[cid]
                    if (
                        not dispatch
                        or dispatch["id"] not in by_id
                        or dispatch["kind"] != "tool_started"
                        or not checkpoints
                        or any(cp["kind"] != HANDOFF or cp["id"] not in by_id for cp in checkpoints)
                        or not result
                        or result["id"] not in by_id
                        or result["kind"] != "tool_result"
                        or result["data"].get("continuationUnavailable")
                    ):
                        break
                    triggers.append((order[result["id"]], "toolResult", result["id"]))
                    lineage.extend([*(cp["id"] for cp in checkpoints), result["id"]])
                else:
                    questions = [
                        e["data"]["id"]
                        for e in branch
                        if e["kind"] == "question_open" and e.get("call") == cid
                    ]
                    closed = {
                        e["data"]["request"]: e
                        for e in branch
                        if e["kind"] in {"question_answer", "question_closed"}
                        and e["data"]["request"] in questions
                    }
                    if not questions or len(closed) != len(questions):
                        break
                    triggers.extend((order[e["id"]], "answer", q) for q, e in closed.items())
                    if not any(
                        recorded_as(e, "tool_result") and e.get("call") == cid for e in s["entries"]
                    ):
                        resume.append(cid)
            else:
                if not triggers:
                    continue
                index, kind, trigger = max(triggers)
                ready.append(
                    {
                        "id": "continue:" + origin,
                        "actor": start.get("actor", s["actor"]),
                        "content": [],
                        "interface_continuation": True,
                        "operation_context": self.interface_report_contexts.get(
                            (sid, by_id.get(trigger, {}).get("call"))
                        )
                        if kind == "toolResult"
                        else None,
                        "ready_order": max(index, order[end["id"]]),
                        "continuation_sources": lineage,
                        "data": {
                            "when": "after",
                            "source": {"continuesTurnId": origin},
                            "startedBy": {"kind": kind, "id": trigger},
                            "resume": resume,
                        },
                    }
                )
        return ready

    async def interface_kick(self, sid):
        # The scheduler derives authority from the origin, not from the report.
        scope = CONNECTION_AUTHORITY.set(None)
        try:
            if sid in self.sessions and "runtime" in self.capabilities:
                await self.call("@harness", "runtime", "kick", {"session": sid})
        finally:
            CONNECTION_AUTHORITY.reset(scope)


def continuation_origin(e):
    data = e.get("data", {})
    return (data.get("source") or {}).get("continuesTurnId") or e.get("wire_fields", {}).get(
        "continuesTurnId"
    )
