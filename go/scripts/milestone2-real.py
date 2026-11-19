#!/usr/bin/env python3
"""One short real Haiku crash/resume demonstration. Only the Provider reads the key."""
import ctypes
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time

binary = Path(sys.argv[1] if len(sys.argv) > 1 else "bin/modular").resolve()
root = Path(tempfile.mkdtemp(prefix="modular-go-m2-real."))
project = root / "project"
project.mkdir()
(project / "marker.txt").write_text("The milestone two marker is amber-47.\n")
(project / "AGENTS.md").write_text("Follow the requested tool order. Keep the final answer to one sentence.\n")
# Reap the orphaned supervisor after SIGKILL even on machines whose PID 1 does not.
if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "cannot become child subreaper")
base = [str(binary), "--runtime", "durable", "--state", str(root / "history"),
        "--settings", str(root / "absent-settings"), "--mode", "json"]
prompt = ("First use bash to run exactly this command with timeout_seconds 60: "
          "`printf 'M2_BASH_READY\\n'; sleep 30; printf finished > completion.txt`. "
          "After that call, read marker.txt and check whether completion.txt exists. "
          "If the command is interrupted or its outcome is unknown, do not repeat it; "
          "check the files before relying on its effects. Report the marker and whether "
          "the completion file exists in one short sentence.")
(root / "prompt.txt").write_text(prompt)
first_args = base + ["--project", str(project), "--key", "m2-real", "--prompt", prompt]
(root / "commands.json").write_text(json.dumps([first_args], indent=2))
first_err = (root / "first.stderr").open("w")
first = subprocess.Popen(first_args, stdout=subprocess.PIPE, stderr=first_err, text=True)
events = queue.Queue()
def read_events():
    with (root / "first.jsonl").open("w") as output:
        for line in first.stdout:
            output.write(line)
            output.flush()
            events.put(json.loads(line))
        events.put(None)
reader = threading.Thread(target=read_events)
reader.start()
session = None
supervisor = None
try:
    deadline = time.monotonic() + 90
    while True:
        event = events.get(timeout=max(0.1, deadline - time.monotonic()))
        if event is None:
            raise RuntimeError("agent exited before bash became ready")
        if event["kind"] == "interface.session":
            session = event["data"]
        if event["kind"] == "tool.progress" and "M2_BASH_READY" in event.get("data", ""):
            journals = list((root / "history" / "commands").glob("*.json"))
            assert len(journals) == 1
            supervisor = json.loads(journals[0].read_text())["Guardian"]["PID"]
            killed_at = event["time"]
            print(f"kill -9 {first.pid} during bash call {event['call']}", flush=True)
            os.kill(first.pid, signal.SIGKILL)
            break
    assert first.wait(timeout=10) == -signal.SIGKILL
    reader.join(timeout=10)
    first_err.close()
    if supervisor is not None:
        os.waitpid(supervisor, 0)
    assert not (project / "completion.txt").exists()
    second_args = base + ["--session", session]
    (root / "commands.json").write_text(json.dumps([first_args, second_args], indent=2))
    second = subprocess.run(second_args, capture_output=True, text=True, timeout=90)
    (root / "second.jsonl").write_text(second.stdout)
    (root / "second.stderr").write_text(second.stderr)
    assert second.returncode == 0, f"resume failed with exit code {second.returncode}"
    snapshots = list((root / "history").glob("*.json"))
    assert len(snapshots) == 1
    snap = json.loads(snapshots[0].read_text())
    entries = snap["entries"]
    starts = [e for e in entries if e["kind"] == "turn.start"]
    ends = [e for e in entries if e["kind"] == "turn.end"]
    results = [e for e in entries if e["kind"] == "tool.result"]
    unknown = [e for e in results if e["data"]["status"] == "unknown"]
    assert len(starts) == len(ends) == len(unknown) == 1
    assert starts[0]["turn"] == ends[0]["turn"]
    assert ends[0]["data"]["status"] == "completed"
    assert not (project / "completion.txt").exists()
    calls = [e for e in entries if e["kind"] == "tool.call"]
    assert len(calls) == len(results)
    original = calls[0]["data"]["input"]["command"]
    assert sum(e["data"]["name"] == "bash" and e["data"]["input"].get("command") == original
               for e in calls) == 1
    summary = {"root": str(root), "session": session, "turn": starts[0]["turn"],
               "killed_at": killed_at, "first_pid": first.pid, "supervisor_pid": supervisor,
               "outcome": ends[0]["data"], "calls": [e["data"] for e in calls],
               "unknown_result": unknown[0]["data"], "completion_file_exists": False}
    (root / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
finally:
    if first.poll() is None:
        first.kill()
        first.wait(timeout=10)
    reader.join(timeout=10)
    first_err.close()
    if supervisor is not None:
        try:
            os.waitpid(supervisor, 0)
        except ChildProcessError:
            pass
    print(f"Evidence: {root}", flush=True)
