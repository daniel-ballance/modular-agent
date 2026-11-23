"""Offline profile checks using the official in-memory exporters."""

import asyncio
import json
import os
from pathlib import Path
import sys

import pytest
from opentelemetry import baggage, context, metrics, trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from ma_core import telemetry as ot
from ma_plugin.rpc import Peer, trace_offer
from ma_plugin.server import PluginServer
from modular_agent import Plugin, ToolContext, create_agent, tool
from modular_agent.testing import memory_environment, scripted_provider


@pytest.fixture
def recorded(monkeypatch):
    exporter = InMemorySpanExporter()
    reader = InMemoryMetricReader()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    meter = MeterProvider(metric_readers=[reader])
    monkeypatch.setattr(trace, "get_tracer", provider.get_tracer)
    monkeypatch.setattr(metrics, "get_meter", meter.get_meter)
    yield exporter, reader
    meter.shutdown()
    provider.shutdown()


async def test_mapping_and_metadata_only(tmp_path, recorded):
    exporter, reader = recorded
    calls = []

    @tool
    async def parent(cx: ToolContext, value: str) -> str:
        """TOOL_DEFINITION_SENTINEL: delegate one call."""
        assert value == "ARGUMENT_SENTINEL"
        assert baggage.get_baggage("secret") is None
        return (await cx.tools.call("child", {})).text()

    @tool
    async def child(cx: ToolContext) -> str:
        """Ask a question."""
        calls.append(await cx.ask({"kind": "text", "question": "QUESTION_SENTINEL"}))
        return "RESULT_SENTINEL"

    script = [
        {
            "toolCalls": [{"name": "parent", "input": {"value": "ARGUMENT_SENTINEL"}}],
            "usage": {"input": 14, "cacheRead": 16, "cacheWrite": 18, "output": 4},
        },
        {"text": "RESPONSE_SENTINEL"},
    ]
    async with create_agent(
        project=tmp_path,
        agent_name="test-agent",
        tools=[parent, child],
        providers=[scripted_provider(script)],
        environment=memory_environment(),
        on_question=lambda q, c: "ANSWER_SENTINEL",
    ) as agent:
        assert agent.declaration()["telemetry"] == 1
        session = await agent.session()
        token = context.attach(baggage.set_baggage("secret", "BAGGAGE_SENTINEL"))
        try:
            result = await session.prompt("PROMPT_SENTINEL")
        finally:
            context.detach(token)
        assert result.outcome.kind == "completed"
        assert len(calls) == 1
    spans = exporter.get_finished_spans()
    by_name = {span.name: span for span in spans}
    agent_span = by_name["invoke_agent test-agent"]
    admit = by_name["modular_agent.input.admit"]
    first, second = [s for s in spans if s.name == "modular_agent.step"]
    parent_span, child_span = by_name["execute_tool parent"], by_name["execute_tool child"]
    assert agent_span.parent == admit.context
    assert first.parent == second.parent == agent_span.context
    assert parent_span.parent == first.context
    assert child_span.parent == parent_span.context
    assert (
        child_span.attributes["modular_agent.tool.parent_call.id"]
        == parent_span.attributes["modular_agent.tool.call.id"]
    )
    assert parent_span.attributes["gen_ai.tool.call.id"] == "script-0-0"
    assert "gen_ai.tool.call.id" not in child_span.attributes
    assert agent_span.attributes["gen_ai.agent.name"] == "test-agent"
    assert agent_span.attributes["modular_agent.turn.outcome"] == "completed"
    models = [s for s in spans if s.name == "chat script"]
    assert [s.parent for s in models] == [first.context, second.context]
    assert models[0].kind == trace.SpanKind.INTERNAL
    assert models[0].attributes["gen_ai.provider.name"] == "scripted"

    def usage(span):
        return {k: v for k, v in span.attributes.items() if k.startswith("gen_ai.usage.")}

    assert usage(models[0]) == {
        "gen_ai.usage.input_tokens": 48,
        "gen_ai.usage.cache_read.input_tokens": 16,
        "gen_ai.usage.cache_write.input_tokens": 18,
        "gen_ai.usage.output_tokens": 4,
    }
    assert usage(models[1]) == {}
    assert all(s.attributes.get("gen_ai.conversation.id") == session.id for s in spans)
    assert [s.name for s in spans if s.name.startswith("modular_agent.session.")] == [
        "modular_agent.session.open",
        "modular_agent.session.close",
    ]
    events = [e for s in spans for e in s.events if e.name.startswith("modular_agent.question.")]
    assert {e.name for e in events} == {
        "modular_agent.question.open",
        "modular_agent.question.close",
    }
    assert len({e.attributes["modular_agent.question.id"] for e in events}) == 1
    assert "SENTINEL" not in "".join(s.to_json() for s in spans)
    summary = {
        m.name: m.data.data_points[0]
        for resource in reader.get_metrics_data().resource_metrics
        for scope in resource.scope_metrics
        for m in scope.metrics
    }
    assert summary["gen_ai.client.inference.duration"].count == 2
    assert summary["gen_ai.client.inference.usage.input_tokens"].value == 48
    assert summary["gen_ai.client.inference.usage.output_tokens"].value == 4
    assert "SENTINEL" not in repr(summary)


