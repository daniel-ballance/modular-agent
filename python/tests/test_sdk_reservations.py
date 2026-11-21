import asyncio

import pytest
from modular_agent import AgentError, ErrorCode, create_agent
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
