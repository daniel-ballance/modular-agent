"""Disposable worker for the ADR 0034 shared scenarios. Only stdin controls it."""

from __future__ import annotations

import asyncio
import ctypes
import json
import os
from datetime import datetime
from pathlib import Path
import select
import sys
from typing import Any, cast
from unittest.mock import patch

from ma_core import Plugin as NativePlugin
from ma_core.wire import entry_out, tool_in
from ma_history import History

from . import Agent, AgentError, Answer, Plugin, PromptResult, Session
from ._scenarios import _agent, _Services
from ._scenario_telemetry import exporter
from .fixtures import count


async def counter_write(path: Path) -> None:
    """Wait on the directory containing the atomically replaced counter."""
    loop = asyncio.get_running_loop()
    if sys.platform == "linux":
        libc = ctypes.CDLL(None, use_errno=True)
        fd = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        if fd < 0:
            raise OSError(ctypes.get_errno(), "inotify_init1")
        try:
            if libc.inotify_add_watch(fd, os.fsencode(path.parent), 0x80 | 0x8) < 0:
                raise OSError(ctypes.get_errno(), "inotify_add_watch")
            while not count(path):
                ready = asyncio.Event()
                loop.add_reader(fd, ready.set)
                try:
                    await ready.wait()
                    os.read(fd, 65536)
                finally:
                    loop.remove_reader(fd)
        finally:
            os.close(fd)
    elif sys.platform == "darwin":
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            with select.kqueue() as queue:
                queue.control(
                    [
                        select.kevent(
                            fd,
                            filter=select.KQ_FILTER_VNODE,
                            flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR,
                            fflags=select.KQ_NOTE_WRITE,
                        )
                    ],
                    0,
                )
                while not count(path):
                    await asyncio.to_thread(queue.control, [], 1)
        finally:
            os.close(fd)
    else:
        raise RuntimeError("No counter file notification on this platform")


