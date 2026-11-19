"""The Python examples in SDK guides 01–03, with no real model calls."""

import sys
from pathlib import Path

from modular_agent import Plugin, ProcessPlugin, tool
from modular_agent.testing import test_agent

test_agent.__test__ = False


async def test_says_hello() -> None:
    async with test_agent(script=[{"text": "Hello."}]) as agent:
        turn = await (await agent.session()).prompt("Say hello.")
        assert turn.text == "Hello."


async def test_stream(capsys) -> None:
    async with test_agent(script=[{"text": "Whitby has a harbour."}]) as agent:
        session = await agent.session()
        async for event in session.prompt_stream("Describe Whitby harbour in two sentences."):
            if event.type == "text":
                print(event.data.delta, end="", flush=True)
        assert event.type == "turnEnded"
    assert capsys.readouterr().out == "Whitby has a harbour."


@tool(read_only=True)
async def tide(harbour: str) -> str:
    """Today's high tide at a harbour.

    Args:
        harbour: The harbour to look up.
    """
    return f"High tide at {harbour} is 14:02."


async def test_looks_up_the_tide() -> None:
    script = [
        {"toolCalls": [{"name": "tide", "input": {"harbour": "Whitby"}}]},
        {"text": "High tide is at 14:02."},
    ]
    async with test_agent(tools=[tide], script=script) as agent:
        turn = await (await agent.session()).prompt("When is high tide at Whitby?")
        assert turn.text == "High tide is at 14:02."
        [result] = turn.tool_results()
        assert result.status == "completed"
        assert result.text() == "High tide at Whitby is 14:02."


async def test_serves_tide(tmp_path: Path) -> None:
    path = tmp_path / "tides.py"
    path.write_text('''# tides.py
from modular_agent import Plugin, serve, tool


@tool(read_only=True)
async def tide(harbour: str) -> str:
    """Today's high tide at a harbour.

    Args:
        harbour: The harbour to look up.
    """
    return f"High tide at {harbour} is 14:02."


serve(Plugin("tides", tools=[tide]))
''')
    script = [{"toolCalls": [{"name": "tide", "input": {"harbour": "Whitby"}}]}, {"text": "Done."}]
    async with test_agent(
        script=script, process_plugins=[ProcessPlugin([sys.executable, str(path)])]
    ) as agent:
        served = (await (await agent.session()).prompt("High tide?")).tool_results()
    async with test_agent(script=script, plugins=[Plugin("tides", tools=[tide])]) as agent:
        local = (await (await agent.session()).prompt("High tide?")).tool_results()
    assert len(served) == len(local) == 1
    assert served[0].text() == local[0].text() == "High tide at Whitby is 14:02."
