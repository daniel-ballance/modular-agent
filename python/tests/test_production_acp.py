"""Offline regressions at the ACP request boundary."""

import acp
import pytest
from acp_fixture import prompt, running
from ma_fake import reply


async def test_join_does_not_bind_connection_to_guest(tmp_path, runtime_kind):
    async with running(tmp_path, [reply("answer")], runtime_kind) as (conn, _, _):
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        base = {"sessionId": sid}
        await conn.ext_method(
            "modular-agent/join",
            {**base, "actor": {"id": "guest", "kind": "program", "rights": ["watch", "input"]}},
        )
        view = await conn.ext_method("modular-agent/actors", base)
        assert "guest" not in view["present"]
        with pytest.raises(acp.RequestError) as caught:
            await conn.ext_method(
                "modular-agent/input",
                {**base, "actorId": "guest", "content": "not mine", "when": "now"},
            )
        assert caught.value.data == {"code": "forbidden"}
        assert (await prompt(conn, sid)).stop_reason == "end_turn"


async def test_keyed_admission_and_operator_grants_across_connections(
    tmp_path, runtime_kind, monkeypatch
):
    async def submit(conn, sid):
        return await conn.ext_method(
            "modular-agent/input",
            {"sessionId": sid, "key": "shared-key", "content": "hello", "when": "propose"},
        )

    monkeypatch.setenv("MODULAR_AGENT_ACTOR", "writer")
    async with running(tmp_path, [], runtime_kind) as (conn, _, initialized):
        assert initialized.field_meta["modular-agent"]["actor"]["id"] == "writer"
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        original = await submit(conn, sid)
        await conn.ext_method(
            "modular-agent/erase", {"sessionId": sid, "entryIds": [original["inputId"]]}
        )

    monkeypatch.setenv("MODULAR_AGENT_ACTOR", "reopener")
    async with running(tmp_path, [], runtime_kind) as (conn, _, _):
        await conn.load_session(session_id=sid, cwd=str(tmp_path), mcp_servers=[])
        own = await submit(conn, sid)
        assert not own.get("duplicate")
        assert own["inputId"] != original["inputId"]
        assert await submit(conn, sid) == {**own, "duplicate": True}
        history = await conn.ext_method("modular-agent/history", {"sessionId": sid})
        grants = [e for e in history["entries"] if e["kind"] == "actorJoined"]
        assert [e["data"]["actor"]["id"] for e in grants] == ["writer", "reopener"]
        assert all(e["data"]["operatorAdmission"] is True and "actorId" not in e for e in grants)

    monkeypatch.setenv("MODULAR_AGENT_ACTOR", "writer")
    async with running(tmp_path, [], runtime_kind) as (conn, _, _):
        await conn.load_session(session_id=sid, cwd=str(tmp_path), mcp_servers=[])
        assert await submit(conn, sid) == {"duplicate": True, "erased": True}


async def test_history_limit_uses_last_entry_cursor(tmp_path, runtime_kind):
    async with running(tmp_path, [reply("answer")], runtime_kind) as (conn, _, _):
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        await prompt(conn, sid)
        base = {"sessionId": sid, "limit": 1}
        one = await conn.ext_method("modular-agent/history", base)
        assert len(one["entries"]) == 1
        assert one["nextEntryId"] == one["entries"][0]["id"]
        two = await conn.ext_method("modular-agent/history", {**base, "after": one["nextEntryId"]})
        assert len(two["entries"]) == 1
        assert two["entries"][0]["id"] != one["nextEntryId"]
