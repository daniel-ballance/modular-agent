"""Latches in the managed fixture. None of these controls exist in the listener."""

import asyncio
from contextvars import ContextVar

from modular_agent._agui import View
from modular_agent._agui_http import Stream
from modular_agent._agui_run import Exchange
from modular_agent._agui_waits import WaitFeed
from modular_agent import ToolContext, tool
from starlette.responses import JSONResponse


@tool
async def ask_later(cx: ToolContext) -> str:
    """Ask one choice that can remain open after the synchronous wait."""
    answer = await cx.ask(
        {"kind": "choice", "question": "Choose one", "options": ["yes", "no"]},
        wait=5,
        then="leaveOpen",
    )
    return str(answer)


class HostReads:
    def init_host_reads(self):
        self.armed = {}
        self.release_events = {}
        self.modes = {}
        self.receipt_mode = "allow"
        self.waits = {}
        self.asks = set()
        self.active_run = ContextVar("fixture_run", default=None)
        self.reader = ContextVar("fixture_view", default=None)

    async def held(self, sid, name, run=None):
        key = sid, name, run
        if release := self.armed.pop(key, None):
            self.latch[key].set()
            await release.wait()

    def observe_reads(self, store):
        fixture = self
        old_serve, old_write, old_deliver = Exchange.serve, Stream.write, WaitFeed.deliver
        old_feed, old_start, old_snap = WaitFeed.serve, Stream.start, View.snapshot
        old_release = self.agent._receipt_store.released

        async def exchange(run):
            token = fixture.active_run.set((run.v.sid, run.data["runId"]))
            try:
                return await old_serve(run)
            finally:
                fixture.active_run.reset(token)

        async def feed(f, after, stream):
            token = fixture.reader.set(f.v)
            try:
                return await old_feed(f, after, stream)
            finally:
                fixture.reader.reset(token)

        async def start(s):
            await old_start(s)
            if v := fixture.reader.get():
                fixture.latch[v.sid, "waitFollowing", None].set()

        async def snap(v, **kw):
            fixture.binding = v.binding
            return await old_snap(v, **kw)

        async def deliver(f, pos, eid, stream):
            await fixture.held(f.v.sid, "beforeWaitDelivery")
            return await old_deliver(f, pos, eid, stream)

        async def write(s, raw):
            run = fixture.active_run.get()
            if run and b'"type":"RUN_FINISHED"' in raw:
                await fixture.held(run[0], "beforeTerminal", run[1])
            return await old_write(s, raw)

        def released(source, kind):
            old_release(source, kind)
            sid, run = fixture.active_run.get()
            fixture.latch[sid, "terminalRecorded", run].set()

        original_publish = store.publish_erasure

        async def publish(d, emit):
            result = await original_publish(d, emit)
            await fixture.held(d["session"], "pendingErasure")
            return result

        store.publish_erasure = publish
        Exchange.serve, Stream.write, WaitFeed.deliver = exchange, write, deliver
        WaitFeed.serve, Stream.start, View.snapshot = feed, start, snap
        self.agent._receipt_store.released = released

        questions = self.agent._h.capabilities["questions"][1]
        publish_question = questions._publish

        async def opened(sid, q):
            await publish_question(sid, q)
            if future := fixture.waits.pop(sid, None):
                future.set_result(q["id"])

        questions._publish = opened

    async def work_boundary(self, sid, entries, before):
        run = self.active_run.get()
        if before and run and any(e["kind"] == "input_queued" for e in entries):
            await self.held(sid, "beforeAdmission", run[1])
        if not before:
            for e in entries:
                if e["kind"] == "turn_end":
                    self.latch[sid, "recoveryEnded"].set()
                if e["kind"] == "turn_start" and run:
                    await self.held(sid, "afterAdmission", run[1])
                if e["kind"] == "tool_result" and run:
                    await self.held(sid, "afterResult", run[1])

    async def open_wait(self, sid, kind):
        future = self.waits[sid] = asyncio.get_running_loop().create_future()
        if kind in ("leaveOpen", "approval"):
            # The priming input used the first scripted step. Drive a real tool
            # call on the next turn, through the usual approval and ask paths.
            name = "ask_later" if kind == "leaveOpen" else "bump"
            self.script._script = (
                self.script._script[0],
                {"toolCalls": [{"name": name, "input": {}}]},
                {"text": "done"},
            )
            work = self.agent._call(
                "runtime",
                "submit",
                session=sid,
                actor="kit-owner",
                when="now",
                content=[{"type": "text", "text": "Start the waiting call."}],
            )
        else:
            work = self.agent._api.call(
                "questions",
                "ask",
                {
                    "session": sid,
                    "actor": "kit-owner",
                    "kind": "choice",
                    "question": "Choose one",
                    "options": ["yes", "no"],
                    "park": False,
                    "timeout": 5 if kind == "deadline" else None,
                    **({"responders": ["kit-owner"]} if kind == "revocable" else {}),
                },
            )
        task = asyncio.create_task(work)
        self.asks.add(task)
        task.add_done_callback(self.asks.discard)
        return JSONResponse({"requestId": await future})

    async def host_read_control(self, sid, d):
        name, run = d.get("name"), d.get("runId")
        key = sid, name, run
        match d["operation"]:
            case "hold":
                self.armed[key] = self.release_events[key] = asyncio.Event()
                self.latch[key].clear()
            case "barrier" if name in {
                "waitFollowing",
                "beforeWaitDelivery",
                "terminalRecorded",
                "beforeTerminal",
                "beforeAdmission",
                "afterAdmission",
                "afterResult",
                "recoveryEnded",
                "pendingErasure",
            }:
                await self.latch[(sid, "recoveryEnded") if name == "recoveryEnded" else key].wait()
            case "release" if key in self.release_events:
                self.release_events.pop(key).set()
            case "openWait":
                return await self.open_wait(sid, d["kind"])
            case "revokeRight":
                h = self.agent._h
                rights = set(h.sessions[sid]["actors"]["kit-owner"]["authority"])
                await self.agent._session(
                    "grant",
                    session=sid,
                    actor="kit-owner",
                    subject="kit-owner",
                    authority=sorted(rights - {d["right"]}),
                )
            case "waitGate":
                self.modes[d["requestId"]] = d["mode"]
            case "receiptGate":
                self.receipt_mode = d["mode"]
            case "expireWaitCursor":
                self.binding.wait_cursors.pop(d["cursor"], None)
            case _:
                return None
        return JSONResponse({})

    def read_gate(self, ev):
        d = ev["data"]
        if (
            self.receipt_mode in ("terminal", "work")
            and d.get("method") == "agui.runReceipt"
            and d["clientId"] == "kit-primary"
        ):
            d["result"][self.receipt_mode] = {"terminal": "unknown", "work": "unsettled"}[
                self.receipt_mode
            ]
            return {"redact": [ev]}
        if self.receipt_mode == "settlement" and ev["type"] == "turnEnded":
            return {"block": True}
        if (
            self.receipt_mode == "reply"
            and d.get("method") == "agui.runReceipt"
            and d["clientId"] == "kit-primary"
        ):
            return {"block": True}
        if not (v := self.reader.get()) or v.client != "kit-primary":
            return None
        if ev["type"] == "entry":
            entry = d["entry"]
            if (entry["kind"], self.modes.get(entry.get("requestId"))) in {
                ("inputRequest", "opening"),
                ("inputAnswer", "decision"),
            }:
                return {"block": True}
        if (
            ev["type"] == "modular-agent.waitClosed"
            and self.modes.get(d.get("requestId")) == "notice"
        ):
            d["reason"] = "changed"
            return {"redact": [ev]}
        return None
