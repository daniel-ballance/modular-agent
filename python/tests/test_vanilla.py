import asyncio
import json
import os

import pytest

from ma_core import content, plain
from ma_fake import call, reply


async def run(a, sid, text="go", **kw):
    receipt = await a.call("runtime", "submit", {"session": sid, "content": content(text), **kw})
    if receipt.get("handled"):
        return receipt
    return await a.call("runtime", "wait", {"session": sid})


async def entries(a, sid, kind=None):
    s = await a.session("get", session=sid)
    return [e for e in s["entries"] if kind is None or e["kind"] == kind]


def paired(es):
    calls = [e["call"] for e in es if e["kind"] == "tool_call"]
    results = [e["call"] for e in es if e["kind"] == "tool_result"]
    assert sorted(calls) == sorted(results)
    assert len(calls) == len(set(calls))


async def test_read_then_answer_and_runtime_credential_free(agent, tmp_path):
    (tmp_path / "facts.txt").write_text("The moon is green.")
    (tmp_path / "AGENTS.md").write_text("Answer in brief sentences.")
    h, a, sid, fake = await agent([reply(calls=[call("read", path="facts.txt")]), reply("green")])
    answers = await run(a, sid)
    assert answers[-1]["outcome"] == "completed"
    assert plain(answers[-1]["content"]) == "green"
    assert len(fake.requests) == 2
    assert "Answer in brief sentences" in fake.requests[0]["system"]
    assert any("moon is green" in plain(m["content"]) for m in fake.requests[1]["messages"])
    es = await entries(a, sid)
    paired(es)
    assert len(await entries(a, sid, "turn_start")) == 1
    assert not any(
        caller == h.capabilities["runtime"][0] and target == "credentials"
        for caller, target, _ in h.trace
    )
    assert not any(
        caller == h.capabilities["runtime"][0] and op in {"catalog", "get_credential"}
        for caller, _, op in h.trace
    )


async def test_tools_write_edit_read_and_atomic_invalid_edits(agent, tmp_path):
    calls = [
        call("write", path="a.txt", text="alpha beta"),
        call("edit", path="a.txt", edits=[{"old": "alpha", "new": "A"}]),
        call("read", path="a.txt"),
    ]
    h, a, sid, fake = await agent([reply(calls=calls), reply("done")])
    await run(a, sid)
    assert (tmp_path / "a.txt").read_text() == "A beta"
    es = await entries(a, sid)
    paired(es)
    assert plain((await entries(a, sid, "tool_result"))[-1]["content"]) == "A beta"
    bad = call(
        "edit", path="a.txt", edits=[{"old": "A", "new": "B"}, {"old": "absent", "new": "C"}]
    )
    fake.script.extend([reply(calls=[bad]), reply("unchanged")])
    await run(a, sid)
    assert (tmp_path / "a.txt").read_text() == "A beta"
    assert (await entries(a, sid, "tool_result"))[-1]["data"]["status"] == "failed"


@pytest.mark.parametrize(
    "calls",
    [
        [call("absent")],
        [call("read", wrong="bad")],
        [call("read", path="not-here")],
        [call("bash", command="exit 7")],
    ],
)
async def test_bad_tools_have_one_result_and_turn_continues(agent, calls):
    h, a, sid, fake = await agent([reply(calls=calls), reply("recovered")])
    result = await run(a, sid)
    assert result[-1]["outcome"] == "completed"
    settlement = (await entries(a, sid, "tool_result"))[0]
    if calls[0]["name"] == "absent":
        assert settlement["data"]["status"] == "refused"
        assert plain(settlement["content"]) == "not offered"
    else:
        assert settlement["data"]["status"] == "failed"
    paired(await entries(a, sid))


async def test_tool_gate_changes_refuses_fails_closed_and_after_replaces(agent, tmp_path):
    h, a, sid, fake = await agent()
    (tmp_path / "x").write_text("ok")

    async def gate(d):
        if d["call"]["input"]["path"] == "throw":
            raise ValueError("policy broken")
        if d["call"]["input"]["path"] == "deny":
            return {**d, "refused": True, "reason": "policy"}
        d["call"]["input"]["path"] = "x"
        return d

    async def after(d):
        if d["result"]["status"] == "completed":
            d["result"]["content"] = content("replaced")
        return d

    h.api("policy").on("tool.before", gate)
    h.api("policy").on("tool.after", after)
    fake.script = [
        reply(calls=[call("read", path=p) for p in ["change", "deny", "throw"]]),
        reply("done"),
    ]
    await run(a, sid)
    rs = await entries(a, sid, "tool_result")
    assert [e["data"]["status"] for e in rs] == ["completed", "refused", "refused"]
    assert plain(rs[0]["content"]) == "replaced"
    paired(await entries(a, sid))


