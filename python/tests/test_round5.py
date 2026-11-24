"""Offline round-five regressions at the ACP, Harness and plugin boundaries."""

import asyncio
import json
from pathlib import Path

import acp
import pytest
from acp_fixture import running
from ma_core import AgentError, content
from ma_core.wire import entry_out
from ma_fake import Fake, reply
from ma_fake.conformance import Echo
from ma_history.http import HTTPHistory
from ma_cli import build


async def test_acp_v2_reports_a_failed_turn_as_an_error(tmp_path, runtime_kind):
    async with running(
        tmp_path, [{"error": "offline failure"}], runtime_kind, binding="modular-agent-acp/2"
    ) as (conn, _, init):
        assert init.field_meta["modular-agent"]["binding"] == "modular-agent-acp/2"
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        with pytest.raises(acp.RequestError) as error:
            await conn.prompt(
                session_id=sid,
                prompt=[acp.schema.TextContentBlock(type="text", text="missing script")],
            )
        assert error.value.code == -32000
        assert error.value.data["_meta"]["modular-agent"]["outcome"]["kind"] == "failed"


async def test_rewind_restores_ui_effect_and_refuses_a_lost_point(tmp_path, runtime_type):
    project = tmp_path / "project"
    project.mkdir()
    h = await build(
        tmp_path / "state", Fake([reply("marker")]), runtime=runtime_type(), project=project
    )
    try:
        a = h.api()
        sid = (
            await a.session(
                "create", project=str(project), settings={"model": "fake", "approval": "off"}
            )
        )["id"]
        scope = {"session": sid}
        await a.call("runtime", "submit", {**scope, "content": content("first")})
        await a.call("runtime", "wait", scope)
        mark = (await a.session("get", **scope))["position"]
        (project / "file").write_text("old")
        await a.call(
            "runtime",
            "run_tool",
            {**scope, "name": "write", "input": {"path": "file", "text": "changed"}},
        )
        assert (project / "file").read_text() == "changed"
        await a.session("move", **scope, point=mark, rewind=True)
        assert (project / "file").read_text() == "old"
        assert (await a.session("get", **scope))["position"] == mark
        await a.call(
            "runtime",
            "run_tool",
            {**scope, "name": "write", "input": {"path": "file", "text": "again"}},
        )
        await a.session("close", **scope)
        await a.session("open", **scope)
        head = (await a.session("get", **scope))["position"]
        with pytest.raises(AgentError, match="Missing working environment point"):
            await a.session("move", **scope, point=mark, rewind=True)
        assert (project / "file").read_text() == "again"
        assert (await a.session("get", **scope))["position"] == head
    finally:
        await h.stop()


async def test_portable_records_and_approval_fails_closed_after_reopen(tmp_path, runtime_type):
    from ma_fake import call

    fake = Fake([reply(calls=[call("write", path="absent", text="no")]), reply("finished")])
    h = await build(tmp_path / "state", fake, runtime=runtime_type(), project=tmp_path)
    try:
        a = h.api()
        sid = (await a.session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]
        scope = {"session": sid}
        # Simulate an earlier writer that left approval unrecorded.
        await a.session("append", **scope, kind="marker")
        setup = next(
            e
            for e in (await a.session("get", **scope))["entries"]
            if e["kind"] == "setting" and "approval" in e["data"]
        )
        await a.session("erase", **scope, entries=[setup["id"]])
        await a.session("close", **scope)
        opened = await a.session("open", **scope)
        assert opened["settings"]["approval"] == "ask always"
        receipt = await a.call(
            "runtime", "submit", {**scope, "content": content("work"), "key": "k"}
        )
        await a.call("runtime", "wait", scope)
        es = [entry_out(e) for e in (await a.session("get", **scope))["entries"]]
        admission = next(e for e in es if e["kind"] == "inputAccepted")
        assert admission["inputId"] == receipt["input"]
        assert "inputId" not in admission["data"]
        assert admission["data"]["content"] == content("work")
        assert len([e for e in es if e["kind"] == "plugins"]) == 1
        attempt = next(e for e in es if e["kind"] == "modelRequest")["data"]
        assert "request" in attempt or not attempt["safeToRepeat"]
        assert next(e for e in es if e["kind"] == "inputAnswer")["data"]["reason"] == "refused"
        result = next(e for e in es if e["kind"] == "toolResult")
        assert result["data"]["status"] == "refused"
        await a.session("erase", **scope, entries=[result["id"]])
        erased = next(
            entry_out(e)
            for e in (await a.session("get", **scope))["entries"]
            if e["id"] == result["id"]
        )
        assert erased == {
            k: result[k] for k in ("id", "parentId", "kind", "turnId", "stepId", "toolCallId")
        } | {"erased": True}
    finally:
        await h.stop()


async def test_plugin_job_kit_offline(runtime_kind):
    from test_plugin_binding import run_kit

    repo = Path(__file__).resolve().parents[1]
    output = await run_kit(
        "conformance/acp/run.mjs",
        "--job-checks",
        "--",
        str(repo / ".venv/bin/modular-agent"),
        "--mode",
        "acp",
        "--runtime",
        runtime_kind,
    )
    assert "jobs: the report started a turn" in output
    assert "jobs: cancel-job ends the job once" in output


