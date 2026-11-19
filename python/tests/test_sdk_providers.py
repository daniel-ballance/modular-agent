import asyncio
import json

import pytest

from modular_agent import create_agent
from modular_agent.anthropic import anthropic
from modular_agent.openai import openai


OPENAI = [
    {"type": "response.output_text.delta", "delta": "Hello."},
    {
        "type": "response.completed",
        "response": {
            "status": "completed",
            "output": [{"type": "message", "content": [{"type": "output_text", "text": "Hello."}]}],
            "usage": {"input_tokens": 4, "output_tokens": 1},
        },
    },
]
ANTHROPIC = [
    {"type": "message_start", "message": {"usage": {"input_tokens": 4}}},
    {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
    {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello."}},
    {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 1}},
    {"type": "message_stop"},
]


@pytest.mark.loopback
@pytest.mark.parametrize("provider,events", [(openai, OPENAI), (anthropic, ANTHROPIC)])
@pytest.mark.parametrize("status", [200, 401])
async def test_loopback_provider(provider, events, status, monkeypatch):
    received = []
    monkeypatch.setenv("OPENAI_API_KEY", "loopback-placeholder")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "loopback-placeholder")

    async def respond(reader, writer):
        raw = (await reader.readuntil(b"\r\n\r\n")).decode("ascii")
        headers = {
            k.lower(): v.strip()
            for k, v in (line.split(":", 1) for line in raw.splitlines()[1:] if line)
        }
        data = json.loads(await reader.readexactly(int(headers["content-length"])))
        received.append((raw.splitlines()[0], headers, data))
        payload = "".join(f"data: {json.dumps(event)}\n\n" for event in events).encode()
        writer.write(
            f"HTTP/1.1 {status} Reply\r\nContent-Length: {len(payload)}\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n".encode()
            + payload
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    async with await asyncio.start_server(respond, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        async with create_agent(
            providers=[provider(base_url=f"http://127.0.0.1:{port}/v1")]
        ) as agent:
            session = await agent.session()
            stream = [e async for e in session.prompt_stream("Say hello")]
            result = await session.last_turn()
            assert stream[-1].type == "turnEnded"
            if status == 200:
                assert result.outcome.kind == "completed", result.outcome
                assert [e.data.delta for e in stream if e.type == "text"] == ["Hello."]
                assert result.text == "Hello."
                assert result.usage["input"] == 4
            else:
                assert result.outcome.kind == "failed"
                entries = await session.history()
                response = next(e["message"] for e in entries if e["kind"] == "response")
                assert response["error"]["kind"] == "credentials"
                assert response["stop"] == "failed"
    [(line, headers, body)] = received
    assert line.startswith("POST /v1/" + ("responses" if provider is openai else "messages"))
    assert body["stream"] is True
    assert "Say hello" in json.dumps(body)
    if provider is openai:
        assert headers["authorization"] == "Bearer loopback-placeholder"
        assert body["store"] is False
    else:
        assert headers["x-api-key"] == "loopback-placeholder"
