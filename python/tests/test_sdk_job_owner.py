import asyncio
import json
from pathlib import Path
import sys

import pytest
from modular_agent import AgentError, ErrorCode, Plugin, create_agent, file_history, run
from modular_agent.testing import memory_environment, over_wire, restart, test_agent as make_agent


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


@pytest.mark.parametrize("served", [False, True])
async def test_report_uses_reserved_input_and_bounds_result(served):
    class Owner:
        async def cancel(self, job, cx):
            await job.end("cancelled")

    async def command(_, cx):
        job = await cx.jobs.start("bounded", {})
        with pytest.raises(AgentError) as refused:
            await cx.jobs.start("over capacity", {})
        assert refused.value.code is ErrorCode.BUSY
        with pytest.raises(AgentError) as oversized:
            await job.end("completed", "large" * 4000, report=True)
        assert oversized.value.code is ErrorCode.RESULT_TOO_LARGE
        return job.id

    def setup(r):
        r.jobs(Owner())
        r.command("bounded", "Start a reporting job", command)

    plugin = Plugin("bounded-job", setup=setup)
    async with make_agent(
        script=[],
        plugins=[over_wire(plugin) if served else plugin],
        resource_reservations={"session": {"inputs": 1, "jobs": 1}},
    ) as agent:
        session = await agent.session()
        jid = await session.run_command("/bounded")
        rows = await session.history()
        assert len([row for row in rows if row["kind"] == "jobStarted"]) == 1
        [end] = [row for row in rows if row["kind"] == "jobEnded" and row["jobId"] == jid]
        [report] = [
            row for row in rows if row["kind"] == "inputAccepted" and row.get("jobId") == jid
        ]
        assert end["data"]["result"] == report["data"]["content"]
        assert end["data"]["result"] == [
            {"type": "text", "text": "Job result exceeded reserved space"}
        ]


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
        several_actors=True,
        data_dir=tmp_path / "state",
        plugins=[Plugin("offline", setup=setup)],
    )
    async with agent:
        session = await agent.session()
        await session.send("Keep this session.", "propose")
        jid = await session.run_command("/offline")
        async with await restart(agent) as next_agent:
            reopened = await next_agent.open_session(session.id)
            assert resumed == [jid]
            rows = [e for e in await reopened.history() if e["kind"] == "jobEnded"]
            assert len(rows) == 1 and rows[0]["jobId"] == jid


def wire_owner(resumed):
    class Owner:
        async def cancel(self, job, cx):
            return None  # Not a confirmation: work could still be running.

        async def resume(self, job, cx):
            resumed.append(job.id)
            await job.end("completed", "wire resumed")

    async def start(_, cx):
        return (await cx.jobs.start("offline", {})).id

    def setup(r):
        r.jobs(Owner())
        r.command("offline", "Start a job", start)

    return Plugin("wire-owner", setup=setup)


@pytest.mark.parametrize("served", [False, True])
async def test_unconfirmed_owner_cleanup_is_recorded_and_not_resumed(tmp_path, served):
    async with create_agent(
        project=tmp_path,
        plugins=[over_wire(wire_owner([])) if served else wire_owner([])],
    ) as agent:
        session = await agent.session()
        jid = await session.run_command("/offline")
        with pytest.raises(AgentError) as failure:
            await session.run_command(f"/job_cancel {jid}")
        assert failure.value.code is ErrorCode.LOST
        [job] = json.loads(await session.run_command("/jobs"))
        assert job["state"] == "cleanupUnconfirmed"
        markers = [e for e in await session.history() if e["kind"] == "jobCleanupUnconfirmed"]
        assert len(markers) == 1 and markers[0]["jobId"] == jid


def wire_agent(path, resumed):
    return create_agent(
        project=path,
        history=file_history(path / "history"),
        durability="kept",
        several_actors=True,
        environment=memory_environment(),
        plugins=[over_wire(wire_owner(resumed))],
    )


async def test_wire_owner_resumes_after_host_crash(tmp_path):
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        str(Path(__file__).resolve()),
        str(tmp_path),
        stdout=asyncio.subprocess.PIPE,
    )
    try:
        async with asyncio.timeout(10):
            sid, jid = (await process.stdout.readline()).decode().split()
    finally:
        if process.returncode is None:
            process.kill()
        await process.wait()
    assert process.returncode < 0
    resumed = []
    async with wire_agent(tmp_path, resumed) as agent:
        session = await agent.open_session(sid)
        assert resumed == [jid]
        [end] = [e for e in await session.history() if e["kind"] == "jobEnded"]
        assert end["jobId"] == jid
        assert end["data"]["outcome"]["kind"] == "completed"


async def crash_fixture(path):
    async with wire_agent(path, []) as agent:
        session = await agent.session()
        await session.send("Keep this session.", "propose")
        job = await session.run_command("/offline")
        print(session.id, job, flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    run(crash_fixture(Path(sys.argv[1])))
