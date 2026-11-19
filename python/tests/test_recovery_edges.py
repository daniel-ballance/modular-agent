"""Persisted recovery states that are difficult to time with a real SIGKILL."""

import asyncio

import pytest

from ma_core import content, plain
from ma_core.wire import tool_out
from ma_fake import call, reply
from test_vanilla import entries, paired


async def seed(a, sid, calls, definitions, started=(), receipts=()):
    queued = await a.session(
        "append", session=sid, kind="input_queued", content=content("go"), data={"when": "now"}
    )
    await a.session(
        "append", session=sid, kind="turn_start", turn="turn", data={"input": queued["id"]}
    )
    await a.session(
        "append",
        session=sid,
        kind="input",
        turn="turn",
        visible=True,
        content=content("go"),
        data={"input": queued["id"]},
    )
    await a.session("append", session=sid, kind="step_start", turn="turn", step="step")
    await a.session(
        "append",
        session=sid,
        kind="model_started",
        turn="turn",
        step="step",
        data={
            "model": {"provider": "fake", "id": "fake"},
            "tools": [c["name"] for c in calls],
            "safeToRepeat": False,
            "tracksStepAfter": True,
        },
    )
    await a.session(
        "append",
        session=sid,
        kind="response",
        turn="turn",
        step="step",
        data={"calls": calls, "stop": "tools", "usage": {"input_tokens": 10}},
    )
    for c, definition in zip(calls, definitions):
        await a.session(
            "append",
            session=sid,
            kind="tool_call",
            turn="turn",
            step="step",
            call=c["id"],
            visible=True,
            data={**c, "definition": definition},
        )
        if c["id"] in started:
            await a.session(
                "append",
                session=sid,
                kind="tool_started",
                turn="turn",
                step="step",
                call=c["id"],
                data={
                    "call": c,
                    "definition": tool_out(definition),
                    "source": {"plugin": "local", "toolSource": definition.get("target", "files")},
                    "safeToRepeat": bool(definition.get("hints", {}).get("safe_to_repeat")),
                },
            )
        if c["id"] in receipts:
            await a.session(
                "append",
                session=sid,
                kind="tool_finished",
                turn="turn",
                step="step",
                call=c["id"],
                data={"status": "completed", "content": content("already finished")},
            )


@pytest.mark.parametrize(
    "recorded_safe,current_safe,cleanup",
    [(True, True, True), (False, True, True), (True, False, True), (True, True, False)],
)
async def test_replay_requires_both_safety_hints_and_environment_guarantee(
    agent, runtime_kind, recorded_safe, current_safe, cleanup
):
    h, a, sid, fake = await agent([reply("continued")])
    tool = next(
        t for t in await a.call("tools", "definitions", {"session": sid}) if t["name"] == "read"
    )
    prior = {**tool, "hints": {"safe_to_repeat": recorded_safe}}
    c = call("read", path="facts")
    await seed(a, sid, [c], [prior], started=[c["id"]])
    source = h.plugins["files"]
    original_definitions = source.definitions

    async def definitions(d, emit):
        return [
            {**t, "hints": {**t["hints"], "safe_to_repeat": current_safe}}
            for t in await original_definitions(d, emit)
        ]

    source.definitions = definitions
    local = h.plugins["local"]
    local.declarations = {**local.declarations, "stops_commands_on_crash": cleanup}
    attempts = []
    original_read = local.read

    async def read(d, emit):
        if d["path"] == "AGENTS.md":
            return await original_read(d, emit)
        attempts.append(d["path"])
        return "repeated"

    local.read = read
    await a.session("close", session=sid)
    await a.session("open", session=sid)
    await a.call("runtime", "wait", {"session": sid})
    expected_replay = runtime_kind == "durable" and recorded_safe and current_safe and cleanup
    assert bool(attempts) == expected_replay
    assert (await entries(a, sid, "tool_result"))[0]["data"]["status"] == (
        "completed" if expected_replay else "outcome_unknown"
    )
    paired(await entries(a, sid))


