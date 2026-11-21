import json

import pytest
from modular_agent import Plugin
from modular_agent.testing import over_wire, restart, test_agent as make_agent


@pytest.mark.parametrize("served", [False, True])
async def test_command_can_start_a_job_and_owner_confirms_cancel(served):
    seen = []

    class Owner:
        async def cancel(self, job, cx):
            assert cx.session_id == job.session_id
            await job.end("cancelled")
            seen.append(job.id)

    async def start(value, cx):
        handle = await cx.jobs.start("countdown", {"label": value}, key="one")
        await handle.progress("Started")
        assert (await cx.jobs.start("countdown", {"label": value}, key="one")).id == handle.id
        return handle.id

    def setup(r):
        r.jobs(Owner())
        r.command("countdown", "Start a countdown", start)

    plugin = Plugin("job-owner", setup=setup)
    async with make_agent(script=[], plugins=[over_wire(plugin) if served else plugin]) as agent:
        session = await agent.session()
        job_id = await session.run_command("/countdown sample")
        assert (
            json.loads(await session.run_command(f"/job_cancel {job_id}"))["state"] == "cancelled"
        )
        assert seen == [job_id]
        history = await session.history()
        assert [e["kind"] for e in history if e["kind"] == "jobStarted"] == ["jobStarted"]
        assert [e["kind"] for e in history if e["kind"] == "jobEnded"] == ["jobEnded"]


async def test_owner_resumes_unfinished_job_on_reopen(tmp_path):
    resumed = []

    class Owner:
        async def cancel(self, job, cx):
            await job.end("cancelled")

        async def resume(self, job, cx):
            resumed.append(job.id)
            await job.end("completed", "recovered")

    async def start(_, cx):
        job = await cx.jobs.start("offline", {})
        return job.id

    def setup(r):
        r.jobs(Owner())
        r.command("offline", "Start a job", start)

    agent = await make_agent(
        script=[],
        durability="kept",
        data_dir=tmp_path / "state",
        plugins=[Plugin("offline", setup=setup)],
    )
    async with agent:
        session = await agent.session()
        jid = await session.run_command("/offline")
        async with await restart(agent) as next_agent:
            reopened = await next_agent.open_session(session.id)
            assert resumed == [jid]
            rows = [e for e in await reopened.history() if e["kind"] == "jobEnded"]
            assert len(rows) == 1 and rows[0]["jobId"] == jid
