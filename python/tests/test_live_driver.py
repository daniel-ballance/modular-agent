"""Offline regression for the live driver's optional Python pidfd bindings."""

import asyncio
import json
import os
import select
import sys

import pytest

from scripts.milestone2_live import descendants, pidfd_kill, pidfd_open, validate


@pytest.mark.skipif(sys.platform != "linux", reason="requires Linux pidfds and procfs")
async def test_pidfd_helpers_without_optional_python_wrappers(monkeypatch):
    monkeypatch.delattr(os, "pidfd_open", raising=False)
    import signal

    monkeypatch.delattr(signal, "pidfd_send_signal", raising=False)
    p = await asyncio.create_subprocess_exec(sys.executable, "-c", "import time; time.sleep(60)")
    fd, snapshot = None, []
    try:
        fd = pidfd_open(p.pid)
        snapshot = descendants(os.getpid())
        assert p.pid in [pid for pid, _ in snapshot]
        assert not select.select([fd], [], [], 0)[0]
        pidfd_kill(fd)
        assert await p.wait() == -signal.SIGKILL
        assert select.select([fd], [], [], 0)[0]
        # Sending through a retained pidfd can never hit a recycled PID.
        pidfd_kill(fd)
    finally:
        if p.returncode is None:
            p.kill()
            await p.wait()
        if fd is not None:
            os.close(fd)
        for _, child_fd in snapshot:
            os.close(child_fd)


@pytest.mark.parametrize("extra", [None, "read", "bash"])
def test_log_validator_accepts_extra_reads_but_not_unsafe_repeats(tmp_path, extra):
    def event(kind, **kw):
        return {"kind": "history_entry", "entry": {"kind": kind, **kw}}

    before = [
        {"kind": "session_opened", "session": "session"},
        event("turn_start", turn="turn"),
        event("tool_call", call="bash", data={"name": "bash"}),
    ]
    after = [
        {"kind": "session_opened", "session": "session"},
        event("tool_result", call="bash", data={"status": "outcome_unknown"}),
        event("tool_call", call="read", data={"name": "read", "input": {"path": "proof.txt"}}),
        event("tool_result", call="read", data={"status": "completed"}),
    ]
    if extra:
        after.extend(
            [
                event(
                    "tool_call", call="extra", data={"name": extra, "input": {"path": "bash.pid"}}
                ),
                event("tool_result", call="extra", data={"status": "completed"}),
            ]
        )
    after.append(
        event(
            "turn_end",
            turn="turn",
            data={
                "outcome": "completed",
                "content": [{"type": "text", "text": "M2-RECOVERED-5831"}],
            },
        )
    )
    for name, events in [("before", before), ("after", after)]:
        (tmp_path / f"{name}.jsonl").write_text("\n".join(json.dumps(e) for e in events))
    if extra == "bash":
        with pytest.raises(AssertionError):
            validate(tmp_path)
    else:
        assert validate(tmp_path)["outcome"] == "completed"
