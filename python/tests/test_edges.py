"""Acceptance edge cases found in the final audit, all offline."""

import asyncio
import json
import os
import sys

import pytest

from ma_core import AgentError, content, plain
from ma_fake import call, reply
from test_vanilla import entries, run


async def test_fork_does_not_readmit_already_consumed_input(agent):
    h, a, sid, fake = await agent([reply("original"), reply("child")])
    await run(a, sid, "parent input")
    child = await a.session("fork", session=sid)
    out = await run(a, child["id"], "child input")
    assert len(out) == 1 and out[0]["outcome"] == "completed"
    assert plain(out[0]["content"]) == "child"


async def test_erasing_input_reaches_admission_and_tool_result_copies(agent, tmp_path):
    secret = "ERASURE-ONLY-9482"
    h, a, sid, fake = await agent(
        [reply(calls=[call("bash", command="printf " + secret)]), reply(secret)]
    )
    await run(a, sid, "Print " + secret)
    user = (await entries(a, sid, "input"))[0]
    await a.session("erase", session=sid, entries=[user["id"]])
    assert secret not in json.dumps(await entries(a, sid))
    assert secret.encode() not in h.plugins["history"].db.read_bytes()
    from plugin_state import keys

    assert sid not in await keys(h.plugins[h.capabilities["runtime"][0]], "tasks")
    assert not fake.requests


async def test_erasing_fork_copy_reaches_original_and_siblings(agent):
    secret = "FORK-PRIVATE-91"
    h, a, sid, fake = await agent([reply(secret)])
    await run(a, sid, secret)
    child = await a.session("fork", session=sid)
    sibling = await a.session("fork", session=sid)
    user = (await entries(a, child["id"], "input"))[0]
    await a.session("erase", session=child["id"], entries=[user["id"]])
    for session in (sid, child["id"], sibling["id"]):
        assert secret not in json.dumps(await entries(a, session))


async def test_settings_change_and_record_share_one_store_commit(agent):
    h, a, sid, fake = await agent()
    calls = []
    store = h.plugins["history"]
    keep = store.keep

    async def count(d, emit):
        calls.append(d)
        return await keep(d, emit)

    store.keep = count
    await a.session("settings", session=sid, changes={"thinking": "low"})
    assert len(calls) == 1
    assert calls[0]["entries"][0]["kind"] == "setting"
    assert calls[0]["session"]["settings"]["thinking"] == "low"


async def test_key_deduplication_survives_reopen(agent):
    h, a, sid, fake = await agent([reply("once")])
    await run(a, sid, "one", key="key")
    await a.session("close", session=sid)
    await a.session("open", session=sid)
    receipt = await a.call(
        "runtime", "submit", {"session": sid, "content": content("two"), "key": "key"}
    )
    assert receipt["duplicate"]
    assert len(await entries(a, sid, "turn_start")) == 1


async def test_settings_changes_apply_to_next_request_and_refuse_midturn(agent):
    h, a, sid, fake = await agent([{**reply("first"), "wait": True}, reply("second")])
    original_catalog = fake.catalog

    async def catalog(d, emit):
        models = await original_catalog(d, emit)
        return models + [{**models[0], "id": "fake-alt"}]

    fake.catalog = catalog
    await a.call("runtime", "submit", {"session": sid, "content": content("one")})
    await fake.entered.wait()
    with pytest.raises(AgentError, match="between turns"):
        await a.session("command", session=sid, text="/model fake-alt")
    fake.release.set()
    await a.call("runtime", "wait", {"session": sid})
    await run(a, sid, "/model fake-alt")
    await run(a, sid, "/thinking high")
    await run(a, sid, "next")
    assert fake.requests[-1]["access"]["id"] == "fake-alt"
    assert fake.requests[-1]["settings"]["thinking"] == "high"


async def test_default_bash_stream_reaches_interface_before_call_ends(agent):
    h, a, sid, fake = await agent(
        [reply(calls=[call("bash", command="printf live; sleep .15")]), reply("done")]
    )
    live = asyncio.Event()

    async def follow(e):
        if e["kind"] == "tool_progress" and plain(e["content"]) == "live":
            assert not any(x["kind"] == "tool_result" for x in await entries(a, sid))
            live.set()

    a.follow("user", follow)
    await a.call("runtime", "submit", {"session": sid, "content": content("go")})
    await asyncio.wait_for(live.wait(), 1)
    await a.call("runtime", "wait", {"session": sid})


async def test_output_gate_exception_exposes_nothing(agent):
    h, a, sid, fake = await agent([reply("private")])

    async def broken(d):
        raise ValueError("do not expose raw output")

    h.api("broken-guard").on("output", broken, "first")
    seen = []

    async def follow(e):
        seen.append(e)

    a.follow("reader", follow)
    await run(a, sid)
    assert not seen
    assert plain((await entries(a, sid, "response"))[0]["content"]) == "private"


async def test_full_vanilla_unused_session_creates_no_store(agent):
    h, a, sid, fake = await agent()
    root = h.plugins["history"].root
    await a.session("get", session=sid)
    await a.session("close", session=sid)
    assert not root.exists()


async def test_shell_background_stopped_and_reaped_at_session_close(agent, tmp_path):
    h, a, sid, fake = await agent()
    await a.call("environment", "bash", {"session": sid, "command": "sleep 60 & echo $! > pid"})
    pid = int((tmp_path / "pid").read_text())
    os.kill(pid, 0)
    await a.session("close", session=sid)
    if sys.platform == "darwin":
        from test_swap import dead, until

        await until(lambda: dead(pid))
        return
    # PID 1 reaps an orphan on this local machine. A zombie is already dead, but
    # do not leave a live command behind and do not treat it as a surviving job.
    for _ in range(100):
        try:
            state = __import__("pathlib").Path(f"/proc/{pid}/stat").read_text().split()[2]
        except FileNotFoundError:
            return
        assert state in {"Z", "X"}
        await asyncio.sleep(0.01)
    pytest.fail("Background child was not reaped")
