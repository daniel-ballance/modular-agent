"""Journalled turn engine shared by the two independently installed Runtimes."""

import asyncio
import json

from jsonschema import Draft202012Validator, ValidationError
from referencing import Registry

from ma_core import TOOL_RESULT_BYTES, lower_reasoning, AgentError, content, identity
from ma_core import telemetry as ot
from ma_core.recovery import STEP_AFTER, step_checkpoint
from ma_core.wire import (
    entry_out,
    model_out,
    model_request_fields,
    recorded_as,
    request_in,
    request_out,
    settings_out,
    settings_in,
    tool_out,
)


UNKNOWN = "Call did not finish. Its outcome is unknown. Check outside state before relying on it."


def checked_tool_result(definition, result):
    schema = (definition or {}).get("returns")
    error = None
    if result["status"] == "completed" and schema is not None:
        if "value" not in result:
            error = "Completed tool result is missing its value"
        else:
            try:
                Draft202012Validator(schema, registry=Registry()).validate(result["value"])
            except ValidationError as exc:
                error = "Invalid completed tool value: " + exc.message[:512]
    if error:
        return {
            "call": result["call"],
            "status": "completed",
            "content": [],
            "_result_error": error,
        }
    if len(json.dumps(result, ensure_ascii=True, separators=(",", ":"))) > TOOL_RESULT_BYTES:
        return {
            "call": result["call"],
            "status": result["status"],
            "content": [],
            "resultUnavailable": "result_too_large",
            "_result_error": "Tool result exceeds reserved space",
        }
    return result


def require_processed_result(result):
    if error := result.get("_result_error"):
        raise AgentError(error, result.get("resultUnavailable", "internal"))


async def ordered_tools(calls, parallel, execute, record):
    """Run a tool round, presenting its results in request order."""
    if not parallel:
        for call in calls:
            await record(call, await execute(call))
        return
    tasks = [asyncio.create_task(execute(call)) for call in calls]
    try:
        for call, task in zip(calls, tasks):
            await record(call, await task)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


