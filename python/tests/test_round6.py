"""Offline regressions for the round-six binding rules."""

import asyncio
import json
import sys
from pathlib import Path

import acp
import pytest
from acp_fixture import running
from ma_core import AgentError, content
from ma_core.wire import entry_out
from ma_fake import Fake, call, reply
from ma_cli import build


async def test_tenant_budget_spans_sessions_and_restarts(tmp_path, runtime_type, monkeypatch):
    monkeypatch.setenv(
        "MODULAR_AGENT_TENANTS", '{"team":{"rights":["watch","input","administer"],"tokens":3}}'
    )
    settings = {"model": "fake"}
    h = await build(
        tmp_path,
        Fake([reply("one", usage={"input_tokens": 2, "output_tokens": 1})]),
        runtime=runtime_type(),
    )
    try:
        a = h.api()
        first = await a.session("create", project=str(tmp_path), tenant="team", settings=settings)
        sid = first["id"]
        assert entry_out(first["entries"][0])["kind"] == "tenant"
        await a.call("runtime", "submit", {"session": sid, "content": content("use budget")})
        assert (await a.call("runtime", "wait", {"session": sid}))[0]["shared_outcome"] == {
            "kind": "limit",
            "limit": "tenantTokens",
        }
    finally:
        await h.stop()

    h = await build(tmp_path, Fake([]), runtime=runtime_type())
    try:
        a = h.api()
        second = await a.session("create", project=str(tmp_path), tenant="team", settings=settings)
        scope = {"session": second["id"]}
        assert (await a.session("tenant", **scope))["tokens"] == {"budget": 3, "used": 3}
        with pytest.raises(AgentError, match="authority"):
            await a.session("limit", **scope, rights=["tools"])
        limit = await a.session("limit", **scope, rights=["watch", "input"])
        assert "administer" in await a.session("authority", **scope)
        with pytest.raises(AgentError, match="authority"):
            await a.session("erase", **scope, entries=[limit["id"]])
        await a.call("runtime", "submit", {**scope, "content": content("already spent")})
        await a.call("runtime", "wait", scope)
        records = [entry_out(e) for e in (await a.session("get", **scope))["entries"]]
        assert not any(r["kind"] == "modelRequest" for r in records)
        assert records[-1]["data"]["outcome"] == {"kind": "limit", "limit": "tenantTokens"}
    finally:
        await h.stop()


async def test_lowering_limit_takes_effect_during_a_turn(tmp_path, runtime_type):
    fake = Fake([reply(calls=[call("write", path="denied", text="no")], wait=True), reply("done")])
    project = tmp_path / "project"
    project.mkdir()
    h = await build(tmp_path / "state", fake, runtime=runtime_type(), project=project)
    try:
        a = h.api()
        scope = {
            "session": (
                await a.session("create", project=str(project), settings={"model": "fake"})
            )["id"]
        }
        await a.call("runtime", "submit", {**scope, "content": content("work")})
        async with asyncio.timeout(5):
            await fake.entered.wait()
        limit = await a.session("limit", **scope, rights=["watch", "input", "administer", "erase"])
        fake.release.set()
        await a.call("runtime", "wait", scope)
        assert not (project / "denied").exists()
        assert (
            next(
                e
                for e in (await a.session("get", **scope))["entries"]
                if e["kind"] == "tool_result"
            )["data"]["status"]
            == "refused"
        )
        with pytest.raises(AgentError, match="records of authority"):
            await a.session("erase", **scope, entries=[limit["id"]])
        await a.session("close", **scope)
        await a.session("open", **scope)
        assert "tools" not in await a.session("authority", **scope)
    finally:
        await h.stop()


def wire_fixture(**config):
    return {
        "command": [sys.executable, str(Path(__file__).with_name("shared_plugin_fixture.py"))],
        "config": config,
    }


