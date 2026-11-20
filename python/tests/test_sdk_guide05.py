import asyncio
from pathlib import Path

import pytest

from modular_agent import Durability, tool
from modular_agent.testing import restart, test_agent as agent_for_test


@pytest.mark.parametrize(("durability", "expected"), [("kept", "failed"), ("durable", "completed")])
async def test_reopens_an_interrupted_session(
    tmp_path: Path, durability: Durability, expected: str
) -> None:
    started = asyncio.Event()
    starts = 0

    @tool(read_only=True, safe_to_repeat=True)
    async def lookup_tide() -> str:
        """Read the tide time."""
        nonlocal starts
        starts += 1
        if starts == 1:
            started.set()
            await asyncio.Future()
        return "14:02"

    async with agent_for_test(
        data_dir=tmp_path,
        durability=durability,
        tools=[lookup_tide],
        script=[
            {"toolCalls": [{"name": "lookup_tide", "input": {}}]},
            {"text": "The tide time could not be confirmed."},
        ],
    ) as agent:
        session = await agent.session()
        session_id = session.id
        await session.send("Find the tide time.", "now")
        async with asyncio.timeout(5):
            await started.wait()

        async with await restart(agent) as rebuilt:
            reopened = await rebuilt.open_session(session_id)
            turn = await reopened.last_turn()
            assert turn is not None and turn.outcome is not None
            assert turn.outcome.kind == expected
            [result] = turn.tool_results()
            assert result.status == "outcomeUnknown"
            assert starts == 1
