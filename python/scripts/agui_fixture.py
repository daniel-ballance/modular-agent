"""Disposable, managed AG-UI fixture. Never loaded by ma or its listener.

The fixture uses the standard configuration's scripted Provider. The side port
observes actual store writes, advances the question and tool clocks, and acts
as a separate trusted Interface. No AG-UI request enables these operations.
"""

import asyncio
import hmac
import json
import logging
import os
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
import ma_questions
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

from starlette.requests import Request
from starlette.responses import JSONResponse
from modular_agent._agui_http import listen_asgi
from ma_core.wire import entry_out
from ma_harness import interface_tools, waiting_approvals
from ma_questions import Questions
from ma_standard.cli import Script
from modular_agent.fixtures import count, fixture as sdk_fixture
from modular_agent import (
    ACP_RIGHTS,
    Plugin,
    ToolContext,
    create_agent,
    file_history,
    read_service_token,
    tool,
)
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter


class Warnings(logging.Handler):
    def __init__(self):
        super().__init__()
        self.fields = []

    def emit(self, record):
        if record.args:
            self.fields.append(record.args[0])


def log(path, value):
    with path.open("a", encoding="utf-8") as f:
        print(json.dumps(value), file=f)


def rows(path):
    return [json.loads(row) for row in path.read_text().splitlines()] if path.exists() else []


class Timers:
    """Advance just work deadlines, not HTTP keepalive or the clients' sockets."""

    def __init__(self):
        self.elapsed = 0
        self.waiters = {}

    def __getattr__(self, name):
        return getattr(asyncio, name)

    async def sleep(self, delay):
        done = asyncio.get_running_loop().create_future()
        self.waiters[done] = self.elapsed + delay, lambda: done.set_result(None)
        try:
            await done
        finally:
            self.waiters.pop(done, None)

    @asynccontextmanager
    async def timeout(self, delay):
        async with asyncio.timeout(None) as timer:
            if delay is not None:
                self.waiters[timer] = (
                    self.elapsed + delay,
                    lambda: timer.reschedule(asyncio.get_running_loop().time()),
                )
            try:
                yield
            finally:
                self.waiters.pop(timer, None)

    def advance(self, seconds):
        self.elapsed += seconds
        for deadline, notify in list(self.waiters.values()):
            if deadline <= self.elapsed:
                notify()


