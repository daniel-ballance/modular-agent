"""Milestone 2 swap, real process crashes and parallel execution. No inference."""

import asyncio
import json
import os
import signal
import sys
from pathlib import Path

import pytest

from ma_core import content, plain
from ma_durable import Durable
from ma_fake import Fake, call, reply
from ma_runtime import Runtime
from ma_cli import build
from test_vanilla import entries, paired, run


# Waiting for a crash driver to reach its checkpoint. The wait ends at once if the driver
# exits, so a broken driver still fails fast; this bound only stops a hang. A driver with
# process plugins starts about five Python processes: 0.8 s idle, 3.8 s with three busy
# loops per core, more beside other suites. That is not what these tests check.
DRIVER_STARTUP = 120


async def until(predicate, timeout=5):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.01)


def pid_ready(path):
    """File creation is not PID publication: require the complete echo line."""
    try:
        value = path.read_text()
    except FileNotFoundError:
        return False
    return value.endswith("\n") and value.strip().isdecimal() and int(value) > 0


def dead(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] in {"Z", "X"}
    except (FileNotFoundError, ProcessLookupError):
        return True


async def spawn_driver(home, project, runtime, phase):
    return await asyncio.create_subprocess_exec(
        sys.executable,
        str(Path(__file__).with_name("crash_driver.py")),
        str(home),
        str(project),
        runtime,
        phase,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )


@pytest.mark.parametrize(
    "phase",
    [
        "turn_start",
        "model_started",
        "response",
        "tool_call",
        "read_effect",
        "bash_effect",
        "tool_finished",
        "step_end",
    ],
)
async def test_sigkill_at_committed_boundaries(tmp_path, runtime_kind, phase):
    home = tmp_path / "store"
    p = await spawn_driver(home, tmp_path, runtime_kind, phase)
    command_pids = []
    try:
        marker = tmp_path / ("escaped.pid" if phase == "bash_effect" else "checkpoint")
        await until(
            lambda: (
                (pid_ready(marker) if phase == "bash_effect" else marker.exists())
                or p.returncode is not None
            ),
            DRIVER_STARTUP,
        )
        assert p.returncode is None, (await p.communicate())[1].decode()
        if phase == "bash_effect":
            command_pids = [
                int((tmp_path / name).read_text()) for name in ("running.pid", "escaped.pid")
            ]
        os.kill(p.pid, signal.SIGKILL)
        await p.wait()
        for pid in command_pids:
            await until(lambda: dead(pid))
        q = await spawn_driver(home, tmp_path, runtime_kind, "reopen")
        try:
            out, err = await asyncio.wait_for(q.communicate(), 10)
            assert q.returncode == 0, err.decode()
        finally:
            if q.returncode is None:
                q.kill()
                await q.wait()
        record = json.loads((tmp_path / "recovered.json").read_text())
        es = record["entries"]
        paired(es)
        ends = [e for e in es if e["kind"] == "turn_end"]
        assert len(ends) == 1
        assert ends[0]["data"]["outcome"] == (
            "completed" if runtime_kind == "durable" else "failed"
        )
        assert len([e for e in es if e["kind"] == "turn_start"]) == 1
        if runtime_kind == "durable":
            if phase in {"response", "tool_call", "read_effect", "bash_effect", "tool_finished"}:
                assert (tmp_path / "never").read_text() == "ran"
                assert (tmp_path / "write-log").read_text().splitlines().count("written") == 1
            if phase == "read_effect":
                assert (tmp_path / "read-count").read_text() == "2"
            if phase == "bash_effect":
                assert len((tmp_path / "bash-attempts").read_text().splitlines()) == 1
                unknown = [
                    m
                    for m in record["requests"][0]["messages"]
                    if m.get("data", {}).get("status") == "outcome_unknown"
                ]
                assert len(unknown) == 1 and "did not finish" in plain(unknown[0]["content"])
                assert "Check outside state" in plain(unknown[0]["content"])
        else:
            assert not record["requests"]
            if phase == "bash_effect":
                statuses = [e["data"]["status"] for e in es if e["kind"] == "tool_result"]
                assert statuses == ["completed", "completed", "outcome_unknown", "not_started"]
    finally:
        if p.returncode is None:
            p.kill()
            await p.wait()
        # Even a failing assertion must not leave a command alive. Starting another
        # working environment also exercises the journal's stale-owner cleanup.
        h = await build(home, Fake(), runtime=Runtime())
        await h.stop()
        for pid in command_pids:
            await until(lambda: dead(pid))


