"""Exercise the Darwin implementation on both POSIX test hosts."""

import asyncio
import os
import signal
import sys

import pytest

from ma_local import local_for_platform
from ma_plugin.server import EnvironmentAPI
from test_swap import dead, pid_ready, until

pytestmark = pytest.mark.skipif(
    sys.platform not in {"linux", "darwin"}, reason="needs POSIX groups"
)


async def test_darwin_group_timeout_cancel_and_close(tmp_path):
    env = local_for_platform(tmp_path, platform="darwin")
    await env.start(EnvironmentAPI())
    assert env.declarations["platforms"] == ["darwin"]
    assert env.declarations["containment"] == "processGroup"
    assert not env.declarations["stops_commands_on_crash"]

    async def emit(_):
        pass

    async def bash(session, command, **options):
        return await env.bash(
            {"session": session, "cwd": str(tmp_path), "command": command, **options}, emit
        )

    try:
        for session in ("one", "two"):
            result = await bash(session, f"sleep 60 & echo $! > {session}; printf ready")
            assert result == {"exit_code": 0, "text": "ready"}
        one, two = (int((tmp_path / name).read_text()) for name in ("one", "two"))
        assert not dead(one) and not dead(two)
        await env._close({"session": "one"})
        await until(lambda: dead(one))
        assert not dead(two)

        command = "trap '' TERM; echo $$ > active; while :; do sleep 60; done"
        active = tmp_path / "active"
        task = asyncio.create_task(bash("one", command))
        await until(lambda: pid_ready(active))
        pid = int(active.read_text())
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await until(lambda: dead(pid))
        with pytest.raises(TimeoutError):
            await bash("one", "while :; do sleep 60; done", timeout=0.05)
    finally:
        await env.stop()
    await until(lambda: dead(two))


async def test_darwin_supervisor_cleans_up_after_sigkill(tmp_path):
    source = """
import asyncio, sys
from ma_local import local_for_platform
from ma_plugin.server import EnvironmentAPI
async def main():
    async def emit(_): pass
    env = local_for_platform(sys.argv[1], platform="darwin")
    await env.start(EnvironmentAPI())
    await env.bash({"session": "test", "cwd": sys.argv[1],
                    "command": "sleep 60 & echo $! > child"}, emit)
    print("ready", flush=True)
    await asyncio.Event().wait()
asyncio.run(main())
"""
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-c", source, str(tmp_path), stdout=asyncio.subprocess.PIPE
    )
    try:
        assert await asyncio.wait_for(proc.stdout.readline(), 5) == b"ready\n"
        pid = int((tmp_path / "child").read_text())
        assert not dead(pid)
        os.kill(proc.pid, signal.SIGKILL)
        await proc.wait()
        await until(lambda: dead(pid))
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