@pytest.mark.parametrize(
    "script,settings,outcome,error",
    [
        ([reply(calls=[call("read", path="absent")])], {"max_steps": 1}, "limit", "step limit"),
        ([{"error": "network down"}], {}, "failed", "network down"),
        ([reply("cut", stop="output_limit")], {}, "limit", "output limit"),
    ],
)
async def test_turn_outcomes(agent, script, settings, outcome, error):
    h, a, sid, fake = await agent(script, settings)
    answer = (await run(a, sid))[-1]
    assert answer["outcome"] == outcome and error in answer["error"]
    paired(await entries(a, sid))


async def wait_for_model(api, sid, fake):
    # Cancellation tests need the dispatch boundary, not a performance target
    # for point creation, durable commits and the Runtime's process round trips.
    entered = asyncio.create_task(fake.entered.wait())
    ended = asyncio.create_task(api.call("runtime", "wait", {"session": sid}))
    try:
        await asyncio.wait((entered, ended), return_when=asyncio.FIRST_COMPLETED)
        if not fake.entered.is_set():
            pytest.fail(f"Turn settled before dispatching to the fake Provider: {ended.result()}")
    finally:
        for task in (entered, ended):
            task.cancel()
        await asyncio.gather(entered, ended, return_exceptions=True)


async def test_cancelling_model_and_queued_input_returned(agent):
    h, a, sid, fake = await agent([{**reply("never"), "wait": True}])
    events = []

    async def follow(e):
        events.append(e)

    a.follow("user", follow)
    await a.call("runtime", "submit", {"session": sid, "content": content("start")})
    await wait_for_model(a, sid, fake)
    for mode in ["steer", "after"]:
        await a.call("runtime", "submit", {"session": sid, "content": content(mode), "when": mode})
    await a.call("runtime", "cancel", {"session": sid})
    assert len([e for e in events if e["kind"] == "input_returned"]) == 2
    assert (await entries(a, sid, "turn_end"))[-1]["data"]["outcome"] == "cancelled"
    assert not (await a.session("get", session=sid))["busy"]


async def test_steering_joins_turn_followup_waits_and_key_is_taken_once(agent):
    h, a, sid, fake = await agent(
        [{**reply("first"), "wait": True}, reply("steered"), reply("followed")]
    )
    first = await a.call(
        "runtime", "submit", {"session": sid, "content": content("start"), "key": "k"}
    )
    await wait_for_model(a, sid, fake)
    again = await a.call(
        "runtime", "submit", {"session": sid, "content": content("different"), "key": "k"}
    )
    assert again["duplicate"] and first["input"] == again["input"]
    await a.call(
        "runtime", "submit", {"session": sid, "content": content("steer"), "when": "steer"}
    )
    await a.call(
        "runtime", "submit", {"session": sid, "content": content("after"), "when": "after"}
    )
    fake.release.set()
    result = await a.call("runtime", "wait", {"session": sid})
    assert len(result) == 2
    assert len(await entries(a, sid, "turn_start")) == 2
    assert "steer" in [plain(m["content"]) for m in fake.requests[1]["messages"]]
    assert "after" not in [plain(m["content"]) for m in fake.requests[1]["messages"]]
    assert "after" in [plain(m["content"]) for m in fake.requests[2]["messages"]]
    await a.call("runtime", "submit", {"session": sid, "content": content("start"), "key": "k"})
    assert len(fake.requests) == 3


async def test_withdraw_queued_input(agent):
    h, a, sid, fake = await agent([{**reply("first"), "wait": True}])
    await a.call("runtime", "submit", {"session": sid, "content": content("start")})
    await fake.entered.wait()
    queued = await a.call(
        "runtime", "submit", {"session": sid, "content": content("after"), "when": "after"}
    )
    assert (await a.call("runtime", "withdraw", {"session": sid, "input": queued["input"]}))[
        "withdrawn"
    ]
    fake.release.set()
    assert len(await a.call("runtime", "wait", {"session": sid})) == 1


