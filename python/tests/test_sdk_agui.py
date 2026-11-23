"""A real HTTP client talking to the public Python SDK."""

from pathlib import Path
from secrets import token_urlsafe

import pytest
from aiohttp import ClientSession

from modular_agent import create_agent
from modular_agent.testing import scripted_provider


pytestmark = pytest.mark.loopback


async def test_authenticated_run_and_reconnect(tmp_path: Path):
    token = token_urlsafe()
    path = tmp_path / "disposable.token"
    path.touch(mode=0o600)
    path.write_text(token)
    async with create_agent(
        project=tmp_path, providers=[scripted_provider([{"text": "Hello."}])]
    ) as agent:
        listener = await agent.serve_agui(
            listen="127.0.0.1:0",
            actors=[
                {
                    "actor": {"id": "alice", "kind": "user", "rights": ["input", "watch"]},
                    "client_id": "browser",
                    "token_file": path,
                }
            ],
        )
        async with ClientSession(headers={"Authorization": f"Bearer {token}"}) as client:
            base = listener.url + "/agui/v1"
            async with client.post(base + "/threads", json={}) as response:
                assert response.status == 201
                thread = (await response.json())["threadId"]
            async with client.post(
                base + "/run",
                json={
                    "runId": "one",
                    "protocolVersion": "1.0",
                    "threadId": thread,
                    "messages": [{"role": "user", "id": "tmp", "content": "Hi."}],
                },
            ) as response:
                assert response.status == 200
                assert '"RUN_FINISHED"' in await response.text()
            async with client.get(base + "/threads/" + thread) as response:
                assert [m["content"] for m in (await response.json())["messages"]] == [
                    "Hi.",
                    "Hello.",
                ]
        await listener.close()
