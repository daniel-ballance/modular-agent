"""Progress keeps shared Content from the tool to a public event follower."""

import sys
from contextlib import aclosing
from pathlib import Path

import pytest

from modular_agent import Plugin, ToolContext, ToolOutputEvent, tool
from modular_agent.testing import over_wire, test_agent as make_agent


@pytest.mark.parametrize("served", [False, True])
@pytest.mark.parametrize("hosted_runtime", [False, True])
async def test_tool_output_keeps_image_content(served, hosted_runtime):
    image = {
        "type": "image",
        "mimeType": "image/gif",
        "data": "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    }
    progress = [{"type": "text", "text": "preview"}, image]

    @tool
    async def render(cx: ToolContext):
        """Report a preview and then finish."""
        await cx.progress(progress)
        await cx.progress([image])
        return "done"

    seen = []

    async def output(payload):
        seen.extend(e["data"] for e in payload["events"] if e["type"] == "toolOutput")

    plugin = Plugin("preview", tools=[render], hooks={"output": output} if served else {})
    script = [{"toolCalls": [{"name": "render", "input": {}}]}, {"text": "finished"}]
    runtime = (
        [
            {
                "command": [str(Path(sys.executable).with_name("modular-agent-plugin"))],
                "env": {"MODULAR_AGENT_PLUGIN_PARTS": "runtime"},
            }
        ]
        if hosted_runtime
        else []
    )
    async with make_agent(
        script=script,
        plugins=[over_wire(plugin) if served else plugin],
        process_plugins=runtime,
    ) as agent:
        session = await agent.session()
        async with aclosing(session.events()) as events:
            assert (await anext(events)).type == "entry"
            turn = await session.prompt("Render a preview")
            outputs = []
            async for event in events:
                if isinstance(event, ToolOutputEvent):
                    outputs.append(event.data.fields)
                if event.type == "turnEnded":
                    break
            call_id = turn.tool_results()[0].call_id
            assert outputs == [
                {"toolCallId": call_id, "chunk": "preview", "content": progress},
                {"toolCallId": call_id, "chunk": "", "content": [image]},
            ]
            if served:
                assert all(event in seen for event in outputs)
