#!/usr/bin/env python3
"""The milestone 1 live check. The Rust credential plugin alone reads the key."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[1]
binary = repo / "target/debug/modular-agent"
if not binary.exists():
    raise SystemExit("Build first: mise exec -- cargo build -p modular-agent --offline")
with tempfile.TemporaryDirectory(prefix="modular-agent-rs-real-") as temp:
    root = Path(temp)
    project = root / "project"
    project.mkdir()
    (project / "AGENTS.md").write_text("Use read for files. Answer in one short sentence. Do not modify files.\n")
    fact = project / "fact.txt"
    fact.write_text("Launch label: alder-orbit-73\nSeats: 29\n")
    base = [str(binary), "--project", str(project), "--data-dir", str(root / "state"),
            "--global-config", str(root / "no-global-settings"), "--json"]

    def run(extra):
        result = subprocess.run(base + extra, cwd=repo, capture_output=True, text=True, timeout=120)
        events = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        if result.returncode:
            errors = [e for e in events if e["kind"] == "turn.result"]
            raise SystemExit("Live check failed: " + json.dumps(errors) + "\n" + result.stderr)
        return events

    first = run(["--prompt", "Use read to read fact.txt. What are the launch label and the number of seats?"])
    session = next(e["scope"]["session"] for e in first if e["kind"] == "session.open")
    first_result = next(e["content"] for e in first if e["kind"] == "turn.result")
    calls = [e["content"] for e in first if e["kind"] == "tool.requested"]
    assert any(c["name"] == "read" and c["input"].get("path") == "fact.txt" for c in calls), calls
    assert "alder-orbit-73" in first_result["text"] and "29" in first_result["text"], first_result
    # The second process must use stored history, not reread the source file.
    fact.unlink()
    second = run(["--session", session, "--prompt",
                  "Without reading any files again, what was the launch label, and what is twice the number of seats?"])
    second_result = next(e["content"] for e in second if e["kind"] == "turn.result")
    assert "alder-orbit-73" in second_result["text"] and "58" in second_result["text"], second_result
    assert not any(e["kind"] == "tool.requested" for e in second), second
    evidence = {
        "model": "gpt-6-luna",
        "provider": "OpenAI Responses API",
        "mode": "stateless",
        "session": session,
        "separate_agent_processes": 2,
        "first": {"result": first_result, "tools": calls},
        "source_file_removed_before_continuation": True,
        "second": {"result": second_result, "tools": []},
        "checked_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
    }
    path = repo / "evidence/m1-real-run.json"
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence, indent=2))
