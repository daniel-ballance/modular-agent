#!/usr/bin/env python3
"""Explicit real Haiku 5.5 demonstration. This is not an offline test."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

binary = Path(sys.argv[1] if len(sys.argv) > 1 else "bin/modular").resolve()
root = Path(tempfile.mkdtemp(prefix="modular-go-m3-real."))
project = root / "project"
project.mkdir()
(project / "AGENTS.md").write_text("Keep responses short. Follow the requested tool order.\n")
prompt = (
    "Use delegate exactly once with background=true. Give the subagent only this task: "
    "Use bash to run `sleep 3; printf 'm3-cobalt-73\\n' > child-note.txt`, then report "
    "that you wrote child-note.txt with bash and include the marker m3-cobalt-73. "
    "Do not delegate further. "
    "After delegate returns, end your current turn with 'Background job started.' "
    "Do not run file or bash tools yourself. When the job report arrives as new input, "
    "describe what the subagent did, naming the file, bash and the marker in one sentence."
)
args = [str(binary), "--runtime", "durable", "--subagents", "durable", "--wait-jobs",
        "--state", str(root / "history"), "--settings", str(root / "absent-settings"),
        "--project", str(project), "--mode", "json", "--key", "m3-real", "--prompt", prompt]
(root / "commands.json").write_text(json.dumps([args], indent=2))
run = subprocess.run(args, capture_output=True, text=True, timeout=120)
(root / "events.jsonl").write_text(run.stdout)
(root / "stderr.txt").write_text(run.stderr)
print(f"Evidence: {root}", flush=True)
assert run.returncode == 0, f"agent exited {run.returncode}; see private evidence"
events = [json.loads(line) for line in run.stdout.splitlines()]
parent_id = next(e["data"] for e in events if e["kind"] == "interface.session")
snapshots = [json.loads(p.read_text()) for p in (root / "history").glob("*.json")]
parent = next(s for s in snapshots if s["id"] == parent_id)
children = [s for s in snapshots if s.get("parent") == parent_id]
assert len(children) == 1
child = children[0]
assert (project / "child-note.txt").read_text() == "m3-cobalt-73\n"
entries = parent["entries"]
starts = [e for e in entries if e["kind"] == "turn.start"]
ends = [e for e in entries if e["kind"] == "turn.end"]
jobs = [e for e in entries if e["kind"] == "job.end"]
assert len(starts) == len(ends) == 2
assert len(jobs) == 1 and jobs[0]["data"]["State"] == "completed"
reports = [e for e in entries if e["kind"] == "input" and e.get("job") == jobs[0]["job"]]
assert len(reports) == 1
accepted = next(e for e in entries if e["kind"] == "input.accepted" and e["data"].get("Job") == jobs[0]["job"])
assert starts[1]["data"]["Input"] == accepted["data"]["ID"]
assert jobs[0]["time"] > ends[0]["time"]
assert not any(e["kind"] == "tool.call" and e["data"]["name"] == "bash" for e in entries)
assert any(e["kind"] == "tool.call" and e["data"]["name"] == "bash" for e in child["entries"])
answer = "".join(p.get("text", "") for p in ends[-1]["data"].get("result", []))
assert all(s in answer.lower() for s in ("child-note.txt", "bash", "m3-cobalt-73"))
summary = {"root": str(root), "parent": parent_id, "child": child["id"],
           "job": jobs[0]["job"], "parent_turns": len(starts),
           "model_requests": sum(e["kind"] == "model" for s in snapshots for e in s["entries"]),
           "child_file": "child-note.txt", "marker": "m3-cobalt-73", "parent_answer": answer,
           "parent_turn_ids": [e["turn"] for e in starts], "job_ended": jobs[0]["time"]}
(root / "summary.json").write_text(json.dumps(summary, indent=2))
print(json.dumps(summary, indent=2))
