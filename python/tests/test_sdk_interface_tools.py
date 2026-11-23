"""Interface executors use the public SDK, not Runtime or history callbacks."""

import asyncio
import json
import os
import signal
import sys
from pathlib import Path

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from modular_agent import AgentError, ErrorCode, Plugin
from modular_agent.testing import test_agent as make_agent


TOOL = {
    "name": "pick_color",
    "description": "Pick a color",
    "parameters": {"type": "object"},
    "callers": ["model"],
}


def source(timeout=30_000):
    return {
        "source_id": "picker",
        "actor_id": "user",
        "route_id": "editor",
        "result_timeout_ms": timeout,
        "tools": [TOOL],
    }


SCRIPT = [{"toolCalls": [{"name": "pick_color", "input": {"label": "color"}}]}, {"text": "done"}]


@pytest.fixture(params=[False, True], ids=["local-runtime", "process-runtime"])
def placement(request):
    return placement_options(request.param)


def placement_options(process, durable=False):
    return {
        "process_plugins": [
            {
                "command": [str(Path(sys.executable).with_name("modular-agent-plugin"))],
                "env": {"MODULAR_AGENT_PLUGIN_PARTS": "durable-runtime" if durable else "runtime"},
            }
        ]
        if process
        else [],
    }


async def test_interface_result_on_new_connection(placement):
    async with make_agent(script=SCRIPT, interface_tools=[source()], **placement) as agent:
        assert agent.declaration()["interfaceTools"] is True
        session = await agent.session()
        requests = []
        cx = agent.connect_interface_tools(
            actor_id="user", route_id="editor", on_handoff=requests.append
        )
        cx.advertise(session.id, [TOOL])
        await session.prompt("Pick a color")
        [request] = requests
        cx.close()
        peer = agent.connect_interface_tools(actor_id="user", route_id="editor")
        report = {
            "callId": request["call_id"],
            "status": "completed",
            "content": [{"type": "text", "text": "green"}],
        }
        assert sorted(
            await asyncio.gather(*(peer.report_tool_result(session.id, report) for _ in range(2)))
        ) == ["accepted", "alreadySettled"]
        await session.wait_idle()
        rows = await session.history()
        [start] = [r for r in rows if r["kind"] == "toolStarted"]
        [checkpoint] = [r for r in rows if r["kind"] == "modular-agent.interfaceHandoff"]
        [result] = [r for r in rows if r["kind"] == "toolResult"]
        first, second = [r for r in rows if r["kind"] == "turnStart"]
        assert "data" not in checkpoint
        assert checkpoint["parentId"] == start["id"]
        assert result["actorId"] == "user"
        assert result["turnId"] == first["turnId"]
        assert second["continuesTurnId"] == first["turnId"]
        assert second["data"]["startedBy"] == {"kind": "toolResult", "id": result["id"]}
        assert len([r for r in rows if r["kind"] in {"inputAccepted", "input"}]) == 2
        peer.close()


async def test_interface_presence_and_approval(placement):
    requests, approvals = [], []

    async def deny(question, context):
        approvals.append(question)
        return "decline"

    async with make_agent(
        script=SCRIPT, interface_tools=[source()], approval="all", on_question=deny, **placement
    ) as agent:
        session = await agent.session()
        cx = agent.connect_interface_tools(
            actor_id="user", route_id="editor", on_handoff=requests.append
        )
        cx.advertise(session.id, [TOOL])
        result = await session.prompt("Ask before sending")
        assert result.tool_results()[0].status == "refused"
        assert approvals and not requests
        assert not any(e["kind"] == "toolStarted" for e in await session.history())


async def test_interface_output_gate_must_leave_executable_request_unchanged(placement):
    requests, inspected = [], []

    async def gate(payload):
        events = payload["events"]
        for event in events:
            if event["type"] == "toolCall":
                event["data"]["call"]["input"]["label"] = "redacted"
                inspected.append(event["type"])
        return {"redact": events}

    async with make_agent(
        script=SCRIPT,
        interface_tools=[source()],
        plugins=[Plugin("redact", hooks={"output": gate})],
        **placement,
    ) as agent:
        session = await agent.session()
        cx = agent.connect_interface_tools(
            actor_id="user", route_id="editor", on_handoff=requests.append
        )
        cx.advertise(session.id, [TOOL])
        await session.send("Pick a color", "now")
        await session.wait_idle()
        result = await session.last_turn()
        assert result.tool_results()[0].status == "refused"
        assert inspected and not requests
        assert not any(e["kind"] == "toolStarted" for e in await session.history())


