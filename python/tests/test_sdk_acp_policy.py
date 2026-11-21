import json
import secrets

import pytest
from modular_agent import AgentError, ErrorCode, create_agent
from modular_agent.testing import scripted_provider
from websockets.asyncio.client import connect


async def test_malformed_stdio_scope_does_not_start(tmp_path):
    async with create_agent(project=tmp_path) as agent:
        for options in (
            {"projects": ["relative"]},
            {"tenants": [""]},
            {"rights": ["unknown"]},
            {"represents": [""]},
        ):
            with pytest.raises(AgentError) as rejected:
                await agent.serve_acp(**options)
            assert rejected.value.code is ErrorCode.INVALID_COMPOSITION


@pytest.mark.loopback
async def test_join_does_not_add_representation(tmp_path):
    token = tmp_path / "token"
    token.touch(mode=0o600)
    token.write_text(secrets.token_hex(32))
    root = tmp_path / "root"
    root.mkdir()
    (root / "nested").mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(root, target_is_directory=True)
    rights = ["watch", "input", "grant", "propose", "answer"]
    async with create_agent(
        project=root, several_actors=True, providers=[scripted_provider([{"text": "no tools"}])]
    ) as agent:
        listener = await agent.serve_acp(
            listen="127.0.0.1:0",
            actors=[
                {
                    "token_file": token,
                    "actor": {"id": "principal", "kind": "host", "rights": rights},
                    "projects": [alias],
                    "represents": ["represented"],
                }
            ],
        )
        async with connect(
            listener.url,
            subprotocols=["modular-agent-acp-1"],
            additional_headers={"Authorization": "Bearer " + token.read_text()},
        ) as client:
            counter = 0

            async def rpc(method, params):
                nonlocal counter
                counter += 1
                await client.send(
                    json.dumps(
                        {"jsonrpc": "2.0", "id": counter, "method": method, "params": params}
                    )
                )
                while (message := json.loads(await client.recv())).get("id") != counter:
                    pass
                return message

            await rpc("initialize", {"protocolVersion": 1})
            created = await rpc("session/new", {"cwd": str(alias), "mcpServers": []})
            scope = {"sessionId": created["result"]["sessionId"]}
            for name in ("represented", "unrepresented"):
                assert "result" in await rpc(
                    "_modular-agent/join",
                    {
                        **scope,
                        "actor": {"id": name, "kind": "user", "rights": rights},
                        "present": True,
                    },
                )
            actors = (await rpc("_modular-agent/actors", scope))["result"]
            assert set(actors["present"]) == {"principal", "represented"}
            args = {**scope, "when": "propose", "content": "proposed"}
            refused = await rpc("_modular-agent/input", {**args, "actorId": "unrepresented"})
            assert refused["error"]["data"]["code"] == "forbidden"
            accepted = await rpc("_modular-agent/input", {**args, "actorId": "represented"})
            assert accepted["result"]["inputId"]
            records = (await rpc("_modular-agent/history", {**scope, "all": True}))["result"][
                "entries"
            ]
            [admission] = [row for row in records if row["kind"] == "inputAccepted"]
            assert admission["actorId"] == "represented"
            assert admission["data"]["submittedBy"] == "principal"