class Turns:
    async def _turn(self, sid, queued=None, turn=None):
        recovering = turn is not None
        turn = turn or identity()
        parent = ot.extract(None)
        if queued:
            parent = self.input_traces.pop((sid, queued["id"]), parent)
        links = []
        if recovering:
            parent = ot.saved_turn_context(await self.api.session("branch", session=sid), sid, turn)
            links = ot.link(parent)
        elif queued:
            origin = (queued["data"].get("source") or {}).get("continuesTurnId")
            if origin:
                links = ot.link(
                    ot.saved_turn_context(
                        await self.api.session("branch", session=sid),
                        sid,
                        origin,
                    )
                )
        label = "invoke_agent"
        agent = ot.name(self.api._harness.agent_name)
        if agent:
            label += " " + agent
        with (
            ot.span(
                label,
                ot.attrs(
                    sid,
                    turn,
                    **{
                        "gen_ai.operation.name": "invoke_agent",
                        "gen_ai.agent.name": agent,
                        "modular_agent.turn.resumed": True if recovering else None,
                    },
                ),
                parent=parent,
                links=links,
            ) as operation,
            ot.Steps(sid, turn).track(),
        ):
            ot.set_attrs(operation, {"modular_agent.turn.outcome": "interrupted"})
            segment = ot.segment(operation, parent) if self.declarations["durable"] else {}
            if recovering and segment:
                await self.api.session(
                    "append",
                    session=sid,
                    turn=turn,
                    kind=ot.TURN_TRACE,
                    writer="@harness",
                    visible=False,
                    data=segment,
                )
            result = await self._run_turn(sid, queued, turn, recovering, segment)
            ot.set_attrs(operation, {"modular_agent.turn.outcome": result["outcome"]})
            if result["outcome"] == "failed":
                ot.error(operation, "turn_failed")
            return result

    async def _definitions(self, sid):
        try:
            return await self.api.call("tools", "definitions", {"session": sid})
        except AgentError as exc:
            if exc.code != "process_lost":
                raise
            return []  # A lost tool router cannot offer tools; inference can continue.

    async def _safe_to_repeat(self, sid, definition):
        declarations = await self.api.session("declaration", session=sid)
        return bool(
            (definition or {}).get("hints", {}).get("safe_to_repeat")
            and any(d.get("stops_commands_on_crash") for d in declarations.values())
        )

    async def _save_point(self, sid):
        declarations = await self.api.session("declaration", session=sid)
        if any(p.get("rewind") for p in declarations.values()):
            try:
                return await self.api.call("environment", "save", {"session": sid})
            except AgentError:
                # An unsaved boundary must never look like a rewindable one.
                return {"pointUnavailable": True}
        return {}

    @staticmethod
    def _lower_reasoning(settings, access):
        settings = dict(settings)
        if "thinking" in settings:
            settings["thinking"] = lower_reasoning(
                settings["thinking"], access.get("thinking") or []
            )
        return settings

    async def _turn_snapshot(self, sid, turn, queued):
        settings = (await self.api.session("get", session=sid))["settings"]
        problem = None
        try:
            access = await self.api.call("selection", "access", {"session": sid})
            model = model_out(access, access["target"])
            settings = self._lower_reasoning(settings, access)
        except AgentError as exc:
            problem = exc
            model = settings_out(settings).get("model")
        try:
            additions = await self.api.session(
                "prepare", session=sid, turn=turn, input=queued["content"]
            )
        except AgentError as exc:
            problem = exc
            additions = []
        return (
            {
                "model": {k: model[k] for k in ("provider", "id")} if model else None,
                "system": "\n\n".join(a.get("system", "") for a in additions),
                "context": [p for a in additions for p in a.get("context", [])],
                **await self._save_point(sid),
                "tools": [tool_out(t) for t in await self._definitions(sid)],
                "settings": {
                    k: v
                    for k, v in settings_out(settings).items()
                    if k in {"reasoning", "maxSteps", "maxOutput", "modelTools"}
                },
            },
            additions,
            problem,
        )

    async def _turn_access(self, sid, start):
        settings = (await self.api.session("get", session=sid))["settings"]
        snapshot = start.get("data", {})
        model = snapshot.get("model")
        model_id = settings_in({"model": model})["model"] if model else None
        access = await self.api.call("selection", "access", {"session": sid, "model": model_id})
        return access, self._lower_reasoning(
            {**settings, **settings_in(snapshot.get("settings") or {})}, access
        )

    async def _run_turn(self, sid, queued, turn, recovering, segment):
        outcome, error = "completed", None
        self.steering_closed.discard(sid)
        prior_starts = set()
        if recovering:
            prior_starts = {
                e["call"]
                for e in await self._entries(sid)
                if e.get("turn") == turn and e["kind"] == "tool_started"
            }
        open_calls, additions, problem = [], None, None
        if not recovering:
            snapshot, additions, problem = await self._turn_snapshot(sid, turn, queued)
            await self._record(
                sid,
                turn,
                "turn_start",
                actor=queued["actor"],
                first_input=self._taken_input(queued),
                data={
                    "input": queued["id"],
                    "source": queued["data"].get("source"),
                    **snapshot,
                    **segment,
                    **(
                        {"result_schema": queued["data"]["result_schema"]}
                        if "result_schema" in queued["data"]
                        else {}
                    ),
                },
            )
        result, usage, structured = [], {}, {}
        tenant_limit = capacity_limit = False
        start = next(
            e
            for e in await self._entries(sid)
            if e.get("turn") == turn and e["kind"] == "turn_start"
        )
        actor = start["actor"]
        schema = start["data"].get("result_schema")
        try:
            es = [e for e in await self._entries(sid) if e.get("turn") == turn]
            if start["data"].get("input") and not any(e["kind"] == "input" for e in es):
                raise AgentError("Interrupted turn has no committed first input", "lost")
            if await self.api.session("tenant_exhausted", session=sid):
                raise AgentError("Tenant token budget reached", "tenantTokens")
            if problem is not None:
                raise problem
            queued = next(
                (e for e in await self._entries(sid) if e["id"] == start["data"].get("input")), None
            )
            actor = queued["actor"] if queued else start["actor"]
            access, settings = await self._turn_access(sid, start)
            tools = await self._definitions(sid)
            if additions is None:
                additions = (
                    [
                        {
                            "system": start["data"]["system"],
                            "context": start["data"].get("context", []),
                        }
                    ]
                    if "system" in start["data"]
                    else (await self.api.session("prepare", session=sid, turn=turn))
                )
            if schema is not None:
                import json

                additions = [
                    *additions,
                    {
                        "system": "Return the final answer as a single JSON value matching this schema: "
                        + json.dumps(schema)
                    },
                ]
            if recovering:
                _, last = await self._step_checkpoint(sid, turn)
                if last and last.get("decision") is not None:
                    raise AgentError(last["decision"]["refuse"], "refused")
            else:
                await self.api.hook("turn.start", {"session": sid, "turn": turn, "actor": actor})
            resume = queued["data"].get("resume", []) if queued else []
            if resume:
                es = await self.api.session("branch", session=sid)
                by_call = {
                    c["id"]: c
                    for e in es
                    if e["kind"] == "response"
                    for c in e["data"].get("calls", [])
                }
                by_call.update({e["call"]: e["data"] for e in es if e["kind"] == "tool_call"})
                calls = [by_call[cid] for cid in resume if cid in by_call]
                origin = (queued["data"].get("source") or {}).get("continuesTurnId")
                open_calls = await self._tools(
                    sid, turn, "late:" + turn, calls, tools, continuation_of=origin
                )
            # Replay journal decisions, not model requests or completed effects.
            while not open_calls:
                tools = await self._definitions(sid)
                es = [e for e in await self._entries(sid) if e.get("turn") == turn]
                responses = [e for e in es if e["kind"] == "response"]
                usage = {}
                for response in responses:
                    for key, value in response["data"].get("usage", {}).items():
                        usage[key] = usage.get(key, 0) + value
                if responses:
                    result = responses[-1]["content"]
                # A portable writer need not keep the native step admission cache.
                by_step = {}
                for e in es:
                    if e["kind"] in {"step_start", "model_started", "response"}:
                        by_step.setdefault(e["step"], e)
                starts = list(by_step.values())
                ends = {e["step"]: e for e in es if e["kind"] == "step_end"}
                if starts and starts[-1]["step"] in ends:
                    last = ends[starts[-1]["step"]]["data"]
                    if not last["continue"]:
                        result = last.get("result", result)
                        structured = {"value": last["value"]} if "value" in last else {}
                        outcome, error = last["outcome"], last.get("error")
                        break
                pending = starts[-1] if starts and starts[-1]["step"] not in ends else None
                if not pending:
                    if await self.api.session("tenant_exhausted", session=sid):
                        raise AgentError("Tenant token budget reached", "tenantTokens")
                    tokens = sum(
                        e.get("data", {}).get("usage", {}).get(k, 0)
                        for e in await self.api.session("branch", session=sid)
                        if e["kind"] in {"response", "job_end"}
                        for k in ("input_tokens", "output_tokens")
                    )
                    if settings.get("max_tokens") is not None and tokens >= settings["max_tokens"]:
                        outcome, error = "limit", "session token limit"
                        break
                    if len(starts) >= settings.get("max_steps", 16):
                        outcome, error = "limit", "step limit"
                        break
                    for e in await self._pending(sid):
                        if e["data"]["when"] == "steer":
                            await self._take(sid, e, turn)
                    step = identity()
                    ot.step_start(step)
                    pending = await self._record(sid, turn, "step_start", step=step)
                    await self.api.event(
                        "step_started", session=sid, turn=turn, step=step, index=len(starts)
                    )
                step = pending["step"]
                ot.step_start(step)
                response_entry = next(
                    (e for e in reversed(responses) if e.get("step") == step), None
                )
                if response_entry is not None and response_entry["data"].get("recovery"):
                    raise AgentError("Interrupted model request was not safe to repeat", "lost")
                if response_entry is None:
                    response_entry = await self._model(
                        sid, turn, step, access, settings, tools, additions, usage
                    )
                step = response_entry["step"]
                response = response_entry["data"]
                result = response_entry["content"]
                calls = response.get("calls", [])
                # Response plus full call list is a single history-store transaction.
                # A crash during call admission is repaired from that immutable list.
                existing = {e["call"] for e in await self._entries(sid) if e["kind"] == "tool_call"}
                for c in calls:
                    if c["id"] not in existing:
                        definition = next((t for t in tools if t["name"] == c["name"]), None)
                        await self._record(
                            sid,
                            turn,
                            "tool_call",
                            copies=[response_entry["id"]],
                            call=c["id"],
                            step=step,
                            visible=True,
                            data={
                                **c,
                                "definition": definition,
                                "initiator": "model",
                                "actor": actor,
                                "authority": await self._turn_authority(sid, turn, actor),
                            },
                        )
                open_calls = await self._tools(sid, turn, step, calls, tools)
                decision = await self._step_after(sid, turn, response_entry)
                if response.get("hostLimit") == "capacity":
                    raise AgentError("Resource reservation capacity exhausted", "capacity")
                if await self.api.session("tenant_exhausted", session=sid):
                    raise AgentError("Tenant token budget reached", "tenantTokens")
                if open_calls and not decision.get("refused"):
                    break
                more = bool(
                    calls or any(e["data"]["when"] == "steer" for e in await self._pending(sid))
                )
                if decision.get("refused"):
                    raise AgentError(decision.get("reason", "Step refused"), "refused")
                if decision.get("end"):
                    more = False
                elif not more:
                    if response.get("stop") in {"failed", "refused"}:
                        raise AgentError(
                            (response.get("error") or {}).get(
                                "message", "Model " + response["stop"]
                            )
                        )
                    if response.get("stop") == "output_limit":
                        outcome, error = "limit", "output limit"
                    else:
                        check = await self.api.hook(
                            "result.ready",
                            {
                                "session": sid,
                                "turn": turn,
                                "result": result,
                                "result_schema": schema,
                            },
                        )
                        if check and "result" in check:
                            result = check["result"]
                        if check and "value" in check:
                            structured = {"value": check["value"]}
                        if check and check.get("retry"):
                            await self._record(
                                sid, turn, "result_feedback", data={"reason": check["reason"]}
                            )
                            more = True
                if not more:
                    async with self.admission.setdefault(sid, asyncio.Lock()):
                        if not decision.get("end") and outcome == "completed":
                            more = any(
                                e["data"]["when"] == "steer" for e in await self._pending(sid)
                            )
                        if not more:
                            self.steering_closed.add(sid)
                await self._record(
                    sid,
                    turn,
                    "step_end",
                    step=step,
                    copies=[
                        e["id"]
                        for e in await self._entries(sid)
                        if e.get("turn") == turn and e["kind"] in {"response", "tool_result"}
                    ],
                    data={
                        "continue": more,
                        "outcome": outcome,
                        "error": error,
                        "result": result,
                        **structured,
                    },
                )
                await self.api.event("step_ended", session=sid, turn=turn, step=step, usage=usage)
                ot.step_end()
        except asyncio.CancelledError:
            if sid in self.suspending:
                raise
            outcome, error = "cancelled", "turn cancelled"
            self.cancelled.add(sid)
            await self.api.session("invalidate", session=sid, reason="cancelled")
        except Exception as exc:
            tenant_limit = isinstance(exc, AgentError) and exc.code == "tenantTokens"
            step_limit = isinstance(exc, AgentError) and exc.code == "stepLimit"
            capacity_limit = isinstance(exc, AgentError) and exc.code in {"capacity", "busy"}
            outcome, error = (
                ("limit" if tenant_limit or step_limit or capacity_limit else "failed"),
                str(exc),
            )
            if not tenant_limit:
                await self.api.session("invalidate", session=sid, reason="failure")
        finally:
            ot.step_end()
            if sid not in self.suspending:
                await self._settle(sid, turn, outcome == "cancelled", prior_starts=prior_starts)
        # Include the final response in usage even if the turn ended by an exception.
        usage = {}
        es = await self._entries(sid)
        for e in es:
            if e.get("turn") == turn and e["kind"] == "response":
                for key, value in e["data"].get("usage", {}).items():
                    usage[key] = usage.get(key, 0) + value
        handed_back = []
        if outcome == "cancelled":
            for queued in await self._pending(sid):
                handed_back.append(
                    {"inputId": self._input_id(queued), "content": queued["content"]}
                )
                await self._return(sid, queued)
        answer = {
            "input": start["data"].get("input"),
            "handed_back": handed_back,
            "session": sid,
            "turn": turn,
            "outcome": outcome,
            "content": result,
            "error": error,
            "usage": usage,
            "open_calls": open_calls,
            **(structured if outcome == "completed" else {}),
            **(
                {
                    "shared_outcome": {
                        "kind": "limit",
                        "limit": "capacity" if capacity_limit else "tenantTokens",
                    }
                }
                if tenant_limit or capacity_limit
                else {}
            ),
            "actor": actor,
        }
        sources = [
            e["id"]
            for e in es
            if e.get("turn") == turn and e["kind"] in {"response", "tool_result"}
        ]
        await self._record(sid, turn, "turn_end", data=answer, copies=sources)
        await self.api.hook("turn.end", answer)
        await self.api.event("turn_ended", **answer)
        if open_calls:
            await self.wake({"session": sid}, None)
        return answer

    async def _step_checkpoint(self, sid, turn, step=None):
        branch = await self.api.session("branch", session=sid)
        branch_ids = {e["id"] for e in branch}
        branch.extend(
            e
            for e in await self._entries(sid)
            if e["id"] not in branch_ids and recorded_as(e, STEP_AFTER)
        )
        try:
            return step_checkpoint(
                [entry_out(e) for e in branch if not e.get("fork_source")], turn, step
            )
        except ValueError as exc:
            raise AgentError(str(exc), "lost") from exc

    async def _step_after(self, sid, turn, response):
        step = response["step"]
        _, saved = await self._step_checkpoint(sid, turn, step)
        if "decision" in saved:
            previous = saved["decision"]
            return {"refused": True, "reason": previous["refuse"]} if previous is not None else {}
        value = await self.api.hook(
            "step.after",
            {
                "session": sid,
                "turn": turn,
                "step": step,
                "response": {**response["data"], "content": response["content"]},
            },
        )
        decision = {"refuse": value.get("reason", "Refused")} if value.get("refused") else None
        await self._record(
            sid, turn, STEP_AFTER, step=step, data={"decision": decision}, copies=[response["id"]]
        )
        return value

    async def _turn_authority(self, sid, turn, actor):
        authority = set(await self.api.session("authority", session=sid, actor=actor))
        for e in await self._entries(sid):
            if e.get("turn") == turn and e["kind"] == "input":
                authority &= set(
                    await self.api.session(
                        "authority",
                        session=sid,
                        actor=e["actor"],
                        ceiling=e.get("data", {}).get("authority"),
                    )
                )
                for contributor in ("releasedBy", "acting_for"):
                    if principal := e["data"].get(contributor):
                        authority &= set(
                            await self.api.session("authority", session=sid, actor=principal)
                        )
        return sorted(authority)

    @staticmethod
    def _model_record(access):
        model = model_out(access, access["target"])
        provider = access["provider"]
        return {
            "model": {k: model[k] for k in ("provider", "id")},
            "safeToRepeat": bool(
                provider.get("requests_safe_to_repeat")
                or (
                    not provider.get("explicit_repeat_promise")
                    and not (provider.get("stateful") or provider.get("runs_tools"))
                )
            ),
        }

    async def _model(self, sid, turn, step, access, settings, tools, additions, usage):
        model_tools = settings.get("modelTools")
        if model_tools is not None:
            tools = [t for t in tools if t["name"] in model_tools]
        es = [e for e in await self._entries(sid) if e.get("step") == step]
        outstanding = next(
            (e for e in reversed(es) if e["kind"] in {"model_started", "response", "model_error"}),
            None,
        )
        changed_request, exact_replay = None, False
        if outstanding and outstanding["kind"] == "model_started":
            recorded = outstanding["data"]
            model = self._model_record(access)
            if not (
                recorded.get("safeToRepeat")
                and recorded.get("request")
                and model["safeToRepeat"]
                and model["model"] == recorded["model"]
            ):
                await self._record(
                    sid,
                    turn,
                    "response",
                    step=step,
                    copies=[outstanding["id"]],
                    data={"stop": "aborted", "recovery": True},
                )
                raise AgentError(
                    "Interrupted model request has unknown outside effects; not safe to repeat"
                )
            await self.api.session("invalidate", session=sid, reason="interrupted_model")
            changed_request = request_in(
                recorded["request"],
                {
                    "session": sid,
                    "turn": turn,
                    "access": access,
                    "provider_tools": False,
                    "actor": outstanding["actor"],
                },
            )
            exact_replay = True
            step = await self._retry_step(sid, turn, step, settings)
        retries = sum(e["kind"] == "model_error" for e in es)
        while True:
            request = changed_request or await self.api.hook(
                "step.before",
                {
                    "session": sid,
                    "turn": turn,
                    "step": step,
                    "access": access,
                    "settings": settings,
                    "tools": tools,
                    "additions": additions,
                    "usage": usage,
                },
            )
            attempt = identity()
            request = {**request, "step": step, "attempt_id": attempt, "exact_replay": exact_replay}
            if exact_replay:
                request["close_attempt"] = {"id": outstanding["id"], "step": outstanding["step"]}
            wire_provider = access["provider"].get("wire_provider")
            if not wire_provider:
                request = await self.api.session("prepare_model_request", **request)
                model = self._model_record(access)
                final = request.get("_shared_request") or request_out(request)
                await self._record(
                    sid,
                    turn,
                    "model_started",
                    step=step,
                    id=attempt,
                    **({"close_attempt": request["close_attempt"]} if exact_replay else {}),
                    **model_request_fields(model["model"], final, model["safeToRepeat"]),
                )

            async def stream(piece):
                event = piece.get("event") or {"type": "text", "delta": piece.get("text", "")}
                if event["type"] not in {"text", "reasoning"}:
                    return
                await self.api.event(
                    "model_output",
                    session=sid,
                    turn=turn,
                    step=step,
                    text=event.get("delta", ""),
                    stream_type=event["type"],
                    final=False,
                )

            try:
                response = await self.api.call(access["target"], "generate", request, stream)
            except AgentError as exc:
                if wire_provider and not any(e["id"] == attempt for e in await self._entries(sid)):
                    raise
                error = {"kind": "other", "message": str(exc)}
                code = exc.code
                response = {"stop": "failed", "error": error}
            else:
                if response.get("stop") != "failed":
                    break
                error = response.get("error") or {"kind": "other", "message": "Model failed"}
                code = {"contextTooLarge": "context_too_large"}.get(error["kind"], error["kind"])
            finally:
                await self.api.event(
                    "model_output", session=sid, turn=turn, step=step, text="", final=True
                )
            failure = await self._record(
                sid,
                turn,
                "response",
                step=step,
                copies=[attempt],
                content=response.get("content", []),
                data={k: v for k, v in response.items() if k != "content"},
            )
            await self._record(
                sid, turn, "model_error", step=step, data={"code": code, "error": error["message"]}
            )
            action = await self.api.hook(
                "model.failed",
                {
                    "session": sid,
                    "turn": turn,
                    "step": step,
                    "access": access,
                    "request": request,
                    "code": code,
                    "error": error["message"],
                    "model_error": error,
                },
            )
            decision = await self._step_after(sid, turn, failure)
            if decision.get("refused"):
                raise AgentError(decision.get("reason", "Step refused"), "refused")
            if not action or not action.get("retry") or retries >= settings.get("max_retries", 1):
                raise AgentError(error["message"], code)
            changed_request = action.get("request")
            if changed_request:
                changed_request.pop("_provider_scope", None)
            exact_replay = False
            retries += 1
            step = await self._retry_step(sid, turn, step, settings)
        response = await self.api.session(
            "bound_model_response", session=sid, step=step, response=response
        )
        calls = response.get("calls", [])
        ids = [c["id"] for c in calls]
        existing = {e["call"] for e in await self._entries(sid) if e["kind"] == "tool_call"}
        if len(ids) != len(set(ids)) or existing.intersection(ids):
            raise AgentError("Provider returned duplicate tool call IDs")
        return await self._record(
            sid,
            turn,
            "response",
            copies=[attempt],
            step=step,
            visible=True,
            content=response.get("content", []),
            data={
                **{k: v for k, v in response.items() if k != "content"},
                "stop": response.get("stop", "finished"),
                "usage": response.get("usage", {}),
                "calls": calls,
            },
        )

    async def _retry_step(self, sid, turn, prior, settings):
        branch = await self._entries(sid)
        count = sum(e.get("turn") == turn and e["kind"] == "model_started" for e in branch)
        await self._record(
            sid, turn, "step_end", step=prior, data={"continue": True, "outcome": "completed"}
        )
        if count >= settings.get("max_steps", 16):
            raise AgentError("step limit", "stepLimit")
        step = identity()
        ot.step_start(step)
        await self._record(sid, turn, "step_start", step=step)
        await self.api.event("step_started", session=sid, turn=turn, step=step, index=count)
        return step

    async def _result(self, sid, turn, step, call, answer):
        es = await self._entries(sid)
        if answer.get("open"):
            pending = answer
            if not pending.get("requestIds") and pending.get("request"):
                pending = {**answer, "requestIds": [answer["request"]]}
            await self._record(sid, turn, "tool_deferred", step=step, call=call["id"], data=pending)
            return
        if any(e["kind"] == "tool_result" and e.get("call") == call["id"] for e in es):
            return
        # An invocation settled without dispatch cannot consume another answer.
        if answer["status"] == "outcome_unknown" and any(
            e["kind"] == "question_open" and e.get("call") == call["id"] for e in es
        ):
            await self.api.call("questions", "close_call", {"session": sid, "call": call["id"]})
        sources = [
            e["id"]
            for e in es
            if e.get("call") == call["id"]
            and e["kind"] in {"tool_call", "tool_started", "tool_finished"}
        ]
        await self._record(
            sid,
            turn,
            "tool_result",
            step=step,
            call=call["id"],
            visible=True,
            content=answer["content"],
            copies=sources,
            data={
                **{
                    k: v for k, v in answer.items() if k not in {"call", "content", "_result_error"}
                },
                "toolName": call.get("name")
                or next(
                    (
                        e["data"]["name"]
                        for e in es
                        if e["kind"] == "tool_call" and e.get("call") == call["id"]
                    ),
                    "unknown",
                ),
                "late": any(
                    e["kind"] == "tool_call"
                    and e.get("call") == call["id"]
                    and e.get("turn") != turn
                    for e in es
                ),
            },
        )
        await self.api.event(
            "tool_progress", session=sid, turn=turn, step=step, call=call["id"], text="", final=True
        )

    async def _tools(self, sid, turn, step, calls, tools, *, continuation_of=None):
        es = await self._entries(sid)
        done = {e.get("call") for e in es if recorded_as(e, "tool_result")}
        receipts = {e["call"]: e["data"] for e in es if e["kind"] == "tool_finished"}
        started = {e["call"]: e for e in es if e["kind"] == "tool_started"}
        relinquished = {}
        call_steps = {}
        if continuation_of is not None:
            branch = await self.api.session("branch", session=sid)
            open_ids = {
                cid
                for e in branch
                if e.get("turn") == continuation_of and recorded_as(e, "turn_end")
                for cid in e["data"].get("open_calls", [])
            }
            for e in branch:
                cid = e.get("call")
                if (
                    cid in open_ids
                    and e.get("turn") == continuation_of
                    and e["kind"] == "tool_deferred"
                ):
                    relinquished[cid] = e["data"].get("toolStartedId")
                    call_steps[cid] = e.get("step")

        async def execute(c):
            recorded = next(
                (e["data"] for e in es if e["kind"] == "tool_call" and e["call"] == c["id"]), {}
            )
            session = await self.api.session("get", session=sid)
            c = {**recorded, **c}
            c.setdefault("actor", session["actor"])
            c.setdefault("initiator", "model")
            if c["id"] in receipts:
                return receipts[c["id"]]
            old = started.get(c["id"])
            if old and relinquished.get(c["id"]) == old["id"]:
                # A pending disposition ends this invocation. It does not cover
                # a later start or give the continuation new gate authority.
                old = None
            if not step.startswith("late:"):
                offered = next(
                    (
                        e["data"].get("tools", [])
                        for e in es
                        if e["kind"] == "model_started" and e.get("step") == step
                    ),
                    [],
                )
                if c["name"] not in offered:
                    if not old:
                        ot.tool_disposition(sid, turn, step, c, None, {"status": "refused"})
                    return {
                        "status": "outcome_unknown" if old else "refused",
                        "content": content(UNKNOWN if old else "not offered"),
                    }
            definition = next((t for t in tools if t["name"] == c["name"]), None)
            if old:
                prior = old.get("data", {})
                was_safe = prior.get(
                    "safeToRepeat",
                    (prior.get("definition") or {}).get("hints", {}).get("safe_to_repeat"),
                )
                if not (was_safe and await self._safe_to_repeat(sid, definition)):
                    return {"status": "outcome_unknown", "content": content(UNKNOWN)}
                c["input"] = prior.get("call", {}).get("input", c["input"])
            return await self._tool(
                sid, turn, call_steps.get(c["id"], step), c, definition, replay=old is not None
            )

        deferred = {
            e.get("call")
            for e in es
            if e.get("turn") == turn and e["kind"] in {"tool_deferred", "toolPending"}
        }
        pending = [c for c in calls if c["id"] not in done | deferred]
        parallel = bool(calls) and all(
            next((t.get("parallel", False) for t in tools if t["name"] == c["name"]), False)
            for c in calls
        )
        opened = [c["id"] for c in calls if c["id"] in deferred - done]

        async def record(c, answer):
            await self._result(sid, turn, call_steps.get(c["id"], step), c, answer)
            require_processed_result(answer)
            if answer.get("open"):
                opened.append(c["id"])

        await ordered_tools(pending, parallel, execute, record)
        return opened

    async def _gate_question(self, sid, turn, step, call, authority, question):
        return await self.api.call(
            "questions",
            "ask",
            {
                **question,
                "session": sid,
                "actor": call["actor"],
                "authority": sorted(authority),
                "call": call["id"],
                "turn": turn,
                "step": step,
                "name": question.get("credential"),
                "timeout": 0,
                "park": True,
                "key": "call:" + call["id"] + ":gate",
                **({"responders": question["answerers"]} if "answerers" in question else {}),
                **(
                    {
                        "approval_call": {
                            "name": call["name"],
                            "input": call["input"],
                        }
                    }
                    if question["kind"] == "approval"
                    else {}
                ),
            },
        )

    async def _tool(self, sid, turn, step, call, definition, *, replay=False):
        ran_again = False
        unknown = {"status": "outcome_unknown", "content": content(UNKNOWN)}
        answer = {"call": call["id"], "status": "failed", "content": []}
        self.active_calls.add((sid, call["id"]))
        try:
            if replay:
                authority = await self.api.session(
                    "authority", session=sid, actor=call["actor"], ceiling=call.get("authority")
                )
                if "tools" not in authority or definition is None:
                    return unknown
            gate = await self.api.hook(
                "tool.before",
                {
                    "session": sid,
                    "turn": turn,
                    "step": step,
                    "call": call,
                    "definition": definition,
                },
            )
            authority = await self.api.session(
                "authority", session=sid, actor=call["actor"], ceiling=call.get("authority")
            )
            if turn is not None:
                authority = set(authority) & set(
                    await self._turn_authority(sid, turn, call["actor"])
                )
            if "tools" not in authority:
                gate = {**gate, "refused": True, "reason": "Actor lacks authority: tools"}
            if gate.get("open") and not gate.get("refused") and not gate.get("pending"):
                return unknown if replay else {"open": True, "request": gate["request"]}
            caller = "plugin" if call.get("parentCallId") else call.get("initiator", "model")
            if definition and caller not in definition.get("callers", []):
                gate = {**gate, "refused": True, "reason": "Tool does not allow this initiator"}
            if "checked_input" in gate and gate["checked_input"] != gate["call"]["input"]:
                gate = {**gate, "refused": True, "reason": "Tool input changed after approval"}
            if gate.get("pending") and not gate.get("refused"):
                if replay:
                    return unknown
                if call.get("parentCallId") or not self.declarations.get("open_calls"):
                    gate = {**gate, "refused": True, "reason": "This tool call cannot be left open"}
                else:
                    reply = await self._gate_question(
                        sid, turn, step, gate["call"], authority, gate["pending"]
                    )
                    if reply.get("open"):
                        return {"open": True, "request": reply["request"]}
                    if reply.get("declined"):
                        gate = {**gate, "refused": True, "reason": reply.get("reason", "Declined")}
            if gate.get("refused"):
                ot.tool_disposition(sid, turn, step, call, definition, {"status": "refused"})
                if replay:
                    return unknown
                answer.update(status="refused", content=content(gate.get("reason", "Refused")))
            elif definition is None:
                if call.get("parentCallId"):
                    answer["status"] = "refused"
                answer["content"] = content("Unknown tool: " + call["name"])
            else:
                changed = {**gate["call"], "id": call["id"], "name": call["name"]}
                if replay and changed["input"] != call["input"]:
                    return unknown
                invocation = await self._record(
                    sid,
                    turn,
                    "tool_started",
                    step=step,
                    call=call["id"],
                    actor=call["actor"],
                    data={
                        "call": changed,
                        "definition": definition,
                        "openWorld": definition.get("hints", {}).get("external", True),
                        "safeToRepeat": await self._safe_to_repeat(sid, definition),
                        **(await self._save_point(sid) if turn is None else {}),
                    },
                    copies=[
                        e["id"]
                        for e in await self._entries(sid)
                        if e["kind"] == "tool_call" and e["call"] == call["id"]
                    ],
                )

                async def progress(piece):
                    await self.api.event(
                        "tool_progress",
                        session=sid,
                        turn=turn,
                        step=step,
                        call=call["id"],
                        text=piece.get("text", ""),
                        final=False,
                        **({"content": piece["content"]} if "content" in piece else {}),
                    )

                ran_again = True
                answer = await self.api.call(
                    "tools",
                    "run",
                    {
                        "session": sid,
                        "turn": turn,
                        "step": step,
                        "call": changed,
                        "definition": definition,
                    },
                    progress,
                )
                if answer.get("open"):
                    return {**answer, "toolStartedId": invocation["id"]}
                answer["call"] = call["id"]
            answer = (
                await self.api.hook(
                    "tool.after", {"session": sid, "turn": turn, "call": call, "result": answer}
                )
            )["result"]
        except asyncio.CancelledError:
            if sid in self.suspending:
                raise
            if replay and not ran_again:
                answer.update(unknown)
            else:
                answer.update(status="cancelled", content=content("Tool call cancelled"))
            await self._receipt(sid, turn, step, call, answer)
            raise
        except Exception as exc:
            if replay and not ran_again:
                return unknown
            lost = isinstance(exc, AgentError) and exc.code == "process_lost"
            answer.update(
                status="outcome_unknown" if lost else "failed",
                content=content(UNKNOWN + " " + str(exc) if lost else str(exc)),
            )
        finally:
            self.active_calls.discard((sid, call["id"]))
        answer = checked_tool_result(definition, answer)
        await self._receipt(sid, turn, step, call, answer)
        return answer

    async def _receipt(self, sid, turn, step, call, answer):
        es = await self._entries(sid)
        sources = [e["id"] for e in es if e.get("call") == call["id"] and e["kind"] == "tool_call"]
        requests = {
            e["data"]["id"]
            for e in es
            if e["kind"] == "question_open" and e["data"].get("call") == call["id"]
        }
        sources.extend(
            e["id"]
            for e in es
            if e["kind"] == "question_answer" and e["data"]["request"] in requests
        )
        await self._record(
            sid, turn, "tool_finished", step=step, call=call["id"], copies=sources, data=answer
        )

    async def _settle(self, sid, turn, cancelled=False, *, prior_starts=()):
        es = await self._entries(sid)
        done = {e.get("call") for e in es if recorded_as(e, "tool_result")}
        started = {e["call"] for e in es if e["kind"] == "tool_started"}
        receipts = {e["call"]: e["data"] for e in es if e["kind"] == "tool_finished"}
        # Also repair a crash partway through admitting the persisted response calls.
        existing = {e["call"] for e in es if e["kind"] == "tool_call"}
        for e in es:
            if e.get("turn") == turn and e["kind"] == "response":
                for c in e["data"].get("calls", []):
                    if c["id"] not in existing:
                        added = await self._record(
                            sid,
                            turn,
                            "tool_call",
                            step=e.get("step"),
                            call=c["id"],
                            visible=True,
                            copies=[e["id"]],
                            data=c,
                        )
                        existing.add(c["id"])
                        es.append(added)
        deferred = {e["call"] for e in es if e["kind"] == "tool_deferred"}
        for e in es:
            if not cancelled and e.get("call") in deferred and e.get("call") not in receipts:
                continue
            if (
                e["kind"] != "tool_call"
                or e.get("turn") != turn
                or e["call"] in done
                or e["data"].get("parentCallId")
            ):
                continue
            status = (
                ("cancelled" if cancelled and e["call"] not in prior_starts else "outcome_unknown")
                if e["call"] in started
                else "not_started"
            )
            answer = receipts.get(
                e["call"],
                {
                    "status": status,
                    "content": content(
                        UNKNOWN if status == "outcome_unknown" else "Call did not finish: " + status
                    ),
                },
            )
            await self._result(sid, turn, e.get("step"), {"id": e["call"]}, answer)