async def test_interface_report_checks_branch_route_rights_and_runs_after(placement):
    requests, reports = [], []
    alternate = {**TOOL, "name": "choose_number"}

    async def after(data):
        reports.append(data["result"]["content"])
        return {"change": {"content": [{"type": "text", "text": "checked data"}]}}

    async with make_agent(
        script=SCRIPT,
        interface_tools=[
            source(),
            {**source(), "source_id": "numbers", "route_id": "other", "tools": [alternate]},
        ],
        plugins=[Plugin("check", hooks={"tool.after": after})],
        **placement,
    ) as agent:
        session = await agent.session()
        cx = agent.connect_interface_tools(
            actor_id="user", route_id="editor", on_handoff=requests.append
        )
        cx.advertise(session.id, [TOOL])
        await session.prompt("Pick a color")
        [request] = requests
        report = {
            "callId": request["call_id"],
            "status": "completed",
            "content": [{"type": "text", "text": "raw data"}],
        }
        wrong = agent.connect_interface_tools(actor_id="user", route_id="other")
        limited = agent.connect_interface_tools(
            actor_id="user", route_id="editor", rights=["watch"]
        )
        assert await wrong.report_tool_result(session.id, report) == "refused"
        assert await limited.report_tool_result(session.id, report) == "refused"
        assert (
            await cx.report_tool_result(session.id, {**report, "status": "cancelled"}) == "refused"
        )
        assert not reports
        assert await cx.report_tool_result(session.id, report) == "accepted"
        await session.wait_idle()
        assert reports == [report["content"]]
        rows = await session.history()
        [entry] = [e for e in rows if e["kind"] == "toolResult"]
        assert entry["message"]["content"] == [{"type": "text", "text": "checked data"}]
        assert "raw data" not in json.dumps(rows)
        model = [e for e in rows if e["kind"] == "modelRequest"][-1]
        assert entry["id"] in model["sources"]


async def test_interface_expiry_refuses_results_and_continues(placement):
    requests = []
    async with make_agent(script=SCRIPT, interface_tools=[source(500)], **placement) as agent:
        session = await agent.session()
        cx = agent.connect_interface_tools(
            actor_id="user", route_id="editor", on_handoff=requests.append
        )
        cx.advertise(session.id, [TOOL])
        await session.prompt("Pick a color")
        [request] = requests
        cx.close()
        async with asyncio.timeout(5):
            async for event in session.events():
                if event.type == "toolResult":
                    assert event.data.fields["status"] == "outcomeUnknown"
                    break
        peer = agent.connect_interface_tools(actor_id="user", route_id="editor")
        assert (
            await peer.report_tool_result(
                session.id, {"callId": request["call_id"], "status": "completed", "content": []}
            )
            == "refused"
        )
        await session.wait_idle()
        rows = await session.history()
        [result] = [e for e in rows if e["kind"] == "toolResult"]
        assert "actorId" not in result
        assert len([e for e in rows if e["kind"] == "turnStart"]) == 2


async def test_interface_handoff_and_settlement_are_separate_spans(placement, monkeypatch):
    traces = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(traces))
    monkeypatch.setattr(trace, "get_tracer", provider.get_tracer)
    requests = []
    try:
        async with make_agent(script=SCRIPT, interface_tools=[source()], **placement) as agent:
            session = await agent.session()
            cx = agent.connect_interface_tools(
                actor_id="user", route_id="editor", on_handoff=requests.append
            )
            cx.advertise(session.id, [TOOL])
            await session.prompt("Pick a color")
            [request] = requests
            report = {
                "callId": request["call_id"],
                "status": "completed",
                "content": [{"type": "text", "text": "RESULT-SENTINEL"}],
            }
            with provider.get_tracer("test").start_as_current_span("caller"):
                assert await cx.report_tool_result(session.id, report) == "accepted"
            await session.wait_idle()
        spans = traces.get_finished_spans()
        [execution] = [s for s in spans if s.name == "execute_tool pick_color"]
        [settle] = [s for s in spans if s.name == "modular_agent.tool.settle"]
        [report_span] = [s for s in spans if s.name == "modular_agent.tool.report"]
        assert execution.attributes["modular_agent.tool.status"] == "pending"
        assert settle.attributes["modular_agent.tool.status"] == "completed"
        assert settle.parent.span_id == report_span.context.span_id
        assert settle.links[0].context.span_id == execution.context.span_id
        turns = [s for s in spans if s.name == "invoke_agent"]
        assert len(turns) == 2
        assert turns[1].links[0].context.span_id == turns[0].context.span_id
        assert "RESULT-SENTINEL" not in str([s.attributes for s in spans])
    finally:
        provider.shutdown()


