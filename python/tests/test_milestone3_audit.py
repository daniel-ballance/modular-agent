"""Cross-feature audit: controlled copies, Interface boundaries and unattended use."""

import json

import pytest

from ma_core import AgentError
from ma_fake import call, reply
from modular_agent import build
from test_jobs_subagents import RoutedFake
from test_questions import interface
from test_terminal import process
from test_vanilla import entries, run


async def test_erasure_reaches_delegated_task_child_report_and_parent_answer(
    tmp_path, runtime_type
):
    marker = "PRIVATE-TASK-CANARY-721"

    async def route(d, index):
        s = await h.api().session("get", session=d["session"])
        if s.get("origin"):
            return reply(marker)
        return (
            reply(calls=[call("delegate", task=marker, background=False)])
            if index == 0
            else reply(marker)
        )

    h = await build(tmp_path / "store", RoutedFake(route), runtime=runtime_type())
    a = h.api()
    try:
        sid = (await a.session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]
        await run(a, sid, marker)
        original = (await entries(a, sid, "input"))[0]["id"]
        await a.session("erase", session=sid, entries=[original])
        assert marker not in json.dumps(h.sessions)
        assert marker.encode() not in h.plugins["history"].db.read_bytes()
    finally:
        await h.stop()


async def test_erasing_question_answer_erases_result_and_model_copies(agent):
    marker = "PRIVATE-ANSWER-CANARY-832"
    h, a, sid, fake = await agent(
        [reply(calls=[call("ask_user", question="Answer?")]), reply(marker)]
    )
    ui = await interface(h, sid)

    async def answer(e):
        if e["kind"] == "input_request_opened":
            await ui.call(
                "questions",
                "answer",
                {"session": sid, "actor": "user", "request": e["request"]["id"], "value": marker},
            )

    a.follow("user", answer)
    await run(a, sid)
    eid = (await entries(a, sid, "question_answer"))[0]["id"]
    await a.session("erase", session=sid, entries=[eid])
    assert marker not in json.dumps(h.sessions[sid])
    assert marker.encode() not in h.plugins["history"].db.read_bytes()


@pytest.mark.parametrize("mode", ["print", "json", "eof"])
async def test_unattended_terminal_approval_fails_closed_without_hanging(tmp_path, mode):
    config = tmp_path / ".modular-agent"
    config.mkdir()
    (config / "settings.json").write_text(json.dumps({"approval": "ask always"}))
    script = [reply(calls=[call("write", path="must-not-run", text="bad")]), reply("call refused")]
    args = (
        ("-p", "go")
        if mode == "print"
        else ("--mode", "json", "-p", "go")
        if mode == "json"
        else ()
    )
    code, out, err = await process(tmp_path, script, *args, stdin="go\n" if mode == "eof" else None)
    assert code == 0 and "call refused" in out
    assert not (tmp_path / "must-not-run").exists()


async def test_suspension_cancels_runtime_before_environment_cleanup(tmp_path, runtime_type):
    import asyncio
    from test_swap import pid_ready, until

    async def route(d, index):
        if index == 0:
            return reply(calls=[call("bash", command="echo $$ > suspend.pid; sleep 60")])
        await asyncio.Event().wait()

    provider = RoutedFake(route)
    h = await build(tmp_path / "store", provider, runtime=runtime_type())
    a = h.api()
    sid = (await a.session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]
    local = h.plugins["local"]
    original_bash = local.bash

    cleanup_calls = 0

    async def delayed_cleanup(d, emit):
        nonlocal cleanup_calls
        try:
            return await original_bash(d, emit)
        finally:
            cleanup_calls += 1
            # Give a mistakenly uncancelled Runtime a deterministic scheduling window.
            if cleanup_calls == 1:
                await asyncio.sleep(0.05)

    # Wrap the public operation, not a private method in another process.
    local.bash = delayed_cleanup
    await a.call("runtime", "submit", {"session": sid, "content": [{"type": "text", "text": "go"}]})
    await until(lambda: pid_ready(tmp_path / "suspend.pid"))
    await h.stop()
    assert cleanup_calls == 1
    assert provider.counts[sid] == 1, "shutdown started another model request during cleanup"


async def test_interface_cannot_use_private_recovery_or_mutate_history(agent):
    h, a, sid, fake = await agent()
    ui = await interface(h, sid)
    for operation, extra in [
        ("busy", {"value": False}),
        ("append", {"kind": "question_answer"}),
        ("open", {"recover": False}),
    ]:
        with pytest.raises(AgentError, match="private"):
            await ui.session(operation, session=sid, **extra)
    with pytest.raises(AgentError, match="checked"):
        await ui.call("fake", "generate", {"session": sid})
    assert not fake.requests
