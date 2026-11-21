"""Exercise typed hook payloads and live events only through SDK registrations."""

from typing import assert_type

import pytest

from modular_agent import (
    AgentError,
    Change,
    CredentialStore,
    ErrorCode,
    HookContext,
    JsonObject,
    Plugin,
    ProviderContext,
    Registrar,
    StepBefore,
    TextEvent,
    ToolContext,
    TurnEndedEvent,
    create_agent,
    tool,
)
from modular_agent.testing import memory_environment, over_wire, scripted_provider


@pytest.mark.parametrize("served", [False, True])
async def test_typed_step_hook_and_stream(served):
    seen = []

    async def before(payload: StepBefore, cx: HookContext) -> Change[JsonObject]:
        assert_type(payload["request"], JsonObject)
        assert payload["stepId"] == cx.step_id
        page = await cx.history()
        assert page["entries"]
        seen.append(cx)
        return {"change": {"systemPrompt": "Extra instruction"}}

    def setup(r: Registrar):
        r.on("step.before", before)

    plugin = Plugin("typed", setup=setup)
    async with create_agent(
        providers=[scripted_provider([{"text": "result"}])],
        plugins=[over_wire(plugin) if served else plugin],
    ) as agent:
        session = await agent.session()
        events = [event async for event in session.prompt_stream("start")]
        [text] = [event for event in events if isinstance(event, TextEvent)]
        assert text.data.fields["delta"] == "result"
        assert isinstance(events[-1], TurnEndedEvent)
        assert events[-1].data.fields["outcome"]["kind"] == "completed"
        assert any(
            entry["kind"] == "modelRequest"
            and entry["data"]["request"]["systemPrompt"] == "Extra instruction"
            for entry in await session.history()
        )
        [stale] = seen
        with pytest.raises(AgentError) as failure:
            await stale.history()
        assert failure.value.code is ErrorCode.INVALID_REQUEST


async def test_tool_and_provider_can_access_named_credentials():
    class Provider:
        delegate = scripted_provider([{"text": "answer"}])
        id, supports = delegate.id, delegate.supports
        models = delegate.models

        async def request(self, model, request, cx: ProviderContext):
            assert cx.credential("test-name") == "offline-value"
            return await self.delegate.request(model, request, cx)

    @tool(in_process_only=True)
    async def check(cx: ToolContext):
        """Check that a credential is available without exposing its value."""
        assert await cx.credential("test-name") == "offline-value"
        return "available"

    async with create_agent(
        credentials=CredentialStore(lambda name: "offline-value" if name == "test-name" else None),
        tools=[check],
        providers=[Provider()],
        environment=memory_environment(),
    ) as agent:
        session = await agent.session()
        assert (await session.call_tool("check", {})).text() == "available"
        assert (await session.prompt("start")).text == "answer"
        assert "offline-value" not in str(await session.history())
