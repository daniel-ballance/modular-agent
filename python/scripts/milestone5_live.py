"""Bounded all-plugins-moved proof. Offline by default only with explicit flag.

uv run python scripts/milestone5_live.py --offline --output /tmp/ma-m5-offline
uv run python scripts/milestone5_live.py --confirm-live --output /tmp/ma-m5-live
uv run python scripts/milestone5_live.py --verify-only --output /tmp/ma-m5-live
"""

import argparse
import asyncio
import json
import os
from pathlib import Path

from ma_core import Plugin, content, plain

MODEL = "claude-haiku-5-5"
MARKER = "M5-PROCESS-PROOF-96427"
COMMAND = "cat proof.txt"


class Audit(Plugin):
    name = "proof_audit"

    def __init__(self, path, provider):
        self.path, self.provider = Path(path), provider

    async def start(self, api):
        await super().start(api)
        api.on(self.provider + ".before", self.request)

    async def request(self, d):
        with self.path.open("a") as file:
            file.write(
                json.dumps(
                    {
                        "session": d["session"],
                        "model": d["access"]["id"],
                        "thinking": d.get("settings", {}).get("thinking", "off"),
                        "audit_pid": os.getpid(),
                    }
                )
                + "\n"
            )
        return d


def save(output, name, data):
    (output / name).write_text(json.dumps(data, indent=2) + "\n")


def descendants(pid):
    result = []
    try:
        children = Path(f"/proc/{pid}/task/{pid}/children").read_text().split()
    except FileNotFoundError:
        return result
    for child in children:
        child = int(child)
        result.extend([child, *descendants(child)])
    return result


def validate(output):
    proof = json.loads((output / "proof.json").read_text())
    es = proof["entries"]
    calls = [e for e in es if e["kind"] == "tool_call"]
    results = [e for e in es if e["kind"] == "tool_result"]
    assert len(calls) == len(results) == 1
    assert calls[0]["call"] == results[0]["call"]
    assert calls[0]["data"]["name"] == "bash"
    assert calls[0]["data"]["input"]["command"] == COMMAND
    assert results[0]["data"]["status"] == "completed"
    assert MARKER in plain(results[0]["content"])
    queued = next(e for e in es if e["kind"] == "input_queued")
    assert MARKER not in plain(queued["content"]), "marker was supplied to the model"
    assert (output / "project/proof.txt").read_text() == MARKER + "\n"
    ends = [e for e in es if e["kind"] == "turn_end"]
    assert len(ends) == 1 and ends[0]["data"]["outcome"] == "completed"
    answer = plain(ends[0]["data"]["content"])
    assert MARKER in answer
    requests = [json.loads(line) for line in (output / "requests.jsonl").read_text().splitlines()]
    expected_model = "fake" if proof["offline"] else MODEL
    assert len(requests) == 2 and {r["model"] for r in requests} == {expected_model}
    assert {r["thinking"] for r in requests} == {"off"}
    placements = proof["placements"]
    provider = "fake" if proof["offline"] else "claude"
    expected = [provider, proof["runtime"], "files", "local", "mcp", "proof_audit"]
    assert all(name in placements for name in expected)
    pids = [p["pid"] for p in placements.values()]
    assert len(set(pids)) == len(pids) and proof["harness_pid"] not in pids
    assert all(
        p["placement"] == "process" and p["ppid"] == proof["harness_pid"]
        for p in placements.values()
    )
    assert {r["audit_pid"] for r in requests} == {placements["proof_audit"]["pid"]}
    trace = [tuple(t) for t in proof["trace"]]
    assert (proof["runtime"], provider, "generate") in trace
    assert (proof["runtime"], "tools", "run") in trace
    assert ("files", "environment", "bash") in trace
    events = [json.loads(line) for line in (output / "events.jsonl").read_text().splitlines()]
    assert any(e["kind"] == "tool_progress" and MARKER in e.get("text", "") for e in events)
    assert any(e["kind"] == "model_output" and e.get("text") for e in events)
    assert not [e for e in events if e["kind"] == "plugin_failed"]
    assert proof["cleanup"] and not proof["remaining_pids"]
    summary = {
        "offline": proof["offline"],
        "model": expected_model,
        "runtime": proof["runtime"],
        "session": proof["session"],
        "model_requests": len(requests),
        "plugin_processes": len(pids),
        "streamed_bash": True,
        "streamed_model": True,
        "all_processes_stopped": True,
        "answer": answer,
    }
    save(output, "summary.json", summary)
    return summary