class Worker:
    def __init__(
        self, directory: Path, scenario: dict[str, Any], placement: str, command: list[str]
    ) -> None:
        self.directory = directory
        self.scenario = scenario
        self.clock = directory / "clock"
        self.agent: Agent | None = None
        self.session: Session | None = None
        self.handles: dict[str, Session] = {}
        self.latches: dict[str, tuple[asyncio.Event, asyncio.Event]] = {}
        self.changed: dict[str, Any] = {}
        self.command = command
        self.services = (
            _Services(command, directory, separate_groups=False)
            if placement.startswith("service:")
            else None
        )
        self.decision: asyncio.Task[None] | None = None
        self.telemetry = (
            json.loads(Path(os.environ["MODULAR_AGENT_TELEMETRY_RUN"]).read_text())
            if "MODULAR_AGENT_TELEMETRY_RUN" in os.environ
            else {}
        )
        self.active: dict[int, str] = {}

    def observe_spans(self) -> None:
        from opentelemetry import trace
        from opentelemetry.sdk.trace import SpanProcessor

        active = self.active

        class Work(SpanProcessor):
            def on_start(self, span: Any, parent_context: Any = None) -> None:
                if span.name.startswith(
                    ("invoke_agent", "execute_tool", "modular_agent.step", "modular_agent.question")
                ):
                    active[span.context.span_id] = span.name

            def on_end(self, span: Any) -> None:
                active.pop(span.context.span_id, None)

        cast(Any, trace.get_tracer_provider()).add_span_processor(Work())

    async def hit(self, boundary: str) -> None:
        if latch := self.latches.get(boundary):
            latch[0].set()
            await latch[1].wait()

    async def before(self, _: Any) -> Any:
        await self.hit("beforeHandoff")
        if "gateInput" in self.changed:
            return {"change": {"input": self.changed["gateInput"]}}

    async def turn(self, _: Any) -> None:
        await self.hit("beforeGates")

    async def gate(self, payload: Any) -> Any:
        for event in payload["events"]:
            if event["type"] == "entry" and event["data"]["entry"]["kind"] == "inputAnswer":
                await self.hit("afterAnswer")
            if (
                payload["recipient"] == self.changed.get("gateView", {}).get("actor")
                and event["type"] == "reply"
                and event["data"].get("method") == "questions"
            ):
                event["data"]["result"]["question"] = "redacted"
                return {"redact": payload["events"]}

    async def build(self, op: str, sid: str | None) -> dict[str, Any]:
        scenario = self.scenario
        opts = dict(scenario["agent"])
        if op == "probe":
            opts.update(maxApprovalWaitMs=100, approval="all", durability="kept")
        settings = {} if op == "probe" else dict(opts.get("settings", {}))
        if (ms := scenario.get("fixture", {}).get("requestedApprovalMs")) is not None:
            settings["approval_timeout"] = ms / 1000
        opts["settings"] = {}
        opts["lateAnswersStartTurns"] = True
        services = await self.services.start(opts.get("plugins", [])) if self.services else None
        self.agent = await _agent(
            {**scenario, "agent": opts},
            self.directory,
            self.command if not self.services else [],
            services,
            controls=[
                Plugin(
                    "fixture-controls",
                    hooks={
                        "turn.start": self.turn,
                        "tool.before": self.before,
                        "output": self.gate,
                    },
                )
            ],
            agent_name=self.telemetry.get("agentName"),
        )
        if any("registration" in step.get("change", {}) for step in scenario["steps"]):
            await self.install_mutable_catalog()
        self.session = (
            await self.agent.open_session(sid)
            if sid
            else await self.agent.session(settings=settings, actors=opts.get("actors", []))
        )
        self.handles["user"] = self.session
        return {"sessionId": self.session.id, "declaration": self.agent.declaration()}

    async def install_mutable_catalog(self) -> None:
        """Compose a catalog that can refresh without replacing any open-session part.

        Its listing and execution come from the selected counter fixture. The
        control changes only the source registration or the listed description.
        """
        assert self.agent
        h = self.agent._h
        definition = next(
            t for t in await h.call("fixture", "tools", "definitions", {}) if t["name"] == "bump"
        )
        target = definition["target"]
        owner = h.capabilities[target][0]
        source, original = h.registration(None, definition)
        changed = self.changed

        class MutableCatalog(NativePlugin):  # type: ignore[misc]
            name = "fixture-catalog"
            role = "tool_source"

            async def start(self, api: Any) -> None:
                await super().start(api)
                api.provide(self.name, self)
                api.on("tools.list", self.list)

            async def list(self, _: Any) -> list[Any]:
                change = changed.get("registration")
                offer = {
                    **original,
                    **({"description": "Changed description"} if change == "definition" else {}),
                }
                registration = {
                    **source,
                    **({"toolSource": "replacement"} if change == "source" else {}),
                }
                return [{**tool_in(offer), "source": registration, "target": self.name}]

            async def run(self, data: Any, emit: Any) -> Any:
                return await self.api.call(target, "run", data, emit)

        h.handlers = [handler for handler in h.handlers if handler[:2] != (owner, "tools.list")]
        await h.load(MutableCatalog())

    async def command_line(self, msg: dict[str, Any]) -> Any:
        op = msg["op"]
        if op in ("probe", "new", "reopen"):
            return await self.build(op, msg.get("sid"))
        assert self.agent and self.session
        actor = msg.get("actor", "user")
        if actor not in self.handles:
            self.handles[actor] = self.session.as_actor(actor)
        handle = self.handles[actor]
        if op in ("prompt", "wait"):
            result: PromptResult | None
            if op == "prompt":
                result = await handle.prompt(msg["text"])
            else:
                await handle.wait_idle()
                result = await handle.last_turn()
            assert result and result.outcome
            return {
                "outcome": result.outcome.kind,
                "text": result.text,
                "openToolCalls": result.open_tool_calls,
                "toolResults": [
                    {"name": t.name, "status": t.status, "text": t.text()}
                    for t in result.tool_results()
                ],
            }
        if op == "poll":
            return [
                {
                    "id": q.id,
                    "kind": q.kind,
                    "question": q.question,
                    "approvalWait": q.approval_wait,
                    "deadline": round(datetime.fromisoformat(q.deadline).timestamp() * 1000)
                    if q.deadline
                    else None,
                    "answerable": q.answerable,
                    "call": {"id": q.tool_call_id, **cast(dict[str, Any], q.call or {})},
                }
                for q in await handle.questions(present=msg["present"])
            ]
        if op == "decide":
            decision = msg["answer"]
            if decision == "decline" and self.telemetry:
                decision = Answer("decline", reason=self.telemetry["values"]["answer"])
            self.decision = asyncio.create_task(handle.answer(msg["qid"], decision))
            if "afterAnswer" in self.latches:
                latch = asyncio.create_task(self.latches["afterAnswer"][0].wait())
                await asyncio.wait([self.decision, latch], return_when=asyncio.FIRST_COMPLETED)
                latch.cancel()
                if not self.decision.done():
                    return True  # The committed answer reached the writer barrier.
            try:
                await self.decision
                return True
            except AgentError as exc:
                if exc.code not in ("conflict", "forbidden", "not_found"):
                    raise
                return False
        if op == "barrier":
            verb, name = next(iter(msg["value"].items()))
            if verb == "arm":
                self.latches[name] = asyncio.Event(), asyncio.Event()
            elif verb == "release":
                self.latches.pop(name)[1].set()
            elif name == "afterEffect":
                await counter_write(self.directory / "count")
            else:
                await self.latches[name][0].wait()
        elif op == "change":
            change = msg["value"]
            if "setting" in change:
                for key, value in change["setting"].items():
                    await handle.set_setting(key, value)
            elif "removeRight" in change:
                who = change["removeRight"]
                member = next(
                    a for a in self.scenario["agent"]["actors"] if a["id"] == who["actor"]
                )
                await self.session.join(
                    {
                        "id": member["id"],
                        "kind": member["kind"],
                        "rights": [r for r in member["rights"] if r != who["right"]],
                    }
                )
            else:
                self.changed.update(change)
        elif op == "clock":
            await self.agent._h.reconcile_waits(self.session.id)
        elif op == "parked":
            await self.session.wait_idle()
            if self.telemetry.get("sdk"):
                from opentelemetry import trace

                assert cast(Any, trace.get_tracer_provider()).force_flush()
            return list(self.active.values())
        elif op != "close":
            raise ValueError(f"Unknown worker operation: {op}")
        return None

    async def run(self) -> None:
        keep = History.keep
        path = self.directory / "batches"

        async def observed(store: Any, d: Any, emit: Any) -> Any:
            result = await keep(store, d, emit)
            with path.open("a") as f:
                print(json.dumps([entry_out(e) for e in d["entries"]]), file=f)
            return result

        with (
            patch.object(History, "keep", observed),
            patch("ma_harness.waiting_approvals.clock_ms", lambda: int(self.clock.read_text())),
        ):
            while line := await asyncio.to_thread(sys.stdin.readline):
                msg = json.loads(line)
                try:
                    async with asyncio.timeout(25):
                        result = await self.command_line(msg)
                    reply = {"result": result}
                except AgentError as exc:
                    reply = {"error": exc.code.value, "message": exc.message}
                print(json.dumps(reply), flush=True)
                if msg["op"] == "close":
                    break
            if self.agent:
                await self.agent.close()
            if self.services:
                for proc in self.services.children:
                    proc.terminate()
                await asyncio.gather(*(proc.wait() for proc in self.services.children))


if __name__ == "__main__":
    worker = Worker(
        Path(sys.argv[1]), json.loads(Path(sys.argv[2]).read_text()), sys.argv[3], sys.argv[4:]
    )
    with exporter(
        os.environ.get("MODULAR_AGENT_TELEMETRY_OTLP") if worker.telemetry.get("sdk") else None
    ):
        if worker.telemetry.get("sdk"):
            worker.observe_spans()
        asyncio.run(worker.run())
