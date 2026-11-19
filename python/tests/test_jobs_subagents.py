"""Offline integration proofs for jobs, both subagent variants and result checks."""

import asyncio
from collections import defaultdict
from pathlib import Path

import pytest

from ma_core import AgentError, clone, content, plain
from ma_fake import Fake, call, reply
from modular_agent import build
from test_questions import interface
from test_swap import dead, pid_ready, until
from test_vanilla import entries, paired, run


class RoutedFake(Fake):
    def __init__(self, route):
        super().__init__()
        self.route = route
        self.counts = defaultdict(int)

    async def generate(self, d, emit):
        self.requests.append(clone(d))
        sid = d["session"]
        index = self.counts[sid]
        self.counts[sid] += 1
        return await self.route(d, index)


async def test_background_child_bash_report_starts_parent_turn(tmp_path, runtime_type):
    root = None
    child_started, release = asyncio.Event(), asyncio.Event()

    async def route(d, index):
        if d["session"] == root:
            return (
                reply(calls=[call("delegate", task="Write proof with bash", background=True)])
                if index == 0
                else reply(
                    "parent first finished" if index == 1 else "parent describes the child report"
                )
            )
        if index == 0:
            child_started.set()
            await release.wait()
            return reply(calls=[call("bash", command="printf CHILD-617 > child-proof")])
        return reply("I wrote child-proof with bash, CHILD-617.")

    provider = RoutedFake(route)
    h = await build(tmp_path / "store", provider, runtime=runtime_type())
    a = h.api()
    try:
        root = (await a.session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]
        await run(a, root, "parent-only-private-input")
        await child_started.wait()
        job = (await a.call("jobs", "list", {"session": root}))[0]
        assert job["state"] == "running"
        assert len(await entries(a, root, "turn_end")) == 1
        release.set()
        await a.call("jobs", "wait", {"session": root, "job": job["id"]})
        await until(
            lambda: len([e for e in h.sessions[root]["entries"] if e["kind"] == "turn_end"]) == 2
        )
        assert (tmp_path / "child-proof").read_text() == "CHILD-617"
        assert (
            len(await entries(a, root, "job_start")) == len(await entries(a, root, "job_end")) == 1
        )
        child = job["detail"]["child"]
        first = next(r for r in provider.requests if r["session"] == child)
        assert "parent-only-private-input" not in str(first)
        assert "Write proof with bash" in str(first)
        report = (await entries(a, root, "input"))[-1]
        assert report["job"] == job["id"] and report["data"]["source"]["job"] == job["id"]
        assert "CHILD-617" in str(provider.requests[-1]["messages"])
        assert (await a.call("jobs", "usage", {"session": root}))["input_tokens"] == 50
        paired(await entries(a, root))
        paired(await entries(a, child))
    finally:
        release.set()
        await h.stop()


async def test_wait_and_followup_keep_child_history_without_duplicate_report(
    tmp_path, runtime_type
):
    async def route(d, index):
        return reply("remember CHILD-MEMORY-193" if index == 0 else "I remember CHILD-MEMORY-193")

    provider = RoutedFake(route)
    h = await build(tmp_path / "store", provider, runtime=runtime_type())
    a = h.api()
    try:
        sid = (await a.session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]
        ui = await interface(h, sid)
        first = await ui.call(
            "runtime",
            "run_tool",
            {
                "session": sid,
                "name": "delegate",
                "input": {"task": "remember this", "background": False},
            },
        )
        assert "CHILD-MEMORY-193" in plain(first["content"])
        child = first["value"]["child"]
        second = await ui.call(
            "runtime",
            "run_tool",
            {
                "session": sid,
                "name": "delegate",
                "input": {"task": "What do you remember?", "child": child, "background": False},
            },
        )
        assert second["value"]["child"] == child
        assert "CHILD-MEMORY-193" in str(provider.requests[-1]["messages"])
        assert len(await entries(a, sid, "job_end")) == 2
        assert not await entries(a, sid, "input")  # wait answers only through the tool
        assert len(await entries(a, child, "turn_start")) == 2
        paired(await entries(a, sid))
    finally:
        await h.stop()


@pytest.mark.parametrize("kind", ["choice", "secret"])
async def test_child_questions_reach_top_user_through_two_parents(tmp_path, runtime_type, kind):
    root = None

    async def route(d, index):
        if d["session"] == root:
            return (
                reply(calls=[call("delegate", task="Ask a grandchild", background=False)])
                if index == 0
                else reply("root done")
            )
        cs = await h.api().session("get", session=d["session"])
        if cs["origin"]["depth"] == 1:
            return (
                reply(calls=[call("delegate", task="Ask the top user", background=False)])
                if index == 0
                else reply("middle done")
            )
        return (
            reply(
                calls=[
                    call(
                        "ask_user",
                        question="Pick one",
                        kind=kind,
                        options=["yes", "no"],
                        name="grandchild-credential",
                    )
                ]
            )
            if index == 0
            else reply("grandchild answered")
        )

    provider = RoutedFake(route)
    h = await build(tmp_path / "store", provider, runtime=runtime_type())
    a = h.api()
    try:
        root = (await a.session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]
        ui = await interface(h, root)
        opened = []

        async def answer(e):
            if e["kind"] == "input_request_opened":
                opened.append(e)
                if e["session"] == root:
                    await ui.call(
                        "credentials" if kind == "secret" else "questions",
                        "answer",
                        {
                            "session": root,
                            "actor": "user",
                            "request": e["request"]["id"],
                            "value": "yes",
                        },
                    )

        a.follow("user", answer)
        out = await asyncio.wait_for(run(a, root), 3)
        assert out[-1]["outcome"] == "completed"
        assert len({e["session"] for e in opened}) == 3
        for sid in h.sessions:
            answers = await entries(a, sid, "question_answer")
            assert len(answers) == 1
            assert answers[0]["data"]["value"] == (
                {"credential": "grandchild-credential"} if kind == "secret" else "yes"
            )
            assert answers[0]["actor"] == ("user" if sid == root else h.sessions[sid]["actor"])
    finally:
        await h.stop()


