"""Milestone 3 questions, authority, approval, secret isolation and UI calls."""

import asyncio
import json
import stat

import pytest

from ma_core import AgentError, content, plain
from ma_fake import Fake, call, reply
from ma_cli import build
from test_swap import until
from test_vanilla import entries, paired, run


async def interface(h, sid, actor="user"):
    ui = h.api("test-interface", "interface")
    await ui.call("questions", "connect", {"session": sid, "actor": actor})
    return ui


@pytest.mark.parametrize(
    "kind,value,options",
    [("text", "hello", []), ("choice", "two", ["one", "two"]), ("approval", "allow", [])],
)
async def test_model_ask_user_records_question_answer_and_actor(agent, kind, value, options):
    h, a, sid, fake = await agent(
        [
            reply(calls=[call("ask_user", question="Which?", kind=kind, options=options)]),
            reply("done"),
        ]
    )
    ui = await interface(h, sid)

    async def answer(e):
        if e["kind"] == "input_request_opened":
            await ui.call(
                "questions",
                "answer",
                {"session": sid, "request": e["request"]["id"], "actor": "user", "value": value},
            )

    a.follow("user", answer)
    assert (await run(a, sid))[-1]["outcome"] == "completed"
    assert len(await entries(a, sid, "question_open")) == 1
    assert (await entries(a, sid, "question_answer"))[0]["actor"] == "user"
    assert value in plain((await entries(a, sid, "tool_result"))[0]["content"])
    paired(await entries(a, sid))


async def test_viewer_sees_question_but_cannot_answer_or_escalate(agent):
    h, a, sid, fake = await agent()
    owner = await interface(h, sid)
    await owner.session(
        "grant", session=sid, actor="user", subject="viewer", authority=["watch", "grant"]
    )
    viewer = await interface(h, sid, "viewer")
    task = asyncio.create_task(
        a.call(
            "questions",
            "ask",
            {"session": sid, "question": "Approve?", "kind": "approval", "key": "x"},
        )
    )
    try:
        await until(lambda: any(e["kind"] == "question_open" for e in h.sessions[sid]["entries"]))
        q = (await viewer.call("questions", "list", {"session": sid, "actor": "viewer"}))[0]
        assert q["answerable"]
        with pytest.raises(AgentError, match="authority"):
            await viewer.call(
                "questions",
                "answer",
                {"session": sid, "actor": "viewer", "request": q["id"], "value": "allow"},
            )
        with pytest.raises(AgentError, match="more authority"):
            await viewer.session(
                "grant",
                session=sid,
                actor="viewer",
                subject="other",
                authority=["watch", "approve"],
            )
        scope = {"session": sid, "actor": "user", "request": q["id"]}
        with pytest.raises(AgentError, match="offered options"):
            await owner.call("questions", "answer", {**scope, "value": "refuse"})
        await owner.call("questions", "answer", {**scope, "declined": True})
        assert (await task)["value"] == "declined"
        with pytest.raises(AgentError, match="closed"):
            await owner.call(
                "questions",
                "answer",
                {"session": sid, "actor": "user", "request": q["id"], "value": "allow"},
            )
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize(
    "policy,tool,asked,status",
    [
        ("off", "write", False, "completed"),
        ("never ask, refuse", "write", False, "refused"),
        ("ask unless read-only", "read", False, "completed"),
        ("ask unless read-only", "write", True, "completed"),
        ("ask always", "read", True, "completed"),
    ],
)
async def test_approval_plugin_policies_and_checked_ui_calls(
    agent, tmp_path, policy, tool, asked, status
):
    h, a, sid, fake = await agent(settings={"approval": policy})
    (tmp_path / "facts").write_text("facts")
    ui = await interface(h, sid)

    async def answer(e):
        if e["kind"] == "input_request_opened":
            await ui.call(
                "questions",
                "answer",
                {"session": sid, "actor": "user", "request": e["request"]["id"], "value": "allow"},
            )

    a.follow("user", answer)
    inputs = {"path": "facts"} if tool == "read" else {"path": "written", "text": "ok"}
    result = await ui.call(
        "runtime", "run_tool", {"session": sid, "actor": "user", "name": tool, "input": inputs}
    )
    assert result["status"] == status
    assert bool(await entries(a, sid, "question_open")) == asked
    record = (await entries(a, sid, "tool_call"))[0]
    assert record["data"]["initiator"] == "interface" and record["data"]["actor"] == "user"
    assert not fake.requests
    paired(await entries(a, sid))
    with pytest.raises(AgentError, match="checked"):
        await ui.call(
            "tools",
            "run",
            {"session": sid, "actor": "user", "call": {"name": tool, "input": inputs}},
        )


