import asyncio
import json
import sqlite3

import acp
import pytest

from acp_fixture import Client, extension, prompt, running
from ma_acp import ACP
from ma_core import AgentError, Plugin
from ma_fake import reply
from ma_harness import Harness
from test_mcp import stdio


async def test_acp_gates_streams_replay_and_extension_returns(tmp_path, runtime_kind):
    (tmp_path / "store").mkdir()
    (tmp_path / "store/settings.json").write_text(
        json.dumps(
            {
                "plugins": [
                    {
                        "factory": "ma_guardrail:Guardrail",
                        "replaces": "guardrail",
                        "options": {"secrets": ["split-secret-732"]},
                    }
                ]
            }
        )
    )
    async with running(
        tmp_path, [reply("split-secret-732", pieces=["split-sec", "ret-732"])], runtime_kind
    ) as (conn, client, _):
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        result = await prompt(conn, sid)
        assert "split-secret-732" not in result.model_dump_json()
        assert "split-secret-732" not in json.dumps(
            [u.model_dump(mode="json") for _, u in client.updates]
        )
        assert "split-secret-732" not in json.dumps(await extension(conn, "follow", sid))
        await conn.close_session(session_id=sid)
        client.updates.clear()
        await conn.load_session(cwd=str(tmp_path), session_id=sid, mcp_servers=[])
        assert "split-secret-732" not in json.dumps(
            [u.model_dump(mode="json") for _, u in client.updates]
        )


async def test_acp_fork_move_erasure_are_host_operations(tmp_path, runtime_kind):
    async with running(tmp_path, [reply("derived private text")], runtime_kind) as (conn, _, _):
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        await prompt(conn, sid, "private input")
        entries = (await extension(conn, "follow", sid))["entries"]
        original = next(e["id"] for e in entries if e["kind"] == "input")
        fork = await extension(conn, "fork", sid)
        assert fork["id"] != sid
        assert any(
            e["kind"] == "input" for e in (await extension(conn, "follow", fork["id"]))["entries"]
        )
        await extension(conn, "erase", sid, entries=[original])
        for session in (sid, fork["id"]):
            state = await extension(conn, "follow", session)
            assert "private input" not in json.dumps(state)
            assert "derived private text" not in json.dumps(state)
        before = (await extension(conn, "follow", sid))["entries"]
        await extension(conn, "move", sid, point=None)
        after = (await extension(conn, "follow", sid))["entries"]
        assert len(after) == len(before) + 1 and after[-1]["kind"] == "position_move"


async def test_acp_eof_interrupts_question_then_load_replays_before_recovery(
    tmp_path, runtime_kind
):
    call = {"id": "question-call", "name": "ask_user", "input": {"question": "Recovery answer?"}}
    client = Client(answer=None)
    async with running(
        tmp_path, [reply("before interruption", calls=[call])], runtime_kind, client
    ) as (conn, _, _):
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        task = asyncio.create_task(prompt(conn, sid))
        async with asyncio.timeout(10):
            await client.question.wait()
    await asyncio.gather(task, return_exceptions=True)
    with sqlite3.connect(tmp_path / "store/history.sqlite3") as db:
        stopped = [json.loads(row[0]) for row in db.execute("SELECT record FROM entries")]
    assert not any(e["kind"] in {"question_answer", "model_error", "turn_end"} for e in stopped)
    async with running(tmp_path, [reply("after recovery")], runtime_kind) as (conn, client, _):
        await conn.load_session(session_id=sid, cwd=str(tmp_path), mcp_servers=[])
        if runtime_kind == "durable":
            await client.wait_event("turn_ended")
        text = [
            u.content.text for _, u in client.updates if u.session_update == "agent_message_chunk"
        ]
        assert text[0] == "before interruption"
        if runtime_kind == "durable":
            assert text[-1] == "after recovery" and len(client.elicitations) == 1
        else:
            assert not client.elicitations
        entries = (await extension(conn, "follow", sid))["entries"]
        results = [
            e for e in entries if e["kind"] == "tool_result" and e["call"] == "question-call"
        ]
        assert len(results) == 1


