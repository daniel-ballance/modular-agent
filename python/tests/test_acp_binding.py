"""Shared host binding regression tests, alongside the unchanged JavaScript kit."""

import asyncio
import json
import sqlite3
import sys
import time
from contextlib import contextmanager
from pathlib import Path

import acp
import pytest

from acp_fixture import Client, prompt, running
from ma_acp import ACP
from ma_core import Plugin, content
from ma_fake import Fake, reply
from ma_history import History, pending
from ma_cli import build

ROOT = Path(__file__).resolve().parents[1]


async def bound(conn, operation, sid, **params):
    return await conn.ext_method("modular-agent/" + operation, {"sessionId": sid, **params})


async def test_shared_acp_conformance_kit(runtime_kind, request):
    kit = ROOT / "conformance/acp"
    assert (kit / "node_modules/@agentclientprotocol/sdk").is_dir(), (
        "Install the official kit client first: cd conformance/acp && npm ci"
    )
    placement = "all" if request.config.getoption("--binding") == "process" else ""
    proc = await asyncio.create_subprocess_exec(
        "node",
        str(kit / "run.mjs"),
        "--verbose",
        "--",
        sys.executable,
        "-m",
        "modular_agent",
        "--mode",
        "acp",
        "--runtime",
        runtime_kind,
        "--process-plugins",
        placement,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        async with asyncio.timeout(120):
            output, _ = await proc.communicate()
        assert proc.returncode == 0, output.decode()
        assert "checks passed" in output.decode()
    finally:
        if proc.returncode is None:
            # Close transport first so the agent suspends and reaps its plugins.
            proc.terminate()
            await proc.wait()


@pytest.fixture
def memory_history(tmp_path, monkeypatch):
    # Test turn synchronization without waiting for disk sync on each record.
    state = tmp_path / "state"
    state.mkdir()
    (state / "history.sqlite3").touch()
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT, meta TEXT)")
    db.execute("CREATE TABLE entries (id TEXT PRIMARY KEY, session TEXT, record TEXT)")
    pending.schema(db)

    @contextmanager
    def connect(_):
        with db:
            yield db

    monkeypatch.setattr(History, "_connect", connect)
    try:
        yield
    finally:
        db.close()


async def test_prompt_does_not_return_before_its_turn_releases_busy(
    tmp_path, runtime_type, memory_history
):
    recorded, release, waiting = asyncio.Event(), asyncio.Event(), asyncio.Event()

    class PausedRuntime(runtime_type):
        async def submit(self, d, emit):
            receipt = await super().submit(d, emit)
            await recorded.wait()
            return receipt

        async def wait(self, d, emit):
            waiting.set()
            return await super().wait(d, emit)

    class Pause(Plugin):
        name = "pause-turn-end"

        async def start(self, api):
            await super().start(api)
            api.on("turn.end", self.end)

        async def end(self, _):
            recorded.set()
            await release.wait()

    h = await build(
        tmp_path / "state",
        Fake([reply("done")]),
        runtime=PausedRuntime(),
        project=tmp_path,
        process_plugins=[],
    )
    interface = ACP(tmp_path, {"model": "fake"})
    try:
        await h.load(Pause(), process=False)
        await h.load(interface, process=False)
        await interface.initialize(1)
        sid = (await interface.new_session(str(tmp_path), [])).session_id
        async with asyncio.timeout(30):
            first = asyncio.create_task(
                interface.prompt(sid, [acp.schema.TextContentBlock(text="first")])
            )
            pending = asyncio.create_task(waiting.wait())
            try:
                await asyncio.wait({first, pending}, return_when=asyncio.FIRST_COMPLETED)
                if first.done():
                    # Reproduce the settings refusal before releasing turn.end.
                    await interface.set_config_option("approval", sid, "off")
                    pytest.fail("Prompt replied while turn.end was still running")
            finally:
                release.set()
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
            assert (await first).stop_reason == "end_turn"
            await interface.set_config_option("approval", sid, "off")
    finally:
        release.set()
        await h.stop()


