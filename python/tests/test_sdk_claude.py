"""The Claude Provider speaks the Python Agent SDK's message types."""

from claude_agent_sdk import AssistantMessage, ResultMessage, StreamEvent, ToolUseBlock
from modular_agent import ModelRef, ProviderContext
from modular_agent.claude import claude
import pytest


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