@pytest.mark.parametrize("report_during_open", [False, True], ids=["natural", "during-open"])
async def test_foreign_job_report_runs_as_a_turn(
    tmp_path, runtime_type, monkeypatch, report_during_open
):
    sid, job = "foreign-session", "foreign-job"
    meta = {"id": sid, "project": str(tmp_path), "created": 0}
    records = [
        {
            "id": "foreign-model-setting",
            "parentId": None,
            "sessionId": sid,
            "kind": "setting",
            "time": 0,
            "writer": "foreign-harness",
            "modelVisible": False,
            "data": {"key": "model", "value": {"provider": "conformance", "id": "echo"}},
        },
        {
            "id": "foreign-job-start",
            "parentId": "foreign-model-setting",
            "sessionId": sid,
            "kind": "jobStarted",
            "time": 1,
            "writer": "conformance-jobs",
            "modelVisible": False,
            "actorId": "user",
            "jobId": job,
            "toolCallId": "foreign-tool-call",
            "data": {
                "kind": "background",
                "rights": ["watch", "input"],
                "key": "background:foreign-tool-call",
                "detail": {"text": "kit-survivor", "ms": 60000},
            },
        },
    ]

    async def exchange(self, method, path, body=None):
        if path == "/v1":
            return {"binding": "modular-agent-history/1", "ttlMs": 60000}
        if path.split("?", 1)[0] == "/v1/sessions":
            return {"sessions": [meta]}
        if method == "GET":
            return {"session": meta, "entries": records}
        if path.endswith("/lease"):
            return {"lease": "held", "ttlMs": 60000}
        if path.endswith("/entries"):
            assert body["lease"] == "held"
            records.extend(body["entries"])
            return {"kept": len(body["entries"])}
        assert method == "DELETE"
        return {}

    token = tmp_path / "token"
    token.write_text("offline-placeholder")
    monkeypatch.setattr(HTTPHistory, "request", exchange)
    monkeypatch.setenv("MODULAR_AGENT_HISTORY_URL", "https://example.invalid")
    monkeypatch.setenv("MODULAR_AGENT_HISTORY_TOKEN_FILE", str(token))
    plugin = Path(__file__).resolve().parents[1] / "conformance/plugin/jobs.mjs"
    monkeypatch.setenv("MODULAR_AGENT_PLUGINS", json.dumps([{"command": ["node", str(plugin)]}]))

    h = await build(tmp_path / "state", Echo(), runtime=runtime_type(), project=tmp_path)
    turn_ended = asyncio.Event()
    report_committed, session_opened = asyncio.Event(), asyncio.Event()

    async def receive(event):
        if event.get("session") != sid:
            return
        if event["kind"] == "job_ended" and report_during_open:
            report_committed.set()
            await session_opened.wait()
        if event["kind"] == "turn_ended":
            turn_ended.set()

    async def wait_for_report(_):
        # Force the commit to precede recovery and the job owner's kick to follow it.
        await asyncio.wait_for(report_committed.wait(), timeout=5)

    try:
        a = h.api()
        a.follow("test", receive)
        if report_during_open:
            a.on("session.start", wait_for_report, "last")
        await a.session("open", session=sid)
        session_opened.set()
        assert not any(e["kind"] == "inputHandedBack" for e in records), (
            "A report admitted during open is new input, not work left over from a restart"
        )
        await asyncio.wait_for(turn_ended.wait(), timeout=5)
        await a.call("runtime", "wait", {"session": sid})
        expected = "background: kit-survivor (taken up)"
        [response] = [e for e in records if e["kind"] == "response"]
        assert response["message"]["content"] == content("echo: " + expected)
        [end] = [e for e in records if e["kind"] == "jobEnded" and e["jobId"] == job]
        assert end["data"]["outcome"] == {"kind": "completed"}
        assert end["data"]["result"] == content(expected)
        assert end["data"]["report"] is True
        [report] = [
            e for e in records if e["kind"] == "input" and e["data"].get("key") == f"job:{job}"
        ]
        assert records.index(end) < records.index(report)
        assert report["message"]["content"] == end["data"]["result"]
        [start] = [e for e in records if e["kind"] == "turnStart"]
        assert response["turnId"] == report["turnId"] == start["turnId"]
        assert start["data"]["startedBy"] == {"kind": "job", "id": job}
        assert "source" not in start["data"]
    finally:
        session_opened.set()
        await h.stop()


async def test_external_output_receives_stream_at_its_end(tmp_path, runtime_type, monkeypatch):
    repo = Path(__file__).resolve().parents[1]
    monkeypatch.setenv(
        "MODULAR_AGENT_PLUGINS",
        json.dumps(
            [
                {
                    "command": [str(repo / ".venv/bin/modular-agent-plugin")],
                    "env": {"MODULAR_AGENT_PLUGIN_PARTS": "hooks"},
                }
            ]
        ),
    )
    h = await build(
        tmp_path / "state",
        Fake([reply("conformance-secret", pieces=["conformance-", "secret"])]),
        runtime=runtime_type(),
        project=tmp_path,
    )
    try:
        a = h.api()
        delivered = []

        async def receive(event):
            delivered.append(event)

        a.follow("test", receive)
        sid = (await a.session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]
        await a.call("runtime", "submit", {"session": sid, "content": content("hello")})
        await a.call("runtime", "wait", {"session": sid})
        emissions = [e["text"] for e in delivered if e["kind"] == "model_output"]
        assert "".join(emissions) == "[redacted]"
        assert "conformance-secret" not in json.dumps(delivered)
        response = next(
            e["entry"]
            for e in delivered
            if e["kind"] == "history_entry" and e["entry"]["kind"] == "response"
        )
        assert response["content"] == content("[redacted]")
        raw = await a.session("branch", session=sid)
        assert next(e for e in raw if e["kind"] == "response")["content"] == content(
            "conformance-secret"
        )
    finally:
        await h.stop()