async def test_fork_narrows_authority_instead_of_restoring_owner_rights(agent):
    h, api, sid, _ = await agent()
    await api.session(
        "grant", session=sid, actor="user", subject="guest", authority=["watch", "input"]
    )
    child = await api.session("fork", session=sid, actor="guest")
    assert child["actor"] == "guest"
    assert set(child["authority"]) == {"watch", "input"}


async def test_failed_session_start_closes_already_attached_mcp(agent, tmp_path):
    h, api, sid, _ = await agent()
    mcp = h.plugins["mcp"]
    sessions = []

    async def fail(d):
        sessions.append(d["session"])
        raise AgentError("late start failure")

    h.api().on("session.start", fail, "last")
    with pytest.raises(AgentError, match="late start failure"):
        await api.session("create", project=str(tmp_path), mcp_servers=[stdio()])
    from plugin_state import keys

    assert sessions[0] not in await keys(mcp, "session_connections")
    assert sessions[0] not in h.sessions


async def test_acp_can_load_a_session_created_by_a_slash_command(tmp_path, runtime_kind):
    async with running(tmp_path, [reply("original")], runtime_kind) as (conn, _, _):
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        await prompt(conn, sid)
        fork = await extension(conn, "command", sid, text="/fork")
        await conn.load_session(session_id=fork["session"], cwd=str(tmp_path), mcp_servers=[])
        assert (await extension(conn, "follow", fork["session"]))["entries"]


async def test_command_actor_cannot_erase_or_change_settings_via_feature_plugin(agent):
    h, api, sid, _ = await agent()
    entry = await api.session(
        "append", session=sid, kind="input", content=[{"type": "text", "text": "keep"}]
    )
    await api.session(
        "grant", session=sid, actor="user", subject="guest", authority=["watch", "input"]
    )
    for text in ("/erase " + entry["id"], "/model fake", "/tree " + entry["id"]):
        with pytest.raises(AgentError, match="authority"):
            await api.session("command", session=sid, actor="guest", text=text)
    assert any(
        e["id"] == entry["id"] and e["kind"] == "input"
        for e in (await api.session("get", session=sid))["entries"]
    )


async def test_acp_gates_declaration_metadata_and_protocol_errors(tmp_path, runtime_type):
    from ma_fake import Fake
    from ma_cli import build

    class Canary(Plugin):
        name = "canary"
        declarations = {"message": "PRIVATE-CANARY-321"}

        async def start(self, api):
            await super().start(api)
            api.command("canary_error", "Test a gated error", self.bad)

        async def bad(self, d):
            raise AgentError("PRIVATE-CANARY-321")

    h = await build(
        tmp_path / "store",
        Fake(),
        secrets=["PRIVATE-CANARY-321"],
        runtime=runtime_type(),
        project=tmp_path,
    )
    await h.load(Canary())
    interface = ACP(tmp_path, {"model": "fake"})
    await h.load(interface)
    try:
        await interface.initialize(1)
        session = await interface.new_session(str(tmp_path), [])
        assert "PRIVATE-CANARY-321" not in session.model_dump_json()
        with pytest.raises(acp.RequestError) as caught:
            await interface.ext_method(
                "modular-agent/command", {"session": session.session_id, "text": "/canary_error"}
            )
        assert "PRIVATE-CANARY-321" not in str(caught.value)
        assert "REDACTED" in str(caught.value)
    finally:
        await h.stop()


async def test_acp_requires_initialization():
    h = Harness()
    plugin = ACP("/tmp")
    await h.load(plugin)
    try:
        with pytest.raises(acp.RequestError, match="Invalid request"):
            await plugin.new_session("/tmp", [])
    finally:
        await h.stop()