async def test_prompt_waits_for_its_own_turn_not_the_job_report(
    tmp_path, runtime_type, memory_history
):
    first_started, second_started = asyncio.Event(), asyncio.Event()
    release_first, release_second = asyncio.Event(), asyncio.Event()

    class Pause(Plugin):
        name = "pause-turn-start"
        seen = 0

        async def start(self, api):
            await super().start(api)
            api.on("turn.start", self.turn)

        async def turn(self, _):
            self.seen += 1
            if self.seen == 1:
                first_started.set()
                await release_first.wait()
            else:
                second_started.set()
                await release_second.wait()

    h = await build(
        tmp_path / "state",
        Fake([reply("first answer"), reply("second answer")]),
        runtime=runtime_type(),
        project=tmp_path,
        process_plugins=[],
    )
    interface = ACP(tmp_path, {"model": "fake"})
    first = None
    try:
        await h.load(Pause(), process=False)
        await h.load(interface, process=False)
        await interface.initialize(1)
        sid = (await interface.new_session(str(tmp_path), [])).session_id
        async with asyncio.timeout(30):
            first = asyncio.create_task(
                interface.prompt(sid, [acp.schema.TextContentBlock(text="first")])
            )
            await first_started.wait()
            job = await h.api().call("jobs", "create", {"session": sid, "kind": "fixture"})
            await h.api().call(
                "jobs", "report", {"session": sid, "job": job["id"], "result": content("report")}
            )
            release_first.set()
            await second_started.wait()
            result = await first
            assert result.stop_reason == "end_turn"
            assert result.field_meta["modular-agent"]["result"]["content"] == content(
                "first answer"
            )
            assert (await h.api().session("get", session=sid))["busy"]
    finally:
        release_first.set()
        release_second.set()
        if first is not None:
            await asyncio.gather(first, return_exceptions=True)
        await h.stop()


async def test_cancel_bash_during_process_bootstrap(tmp_path, runtime_kind, monkeypatch):
    monkeypatch.setenv("MA_PLUGIN_PROCESSES", "all")
    monkeypatch.setenv("MODULAR_AGENT_CONFORMANCE", "1")
    async with running(tmp_path, [], runtime_kind) as (conn, client, _):
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        await conn.set_config_option(session_id=sid, config_id="model", value="conformance/echo")
        await prompt(conn, sid, 'tool:bash {"command":"echo yes > earlier.txt"}')
        task = asyncio.create_task(prompt(conn, sid, 'tool:bash {"command":"sleep 30"}'))
        async with asyncio.timeout(10):
            while not any(
                u.session_update == "tool_call" and "sleep 30" in str(u.raw_input)
                for _, u in client.updates
            ):
                await asyncio.sleep(0.05)
            started = time.monotonic()
            await conn.cancel(session_id=sid)
            assert (await task).stop_reason == "cancelled"
            assert time.monotonic() - started < 5


@pytest.mark.parametrize(
    "script,settings,stop,kind,detail",
    [
        ([{"error": "offline failure"}], {}, "refusal", "failed", "offline failure"),
        ([reply("truncated", stop="output_limit")], {}, "max_tokens", "limit", "output"),
        ([], {"max_steps": 0}, "max_turn_requests", "limit", "steps"),
        ([], {"max_tokens": 0}, "max_tokens", "limit", "sessionTokens"),
    ],
)
async def test_bound_outcomes(tmp_path, runtime_kind, script, settings, stop, kind, detail):
    (tmp_path / "store").mkdir()
    (tmp_path / "store/settings.json").write_text(json.dumps(settings))
    async with running(tmp_path, script, runtime_kind) as (conn, _, _):
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        result = await prompt(conn, sid, key="outcome")
        assert result.stop_reason == stop
        metadata = result.field_meta["modular-agent"]
        assert metadata["outcome"] == {
            "kind": kind,
            "limit" if kind == "limit" else "error": detail,
        }
        entries = (await bound(conn, "history", sid))["entries"]
        assert entries[-1]["data"]["outcome"] == metadata["outcome"]
        assert all(isinstance(e["time"], int) for e in entries)
        assert all(
            e.get("actorId") == "user"
            for e in entries
            if e["kind"] not in {"plugins", "actorJoined"}
        )
        setup = next(e for e in entries if e["kind"] == "actorJoined")
        assert setup["data"]["operatorAdmission"] is True and "actorId" not in setup
        assert next(e for e in entries if e["kind"] == "input")["message"]["role"] == "user"