async def test_proposals_decline_withdraw_and_absent_join(tmp_path, runtime_kind):
    async with running(tmp_path, [], runtime_kind) as (conn, _, _):
        sid = (await conn.new_session(cwd=str(tmp_path))).session_id

        async def ask(method, **params):
            return await conn.ext_method("modular-agent/" + method, {"sessionId": sid, **params})

        await ask(
            "join",
            actor={"id": "guest", "kind": "user", "rights": ["watch", "propose"]},
            present=False,
        )
        assert "guest" not in (await ask("actors"))["present"]
        with pytest.raises(acp.RequestError) as denied:
            await ask("input", actorId="guest", content="not mine", when="propose")
        assert denied.value.data == {"code": "forbidden"}
        first = await ask("input", content="first", when="propose")
        second = await ask("input", content="second", when="propose")
        listed = (await ask("proposals"))["proposals"]
        assert [r["inputId"] for r in listed] == [first["inputId"], second["inputId"]]
        assert all(r["actorId"] == "user" and isinstance(r["time"], int) for r in listed)
        assert (await ask("release", inputId=first["inputId"], declined=True))[
            "taken"
        ] == "handedBack"
        assert await ask("withdraw", inputId=second["inputId"]) == {}
        assert await ask("proposals") == {"proposals": []}
        es = (await ask("history"))["entries"]
        assert [e["data"]["inputIds"][0] for e in es if e["kind"] == "inputHandedBack"] == [
            first["inputId"],
            second["inputId"],
        ]
        assert not any(e["kind"] == "turnStart" for e in es)


async def test_propose_does_not_require_watch(tmp_path, runtime_kind, monkeypatch):
    monkeypatch.setenv("MODULAR_AGENT_TENANTS", '{"proposal-only":{"rights":["propose"]}}')
    async with running(tmp_path, [], runtime_kind) as (conn, _, _):
        sid = (
            await conn.new_session(
                cwd=str(tmp_path), **{"modular-agent": {"tenant": "proposal-only"}}
            )
        ).session_id
        scope = {"sessionId": sid}
        receipt = await conn.ext_method(
            "modular-agent/input", {**scope, "content": "suggestion", "when": "propose"}
        )
        assert receipt["taken"] == "proposed"
        with pytest.raises(acp.RequestError):
            await conn.ext_method("modular-agent/proposals", scope)
        await conn.close_session(session_id=sid)


async def test_gate_withholds_reply_but_not_effect(tmp_path, runtime_kind, monkeypatch):
    spec = wire_fixture(hooks=["output"], blockMethod="_modular-agent/limit")
    monkeypatch.setenv("MODULAR_AGENT_PLUGINS", json.dumps([spec]))
    async with running(tmp_path, [], runtime_kind) as (conn, _, _):
        sid = (await conn.new_session(cwd=str(tmp_path))).session_id
        with pytest.raises(acp.RequestError) as error:
            await conn.ext_method("modular-agent/limit", {"sessionId": sid, "rights": ["watch"]})
        assert error.value.code == -32000
        assert error.value.data["code"] == "withheld"
        es = (await conn.ext_method("modular-agent/history", {"sessionId": sid}))["entries"]
        assert [e["data"]["rights"] for e in es if e["kind"] == "limit"] == [["watch"]]


async def test_duplicate_name_is_refused_even_with_disjoint_registrations(tmp_path, monkeypatch):
    log = tmp_path / "shutdown"
    plugin1 = wire_fixture(
        registration={"name": "same", "commands": [], "toolSources": [], "providers": []}
    )
    plugin2 = wire_fixture(registration={"name": "same"}, shutdownLog=str(log))
    monkeypatch.setenv("MODULAR_AGENT_PLUGINS", json.dumps([plugin1, plugin2]))
    from ma_plugin.rpc import WireError

    with pytest.raises(WireError, match="Duplicate plugin name: same"):
        await build(tmp_path / "state", Fake(), project=tmp_path)
    assert log.read_text() == "refused"


async def test_rewind_never_restores_before_committing_and_journals_missing_point(
    tmp_path, runtime_type, monkeypatch
):
    project = tmp_path / "project"
    project.mkdir()
    h = await build(tmp_path / "state", Fake(), runtime=runtime_type(), project=project)
    try:
        a = h.api()
        scope = {"session": (await a.session("create", project=str(project)))["id"]}
        mark = (await a.session("append", **scope, kind="marker"))["id"]
        file = project / "file"
        file.write_text("before")
        await a.call(
            "runtime",
            "run_tool",
            {**scope, "name": "bash", "input": {"command": "printf changed > file"}},
        )
        assert file.read_text() == "changed"
        head = (await a.session("get", **scope))["position"]
        history = h.capabilities["history"][1]
        original = history.keep

        async def reject_move(d, emit):
            if d["entries"][-1]["kind"] == "position_move":
                assert file.read_text() == "changed"
                assert d["entries"][-1]["data"]["restore"]["point"]
                raise AgentError("Lost history lease", "lost")
            return await original(d, emit)

        with monkeypatch.context() as patch:
            patch.setattr(history, "keep", reject_move)
            with pytest.raises(AgentError, match="Lost history lease"):
                await a.session("move", **scope, point=mark, rewind=True)
        assert file.read_text() == "changed"
        assert (await a.session("get", **scope))["position"] == head
        await a.session("close", **scope)
        await a.session("open", **scope)
        # A lost point now fails read-only preflight before the first journal write.
        with pytest.raises(AgentError, match="Missing working environment point"):
            await a.session("move", **scope, point=mark, rewind=True)
        session = await a.session("get", **scope)
        assert session["position"] == head
        assert file.read_text() == "changed"
        journal = [e["data"] for e in session["entries"] if e["kind"] == "position_move"]
        assert journal == []
    finally:
        await h.stop()


