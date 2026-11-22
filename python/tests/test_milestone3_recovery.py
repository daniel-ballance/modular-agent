"""Real process death, fake Provider: questions and both subagent variants."""

import asyncio
import json
import sys
from pathlib import Path

import pytest

from ma_fake import Fake
from ma_cli import build
from test_swap import DRIVER_STARTUP, until
from test_vanilla import paired


async def driver(home, project, runtime, variant, action):
    return await asyncio.create_subprocess_exec(
        sys.executable,
        str(Path(__file__).with_name("milestone3_crash_driver.py")),
        str(home),
        str(project),
        runtime,
        variant,
        action,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )


async def crash_and_reopen(tmp_path, runtime, variant, action, reopen):
    home = tmp_path / "store"
    p = await driver(home, tmp_path, runtime, variant, action)
    q = None
    try:
        try:
            await until(
                lambda: (tmp_path / "checkpoint").exists() or p.returncode is not None,
                DRIVER_STARTUP,
            )
        except TimeoutError:
            # It normally takes about 0.3 s (under 1.5 s with every core busy). Keep what the driver
            # said so an unexplained stall can be diagnosed rather than retried.
            p.kill()
            out, err = await p.communicate()
            raise AssertionError(
                f"driver never reached the checkpoint ({action})\n"
                f"stdout: {out.decode()[-2000:]}\nstderr: {err.decode()[-4000:]}"
            ) from None
        assert p.returncode is None, (await p.communicate())[1].decode()
        p.kill()
        await p.wait()
        q = await driver(home, tmp_path, runtime, variant, reopen)
        out, err = await asyncio.wait_for(q.communicate(), 8)
        assert q.returncode == 0, err.decode()
        return json.loads((tmp_path / "recovered.json").read_text())
    finally:
        for process in (p, q):
            if process is not None and process.returncode is None:
                process.kill()
                await process.wait()
        h = await build(home, Fake())
        await h.stop()


@pytest.mark.parametrize("answered", [False, True])
async def test_sigkill_open_or_recorded_answer(tmp_path, runtime_kind, answered):
    record = await crash_and_reopen(
        tmp_path,
        runtime_kind,
        "transient",
        "question-answered" if answered else "question-open",
        "question-reopen",
    )
    es = record["entries"]
    paired(es)
    repeats = runtime_kind == "durable" and record["confirms_crash_cleanup"]
    opened = [e for e in record["events"] if e["kind"] == "input_request_opened"]
    assert len(opened) == int(repeats and not answered)
    answers = [e for e in es if e["kind"] == "question_answer"]
    assert len(answers) == int(answered or repeats)
    (result,) = [e for e in es if e["kind"] == "tool_result"]
    assert result["data"]["status"] == ("completed" if repeats else "outcome_unknown")
    if answered:
        assert answers[0]["data"]["value"] == "saved-before-crash"
    assert len([e for e in es if e["kind"] == "question_open"]) == 1


@pytest.mark.parametrize("variant", ["transient", "durable"])
async def test_sigkill_subagent_variant_recovers_or_reports_unknown(
    tmp_path, runtime_kind, variant
):
    record = await crash_and_reopen(tmp_path, runtime_kind, variant, "job-open", "job-reopen")
    job = record["jobs"][0]
    assert job["state"] == ("completed" if variant == "durable" else "outcome_unknown")
    if variant == "durable":
        assert "real-child-result" in str(job["result"])
        assert record["child_entries"]
        assert any(
            e["kind"] == "turn_end" and e["data"]["outcome"] == "completed"
            for e in record["child_entries"]
        )
        paired(record["child_entries"])
    else:
        assert "Outcome unknown" in str(job["result"])
        assert all(r["session"] == record["session"] for r in record["requests"])
    es = record["entries"]
    assert len([e for e in es if e["kind"] == "job_start"]) == 1
    assert len([e for e in es if e["kind"] == "job_end"]) == 1
    assert len([e for e in es if e["kind"] == "input" and e.get("job") == job["id"]]) == 1
    paired(es)