async def test_runtime_is_only_plugin_changed_and_hooks_survive_replacement(tmp_path):
    h = await build(tmp_path / "store", Fake([reply("before"), reply("after")]))
    originals = {k: v for k, v in h.plugins.items() if k != "transient"}
    try:
        s = await h.api().session("create", project=str(tmp_path), settings={"model": "fake"})
        await run(h.api(), s["id"])
        await h.api().session("close", session=s["id"])
        await h.load(Durable(), replaces="transient")
        assert all(h.plugins[k] is v for k, v in originals.items())
        assert h.hooks["tool.before"][0] == "durable"
        s = await h.api().session("open", session=s["id"])
        assert "durable" in s["plugins"] and "transient" not in s["plugins"]
        assert (await run(h.api(), s["id"]))[-1]["outcome"] == "completed"
        assert not any(
            caller == "durable" and target == "credentials" for caller, target, _ in h.trace
        )
    finally:
        await h.stop()


@pytest.mark.parametrize("mode", ["all", "none", "mixed"])
async def test_tool_overlap_ordering_and_mixed_step_exclusion(agent, mode):
    parallel = mode == "all"
    calls = [
        call("read", path="slow"),
        call("write", path="fast", text="fast") if mode == "mixed" else call("read", path="fast"),
    ]
    h, a, sid, fake = await agent([reply(calls=calls), reply("done")])
    tool_source = h.plugins["files"]
    original = tool_source.definitions

    async def definitions(d, emit):
        return [
            {**t, "parallel": mode != "none" if t["name"] == "read" else False}
            for t in await original(d, emit)
        ]

    tool_source.definitions = definitions
    active, maximum, finished = 0, 0, []
    both = asyncio.Event()
    original_read = h.plugins["local"].read

    async def read(d, emit):
        nonlocal active, maximum
        if d["path"] not in {"slow", "fast"}:
            return await original_read(d, emit)
        active += 1
        maximum = max(maximum, active)
        if active == 2:
            both.set()
        if parallel:
            await asyncio.wait_for(both.wait(), 1)
        await asyncio.sleep(0.04 if d["path"] == "slow" else 0)
        active -= 1
        finished.append(d["path"])
        return d["path"]

    h.plugins["local"].read = read

    async def write(d, emit):
        return {"text": await read(d, emit)}

    h.plugins["local"].write = write
    await run(a, sid)
    assert maximum == (2 if parallel else 1)
    assert finished == (["fast", "slow"] if parallel else ["slow", "fast"])
    assert [plain(e["content"]) for e in await entries(a, sid, "tool_result")] == ["slow", "fast"]
    paired(await entries(a, sid))


async def test_parallel_cancellation_settles_all_and_stops_work(agent):
    h, a, sid, fake = await agent([reply(calls=[call("read", path=str(i)) for i in range(3)])])
    entered, active = asyncio.Event(), set()
    original_read = h.plugins["local"].read

    async def read(d, emit):
        if d["path"] == "AGENTS.md":
            return await original_read(d, emit)
        active.add(d["path"])
        if len(active) == 3:
            entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            active.remove(d["path"])

    h.plugins["local"].read = read
    await a.call("runtime", "submit", {"session": sid, "content": content("go")})
    await asyncio.wait_for(entered.wait(), 2)
    await a.call("runtime", "cancel", {"session": sid})
    assert not active
    assert [e["data"]["status"] for e in await entries(a, sid, "tool_result")] == ["cancelled"] * 3
    paired(await entries(a, sid))