async def test_bound_cancel_returns_queued_input_and_preserves_original_outcome(
    tmp_path, runtime_kind
):
    async with running(tmp_path, [{"wait": True}, reply("later")], runtime_kind) as (
        conn,
        client,
        _,
    ):
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        task = asyncio.create_task(prompt(conn, sid, key="original"))
        await client.wait_event("step_started")
        with pytest.raises(acp.RequestError):
            await conn.set_config_option(session_id=sid, config_id="thinking", value="high")
        queued = await bound(conn, "input", sid, content="queued", when="after", key="after")
        steer = await bound(conn, "input", sid, content=content("steer"), when="steer", key="steer")
        assert queued["taken"] == "after" and steer["taken"] == "inTurn"
        await conn.cancel(session_id=sid)
        result = await task
        meta = result.field_meta["modular-agent"]
        assert meta["outcome"]["kind"] == "cancelled"
        assert meta["handedBack"] == [
            {"inputId": queued["inputId"], "content": content("queued")},
            {"inputId": steer["inputId"], "content": content("steer")},
        ]
        await prompt(conn, sid, "later")
        duplicate = await prompt(conn, sid, key="original")
        assert duplicate.stop_reason == "cancelled"
        assert duplicate.field_meta["modular-agent"] == {
            **meta,
            "duplicate": True,
            "receipt": {**meta["receipt"], "duplicate": True},
        }


async def test_bound_optional_operations_and_branch_history(tmp_path, runtime_kind):
    async with running(tmp_path, [reply("private response")], runtime_kind) as (conn, _, _):
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        await prompt(conn, sid, "private input")
        entries = (await bound(conn, "history", sid))["entries"]
        original = next(e["id"] for e in entries if e["kind"] == "input")
        child = (await bound(conn, "fork", sid, entryId=entries[-1]["id"]))["sessionId"]
        assert child != sid
        with pytest.raises(acp.RequestError):
            await bound(conn, "history", child)
        await conn.load_session(session_id=child, cwd=str(tmp_path), mcp_servers=[])
        assert (await bound(conn, "history", child))["entries"]
        assert await bound(conn, "jobs", sid) == {"jobs": []}
        with pytest.raises(acp.RequestError) as refused:
            await bound(conn, "move", sid, entryId=original)
        assert refused.value.data == {"code": "conflict"}
        quiescent = next(e["id"] for e in entries if e["kind"] == "plugins")
        assert await bound(conn, "move", sid, entryId=quiescent) == {}
        branch = (await bound(conn, "history", sid))["entries"]
        assert not any(e["kind"] == "response" for e in branch)
        all_entries = (await bound(conn, "history", sid, all=True))["entries"]
        assert any(e["kind"] == "response" for e in all_entries)
        with pytest.raises(acp.RequestError) as caught:
            await bound(conn, "history", sid, after=entries[-1]["id"])
        assert caught.value.code == -32602
        assert (await bound(conn, "history", sid, all=True, after=entries[-1]["id"]))["entries"]
        erased = await bound(conn, "erase", sid, entryIds=[original])
        assert {"sessionId": sid, "id": original} in erased["erased"]
        assert erased["pending"] == [] and erased["outOfReach"]
        for session in (sid, child):
            assert "private input" not in json.dumps(
                await bound(conn, "history", session, all=True)
            )
            assert "private response" not in json.dumps(
                await bound(conn, "history", session, all=True)
            )


