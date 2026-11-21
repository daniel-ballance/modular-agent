import pytest

from modular_agent import AgentError, Plugin, create_agent, tool
from modular_agent.testing import memory_environment, over_wire, scripted_provider


@pytest.mark.parametrize("wire", [False, True])
async def test_auxiliary_model_requests_stay_under_command_step(wire):
    calls, changed, responses, contexts = [], [], [], []

    @tool
    async def ignored():
        """Not dispatched by the command."""
        calls.append(True)
        return "unexpected"

    request = {"systemPrompt": "Original", "messages": [], "tools": [], "settings": {}}

    async def summarize(args, cx):
        contexts.append(cx)
        for _ in range(2):
            response = await cx.request_model(request)
            assert response["content"][0]["name"] == "ignored"
        return args

    async def change(payload):
        changed.append(payload["request"]["systemPrompt"])
        return {"change": {**payload["request"], "systemPrompt": "Changed"}}

    async def observe(payload):
        responses.append(payload["message"]["stop"])

    def setup(r):
        r.command("summary", "Summarize", summarize, uses_model=True, in_process_only=True)
        r.on("provider.request", change)
        r.on("provider.response", observe)

    script = [{"toolCalls": [{"name": "ignored", "input": {}}], "usage": {"input": 4}}]
    provider = scripted_provider(script)
    plugins = [Plugin("summary", setup=setup)]
    if wire:
        plugins.append(over_wire(Plugin("models", setup=lambda r: r.provider(provider))))
    async with create_agent(
        plugins=plugins,
        providers=[] if wire else [provider],
        tools=[ignored],
        environment=memory_environment(),
    ) as agent:
        session = await agent.session()
        assert await session.run_command("/summary result") == "result"
        entries = await session.history()
        assert await session.last_turn() is None
    assert calls == []
    assert changed == ["Original", "Original"]
    assert responses == ["toolUse", "toolUse"]
    records = [e for e in entries if e["kind"] in {"modelRequest", "response"}]
    assert [e["kind"] for e in records] == ["modelRequest", "response"] * 2
    assert all(e["stepId"] == contexts[0].step_id and "turnId" not in e for e in records)
    for sent, received in zip(records[::2], records[1::2]):
        assert received["sources"] == [sent["id"]]
        assert received["message"]["usage"]["input"] == 4
    with pytest.raises(AgentError) as stale:
        await contexts[0].request_model(request)
    assert stale.value.code == "invalid_request"
