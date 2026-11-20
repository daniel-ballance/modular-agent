"""Opt-in smoke checks against real model services; use only before a release."""

import os

import pytest

from modular_agent import create_agent
from modular_agent.anthropic import anthropic
from modular_agent.fixtures import tide
from modular_agent.openai import openai

pytestmark = pytest.mark.skipif(
    os.getenv("MODULAR_AGENT_LIVE") != "1", reason="requires MODULAR_AGENT_LIVE=1"
)


@pytest.mark.parametrize(
    ("provider_id", "key_variable", "model_variable", "default_model", "build"),
    [
        ("openai", "OPENAI_API_KEY", "MODULAR_AGENT_LIVE_OPENAI_MODEL", "gpt-6-luna", openai),
        (
            "anthropic",
            "ANTHROPIC_API_KEY",
            "MODULAR_AGENT_LIVE_ANTHROPIC_MODEL",
            "claude-haiku-5-5",
            anthropic,
        ),
    ],
)
async def test_live_provider(provider_id, key_variable, model_variable, default_model, build):
    if not os.getenv(key_variable):
        pytest.skip(f"{key_variable} is absent")
    model = os.getenv(model_variable, default_model)
    provider = build(models=[model])
    [info] = provider.models()
    reasoning = next((level for level in info.get("thinking", []) if level != "off"), "off")
    async with create_agent(
        providers=[provider], model=f"{provider_id}/{model}", tools=[tide]
    ) as agent:
        session = await agent.session()
        await session.set_setting("reasoning", reasoning)
        chunks = [
            event.data.delta
            async for event in session.prompt_stream("Say hello in one sentence.")
            if event.type == "text"
        ]
        result = await session.last_turn()
        assert result is not None and result.outcome is not None
        assert result.outcome.kind == "completed"
        assert result.text.strip() and "".join(chunks) == result.text

        session = await agent.session()
        result = await session.prompt(
            "Call the tide tool for Whitby. Then quote the time from its result in your answer."
        )
        assert result.outcome is not None and result.outcome.kind == "completed"
        assert any(
            result.name == "tide" and result.status == "completed" and "14:02" in result.text()
            for result in result.tool_results()
        )
        assert "14:02" in result.text