async def test_bound_parked_question_uses_extensions_and_pending_update(tmp_path, runtime_kind):
    call = {"id": "parked", "name": "ask_user", "input": {"question": "Later?", "timeout": 0}}
    async with running(
        tmp_path, [reply(calls=[call]), reply("resumed")], runtime_kind, forms=False
    ) as (conn, client, _):
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        result = await prompt(conn, sid)
        assert result.stop_reason == "end_turn"
        assert result.field_meta["modular-agent"]["openToolCalls"] == ["parked"]
        updates = [u for _, u in client.updates if u.session_update == "tool_call_update"]
        assert updates[-1].status == "pending"
        q = (await bound(conn, "requests", sid))["requests"][0]
        assert q["kind"] == "text" and q["answerable"] and q["toolCallId"] == "parked"
        point = (await bound(conn, "history", sid))["entries"][-1]["id"]
        for operation in ("fork", "move"):
            with pytest.raises(acp.RequestError):
                await bound(conn, operation, sid, entryId=point)
        assert (await bound(conn, "answer", sid, requestId=q["id"], value="from host"))["accepted"]
        async with asyncio.timeout(10):
            while not any(
                e["kind"] == "response" and "resumed" in str(e.get("message"))
                for e in (await bound(conn, "history", sid))["entries"]
            ):
                await asyncio.sleep(0.01)
        assert await bound(conn, "requests", sid) == {"requests": []}
        assert not (await bound(conn, "answer", sid, requestId=q["id"], value="again"))["accepted"]


async def test_conformance_echo_is_literal_zero_usage_and_data_dir_isolated(
    tmp_path, runtime_kind, monkeypatch
):
    monkeypatch.setenv("MODULAR_AGENT_CONFORMANCE", "1")
    monkeypatch.setenv("MODULAR_AGENT_DATA_DIR", str(tmp_path / "isolated"))
    (tmp_path / "unicode.txt").write_text("λ" * 240)
    async with running(tmp_path, [], runtime_kind) as (conn, client, init):
        declaration = init.field_meta["modular-agent"]["declaration"]
        assert declaration["settingsDuringTurn"] == "refused"
        assert declaration["queuedInputAfterRestart"] == (
            "run" if runtime_kind == "durable" else "handedBack"
        )
        session = await conn.new_session(cwd=str(tmp_path), mcp_servers=[])
        sid = session.session_id
        await conn.set_config_option(session_id=sid, config_id="model", value="conformance/echo")
        await prompt(conn, sid, "/not-a-command")
        await prompt(conn, sid, 'tool:read {"path":"unicode.txt"}')
        text = "".join(
            u.content.text for _, u in client.updates if u.session_update == "agent_message_chunk"
        )
        assert text == "echo: /not-a-command" + "done: " + "λ" * 200
        entries = (await bound(conn, "history", sid))["entries"]
        assert all(
            e["data"]["usage"] == {"input_tokens": 0, "output_tokens": 0}
            for e in entries
            if e["kind"] == "response"
        )
        assert any(
            e["kind"] == "toolResult" and e["message"]["role"] == "toolResult" for e in entries
        )
        await conn.close_session(session_id=sid)
        resumed = await conn.resume_session(session_id=sid, cwd=str(tmp_path), mcp_servers=[])
        assert not resumed.field_meta["modular-agent"]["declaration"]["keepsStateAtProvider"]
    assert not (tmp_path / "store").exists()
    assert (tmp_path / "isolated/history.sqlite3").exists()


async def test_conformance_model_is_not_normally_offered(tmp_path, runtime_kind):
    async with running(tmp_path, [], runtime_kind) as (conn, _, _):
        session = await conn.new_session(cwd=str(tmp_path), mcp_servers=[])
        models = next(o for o in session.config_options if o.id == "model")
        assert [o.value for o in models.options] == ["fake/fake"]


