"""Embedded actor views use the recorded session authority, not copied grants."""

import pytest

from modular_agent import AgentError, ErrorCode
from modular_agent.testing import test_agent as build_agent


async def test_actor_rights_and_limits_apply_to_existing_views():
    async with build_agent(
        script=[{"text": "Hello."}], several_actors=True, session_limits=True
    ) as agent:
        session = await agent.session(
            actors=[{"id": "editor", "kind": "user", "rights": ["input", "watch"]}]
        )
        editor = session.as_actor("editor")
        await session.set_limit(["watch"])
        with pytest.raises(AgentError) as denied:
            await editor.prompt("Hello")
        assert denied.value.code is ErrorCode.FORBIDDEN
        await session.set_limit()
        assert (await editor.prompt("Hello")).text == "Hello."
        inputs = [entry for entry in await session.history() if entry["kind"] == "inputAccepted"]
        assert inputs[0]["actorId"] == "editor"
        assert inputs[0]["data"]["submittedBy"] == "user"
        await session.leave("editor")
        with pytest.raises(AgentError) as departed:
            await editor.history()
        assert departed.value.code is ErrorCode.FORBIDDEN


async def test_options_are_off_by_default():
    async with build_agent(script=[]) as agent:
        session = await agent.session()
        for key in ("severalActors", "sessionLimits", "tenants"):
            assert agent.declaration()[key] is False
        with pytest.raises(AgentError) as view:
            session.as_actor("other")
        with pytest.raises(AgentError) as limit:
            await session.set_limit([])
        with pytest.raises(AgentError) as tenant:
            await agent.session(tenant="other")
        with pytest.raises(AgentError) as proposal:
            await session.send("Hello", "propose")
        assert {error.value.code for error in (view, limit, tenant, proposal)} == {
            ErrorCode.NOT_SUPPORTED
        }
