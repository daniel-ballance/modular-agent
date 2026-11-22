"""The Claude Provider speaks the Python Agent SDK's message types."""

from claude_agent_sdk import AssistantMessage, ResultMessage, StreamEvent, TextBlock, ToolUseBlock
from modular_agent import ModelRef, ProviderContext
from modular_agent.claude import claude
from modular_agent.fixtures import tide
import pytest

from test_sdk_subscription import mounted


class ClaudeFixture:
    def __init__(self, account=None, *, callers=()):
        self.account = (
            account if account is not None else {"subscriptionType": "max", "apiKeySource": "none"}
        )
        self.options = []
        self.prompts = []
        self.callers = iter(callers)
        self.closed = 0

    def __call__(self, *, options):
        self.options.append(options)
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        self.closed += 1

    async def get_server_info(self):
        return {
            "account": self.account,
            "models": [
                {
                    "value": "sonnet",
                    "resolvedModel": "claude-sonnet-5-5",
                    "displayName": "Test Sonnet",
                }
            ],
        }

    async def query(self, prompt):
        self.prompts.append([message async for message in prompt])

    async def receive_messages(self):
        for message in next(self.callers):
            yield message


async def test_claude_declines_metered_account():
    fixture = ClaudeFixture({"subscriptionType": "max", "apiKeySource": "user"})
    provider = claude(client_factory=fixture)
    assert not await provider.available()
    assert "API key from user" in provider.unavailable_reason
    assert fixture.prompts == []
    assert fixture.closed == 1


@pytest.mark.parametrize(
    ("model", "asked", "thinking", "effort"),
    [
        ("claude-sonnet-5-5", None, None, None),
        ("claude-sonnet-5-5", "off", None, None),
        ("claude-sonnet-5-5", "xhigh", {"type": "adaptive", "display": "summarized"}, "xhigh"),
        (
            "claude-opus-4-5",
            "high",
            {"type": "enabled", "budget_tokens": 1999, "display": "summarized"},
            None,
        ),
        ("claude-opus-4-7", "off", {"type": "disabled"}, None),
    ],
)
async def test_claude_maps_reasoning_and_stops_for_host_tool(model, asked, thinking, effort):
    fixture = ClaudeFixture(
        callers=[
            [AssistantMessage([ToolUseBlock("c1", "mcp__agent__tide", {"port": "Whitby"})], model)]
        ]
    )
    provider = claude(client_factory=fixture)

    async def emit(piece):
        pytest.fail(f"Unexpected piece: {piece}")

    settings = {"maxOutput": 2000}
    if asked is not None:
        settings["reasoning"] = asked
    response = await provider.request(
        ModelRef("claude", model),
        {
            "systemPrompt": "Only use the host's tools.",
            "messages": [
                {
                    "role": "user",
                    "content": [{"type": "image", "mimeType": "image/png", "data": "AAAA"}],
                }
            ],
            "settings": settings,
            "tools": [
                {"name": "tide", "description": "Read tides", "parameters": {"type": "object"}}
            ],
        },
        ProviderContext("session", None, emit, lambda: None),
    )
    [options] = fixture.options
    assert options.system_prompt == "Only use the host's tools."
    assert options.tools == options.setting_sources == options.skills == options.plugins == []
    assert options.strict_mcp_config and options.extra_args["no-session-persistence"] is None
    assert options.allowed_tools == ["mcp__agent__tide"]
    assert options.thinking == thinking
    assert options.effort == effort
    assert fixture.prompts[0][0]["message"]["content"] == [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}}
    ]
    assert response["stop"] == "toolUse"
    assert response["content"] == [
        {"type": "toolCall", "id": "c1", "name": "tide", "arguments": {"port": "Whitby"}}
    ]
    assert fixture.closed == 1