async def test_depth_limit_and_authority_never_widen(tmp_path, runtime_type):
    async def route(d, index):
        return (
            reply(calls=[call("delegate", task="go deeper", background=False)])
            if index == 0
            else reply("finished")
        )

    h = await build(tmp_path / "store", RoutedFake(route), runtime=runtime_type())
    a = h.api()
    try:
        root = (
            await a.session(
                "create",
                project=str(tmp_path),
                settings={"model": "fake", "max_depth": 1},
                authority=["watch", "input", "tools", "jobs", "delegate"],
            )
        )["id"]
        await run(a, root)
        job = (await a.call("jobs", "list", {"session": root}))[0]
        child = job["detail"]["child"]
        rights = await a.session("authority", session=child, actor=h.sessions[child]["actor"])
        assert set(rights) <= set(h.sessions[root]["authority"])
        results = await entries(a, child, "tool_result")
        assert "depth limit" in plain(results[0]["content"])
        assert len(h.sessions) == 2
    finally:
        await h.stop()


async def test_cancel_parent_turn_leaves_job_running(tmp_path, runtime_type):
    root = None
    child_entered, parent_entered, release = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def route(d, index):
        if d["session"] == root:
            if index == 0:
                return reply(calls=[call("delegate", task="background", background=True)])
            if index == 1:
                parent_entered.set()
                await asyncio.Event().wait()
            return reply("report acknowledged")
        child_entered.set()
        await release.wait()
        return reply("child finished")

    h = await build(tmp_path / "store", RoutedFake(route), runtime=runtime_type())
    a = h.api()
    try:
        root = (await a.session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]
        await a.call("runtime", "submit", {"session": root, "content": content("go")})
        await asyncio.wait_for(parent_entered.wait(), 2)
        await child_entered.wait()
        await a.call("runtime", "cancel", {"session": root})
        job = (await a.call("jobs", "list", {"session": root}))[0]
        assert job["state"] == "running"
        release.set()
        result = await a.call("jobs", "wait", {"session": root, "job": job["id"]})
        assert result["state"] == "completed"
        await a.call("runtime", "wait", {"session": root})
    finally:
        release.set()
        await h.stop()


async def test_cancel_job_stops_child_bash_and_session_close_stops_jobs(tmp_path, runtime_type):
    sid = None

    async def route(d, index):
        if d["session"] == sid:
            return reply("cancel report acknowledged")
        return (
            reply(calls=[call("bash", command="echo $$ > child.pid; sleep 60")])
            if index == 0
            else reply("finished")
        )

    h = await build(tmp_path / "store", RoutedFake(route), runtime=runtime_type())
    a = h.api()
    pid = None
    try:
        sid = (await a.session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]
        ui = await interface(h, sid)
        started = await ui.call(
            "runtime",
            "run_tool",
            {"session": sid, "name": "delegate", "input": {"task": "bash", "background": True}},
        )
        await until(lambda: pid_ready(tmp_path / "child.pid"))
        pid = int((tmp_path / "child.pid").read_text())
        ended = await ui.call("jobs", "cancel", {"session": sid, "job": started["value"]["job"]})
        assert ended["state"] == "cancelled" and dead(pid)
        await a.call("runtime", "wait", {"session": sid})
        await a.session("close", session=sid)
        assert not h.sessions
    finally:
        await h.stop()
        if pid:
            assert not Path(f"/proc/{pid}").exists()


async def test_job_usage_enforces_session_budget_and_reports_are_not_commands(agent):
    h, a, sid, fake = await agent([reply("must not call")], settings={"max_tokens": 10})
    owner = h.api("work", "feature")
    job = await owner.call("jobs", "create", {"session": sid, "kind": "test", "key": "once"})
    assert (await owner.call("jobs", "create", {"session": sid, "kind": "test", "key": "once"}))[
        "id"
    ] == job["id"]
    with pytest.raises(AgentError, match="owner"):
        await a.call(
            "jobs", "report", {"session": sid, "job": job["id"], "result": content("forged")}
        )
    await owner.call(
        "jobs",
        "report",
        {
            "session": sid,
            "job": job["id"],
            "result": content("/model other"),
            "usage": {"input_tokens": 20},
        },
    )
    results = await a.call("runtime", "wait", {"session": sid})
    assert results[-1]["outcome"] == "limit" and not fake.requests
    assert h.sessions[sid]["settings"]["model"] == "fake"
    assert len(await entries(a, sid, "input")) == 1


async def test_result_checker_retries_inside_same_turn_and_is_step_bounded(agent):
    h, a, sid, fake = await agent([reply("bad"), reply("good")])

    async def check(d):
        return {"retry": True, "reason": "Use good"} if plain(d["result"]) != "good" else None

    a.on("result.ready", check)
    result = (await run(a, sid))[-1]
    assert result["outcome"] == "completed" and plain(result["content"]) == "good"
    assert len(await entries(a, sid, "turn_start")) == 1
    assert "Use good" in str(fake.requests[-1]["messages"])
    h.sessions[sid]["settings"]["max_steps"] = 1
    fake.script.append(reply("bad"))
    assert (await run(a, sid))[-1]["outcome"] == "limit"
