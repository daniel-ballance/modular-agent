"""Opt-in, short Haiku-only SIGKILL recovery demonstration.

Run: uv run python scripts/milestone2_live.py --confirm-live --output /tmp/ma-m2-live
No credential values are read or logged by this script.
"""

import argparse
import asyncio
import ctypes
import errno
import json
import os
import select
import signal
import sys
from pathlib import Path


# Some Python builds omit the optional os/signal wrappers even on a capable
# kernel. Use glibc, documented by pidfd_open(2) and pidfd_send_signal(2).
LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.pidfd_open.argtypes = [ctypes.c_int, ctypes.c_uint]
LIBC.pidfd_open.restype = ctypes.c_int
LIBC.pidfd_send_signal.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint]
LIBC.pidfd_send_signal.restype = ctypes.c_int


def pidfd_open(pid):
    fd = LIBC.pidfd_open(pid, 0)
    if fd < 0:
        raise OSError(ctypes.get_errno(), "pidfd_open failed")
    return fd


def pidfd_kill(fd):
    if LIBC.pidfd_send_signal(fd, signal.SIGKILL, None, 0) < 0:
        error = ctypes.get_errno()
        if error != errno.ESRCH:
            raise OSError(error, "pidfd_send_signal failed")


async def until(predicate, timeout=60):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.02)


def descendants(parent):
    result = []
    try:
        children = Path(f"/proc/{parent}/task/{parent}/children").read_text().split()
    except (FileNotFoundError, ProcessLookupError):
        return result
    for child in children:
        pid = int(child)
        try:
            fd = pidfd_open(pid)
        except ProcessLookupError:
            continue
        result.append((pid, fd))
        result.extend(descendants(pid))
    return result


def validate(output):
    events = [
        json.loads(line)
        for name in ("before.jsonl", "after.jsonl")
        for line in (output / name).read_text().splitlines()
    ]
    sessions = {e["session"] for e in events if e["kind"] == "session_opened"}
    assert len(sessions) == 1
    entries = [e["entry"] for e in events if e["kind"] == "history_entry"]
    calls = [e for e in entries if e["kind"] == "tool_call"]
    results = [e for e in entries if e["kind"] == "tool_result"]
    ends = [e for e in entries if e["kind"] == "turn_end"]
    starts = [e for e in entries if e["kind"] == "turn_start"]
    assert len(starts) == len(ends) == 1
    assert starts[0]["turn"] == ends[0]["turn"]
    assert ends[0]["data"]["outcome"] == "completed"
    answer = [p for p in ends[0]["data"]["content"] if p.get("type") == "text"]
    assert "M2-RECOVERED-5831" in json.dumps(answer)
    names = [c["data"]["name"] for c in calls]
    assert names[0] == "bash" and len(names) > 1 and set(names[1:]) == {"read"}
    assert any(Path(c["data"]["input"]["path"]).name == "proof.txt" for c in calls[1:])
    assert [r["data"]["status"] for r in results] == ["outcome_unknown"] + ["completed"] * (
        len(calls) - 1
    )
    assert sorted(c["call"] for c in calls) == sorted(r["call"] for r in results)
    observations = output / "process-observations.json"
    summary = json.loads(observations.read_text()) if observations.exists() else {}
    summary.update(
        model="claude-haiku-5-5",
        session=next(iter(sessions)),
        turn=starts[0]["turn"],
        outcome="completed",
        calls=names,
        statuses=[r["data"]["status"] for r in results],
        answer=answer,
        model_requests=sum(e["kind"] == "model_started" for e in entries),
    )
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    return summary