async def test_claude_uses_reported_catalog_and_passes_stream_pieces():
    model = "claude-sonnet-5-5"

    def event(**data):
        return StreamEvent("e", "s", data)

    fixture = ClaudeFixture(
        callers=[
            [
                event(
                    type="content_block_start",
                    index=0,
                    content_block={"type": "thinking", "thinking": ""},
                ),
                event(
                    type="content_block_delta",
                    index=0,
                    delta={"type": "thinking_delta", "thinking": "Plan"},
                ),
                event(
                    type="content_block_start", index=1, content_block={"type": "text", "text": ""}
                ),
                event(
                    type="content_block_delta",
                    index=1,
                    delta={"type": "text_delta", "text": "Done"},
                ),
                ResultMessage("success", 5, 5, False, 1, "s", usage={"output_tokens": 4}),
            ]
        ]
    )
    provider = claude(client_factory=fixture)
    assert len(provider.models()) > 1
    assert await provider.available()
    assert [m["id"] for m in provider.models()] == [model]
    received = []

    async def emit(piece):
        received.append(piece["event"])

    response = await provider.request(
        ModelRef("claude", model), {}, ProviderContext("s", None, emit, lambda: None)
    )
    assert received == [{"type": "reasoning", "delta": "Plan"}, {"type": "text", "delta": "Done"}]
    assert response["content"] == [
        {"type": "reasoning", "text": "Plan"},
        {"type": "text", "text": "Done"},
    ]
    assert response["usage"] == {"output": 4}
    assert fixture.closed == 2


@pytest.mark.loopback
@pytest.mark.parametrize("served", [False, True], ids=["embedded", "served"])
async def test_claude_host_runs_the_tool_and_replays_result(tmp_path, runtime_kind, served):
    model = "claude-sonnet-5-5"
    fixture = ClaudeFixture(
        callers=[
            [
                AssistantMessage(
                    [ToolUseBlock("c1", "mcp__agent__tide", {"harbour": "Whitby"})], model
                )
            ],
            [
                AssistantMessage([TextBlock("Done")], model),
                ResultMessage("success", 5, 5, False, 1, "s"),
            ],
        ]
    )
    provider = claude(client_factory=fixture)
    async with mounted(
        tmp_path, provider, served, "claude/" + model, runtime_kind, tools=[tide]
    ) as agent:
        session = await agent.session(settings={"reasoning": "high"})
        result = await session.prompt("Tell me about the tide.")
    assert result.text == "Done"
    [call] = result.tool_results()
    assert call.status == "completed"
    assert "14:02" in call.text()
    assert "14:02" in str(fixture.prompts[1])
    assert fixture.options[-1].effort == "high"
    assert fixture.closed == 3


async def test_claude_waits_for_the_complete_streamed_tool_list():
    model = "claude-sonnet-5-5"
    messages = []
    for i, name in enumerate(("first", "second")):
        tool = f"mcp__agent__{name}"
        messages.extend(
            [
                StreamEvent(
                    "e",
                    "s",
                    {
                        "type": "content_block_start",
                        "index": i,
                        "content_block": {"type": "tool_use", "id": name, "name": tool},
                    },
                ),
                StreamEvent(
                    "e",
                    "s",
                    {
                        "type": "content_block_delta",
                        "index": i,
                        "delta": {"type": "input_json_delta", "partial_json": '{"n": 1}'},
                    },
                ),
                AssistantMessage([ToolUseBlock(name, tool, {"n": 1})], model),
                StreamEvent("e", "s", {"type": "content_block_stop", "index": i}),
            ]
        )
    messages.append(
        StreamEvent("e", "s", {"type": "message_delta", "delta": {"stop_reason": "tool_use"}})
    )
    fixture = ClaudeFixture(callers=[messages])
    provider = claude(client_factory=fixture)

    async def emit(piece):
        pytest.fail(f"Unexpected piece {piece}")

    response = await provider.request(
        ModelRef("claude", model),
        {
            "tools": [
                {"name": name, "parameters": {"type": "object"}} for name in ("first", "second")
            ],
        },
        ProviderContext("s", None, emit, lambda: None),
    )
    assert response["stop"] == "toolUse"
    assert [part["name"] for part in response["content"]] == ["first", "second"]
    assert all(part["arguments"] == {"n": 1} for part in response["content"])
