"""Adversarial boundaries for milestone 3's visible guarantees."""

import asyncio
import json

import pytest

from ma_core import AgentError, content, plain
from ma_fake import call, reply
from test_jobs_subagents import RoutedFake
from test_questions import interface
from test_swap import dead, pid_ready, until
from test_vanilla import entries, paired, run
from modular_agent import build


async def test_approval_cannot_be_answered_after_its_turn(agent, tmp_path):
    h, a, sid, fake = await agent(
        [reply(calls=[call("write", path="no-write", text="bad")]), reply("refused")],
        settings={"approval": "ask always", "approval_timeout": 0},
    )
    ui = await interface(h, sid)
    await run(a, sid)
    q = (await a.call("questions", "list", {"session": sid}))[0]
    assert not q["answerable"]
    with pytest.raises(AgentError, match="Question is closed"):
        await ui.call(
            "questions",
            "answer",
            {"session": sid, "actor": "user", "request": q["id"], "value": "allow"},
        )
    await a.call("runtime", "wait", {"session": sid})
    assert not (tmp_path / "no-write").exists()
    assert (await entries(a, sid, "tool_result"))[0]["data"]["status"] == "refused"
    assert len(await entries(a, sid, "turn_start")) == 1
    paired(await entries(a, sid))


async def test_mutation_after_approval_cannot_change_approved_arguments(agent, tmp_path):
    h, a, sid, fake = await agent(settings={"approval": "ask always"})
    ui = await interface(h, sid)

    async def allow(e):
        if e["kind"] == "input_request_opened":
            await ui.call(
                "questions",
                "answer",
                {"session": sid, "actor": "user", "request": e["request"]["id"], "value": "allow"},
            )

    async def mutate(d):
        return {**d, "call": {**d["call"], "input": {"path": "changed", "text": "bad"}}}

    a.follow("user", allow)
    a.on("tool.before", mutate, "last")
    result = await ui.call(
        "runtime",
        "run_tool",
        {"session": sid, "name": "write", "input": {"path": "approved", "text": "ok"}},
    )
    assert result["status"] == "refused" and "changed after approval" in plain(result["content"])
    assert not (tmp_path / "approved").exists() and not (tmp_path / "changed").exists()


async def test_all_parallel_questions_must_be_answered_before_resume(agent):
    cs = [call("ask_user", question=str(i), timeout=0) for i in range(2)]
    h, a, sid, fake = await agent([reply(calls=cs), reply("both answered")])
    ui = await interface(h, sid)
    await run(a, sid)
    qs = await a.call("questions", "list", {"session": sid})
    for index, q in enumerate(qs):
        await ui.call(
            "questions",
            "answer",
            {"session": sid, "actor": "user", "request": q["id"], "value": str(index)},
        )
        if index == 0:
            assert len(await entries(a, sid, "turn_start")) == 1
    await a.call("runtime", "wait", {"session": sid})
    assert len(await entries(a, sid, "turn_start")) == 2
    results = await entries(a, sid, "tool_result")
    assert [e["call"] for e in results] == [c["id"] for c in cs]
    assert all(e["data"]["late"] for e in results)
    paired(await entries(a, sid))


async def test_move_cancels_abandoned_calls_and_fork_refuses_pending_work(agent):
    h, a, sid, fake = await agent([reply(calls=[call("ask_user", question="Wait", timeout=0)])])
    await interface(h, sid)
    await run(a, sid)
    prior = h.sessions[sid]["position"]
    with pytest.raises(AgentError, match="pending work"):
        await a.session("fork", session=sid)
    await a.session("move", session=sid, point=None)
    all_entries = await entries(a, sid)
    assert len([e for e in all_entries if e["kind"] == "tool_result"]) == 1
    assert (
        next(e for e in all_entries if e["kind"] == "tool_result")["data"]["status"] == "cancelled"
    )
    q = next(e for e in all_entries if e["kind"] == "question_open")["data"]["id"]
    with pytest.raises(AgentError, match="closed"):
        await a.call(
            "questions",
            "answer",
            {"session": sid, "actor": "user", "request": q, "value": "too late"},
        )
    assert prior is not None
    paired(all_entries)


