"""Read a real file, interrupt a bash call by PID, and reopen on HTTP history."""

import argparse
import asyncio
import json
import os
import select
import signal
import sys
from pathlib import Path

from milestone2_live import descendants, pidfd_kill, pidfd_open, until


def events(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


async def main(output):
    if not all(
        os.environ.get(k) for k in ("MODULAR_AGENT_HISTORY_URL", "MODULAR_AGENT_HISTORY_TOKEN_FILE")
    ):
        raise SystemExit("Select the history service before running the live proof")
    project = output / "project"
    project.mkdir(parents=True)
    marker = "ROUND4-PORTABLE-FILE-7351"
    (project / "proof.txt").write_text(marker + "\n")
    base = [
        sys.executable,
        "-m",
        "modular_agent",
        "--mode",
        "json",
        "--runtime",
        "durable",
        "--home",
        str(output / "state"),
        "--project",
        str(project),
        "--model",
        "claude-haiku-5-5",
    ]
    proc, snapshot = None, []

    async def launch(name, *args):
        with (
            (output / (name + ".jsonl")).open("w") as stdout,
            (output / (name + ".stderr")).open("w") as stderr,
        ):
            child = await asyncio.create_subprocess_exec(
                *base, *args, stdout=stdout, stderr=stderr, stdin=asyncio.subprocess.PIPE
            )
            child.stdin.close()
            return child

    try:
        proc = await launch(
            "read", "-p", "Use the read tool on proof.txt and answer with just its text."
        )
        assert await asyncio.wait_for(proc.wait(), 90) == 0
        initial = events(output / "read.jsonl")
        sid = next(e["session"] for e in initial if e["kind"] == "session_opened")
        assert any(
            e.get("kind") == "turn_ended" and marker in json.dumps(e.get("content"))
            for e in initial
        )
        proc = await launch(
            "before",
            "--session",
            sid,
            "-p",
            "Use bash to run exactly `echo $$ > bash.pid; sleep 45`. If its result is unknown, do not "
            "repeat bash. Instead answer with the text you read from proof.txt in the previous turn.",
        )
        pidfile = project / "bash.pid"
        await until(
            lambda: (pidfile.exists() and pidfile.stat().st_size) or proc.returncode is not None
        )
        assert proc.returncode is None, "Agent exited before executing bash"
        snapshot = descendants(proc.pid)
        agent_pid, bash_pid = proc.pid, int(pidfile.read_text())
        bash_fd = pidfd_open(bash_pid)
        snapshot.append((bash_pid, bash_fd))
        (output / "interrupted.json").write_text(
            json.dumps({"agentPid": agent_pid, "bashPid": bash_pid})
        )
        killer = await asyncio.create_subprocess_exec("kill", "-9", str(agent_pid))
        assert await killer.wait() == 0 and await proc.wait() == -signal.SIGKILL
        await until(lambda: bool(select.select([bash_fd], [], [], 0)[0]), timeout=5)
        proc = await launch("after", "--session", sid)
        assert await asyncio.wait_for(proc.wait(), 90) == 0
        resumed = events(output / "after.jsonl")
        assert any(
            e.get("kind") == "turn_ended"
            and e.get("outcome") == "completed"
            and marker in json.dumps(e.get("content"))
            for e in resumed
        )
        assert any(
            e.get("entry", {}).get("data", {}).get("status") == "outcome_unknown" for e in resumed
        )
        assert int(pidfile.read_text()) == bash_pid, "Bash was repeated"
        proof = {
            "session": sid,
            "kill": ["kill", "-9", str(agent_pid)],
            "bashPid": bash_pid,
            "resumedPid": proc.pid,
            "answer": marker,
        }
        (output / "proof.json").write_text(json.dumps(proof) + "\n")
        print(json.dumps(proof))
    finally:
        if proc is not None and proc.returncode is None:
            proc.kill()
            await proc.wait()
        for _, fd in snapshot:
            if not select.select([fd], [], [], 0)[0]:
                pidfd_kill(fd)
            os.close(fd)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm-live", action="store_true", required=True)
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(main(parser.parse_args().output.resolve()))