async def test_later_parallel_receipt_survives_before_first_result(agent, runtime_kind):
    h, a, sid, fake = await agent([reply("continued")])
    tool = next(
        t for t in await a.call("tools", "definitions", {"session": sid}) if t["name"] == "read"
    )
    calls = [call("read", path="first"), call("read", path="second")]
    await seed(
        a, sid, calls, [tool, tool], started=[c["id"] for c in calls], receipts=[calls[1]["id"]]
    )
    original = h.plugins["local"].read
    attempts = []

    async def read(d, emit):
        if d["path"] == "AGENTS.md":
            return await original(d, emit)
        attempts.append(d["path"])
        return d["path"]

    h.plugins["local"].read = read
    await a.session("close", session=sid)
    await a.session("open", session=sid)
    await a.call("runtime", "wait", {"session": sid})
    assert attempts == (["first"] if runtime_kind == "durable" else [])
    results = await entries(a, sid, "tool_result")
    assert [e["call"] for e in results] == [c["id"] for c in calls]
    assert plain(results[1]["content"]) == "already finished"
    paired(await entries(a, sid))


async def test_recovery_preserves_step_budget_and_is_idempotent(agent, runtime_kind):
    h, a, sid, fake = await agent([reply("must not request")], settings={"max_steps": 1})
    c = call("read", path="absent")
    tool = next(
        t for t in await a.call("tools", "definitions", {"session": sid}) if t["name"] == "read"
    )
    await seed(a, sid, [c], [tool])
    await a.session("close", session=sid)
    await a.session("open", session=sid)
    await a.call("runtime", "wait", {"session": sid})
    assert not fake.requests
    answer = (await entries(a, sid, "turn_end"))[-1]["data"]
    assert answer["outcome"] == ("limit" if runtime_kind == "durable" else "failed")
    for _ in range(2):
        await a.call("runtime", "recover", {"session": sid})
        await a.call("runtime", "wait", {"session": sid})
    assert len(await entries(a, sid, "turn_end")) == 1
    paired(await entries(a, sid))


@pytest.mark.parametrize("provider", [{"stateful": True, "runs_tools": True}, {"stateful": True}])
async def test_unknown_native_provider_effects_are_not_repeated(agent, runtime_kind, provider):
    h, a, sid, fake = await agent([reply("must not request")])
    await seed(a, sid, [], [])
    # An interrupted request in a second step has no response or tool list yet.
    await a.session(
        "append", session=sid, kind="step_end", turn="turn", step="step", data={"continue": True}
    )
    await a.session("append", session=sid, kind="step_start", turn="turn", step="native")
    await a.session(
        "append",
        session=sid,
        kind="model_started",
        turn="turn",
        step="native",
        data={"provider": provider},
    )
    await a.session("close", session=sid)
    await a.session("open", session=sid)
    await a.call("runtime", "wait", {"session": sid})
    assert not fake.requests
    end = (await entries(a, sid, "turn_end"))[-1]["data"]
    assert end["outcome"] == "failed"
    if runtime_kind == "durable":
        assert "unknown outside effects" in end["error"]


async def test_gate_reruns_on_safe_recovery(agent, runtime_kind):
    h, a, sid, fake = await agent([reply("continued")])
    tool = next(
        t for t in await a.call("tools", "definitions", {"session": sid}) if t["name"] == "read"
    )
    c = call("read", path="absent")
    await seed(a, sid, [c], [tool], started=[c["id"]])
    checks = []

    async def gate(d):
        checks.append(d["call"]["id"])
        return {**d, "refused": True, "reason": "new policy"}

    h.api("policy").on("tool.before", gate)
    await a.session("close", session=sid)
    await a.session("open", session=sid)
    await a.call("runtime", "wait", {"session": sid})
    assert checks == ([c["id"]] if runtime_kind == "durable" else [])
    # The new policy kept the tool from running again, but cannot tell us
    # how its earlier execution ended.
    assert (await entries(a, sid, "tool_result"))[0]["data"]["status"] == "outcome_unknown"


async def test_recover_call_while_resuming_does_not_spawn_duplicate_turn(agent, runtime_kind):
    h, a, sid, fake = await agent([{**reply("continued"), "wait": True}])
    await seed(a, sid, [], [])
    # Remove a complete response by starting an unresolved next step.
    await a.session(
        "append", session=sid, kind="step_end", turn="turn", step="step", data={"continue": True}
    )
    await a.session("close", session=sid)
    await a.session("open", session=sid)
    if runtime_kind == "durable":
        await asyncio.wait_for(fake.entered.wait(), 1)
        await a.call("runtime", "recover", {"session": sid})
        fake.release.set()
    await a.call("runtime", "wait", {"session": sid})
    assert len(await entries(a, sid, "turn_end")) == 1