@pytest.mark.parametrize("pid_delay", [0, 0.05])
async def test_bash_output_live_background_returns_and_cancel_kills_only_foreground(
    agent, tmp_path, pid_delay
):
    h, a, sid, fake = await agent()
    events, first_output = [], asyncio.Event()

    async def follow(e):
        events.append(e)
        if e["kind"] == "history_entry" and e["entry"]["kind"] == "tool_started":
            first_output.set()

    # Use an ungated progress consumer to prove local streaming independently of
    # the optional guardrail, which deliberately holds recipient streams.
    a.follow("user", follow)
    seen = []

    async def progress(e):
        seen.append(e["text"])

    result = await a.call(
        "environment",
        "bash",
        {"session": sid, "command": "printf first; sleep .1; printf second"},
        progress,
    )
    assert "".join(seen) == "firstsecond" and len(seen) >= 2
    result = await asyncio.wait_for(
        a.call(
            "environment",
            "bash",
            {"session": sid, "command": "sleep 60 & echo $! > background.pid; printf returned"},
        ),
        1,
    )
    assert result["text"] == "returned"
    background = int((tmp_path / "background.pid").read_text())
    os.kill(background, 0)
    fake.script = [
        reply(
            calls=[
                call(
                    "bash",
                    command=f": > foreground.pid; sleep {pid_delay}; echo $$ > foreground.pid; sleep 60",
                ),
                call("read", path="absent"),
            ]
        )
    ]
    await a.call("runtime", "submit", {"session": sid, "content": content("go")})
    await first_output.wait()
    from test_swap import pid_ready, until

    await until(lambda: pid_ready(tmp_path / "foreground.pid"))
    await a.call("runtime", "cancel", {"session": sid})
    foreground = int((tmp_path / "foreground.pid").read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(foreground, 0)
    os.kill(background, 0)
    paired(await entries(a, sid))
    statuses = [e["data"]["status"] for e in await entries(a, sid, "tool_result")]
    assert statuses == ["cancelled", "not_started"]


async def test_context_auto_compaction_appends_and_overflow_retries(agent):
    h, a, sid, fake = await agent([reply("a" * 100), reply("done")], {"context_budget": 1})
    await run(a, sid)
    before = await entries(a, sid)
    await run(a, sid, "continue")
    summaries = await entries(a, sid, "summary")
    assert summaries and summaries[-1]["copies"]
    after = await entries(a, sid)
    assert all(e in after for e in before)
    assert fake.discards
    fake.script = [{"error": "too long", "code": "context_too_large"}, reply("retry success")]
    result = await run(a, sid, "overflow")
    assert result[-1]["outcome"] == "completed"
    assert len(await entries(a, sid, "summary")) >= 3


async def test_compact_and_settings_commands_do_not_start_turns(agent):
    h, a, sid, fake = await agent([reply("answer")])
    await run(a, sid)
    turns = len(await entries(a, sid, "turn_start"))
    await run(a, sid, "/thinking high")
    await run(a, sid, "/model fake")
    await run(a, sid, "/compact")
    assert len(await entries(a, sid, "turn_start")) == turns
    assert (await a.session("get", session=sid))["settings"]["thinking"] == "high"
    # The initial portable setting snapshot precedes the two commands.
    assert len(await entries(a, sid, "setting")) == 3
    assert len(await entries(a, sid, "summary")) == 1
    assert set(await a.session("commands")) >= {"compact", "model", "thinking", "tree"}


async def test_config_project_scoping_and_settings_survive_restart(agent, tmp_path):
    h, a, sid, fake = await agent()
    store = h.plugins["config"].root
    store.mkdir(parents=True, exist_ok=True)
    (store / "settings.json").write_text(json.dumps({"thinking": "low", "max_steps": 7}))
    project = tmp_path / "other"
    (project / ".modular-agent").mkdir(parents=True)
    (project / ".modular-agent" / "settings.json").write_text(json.dumps({"thinking": "high"}))
    (project / "AGENTS.md").write_text("OTHER PROJECT")
    (project / "local.txt").write_text("other file")
    s = await a.session("create", project=str(project), settings={"model": "fake"})
    assert s["settings"]["thinking"] == "high" and s["settings"]["max_steps"] == 7
    fake.script = [reply(calls=[call("read", path="local.txt")]), reply("done")]
    await run(a, s["id"])
    assert "OTHER PROJECT" in fake.requests[0]["system"]
    assert "other file" == plain((await entries(a, s["id"], "tool_result"))[0]["content"])
    await run(a, s["id"], "/thinking low")
    await a.session("close", session=s["id"])
    reopened = await a.session("open", session=s["id"])
    assert reopened["settings"]["thinking"] == "low"


async def test_output_gate_holds_split_secret_and_record_is_original(agent):
    secret = "TOP-SECRET"
    h, a, sid, fake = await agent(
        [{**reply(secret), "pieces": ["TOP-", "SEC", "RET"]}], secrets=[secret]
    )
    events = []

    async def follow(e):
        events.append(e)

    a.follow("reader", follow)
    await run(a, sid)
    output = [e for e in events if e["kind"] == "model_output"]
    assert len(output) == 1 and output[0]["text"] == "[REDACTED]"
    assert secret not in json.dumps(events)
    assert plain((await entries(a, sid, "response"))[0]["content"]) == secret
    view = await a.session("view", value=await entries(a, sid), recipient="reader")
    assert secret not in json.dumps(view)


async def test_result_validation_can_continue_same_turn(agent):
    h, a, sid, fake = await agent([reply("bad"), reply("good")])

    async def validate(d):
        return {"retry": True, "reason": "Need good"} if plain(d["result"]) == "bad" else None

    h.api("validator").on("result.ready", validate)
    result = await run(a, sid)
    assert len(result) == 1 and plain(result[0]["content"]) == "good"
    (feedback,) = await entries(a, sid, "result_feedback")
    assert feedback["data"] == {"reason": "Need good"}
    assert feedback["turn"] == result[0]["turn"]
    assert any(m.get("id") == feedback["id"] for m in fake.requests[-1]["messages"])
    assert feedback["id"] in (await entries(a, sid, "model_started"))[-1]["copies"]


async def test_recovery_settles_or_resumes_as_declared(agent, runtime_kind):
    h, a, sid, fake = await agent([reply("carried on")])
    queued = await a.session(
        "append", session=sid, kind="input_queued", content=content("go"), data={"when": "now"}
    )
    await a.session(
        "append",
        session=sid,
        kind="turn_start",
        turn="interrupted",
        data={"input": queued["id"]},
        first_input={
            "session": sid,
            "content": content("go"),
            "visible": True,
            "actor": "user",
            "data": {"input": queued["id"]},
            "copies": [queued["id"]],
        },
    )
    calls = [
        {"id": cid, "name": "bash", "input": {"command": "true"}} for cid in ["started", "waiting"]
    ]
    await a.session("append", session=sid, kind="step_start", turn="interrupted", step="step")
    await a.session(
        "append",
        session=sid,
        kind="model_started",
        turn="interrupted",
        step="step",
        data={
            "model": {"provider": "fake", "id": "fake"},
            "tools": ["bash"],
            "safeToRepeat": False,
            "tracksStepAfter": True,
        },
    )
    await a.session(
        "append",
        session=sid,
        kind="response",
        turn="interrupted",
        step="step",
        data={"calls": calls, "stop": "tools", "usage": {}},
    )
    for cid in ["started", "waiting"]:
        await a.session(
            "append",
            session=sid,
            kind="tool_call",
            turn="interrupted",
            call=cid,
            step="step",
            data=next(c for c in calls if c["id"] == cid),
        )
    await a.session("append", session=sid, kind="tool_started", turn="interrupted", call="started")
    await a.session("close", session=sid)
    await a.session("open", session=sid)
    await a.call("runtime", "wait", {"session": sid})
    results = await entries(a, sid, "tool_result")
    assert [e["data"]["status"] for e in results] == [
        "outcome_unknown",
        "completed" if runtime_kind == "durable" else "not_started",
    ]
    assert (await entries(a, sid, "turn_end"))[-1]["data"]["outcome"] == (
        "completed" if runtime_kind == "durable" else "failed"
    )
    paired(await entries(a, sid))
    assert bool(fake.requests) == (runtime_kind == "durable")