async def test_ui_call_cancellation_and_permission_ceiling(agent, tmp_path):
    h, a, sid, fake = await agent()
    ui = await interface(h, sid)
    task = asyncio.create_task(
        ui.call(
            "runtime",
            "run_tool",
            {"session": sid, "name": "bash", "input": {"command": "echo $$ > ui.pid; sleep 60"}},
        )
    )
    try:
        await until(lambda: pid_ready(tmp_path / "ui.pid"))
        pid = int((tmp_path / "ui.pid").read_text())
        await ui.call("runtime", "cancel", {"session": sid})
        assert (await task)["status"] == "cancelled" and dead(pid)
        await ui.session("grant", session=sid, subject="viewer", authority=["watch"])
        with pytest.raises(AgentError, match="authority"):
            await ui.call(
                "runtime",
                "run_tool",
                {
                    "session": sid,
                    "actor": "viewer",
                    "name": "write",
                    "input": {"path": "never", "text": "bad"},
                },
            )
        paired(await entries(a, sid))
    finally:
        if not task.done():
            await a.call("runtime", "cancel", {"session": sid})
        await asyncio.gather(task, return_exceptions=True)


async def test_secret_missing_store_and_store_failure_do_not_expose_value(agent, monkeypatch):
    h, a, sid, fake = await agent()
    ui = await interface(h, sid)
    ask = {"session": sid, "kind": "secret", "name": "service", "question": "Token", "timeout": 0}
    answer = await a.call("questions", "ask", ask)
    secret = "dummy-intake-error-canary"

    def fail(*args, **kwargs):
        raise OSError(secret)

    monkeypatch.setattr("ma_credentials.os.open", fail)
    with pytest.raises(AgentError, match="could not be stored") as exc:
        await ui.call(
            "credentials",
            "answer",
            {"session": sid, "actor": "user", "request": answer["request"], "value": secret},
        )
    assert secret not in str(exc.value)
    assert secret not in json.dumps(await entries(a, sid))
    monkeypatch.undo()
    await h.unload("credentials")
    assert (await a.call("questions", "ask", {**ask, "key": "missing-store"}))[
        "value"
    ] == "declined"


async def test_committed_job_end_redelivers_once_after_reopen_and_not_in_fork(agent):
    h, a, sid, fake = await agent([reply("report handled")])
    owner = h.api("worker", "feature")
    job = await owner.call("jobs", "create", {"session": sid, "kind": "test", "key": "report"})
    # Crash boundary: result committed, but report input has not been admitted.
    result = content("/model not-a-command")
    await a.session(
        "append",
        session=sid,
        kind="job_end",
        job=job["id"],
        data={"state": "completed", "result": result, "usage": {}},
    )
    await a.session("close", session=sid)
    await a.session("open", session=sid)
    await a.call("runtime", "wait", {"session": sid})
    [report] = await entries(a, sid, "input")
    assert report["content"] == result
    await a.session("close", session=sid)
    await a.session("open", session=sid)
    await a.call("runtime", "wait", {"session": sid})
    assert len(await entries(a, sid, "input")) == 1
    child = await a.session("fork", session=sid)
    await a.session("close", session=child["id"])
    await a.session("open", session=child["id"])
    assert len(await entries(a, child["id"], "input")) == 1


async def test_session_close_cancels_live_child_and_prevents_report_turn(tmp_path, runtime_type):
    async def route(d, index):
        return reply(calls=[call("bash", command="echo $$ > close.pid; sleep 60")])

    h = await build(tmp_path / "store", RoutedFake(route), runtime=runtime_type())
    a = h.api()
    try:
        sid = (await a.session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]
        ui = await interface(h, sid)
        await ui.call(
            "runtime",
            "run_tool",
            {
                "session": sid,
                "name": "delegate",
                "input": {"task": "stay busy", "background": True},
            },
        )
        await until(lambda: pid_ready(tmp_path / "close.pid"))
        pid = int((tmp_path / "close.pid").read_text())
        await ui.session("close", session=sid)
        assert dead(pid) and not h.sessions
        saved = await a.call("history", "read", {"session": sid})
        report = next(e for e in saved["entries"] if e["kind"] == "input_queued")
        assert report["data"]["source"]["job"] == report["job"]
        assert not any(e["kind"] == "turn_start" for e in saved["entries"])
        assert (
            next(e for e in saved["entries"] if e["kind"] == "job_end")["data"]["state"]
            == "cancelled"
        )
    finally:
        await h.stop()
