import asyncio
import json
import os

import acp
import pytest
from acp import schema as s

from ma_core import content
from ma_fake import reply
from ma_mcp import tool_name
from acp_fixture import Client, extension, prompt, running
from test_mcp import stdio


async def test_acp_stdio_declaration_config_stream_key_and_lifecycle(tmp_path, runtime_kind):
    async with running(
        tmp_path, [reply("streamed hello", pieces=["streamed ", "hello"])], runtime_kind
    ) as (conn, client, init):
        assert init.protocol_version == 1 and init.agent_capabilities.load_session
        assert init.agent_capabilities.mcp_capabilities.http
        assert init.agent_capabilities.session_capabilities.resume is not None
        assert init.agent_capabilities.session_capabilities.close is not None
        session = await conn.new_session(cwd=str(tmp_path), mcp_servers=[])
        sid = session.session_id
        assert {o.id for o in session.config_options} >= {"model", "thinking"}
        result = await conn.set_config_option(session_id=sid, config_id="thinking", value="high")
        assert next(o.current_value for o in result.config_options if o.id == "thinking") == "high"
        declaration = await extension(conn, "declaration", sid)
        assert declaration["continuesAfterRestart"] == (runtime_kind == "durable")
        assert (
            declaration["plugins"]["claude"]["stateful"]
            if "claude" in declaration["plugins"]
            else not declaration["plugins"]["fake"]["stateful"]
        )
        result = await prompt(conn, sid, key="one")
        assert result.stop_reason == "end_turn"
        assert (
            "".join(
                u.content.text
                for _, u in client.updates
                if u.session_update == "agent_message_chunk"
            )
            == "streamed hello"
        )
        duplicate = await prompt(conn, sid, key="one")
        assert duplicate.field_meta["modular-agent"]["receipt"]["duplicate"]
        follow = await extension(conn, "follow", sid)
        assert len([e for e in follow["entries"] if e["kind"] == "input"]) == 1
        point = follow["entries"][-1]["id"]
        assert (await extension(conn, "follow", sid, after=point))["entries"] == []
        assert sid in {x.session_id for x in (await conn.list_sessions()).sessions}
        await conn.close_session(session_id=sid)
        with pytest.raises(acp.RequestError) as error:
            await conn.close_session(session_id=sid)
        assert error.value.data == {"code": "not_open"}
        client.updates.clear()
        await conn.resume_session(session_id=sid, cwd=str(tmp_path), mcp_servers=[])
        assert not [
            u
            for _, u in client.updates
            if u.session_update in {"user_message_chunk", "agent_message_chunk"}
        ]
        await conn.close_session(session_id=sid)
        await conn.load_session(session_id=sid, cwd=str(tmp_path), mcp_servers=[])
        assert any(u.session_update == "user_message_chunk" for _, u in client.updates)
        assert any(u.session_update == "agent_message_chunk" for _, u in client.updates)


async def test_acp_reopen_new_process_and_follow_from_point(tmp_path, runtime_kind):
    async with running(tmp_path, [reply("first answer")], runtime_kind) as (conn, _, _):
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        await prompt(conn, sid, key="first")
        entries = (await extension(conn, "follow", sid))["entries"]
        point = entries[-1]["id"]
    async with running(tmp_path, [reply("second answer")], runtime_kind) as (conn, client, _):
        await conn.load_session(session_id=sid, cwd=str(tmp_path), mcp_servers=[])
        assert any(
            u.session_update == "agent_message_chunk" and u.content.text == "first answer"
            for _, u in client.updates
        )
        await prompt(conn, sid, "continue", key="second")
        later = (await extension(conn, "follow", sid, after=point))["entries"]
        assert all(e["id"] not in {x["id"] for x in entries} for e in later)
        assert any(e["kind"] == "response" and "second answer" in str(e["content"]) for e in later)


@pytest.mark.parametrize(
    "permission,allowed",
    [("allow", True), ("refuse", False), ("cancelled", False), ("unoffered-option", False)],
)
async def test_acp_approvals_are_permission_requests(tmp_path, runtime_kind, permission, allowed):
    client = Client(permission=permission)
    call = {"id": "write-call", "name": "write", "input": {"path": "approved.txt", "text": "proof"}}
    async with running(tmp_path, [reply(calls=[call]), reply("done")], runtime_kind, client) as (
        conn,
        _,
        _,
    ):
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        await conn.set_config_option(session_id=sid, config_id="approval", value="all")
        assert (await prompt(conn, sid)).stop_reason == "end_turn"
        assert len(client.permissions) == 1
        assert {x.kind for x in client.permissions[0][2]} == {"allow_once", "reject_once"}
        assert (tmp_path / "approved.txt").exists() == allowed
        history = await conn.ext_method("modular-agent/history", {"sessionId": sid})
        answer = next(e["data"] for e in history["entries"] if e["kind"] == "inputAnswer")
        if allowed:
            assert answer["value"] == "allow"
        else:
            assert answer["declined"] is True and "value" not in answer
        entries = (await extension(conn, "follow", sid))["entries"]
        results = [e for e in entries if e["kind"] == "tool_result"]
        assert len(results) == 1
        assert results[0]["data"]["status"] == ("completed" if allowed else "refused")
        assert any(u.session_update == "tool_call" for _, u in client.updates)
        assert any(u.session_update == "tool_call_update" for _, u in client.updates)


