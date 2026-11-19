"""Containment survives SIGKILL, setsid, double forks and watcher loss."""

import asyncio
import json
import os
import signal
from pathlib import Path

import pytest

from ma_core import AgentError
from ma_fake import Fake
from ma_local import Local
from ma_local.containment import journal, owner_identity, recover
from ma_cli import build
from test_swap import dead, pid_ready, spawn_driver, until


async def test_watcher_and_agent_die_next_start_cleans_up(tmp_path, runtime_kind):
    home = tmp_path / "store"
    p = await spawn_driver(home, tmp_path, runtime_kind, "bash_effect")
    watcher, pids, record, group = None, [], None, None
    try:
        await until(lambda: pid_ready(tmp_path / "escaped.pid") or p.returncode is not None)
        assert p.returncode is None, (await p.communicate())[1].decode()
        pids = [int((tmp_path / name).read_text()) for name in ("running.pid", "escaped.pid")]
        record = next((home / "commands").glob("*.json"))
        group = Path(json.loads(record.read_text())["group"])
        owner = json.loads(record.read_text())["owner"]["pid"]
        watcher = int(Path(f"/proc/{owner}/task/{owner}/children").read_text().split()[0])
        # Stop the watcher first so lifetime EOF cannot trigger its cleanup.
        os.kill(watcher, signal.SIGSTOP)
        if owner != p.pid:
            os.kill(owner, signal.SIGKILL)
        p.kill()
        await p.wait()
        os.kill(watcher, signal.SIGKILL)
        await until(lambda: dead(watcher))
        assert all(not dead(pid) for pid in pids)
        h = await build(tmp_path / "different-home", Fake())
        try:
            assert all(dead(pid) for pid in pids)
            assert not group.exists()
        finally:
            await h.stop()
        h = await build(home, Fake())
        await h.stop()
        assert not record.exists()
    finally:
        if p.returncode is None:
            p.kill()
            await p.wait()
        if watcher is not None and not dead(watcher):
            os.kill(watcher, signal.SIGKILL)
        h = await build(home, Fake())
        await h.stop()
        for pid in pids:
            await until(lambda: dead(pid))


