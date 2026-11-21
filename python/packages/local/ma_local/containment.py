"""Linux cgroup v2 containment, independent of process groups and PID reuse.

Source: https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html
cgroup.kill is recursive and handles concurrent forks. Children inherit cgroups.
"""

import asyncio
import errno
import json
import os
import time
from pathlib import Path

from ma_core import AgentError


def owner_identity():
    return {
        "pid": os.getpid(),
        "start": process_start(os.getpid()),
        "boot": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
    }


def process_start(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return None if fields[0] in {"Z", "X"} else fields[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def alive(owner):
    return (
        owner["boot"] == Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        and process_start(owner["pid"]) == owner["start"]
    )


def delegated_root():
    # systemd delegates this subtree to the logged-in user. An administrator may
    # instead supply another delegated cgroup v2 path. Never fall back to killpg.
    path = Path(
        os.environ.get(
            "MA_CGROUP_ROOT",
            f"/sys/fs/cgroup/user.slice/user-{os.getuid()}.slice/user@{os.getuid()}.service",
        )
    )
    if not (path / "cgroup.controllers").exists() or not os.access(path, os.W_OK):
        raise AgentError(
            "Command containment unavailable: writable delegated cgroup v2 required",
            "environment_lost",
        )
    return path


def journal(path, value):
    temp = path.with_suffix(".tmp")
    with temp.open("w") as file:
        json.dump(value, file)
        file.flush()
        os.fsync(file.fileno())
    temp.replace(path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def kill(group):
    try:
        (group / "cgroup.kill").write_text("1")
    except OSError as exc:
        # A second cleanup can remove the cgroup after we open cgroup.kill.
        if exc.errno not in {errno.ENOENT, errno.ENODEV}:
            raise


def remove(group):
    try:
        group.rmdir()
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return True


async def terminate(group):
    # cgroup.kill sends SIGKILL, it does not wait for exit. A task can leave its
    # cgroup during do_exit before /proc reports Z/X. Keep identities from before
    # the kill and wait for terminal states too, not just successful rmdir.
    # https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#core-interface-files
    try:
        members = {
            int(pid): process_start(int(pid))
            for pid in (group / "cgroup.procs").read_text().split()
        }
    except FileNotFoundError:
        members = {}
    kill(group)
    deadline = time.monotonic() + 5
    removed = False
    while True:
        removed = removed or remove(group)
        pending = any(
            start is not None and process_start(pid) == start for pid, start in members.items()
        )
        if removed and not pending:
            return
        if time.monotonic() > deadline:
            raise AgentError("Command containment cleanup did not finish", "environment_lost")
        await asyncio.sleep(0.01)


async def cleanup(record):
    """Idempotent even when the normal watcher is cleaning up at the same time."""
    try:
        data = json.loads(record.read_text())
    except FileNotFoundError:
        return
    group = Path(data["group"])
    await terminate(group)
    record.unlink(missing_ok=True)
    record.with_suffix(".result").unlink(missing_ok=True)


async def recover(root):
    # The cgroup name carries PID plus kernel start time. Scan the shared delegated
    # subtree too, so a new agent using a different history directory still stops
    # stale commands. Cgroups disappear on reboot, so boot identity is implicit.
    try:
        delegated = delegated_root()
    except AgentError:
        delegated = None
    if delegated is not None:
        for group in delegated.glob("ma-py-*-*-*"):
            _, _, pid, start, _ = group.name.split("-", 4)
            if pid.isdecimal() and process_start(int(pid)) != start:
                await terminate(group)
    if not root.exists():
        return
    for record in root.glob("*.json"):
        try:
            data = json.loads(record.read_text())
        except FileNotFoundError:
            continue
        if not alive(data["owner"]):
            await cleanup(record)