@pytest.mark.parametrize("action", ["cancel", "erase", "close", "erase-result"])
async def test_interface_lifetime_controls(placement, tmp_path, action):
    requests = []
    kept = {"durability": "kept", "data_dir": tmp_path / "state"}
    async with make_agent(
        script=SCRIPT, project=tmp_path, interface_tools=[source()], **placement, **kept
    ) as agent:
        session = await agent.session()
        cx = agent.connect_interface_tools(
            actor_id="user", route_id="editor", on_handoff=requests.append
        )
        cx.advertise(session.id, [TOOL])
        await session.prompt("Pick a color")
        [request] = requests
        rows = await session.history()
        [start] = [e for e in rows if e["kind"] == "toolStarted"]
        [end] = [e for e in rows if e["kind"] == "turnEnd"]
        with pytest.raises(AgentError) as blocked:
            await session.move_to(end["id"])
        assert blocked.value.code in {ErrorCode.BUSY, ErrorCode.CONFLICT}
        if action == "erase":
            erasure = await session.erase([start["id"]])
            assert {"sessionId": session.id, "id": start["id"]} in erasure["erased"]
            assert erasure["outOfReach"]
        elif action == "close":
            await session.close()
            session = await agent.open_session(session.id)
        elif action == "erase-result":
            assert (
                await cx.report_tool_result(
                    session.id,
                    {
                        "callId": request["call_id"],
                        "status": "completed",
                        "content": [{"type": "text", "text": "erased payload"}],
                    },
                )
                == "accepted"
            )
            await session.wait_idle()
            [result] = [e for e in await session.history() if e["kind"] == "toolResult"]
            await session.erase([result["id"]])
        else:
            await session.cancel()
        assert (
            await cx.report_tool_result(
                session.id, {"callId": request["call_id"], "status": "completed", "content": []}
            )
            == "refused"
        )
        rows = await session.history()
        [terminal] = [e for e in rows if e["kind"] == "toolResult"]
        assert terminal.get("erased") or terminal["data"]["status"] == "outcomeUnknown"
        if action == "erase":
            assert "label" not in json.dumps([e for e in rows if e["id"] == start["id"]])
            assert not any(e.get("continuesTurnId") for e in rows)


async def test_without_option_does_not_declare_or_offer_interface_tools(placement):
    async with make_agent(script=[{"text": "unchanged"}], **placement) as agent:
        assert "interfaceTools" not in agent.declaration()
        session = await agent.session()
        with pytest.raises(AgentError) as error:
            agent.connect_interface_tools(actor_id="user", route_id="editor")
        assert error.value.code == ErrorCode.NOT_SUPPORTED
        await session.prompt("An ordinary prompt")
        assert not any(
            e["kind"] == "modular-agent.interfaceHandoff" for e in await session.history()
        )


@pytest.mark.parametrize(
    "bad",
    [
        {**source(), "result_timeout_ms": 0},
        {**source(), "result_timeout_ms": 2**53},
        {**source(), "tools": [{**TOOL, "callers": ["model", "ui"]}]},
        {**source(), "tools": [{**TOOL, "hints": {"safeToRepeat": True}}]},
        {**source(), "tools": [{**TOOL, "hints": {"openWorld": False}}]},
    ],
)
async def test_bad_interface_registration_is_a_composition_error(bad):
    with pytest.raises(AgentError) as error:
        await make_agent(script=SCRIPT, interface_tools=[bad])
    assert error.value.code == ErrorCode.INVALID_COMPOSITION


def crash_options(path, process, durable):
    return {
        "project": path,
        "data_dir": path / "state",
        "durability": "durable" if durable else "kept",
        "interface_tools": [source()],
        **placement_options(process, durable),
    }


async def driver(path, process, durable, active):
    held = asyncio.Event()

    async def hold_step(_):
        if active:
            await held.wait()

    def publish(request):
        if active:
            print(json.dumps(request), flush=True)

    async with make_agent(
        script=SCRIPT,
        plugins=[Plugin("hold", hooks={"step.after": hold_step})],
        **crash_options(path, process, durable),
    ) as agent:
        session = await agent.session()
        handed_off = []

        def received(request):
            handed_off.append(request)
            publish(request)

        cx = agent.connect_interface_tools(actor_id="user", route_id="editor", on_handoff=received)
        cx.advertise(session.id, [TOOL])
        await session.prompt("Pick a color")
        if not active:
            print(json.dumps(handed_off[0]), flush=True)
        await held.wait()


@pytest.mark.parametrize("process", [False, True], ids=["local-runtime", "process-runtime"])
@pytest.mark.parametrize(
    "durable,active", [(False, False), (True, False), (True, True), (False, True)]
)
async def test_interface_crash_recovery(tmp_path, process, durable, active):
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        __file__,
        str(tmp_path),
        str(int(process)),
        str(int(durable)),
        str(int(active)),
        stdout=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    try:
        async with asyncio.timeout(10):
            request = json.loads(await proc.stdout.readline())
    finally:
        os.killpg(proc.pid, signal.SIGKILL)
        assert await proc.wait() == -signal.SIGKILL
    async with make_agent(
        script=[{"text": "continued"}], **crash_options(tmp_path, process, durable)
    ) as agent:
        session = await agent.open_session(request["session_id"])
        retry = agent.connect_interface_tools(actor_id="user", route_id="editor")
        report = {"callId": request["call_id"], "status": "completed", "content": []}
        assert await retry.report_tool_result(session.id, report) == (
            "refused" if active and not durable else "accepted"
        )
        await session.wait_idle()
        rows = await session.history()
        assert len([e for e in rows if e["kind"] == "toolStarted"]) == 1
        assert len([e for e in rows if e["kind"] == "toolResult"]) == 1
        assert len([e for e in rows if e.get("continuesTurnId")]) == (
            0 if active and not durable else 1
        )


if __name__ == "__main__":
    asyncio.run(driver(Path(sys.argv[1]), *(bool(int(arg)) for arg in sys.argv[2:])))
