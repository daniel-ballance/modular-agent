"""Embedded actor views use the recorded session authority, not copied grants."""

import pytest

from modular_agent import (
    AgentError,
    ErrorCode,
    durable_runtime,
    local_environment,
    transient_runtime,
)
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


async def test_tenant_ceiling_and_budget():
    async with build_agent(
        script=[{"text": "First", "usage": {"input": 2, "output": 1}}],
        tenants={"team": {"rights": ["watch", "input"], "tokens": 3}},
        session_limits=True,
    ) as agent:
        assert agent.declaration()["tenants"] is True
        first = await agent.session(tenant="team")
        assert (await first.history())[0]["kind"] == "tenant"
        with pytest.raises(AgentError) as denied:
            await first.set_limit([])
        assert denied.value.code is ErrorCode.FORBIDDEN
        outcome = (await first.prompt("Hello")).outcome
        assert outcome is not None and outcome.limit == "tenantTokens"
        second = await agent.session(tenant="team")
        outcome = (await second.prompt("Hello again")).outcome
        assert outcome is not None and outcome.limit == "tenantTokens"
        with pytest.raises(AgentError) as unknown:
            await agent.session(tenant="unknown")
        assert unknown.value.code is ErrorCode.FORBIDDEN


async def test_explicit_local_and_runtime_constructors(tmp_path):
    async with build_agent(
        script=[], project=tmp_path, environment=local_environment(), runtime=transient_runtime()
    ) as agent:
        assert agent.declaration()["continuesAfterRestart"] is False
        assert agent.declaration()["confinesFiles"] is False
    with pytest.raises(AgentError) as inconsistent:
        await build_agent(script=[], runtime=durable_runtime())
    assert inconsistent.value.code is ErrorCode.INVALID_COMPOSITION


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
