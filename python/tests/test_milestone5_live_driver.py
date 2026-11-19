"""Exercise and tamper-check the complete process proof without inference."""

import json

import pytest

from scripts.milestone5_live import demonstrate, validate


async def test_complete_process_live_driver_offline(tmp_path, runtime_kind):
    summary = await demonstrate(tmp_path / "proof", offline=True, runtime=runtime_kind)
    assert summary["offline"] and summary["model"] == "fake"
    assert summary["model_requests"] == 2 and summary["plugin_processes"] == 18
    assert summary["all_processes_stopped"]
    assert summary == validate(tmp_path / "proof")


@pytest.mark.parametrize("corruption", ["placement", "model", "cleanup", "result"])
async def test_process_live_validator_rejects_corrupt_evidence(tmp_path, runtime_kind, corruption):
    output = tmp_path / "proof"
    await demonstrate(output, offline=True, runtime=runtime_kind)
    path = output / ("requests.jsonl" if corruption == "model" else "proof.json")
    if corruption == "model":
        requests = [json.loads(line) for line in path.read_text().splitlines()]
        requests[0]["model"] = "unapproved"
        path.write_text("".join(json.dumps(r) + "\n" for r in requests))
    else:
        data = json.loads(path.read_text())
        if corruption == "placement":
            data["placements"]["local"]["pid"] = data["harness_pid"]
        elif corruption == "cleanup":
            data["cleanup"] = False
        else:
            next(e for e in data["entries"] if e["kind"] == "tool_result")["data"]["status"] = (
                "failed"
            )
        path.write_text(json.dumps(data))
    with pytest.raises(AssertionError):
        validate(output)