async def test_queued_restart_follows_declared_policy(tmp_path, runtime_kind, runtime_type):
    h = await build(tmp_path / "store", Fake(), runtime=runtime_type(), project=tmp_path)
    try:
        session = await h.api().session("create", project=str(tmp_path), settings={"model": "fake"})
        sid = session["id"]
        queued = await h.api().session(
            "append",
            session=sid,
            kind="input_queued",
            content=content("waiting"),
            data={"when": "after", "key": "restart", "authority": session["authority"]},
        )
    finally:
        await h.stop()
    async with running(tmp_path, [reply("recovered queued input")], runtime_kind) as (
        conn,
        client,
        _,
    ):
        loaded = await conn.load_session(cwd=str(tmp_path), session_id=sid, mcp_servers=[])
        if runtime_kind == "transient":
            assert loaded.field_meta["modular-agent"]["handedBack"] == [
                {"inputId": queued["id"], "content": content("waiting")}
            ]
            entries = (await bound(conn, "history", sid))["entries"]
            assert any(e["kind"] == "inputHandedBack" for e in entries)
            assert not any(e["kind"] == "response" for e in entries)
        else:
            await client.wait_event("turn_ended")
            entries = (await bound(conn, "history", sid))["entries"]
            assert any(e["kind"] == "response" for e in entries)


async def test_closed_connection_refuses_pending_approval_on_restart(tmp_path, runtime_kind):
    client = Client(permission="wait")
    call = {
        "id": "pending-permission",
        "name": "write",
        "input": {"path": "never.txt", "text": "no"},
    }
    async with running(tmp_path, [reply(calls=[call])], runtime_kind, client) as (conn, _, _):
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        await conn.set_config_option(session_id=sid, config_id="approval", value="all")
        task = asyncio.create_task(prompt(conn, sid))
        async with asyncio.timeout(10):
            await client.question.wait()
    await asyncio.gather(task, return_exceptions=True)
    async with running(tmp_path, [reply("recovered")], runtime_kind) as (conn, new_client, _):
        await conn.load_session(cwd=str(tmp_path), session_id=sid, mcp_servers=[])
        async with asyncio.timeout(10):
            while True:
                entries = (await bound(conn, "history", sid))["entries"]
                if any(e["kind"] == "turnEnd" for e in entries):
                    break
                await asyncio.sleep(0.01)
        assert any(e["kind"] == "inputAnswer" and e["data"]["declined"] for e in entries)
        assert not new_client.permissions
        assert not (tmp_path / "never.txt").exists()


async def test_binding_history_and_errors_pass_output_gate(tmp_path, runtime_kind):
    (tmp_path / "store").mkdir()
    (tmp_path / "store/settings.json").write_text(
        json.dumps(
            {
                "plugins": [
                    {
                        "factory": "ma_guardrail:Guardrail",
                        "replaces": "guardrail",
                        "options": {"secrets": ["bound-secret-712"]},
                    }
                ],
            }
        )
    )
    async with running(
        tmp_path, [reply("bound-secret-712", pieces=["bound-", "secret-712"])], runtime_kind
    ) as (conn, client, init):
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        result = await prompt(conn, sid, "bound-secret-712", key="bound-secret-712")
        history = await bound(conn, "history", sid, all=True)
        chunks = [u.model_dump(mode="json") for _, u in client.updates]
        for value in (
            result.model_dump(mode="json"),
            history,
            chunks,
            init.model_dump(mode="json"),
        ):
            assert "bound-secret-712" not in json.dumps(value)
        assert "[REDACTED]" in json.dumps(history)
        for params in ({"after": "no-such-entry"}, {"all": "yes"}):
            with pytest.raises(acp.RequestError) as caught:
                await bound(conn, "history", sid, **params)
            assert caught.value.code == -32602
        before = len(history["entries"])
        with pytest.raises(acp.RequestError):
            await bound(conn, "input", sid, content=[{"type": "image"}], when="now")
        with pytest.raises(acp.RequestError):
            await bound(conn, "input", sid, content="hello", when="now", key={})
        assert len((await bound(conn, "history", sid, all=True))["entries"]) == before