async def test_job_report_admission_links_to_one_job(tmp_path, recorded):
    exporter, _ = recorded

    class Owner:
        async def cancel(self, job, cx):
            await job.end("cancelled")

    async def command(value, cx):
        job = await cx.jobs.start("sample", {"private": "JOB_DETAIL_SENTINEL"}, key="one")
        assert (await cx.jobs.start("sample", {}, key="one")).id == job.id
        await job.end("completed", "JOB_REPORT_SENTINEL", report=True)
        return job.id

    def setup(registrar):
        registrar.jobs(Owner())
        registrar.command("sample", "Start a sample job", command)

    async with create_agent(
        project=tmp_path,
        plugins=[Plugin("job-test", setup=setup)],
        providers=[scripted_provider([])],
    ) as agent:
        session = await agent.session()
        job_id = await session.run_command("/sample")
    spans = exporter.get_finished_spans()
    [job] = [s for s in spans if s.name == "modular_agent.job"]
    [admit] = [s for s in spans if s.name == "modular_agent.input.admit"]
    assert job.attributes["modular_agent.job.id"] == job_id
    assert job.attributes["modular_agent.job.outcome"] == "completed"
    assert [link.context for link in admit.links] == [job.context]
    assert admit.attributes["modular_agent.input.id"]
    assert "SENTINEL" not in job.to_json() + admit.to_json()


class BrokenExporter(SpanExporter):
    def export(self, spans):
        raise RuntimeError("EXPORT_FAILURE_SENTINEL")


async def test_export_failure_does_not_repeat_effects(tmp_path, monkeypatch):
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(BrokenExporter()))
    monkeypatch.setattr(trace, "get_tracer", provider.get_tracer)
    effects = []

    @tool
    async def effect() -> str:
        """Count an effect."""
        effects.append(1)
        return "ok"

    try:
        script = [{"toolCalls": [{"name": "effect"}]}, {"text": "settled"}]
        async with create_agent(
            project=tmp_path, tools=[effect], providers=[scripted_provider(script)]
        ) as agent:
            session = await agent.session()
            result = await session.prompt("run")
            assert result.outcome.kind == "completed"
            assert effects == [1]
            assert len([e for e in await session.history() if e["kind"] == "turnEnd"]) == 1
    finally:
        provider.shutdown()


class Frames:
    def __init__(self):
        self.queue = asyncio.Queue()
        self.sent = []

    async def send(self, raw):
        self.sent.append(json.loads(raw))
        self.peer.queue.put_nowait(raw)

    async def receive(self):
        return await self.queue.get()

    async def close(self):
        self.peer.queue.put_nowait(None)


