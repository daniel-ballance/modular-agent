"""Opt-in Haiku-only background subagent demonstration. No credential logging.

uv run python scripts/milestone3_live.py --confirm-live --output /tmp/ma-m3-live
uv run python scripts/milestone3_live.py --verify-only --output /tmp/ma-m3-live
"""

import argparse
import asyncio
import json
from pathlib import Path

from ma_core import content, plain

MARKER = "M3-CHILD-61742"
FILENAME = "child-proof.txt"


def validate(output):
    data = json.loads((output / "history.json").read_text())
    root = data["root"]
    parent = data["sessions"][root]
    starts = [e for e in parent if e["kind"] == "job_start"]
    ends = [e for e in parent if e["kind"] == "job_end"]
    assert len(starts) == len(ends) == 1
    job = starts[0]["job"]
    child = starts[0]["data"]["detail"]["child"]
    assert ends[0]["data"]["state"] == "completed"
    child_history = data["sessions"][child]
    calls = [e for e in child_history if e["kind"] == "tool_call"]
    assert calls and any(e["data"]["name"] == "bash" for e in calls)
    assert (output / "project" / FILENAME).read_text() == MARKER + "\n"
    turns = [e for e in parent if e["kind"] == "turn_start"]
    results = [e for e in parent if e["kind"] == "turn_end"]
    assert len(turns) == len(results) == 2
    assert all(e["data"]["outcome"] == "completed" for e in results)
    assert turns[1]["data"]["source"]["job"] == job
    answer = plain(results[1]["data"]["content"])
    assert FILENAME in answer and MARKER in answer and "bash" in answer.lower()
    for es in data["sessions"].values():
        calls = [e["call"] for e in es if e["kind"] == "tool_call"]
        results = [e["call"] for e in es if e["kind"] == "tool_result"]
        assert sorted(calls) == sorted(results) and len(results) == len(set(results))
    requests = data["requests"]
    assert requests and {r["model"] for r in requests} == {"claude-haiku-5-5"}
    summary = {
        "model": "claude-haiku-5-5",
        "root": root,
        "child": child,
        "job": job,
        "model_requests": len(requests),
        "parent_turns": 2,
        "file": FILENAME,
        "file_text": MARKER,
        "child_tools": [e["data"]["name"] for e in child_history if e["kind"] == "tool_call"],
        "answer": answer,
    }
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary


async def demonstrate(output):
    from ma_claude import Claude, MODEL
    from ma_durable import Durable
    from ma_durable_subagents import DurableSubagents
    from ma_local.containment import delegated_root
    from modular_agent import build

    delegated_root()  # Preflight before inference.
    assert MODEL == "claude-haiku-5-5"
    output.mkdir(parents=True, exist_ok=False)
    project = output / "project"
    project.mkdir()
    h = await build(output / "store", Claude(), runtime=Durable(), subagents=DurableSubagents())
    a = h.api()
    root, requests, events = None, [], []
    finished = asyncio.Event()
    event_file = (output / "events.jsonl").open("w")

    async def event(e):
        events.append(e)
        event_file.write(json.dumps(e) + "\n")
        event_file.flush()
        if e["kind"] == "turn_ended" and e["session"] == root:
            if len([e for e in events if e["kind"] == "turn_ended" and e["session"] == root]) >= 2:
                finished.set()

    async def request(d):
        requests.append({"session": d["session"], "model": d["access"]["id"]})
        return d

    a.follow("live-driver", event)
    a.on("claude.before", request)
    try:
        root = (
            await a.session(
                "create",
                project=str(project),
                settings={
                    "model": MODEL,
                    "thinking": "off",
                    "max_steps": 5,
                    "max_depth": 1,
                    "approval": "off",
                },
            )
        )["id"]
        command = "printf '" + MARKER + "\\n' > " + FILENAME
        task = (
            "Use bash exactly once to run this exact command:\n```\n"
            + command
            + "\n```\nThen report in one sentence the file name, its text marker, and that you used bash. Do not delegate, ask questions or use any other tool."
        )
        prompt = (
            "Use delegate exactly once, background=true, with this exact child task:\n"
            + task
            + "\n"
            "Do not write the file yourself. After delegate returns the job and child IDs, answer only 'Background job started.' "
            "The job report will arrive as new input in a later turn. In that report-started turn, describe the child's work in one sentence, including bash, "
            + FILENAME
            + " and "
            + MARKER
            + ". Do not delegate again or call any other tools."
        )
        (output / "prompt.txt").write_text(prompt)
        async with asyncio.timeout(100):
            await a.call("runtime", "submit", {"session": root, "content": content(prompt)})
            await finished.wait()
            await a.call("runtime", "wait", {"session": root})
        data = {
            "root": root,
            "sessions": {sid: s["entries"] for sid, s in h.sessions.items()},
            "requests": requests,
        }
        (output / "history.json").write_text(json.dumps(data, indent=2) + "\n")
        return validate(output)
    finally:
        # Preserve partial evidence even if the model or validator fails.
        if not (output / "history.json").exists():
            (output / "history.json").write_text(
                json.dumps(
                    {
                        "root": root,
                        "sessions": {sid: s["entries"] for sid, s in h.sessions.items()},
                        "requests": requests,
                    },
                    indent=2,
                )
            )
        await h.stop()
        event_file.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--confirm-live", action="store_true")
    mode.add_argument("--verify-only", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    summary = (
        validate(args.output.resolve())
        if args.verify_only
        else asyncio.run(demonstrate(args.output.resolve()))
    )
    print(json.dumps(summary, indent=2))
