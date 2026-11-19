"""The live evidence validator is tested offline before spending inference."""

import json

import pytest

from scripts.milestone3_live import FILENAME, MARKER, validate


def evidence(tmp_path):
    def entry(kind, **kw):
        return {"kind": kind, **kw}

    child = [
        entry("tool_call", call="bash", data={"name": "bash"}),
        entry("tool_result", call="bash", data={"status": "completed"}),
    ]
    parent = [
        entry("job_start", job="job", data={"detail": {"child": "child"}}),
        entry("job_end", job="job", data={"state": "completed"}),
        entry("turn_start", data={"source": None}),
        entry("turn_end", data={"outcome": "completed", "content": []}),
        entry("turn_start", data={"source": {"job": "job"}}),
        entry(
            "turn_end",
            data={
                "outcome": "completed",
                "content": [
                    {"type": "text", "text": "Used bash to write " + FILENAME + " with " + MARKER}
                ],
            },
        ),
    ]
    data = {
        "root": "root",
        "sessions": {"root": parent, "child": child},
        "requests": [{"model": "claude-haiku-5-5"}] * 5,
    }
    (tmp_path / "project").mkdir()
    (tmp_path / "project" / FILENAME).write_text(MARKER + "\n")
    return data


def test_live_validator_counts_requests_and_job_started_turn(tmp_path):
    data = evidence(tmp_path)
    (tmp_path / "history.json").write_text(json.dumps(data))
    assert validate(tmp_path)["model_requests"] == 5


@pytest.mark.parametrize("change", ["wrong_source", "duplicate_result", "wrong_model"])
def test_live_validator_rejects_invalid_proof(tmp_path, change):
    data = evidence(tmp_path)
    if change == "wrong_source":
        data["sessions"]["root"][-2]["data"]["source"]["job"] = "not-this-job"
    elif change == "duplicate_result":
        data["sessions"]["child"].append(data["sessions"]["child"][-1])
    else:
        data["requests"][0]["model"] = "not-allowed"
    (tmp_path / "history.json").write_text(json.dumps(data))
    with pytest.raises(AssertionError):
        validate(tmp_path)
