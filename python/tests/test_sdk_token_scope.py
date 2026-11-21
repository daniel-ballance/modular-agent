import json
import secrets

import pytest
from modular_agent import create_agent
from modular_agent.testing import scripted_provider
from websockets.asyncio.client import connect


@pytest.mark.loopback
async def test_token_is_a_ceiling_without_changing_recorded_grants(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    (root / "child").mkdir()
    actor = {"id": "writer", "kind": "user", "rights": ["watch", "input"]}
    read_user = {**actor, "rights": ["watch"]}
    values = [secrets.token_hex(32) for _ in range(3)]
    paths = [tmp_path / f"token-{i}" for i in range(len(values))]
    for path, value in zip(paths, values):
        path.touch(mode=0o600)
        path.write_text(value)

    async def rpc(ws, method, params, key=1):
        await ws.send(json.dumps({"jsonrpc": "2.0", "id": key, "method": method, "params": params}))
        while (frame := json.loads(await ws.recv())).get("id") != key:
            pass
        return frame

    async with create_agent(
        project=root, providers=[scripted_provider([{"text": "saved"}, {"text": "done"}])]
    ) as agent:
        listener = await agent.serve_acp(
            listen="127.0.0.1:0",
            actors=[
                {"token_file": paths[0], "actor": actor},
                {"token_file": paths[1], "actor": read_user, "tenants": [None], "projects": [root]},
                {"token_file": paths[2], "actor": actor, "tenants": [], "projects": []},
            ],
        )

        def client(i):
            return connect(
                listener.url,
                subprotocols=["modular-agent-acp-1"],
                additional_headers={
                    "Authorization": f"Bearer {values[i]}",
                },
            )

        params = {"cwd": str(root), "mcpServers": []}
        async with client(0) as writer, client(1) as reader, client(2) as none:
            assert (await rpc(writer, "$/ping", {}))["result"] == {}
            for ws in (writer, reader, none):
                await rpc(ws, "initialize", {"protocolVersion": 1}, 2)
            assert (await rpc(none, "session/new", params, 3))["error"]["data"][
                "code"
            ] == "forbidden"
            sid = (await rpc(writer, "session/new", params, 4))["result"]["sessionId"]
            prompt = {"sessionId": sid, "prompt": [{"type": "text", "text": "Say hello."}]}
            assert (await rpc(writer, "session/prompt", prompt, 5))["result"][
                "stopReason"
            ] == "end_turn"
            assert "error" in await rpc(
                reader,
                "session/resume",
                {**params, "cwd": str(root / "child"), "sessionId": sid},
                3,
            )
            assert "result" in await rpc(reader, "session/resume", {**params, "sessionId": sid}, 4)
            assert (await rpc(reader, "session/prompt", prompt, 5))["error"]["data"][
                "code"
            ] == "forbidden"
            assert (await rpc(writer, "session/prompt", prompt, 6))["result"][
                "stopReason"
            ] == "end_turn"
