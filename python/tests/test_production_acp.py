"""Offline regressions at the ACP request boundary."""

import acp
import pytest
from acp_fixture import prompt, running
from ma_fake import reply
from modular_agent import HistoryError, serve_history, sqlite_history_port


@pytest.mark.loopback
@pytest.mark.parametrize("code, details", [("held", {"retryAfterMs": 60_000}), ("lost", {})])
async def test_reopen_reports_lease_refusal_without_attaching(
    tmp_path, runtime_kind, monkeypatch, code, details
):
    class RefusingStore:
        refuse = False

        def __getattr__(self, name):
            return getattr(backend, name)

        async def acquire(self, session_id, owner):
            if self.refuse:
                raise HistoryError(code, "Fixture lease refusal", details)
            return await backend.acquire(session_id, owner)

    token = tmp_path / "history-token"
    token.write_text("test-history-token-with-32-characters")
    with sqlite_history_port(tmp_path / "history", ttl_ms=10_000) as backend:
        history = RefusingStore()
        server = serve_history(history, address=("127.0.0.1", 0), token_file=token)
        assert server is not None
        monkeypatch.setenv("MODULAR_AGENT_HISTORY_URL", server.url)
        monkeypatch.setenv("MODULAR_AGENT_HISTORY_TOKEN_FILE", str(token))
        try:
            async with running(tmp_path, [reply("answer")], runtime_kind) as (conn, _, _):
                sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
                assert (await prompt(conn, sid)).stop_reason == "end_turn"

            history.refuse = True
            async with running(tmp_path, [], runtime_kind) as (conn, client, _):
                with pytest.raises(acp.RequestError) as caught:
                    await conn.load_session(session_id=sid, cwd=str(tmp_path), mcp_servers=[])
                assert caught.value.code == -32000
                assert caught.value.data == {"code": code, **details}
                assert not client.updates
                with pytest.raises(acp.RequestError) as absent:
                    await prompt(conn, sid)
                assert absent.value.data == {"code": "not_open"}
        finally:
            server.close()


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