async def demonstrate(output, offline=False, runtime="durable"):
    from ma_claude import Claude
    from ma_durable import Durable
    from ma_fake import Fake, call, reply
    from ma_local.containment import delegated_root
    from ma_process import ProcessPlugin
    from ma_runtime import Runtime
    from ma_cli import build

    delegated_root()  # Refuse before inference if command containment is unavailable.
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    project = output / "project"
    project.mkdir()
    (project / "proof.txt").write_text(MARKER + "\n")
    provider = (
        Fake(
            [
                reply(calls=[call("bash", command=COMMAND)]),
                reply(
                    "The exact marker is " + MARKER + ".",
                    pieces=["The exact marker is ", MARKER, "."],
                ),
            ]
        )
        if offline
        else Claude()
    )
    h = await build(
        output / "store",
        provider,
        runtime=Durable() if runtime == "durable" else Runtime(),
        project=project,
        process_plugins="all",
    )
    a = h.api()
    event_file = (output / "events.jsonl").open("w")
    proof = {"offline": offline, "runtime": runtime, "harness_pid": os.getpid(), "placements": {}}

    async def follow(event):
        event_file.write(json.dumps(event) + "\n")
        event_file.flush()

    a.follow("live-proof", follow)
    try:
        await h.load(Audit(output / "requests.jsonl", provider.name))
        for name, plugin in h.plugins.items():
            assert isinstance(plugin, ProcessPlugin)
            ppid = int(Path(f"/proc/{plugin.pid}/stat").read_text().rsplit(")", 1)[1].split()[1])
            proof["placements"][name] = {
                "placement": "process",
                "pid": plugin.pid,
                "ppid": ppid,
                "role": plugin.role,
            }
        sid = (
            await a.session(
                "create",
                project=str(project),
                settings={
                    "model": "fake" if offline else MODEL,
                    "thinking": "off",
                    "max_steps": 3,
                    "approval": "off",
                    "max_depth": 0,
                },
            )
        )["id"]
        proof["session"] = sid
        async with asyncio.timeout(90):
            await a.call(
                "runtime",
                "submit",
                {
                    "session": sid,
                    "key": "m5-proof",
                    "content": content(
                        "Use bash exactly once with the exact command `cat proof.txt`. "
                        "Then answer in one short sentence giving the exact marker from its output. "
                        "Do not use any other tool or ask questions. The file content is not in this prompt."
                    ),
                },
            )
            proof["turns"] = await a.call("runtime", "wait", {"session": sid})
        proof["entries"] = (await a.session("get", session=sid))["entries"]
        proof["trace"] = h.trace
    finally:
        children = descendants(os.getpid())
        await h.stop()
        event_file.close()
        # The SDK and command watcher also have to be gone, not only plugin PIDs.
        async with asyncio.timeout(5):
            while any(Path(f"/proc/{pid}").exists() for pid in children):
                await asyncio.sleep(0.01)
        proof["cleanup"] = True
        proof["remaining_pids"] = [pid for pid in children if Path(f"/proc/{pid}").exists()]
        save(output, "proof.json", proof)
    return validate(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--offline", action="store_true")
    mode.add_argument("--confirm-live", action="store_true")
    mode.add_argument("--verify-only", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runtime", choices=["transient", "durable"], default="durable")
    args = parser.parse_args()
    result = (
        validate(args.output)
        if args.verify_only
        else asyncio.run(demonstrate(args.output, args.offline, args.runtime))
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
