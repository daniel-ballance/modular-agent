from pathlib import Path

import pytest
from modular_agent import AgentError, Plugin, tool
from modular_agent.testing import over_wire, test_agent as scripted_agent


@pytest.mark.asyncio
async def test_empty_lists_do_not_enable_or_require_plugin_host(monkeypatch):
    monkeypatch.setenv("MODULAR_AGENT_PLUGINS", "not JSON")
    async with scripted_agent(script=[], process_plugins=[], service_plugins=[], plugin_host=False):
        pass
    async with scripted_agent(script=[], process_plugins=[], service_plugins=[]):
        pass
    with pytest.raises(AgentError) as invalid:
        await scripted_agent(script=[], project=Path.cwd(), plugin_host=True)
    assert invalid.value.code == "invalid_composition"


@pytest.mark.asyncio
@pytest.mark.parametrize("wire", [False, True])
@pytest.mark.parametrize("repair", [False, True])
async def test_completed_tool_value_is_checked_after_transform(wire, repair):
    ran = []

    @tool(output=int)
    async def count():
        """Return a count."""
        ran.append(True)
        return "not an integer"

    async def after(payload):
        assert payload["result"]["status"] == "completed"
        return {"change": {"value": 6}} if repair else None

    plugin = Plugin("counting", tools=[count], hooks={"tool.after": after})
    script = [{"toolCalls": [{"name": "count", "input": {}}]}, {"text": "done"}]
    async with scripted_agent(script=script, plugins=[over_wire(plugin) if wire else plugin]) as a:
        session = await a.session()
        turn = await session.prompt("Count it")
        assert ran == [True]
        result = turn.tool_results()[0]
        assert result.status == "completed"
        assert result.value == (6 if repair else None)
        assert turn.outcome is not None and turn.outcome.kind == (
            "completed" if repair else "failed"
        )
