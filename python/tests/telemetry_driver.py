"""An offline process killed after its saved segment reaches the Provider boundary."""

import asyncio
import importlib.abc
import json
from pathlib import Path
import sys


class NoSDK(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.startswith(("opentelemetry.sdk", "opentelemetry.exporter")):
            raise ModuleNotFoundError(fullname)
        return None


ROOT, PHASE = Path(sys.argv[1]), sys.argv[2]
if PHASE == "no-sdk":
    sys.meta_path.insert(0, NoSDK())


async def main():
    from modular_agent import create_agent
    from modular_agent.testing import scripted_provider

    fixture = scripted_provider([{"text": "settled"}])
    if PHASE == "no-sdk":
        async with create_agent(project=ROOT, providers=[fixture]) as agent:
            assert agent.declaration()["telemetry"] == 1
            assert (await (await agent.session()).prompt("offline")).outcome.kind == "completed"
        return

    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    sdk = TracerProvider()
    trace.set_tracer_provider(sdk)
    exporter = InMemorySpanExporter()
    sdk.add_span_processor(SimpleSpanProcessor(exporter))

    class Provider:
        id, supports, models = fixture.id, fixture.supports, staticmethod(fixture.models)

        async def request(self, model, request, context):
            if PHASE != "settle":
                sid = (ROOT / "session").read_text()
                entries = (await agent._call("history", "read", session=sid))["entries"]
                wanted = "turn_start" if PHASE == "start" else "modular-agent.turnTrace"
                [entry] = [e for e in entries if e["kind"] == wanted]
                print(
                    json.dumps({"turn": entry["turn"], **entry["data"]["traceContext"]}), flush=True
                )
                await asyncio.Future()
            return await fixture.request(model, request, context)

    async with create_agent(
        project=ROOT, data_dir=ROOT / "state", durability="durable", providers=[Provider()]
    ) as agent:
        if PHASE == "start":
            session = await agent.session()
            (ROOT / "session").write_text(session.id)
            await session.prompt("offline")
        else:
            session = await agent.open_session((ROOT / "session").read_text())
            assert (await session.last_turn()).outcome.kind == "completed"
            fork = await session.fork()
            copied = await fork.history()
            assert not any(
                e["kind"] == "modular-agent.turnTrace" or "traceContext" in e.get("data", {})
                for e in copied
            )
    [invocation] = [s for s in exporter.get_finished_spans() if s.name == "invoke_agent"]
    [link] = invocation.links
    print(
        json.dumps(
            {
                "turn": invocation.attributes["modular_agent.turn.id"],
                "resumed": invocation.attributes["modular_agent.turn.resumed"],
                "trace_id": f"{invocation.context.trace_id:032x}",
                "span_id": f"{invocation.context.span_id:016x}",
                "parent_id": f"{invocation.parent.span_id:016x}",
                "link_id": f"{link.context.span_id:016x}",
            }
        ),
        flush=True,
    )
    sdk.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
