import json
import secrets

import pytest
from modular_agent import AgentError, ErrorCode, ToolContext, create_agent, tool
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
    rights = ["watch", "input", "grant", "propose", "answer", "tools"]

    @tool(read_only=True)
    async def ask_member(cx: ToolContext) -> str:
        """Ask the represented member for a value."""
        answer = await cx.ask(
            {"kind": "text", "question": "Member only?", "answerers": ["represented"]}
        )
        return str(answer.value)

    script = [{"toolCalls": [{"name": "ask_member", "input": {}}]}, {"text": "answered"}]
    async with create_agent(
        project=root, several_actors=True, providers=[scripted_provider(script)], tools=[ask_member]
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
                while True:
                    message = json.loads(await client.recv())
                    if message.get("method") == "elicitation/create":
                        assert message["params"]["message"] == "Member only?"
                        await client.send(
                            json.dumps(
                                {
                                    "jsonrpc": "2.0",
                                    "id": message["id"],
                                    "result": {
                                        "action": "accept",
                                        "content": {"answer": "declined"},
                                    },
                                }
                            )
                        )
                    elif message.get("id") == counter:
                        return message

            await rpc(
                "initialize",
                {"protocolVersion": 1, "clientCapabilities": {"elicitation": {"form": {}}}},
            )
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
            result = await rpc(
                "session/prompt", {**scope, "prompt": [{"type": "text", "text": "Ask"}]}
            )
            assert result["result"]["stopReason"] == "end_turn"
            records = (await rpc("_modular-agent/history", {**scope, "all": True}))["result"][
                "entries"
            ]
            [answer] = [row["data"] for row in records if row["kind"] == "inputAnswer"]
            assert answer["actorId"] == "represented"
            assert answer["actingFor"] == "principal"
            assert answer["value"] == "declined"
