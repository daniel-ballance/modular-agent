"""An offline triage agent. Only the authenticated desk plugin supplies tools."""
import asyncio
import os
import signal

from modular_agent import create_agent
from modular_agent.testing import ScriptedProvider, scripted_provider


class Triage(ScriptedProvider):
    def __init__(self):
        super().__init__([])

    async def request(self, model, request, context):
        event = next(m for m in request["messages"] if m["role"] == "user")
        report = " ".join(p["text"] for p in event["content"] if p["type"] == "text")
        summary = "The sample percentage check needs a fix. Report: " + report[:800]
        script = [
            {"toolCalls": [{"name": "post", "input": {"kind": "summary", "text": summary}}]},
            {"toolCalls": [{"name": "hand_off", "input": {"to": "coder", "task": summary}}]},
            {"text": "Sent the report to the coder."},
        ]
        return await scripted_provider(script).request(model, request, context)


def telemetry():
    if not os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT") or os.getenv("OTEL_SDK_DISABLED") == "true":
        return
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    provider = TracerProvider()
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    return provider


async def main():
    stop = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_running_loop().add_signal_handler(sig, stop.set)
    provider = telemetry()
    project = os.environ["DESK_PROJECT"]
    async with create_agent(
        project=project, data_dir=os.environ["MODULAR_AGENT_DATA_DIR"], durability="durable",
        providers=[Triage()], model="scripted/script", plugin_host=True,
    ) as agent:
        server = await agent.serve_agui(listen="127.0.0.1:0", actors=[{
            "token_file": os.environ["DESK_TOKEN_FILE"], "client_id": "ops-desk",
            "actor": {"id": "desk", "kind": "user", "rights": ["input", "watch", "tools", "approve", "answer"]},
            "projects": [project], "trace_trusted": True,
        }])
        print(server.url, flush=True)
        await stop.wait()
        await server.close()
    if provider:
        provider.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
