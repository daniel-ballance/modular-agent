"""Failure and lifecycle boundaries of the process binding, all offline."""

import asyncio
import os
from pathlib import Path

import pytest

from ma_core import AgentError, Plugin, content
from ma_fake import Fake, call, reply
from ma_harness import Harness
from ma_process import ProcessPlugin
from ma_cli import build
from test_swap import dead, pid_ready, until
from test_vanilla import entries, paired, run


@pytest.mark.parametrize("victim", ["files", "local"])
async def test_lost_tool_or_environment_stops_descendants_and_continues(
    tmp_path, runtime_type, victim
):
    h = await build(
        tmp_path / "store",
        Fake(
            [
                reply(calls=[call("bash", command="echo $$ > shell.pid; sleep 90")]),
                reply("continued"),
            ]
        ),
        runtime=runtime_type(),
        process_plugins="runtime,files,local,mcp",
    )
    try:
        a = h.api()
        sid = (await a.session("create", project=str(tmp_path), settings={"model": "fake"}))["id"]
        await a.call("runtime", "submit", {"session": sid, "content": content("go")})
        await until(lambda: pid_ready(tmp_path / "shell.pid"))
        shell = int((tmp_path / "shell.pid").read_text())
        os.kill(h.plugins[victim].pid, 9)
        result = await asyncio.wait_for(a.call("runtime", "wait", {"session": sid}), 5)
        assert result[-1]["outcome"] == "completed"
        assert (await entries(a, sid, "tool_result"))[0]["data"]["status"] == "outcome_unknown"
        await until(lambda: dead(shell))
        paired(await entries(a, sid))
    finally:
        await h.stop()


class Policy(Plugin):
    name = "policy"

    async def start(self, api):
        await super().start(api)
        api.on("tool.before", self.allow, "first")

    async def allow(self, d):
        return d


async def test_lost_remote_gate_refuses_instead_of_silently_allowing(tmp_path, runtime_type):
    h = await build(
        tmp_path / "store",
        Fake(
            [
                reply(calls=[call("write", path="must-not-exist", text="forbidden")]),
                reply("refused"),
            ]
        ),
        runtime=runtime_type(),
        process_plugins="runtime,files,local,mcp",
    )
    await h.load(Policy(), process=True)
    try:
        sid = (await h.api().session("create", project=str(tmp_path), settings={"model": "fake"}))[
            "id"
        ]
        policy = h.plugins["policy"]
        os.kill(policy.pid, 9)
        await policy.monitor
        assert (await run(h.api(), sid))[-1]["outcome"] == "completed"
        assert (await entries(h.api(), sid, "tool_result"))[0]["data"]["status"] == "refused"
        assert not (tmp_path / "must-not-exist").exists()
    finally:
        await h.stop()


class Cleanup(Plugin):
    name = "cleanup"

    def __init__(self, path):
        self.path = Path(path)

    async def start(self, api):
        await super().start(api)
        api.provide("cleanup", self)

    async def wait(self, d, emit):
        await emit({"started": os.getpid()})
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0.03)
            self.path.write_text("cleaned")


async def test_transport_cancellation_acknowledges_remote_finally(tmp_path):
    h = Harness(process_plugins="all")
    await h.load(Cleanup(tmp_path / "cleaned"))
    started = asyncio.Event()

    async def progress(d):
        assert d["started"] == h.plugins["cleanup"].pid
        started.set()

    task = asyncio.create_task(h.api().call("cleanup", "wait", {}, progress))
    try:
        await asyncio.wait_for(started.wait(), 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert (tmp_path / "cleaned").read_text() == "cleaned"
        assert not h.plugins["cleanup"].peer.pending
    finally:
        await h.stop()


async def test_cancel_during_request_send_still_cancels_remote_work(tmp_path):
    h = Harness(process_plugins="all")
    await h.load(Cleanup(tmp_path / "cleaned"))
    worker = h.plugins["cleanup"]
    original_send = worker.peer.send
    started = asyncio.Event()

    async def send(frame):
        await original_send(frame)
        if frame["kind"] == "request" and frame["operation"] == "invoke":
            # The frame reached the child, but the sender is still in drain.
            await asyncio.Event().wait()

    async def progress(d):
        started.set()

    worker.peer.send = send
    task = asyncio.create_task(h.api().call("cleanup", "wait", {}, progress))
    try:
        await asyncio.wait_for(started.wait(), 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert (tmp_path / "cleaned").read_text() == "cleaned"
    finally:
        worker.peer.send = original_send
        await h.stop()


async def test_connection_setup_failure_still_reaps_worker(monkeypatch):
    import ma_process

    async def fail(**kwargs):
        raise OSError("connection setup refused")

    monkeypatch.setattr(ma_process.asyncio, "open_connection", fail)
    h = Harness()
    worker = ProcessPlugin(Plugin())
    worker.name = "setup_failure"
    with pytest.raises(OSError, match="setup refused"):
        await h.load(worker, process=False)
    assert not h.plugins
    assert not Path(f"/proc/{worker.pid}").exists()
    await h.stop()


class Uncooperative(Plugin):
    name = "uncooperative"

    async def stop(self):
        # Deliberately blocks the worker loop. A cancellation message cannot help.
        import time

        time.sleep(90)


async def test_shutdown_escalation_reaps_exact_uncooperative_worker():
    h = Harness()
    worker = ProcessPlugin(Uncooperative())
    worker.stop_timeout = 0.05
    await h.load(worker, process=False)
    await asyncio.wait_for(h.stop(), 3)
    assert not Path(f"/proc/{worker.pid}").exists()
    assert worker.exit_status == -9


class RoleProbe(Plugin):
    name = "role_probe"
    role = "runtime"

    async def start(self, api):
        await super().start(api)
        api.provide("probe", self)

    async def forbidden(self, d, emit):
        return await self.api.call("credentials", "get", {"name": "not-a-secret"})


async def test_remote_api_uses_enrolled_role_not_child_supplied_caller():
    h = Harness(process_plugins="all")
    try:
        await h.load(RoleProbe())
        with pytest.raises(AgentError, match="cannot access credentials") as exc:
            await h.api().call(
                "probe", "forbidden", {"_caller": "provider", "_caller_role": "provider"}
            )
        assert exc.value.code == "forbidden"
    finally:
        await h.stop()


async def test_acp_interface_itself_can_move(tmp_path, runtime_kind, monkeypatch):
    from acp_fixture import prompt, running

    monkeypatch.setenv("MA_PLUGIN_PROCESSES", "all")
    async with running(
        tmp_path, [reply("remote ACP", pieces=["remote ", "ACP"])], runtime_kind
    ) as (conn, client, init):
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        assert (await prompt(conn, sid)).stop_reason == "end_turn"
        assert (
            "".join(
                u.content.text
                for _, u in client.updates
                if u.session_update == "agent_message_chunk"
            )
            == "remote ACP"
        )
