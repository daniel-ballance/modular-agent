"""Transient turns. All effects, hooks and history are reached through the plugin API."""

import asyncio
from datetime import datetime

from ma_core import AgentError, Plugin, content, identity
from ma_core.wire import recorded_as

from .turns import Turns


class Runtime(Turns, Plugin):
    name = "transient"
    role = "runtime"
    declarations = {
        "steering": True,
        "keyed_input": True,
        "durable": False,
        "questions": True,
        "jobs": True,
        "open_calls": True,
        "parallel_tools": True,
        "nested_tools": True,
        "queued_input_after_restart": "handedBack",
    }

    def __init__(self):
        self.tasks = {}
        self.admission = {}
        self.scheduling = {}
        self.steering_closed = set()
        self.cancelled = set()
        self.suspending = set()
        self.active_calls = set()

    async def start(self, api):
        await super().start(api)
        api.provide("runtime", self)
        for name, rule in {
            "turn.start": "observe",
            "step.before": "transform",
            "step.after": "gate",
            "tool.before": "gate",
            "tool.after": "transform",
            "model.failed": "first",
            "result.ready": "first",
            "turn.end": "observe",
        }.items():
            api.define_hook(name, rule)
        api.on("session.start", self._opened, "first")
        api.on("session.end", self._close, "first")
        api.on("session.suspend", self._suspend, "first")
        api.on("session.moving", self._close)
        api.on("session.invalidate", self._invalidated)

    async def _entries(self, sid):
        return (await self.api.session("get", session=sid))["entries"]

    @staticmethod
    def _input_id(e):
        return e["data"].get("input", e["id"])

    async def _pending(self, sid, *, proposals=False):
        settled, accepted = set(), {}
        for e in await self._entries(sid):
            if e.get("fork_source"):
                continue
            if e["kind"] == "input_queued":
                accepted[self._input_id(e)] = e
            elif recorded_as(e, "input"):
                settled.add(e["data"].get("inputId", self._input_id(e)))
            elif recorded_as(e, "input_withdrawn"):
                d = e["data"]
                settled.update(d.get("inputIds", [d.get("inputId", self._input_id(e))]))
        return [
            e
            for iid, e in accepted.items()
            if iid not in settled
            and (proposals or (e["data"]["when"] != "propose" and not e["data"].get("parked")))
        ]

    async def _restart_pending(self, d):
        pending = await self._pending(d["session"])
        if "prior_inputs" not in d:
            return pending
        prior = set(d["prior_inputs"])
        return [e for e in pending if e["id"] in prior]

    async def submit(self, d, emit):
        async with self.admission.setdefault(d["session"], asyncio.Lock()):
            return await self._submit(d, emit)

    async def _submit(self, d, emit):
        sid = d["session"]
        s = await self.api.session(
            "get", session=sid, **({"actor": d["actor"]} if "actor" in d else {})
        )
        actor = d.get("actor", s["actor"])
        authority = await self.api.session(
            "authority", session=sid, actor=actor, ceiling=d.get("authority")
        )
        if acting := d.get("acting_for"):
            authority = await self.api.session(
                "authority", session=sid, actor=acting, ceiling=authority
            )
        permission = "propose" if d.get("when") == "propose" else "input"
        if permission not in authority:
            raise AgentError("Actor lacks authority: " + permission, "forbidden")
        if s.get("closing") or s.get("moving"):
            raise AgentError("Session is not admitting input")
        submitter = d.get("acting_for", actor)
        key = d.get("key")
        if key is not None:
            if key.startswith(("job:", "continue:")) and not d.get("source"):
                raise AgentError("Input key prefix is reserved", "invalid_request")
            entries = [e for e in s["entries"] if not e.get("fork_source")]
            for e in entries:
                if e["kind"] != "erase":
                    continue
                for reservation in e["data"].get("inputKeys", []):
                    attributed = reservation.get("actorId")
                    if (
                        reservation.get("submittedBy", attributed),
                        attributed,
                        reservation["key"],
                    ) == (submitter, actor, key):
                        return {"duplicate": True, "erased": True}
            for e in entries:
                if e["kind"] != "input_queued":
                    continue
                first = e["data"]
                attributed = e.get("actor")
                if (first.get("submittedBy", attributed), attributed, first.get("key")) == (
                    submitter,
                    actor,
                    key,
                ):
                    return {
                        "input": self._input_id(e),
                        "when": {"inTurn": "steer", "proposed": "propose"}.get(
                            first.get("taken"), first.get("taken", first["when"])
                        ),
                        "duplicate": True,
                    }
        incoming = d if d.get("source") else await self.api.session("input", **d)
        if incoming.get("handled"):
            return incoming
        d = incoming
        mode = d.get("when", "now")
        if mode not in {"now", "steer", "after", "propose"}:
            raise AgentError("Unknown input timing")
        if (mode == "propose") != (permission == "propose"):
            raise AgentError("Input hook changed the proposal boundary", "forbidden")
        current = await self.api.session("get", session=sid)
        if current.get("busy") and mode == "now":
            mode = "after"
        if mode == "steer" and (
            not current.get("busy")
            or sid in self.steering_closed
            or not self.declarations["steering"]
        ):
            mode = "after"
        e = await self.api.session(
            "append",
            session=sid,
            kind="input_queued",
            actor=actor,
            writer=self.name,
            content=d["content"],
            copies=d.get("copies", []),
            data={
                "when": mode,
                "key": key,
                **({"submittedBy": submitter} if submitter != actor else {}),
                "authority": authority,
                **{k: d[k] for k in ("source", "resume", "acting_for", "result_schema") if k in d},
            },
            **({"job": d["source"]["job"]} if d.get("source", {}).get("job") else {}),
        )
        await self.api.event("input_accepted", session=sid, input=e["id"], when=mode)
        if mode != "propose":
            await self._schedule(sid)
        return {"input": e["id"], "when": mode, "duplicate": False}

    async def kick(self, d, emit):
        sid = d["session"]
        if await self._pending(sid):
            await self._schedule(sid)
        return {}

    async def _schedule(self, sid):
        # report() and wait() may both kick the same committed admission.
        # Marking the session busy can yield across the process boundary.
        async with self.scheduling.setdefault(sid, asyncio.Lock()):
            if sid not in self.tasks or self.tasks[sid].done():
                # Recovery must settle old work before ordinary queue dispatch.
                busy = await self.api.session(
                    "busy", session=sid, value=True, unless_reopening=True
                )
                if busy.get("deferred"):
                    return
                self.cancelled.discard(sid)
                self.tasks[sid] = asyncio.create_task(self._drain(sid), name="turn:" + sid)

    async def release(self, d, emit):
        sid, actor, mode = d["session"], d["actor"], d["when"]
        if mode not in {"now", "steer", "after"}:
            raise AgentError("Invalid release timing")
        async with self.admission.setdefault(sid, asyncio.Lock()):
            rights = set(await self.api.session("authority", session=sid, actor=actor))
            if "input" not in rights:
                raise AgentError("Actor lacks authority: input", "forbidden")
            proposed = next(
                (
                    e
                    for e in await self._pending(sid, proposals=True)
                    if self._input_id(e) == d["input"] and self._parked(e)
                ),
                None,
            )
            if proposed is None:
                raise AgentError("Unknown proposed input")
            if d.get("declined"):
                await self._return(sid, proposed)
                return {"input": d["input"], "when": "handedBack"}
            s = await self.api.session("get", session=sid)
            if s.get("busy") and mode == "now":
                mode = "after"
            shared = rights & set(
                await self.api.session(
                    "authority",
                    session=sid,
                    actor=proposed["actor"],
                    ceiling=proposed["data"].get("authority"),
                )
            )
            job = proposed.get("job")
            if job:
                if "input" not in shared:
                    raise AgentError("Job no longer has input authority", "forbidden")
                if mode == "steer":
                    mode = "after"
            await self.api.session(
                "append",
                session=sid,
                kind="input_queued",
                actor=proposed["actor"],
                writer=self.name,
                content=proposed["content"],
                copies=[proposed["id"]],
                **({"job": job} if job else {}),
                data={
                    **proposed["data"],
                    "input": d["input"],
                    "when": mode,
                    "releasedBy": actor,
                    "authority": sorted(shared),
                    **({"parked": False, "source": {"job": job}} if job else {}),
                },
            )
            await self._schedule(sid)
            return {"input": d["input"], "when": mode}

    @staticmethod
    def _parked(e):
        return e["data"]["when"] == "propose" or bool(e["data"].get("parked"))

    async def proposals(self, d, emit):
        return [
            {
                "inputId": self._input_id(e),
                "actorId": e["actor"],
                "content": e["content"],
                "time": int(datetime.fromisoformat(e["time"]).timestamp() * 1000),
            }
            for e in await self._pending(d["session"], proposals=True)
            if self._parked(e)
        ]

    async def withdraw_proposal(self, d, emit):
        sid = d["session"]
        async with self.admission.setdefault(sid, asyncio.Lock()):
            proposal = next(
                (p for p in await self.proposals(d, emit) if p["inputId"] == d["input"]), None
            )
            if proposal is None:
                raise AgentError("Unknown proposed input")
            principal = d["actor"]
            actor = d.get("acting_for", principal)
            rights = set(await self.api.session("authority", session=sid, actor=principal))
            if actor != principal:
                rights &= set(await self.api.session("authority", session=sid, actor=actor))
            if "input" not in rights and not (
                proposal["actorId"] == actor and (actor == principal or "propose" in rights)
            ):
                raise AgentError(
                    "Only the proposer or an actor with input may withdraw", "forbidden"
                )
            entry = next(
                e
                for e in await self._pending(sid, proposals=True)
                if self._input_id(e) == d["input"]
            )
            await self._return(sid, entry)
            return {}

    async def withdraw(self, d, emit):
        for e in await self._pending(d["session"]):
            if self._input_id(e) == d["input"]:
                await self._return(d["session"], e)
                return {"withdrawn": True, "content": e["content"]}
        return {"withdrawn": False}

    async def _return(self, sid, e):
        await self.api.session(
            "append",
            session=sid,
            kind="input_withdrawn",
            writer=self.name,
            data={"input": self._input_id(e)},
        )
        await self.api.event(
            "input_returned", session=sid, input=self._input_id(e), content=e["content"]
        )

    def _taken_input(self, e):
        return {
            "visible": True,
            "content": e["content"],
            "actor": e["actor"],
            "copies": [e["id"]],
            "data": {
                "input": self._input_id(e),
                "key": e["data"].get("key"),
                "when": e["data"].get("when", "now"),
                "authority": e["data"].get("authority"),
                "source": e["data"].get("source"),
                **{k: e["data"][k] for k in ("releasedBy", "acting_for") if k in e["data"]},
            },
            **({"job": e["job"]} if e.get("job") else {}),
        }

    async def _take(self, sid, e, turn):
        return await self._record(sid, turn, "input", **self._taken_input(e))

    async def wait(self, d, emit):
        task = self.tasks.get(d["session"])
        result = await asyncio.shield(task) if task else []
        return result if isinstance(result, list) else []

    async def cancel(self, d, emit):
        sid = d["session"]
        await self.api.session("get", **d)
        self.cancelled.add(sid)
        task = self.tasks.get(sid)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        for e in await self._pending(sid):
            await self._return(sid, e)
        await self.api.session("invalidate", session=sid, reason="cancelled")
        es = await self._entries(sid)
        done = {e.get("call") for e in es if recorded_as(e, "tool_result")}
        for e in es:
            if e["kind"] == "tool_deferred" and e["call"] not in done:
                await self._result(
                    sid,
                    e.get("turn"),
                    e.get("step"),
                    {"id": e["call"]},
                    {"status": "cancelled", "content": content("Open call cancelled")},
                )
                done.add(e["call"])
        await self.api.session("busy", session=sid, value=False)
        return {"cancelled": True}

    async def _invalidated(self, d):
        task = self.tasks.get(d["session"])
        if d.get("reason") == "erasure" and task is not None and task.done():
            self.tasks.pop(d["session"], None)

    @staticmethod
    def deferred_calls(entries):
        done = {e.get("call") for e in entries if recorded_as(e, "tool_result")}
        ended = {e.get("turn") for e in entries if e["kind"] == "turn_end"}
        deferred = {
            e["call"]: e
            for e in entries
            if e["kind"] == "tool_deferred" and (e.get("turn") is None or e.get("turn") in ended)
        }
        requested = {
            c["id"]: {**e, "call": c["id"], "data": c}
            for e in entries
            if e["kind"] == "response"
            for c in e["data"].get("calls", [])
        }
        for e in entries:
            if e["kind"] == "turn_end":
                for cid in e["data"].get("open_calls", []):
                    if cid in requested:
                        deferred.setdefault(cid, requested[cid])
        return {cid: e for cid, e in deferred.items() if cid not in done}

    async def wake(self, d, emit):
        sid = d["session"]
        if sid in self.suspending:
            return {}
        es = await self.api.session("branch", session=sid)
        deferred = self.deferred_calls(es)
        if not deferred:
            return {}
        qs = await self.api.call("questions", "list", {"session": sid})
        groups = {}
        for cid, entry in deferred.items():
            groups.setdefault(entry.get("turn"), []).append(cid)
        for origin_turn, calls in groups.items():
            if any((sid, cid) in self.active_calls for cid in calls):
                continue
            questions = [q for q in qs if q.get("call") in calls and not q.get("closed")]
            if not questions or any(not q.get("answer") for q in questions):
                continue
            key = "continue:" + (origin_turn or calls[0])
            call = next(
                (e for e in es if e["kind"] == "tool_call" and e["call"] == calls[0]),
                deferred[calls[0]],
            )
            await self.submit(
                {
                    "session": sid,
                    "actor": call["data"].get("actor", call["actor"]),
                    "authority": call["data"].get("authority"),
                    "content": content("Continue after answered input requests."),
                    "source": {
                        "questions": [q["id"] for q in questions],
                        "continuesTurnId": origin_turn,
                    },
                    "resume": calls,
                    "key": key,
                    "when": "after",
                },
                emit,
            )
        return {}

    async def dispatch_nested(self, d, emit):
        return await self._tool(d["session"], d["turn"], d["step"], d["call"], d["definition"])

    async def run_tool(self, d, emit):
        sid = d["session"]
        s = await self.api.session("get", session=sid)
        if s.get("busy"):
            raise AgentError("UI tool calls require an idle turn")
        self.cancelled.discard(sid)
        await self.api.session("busy", session=sid, value=True)

        async def execute():
            try:
                return await self._ui_call(d, emit)
            except asyncio.CancelledError:
                if sid in self.suspending:
                    raise
                await self._settle(sid, None, True)
                return {"status": "cancelled", "content": content("UI call cancelled")}
            finally:
                await self.api.session("busy", session=sid, value=False)
                if (
                    sid not in self.suspending
                    and sid not in self.cancelled
                    and await self._pending(sid)
                ):
                    await self.api.session("busy", session=sid, value=True)
                    self.tasks[sid] = asyncio.create_task(self._drain(sid))

        task = asyncio.create_task(execute(), name="ui-tool:" + sid)
        self.tasks[sid] = task
        return await asyncio.shield(task)

    async def _ui_call(self, d, emit):
        sid = d["session"]
        s = await self.api.session("get", session=sid)
        actor = d.get("actor", s["actor"])
        authority = await self.api.session("authority", session=sid, actor=actor)
        if acting := d.get("acting_for"):
            authority = await self.api.session(
                "authority", session=sid, actor=acting, ceiling=authority
            )
        c = {
            **({"acting_for": acting} if acting else {}),
            "id": d.get("id", identity()),
            "name": d["name"],
            "input": d["input"],
            "actor": actor,
            "authority": authority,
            "initiator": "interface",
        }
        es = await self._entries(sid)
        prior = next((e for e in es if e["kind"] == "tool_call" and e["call"] == c["id"]), None)
        if prior:
            if any(prior["data"].get(k) != c[k] for k in ("name", "input", "actor")):
                raise AgentError("Tool call ID reused with different data")
            receipt = next(
                (e for e in es if e["kind"] == "tool_result" and e["call"] == c["id"]), None
            )
            return receipt["data"] if receipt else {"open": True}
        tools = await self.api.call("tools", "definitions", {"session": sid})
        definition = next((t for t in tools if t["name"] == c["name"]), None)
        await self._record(
            sid,
            None,
            "tool_call",
            call=c["id"],
            visible=True,
            actor=actor,
            data={**c, "definition": definition},
        )
        answer = await self._tool(sid, None, "ui:" + c["id"], c, definition)
        await self._result(sid, None, "ui:" + c["id"], c, answer)
        return answer

    async def _opened(self, d):
        self.suspending.discard(d["session"])

    async def _suspend(self, d):
        sid = d["session"]
        self.suspending.add(sid)
        task = self.tasks.get(sid)
        if task and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def _close(self, d):
        await self.cancel(d, None)
        self.tasks.pop(d["session"], None)
        self.cancelled.discard(d["session"])

    async def _drain(self, sid):
        results = []
        try:
            while sid not in self.cancelled:
                queued = await self._pending(sid)
                if not queued:
                    break
                results.append(await self._turn(sid, queued[0]))
        finally:
            await self.api.session("busy", session=sid, value=False)
        return results

    async def _record(self, sid, turn, kind, **kw):
        return await self.api.session(
            "append", session=sid, turn=turn, kind=kind, writer=self.name, **kw
        )

    async def abandon(self, d, emit):
        """Settle a stopped child without scheduling inference, under either Runtime."""
        sid = d["session"]
        await self.api.session("invalidate", session=sid, reason="cancelled")
        es = await self._entries(sid)
        ended = {e.get("turn") for e in es if recorded_as(e, "turn_end")}
        for e in es:
            if e["kind"] == "turn_start" and e["turn"] not in ended:
                await self._settle(sid, e["turn"])
                await self._record(
                    sid,
                    e["turn"],
                    "turn_end",
                    data={
                        "outcome": "failed",
                        "error": "Subagent interrupted",
                        "content": [],
                        "turn": e["turn"],
                    },
                )
        await self._settle(sid, None)
        for queued in await self._pending(sid):
            await self._return(sid, queued)
        return {}

    async def recover(self, d, emit):
        sid = d["session"]
        if sid in self.tasks and not self.tasks[sid].done():
            return {"already_running": True}
        await self._settle(sid, None)
        entries = await self.api.session("branch", session=sid)
        ended = {e.get("turn") for e in entries if recorded_as(e, "turn_end")}
        for e in entries:
            if e["kind"] == "turn_start" and e["turn"] not in ended:
                await self._settle(sid, e["turn"])
                await self._record(
                    sid,
                    e["turn"],
                    "turn_end",
                    data={"outcome": "failed", "error": "Transient turn interrupted"},
                )
        run_jobs = self.declarations.get("queued_job_reports_after_restart") == "run"
        for queued in await self._restart_pending(d):
            if not (run_jobs and (queued["data"].get("source") or {}).get("job")):
                await self._return(sid, queued)
        await self.wake(d, emit)
        if run_jobs:
            await self.kick(d, emit)
        return {}

    async def stop(self):
        for task in self.tasks.values():
            if not task.done():
                task.cancel()
        await asyncio.gather(*self.tasks.values(), return_exceptions=True)
        self.tasks.clear()