async def test_completed_background_double_fork_dies_with_agent(tmp_path, runtime_kind):
    # Reuse the subprocess fixture, but finish the shell while descendants run.
    # The initial bash waits for a daemonized grandchild through a PID file only.
    home = tmp_path / "store"
    import sys

    code = """
import asyncio, sys
from pathlib import Path
from ma_fake import Fake
from ma_cli import build
async def main():
 h = await build(Path(sys.argv[1]), Fake())
 s = await h.api().session('create', project=sys.argv[2], settings={'model':'fake'})
 command = "setsid /bin/bash -c 'sleep 90 & echo $! > daemon.pid' & sleep .05; printf returned"
 result = await h.api().call('environment','bash', {'session':s['id'],'command':command})
 assert result['text'] == 'returned'
 Path(sys.argv[2], 'returned').touch()
 await asyncio.Event().wait()
asyncio.run(main())
"""
    p = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        code,
        str(home),
        str(tmp_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    pid = None
    try:
        await until(lambda: (tmp_path / "returned").exists() or p.returncode is not None)
        assert p.returncode is None, (await p.communicate())[1].decode()
        pid = int((tmp_path / "daemon.pid").read_text())
        assert not dead(pid)
        p.kill()
        await p.wait()
        await until(lambda: not Path(f"/proc/{pid}").exists())
        await until(lambda: not list((home / "commands").glob("*.json")))
    finally:
        if p.returncode is None:
            p.kill()
            await p.wait()
        h = await build(home, Fake())
        await h.stop()
        if pid is not None:
            await until(lambda: dead(pid))


async def test_command_timeout_kills_escaped_descendant(agent, tmp_path):
    h, a, sid, fake = await agent()
    with pytest.raises(TimeoutError):
        await a.call(
            "environment",
            "bash",
            {
                "session": sid,
                "command": "setsid sleep 90 & echo $! > timed.pid; wait",
                "timeout": 0.15,
            },
        )
    pid = int((tmp_path / "timed.pid").read_text())
    assert not Path(f"/proc/{pid}").exists()
    assert not list(h.plugins["local"].root.glob("*.json"))


async def test_missing_containment_refuses_before_command(tmp_path, monkeypatch, runtime_type):
    monkeypatch.setenv("MA_CGROUP_ROOT", str(tmp_path / "no-delegation"))
    h = await build(tmp_path / "store", Fake(), runtime=runtime_type())
    try:
        sid = (await h.api().session("create", project=str(tmp_path)))["id"]
        with pytest.raises(AgentError, match="containment unavailable"):
            await h.api().call(
                "environment", "bash", {"session": sid, "command": "touch must-not-run"}
            )
        assert not (tmp_path / "must-not-run").exists()
    finally:
        await h.stop()


async def test_recovery_leaves_live_other_agent_journal_alone(tmp_path):
    root = tmp_path / "commands"
    root.mkdir()
    record = root / "live.json"
    journal(record, {"owner": owner_identity(), "group": str(tmp_path / "no-group")})
    await recover(root)
    assert record.exists()


async def test_cleanup_waits_for_process_exit_after_group_removal(tmp_path, monkeypatch):
    from ma_local import containment

    group = tmp_path / "group"
    group.mkdir()
    (group / "cgroup.procs").write_text("123\n")
    record = tmp_path / "command.json"
    journal(record, {"group": str(group)})
    killed = asyncio.Event()
    running = True
    monkeypatch.setattr(containment, "kill", lambda group: killed.set())
    monkeypatch.setattr(containment, "remove", lambda group: True)
    monkeypatch.setattr(containment, "process_start", lambda pid: "start" if running else None)
    task = asyncio.create_task(containment.cleanup(record))
    try:
        await killed.wait()
        # A cgroup may be removable while a task is still exiting in the kernel.
        assert not task.done(), "cleanup returned before the killed process exited"
    finally:
        running = False
        await task
    assert not record.exists()


async def test_lifetime_eof_before_child_enters_cgroup(tmp_path):
    """Cancellation must not kill an empty group then wait on a late entrant."""
    import sys

    from ma_core import identity
    from ma_local.containment import cleanup, delegated_root, kill

    owner = owner_identity()
    group = delegated_root() / f"ma-py-{owner['pid']}-{owner['start']}-{identity()}"
    group.mkdir()
    record = tmp_path / "early.json"
    journal(record, {"group": str(group), "owner": owner})
    read_fd, lifetime = os.pipe()
    # Delay exactly the child-side cgroup admission, not the watcher or transport.
    code = """
import time
from ma_local import worker
original = worker.Path.write_text
def delayed(path, *args, **kwargs):
    if path.name == 'cgroup.procs':
        time.sleep(.3)
    return original(path, *args, **kwargs)
worker.Path.write_text = delayed
worker.main()
"""
    proc = None
    try:
        with (tmp_path / "output").open("wb") as output:
            proc = await asyncio.create_subprocess_exec(
                sys.executable,
                "-c",
                code,
                str(record),
                str(read_fd),
                str(output.fileno()),
                str(tmp_path),
                "sleep 30",
                pass_fds=(read_fd, output.fileno()),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            os.close(read_fd)
            read_fd = None
            await until(
                lambda: bool(Path(f"/proc/{proc.pid}/task/{proc.pid}/children").read_text())
            )
            assert not (group / "cgroup.procs").read_text().strip()
            os.close(lifetime)
            lifetime = None
            try:
                async with asyncio.timeout(2):
                    await proc.wait()
            except TimeoutError:
                pytest.fail("Watcher waited on a child admitted after its cancellation kill")
            assert proc.returncode == 0, (await proc.stderr.read()).decode()
            assert not group.exists()
    finally:
        for fd in (read_fd, lifetime):
            if fd is not None:
                os.close(fd)
        kill(group)
        if proc is not None:
            async with asyncio.timeout(5):
                await proc.wait()
        await cleanup(record)


async def test_unused_local_has_no_durable_side_effects(tmp_path):
    from ma_harness import Harness

    h = Harness()
    await h.load(Local(tmp_path / "store"))
    await h.stop()
    assert not (tmp_path / "store").exists()
