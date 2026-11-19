"""Question liveness belongs to the job, not the parent's current turn."""

import asyncio

from ma_core import content
from ma_fake import Fake, call, reply
from modular_agent import build
from test_jobs_subagents import RoutedFake
from test_questions import interface
from test_swap import until
from test_vanilla import entries


async def test_parent_cancellation_keeps_background_child_question_answerable(
    tmp_path, runtime_type
):
    root = None
    parent_waiting = asyncio.Event()

    async def route(d, index):
        if d["session"] == root:
            if index == 0:
                return reply(calls=[call("delegate", task="ask a question", background=True)])
            if index == 1:
                parent_waiting.set()
                await asyncio.Event().wait()
            return reply("report received")
        return (
            reply(calls=[call("ask_user", question="Child needs text")])
            if index == 0
            else reply("child done")
        )

    h = await build(tmp_path / "store", RoutedFake(route), runtime=runtime_type())
    a = h.api()
    try:
        root = (await a.session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]
        ui = await interface(h, root)
        await a.call("runtime", "submit", {"session": root, "content": content("go")})
        await parent_waiting.wait()
        await until(lambda: any(e["kind"] == "question_open" for e in h.sessions[root]["entries"]))
        await a.call("runtime", "cancel", {"session": root})
        q = (await a.call("questions", "list", {"session": root}))[0]
        assert q["answerable"]
        await ui.call(
            "questions",
            "answer",
            {"session": root, "actor": "user", "request": q["id"], "value": "answer"},
        )
        job = (await a.call("jobs", "list", {"session": root}))[0]
        assert (await a.call("jobs", "wait", {"session": root, "job": job["id"]}))[
            "state"
        ] == "completed"
        await a.call("runtime", "wait", {"session": root})
    finally:
        await h.stop()


async def test_durable_parked_child_question_reannounces_and_accepts_before_child_opens(
    tmp_path, runtime_type
):
    from ma_durable_subagents import DurableSubagents

    async def route(d, index):
        return reply(calls=[call("ask_user", question="Parked child question", timeout=0)])

    home = tmp_path / "store"
    h = await build(home, RoutedFake(route), runtime=runtime_type(), subagents=DurableSubagents())
    a = h.api()
    root = (await a.session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]
    await interface(h, root)
    await a.call(
        "runtime",
        "run_tool",
        {"session": root, "name": "delegate", "input": {"task": "question", "background": True}},
    )
    await until(lambda: any(e["kind"] == "question_open" for e in h.sessions[root]["entries"]))
    child = (await a.call("jobs", "list", {"session": root}))[0]["detail"]["child"]
    await a.call("runtime", "wait", {"session": child})
    await h.stop()
    h = await build(
        home,
        Fake([reply("child answered"), reply("report handled")]),
        runtime=runtime_type(),
        subagents=DurableSubagents(),
    )
    a = h.api()
    seen = []

    async def answer(e):
        if e["kind"] == "input_request_opened" and e["session"] == root:
            seen.append(e)
            await a.call(
                "questions",
                "answer",
                {
                    "session": root,
                    "actor": "user",
                    "request": e["request"]["id"],
                    "value": "late answer",
                },
            )

    a.follow("user", answer)
    try:
        await a.session("open", session=root)
        job = (await a.call("jobs", "list", {"session": root}))[0]
        await a.call("jobs", "wait", {"session": root, "job": job["id"]})
        await a.call("runtime", "wait", {"session": root})
        assert seen and (await a.call("jobs", "list", {"session": root}))[0]["state"] == "completed"
        assert len(await entries(a, child, "tool_result")) == 1
        assert (await entries(a, child, "question_answer"))[0]["data"]["value"] == "late answer"
    finally:
        await h.stop()


async def test_transient_job_loss_closes_forwarded_proxy_without_resuming_child(
    tmp_path, runtime_type
):
    root = None

    async def route(d, index):
        return reply(calls=[call("ask_user", question="Unfinished child question")])

    home = tmp_path / "store"
    h = await build(home, RoutedFake(route), runtime=runtime_type())
    a = h.api()
    root = (await a.session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]
    await interface(h, root)
    await a.call(
        "runtime",
        "run_tool",
        {"session": root, "name": "delegate", "input": {"task": "question", "background": True}},
    )
    await until(lambda: any(e["kind"] == "question_open" for e in h.sessions[root]["entries"]))
    await h.stop()
    provider = Fake([reply("unknown job acknowledged")])
    h = await build(home, provider, runtime=runtime_type())
    a = h.api()
    try:
        await a.session("open", session=root)
        await a.call("runtime", "wait", {"session": root})
        qs = await a.call("questions", "list", {"session": root})
        assert len(qs) == 1 and not qs[0]["answerable"]
        assert all(r["session"] == root for r in provider.requests)
        job = (await a.call("jobs", "list", {"session": root}))[0]
        child = job["detail"]["child"]
        calls = await entries(a, child, "tool_call")
        results = await entries(a, child, "tool_result")
        assert len(calls) == len(results) == 1
        assert job["state"] == "outcome_unknown"
    finally:
        await h.stop()