@pytest.mark.parametrize("kind,answer", [("text", "host answer"), ("choice", "blue")])
async def test_acp_free_text_and_choice_are_elicitation(tmp_path, runtime_kind, kind, answer):
    call = {
        "id": "question-call",
        "name": "ask_user",
        "input": {
            "question": "Which colour?",
            "kind": kind,
            **({"options": ["blue", "red"]} if kind == "choice" else {}),
        },
    }
    client = Client(answer=answer)
    async with running(tmp_path, [reply(calls=[call]), reply("done")], runtime_kind, client) as (
        conn,
        _,
        _,
    ):
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        assert (await prompt(conn, sid)).stop_reason == "end_turn"
        assert len(client.elicitations) == 1
        entries = (await extension(conn, "follow", sid))["entries"]
        assert any(e["kind"] == "question_answer" and e["data"]["value"] == answer for e in entries)


@pytest.mark.parametrize("kind,forms", [("secret", True), ("text", False)])
async def test_acp_no_insecure_form_or_unsupported_elicitation_fallback(
    tmp_path, runtime_kind, kind, forms
):
    call = {
        "id": "question-call",
        "name": "ask_user",
        "input": {"question": "Input?", "kind": kind, "name": "service-login"},
    }
    async with running(
        tmp_path, [reply(calls=[call]), reply("done")], runtime_kind, forms=forms
    ) as (conn, client, _):
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        async with asyncio.timeout(10):
            task = asyncio.create_task(prompt(conn, sid))
            if kind == "text":
                requests = []
                while not requests:
                    requests = (
                        await conn.ext_method("modular-agent/requests", {"sessionId": sid})
                    )["requests"]
                    await asyncio.sleep(0.01)
                answer = await conn.ext_method(
                    "modular-agent/answer",
                    {
                        "sessionId": sid,
                        "requestId": requests[0]["id"],
                        "value": "host fallback",
                        "actor": "intruder",
                        "authority": ["everything"],
                    },
                )
                assert answer["accepted"]
            assert (await task).stop_reason == "end_turn"
        assert not client.elicitations
        entries = (await extension(conn, "follow", sid))["entries"]
        expected = "host fallback" if kind == "text" else "declined"
        assert any(
            e["kind"] == "question_answer"
            and e["data"]["value"] == expected
            and e["actor"] == "user"
            for e in entries
        )
        assert not (tmp_path / "store/credentials.json").exists()


async def test_acp_cancel_pending_permission_cannot_authorize_later(tmp_path, runtime_kind):
    client = Client(permission="wait")
    call = {"id": "write-call", "name": "write", "input": {"path": "never.txt", "text": "no"}}
    async with running(tmp_path, [reply(calls=[call])], runtime_kind, client) as (conn, _, _):
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        await conn.set_config_option(session_id=sid, config_id="approval", value="all")
        task = asyncio.create_task(prompt(conn, sid))
        async with asyncio.timeout(10):
            await client.question.wait()
            await conn.cancel(session_id=sid)
            assert (await task).stop_reason == "cancelled"
        client.release.set()
        assert not (tmp_path / "never.txt").exists()
        assert all(not q["answerable"] for q in await extension(conn, "questions", sid))


async def test_acp_session_mcp_isolation_and_private_connection_data(tmp_path, runtime_kind):
    spec = stdio()
    spec["env"] = [{"name": "OFFLINE_TEST_PRIVATE", "value": "not-in-history-9182"}]
    async with running(tmp_path, [reply("ready")], runtime_kind) as (conn, _, _):
        sid = (
            await conn.new_session(cwd=str(tmp_path), mcp_servers=[s.McpServerStdio(**spec)])
        ).session_id
        other = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        await prompt(conn, sid)
        await prompt(conn, other)
        tool = tool_name("local", "echo")
        result = await extension(conn, "tool", sid, name=tool, input={"text": "host tool"})
        assert result["status"] == "completed"
        pid = result["value"]["pid"]
        assert (await extension(conn, "tool", other, name=tool, input={"text": "no"}))[
            "status"
        ] == "failed"
        assert "not-in-history-9182" not in json.dumps(await extension(conn, "follow", sid))
        await conn.close_session(session_id=sid)
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)


async def test_acp_bad_requests_refuse_before_changes(tmp_path, runtime_kind):
    async with running(tmp_path, [], runtime_kind) as (conn, _, _):
        with pytest.raises(acp.RequestError):
            await conn.new_session(cwd=str(tmp_path / "other"), mcp_servers=[])
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        setup = (await extension(conn, "follow", sid))["entries"]
        with pytest.raises(acp.RequestError):
            await conn.set_config_option(session_id=sid, config_id="model", value="not-allowed")
        with pytest.raises(acp.RequestError):
            await extension(conn, "move", sid, point="unknown-point", rewind=True)
        with pytest.raises(acp.RequestError):
            await conn.ext_method("not-implemented", {})
        assert (await extension(conn, "follow", sid))["entries"] == setup


async def test_acp_async_submit_steering_withdraw_and_close(tmp_path, runtime_kind):
    async with running(tmp_path, [{"wait": True}], runtime_kind) as (conn, client, _):
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        task = asyncio.create_task(prompt(conn, sid))
        await client.wait_event("step_started")
        after = await extension(
            conn, "submit", sid, content=content("queued"), when="after", key="queued"
        )
        assert (await extension(conn, "withdraw", sid, input=after["input"]))["withdrawn"]
        steer = await extension(conn, "submit", sid, content=content("steer"), when="steer")
        assert steer["when"] == "steer"
        await conn.close_session(session_id=sid)
        assert (await task).stop_reason == "cancelled"