async def test_reasoning_is_lowered_to_nearest_supported_level(tmp_path, runtime_type):
    fake = Fake([reply("ok")])
    h = await build(tmp_path, fake, runtime=runtime_type())
    try:
        a = h.api()
        sid = (
            await a.session(
                "create", project=str(tmp_path), settings={"model": "fake", "thinking": "medium"}
            )
        )["id"]
        await a.call("runtime", "submit", {"session": sid, "content": content("think")})
        await a.call("runtime", "wait", {"session": sid})
        assert fake.requests[0]["settings"]["thinking"] == "low"
        entries = [entry_out(e) for e in await a.session("branch", session=sid)]
        assert (
            next(e for e in entries if e["kind"] == "turnStart")["data"]["settings"]["reasoning"]
            == "low"
        )
    finally:
        await h.stop()


async def test_job_end_accepts_report_without_waiting_for_report_turn(
    tmp_path, runtime_type, monkeypatch
):
    fake = Fake([reply("reported", wait=True)])
    monkeypatch.setenv("MODULAR_AGENT_PLUGINS", json.dumps([wire_fixture()]))
    h = await build(tmp_path / "state", fake, runtime=runtime_type(), project=tmp_path)
    try:
        a = h.api()
        scope = {
            "session": (
                await a.session("create", project=str(tmp_path), settings={"model": "fake"})
            )["id"]
        }
        await a.session("limit", **scope, rights=["watch", "input", "jobs"])
        async with asyncio.timeout(5):
            result = await a.session("command", **scope, text="/probe end-job")
            await fake.entered.wait()
        assert json.loads(result["output"]) == {
            "rights": ["administer", "input", "jobs", "watch"],
            "accepted": content("offline job report"),
        }
        fake.release.set()
        await a.call("runtime", "wait", scope)
    finally:
        await h.stop()


async def test_hosted_cancel_wins_over_failed_callback(tmp_path, runtime_type, monkeypatch):
    fake = Fake([reply("not delivered", wait=True)])
    monkeypatch.setenv(
        "MODULAR_AGENT_PLUGINS",
        json.dumps([wire_fixture(runtimeCancel=True, registration={"replaces": ["runtime"]})]),
    )
    h = await build(tmp_path / "state", fake, runtime=runtime_type(), project=tmp_path)
    try:
        a = h.api()
        scope = {
            "session": (
                await a.session("create", project=str(tmp_path), settings={"model": "fake"})
            )["id"]
        }
        await a.call("runtime", "submit", {**scope, "content": content("wait")})
        async with asyncio.timeout(5):
            await fake.entered.wait()
            await a.call("runtime", "cancel", scope)
        es = [entry_out(e) for e in await a.session("branch", **scope)]
        assert next(e for e in es if e["kind"] == "turnEnd")["data"]["outcome"] == {
            "kind": "cancelled"
        }
    finally:
        await h.stop()


async def test_history_first_entry_does_not_fit_with_required_cursor(tmp_path, monkeypatch):
    monkeypatch.setenv("MODULAR_AGENT_PLUGINS", json.dumps([wire_fixture(after="before-large")]))
    h = await build(tmp_path / "state", Fake(), project=tmp_path)
    try:
        a = h.api()
        scope = {"session": (await a.session("create", project=str(tmp_path)))["id"]}
        mark = await a.session(
            "append", **scope, kind="marker", id="before-large", data={"blob": ""}
        )
        candidate = {**entry_out(mark), "id": "large-entry!", "parentId": "before-large"}
        blank = len(json.dumps({"entries": [candidate]}).encode())
        target = await a.session(
            "append",
            **scope,
            kind="marker",
            id=candidate["id"],
            data={"blob": "x" * (4 * 1024 * 1024 - blank)},
        )
        assert len(json.dumps({"entries": [entry_out(target)]}).encode()) == 4 * 1024 * 1024
        await a.session("append", **scope, kind="marker")
        with pytest.raises(AgentError) as err:
            await a.session("command", **scope, text="/probe page-edge")
        assert err.value.code == "result_too_large"
    finally:
        await h.stop()