class Fixture:
    def __init__(self, config):
        self.name = config["name"]
        self.root = Path(os.environ["MODULAR_AGENT_DATA_DIR"])
        self.project = Path(config["project"])
        self.token = "Bearer " + read_service_token(config["controlTokenFile"])
        self.batches = self.root / "write-ids.jsonl"
        self.dispatches = self.root / "dispatches.jsonl"
        self.latch = defaultdict(asyncio.Event)
        self.warnings = Warnings()
        self.timers = Timers()
        self.erasure = {}
        self.script = Script(json.loads(Path(os.environ["MODULAR_AGENT_SCRIPT"]).read_text()))
        self.control_tls = {}
        self.waiting = self.name.startswith("waiting-")
        self.redact_approval = None
        self.actors = []
        for role, token in config["tokenFiles"].items():
            other = self.project.parent if role == "project" else self.project
            self.actors.append(
                {
                    "token_file": token,
                    "client_id": "kit-" + ("primary" if role in ("owner", "rotated") else role),
                    "actor": {
                        "id": "kit-foreign" if role == "foreign" else "kit-owner",
                        "kind": "user",
                        "rights": list(ACP_RIGHTS) if role != "watch" else ["watch"],
                    },
                    "tenants": ["other" if role == "tenant" else "test"],
                    "projects": [other],
                    "trace_trusted": role in ("owner", "rotated"),
                }
            )
        self.offer = {**config["offer"], "callers": ["model"]}
        if self.name.startswith("waiting-mixed"):
            self.offer["hints"] = {"readOnly": True}
        self.exporter = InMemorySpanExporter()
        self.telemetry = TracerProvider()
        self.telemetry.add_span_processor(SimpleSpanProcessor(self.exporter))
        trace.set_tracer_provider(self.telemetry)

    async def start(self):
        async def before(payload):
            if payload["call"]["name"] == "pick_color" and payload["call"]["input"] == {
                "color": "draft-blue"
            }:
                return {"change": {"input": {"color": "dispatch-blue"}}}

        async def after(payload):
            if payload["result"]["status"] == "completed":
                return {
                    "change": {"content": [{"type": "text", "text": "Checked frontend result."}]}
                }

        async def step(payload, ctx):
            if self.name == "state-and-gate":
                await ctx.emit("kit.visible", {"title": "Visible"})
                await ctx.emit("kit.hidden", {"text": "withheld-extension-sentinel"})
                await ctx.emit("modular-agent.agui.raw", {"type": "fixture.foreign"})
                await self.agent._api.session(
                    "append",
                    session=ctx.session_id,
                    turn=ctx.turn_id,
                    kind="kit.note",
                    writer="kit",
                    visible=True,
                    data={"title": "Visible"},
                )
                await ctx.emit(
                    "modular-agent.agui.stateSnapshot",
                    {"revisionId": "0", "snapshot": {"counter": 0}},
                )
                for base, rev in [("0", "1"), ("0", "2"), ("1", "3"), (None, "4"), ("4", "5")]:
                    if base is None:
                        await ctx.emit(
                            "modular-agent.agui.stateSnapshot",
                            {"revisionId": rev, "snapshot": {"counter": int(rev)}},
                        )
                    else:
                        await ctx.emit(
                            "modular-agent.agui.stateDelta",
                            {
                                "baseRevisionId": base,
                                "revisionId": rev,
                                "delta": [{"op": "replace", "path": "/counter", "value": int(rev)}],
                            },
                        )
            if self.name == "output-size":
                await ctx.emit("kit.oversized", {"text": "x" * (64 << 20)})
            if self.name == "questions":
                await self.choice(ctx.session_id, ctx.turn_id, ctx.step_id)

        async def wrong(payload, ctx):
            await ctx.emit(
                "modular-agent.agui.stateSnapshot",
                {"revisionId": "wrong", "snapshot": {"text": "wrong-plugin-sentinel"}},
            )

        async def mixed(payload, ctx):
            if any(r.get("status") == "pending" for r in payload.get("dispositions", [])) or any(
                e["kind"] == "tool_started" and e.get("turn") == ctx.turn_id
                for e in self.agent._h.sessions[ctx.session_id]["entries"]
            ):
                await self.choice(ctx.session_id, ctx.turn_id, ctx.step_id)

        hooks = {"tool.before": before, "tool.after": after}
        if self.name in ("questions", "state-and-gate", "output-size"):
            hooks["step.before"] = step
        if self.name == "mixed":
            hooks["step.after"] = mixed
        if self.name in (
            "approval-redacted",
            "waiting-routes",
            "state-and-gate",
            "output-size",
            "error-gate",
            "release-gate",
        ):
            hooks["output"] = self.gate
        plugins = [Plugin("kit", hooks=hooks)]
        if self.name == "state-and-gate":
            plugins.append(Plugin("other", hooks={"step.before": wrong}))
            original = self.script.request

            async def private(*args):
                return {
                    **await original(*args),
                    "providerData": {"private": "provider-only-sentinel"},
                }

            self.script.request = private
        if self.name == "waiting-restart":

            @tool(callers=["plugin"])
            async def increment() -> str:
                """Count one nested effect."""
                path = self.root / "count"
                value = str(count(path) + 1)
                path.write_text(value)
                return value

            @tool
            async def bump(cx: ToolContext, hold: bool = False, note: str | None = None) -> str:
                """Delegate the count to a nested tool."""
                return (await cx.tools.call("increment", {})).text()

            plugins.append(Plugin("counter", tools=[bump, increment]))
        elif self.waiting:
            plugins.append(sdk_fixture("counter", config={"path": str(self.root / "count")}))
        self.agent = await create_agent(
            project=self.project,
            data_dir=self.root,
            providers=[self.script],
            history=file_history(self.root / "store"),
            durability="durable" if self.name == "crash-continuation" else "kept",
            tenants={k: {"rights": list(ACP_RIGHTS)} for k in ("test", "other")},
            several_actors=True,
            session_limits=True,
            plugins=plugins,
            approval="ask"
            if self.name.startswith("waiting-mixed")
            else "all"
            if self.waiting or self.name.startswith("approval")
            else "off",
            approval_covers_nested=self.waiting or self.name.startswith("approval"),
            max_approval_wait=5.0 if self.waiting else None,
            late_answers_start_turns=self.waiting,
            settings={
                "approval_timeout": 5,
                **(
                    {"approvalWait": "live" if self.name == "waiting-live" else "untilDeadline"}
                    if self.waiting
                    else {}
                ),
            },
            interface_tools=[
                {
                    "actor_id": "kit-owner",
                    "source_id": "browser",
                    "route_id": "kit-primary",
                    "result_timeout_ms": 60_000,
                    "tools": [self.offer],
                }
            ],
        )
        self.instrument()
        tls = None
        if self.name == "tls":
            # Reuse the kit's disposable CA generator. Keep key material in the
            # fresh fixture directory; never pass it on the command line.
            module = (
                Path(__file__).resolve().parents[2] / "conformance/agui/tls-fixture.mjs"
            ).as_uri()
            generated = json.loads(
                subprocess.check_output(
                    [
                        "node",
                        "--input-type=module",
                        "-e",
                        f"import {{disposableTls}} from '{module}'; console.log(JSON.stringify(await disposableTls()))",
                    ]
                )
            )
            self.control_tls = generated["client"]
            tls = {}
            for field, key in [
                ("cert_file", "cert"),
                ("key_file", "key"),
                ("client_ca_file", "ca"),
            ]:
                path = self.root / (key + ".pem")
                path.touch(mode=0o600)
                path.write_text(generated["server"][key])
                tls[field] = path
        self.service = await self.agent.serve_agui(
            listen=os.environ["MA_AGUI_LISTEN"],
            actors=self.actors,
            tenant="test",
            acp=True,
            tls=tls,
            state_plugin="kit",
            raw_sources={"kit": "kit"},
            trace_state_keys=["kit"],
        )

        async def control(scope, receive, send):
            req = Request(scope, receive)
            reply = (
                await self.control(req)
                if req.method == "POST" and req.url.path == "/fixture"
                else JSONResponse({}, status_code=404)
            )
            await reply(scope, receive, send)

        async def shutdown():
            pass

        self.runner = await listen_asgi("127.0.0.1", 0, control, shutdown)
        print(
            json.dumps(
                {
                    "url": self.service.url,
                    "control": self.runner.url + "/fixture",
                }
            ),
            flush=True,
        )

    async def choice(self, sid, turn, step):
        await self.agent._api.call(
            "questions",
            "ask",
            {
                "session": sid,
                "turn": turn,
                "step": step,
                "actor": "kit-owner",
                "kind": "choice",
                "question": "Choose one",
                "options": ["yes", "no"],
                "park": False,
                "timeout": 5,
            },
        )

    def instrument(self):
        # Store IDs, not copies of entries that could survive erasure. Read the
        # recorded body from the store at inspect time, not from the SSE stream.
        h = self.agent._h
        store = h.capabilities["history"][1]
        original_keep = store.keep

        async def keep(d, emit):
            sid = d["session"]["id"]
            entries = d["entries"]
            if self.name == "crash-before-handoff" and any(
                e["kind"] == "tool_started" for e in entries
            ):
                await self.pause(sid, "beforeHandoff")
            result = await original_keep(d, emit)
            log(self.batches, [sid, [e["id"] for e in entries]])
            if self.waiting:
                for e in entries:
                    marker = {
                        "question_answer": "answerCommitted",
                        "tool_result": "reportCommitted",
                        "turn_end": "continuationEnded",
                    }.get(e["kind"])
                    if marker and (
                        marker != "continuationEnded" or not e["data"].get("open_calls")
                    ):
                        self.latch[sid, marker].set()
            if self.name == "crash-after-result" and any(
                e["kind"] == "tool_result" and e.get("actor") for e in entries
            ):
                await self.pause(sid, "afterResult")
            if self.name == "crash-continuation" and any(
                e["kind"] == "turn_start" and (e["data"].get("source") or {}).get("continuesTurnId")
                for e in entries
            ):
                await self.pause(sid, "duringContinuation")
            return result

        store.keep = keep
        original_connect = self.agent.connect_interface_tools

        def connect(**kwargs):
            callback = kwargs["on_handoff"]

            def released(handoff):
                log(self.dispatches, [handoff["session_id"], handoff["call_id"]])
                callback(handoff)

            return original_connect(**{**kwargs, "on_handoff": released})

        self.agent.connect_interface_tools = connect
        original_disconnect = h.capabilities["questions"][1].disconnect

        async def disconnect(d, emit):
            result = await original_disconnect(d, emit)
            self.latch[d["session"], "presenceLost"].set()
            return result

        h.capabilities["questions"][1].disconnect = disconnect

        # Admit the second fixture actor through the normal grant operation.
        async def join(d):
            sid = d["session"]
            s = h.sessions[sid]
            if not d.get("resumed") and s["actor"] == "kit-owner":
                await self.agent._session(
                    "grant",
                    session=sid,
                    actor="kit-owner",
                    subject="kit-foreign",
                    kind="user",
                    authority=list(ACP_RIGHTS),
                )

        h.api().on("session.start", join)
        logging.getLogger("modular_agent.agui").addHandler(self.warnings)

    async def pause(self, sid, name):
        self.latch[sid, name].set()
        await self.latch[sid, "release"].wait()

    async def gate(self, payload):
        changed = False
        events = payload["events"]
        for ev in events:
            d = ev["data"]
            method = d.get("method") if isinstance(d, dict) else None
            value = d.get("result", {})
            if (
                self.name == "release-gate"
                and method == "agui.event"
                and value.get("type") == "TOOL_CALL_START"
            ):
                await self.pause(payload["sessionId"], "beforeRelease")
            if (
                self.name == "approval-redacted"
                or self.redact_approval
                and self.redact_approval == d.get("clientId")
            ) and method == "agui.interrupt":
                value["message"] = "Redacted approval"
                changed = True
            if self.name == "error-gate" and (
                method in ("agui.discovery", "agui.error")
                or "provider-diagnostic-sentinel" in str(value)
            ):
                return {"block": True}
            if self.name == "state-and-gate":
                if (
                    ev["type"] == "kit.hidden"
                    or (method == "agui.snapshot" and d["clientId"] == "kit-sibling")
                    or (value.get("type") == "STATE_DELTA" and value["delta"][0]["value"] == 3)
                ):
                    return {"block": True}
                serialized = json.dumps(ev)
                if "kit-hidden-output-sentinel" in serialized:
                    ev.update(
                        json.loads(serialized.replace("kit-hidden-output-sentinel", "Gated text."))
                    )
                    changed = True
            if (
                self.name == "output-size"
                and method == "agui.snapshot"
                and d["clientId"] == "kit-sibling"
            ):
                value["messages"][0]["content"] = "x" * (64 << 20)
                changed = True
        if changed:
            return {"redact": events}

    async def control(self, req):
        if not hmac.compare_digest(self.token, req.headers.get("Authorization", "")):
            return JSONResponse({}, status_code=401)
        d = await req.json()
        sid = d.get("threadId")
        h = self.agent._h
        match d["operation"]:
            case "tls":
                return JSONResponse(self.control_tls)
            case "inspect":
                saved = await self.agent._call("history", "read", session=sid)
                records = {e["id"]: entry_out(e) for e in (saved or {}).get("entries", [])}
                self.telemetry.force_flush()
                return JSONResponse(
                    {
                        "batches": [
                            [records[i] for i in group if i in records]
                            for s, group in rows(self.batches)
                            if s == sid
                        ],
                        "model": rows(Path(os.environ["MODULAR_AGENT_SCRIPT_LOG"])),
                        "project": str(self.project),
                        "counter": count(self.root / "count"),
                        "dispatches": [cid for s, cid in rows(self.dispatches) if s == sid],
                        "warnings": self.warnings.fields,
                        "spans": [
                            {
                                "name": s.name,
                                "traceId": f"{s.context.trace_id:032x}",
                                "spanId": f"{s.context.span_id:016x}",
                                "attributes": dict(s.attributes),
                                "links": [
                                    {
                                        "spanId": f"{link.context.span_id:016x}",
                                        "traceId": f"{link.context.trace_id:032x}",
                                    }
                                    for link in s.links
                                ],
                            }
                            for s in self.exporter.get_finished_spans()
                            if s.attributes.get("gen_ai.conversation.id") == sid
                        ],
                        "erasure": self.erasure.get(sid, {"outOfReach": []}),
                    }
                )
            case "barrier":
                await self.latch[sid, d["name"]].wait()
                if d["name"] == "presenceLost":
                    await self.agent._call("runtime", "wait", session=sid)
            case "release":
                self.latch[sid, "release"].set()
            case "revoke":
                await self.agent._session(
                    "limit",
                    session=sid,
                    actor="kit-owner",
                    rights=sorted(set(ACP_RIGHTS) - {"tools"}),
                )
            case "approvalGate":
                self.redact_approval = d["client"] if d["mode"] == "redact" else None
            case "advance":
                self.timers.advance(d["milliseconds"] / 1000)
                if self.waiting:
                    await h.reconcile_waits(sid)
                # Yield to the timer queue at the new instant, then wait for its
                # recorded settlement and all runnable work, not a real timeout.
                for (s, _), task in list(h.interface_timers.items()):
                    if s == sid:
                        await task
                await self.agent._call("runtime", "wait", session=sid)
            case "move" | "erase":
                await self.agent._call("runtime", "wait", session=sid)
                branch = await self.agent._session("branch", session=sid)
                before = next(e for e in branch if e["kind"] == "input_queued")
                if d["operation"] == "move":
                    await self.agent._session(
                        "move", session=sid, actor="kit-owner", point=before["parent"]
                    )
                else:
                    report = await self.agent._session(
                        "erase", session=sid, actor="kit-owner", entries=[before["id"]]
                    )
                    self.erasure[sid] = {"outOfReach": report.get("out_of_reach", [])}
            case _:
                return JSONResponse({}, status_code=400)
        return JSONResponse({})