async def test_approval_without_answerer_fails_closed(agent, tmp_path):
    h, a, sid, fake = await agent(
        [reply(calls=[call("write", path="must-not-exist", text="bad")]), reply("refused")],
        settings={"approval": "ask always"},
    )
    await run(a, sid)
    assert not (tmp_path / "must-not-exist").exists()
    assert (await entries(a, sid, "tool_result"))[0]["data"]["status"] == "refused"


async def test_keyed_answers_reuse_only_on_current_branch_and_current_authority(agent):
    h, a, sid, fake = await agent()
    ui = await interface(h, sid)
    await a.session("grant", session=sid, subject="approver", authority=["watch", "approve"])
    await interface(h, sid, "approver")
    args = {"session": sid, "kind": "approval", "question": "Allow?", "key": "stable"}
    task = asyncio.create_task(a.call("questions", "ask", args))
    await until(lambda: any(e["kind"] == "question_open" for e in h.sessions[sid]["entries"]))
    q = (await a.call("questions", "list", {"session": sid}))[0]
    await ui.call(
        "questions",
        "answer",
        {"session": sid, "actor": "approver", "request": q["id"], "value": "allow"},
    )
    original = await task
    assert await a.call("questions", "ask", args) == original
    await a.session("grant", session=sid, subject="approver", authority=["watch"])
    # Neither the old allow nor its key is valid for a new deadline policy.
    with pytest.raises(AgentError, match="Question key reused"):
        await a.call("questions", "ask", {**args, "timeout": 0})
    again = await a.call("questions", "ask", {**args, "key": "fresh", "timeout": 0})
    assert again.get("open") and again["request"] != q["id"]
    await a.session("move", session=sid, point=None)
    assert await a.call("questions", "list", {"session": sid}) == []


def test_portable_question_signature_includes_scope_and_policy():
    from ma_core.wire import entry_in

    draft = {
        "id": "q",
        "askedBy": "tools",
        "kind": "text",
        "question": "Proceed?",
        "answerers": ["owner"],
        "toolCallId": "call",
        "timeLimitMs": 1200,
        "whenTimeLimit": "leaveOpen",
    }
    row = {
        "id": "entry",
        "kind": "inputRequest",
        "requestId": "q",
        "writer": "questions",
        "data": {"request": draft},
    }
    signature = json.loads(entry_in(row, "session")["data"]["signature"])
    assert (
        signature["responders"],
        signature["call"],
        signature["timeout"],
        signature["park"],
    ) == (
        ["owner"],
        "call",
        1.2,
        True,
    )
    draft["signature"] = json.dumps({"kind": "text", "question": "Proceed?"}, sort_keys=True)
    with pytest.raises(ValueError, match="signature"):
        entry_in(row, "session")
    with pytest.raises(ValueError, match="sessionId"):
        entry_in({"session": "session", "kind": "question_open", "data": draft}, "session")


