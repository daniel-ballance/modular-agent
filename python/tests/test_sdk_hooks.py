"""Developer hooks can transform the committed Provider request in either placement."""

import pytest

from modular_agent import Plugin, ToolContext, create_agent, tool
from modular_agent.testing import over_wire, scripted_provider


@pytest.mark.parametrize("served", [False, True])
async def test_provider_hook_transforms_committed_request(served):
    seen = []

    def setup(registrar):
        registrar.provider(scripted_provider([{"text": "Hello."}]))
        registrar.on("provider.request", lambda _: {"change": {"system": "From Provider hook"}})
        registrar.on("provider.response", lambda payload: seen.append(payload["message"]["stop"]))

    plugin = Plugin("extra-hooks", setup=setup)
    async with create_agent(plugins=[over_wire(plugin) if served else plugin]) as agent:
        session = await agent.session()
        assert (await session.prompt("Say hello.")).text == "Hello."
        [kept] = [entry for entry in await session.history() if entry["kind"] == "modelRequest"]
        assert kept["data"]["request"]["system"] == "From Provider hook"
        assert seen == ["finished"]


@pytest.mark.parametrize("served", [False, True])
async def test_tool_history_is_scoped_and_keeps_wire_names(served):
    @tool
    async def inspect(cx: ToolContext) -> str:
        """Read this call's history page."""
        page = await cx.history()
        first, *rest = page["entries"]
        assert (await cx.history(first["id"]))["entries"] == rest
        assert any(entry["kind"] == "toolStarted" for entry in rest)
        return "Saw the committed call."

    plugin = Plugin("inspect-history", tools=[inspect])
    async with create_agent(
        providers=[
            scripted_provider(
                [{"toolCalls": [{"name": "inspect", "input": {}}]}, {"text": "Done."}]
            )
        ],
        plugins=[over_wire(plugin) if served else plugin],
    ) as agent:
        session = await agent.session()
        [result] = (await session.prompt("Inspect.")).tool_results()
        assert result.text() == "Saw the committed call."
