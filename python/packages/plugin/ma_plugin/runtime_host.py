"""Host the public Runtime port. Admission and effects stay on the Harness side."""

import asyncio

from ma_core import telemetry as ot
from ma_core import AgentError, content, identity, plain
from ma_runtime import Runtime
from ma_runtime.turns import UNKNOWN, checked_tool_result, require_processed_result

from . import hooks
from ma_core.recovery import HANDOFF, STEP_AFTER
from ma_core.wire import (
    STATUS_IN,
    call_out,
    entry_out,
    model_out,
    model_request_fields,
    recorded_as,
    request_in,
    request_out,
    response_in,
    response_out,
    result_in,
    result_out,
    tool_out,
    usage_out,
)
from .rpc import WireError


ENTRY_KINDS = {
    "turnStart": "turn_start",
    "turnEnd": "turn_end",
    "toolCall": "tool_call",
    "toolResult": "tool_result",
    "toolDeferred": "tool_deferred",
    "python.tool_deferred": "tool_deferred",
    "python.context": "context",
    "toolFinished": "tool_finished",
    "stepStart": "step_start",
    "modelStarted": "model_started",
}
RUNTIME_HOOKS = {
    "turn.start",
    "step.after",
    "tool.before",
    "tool.after",
    "model.failed",
    "turn.result",
    "turn.end",
}
OUTCOMES = {"completed", "failed", "cancelled", "limit"}


def native_outcome(outcome):
    if outcome["kind"] not in OUTCOMES:
        raise WireError("Unknown turn outcome", "invalid_request")
    error = outcome.get("error")
    if outcome["kind"] == "limit":
        limit = outcome.get("limit", "steps")
        error = "output limit" if limit in {"output", "maxOutput", "tokens"} else "step limit"
    return {"outcome": outcome["kind"], "error": error}


class HostedRuntime(Runtime):
    """The native admission/lifecycle shell, with turn execution replaced wholesale."""

    def __init__(self, plugin, registration):
        super().__init__()
        self.plugin = plugin
        self.name = plugin.name
        self.registration = registration
        self.supports = registration.get("supports") or {}
        self.declarations = {
            **Runtime.declarations,
            "steering": bool(self.supports.get("inputDuringTurn")),
            "durable": bool(self.supports.get("continuesAfterRestart")),
            "waiting_through_restart": bool(self.supports.get("waitingThroughRestart")),
            "nested_tools": False,
            "interface_tools": self.supports.get("interfaceTools") is True,
            "queued_input_after_restart": "run"
            if self.supports.get("continuesAfterRestart")
            else "handedBack",
        }

    async def _run_turn(self, sid, queued, turn, recovering, segment):
        additions, problem = None, None
        if recovering:
            entries = await self.api.session("branch", session=sid)
            start = next(e for e in entries if e.get("turn") == turn and e["kind"] == "turn_start")
            queued = next(
                (
                    e
                    for e in entries
                    if e["id"] == start["data"].get("input") and e["kind"] == "input_queued"
                ),
                None,
            )
        else:
            source = queued["data"].get("source") or {}
            started_by = queued["data"].get("startedBy") or (
                {"kind": "job", "id": source["job"]}
                if source.get("job")
                else {"kind": "answer", "id": source["questions"][0]}
                if source.get("questions")
                else {"kind": "actor", "id": queued["actor"]}
            )
            snapshot, additions, problem = await self._turn_snapshot(sid, turn, queued)
            start = await self._record(
                sid,
                turn,
                "turn_start",
                actor=queued["actor"],
                **(
                    {}
                    if queued.get("interface_continuation")
                    else {"first_input": self._taken_input(queued)}
                ),
                copies=queued.get("continuation_sources", []),
                data={
                    **self._start_trigger(queued),
                    "startedBy": started_by,
                    **snapshot,
                    **segment,
                },
            )
        self.steering_closed.discard(sid)
        scope = TurnHost(self, sid, turn, start)
        scope.trace_parent = ot.current()
        scope.step_span = None
        scope.traced_step = None
        scope.additions = (
            additions
            if not recovering
            else [{"system": start["data"]["system"], "context": start["data"].get("context", [])}]
            if "system" in start["data"]
            else None
        )
        try:
            if (
                recovering
                and start["data"].get("input")
                and not any(e.get("turn") == turn and e["kind"] == "input" for e in entries)
            ):
                raise AgentError("Interrupted turn has no committed first input", "lost")
            await scope.check_tenant()
            if problem is not None:
                raise problem
            access, scope.settings = await self._turn_access(sid, start)
            scope.access = access
            snapshot = start["data"].get("startedBy") or {"kind": "actor", "id": start["actor"]}
            model_supports = {
                "keepsState": bool(access["provider"].get("stateful")),
                "runsTools": bool(access["provider"].get("runs_tools")),
            }
            params = {
                "turn": {
                    "sessionId": sid,
                    "turnId": turn,
                    "startedBy": snapshot,
                    "model": model_out(access, access["target"]),
                    "modelSupports": model_supports,
                    "settings": {
                        wire: scope.settings[native]
                        for wire, native in (
                            ("maxSteps", "max_steps"),
                            ("reasoning", "thinking"),
                            ("maxOutput", "max_output"),
                        )
                        if scope.settings.get(native) is not None
                    },
                    **(
                        {"resultShape": scope.settings["result_shape"]}
                        if scope.settings.get("result_shape") is not None
                        else {}
                    ),
                }
            }
            resume = (
                queued["data"].get("resume", [])
                if queued
                else start["data"].get("continuationCalls", [])
            )
            scope.continuing = set(resume)
            if recovering:
                await scope.recover_model_attempts()
                params["interrupted"] = await scope.interrupted(resume)
                method = "resumeTurn"
            elif resume or queued.get("interface_continuation"):
                params["calls"] = scope.calls(await scope.entries(), resume)
                method = "continueOpenCalls"
            else:
                method = "runTurn"
            value = await self.plugin.request(
                "runtime/" + method,
                params,
                {"session": sid, "turn": turn, "actor": start["actor"], "runtime": scope},
                return_on_cancel=True,
            )
            answer = await scope.checked_end_data(value)
        except asyncio.CancelledError:
            if sid in self.suspending:
                scope.end_step()
                raise
            answer = scope.end_data({"outcome": {"kind": "cancelled"}})
        except Exception as exc:
            answer = scope.end_data({"outcome": {"kind": "failed", "error": str(exc)}})
        if sid in self.cancelled and answer["outcome"] != "completed":
            answer.update(
                scope.end_data(
                    {
                        "outcome": {"kind": "cancelled"},
                        "usage": usage_out(answer.get("usage") or {}),
                    }
                )
            )
        if answer["outcome"] != "cancelled" and (
            scope.tenant_limited or await self.api.session("tenant_exhausted", session=sid)
        ):
            answer.update(
                outcome="limit",
                error=None,
                shared_outcome={"kind": "limit", "limit": "tenantTokens"},
            )
        if scope.capacity_limited and answer["outcome"] != "cancelled":
            answer.update(
                outcome="limit", error=None, shared_outcome={"kind": "limit", "limit": "capacity"}
            )
        scope.end_step()
        answer = await scope.finish(answer)
        if answer["open_calls"]:
            await self.wake({"session": sid}, None)
        return answer

    async def recover(self, d, emit):
        sid = d["session"]
        if sid in self.tasks and not self.tasks[sid].done():
            return {"already_running": True}
        await self._settle(sid, None)
        entries = await self.api.session("branch", session=sid)
        ended = {e.get("turn") for e in entries if recorded_as(e, "turn_end")}
        turns = [e["turn"] for e in entries if e["kind"] == "turn_start" and e["turn"] not in ended]
        if not turns and not await self._pending(sid):
            await self.wake(d, emit)
            return {}

        # Hand-backs are open metadata, not recovered execution.
        if not self.declarations["durable"]:
            for queued in await self._restart_pending(d):
                await self._return(sid, queued)

        async def resume():
            try:
                results = [await self._turn(sid, turn=turn) for turn in turns]
                if self.declarations["durable"] and sid not in self.cancelled:
                    results.extend(await self._drain(sid))
                await self.wake(d, emit)
                # wake can queue work while this task still owns the session.
                if sid not in self.cancelled and await self._pending(sid):
                    results.extend(await self._drain(sid))
                return results
            finally:
                await self.api.session("busy", session=sid, value=False)

        async with self.scheduling.setdefault(sid, asyncio.Lock()):
            if sid in self.tasks and not self.tasks[sid].done():
                return {"already_running": True}
            if not turns and not await self._pending(sid):
                return {}
            self.cancelled.discard(sid)
            await self.api.session("invalidate", session=sid, reason="recovery")
            await self.api.session("busy", session=sid, value=True)
            self.tasks[sid] = asyncio.create_task(resume(), name="external-recover:" + sid)
        return {"resuming": turns}