async def main():
    config = json.loads(Path(os.environ["MA_AGUI_FIXTURE"]).read_text())
    if config["name"] in {"history", "stock-conversation", "encoding"}:
        os.execv(sys.executable, [sys.executable, str(Path(__file__).with_name("agui_ma.py"))])
    fixture = Fixture(config)
    clock = interface_tools.clock

    def remaining(q):
        deadline = q.get("deadline")
        now = datetime.now(UTC) + timedelta(seconds=fixture.timers.elapsed)
        return (datetime.fromisoformat(deadline) - now).total_seconds() if deadline else None

    with (
        patch.object(
            waiting_approvals,
            "clock_ms",
            lambda: 1800000000000 + round(fixture.timers.elapsed * 1000),
        ),
        patch.object(ma_questions, "asyncio", fixture.timers),
        patch.object(interface_tools, "asyncio", fixture.timers),
        patch.object(
            interface_tools, "clock", lambda: clock() + round(fixture.timers.elapsed * 1000)
        ),
        patch.object(Questions, "_remaining", staticmethod(remaining)),
    ):
        await fixture.start()
        try:
            await asyncio.Event().wait()
        finally:
            await fixture.runner.close()
            await fixture.service.close()
            await fixture.agent.close()


if __name__ == "__main__":
    asyncio.run(main())