async def main(output):
    # Verify all platform helpers before spending a model request.
    os.close(pidfd_open(os.getpid()))
    output.mkdir(parents=True, exist_ok=False)
    project, home = output / "project", output / "store"
    (project / ".modular-agent").mkdir(parents=True)
    (project / ".modular-agent/settings.json").write_text(json.dumps({"max_steps": 6}))
    marker = "M2-RECOVERED-5831"
    command = f"echo $$ > bash.pid; printf '{marker}\\n' > proof.txt; printf 'M2-bash-started\\n'; sleep 90"
    prompt = (
        "First use bash to run exactly this command:\n```\n" + command + "\n```\n"
        "After it returns, use read to inspect proof.txt and tell me its text. "
        "If bash is interrupted and its outcome is unknown, do not repeat it. "
        "Check proof.txt with read before relying on the unknown result."
    )
    base = [
        sys.executable,
        "-m",
        "modular_agent",
        "--runtime",
        "durable",
        "--home",
        str(home),
        "--project",
        str(project),
        "--mode",
        "json",
        "--model",
        "claude-haiku-5-5",
    ]
    snapshot, p = [], None
    try:
        with (
            (output / "before.jsonl").open("w") as stdout,
            (output / "before.stderr").open("w") as stderr,
        ):
            p = await asyncio.create_subprocess_exec(
                *base, "-p", prompt, stdout=stdout, stderr=stderr
            )
            await until(lambda: (project / "bash.pid").exists() or p.returncode is not None)
            if p.returncode is not None:
                raise RuntimeError("Agent exited before bash started; inspect before.jsonl")
            snapshot = descendants(p.pid)
            killed_agent = p.pid
            bash_pid = int((project / "bash.pid").read_text())
            bash_fd = pidfd_open(bash_pid)
            snapshot.append((bash_pid, bash_fd))
            observations = {"kill_command": ["kill", "-9", str(killed_agent)], "bash_pid": bash_pid}
            observation_path = output / "process-observations.json"
            observation_path.write_text(json.dumps(observations))
            killer = await asyncio.create_subprocess_exec("kill", "-9", str(p.pid))
            assert await killer.wait() == 0
            assert await p.wait() == -signal.SIGKILL
            observations["agent_returncode"] = p.returncode
        # Provider transport processes are outside the working environment. Give
        # EOF cleanup time, then stop only descendants captured by pidfd, never a
        # name pattern or a potentially recycled PID.
        await until(lambda: bool(select.select([bash_fd], [], [], 0)[0]), timeout=5)
        await asyncio.sleep(1)
        transport_cleanup = []
        for pid, fd in snapshot:
            if not select.select([fd], [], [], 0)[0]:
                pidfd_kill(fd)
                transport_cleanup.append(pid)
        events = [json.loads(line) for line in (output / "before.jsonl").read_text().splitlines()]
        sid = next(e["session"] for e in events if e["kind"] == "session_opened")
        with (
            (output / "after.jsonl").open("w") as stdout,
            (output / "after.stderr").open("w") as stderr,
        ):
            p = await asyncio.create_subprocess_exec(
                *base, "--session", sid, stdin=asyncio.subprocess.PIPE, stdout=stdout, stderr=stderr
            )
            await asyncio.wait_for(p.communicate(b""), 90)
            assert p.returncode == 0
        observations.update(
            bash_stopped_by_working_environment=True,
            transport_descendants_explicitly_cleaned=transport_cleanup,
        )
        observation_path.write_text(json.dumps(observations))
        validate(output)
    finally:
        if p is not None and p.returncode is None:
            p.kill()
            await p.wait()
        for _, fd in snapshot:
            if not select.select([fd], [], [], 0)[0]:
                pidfd_kill(fd)
            os.close(fd)
        # Clean any old working-environment journal, even after a failed assertion.
        from ma_fake import Fake
        from modular_agent import build

        h = await build(home, Fake())
        await h.stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--confirm-live", action="store_true")
    mode.add_argument(
        "--verify-only", action="store_true", help="Validate saved logs with no inference"
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.verify_only:
        validate(args.output.resolve())
    else:
        asyncio.run(main(args.output.resolve()))