@pytest.mark.parametrize(("offer", "accept"), [(True, True), (True, False), (False, True)])
async def test_plugin_context_requires_handshake(recorded, offer, accept):
    exporter, _ = recorded
    host_wire, plugin_wire = Frames(), Frames()
    host_wire.peer, plugin_wire.peer = plugin_wire, host_wire

    async def callback(method, params, key):
        return {"ok": True}

    async def work(params, key):
        return await plugin.peer.request("host/tools/list", {"parentRequestId": key})

    plugin = PluginServer(
        {"binding": "modular-agent-plugin/1", "name": "fixture"}, {"tools/call": work}
    )
    plugin.trace_context = accept
    host = Peer(None, None, callback, frames=host_wire, label="fixture")
    server = asyncio.create_task(plugin.serve_frames(plugin_wire))
    try:
        response = await host.request(
            "plugin/initialize",
            {
                "binding": "modular-agent-plugin/1",
                "data": "modular-agent-data/1",
                **({"traceContext": 1} if offer else {}),
            },
        )
        host.trace_agreed = offer and trace_offer(response.get("traceContext"))
        assert ("traceContext" in response) == (offer and accept)
        with ot.span("fixture.root"):
            assert await host.request("tools/call", {"traceContext": {"baggage": "BOGUS"}}) == {
                "ok": True
            }
        requests = [
            line
            for line in host_wire.sent + plugin_wire.sent
            if line.get("method") in {"tools/call", "host/tools/list"}
        ]
        assert len(requests) == 2
        for line in requests:
            carrier = line["params"].get("traceContext")
            assert (carrier is not None) == (offer and accept)
            assert carrier is None or (
                set(carrier) == {"traceparent"} and ot.valid(ot.extract(carrier))
            )
        if offer and accept:
            spans = exporter.get_finished_spans()
            pairs = [
                s for s in spans if s.attributes.get("modular_agent.plugin.method") == "tools/call"
            ]
            sent = next(s for s in pairs if s.kind == trace.SpanKind.CLIENT)
            received = next(s for s in pairs if s.kind == trace.SpanKind.SERVER)
            assert received.parent.trace_id == sent.context.trace_id
            assert received.parent.span_id == sent.context.span_id
    finally:
        await host.close()
        await server


@pytest.mark.parametrize("mode", ["crash", "no-sdk"])
async def test_process_recovery_and_no_sdk(tmp_path, mode):
    fixture = str(Path(__file__).with_name("telemetry_driver.py"))

    async def run(phase):
        return await asyncio.create_subprocess_exec(
            sys.executable,
            fixture,
            str(tmp_path),
            phase,
            env={**os.environ, "HOME": str(tmp_path)},
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

    if mode == "no-sdk":
        p = await run(mode)
        _, err = await p.communicate()
        assert p.returncode == 0, err.decode()
        return

    async def kill_at_checkpoint(phase):
        p = await run(phase)
        try:
            async with asyncio.timeout(15):
                line = await p.stdout.readline()
            assert line, (await p.stderr.read()).decode()
            return json.loads(line)
        finally:
            if p.returncode is None:
                p.kill()
            await p.wait()

    first = await kill_at_checkpoint("start")
    second = await kill_at_checkpoint("resume")
    p = await run("settle")
    out, err = await p.communicate()
    assert p.returncode == 0, err.decode()
    final = json.loads(out)
    assert first["turn"] == second["turn"] == final["turn"]
    trace_id = first["traceparent"].split("-")[1]
    assert second["traceparent"].split("-")[1] == final["trace_id"] == trace_id
    assert final["parent_id"] == final["link_id"] == second["traceparent"].split("-")[2]
    assert len({first["traceparent"].split("-")[2], final["parent_id"], final["span_id"]}) == 3
    assert final["resumed"] is True