async def test_timeout_leaves_no_result_then_late_answer_runs_new_turn(agent):
    c = call("ask_user", question="Which?", kind="choice", options=["a", "b"], timeout=0)
    h, a, sid, fake = await agent([reply(calls=[c]), reply("continued")])
    ui = await interface(h, sid)
    first = (await run(a, sid))[-1]
    assert first["outcome"] == "completed" and first["open_calls"] == [c["id"]]
    assert not await entries(a, sid, "tool_result")
    # New input is allowed while the old call is open; only the view says waiting.
    fake.script.append(reply("other"))
    await run(a, sid, "unrelated")
    assert any(m["kind"] == "waiting" for m in fake.requests[-1]["messages"])
    q = (await a.call("questions", "list", {"session": sid}))[0]
    await ui.call(
        "questions", "answer", {"session": sid, "actor": "user", "request": q["id"], "value": "b"}
    )
    await a.call("runtime", "wait", {"session": sid})
    assert len(await entries(a, sid, "turn_start")) == 3
    assert len(await entries(a, sid, "tool_result")) == 1
    assert not any(e["kind"] == "waiting" for e in await entries(a, sid))
    paired(await entries(a, sid))


async def test_secret_goes_only_to_store_with_name_elsewhere(agent):
    secret = "offline-secret-canary-49217"
    h, a, sid, fake = await agent(
        [
            reply(calls=[call("ask_user", question="Token", kind="secret", name="service-login")]),
            reply("saved"),
        ]
    )
    ui = await interface(h, sid)
    events = []

    async def answer(e):
        events.append(e)
        if e["kind"] == "input_request_opened":
            await ui.call(
                "credentials",
                "answer",
                {"session": sid, "actor": "user", "request": e["request"]["id"], "value": secret},
            )

    a.follow("user", answer)
    await run(a, sid)
    assert secret not in json.dumps([await entries(a, sid), events, fake.requests, h.trace])
    assert "service-login" in json.dumps(await entries(a, sid))
    credentials = h.api("source", "tool_source")
    assert await credentials.call("credentials", "get", {"name": "service-login"}) == secret
    path = h.plugins["credentials"].root / "credentials.json"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    with pytest.raises(AgentError, match="credentials"):
        await h.api("runtime", "runtime").call("credentials", "get", {"name": "service-login"})


@pytest.mark.parametrize("name", [None, "claude_login"])
async def test_secret_without_valid_store_name_declines_before_asking(agent, name):
    h, a, sid, fake = await agent()
    result = await a.call(
        "questions", "ask", {"session": sid, "kind": "secret", "question": "Token", "name": name}
    )
    assert result["value"] == "declined"
    assert not await entries(a, sid, "question_open")


async def test_interrupted_question_reasked_only_by_durable_runtime(
    tmp_path, runtime_type, runtime_kind
):
    home = tmp_path / "store"
    c = call("ask_user", question="Continue?", kind="text")
    h = await build(home, Fake([reply(calls=[c])]), runtime=runtime_type())
    sid = (await h.api().session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]
    await interface(h, sid)
    await h.api().call("runtime", "submit", {"session": sid, "content": content("go")})
    await until(lambda: any(e["kind"] == "question_open" for e in h.sessions[sid]["entries"]))
    await h.stop()  # suspend, not session close
    h = await build(home, Fake([reply("after restart")]), runtime=runtime_type())
    a = h.api()
    seen = []
    a.follow("user", lambda e: capture(seen, e))
    try:
        await a.session("open", session=sid)
        ui = await interface(h, sid)
        repeats = (
            runtime_kind == "durable" and h.plugins["local"].declarations["stops_commands_on_crash"]
        )
        if repeats:
            await until(lambda: any(e["kind"] == "input_request_opened" for e in seen))
            q = (await a.call("questions", "list", {"session": sid}))[0]
            await ui.call(
                "questions",
                "answer",
                {"session": sid, "actor": "user", "request": q["id"], "value": "yes"},
            )
        await a.call("runtime", "wait", {"session": sid})
        qs = await a.call("questions", "list", {"session": sid})
        assert len(qs) == 1
        assert bool(qs[0].get("closed")) == (not repeats)
        assert not qs[0]["answerable"]
        (result,) = await entries(a, sid, "tool_result")
        assert result["data"]["status"] == ("completed" if repeats else "outcome_unknown")
        assert (await entries(a, sid, "turn_end"))[-1]["data"]["outcome"] == (
            "completed" if runtime_kind == "durable" else "failed"
        )
        paired(await entries(a, sid))
    finally:
        await h.stop()


async def capture(out, event):
    out.append(event)
