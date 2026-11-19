import importlib.util
import json
from pathlib import Path

import pytest


path = Path(__file__).resolve().parents[1] / "scripts/milestone4_live.py"
spec = importlib.util.spec_from_file_location("milestone4_live", path)
live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)


@pytest.fixture
async def evidence(tmp_path, runtime_kind):
    output = tmp_path / "evidence"
    await live.demonstrate(output, offline=True, runtime=runtime_kind)
    return output


async def test_acp_driver_runs_offline_and_revalidates_without_inference(evidence):
    summary = live.validate(evidence)
    assert summary["model"] == "fake" and summary["model_requests"] == 2
    assert summary["permissions"] == summary["mcp_calls"] == 1
    assert summary["load_replayed"] and not summary["resume_replayed"]


async def test_acp_validator_rejects_wrong_model(evidence):
    path = evidence / "requests.jsonl"
    lines = path.read_text().splitlines()
    changed = json.loads(lines[0])
    changed["model"] = "not-the-allowed-model"
    path.write_text(json.dumps(changed) + "\n" + lines[1] + "\n")
    with pytest.raises(AssertionError):
        live.validate(evidence)


async def test_acp_validator_rejects_missing_or_duplicate_tool_results(evidence):
    path = evidence / "follow.json"
    data = json.loads(path.read_text())
    result = next(e for e in data["entries"] if e["kind"] == "tool_result")
    data["entries"].append(result)
    path.write_text(json.dumps(data))
    with pytest.raises(AssertionError):
        live.validate(evidence)


async def test_acp_validator_rejects_unclean_exit(evidence):
    (evidence / "process.json").write_text(json.dumps({"exit_code": 1}))
    with pytest.raises(AssertionError):
        live.validate(evidence)
