#!/usr/bin/env python3
"""Milestone 2 live crash check. Only the Rust credential plugin reads the key."""
import ctypes
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

repo = Path(__file__).resolve().parents[1]
binary = repo / "target/debug/modular-agent"
if not binary.exists():
    raise SystemExit("Build first: mise exec -- cargo build -p modular-agent --locked --offline")
# Adopt and reap the killed agent's command descendants.
if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
    raise SystemExit("Cannot become a child subreaper")


def live(pid):
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
        return state not in ("Z", "X")
    except FileNotFoundError:
        return False


def reap():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if pid == 0:
                return
        except ChildProcessError:
            return


with tempfile.TemporaryDirectory(prefix="modular-agent-rs-m2-real-") as temp:
    root = Path(temp)
    project = root / "project"
    project.mkdir()
    (project / "AGENTS.md").write_text(
        "Follow the requested crash demonstration. Never repeat the original bash command. "
        "If interrupted, inspect receipt.txt with read before reporting its content. "
        "Keep the final answer to one short sentence.\n"
    )
    (project / ".modular-agent.json").write_text(json.dumps({"output_limit": 1024, "step_limit": 5}))
    command = "printf 'copper-river-83\\n' > receipt.txt; printf '%s\\n' \"$$\" > bash.pid; printf 'M2_BASH_READY\\n'; sleep 60"
    prompt = (
        "Use bash to run exactly this command once: " + command + "\n"
        "After the bash call, even if it was interrupted, use read on receipt.txt to check its "
        "outside effect. Do not repeat that bash command. Then report the receipt's content "
        "and explicitly say the turn recovered from interruption."
    )
    base = [
        str(binary), "--runtime", "durable", "--provider-mode", "stateless",
        "--approval", "off", "--project", str(project),
        "--data-dir", str(root / "state"), "--global-config", str(root / "NO-SETTINGS"), "--json",
    ]
    first = None
    second = None
    bash_pid = None
    try:
        with (root / "first.jsonl").open("w") as output, (root / "first.err").open("w") as errors:
            first = subprocess.Popen(base + ["--prompt", prompt], cwd=repo, stdin=subprocess.DEVNULL,
                                     stdout=output, stderr=errors)
            deadline = time.monotonic() + 120
            while not (project / "bash.pid").exists():
                if first.poll() is not None:
                    raise RuntimeError("Agent exited before bash: " + (root / "first.err").read_text())
                if time.monotonic() > deadline:
                    raise TimeoutError("Model did not start bash")
                time.sleep(0.01)
            bash_pid = int((project / "bash.pid").read_text())
            time.sleep(0.05)
            assert live(bash_pid)
            sessions = list((root / "state/sessions").glob("*.json"))
            assert len(sessions) == 1
            before = json.loads(sessions[0].read_text())
            call = next(e for e in before["entries"] if e["kind"] == "toolStarted")
            assert call["data"]["call"]["name"] == "bash", call
            assert not any(e["kind"] == "toolResult" for e in before["entries"])
            turn = call["turnId"]
            session = before["id"]
            # Exactly kill -9, and only this known agent PID.
            subprocess.run(["kill", "-9", str(first.pid)], check=True)
            assert first.wait(timeout=10) == -signal.SIGKILL
        deadline = time.monotonic() + 5
        while live(bash_pid) and time.monotonic() < deadline:
            time.sleep(0.01)
        assert not live(bash_pid), "bash outlived its agent"
        reap()
        with (root / "second.jsonl").open("w") as output, (root / "second.err").open("w") as errors:
            # No new input. Opening alone must resume the interrupted turn.
            second = subprocess.Popen(base + ["--session", session, "--history"], cwd=repo, stdin=subprocess.DEVNULL,
                                      stdout=output, stderr=errors)
            try:
                code = second.wait(timeout=120)
            except subprocess.TimeoutExpired:
                print("Reopen timed out. Last event kinds:", [
                    json.loads(line).get("kind") for line in (root / "second.jsonl").read_text().splitlines()
                ][-15:])
                raise
        assert code == 0, (root / "second.err").read_text()
        after = json.loads(sessions[0].read_text())
        entries = after["entries"]
        unknown = next(e["data"] for e in entries if e["kind"] == "toolResult" and e["toolCallId"] == call["toolCallId"])
        assert unknown["status"] == "outcomeUnknown", unknown
        tools = [e["data"]["call"] for e in entries if e["kind"] == "toolStarted"]
        assert len([c for c in tools if c["name"] == "bash"]) == 1, tools
        assert any(c["name"] == "read" and c["input"]["path"] == "receipt.txt" for c in tools)
        starts = [e for e in entries if e["kind"] == "turnStart"]
        ends = [e for e in entries if e["kind"] == "turnEnd"]
        assert len(starts) == len(ends) == 1
        assert ends[0]["turnId"] == turn
        result = ends[0]["data"]
        assert result["outcome"]["kind"] == "completed", result
        assert "copper-river-83" in result["result"]["text"], result
        resumed = [json.loads(line) for line in (root / "second.jsonl").read_text().splitlines()]
        assert any(e["kind"] == "turn.resumed" for e in resumed)
        evidence = {
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "model": "gpt-6-luna", "provider": "OpenAI Responses API", "provider_mode": "stateless",
            "runtime": "durable", "agent_processes": 2, "session": session, "turn": turn,
            "kill": {"command": "kill -9 AGENT_PID", "agent_pid": first.pid, "bash_pid": bash_pid,
                     "bash_was_running": True, "bash_stopped_after_sigkill": True},
            "reopened_without_new_input": True, "same_turn_start_count": len(starts),
            "original_bash_not_repeated": True, "unknown_result": unknown,
            "tools": tools, "result": result,
            "model_requests": len([e for e in entries if e["kind"] == "modelRequest"]),
        }
        print(json.dumps(evidence, indent=2))
    finally:
        for process in (first, second):
            if process is not None and process.poll() is None:
                process.kill()
                process.wait(timeout=10)
        if bash_pid is not None and live(bash_pid):
            os.kill(bash_pid, signal.SIGKILL)
        reap()
