"""Public turn port for the Python Runtimes. Only the Harness performs effects."""

import asyncio

from ma_core import plain
from ma_core.recovery import HANDOFF, step_checkpoint

from .rpc import WireError

METHODS = ("runTurn", "resumeTurn", "continueOpenCalls")


class RuntimeServer:
    def __init__(self, server, runtime):
        self.server = server
        durable = runtime.declarations["durable"]
        self.registration = {
            "id": runtime.name,
            "supports": {
                "inputDuringTurn": runtime.declarations["steering"],
                "waitingThroughRestart": durable,
                "continuesAfterRestart": durable,
                "interfaceTools": runtime.declarations.get("interface_tools", False),
                "rewinding": False,
            },
        }
        self.durable = durable

    async def run(self, method, params, key):
        turn = PublicTurn(self.server.peer, key, params["turn"])
        return await turn.run(method, params, self.durable)


class PublicTurn:
    def __init__(self, peer, key, turn):
        self.peer, self.key, self.turn = peer, key, turn
        self.settings = turn.get("settings") or {}
        self.entries, self.open, self.sources = [], [], []
        self.pending = {}
        self.seen = set()
        self.usage = dict.fromkeys(("input", "output", "cacheRead", "cacheWrite", "cost"), 0)
        self.result = {"openToolCalls": self.open}

    async def ask(self, operation, **params):
        return await self.peer.request(
            "host/runtime/" + operation, {**params, "parentRequestId": self.key}
        )

    async def hook(self, name, **payload):
        return await self.ask("hook", hook=name, payload=payload)

    async def record(
        self, kind, *, step=None, call=None, message=None, data=None, sources=None, committed=None
    ):
        entry = {
            "kind": kind,
            "writer": "runtime",
            "modelVisible": message is not None,
            **({"stepId": step} if step else {}),
            **({"toolCallId": call} if call else {}),
            **({"message": message} if message is not None else {}),
            **({"data": data} if data is not None else {}),
            **({"sources": sources} if sources else {}),
        }
        # A cancel during append must not make us guess whether it already committed.
        task = asyncio.create_task(self.ask("record", entry=entry))
        try:
            saved = await asyncio.shield(task)
        except asyncio.CancelledError:
            if self.peer.closed.is_set():
                await asyncio.gather(task, return_exceptions=True)
                raise
            saved = await task
            self.entries.append(saved["id"])
            if committed:
                committed(saved["id"])
            raise
        self.entries.append(saved["id"])
        if committed:
            committed(saved["id"])
        return saved["id"]

    async def generate(self, step, request):
        return await self.ask("model", request=request, stepId=step)

    async def publish(self, call, answer):
        cid = call["id"]
        step = call.get("stepId")

        if "pending" in answer:
            self.pending.pop(cid, None)
            self.open.append(cid)
            return

        def committed(entry_id):
            self.pending.pop(cid, None)
            self.sources.append(entry_id)

        await self.record(
            "toolResult",
            step=step,
            call=cid,
            message={
                "role": "toolResult",
                "toolCallId": cid,
                "toolName": call["name"],
                "content": answer["content"],
                "isError": answer["status"] != "completed",
            },
            data={k: answer[k] for k in ("status", "value") if k in answer},
            committed=committed,
        )

    async def tools(self, calls):
        definitions = {
            name: await self.ask("definition", toolName=name)
            for name in dict.fromkeys(c["name"] for c in calls)
        }

        async def execute(call):
            cid = call["id"]
            definition = definitions[call["name"]]
            wire = {k: v for k, v in call.items() if k not in {"started", "safeToRepeat"}}
            before = await self.hook("tool.before", call=wire, definition=definition)
            if "refused" in before:
                result = before.get("result")
                if (
                    not isinstance(result, dict)
                    or result.get("callId") != cid
                    or "pending" in result
                    or result.get("status")
                    not in (
                        "completed",
                        "failed",
                        "refused",
                        "cancelled",
                        "outcomeUnknown",
                        "notStarted",
                    )
                    or not isinstance(result.get("content"), list)
                    or not all(
                        isinstance(p, dict)
                        and isinstance(p.get("type"), str)
                        and p["type"]
                        and (p["type"] != "text" or isinstance(p.get("text"), str))
                        for p in result["content"]
                    )
                ):
                    raise WireError("Tool refusal lacks its committed result", "invalid_request")
                return result
            if "pending" in before:
                return {"callId": cid, "pending": before["pending"]}
            changed = {**wire, "input": before.get("value", {}).get("call", wire)["input"]}
            return await self.ask("runToolCall", call=changed)

        async def run(call):
            await self.publish(call, await execute(call))

        if all((definitions[c["name"]] or {}).get("parallel") for c in calls):
            tasks = [asyncio.create_task(run(call)) for call in calls]
            try:
                await asyncio.gather(*tasks)
            finally:
                for task in tasks:
                    if not task.done() and not task.cancelling():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        else:
            for call in calls:
                await run(call)

    def admit(self, calls):
        calls = [{"startedBy": "model", **c} for c in calls]
        for call in calls:
            cid = call["id"]
            if cid in self.seen:
                raise WireError("Provider returned duplicate tool call IDs", "invalid_request")
            self.seen.add(cid)
            self.pending[cid] = call
        return calls

    async def steps(self, step_count):
        max_steps = self.settings.get("maxSteps")
        retried = False
        replacement = None
        while not self.open:
            if max_steps is not None and step_count >= max_steps:
                return {"kind": "limit", "limit": "steps"}
            step_count += 1
            step = (await self.ask("newId"))["id"]
            await self.ask("takeSteering")
            prepared = await self.ask("prepareStep", stepId=step, usage=self.usage)
            request = replacement if replacement is not None else prepared
            replacement = None
            response = await self.generate(step, request)
            for key, value in (response.get("usage") or {}).items():
                if key in self.usage and type(value) in {int, float}:
                    self.usage[key] += value
            self.sources.append(await self.record("response", step=step, message=response))
            if response["stop"] == "failed":
                error = response.get("error") or {"kind": "other", "message": "Model failed"}
                retry = await self.hook("model.failed", request=request, error=error, stepId=step)
                decision = await self.hook("step.after", stepId=step, response=response)
                if decision.get("refused"):
                    return {"kind": "failed", "error": str(decision["refused"])}
                if not retry or not retry.get("retry") or retried:
                    return {"kind": "failed", "error": error["message"]}
                retried = True
                replacement = retry.get("request")
                continue
            retried = False
            self.result["text"] = plain(response["content"])
            calls = self.admit(
                [
                    {"id": p["id"], "name": p["name"], "input": p["arguments"], "stepId": step}
                    for p in response["content"]
                    if response["stop"] == "toolUse" and p.get("type") == "toolCall"
                ]
            )
            if calls:
                await self.tools(calls)
            outcome = await self.after_step(step, response, bool(calls))
            if outcome is not None:
                return outcome
        return {"kind": "completed"}

    async def after_step(self, step, response, had_calls, checkpoint=None):
        self.result["text"] = plain(response["content"])
        if checkpoint is not None and "decision" in checkpoint:
            saved = checkpoint["decision"]
            decision = {} if saved is None else {"refused": saved["refuse"]}
        else:
            decision = await self.hook("step.after", stepId=step, response=response)
        if "refused" in decision:
            return {"kind": "failed", "error": decision["refused"]}
        if response["stop"] == "failed":
            return {"kind": "failed", "error": response["error"]["message"]}
        if self.open:
            await self.ask("takeSteering", final=True)
            return {"kind": "completed"}
        if had_calls:
            return None
        if response["stop"] == "length":
            return {"kind": "limit", "limit": "output"}
        if response["stop"] in {"refused", "aborted"}:
            return {"kind": "failed", "error": "Model " + response["stop"]}
        draft = {k: v for k, v in self.result.items() if k != "openToolCalls"}
        check = await self.hook("turn.result", result=draft, shape=self.turn.get("resultShape"))
        self.result.update(check.get("value", {}).get("result", {}))
        if check.get("refused"):
            return None
        if (await self.ask("takeSteering", final=True))["entries"]:
            return None
        return {"kind": "completed"}

    async def history(self):
        entries = []
        cursor = None
        while True:
            page = await self.peer.request(
                "host/history",
                {
                    "sessionId": self.turn["sessionId"],
                    "parentRequestId": self.key,
                    **({"after": cursor} if cursor is not None else {}),
                },
            )
            entries.extend(page["entries"])
            cursor = page.get("next")
            if cursor is None:
                return entries

    async def restore(self, interrupted, durable):
        turn_id = self.turn["turnId"]
        if interrupted.get("turnId") != turn_id:
            raise WireError("Interrupted turn id does not match", "invalid_request")
        journal = await self.history()
        try:
            last, checkpoint = step_checkpoint(journal, turn_id)
        except ValueError as exc:
            raise WireError(str(exc), "invalid_request") from exc
        if ("lastStep" in interrupted) != (checkpoint is not None) or interrupted.get(
            "lastStep"
        ) != checkpoint:
            raise WireError("Interrupted lastStep differs from checkpoint", "invalid_request")
        history = [e for e in journal if e.get("turnId") == turn_id]
        settled = {e.get("toolCallId") for e in journal if e["kind"] == "toolResult"}
        self.open.extend(
            e["toolCallId"]
            for e in history
            if e["kind"] in {"toolPending", HANDOFF} and e.get("toolCallId") not in settled
        )
        calls = interrupted["calls"]
        if any(
            c["id"] in settled or c["id"] in self.open or (c["started"] and not c["safeToRepeat"])
            for c in calls
        ):
            raise WireError("Interrupted calls include ineligible work", "invalid_request")
        if last and durable:
            unresolved = (
                {p["id"] for p in last["message"]["content"] if p["type"] == "toolCall"}
                - settled
                - set(self.open)
            )
            if (
                not unresolved <= {c["id"] for c in calls}
                or unresolved
                and "decision" in checkpoint
            ):
                raise WireError("Interrupted calls disagree with answered step", "invalid_request")
        return history, last, checkpoint, self.admit(calls)

    async def run(self, method, params, durable):
        if method == "resumeTurn":
            history, last, checkpoint, calls = await self.restore(params["interrupted"], durable)
        outcome = {"kind": "completed"}
        try:
            if method == "resumeTurn":
                if not durable:
                    outcome = {"kind": "failed", "error": "Transient turn interrupted"}
                else:
                    auxiliary = {
                        e.get("stepId")
                        for e in history
                        if e["kind"] == "modelRequest" and e.get("data", {}).get("auxiliary")
                    }
                    responses = [
                        e
                        for e in history
                        if e["kind"] == "response"
                        and not e.get("erased")
                        and e.get("stepId") not in auxiliary
                        and not e.get("data", {}).get("recovery")
                    ]
                    settled = {e.get("stepId") for e in history if e["kind"] == "response"}
                    outstanding = next(
                        (
                            e
                            for e in reversed(history)
                            if e["kind"] == "modelRequest"
                            and e.get("stepId") not in settled
                            and not e.get("data", {}).get("auxiliary")
                        ),
                        None,
                    )
                    if outstanding and not outstanding["data"].get("request"):
                        raise WireError("Interrupted model request is not safe to repeat")
                    if not outstanding and any(
                        e["kind"] == "response"
                        and e.get("data", {}).get("recovery")
                        and (not last or history.index(e) > history.index(last))
                        and e.get("stepId") not in auxiliary
                        for e in history
                    ):
                        raise WireError("Interrupted model request was not safe to repeat")
                    for e in responses:
                        message = e["message"]
                        self.seen.update(
                            p["id"] for p in message["content"] if p["type"] == "toolCall"
                        )
                        for k in self.usage:
                            self.usage[k] += (message.get("usage") or {}).get(k, 0)
                    if calls:
                        await self.tools(calls)
                    outcome = None
                    if last:
                        response = last["message"]
                        if outstanding:
                            # The host already began a later attempt, so only
                            # finish the restored gate, not the whole turn.
                            saved = checkpoint.get("decision")
                            if "decision" not in checkpoint:
                                gate = await self.hook(
                                    "step.after", stepId=last["stepId"], response=response
                                )
                                saved = {"refuse": gate["refused"]} if "refused" in gate else None
                            if saved is not None:
                                outcome = {"kind": "failed", "error": saved["refuse"]}
                        else:
                            outcome = await self.after_step(
                                last["stepId"],
                                response,
                                any(p["type"] == "toolCall" for p in response["content"]),
                                checkpoint,
                            )
                    step_count = len({e["stepId"] for e in responses})
                    if outstanding and outcome is None:
                        step = (await self.ask("newId"))["id"]
                        response = await self.generate(step, outstanding["data"]["request"])
                        self.sources.append(
                            await self.record("response", step=step, message=response)
                        )
                        for k in self.usage:
                            self.usage[k] += (response.get("usage") or {}).get(k, 0)
                        step_count += 2
                        if response["stop"] == "failed":
                            outcome = await self.after_step(step, response, False)
                        else:
                            replay_calls = self.admit(
                                [
                                    {
                                        "id": p["id"],
                                        "name": p["name"],
                                        "input": p["arguments"],
                                        "stepId": step,
                                    }
                                    for p in response["content"]
                                    if response["stop"] == "toolUse" and p["type"] == "toolCall"
                                ]
                            )
                            if replay_calls:
                                await self.tools(replay_calls)
                            outcome = await self.after_step(step, response, bool(replay_calls))
                    if outcome is None:
                        outcome = await self.steps(step_count)
            else:
                await self.hook("turn.start")
                if method == "continueOpenCalls":
                    await self.tools(self.admit(params["calls"]))
                outcome = await self.steps(0)
        except asyncio.CancelledError:
            if self.peer.closed.is_set():
                raise
            outcome = {"kind": "cancelled"}
        except Exception as exc:
            if self.peer.closed.is_set():
                raise
            if isinstance(exc, WireError) and exc.code == "turn_limit":
                outcome = {"kind": "limit", "limit": exc.details.get("limit", "steps")}
            elif isinstance(exc, WireError) and exc.code == "cancelled":
                outcome = {"kind": "cancelled"}
            else:
                outcome = {"kind": "failed", "error": str(exc)}
        # The host alone settles calls when execution or acknowledgement was interrupted.
        if outcome["kind"] == "cancelled":
            self.open.clear()
        elif self.open:
            entries = await self.history()
            settled = {e.get("toolCallId") for e in entries if e["kind"] == "toolResult"}
            handoffs = {e.get("toolCallId") for e in entries if e["kind"] == HANDOFF}
            self.open[:] = [
                cid
                for cid in self.open
                if cid not in settled and (outcome["kind"] == "completed" or cid not in handoffs)
            ]
        await self.hook("turn.end", outcome=outcome, result=self.result)
        return {
            "outcome": outcome,
            "result": self.result,
            "entries": self.entries,
            "usage": self.usage,
        }
