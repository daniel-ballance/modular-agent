import asyncio

import pytest
from modular_agent import AgentError, ErrorCode, create_agent, file_history, tool
from modular_agent.testing import scripted_provider


@pytest.mark.parametrize("scope", ["session", "tenant", "agent"])
async def test_only_one_proposal_wins_and_refused_key_is_reusable(scope):
    async with create_agent(
        several_actors=True, resource_reservations={scope: {"inputs": 1}}
    ) as agent:
        first = await agent.session()
        second = first if scope == "session" else await agent.session()
        assert agent.declaration()["resourceReservations"][scope]["inputs"] == 1
        receipts = await asyncio.gather(
            first.send("one", "propose", key="one"),
            second.send("two", "propose", key="two"),
            return_exceptions=True,
        )
        won = 0 if not isinstance(receipts[0], Exception) else 1
        winner, loser = (first, second) if won == 0 else (second, first)
        winning_key, losing_key = ("one", "two") if won == 0 else ("two", "one")
        accepted, refused = receipts[won], receipts[1 - won]
        assert isinstance(refused, AgentError) and refused.code is ErrorCode.BUSY
        duplicate = await winner.send("not a new proposal", "propose", key=winning_key)
        assert duplicate.duplicate and duplicate.input_id == accepted.input_id
        await winner.withdraw(accepted.input_id)
        assert not (await loser.send("try again", "propose", key=losing_key)).duplicate


async def test_capacity_refuses_model_attempt_without_dispatch():
    async with create_agent(
        providers=[scripted_provider([{"text": "unexpected"}])],
        resource_reservations={"session": {"calls": 0}},
    ) as agent:
        session = await agent.session()
        result = await session.prompt("no attempts allowed")
        assert result.outcome is not None
        assert result.outcome.kind == "limit" and result.outcome.limit == "capacity"
        assert not any(e["kind"] == "modelRequest" for e in await session.history())


async def test_over_capacity_call_list_is_replaced_before_recording():
    script = [
        {
            "toolCalls": [{"name": "a", "input": {}}, {"name": "b", "input": {}}],
            "usage": {"input": 3, "output": 2},
        }
    ]
    async with create_agent(
        providers=[scripted_provider(script)],
        resource_reservations={"session": {"calls": 1}},
    ) as agent:
        session = await agent.session()
        result = await session.prompt("offer two calls")
        assert result.outcome is not None and result.outcome.limit == "capacity"
        entries = await session.history()
        assert all(e["kind"] not in {"toolCall", "toolStarted"} for e in entries)
        [response] = [e for e in entries if e["kind"] == "response"]
        assert response["message"]["stop"] == "failed"
        assert response["message"]["content"] == []
        assert response["message"]["usage"]["input"] == 3


async def test_oversized_tool_result_still_records_terminal_call():
    @tool
    async def large() -> str:
        """Return a result larger than the tool settlement budget."""
        return "x" * 50_000

    async with create_agent(
        tools=[large], resource_reservations={"session": {"calls": 1}}
    ) as agent:
        session = await agent.session()
        with pytest.raises(AgentError) as too_large:
            await session.call_tool("large", {})
        assert too_large.value.code is ErrorCode.RESULT_TOO_LARGE
        [terminal] = [e for e in await session.history() if e["kind"] == "toolResult"]
        assert terminal["data"]["status"] == "completed"
        assert terminal["data"]["resultUnavailable"] == "result_too_large"
        assert terminal["message"]["content"] == []


async def test_unopened_proposal_is_charged_after_restart(tmp_path):
    options = {
        "project": tmp_path,
        "data_dir": tmp_path / "data",
        "history": file_history(tmp_path / "store"),
        "durability": "kept",
        "several_actors": True,
        "resource_reservations": {"agent": {"inputs": 1}},
    }
    async with create_agent(**options) as agent:
        session = await agent.session()
        sid = session.id
        proposal = await session.send("held", "propose")
    async with create_agent(**options) as agent:
        fresh = await agent.session()
        with pytest.raises(AgentError) as rejected:
            await fresh.send("no room", "propose", key="reusable")
        assert rejected.value.code is ErrorCode.BUSY
        old = await agent.open_session(sid)
        await old.withdraw(proposal.input_id)
        assert not (await fresh.send("now there is room", "propose", key="reusable")).duplicate
