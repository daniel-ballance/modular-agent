#!/usr/bin/env python3
"""Milestone 3 demonstration. Only the Rust credential plugin reads the key."""
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[1]
binary = repo / "target/debug/modular-agent"
if not binary.exists():
    raise SystemExit("Build first: mise exec -- cargo build -p modular-agent --locked --offline")

with tempfile.TemporaryDirectory(prefix="modular-agent-rs-m3-real-") as temp:
    root = Path(temp)
    project = root / "project"
    project.mkdir()
    (project / "AGENTS.md").write_text(
        "Follow the assigned demonstration task exactly. Keep answers to one short sentence. "
        "Do not inspect unrelated files. Do not ask questions or start extra subagents.\n"
    )
    (project / ".modular-agent.json").write_text(json.dumps({"output_limit": 768, "step_limit": 4}))
    task = (
        "Use bash exactly once to run: printf 'silver-meadow-31\\n' > subagent-receipt.txt\n"
        "Then end with a short report saying you wrote subagent-receipt.txt using bash and "
        "that its content is silver-meadow-31. Do not use any other tools."
    )
    prompt = (
        "Demonstrate a background subagent. Use delegate exactly once with background=true "
        "and this task: " + task + "\n"
        "Leave delegate authority, model and session unset/null to inherit the normal defaults. "
        "Do not do the child's work yourself and do not use any other tools. "
        "After delegate returns, end this turn with 'Background work started.' "
        "When the job report arrives later as new input, do not delegate again or run tools. "
        "In that NEW turn, briefly describe what the subagent did, including the filename and content."
    )
    completed = subprocess.run([
        str(binary), "--runtime", "durable", "--subagents", "durable", "--approval", "off",
        "--project", str(project), "--data-dir", str(root / "state"),
        "--global-config", str(root / "NO-SETTINGS"), "--json", "--prompt", prompt,
    ], cwd=repo, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=180)
    if completed.returncode:
        raise RuntimeError("Agent failed: " + completed.stderr)
    events = [json.loads(line) for line in completed.stdout.splitlines()]
    sessions = [json.loads(path.read_text()) for path in (root / "state/sessions").glob("*.json")]
    assert len(sessions) == 2, "expected exactly a parent and one child"
    parent = next(s for s in sessions if "_parent" not in s["settings"])
    child = next(s for s in sessions if "_parent" in s["settings"])
    assert child["settings"]["_parent"]["session"] == parent["id"]
    calls = lambda s: [e["content"] for e in s["entries"] if e["kind"] == "tool.call"]
    responses = [e for s in sessions for e in s["entries"] if e["kind"] == "model.response"]
    attempt = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "model": "gpt-6-luna", "parent_calls": calls(parent), "child_calls": calls(child),
        "parent_results": [e["content"] for e in parent["entries"] if e["kind"] in ("tool.result", "turn.end", "job.end")],
        "child_results": [e["content"] for e in child["entries"] if e["kind"] in ("tool.result", "turn.end")],
        "model_requests": len(responses),
        "usage": {key:sum(e["content"]["usage"][key] for e in responses) for key in ("input_tokens", "output_tokens", "cached_tokens")},
    }
    (repo / "evidence/m3-last-attempt.json").write_text(json.dumps(attempt, indent=2) + "\n")
    assert [c["name"] for c in calls(parent)] == ["delegate"]
    assert calls(parent)[0]["input"]["background"] is True
    assert [c["name"] for c in calls(child)] == ["bash"]
    assert next(e["content"] for e in child["entries"] if e["kind"] == "tool.result")["status"] == "completed", attempt
    assert (project / "subagent-receipt.txt").read_text() == "silver-meadow-31\n"
    starts = [e for e in parent["entries"] if e["kind"] == "turn.start"]
    ends = [e for e in parent["entries"] if e["kind"] == "turn.end"]
    assert len(starts) == len(ends) == 2
    assert all(e["content"]["outcome"] == "completed" for e in ends)
    job = next(e["content"] for e in parent["entries"] if e["kind"] == "job.end")
    assert job["state"] == "completed"
    assert starts[1]["scope"]["job"] == job["id"]
    assert starts[1]["scope"]["actor"] == "job:" + job["id"]
    final = ends[1]["content"]["text"]
    assert "subagent-receipt.txt" in final and "silver-meadow-31" in final
    first_child_input = next(e["content"]["text"] for e in child["entries"] if e["kind"] == "input")
    assert first_child_input == calls(parent)[0]["input"]["task"]
    responses = [e for s in sessions for e in s["entries"] if e["kind"] == "model.response"]
    evidence = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "model": "gpt-6-luna", "provider": "OpenAI Responses API", "provider_mode": "stateless",
        "runtime": "durable", "subagents": "durable", "agent_processes": 1,
        "parent_session": parent["id"], "child_session": child["id"],
        "child_received_only_its_task": True,
        "parent_calls": calls(parent), "child_calls": calls(child),
        "receipt": "silver-meadow-31\n", "job": job,
        "parent_turns": [{"scope":e["scope"], "result":e["content"]} for e in ends],
        "report_started_new_parent_turn": True,
        "model_requests": len(responses),
        "usage": {key:sum(e["content"]["usage"][key] for e in responses)
                  for key in ("input_tokens", "output_tokens", "cached_tokens")},
        "events_include_job_end": any(e["kind"] == "job.ended" for e in events),
    }
    path = repo / "evidence/m3-real-run.json"
    path.write_text(json.dumps(evidence, indent=2) + "\n")
    (repo / "evidence/m3-last-attempt.json").unlink()
    print(json.dumps(evidence, indent=2))