class TurnHost:
    def __init__(self, runtime, sid, turn, start):
        self.runtime, self.api = runtime, runtime.api
        self.sid, self.turn, self.start = sid, turn, start
        self.actor = start["actor"]
        self.scope = {"session": sid, "turn": turn, "actor": self.actor}
        self.additions = None
        self.step = None
        self.ended = False
        self.gates, self.results = {}, {}
        self.gating = set()
        self.inflight, self.attempted = set(), set()
        self.allocated, self.prepared, self.model_answers = set(), {}, {}
        self.replay_attempt = None
        self.continuing = set()
        self.repeatable = set()
        self.prior_starts, self.restarted = set(), set()
        self.final_hook = False
        self.outcome_error = None
        self.open_recovered = []
        self.step_ids = set()
        self.journal = asyncio.Lock()

    async def entries(self):
        return await self.api.session("branch", session=self.sid)

    async def append(self, kind, **fields):
        return await self.runtime._record(self.sid, self.turn, kind, actor=self.actor, **fields)

    def calls(self, entries, ids=None):
        done = {
            e.get("call")
            for e in entries
            if recorded_as(e, "tool_result") and not e.get("fork_source")
        }
        starts = {
            e["call"]: e
            for e in entries
            if recorded_as(e, "tool_started") and not e.get("fork_source")
        }
        calls = {}
        for e in entries:
            if e["kind"] == "response":
                for c in e["data"].get("calls", []):
                    if e.get("turn") == self.turn or c["id"] in (ids or ()):
                        calls[c["id"]] = (c, e.get("step"))
            if e["kind"] in {"tool_call", "tool_started"} and (
                e.get("turn") == self.turn or e["call"] in (ids or ())
            ):
                calls.setdefault(
                    e["call"],
                    (
                        e["data"]["call"] if e["kind"] == "tool_started" else e["data"],
                        e.get("step"),
                    ),
                )
        result = []
        for cid in ids if ids is not None else calls:
            if cid not in calls or cid in done:
                continue
            c, step = calls[cid]
            old = starts.get(cid)
            result.append(
                {
                    "id": cid,
                    "name": c["name"],
                    "input": c["input"],
                    "started": old is not None,
                    **({"stepId": step} if step else {}),
                    "safeToRepeat": bool(old and old["data"].get("safeToRepeat")),
                }
            )
        return result

    async def interrupted(self, resume):
        entries = await self.entries()
        all_entries = (await self.api.session("get", session=self.sid))["entries"]
        done = {
            e.get("call")
            for e in all_entries
            if recorded_as(e, "tool_result") and not e.get("fork_source")
        }
        calls = self.calls(entries)
        calls.extend(
            c for c in self.calls(entries, resume) if c["id"] not in {x["id"] for x in calls}
        )
        calls = [c for c in calls if c["id"] not in done]
        self.prior_starts = {c["id"] for c in calls if c["started"]}
        pending = {
            e.get("call")
            for e in entries
            if e.get("turn") == self.turn and e["kind"] in {"tool_deferred", "toolPending", HANDOFF}
        }
        self.open_recovered = [c["id"] for c in calls if c["id"] in pending]
        eligible = []
        receipts = {e["call"]: e["data"] for e in entries if e["kind"] == "tool_finished"}
        for c in calls:
            cid = c["id"]
            if cid in pending:
                continue
            if cid in receipts:
                await self.runtime._result(self.sid, self.turn, c.get("stepId"), c, receipts[cid])
                continue
            definition = await self.definition(c["name"])
            prior = next(
                (
                    e
                    for e in reversed(entries)
                    if e["kind"] == "tool_started" and e.get("call") == c["id"]
                ),
                None,
            )
            source, wire_definition = (
                self.registration_for(definition) if definition else (None, None)
            )
            c["safeToRepeat"] = bool(
                prior
                and source
                and prior["data"].get("source") == source
                and prior["data"].get("definition") == wire_definition
                and c["safeToRepeat"]
                and "tools" in await self.runtime._turn_authority(self.sid, self.turn, self.actor)
                and await self.runtime._safe_to_repeat(self.sid, definition)
            )
            offered = any(
                e["kind"] == "model_started"
                and e.get("step") == c.get("stepId")
                and c["name"] in e["data"].get("tools", [])
                for e in entries
            )
            authorized = "tools" in await self.runtime._turn_authority(
                self.sid, self.turn, self.actor
            )
            if (
                self.runtime.declarations["durable"]
                and offered
                and definition
                and authorized
                and (not c["started"] or c["safeToRepeat"])
            ):
                if c["safeToRepeat"]:
                    self.repeatable.add(cid)
                eligible.append(c)
                continue
            if c["started"]:
                status, text = "outcome_unknown", UNKNOWN
            elif not offered:
                status, text = "refused", "not offered"
            elif not authorized:
                status, text = "refused", "Tool caller is not authorized"
            else:
                status, text = "not_started", "Call did not start before interruption"
            await self.finish_tool(c, c.get("stepId"), {"status": status, "content": content(text)})
        _, last = await self.step_checkpoint()
        self.step = last["stepId"] if last else None
        return {"turnId": self.turn, "calls": eligible, **({"lastStep": last} if last else {})}

    async def step_checkpoint(self, step=None):
        try:
            return await self.api.session(
                "step_checkpoint",
                session=self.sid,
                turn=self.turn,
                step=step,
                include_response=True,
            )
        except AgentError as exc:
            raise WireError(str(exc), "invalid_request") from exc

    async def checked_end_data(self, value):
        if self.outcome_error is not None:
            raise WireError(self.outcome_error, "invalid_request")
        outcome = value["outcome"]
        kind = outcome["kind"]
        if kind == "limit" and outcome.get("limit") == "questions":
            self.outcome_error = "Leaving a question open is not a turn limit"
        else:
            reported = (value.get("result") or {}).get("openToolCalls", [])
            entries = [e for e in await self.entries() if not e.get("fork_source")]
            settled = {e.get("call") for e in entries if recorded_as(e, "tool_result")}
            pending = {
                e["call"]
                for e in entries
                if e.get("turn") == self.turn
                and (
                    e["kind"] == HANDOFF
                    or e["kind"] in {"tool_deferred", "toolPending"}
                    and e["data"].get("requestIds")
                )
            } - settled
            expired = {
                e["call"] for e in entries if e["kind"] == HANDOFF and e.get("turn") == self.turn
            } & settled
            if (
                not isinstance(reported, list)
                or not all(isinstance(cid, str) for cid in reported)
                or len(reported) != len(set(reported))
                or not set(reported) <= pending | expired
                or (kind == "completed" and set(reported) - expired != pending)
                or (
                    kind == "limit"
                    and set(reported)
                    != pending - {e.get("call") for e in entries if e["kind"] == HANDOFF}
                )
                or (kind == "cancelled" and reported)
            ):
                self.outcome_error = (
                    "Reported open tool calls disagree with committed pending calls"
                )
        if self.outcome_error is not None:
            raise WireError(self.outcome_error, "invalid_request")
        return self.end_data(value)

    def end_data(self, value):
        result = value.get("result") or {}
        return {
            **self.scope,
            "input": self.start["data"].get("input"),
            **native_outcome(value["outcome"]),
            "content": content(result.get("text") or ""),
            "shared_result": {"openToolCalls": [], **result},
            "shared_outcome": value["outcome"],
            "open_calls": list(
                dict.fromkeys([*self.open_recovered, *result.get("openToolCalls", [])])
            )
            if value["outcome"]["kind"] not in {"cancelled", "failed"}
            else result.get("openToolCalls", []),
            "usage": self.native_usage(value.get("usage") or {}),
            "handed_back": [],
        }

    @staticmethod
    def native_usage(usage):
        return {
            **usage,
            **{
                k: usage[w]
                for k, w in (
                    ("input_tokens", "input"),
                    ("output_tokens", "output"),
                    ("cache_read", "cacheRead"),
                    ("cache_write", "cacheWrite"),
                )
                if w in usage
            },
        }

    async def finish(self, answer):
        if self.replay_attempt:
            await self.abort_model_attempt(self.replay_attempt)
            self.replay_attempt = None
        entries = await self.entries()
        end = next(
            (e for e in entries if e.get("turn") == self.turn and e["kind"] == "turn_end"), None
        )
        if end:
            # History is authoritative if the process stopped after committing turnEnd.
            answer = {**answer, **end["data"]}
        if answer["outcome"] in {"failed", "cancelled"}:
            await self.api.session(
                "invalidate",
                session=self.sid,
                reason="cancelled" if answer["outcome"] == "cancelled" else "failure",
            )
        if answer["outcome"] == "cancelled":
            self.runtime.cancelled.add(self.sid)
            for queued in await self.runtime._pending(self.sid):
                answer["handed_back"].append(
                    {"inputId": self.runtime._input_id(queued), "content": queued["content"]}
                )
                await self.runtime._return(self.sid, queued)
        if not end:
            await self.settle(answer)
            committed = await self.append(
                "turn_end",
                data=answer,
                copies=[
                    e["id"]
                    for e in await self.entries()
                    if e.get("turn") == self.turn and e["kind"] in {"response", "tool_result"}
                ],
            )
            answer = committed["data"]
        if not self.final_hook:
            await self.api.hook("turn.end", answer)
        await self.api.event("turn_ended", **answer)
        return answer

    async def settle(self, answer):
        entries = await self.entries()
        handoffs = {
            e["call"] for e in entries if e["kind"] == HANDOFF and e.get("turn") == self.turn
        }
        if handoffs:
            if answer["outcome"] != "completed":
                await self.api.session(
                    "interface_settle",
                    session=self.sid,
                    turn=self.turn,
                    reason="Originating turn did not complete",
                )
            done = {e.get("call") for e in await self.entries() if recorded_as(e, "tool_result")}
            answer["open_calls"] = [cid for cid in answer["open_calls"] if cid not in done]
            answer["shared_result"]["openToolCalls"] = answer["open_calls"]
        calls = {c["id"]: c for c in self.calls(entries)}
        calls.update({c["id"]: c for c in self.calls(entries, self.continuing)})
        for call in calls.values():
            cid = call["id"]
            if cid in handoffs:
                continue
            if cid in answer["open_calls"]:
                if not any(
                    e["kind"] in {"tool_deferred", "toolPending"} and e.get("call") == cid
                    for e in entries
                ):
                    await self.append(
                        "tool_deferred", call=cid, step=call.get("stepId"), data={"open": True}
                    )
                continue
            await self.ensure_call(call)
            receipt = next(
                (
                    e
                    for e in reversed(entries)
                    if e["kind"] == "tool_finished" and e.get("call") == cid
                ),
                None,
            )
            status = (
                (
                    "cancelled"
                    if answer["outcome"] == "cancelled" and not self.unrepeated(cid)
                    else "outcome_unknown"
                )
                if call["started"]
                else "not_started"
            )
            result = (
                receipt["data"]
                if receipt
                else {
                    "status": status,
                    "content": content(
                        UNKNOWN if status == "outcome_unknown" else "Call did not finish: " + status
                    ),
                }
            )
            await self.runtime._result(self.sid, self.turn, call.get("stepId"), call, result)

    async def ensure_call(self, c, sources=()):
        entries = await self.entries()
        cid = c["id"]
        entry = next((e for e in entries if e["kind"] == "tool_call" and e["call"] == cid), None)
        if entry:
            if entry.get("turn") != self.turn and cid not in self.continuing:
                raise WireError("Tool call does not belong to this turn", "invalid_request")
            return entry
        original = next(
            (
                p
                for e in entries
                if e.get("turn") == self.turn and e["kind"] == "response"
                for p in e["data"].get("calls", [])
                if p["id"] == cid
            ),
            c,
        )
        call = {
            **original,
            "actor": self.actor,
            "initiator": "model",
            "authority": await self.runtime._turn_authority(self.sid, self.turn, self.actor),
        }
        copies = [
            e["id"]
            for e in entries
            if e.get("turn") == self.turn
            and e["kind"] == "response"
            and any(p["id"] == cid for p in e["data"].get("calls", []))
        ]
        return await self.append(
            "tool_call",
            call=cid,
            step=c.get("stepId") or self.step,
            data=call,
            visible=True,
            copies=list(dict.fromkeys([*sources, *copies])),
        )

    async def definition(self, name):
        return next(
            (d for d in await self.runtime._definitions(self.sid, self.turn) if d["name"] == name),
            None,
        )

    tenant_limited = False
    capacity_limited = False

    async def check_tenant(self):
        if self.sid in self.runtime.cancelled:
            raise WireError("Turn cancelled", "cancelled")
        if self.capacity_limited:
            raise WireError(
                "Resource reservation capacity exhausted",
                "turn_limit",
                details={"limit": "capacity"},
            )
        if self.tenant_limited or await self.api.session("tenant_exhausted", session=self.sid):
            self.tenant_limited = True
            raise WireError(
                "Tenant token budget reached", "turn_limit", details={"limit": "tenantTokens"}
            )

    async def abort_model_attempt(self, entry):
        await self.append(
            "response",
            step=entry["step"],
            copies=[entry["id"]],
            data={"stop": "aborted", "recovery": True},
        )

    async def recover_model_attempts(self):
        entries = [e for e in await self.entries() if e.get("turn") == self.turn]
        settled = {e.get("step") for e in entries if recorded_as(e, "response")}
        outstanding = [
            e for e in entries if e["kind"] == "model_started" and e.get("step") not in settled
        ]
        model = self.runtime._model_record(self.access)
        for entry in outstanding:
            record = entry["data"]
            if (
                entry is outstanding[-1]
                and self.runtime.declarations["durable"]
                and model["safeToRepeat"]
                and record.get("safeToRepeat")
                and record.get("request")
                and record.get("model") == model["model"]
            ):
                self.replay_attempt = entry
            else:
                await self.abort_model_attempt(entry)

    async def prepare(self, p):
        await self.check_tenant()
        if self.replay_attempt:
            await self.abort_model_attempt(self.replay_attempt)
            self.replay_attempt = None
        self.step = p.get("stepId")
        if self.step not in self.allocated or self.step in self.step_ids:
            raise WireError("prepareStep needs a fresh allocated stepId", "invalid_request")
        self.step_ids.add(self.step)
        await self.api.event(
            "step_started", **self.scope, step=self.step, index=len(self.step_ids) - 1
        )
        if self.additions is None:
            self.additions = await self.api.session("prepare", session=self.sid, turn=self.turn)
        model_tools = self.settings.get("modelTools")
        tools = await self.runtime._definitions(self.sid, self.turn)
        if model_tools is not None:
            tools = [t for t in tools if t["name"] in model_tools]
        d = {
            **self.scope,
            "step": self.step,
            "access": self.access,
            "settings": self.settings,
            "tools": tools,
            "additions": self.additions,
            "usage": self.native_usage(p.get("usage") or {}),
        }
        prepared = request_out(await self.api.hook("step.before", d))
        self.prepared[self.step] = prepared
        return prepared

    async def model(self, request, key, step):
        await self.check_tenant()
        replay = self.replay_attempt
        if (
            replay
            and step in self.allocated - self.step_ids
            and request == replay["data"]["request"]
        ):
            self.step_ids.add(step)
            self.replay_attempt = None
        else:
            replay = None
            if step not in self.prepared or request != self.prepared.pop(step):
                raise WireError("Model request needs its exact prepared request", "invalid_request")

        async def emit(piece):
            event = piece.get("event") or {"type": "text", "delta": piece.get("text", "")}
            if event["type"] in {"text", "reasoning"}:
                await self.api.event(
                    "model_output",
                    **self.scope,
                    step=step,
                    text=event.get("delta", ""),
                    stream_type=event["type"],
                    final=False,
                )
            await self.runtime.plugin.peer.notify(
                "host/runtime/modelEvent", {"parentRequestId": key, "event": event}
            )

        d = request_in(
            request,
            {**self.scope, "step": step, "access": self.access, "provider_tools": False},
        )
        d["attempt_id"] = identity()
        if replay:
            d.update(exact_replay=True, close_attempt={"id": replay["id"], "step": replay["step"]})
        wire_provider = self.access["provider"].get("wire_provider")
        if not wire_provider:
            d = await self.api.session("prepare_model_request", **d)
            request = d.get("_shared_request", request)
            model = self.runtime._model_record(self.access)
            try:
                await self.append(
                    "model_started",
                    step=step,
                    id=d["attempt_id"],
                    **({"close_attempt": d["close_attempt"]} if replay else {}),
                    **model_request_fields(model["model"], request, model["safeToRepeat"]),
                )
            except AgentError as exc:
                if exc.code != "busy":
                    raise
                self.capacity_limited = True
                raise WireError(str(exc), "turn_limit", details={"limit": "capacity"}) from exc
        try:
            await self.check_tenant()
        except WireError:
            await self.append(
                "response",
                step=step,
                visible=False,
                copies=[d["attempt_id"]],
                data={"stop": "aborted", "recovery": True},
            )
            raise
        # The Provider always gets the host-selected model and the turn's scope.
        try:
            response = await self.api.call(self.access["target"], "generate", d, emit)
        except AgentError as exc:
            if exc.code == "busy":
                self.capacity_limited = True
                raise WireError(str(exc), "turn_limit", details={"limit": "capacity"}) from exc
            if exc.code == "turn_limit":
                await self.check_tenant()
                raise
            if exc.code == "process_lost" or (
                wire_provider and not any(e["id"] == d["attempt_id"] for e in await self.entries())
            ):
                raise
            kind = {
                "context_too_large": "contextTooLarge",
                "credentials": "credentials",
                "refused": "refused",
                "temporary": "temporary",
            }.get(exc.code, "other")
            response = {
                "content": [],
                "stop": "failed",
                "error": {"kind": kind, "message": str(exc)},
            }
        finally:
            await self.api.event("model_output", **self.scope, step=step, text="", final=True)
        response = await self.api.session(
            "bound_model_response", session=self.sid, step=step, response=response
        )
        if response.get("hostLimit") == "capacity":
            self.capacity_limited = True
        wire = response_out(response)
        self.model_answers[step] = (wire, d["attempt_id"])
        return wire

    async def hook(self, name, p):
        if name not in RUNTIME_HOOKS:
            raise WireError("Hook is not owned by the Runtime", "invalid_request")
        d = {**self.scope, "step": p.get("stepId") or self.step}
        entry = None
        if name in {"tool.before", "tool.after"}:
            c = p["call"]
            cid = c["id"]
            if name == "tool.after":
                if cid not in self.results:
                    raise WireError("Tool result has not settled", "invalid_request")
                result = self.results[cid]
                if any(p["result"].get(k) != result.get(k) for k in ("status", "content", "value")):
                    raise WireError("Tool result differs from committed result", "invalid_request")
                return {**p, "result": result}
            if (
                cid in self.gates
                or cid in self.results
                or cid in self.gating
                or cid in self.attempted
            ):
                raise WireError("Tool call is not unstarted", "invalid_request")
            async with self.journal:
                entries = await self.entries()
                proposed = next(
                    (
                        (e, draft)
                        for e in entries
                        if e["kind"] == "response"
                        for draft in e["data"].get("calls", [])
                        if draft["id"] == cid
                    ),
                    None,
                )
                if proposed is None or (
                    proposed[0].get("turn") != self.turn and cid not in self.continuing
                ):
                    raise WireError("Call has no committed proposal in scope", "invalid_request")
                response_entry, draft = proposed
                if c["name"] != draft["name"] or c["input"] != draft["input"]:
                    raise WireError("Call differs from committed proposal", "invalid_request")
                entry = await self.ensure_call({**c, "stepId": response_entry.get("step")})
                offer = next(
                    (
                        e["data"].get("tools", [])
                        for e in entries
                        if e["kind"] == "model_started"
                        and e.get("step") == response_entry.get("step")
                    ),
                    [],
                )
                if cid not in self.continuing and c["name"] not in offer:
                    self.attempted.add(cid)
                    return await self.refuse_tool(
                        p, entry["data"], entry.get("step"), "not offered"
                    )
                if (
                    cid in self.gating
                    or cid in self.gates
                    or cid in self.results
                    or any(
                        e.get("call") == cid
                        and (
                            recorded_as(e, "tool_result")
                            or e["kind"] in {"toolPending", "tool_deferred", HANDOFF}
                            and e.get("turn") == self.turn
                        )
                        for e in entries
                    )
                ):
                    raise WireError("Call already has a disposition in scope", "invalid_request")
                self.gating.add(cid)
            if entry.get("turn") != self.turn and c["id"] not in self.continuing:
                raise WireError("Tool call does not belong to this turn", "invalid_request")
            original = {"actor": self.actor, "initiator": "model", **entry["data"]}
            authority = set(await self.runtime._turn_authority(self.sid, self.turn, self.actor))
            authority &= set(
                await self.api.session(
                    "authority",
                    session=self.sid,
                    actor=original["actor"],
                    ceiling=original.get("authority"),
                )
            )
            d["call"] = {**original, "input": c["input"], "authority": sorted(authority)}
            d["step"] = c.get("stepId") or entry.get("step") or self.step
            if name == "tool.before":
                self.gates.pop(c["id"], None)
                definition = await self.definition(original["name"])
                d["definition"] = definition
                if "tools" not in authority or (
                    definition and original["initiator"] not in definition.get("callers", [])
                ):
                    return await self.refuse_tool(
                        p, original, d["step"], "Tool caller is not authorized"
                    )
                if definition is None:
                    return await self.refuse_tool(
                        p, original, d["step"], "Tool is no longer available"
                    )
            else:
                d["result"] = result_in(p["result"], original["id"])
        elif name == "model.failed":
            error = p["error"]
            d.update(
                access=self.access,
                code="context_too_large" if error["kind"] == "contextTooLarge" else error["kind"],
                error=error["message"],
                request=request_in(p["request"], {**d, "access": self.access}),
            )
        elif name == "step.after":
            return await self.after_step(d["step"], p)
        elif name == "turn.result":
            d.update(
                result=content(p["result"].get("text") or ""),
                shape=p.get("shape"),
                shared_result=p["result"],
            )
        elif name == "turn.end":
            data = await self.checked_end_data(p)
            self.final_hook = True
            await self.api.hook("turn.end", data)
            return None
        native = hooks.NAMES.get(name, name)
        a = await (
            self.runtime.plugin.h.fire("@harness", native, d)
            if name == "turn.result"
            else self.api.hook(native, d)
        )
        if name == "turn.start":
            return None
        if name == "model.failed":
            if a and a.get("retry") and self.access["provider"].get("stateful"):
                await self.api.call(self.access["target"], "discard", {"session": self.sid})
            return (
                {**a, **({"request": request_out(a["request"])} if a.get("request") else {})}
                if a
                else None
            )
        if name == "tool.after":
            return {**p, "call": call_out(a["call"]), "result": result_out(a["result"])}
        value = {**p}
        if name == "tool.before":
            # Use only transformed input, never a handler's change to caller identity.
            call = {**d["call"], "input": a["call"]["input"]}
            value["call"] = call_out(call)
            if "checked_input" in a and a["checked_input"] != call["input"]:
                a = {**a, "refused": True, "reason": "Tool input changed after approval"}
            if a.get("open") and isinstance(a.get("pending"), dict) and not a.get("refused"):
                if not self.runtime.declarations.get("open_calls"):
                    return await self.refuse_tool(
                        value, call, d["step"], "This call cannot be left open"
                    )
                question = await self.runtime._gate_question(
                    self.sid, self.turn, d["step"], call, authority, a["pending"]
                )
                if question.get("open"):
                    a = {**a, "request": question["request"], "pending": "Waiting for an answer"}
                elif question.get("declined"):
                    a = {**a, "refused": True, "reason": question.get("reason", "Declined")}
                else:
                    a = {**a, "open": False}
            if a.get("refused"):
                return await self.refuse_tool(value, call, d["step"], a.get("reason", "Refused"))
            if a.get("open") and a.get("request"):
                await self.append(
                    "tool_deferred", step=d["step"], call=cid, data={"requestIds": [a["request"]]}
                )
            self.gating.discard(cid)
            if not a.get("open") and definition:
                self.gates[call["id"]] = (call, definition, d["step"])
        elif name == "turn.result":
            value["result"] = {**a.get("shared_result", p["result"]), "text": plain(a["result"])}
            if a.get("refused"):
                await self.append("result_feedback", data={"reason": a.get("reason", "Refused")})
        return {
            "value": value,
            **({"refused": a.get("reason", "Refused")} if a.get("refused") else {}),
            **({"pending": a.get("pending", "Waiting for an answer")} if a.get("open") else {}),
        }

    async def after_step(self, step, payload):
        async with self.journal:
            response, saved = await self.step_checkpoint(step)
            expected = self.model_answers.get(step, (None,))[0]
            if response is None or (
                payload.get("response") != response["message"]
                and payload.get("response") != expected
            ):
                raise WireError("step.after does not match an answered step", "invalid_request")
            if "decision" not in saved:
                entries = await self.entries()
                disposed = {
                    e.get("call")
                    for e in entries
                    if recorded_as(e, "tool_result")
                    or e["kind"] in {"tool_deferred", "toolPending", HANDOFF}
                    and e.get("turn") == self.turn
                }
                if any(
                    p["type"] == "toolCall" and p["id"] not in disposed
                    for p in response["message"]["content"]
                ):
                    raise WireError("step.after has unsettled calls", "invalid_request")
                decision = await self.api.hook(
                    "step.after",
                    {
                        **self.scope,
                        "step": step,
                        "response": response_in(response["message"]),
                    },
                )
                saved["decision"] = (
                    {"refuse": decision.get("reason", "Refused")}
                    if decision.get("refused")
                    else None
                )
                await self.append(
                    STEP_AFTER,
                    step=step,
                    data={"decision": saved["decision"]},
                    copies=[response["id"]],
                )
            result = {"value": payload}
            if saved["decision"] is not None:
                result["refused"] = saved["decision"]["refuse"]
            return result

    async def refuse_tool(self, value, call, step, reason):
        result = {"status": "refused", "content": content(reason)}
        if self.unrepeated(call["id"]):
            result = {"status": "outcome_unknown", "content": content(UNKNOWN)}
        terminal = await self.finish_tool(call, step, result)
        self.gating.discard(call["id"])
        return {"value": value, "refused": reason, "result": terminal}

    def unrepeated(self, cid):
        return cid in self.prior_starts and cid not in self.restarted

    async def finish_tool(self, call, step, result, definition=None):
        answer = await self.api.hook(
            "tool.after",
            {**self.scope, "step": step, "call": call, "result": {**result, "call": call["id"]}},
        )
        terminal = checked_tool_result(definition, answer["result"])
        await self.runtime._result(self.sid, self.turn, step, call, terminal)
        require_processed_result(terminal)
        wire = result_out({**terminal, "call": call["id"]})
        self.results[call["id"]] = wire
        return wire

    def registration_for(self, definition):
        name = definition["name"]
        owner, source = self.runtime.plugin.h.external_tool_names.get(name, ("local", "files"))
        plugin = self.runtime.plugin.h.plugins.get(owner)
        if plugin is not None and source in getattr(plugin, "sources", {}):
            cache = plugin.sources[source]["cache"]
            for offered in cache.get(self.sid, cache.get(None, [])):
                if offered["name"] == name:
                    return {"plugin": plugin.registration["name"], "toolSource": source}, offered
        return {"plugin": owner, "toolSource": source}, tool_out(definition)

    async def tool(self, wire):
        cid = wire["id"]
        allowed = self.gates.pop(cid, None)
        if not allowed or cid in self.attempted:
            raise WireError("Tool call needs its own before gate", "invalid_request")
        call, definition, step = allowed
        if self.unrepeated(cid):
            old = next(
                e
                for e in reversed(await self.entries())
                if e["kind"] == "tool_started" and e.get("call") == cid
            )
            if call["input"] != old["data"]["call"]["input"]:
                self.attempted.add(cid)
                return await self.finish_tool(
                    call, step, {"status": "outcome_unknown", "content": content(UNKNOWN)}
                )
        if call["name"] != wire["name"] or call["input"] != wire["input"]:
            self.attempted.add(cid)
            return await self.finish_tool(
                call,
                step,
                {
                    "status": "refused",
                    "content": content("Tool call differs from its authorized input"),
                },
            )
        authority = await self.api.session(
            "authority", session=self.sid, actor=call["actor"], ceiling=call["authority"]
        )
        authority = set(authority) & set(
            await self.runtime._turn_authority(self.sid, self.turn, call["actor"])
        )
        if "tools" not in authority:
            raise WireError("Tool authority no longer holds", "invalid_request")
        if self.ended or cid in self.attempted:
            raise WireError("Tool call has already run or turn has ended", "invalid_request")
        self.inflight.add(cid)
        self.attempted.add(cid)
        try:
            entries = await self.entries()
            if any(recorded_as(e, "tool_result") and e.get("call") == cid for e in entries):
                raise WireError("Tool call already has a result", "invalid_request")
            if self.ended:
                raise WireError("Turn has ended", "invalid_request")
            if any(e["kind"] == "tool_started" and e.get("call") == cid for e in entries) and (
                cid not in self.repeatable and cid not in self.continuing
            ):
                raise WireError("Started call cannot safely repeat", "invalid_request")
            if definition.get("interfaceSource"):
                result = await self.api.session(
                    "interface_dispatch",
                    session=self.sid,
                    turn=self.turn,
                    step=step,
                    call=call,
                    definition=definition,
                )
                if result.get("open"):
                    return {"callId": cid, "pending": result["pending"]}
                if result.get("interface"):
                    committed = next(
                        e
                        for e in await self.entries()
                        if e["kind"] == "tool_result" and e.get("call") == cid
                    )
                    wire = result_out(
                        {**committed["data"], "call": cid, "content": committed["content"]}
                    )
                    self.results[cid] = wire
                    return wire
                return await self.finish_tool(call, step, result, definition)
            source, offered_definition = self.registration_for(definition)
            started = await self.append(
                "tool_started",
                step=step,
                call=cid,
                data={
                    "call": call,
                    "source": source,
                    "definition": offered_definition,
                    "openWorld": offered_definition.get("hints", {}).get("openWorld", True),
                    "safeToRepeat": await self.runtime._safe_to_repeat(self.sid, definition),
                },
                copies=[
                    e["id"] for e in entries if e["kind"] == "tool_call" and e.get("call") == cid
                ],
            )

            rights = await self.runtime._turn_authority(self.sid, self.turn, call["actor"])
            if "tools" not in set(rights) & set(
                call["authority"]
            ) or definition != await self.definition(call["name"]):
                return await self.finish_tool(
                    call,
                    step,
                    {"status": "refused", "content": content("Tool allowance no longer applies")},
                )
            if cid in self.prior_starts:
                self.restarted.add(cid)

            async def progress(piece):
                await self.api.event(
                    "tool_progress",
                    **self.scope,
                    step=step,
                    call=cid,
                    text=piece.get("text", ""),
                    final=False,
                    **({"content": piece["content"]} if "content" in piece else {}),
                )

            result = await self.api.call(
                "tools",
                "run",
                {**self.scope, "step": step, "call": call, "definition": definition},
                progress,
            )
            if result.get("open"):
                request_ids = result.get("requestIds") or (
                    [result["request"]] if result.get("request") else []
                )
                if not request_ids:
                    raise WireError(
                        "Pending tool reply has no relinquished question", "invalid_request"
                    )
                await self.append(
                    "tool_deferred",
                    call=cid,
                    step=step,
                    data={"requestIds": request_ids, "toolStartedId": started["id"]},
                )
                return {"callId": cid, "pending": result.get("pending", "Waiting for an answer")}
            return await self.finish_tool(call, step, result, definition)
        except asyncio.CancelledError:
            return {"callId": cid, "status": "cancelled", "content": content("Tool call cancelled")}
        finally:
            self.inflight.discard(cid)

    async def record(self, entry):
        async with self.journal:
            return ot.project_entry(entry_out(await self._record(entry)))

    async def _record(self, entry):
        if self.ended or any(k in entry for k in ("id", "sessionId", "parentId", "time", "turnId")):
            raise WireError("Turn or entry identity is owned by the host", "invalid_request")
        wire_kind = entry["kind"]
        kind = ENTRY_KINDS.get(wire_kind, wire_kind)
        step = entry.get("stepId") or self.step
        cid = entry.get("toolCallId")
        message = entry.get("message") or {}
        data = entry.get("data") or {}
        if kind == "turn_start":
            return self.start
        if kind in {
            "input",
            "input_queued",
            "input_withdrawn",
            "setting",
            "position",
            "erasure",
            "erase",
            "position_move",
            "tool_started",
            "toolStarted",
            "toolPending",
            "model_started",
            "modelRequest",
            "resultFeedback",
            "result_feedback",
            STEP_AFTER,
            HANDOFF,
            ot.TURN_TRACE,
            ot.DISCLOSURE,
        } or kind.startswith(("question_", "job_")):
            raise WireError("Entry kind is owned by the host", "invalid_request")
        sources = list(entry.get("sources") or [])
        if kind == "response":
            prior = next(
                (
                    e
                    for e in await self.entries()
                    if e.get("step") == step and e["kind"] == "response"
                ),
                None,
            )
            expected = self.model_answers.get(step)
            if not expected or message != expected[0]:
                raise WireError("Response does not match a model attempt", "invalid_request")
            if prior:
                return prior
            sources = [expected[1]]
            data = response_in(message)
        elif kind == "tool_result" and data.get("status") == "notStarted":
            raise WireError("Only the host can settle an abandoned call", "invalid_request")
        elif kind == "tool_result" and cid in self.results:
            result = self.results[cid]
            if (
                any(data.get(k) != result.get(k) for k in ("status", "value"))
                or message.get("content") != result["content"]
            ):
                raise WireError("Result differs from committed result", "invalid_request")
            return next(
                e
                for e in await self.entries()
                if e["kind"] == "tool_result" and e.get("call") == cid
            )
        elif kind == "tool_call":
            return await self.ensure_call(
                {**data, "id": cid or data["id"], "stepId": step}, sources
            )
        elif kind in {"tool_result", "tool_finished", "tool_deferred"}:
            cid = cid or message.get("toolCallId") or data.get("callId")
            entries = await self.entries()
            pending = self.calls(entries, [cid]) if cid in self.continuing else self.calls(entries)
            call = next((c for c in pending if c["id"] == cid), None)
            if cid in self.inflight:
                raise WireError("Tool call has not settled", "invalid_request")
            if kind == "tool_deferred":
                # Older Python Runtimes echo the pending reply as a private record.
                saved = next(
                    (
                        e
                        for e in entries
                        if e["kind"] in {"tool_deferred", HANDOFF}
                        and e.get("call") == cid
                        and e.get("turn") == self.turn
                    ),
                    None,
                )
                if saved:
                    return saved
                if "requestIds" in data or "toolStartedId" in data:
                    raise WireError("Pending checkpoint is owned by the host", "invalid_request")
            if not call:
                prior = next(
                    (
                        e
                        for e in entries
                        if e["kind"] == "tool_result"
                        and e.get("call") == cid
                        and e.get("turn") == self.turn
                    ),
                    None,
                )
                if kind == "tool_result" and prior:
                    return prior
                raise WireError("Result does not belong to an open call", "invalid_request")
            if self.unrepeated(cid) and kind in {"tool_result", "tool_deferred"}:
                receipt = next(
                    (
                        e["data"]
                        for e in reversed(entries)
                        if e["kind"] == "tool_finished" and e.get("call") == cid
                    ),
                    None,
                )
                kind = "tool_result"
                data = receipt or {"status": "outcomeUnknown"}
                message = {"content": receipt["content"] if receipt else content(UNKNOWN)}
            if kind == "tool_result":
                await self.ensure_call({**call, "stepId": step or call.get("stepId")})
                data = {
                    **data,
                    "status": STATUS_IN.get(data["status"], data["status"]),
                    "toolName": call["name"],
                }
            elif kind == "tool_finished":
                data = result_in(data, cid)
            sources.extend(
                e["id"]
                for e in await self.entries()
                if e.get("call") == cid
                and (
                    e["kind"] in {"tool_call", "tool_started", "tool_finished"}
                    or (e["kind"] == "question_open")
                )
            )
            requests = {
                e["data"]["id"]
                for e in entries
                if e["kind"] == "question_open" and e["data"].get("call") == cid
            }
            sources.extend(
                e["id"]
                for e in entries
                if e["kind"] == "question_answer" and e["data"]["request"] in requests
            )
        elif kind == "turn_end":
            data = await self.checked_end_data(data)
            if self.inflight:
                raise WireError("Turn still has running calls", "invalid_request")
            await self.settle(data)
            sources.extend(
                e["id"]
                for e in await self.entries()
                if e.get("turn") == self.turn and e["kind"] in {"response", "tool_result"}
            )
        elif kind == "summary":
            data = {**data, "covers": sources}
            message = {**message, "content": content(data["summary"])}
        saved = await self.append(
            kind,
            step=step,
            **({"call": cid} if cid else {}),
            visible=entry.get("modelVisible", kind in {"response", "tool_result"}),
            content=data.pop("content", []) if kind == "response" else message.get("content", []),
            data=data,
            copies=list(dict.fromkeys(sources)),
        )
        if kind == "turn_end":
            self.ended = True
        return saved

    def end_step(self):
        if self.step_span is not None:
            ot.end(self.step_span)
            self.step_span = self.traced_step = None

    async def callback(self, method, p, key):
        step = p.get("stepId") or self.step
        if (
            method in {"prepareStep", "model"}
            and step in self.allocated
            and step != self.traced_step
        ):
            self.end_step()
            self.traced_step = step
            self.step_span = ot.begin(
                "modular_agent.step", ot.attrs(self.sid, self.turn, step), parent=self.trace_parent
            )
        if self.step_span is not None and step == self.traced_step:
            with ot.use(ot.scoped_context(self.step_span, self.sid, self.turn, step)):
                return await self._callback(method, p, key)
        return await self._callback(method, p, key)

    async def _callback(self, method, p, key):
        if (
            self.ended
            or (self.final_hook and method != "report")
            or (p.get("turnId") is not None and p["turnId"] != self.turn)
        ):
            raise WireError("Runtime callback does not belong to an active turn", "invalid_request")
        match method:
            case "newId":
                allocated = identity()
                self.allocated.add(allocated)
                return {"id": allocated}
            case "prepareStep":
                return await self.prepare(p)
            case "model":
                return await self.model(p["request"], key, p.get("stepId"))
            case "hook":
                return await self.hook(p["hook"], p["payload"])
            case "definition":
                result = await self.definition(p["toolName"])
                return tool_out(result) if result else None
            case "runToolCall":
                return await self.tool(p["call"])
            case "record":
                return await self.record(p["entry"])
            case "takeSteering":
                async with self.runtime.admission.setdefault(self.sid, asyncio.Lock()):
                    entries = [
                        entry_out(await self.runtime._take(self.sid, e, self.turn))
                        for e in await self.runtime._pending(self.sid)
                        if e["data"]["when"] == "steer"
                    ]
                    if p.get("final") and not entries:
                        self.runtime.steering_closed.add(self.sid)
                    return {"entries": entries}
            case "hasSteering":
                return {
                    "waiting": any(
                        e["data"]["when"] == "steer" for e in await self.runtime._pending(self.sid)
                    )
                }
            case "report":
                kind = p["type"]
                data = p.get("data") or {}
                normalized = "".join(ch for ch in kind.lower() if ch.isalpha())
                if normalized not in {
                    "modeloutput",
                    "modeldelta",
                    "modelevent",
                    "stepstarted",
                    "stepstart",
                    "toolstarted",
                    "toolprogress",
                    "toolended",
                    "toolresult",
                    "historyentry",
                    "turnstart",
                    "turnstarted",
                    "turnend",
                    "turnended",
                    "stepend",
                    "stepended",
                }:
                    await self.api.event(
                        "runtime_report",
                        **self.scope,
                        type=kind,
                        data=data,
                        step=p.get("stepId"),
                        call=p.get("toolCallId"),
                    )
                return None
            case _:
                raise WireError("Unknown Runtime callback", "not_supported", -32601)
