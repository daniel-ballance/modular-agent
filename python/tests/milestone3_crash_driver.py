"""Offline SIGKILL fixture for question and subagent recovery. Never inference."""

import asyncio
import json
import sys
from pathlib import Path

from ma_core import content
from ma_durable import Durable
from ma_durable_subagents import DurableSubagents
from ma_fake import Fake, call, reply
from ma_runtime import Runtime
from ma_subagents import Subagents
from ma_cli import build


async def main():
    home, project, runtime, variant, action = sys.argv[1:]
    home, project = Path(home), Path(project)
    rt = Durable() if runtime == "durable" else Runtime()
    sub = DurableSubagents() if variant == "durable" else Subagents()
    is_job = action.startswith("job")
    reopening = action.endswith("reopen")
    provider = (
        Fake([reply("real-child-result"), reply("parent consumed report")]) if reopening else Fake()
    )
    h = await build(home, provider, runtime=rt, subagents=sub)
    a = h.api()
    events = []
    try:
        if reopening:
            sid = (project / "session").read_text()

            async def answer(e):
                events.append(e)
                if not is_job and e["kind"] == "input_request_opened":
                    await a.call(
                        "questions",
                        "answer",
                        {
                            "session": sid,
                            "actor": "user",
                            "request": e["request"]["id"],
                            "value": "reanswered",
                        },
                    )

            a.follow("user", answer)
            await a.session("open", session=sid)
            await a.call("questions", "connect", {"session": sid, "actor": "user"})
            if is_job:
                jobs = await a.call("jobs", "list", {"session": sid})
                await a.call("jobs", "wait", {"session": sid, "job": jobs[0]["id"]})
                await asyncio.sleep(0)
            await a.call("runtime", "wait", {"session": sid})
            jobs = await a.call("jobs", "list", {"session": sid})
            child = jobs[0]["detail"]["child"] if jobs else None
            child_entries = (
                (await a.session("get", session=child))["entries"]
                if child and child in h.sessions
                else []
            )
            (project / "recovered.json").write_text(
                json.dumps(
                    {
                        "session": sid,
                        "entries": h.sessions[sid]["entries"],
                        "jobs": jobs,
                        "child_entries": child_entries,
                        "events": events,
                        "requests": provider.requests,
                    }
                )
            )
        else:
            sid = (await a.session("create", project=str(project), settings={"model": "fake"}))[
                "id"
            ]
            (project / "session").write_text(sid)
            await a.call("questions", "connect", {"session": sid, "actor": "user"})
            if is_job:
                provider.script = [{**reply("not yet finished"), "wait": True}]
                await a.call(
                    "runtime",
                    "run_tool",
                    {
                        "session": sid,
                        "name": "delegate",
                        "input": {"task": "recover this isolated task", "background": True},
                    },
                )
                await provider.entered.wait()
                (project / "checkpoint").touch()
                await asyncio.Event().wait()
            else:

                async def checkpoint(e):
                    if e["kind"] == "input_request_opened" and action == "question-open":
                        (project / "checkpoint").touch()
                        await asyncio.Event().wait()
                    if e["kind"] == "input_request_opened" and action == "question-answered":
                        await a.call(
                            "questions",
                            "answer",
                            {
                                "session": sid,
                                "actor": "user",
                                "request": e["request"]["id"],
                                "value": "saved-before-crash",
                            },
                        )
                    if e["kind"] == "input_request_answered":
                        (project / "checkpoint").touch()
                        await asyncio.Event().wait()

                a.follow("user", checkpoint)
                provider.script = [
                    reply(calls=[call("ask_user", question="Answer before crash?", kind="text")])
                ]
                await a.call("runtime", "submit", {"session": sid, "content": content("go")})
                await a.call("runtime", "wait", {"session": sid})
    finally:
        await h.stop()


asyncio.run(main())
