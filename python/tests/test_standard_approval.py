"""Operator approval settings and the two terminal answer routes."""

import asyncio
import json
import os
from pathlib import Path
import sys

import pytest


CODE = "tools.write('one', 'first')\ntools.write('two', 'second')"
MA = str(Path(sys.executable).with_name("ma"))


@pytest.fixture
def setup(tmp_path, monkeypatch):
    config, project = tmp_path / "config", tmp_path / "project"
    config.mkdir()
    project.mkdir()
    script = tmp_path / "script"
    script.write_text(
        json.dumps(
            [{"toolCalls": [{"name": "codemode", "input": {"code": CODE}}]}, {"text": "finished"}]
        )
    )
    monkeypatch.setenv("MODULAR_AGENT_DATA_DIR", str(config))
    monkeypatch.setenv("MODULAR_AGENT_SCRIPT", str(script))
    return config, project


async def start(project, *args):
    return await asyncio.create_subprocess_exec(
        MA,
        "--project",
        str(project),
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )


async def run(project, *args):
    proc = await start(project, *args)
    stdout, stderr = await proc.communicate()
    assert proc.returncode == 0, stderr.decode()
    return stdout.decode()


async def test_project_cannot_configure_approval_or_its_wait(setup):
    config, project = setup
    (config / "policy.json").write_text('{"approvalWaitMaxMs":60000}')
    (project / ".modular-agent.json").write_text(
        '{"approval":"never","approval_wait":"untilDeadline","approvalWait":"untilDeadline"}'
    )
    declaration = json.loads(await run(project, "--declaration"))
    assert "approvalCoversNested" not in declaration and "approvalsOutlastTurns" not in declaration
    assert await run(project, "-p", "run") == "finished\n"
    assert (project / "one").read_text() == "first"


@pytest.mark.parametrize("enable_wait", [False, True])
async def test_print_refuses_without_asking_or_parking(setup, enable_wait):
    config, project = setup
    (config / "settings.json").write_text('{"approval":"off","approval_wait":"untilDeadline"}')
    if enable_wait:
        (config / "policy.json").write_text('{"approvalWaitMaxMs":60000}')
    declaration = json.loads(await run(project, "--declaration"))
    assert declaration["approvalCoversNested"] is True
    assert ("approvalsOutlastTurns" in declaration) == enable_wait
    output = await run(project, "--json", "--approval", "ask", "-p", "run")
    entries = [
        e["data"]["entry"]
        for line in output.splitlines()
        if (e := json.loads(line))["type"] == "entry"
    ]
    [result] = [e for e in entries if e["kind"] == "toolResult"]
    assert result["data"]["status"] == "refused"
    assert not any(e["kind"] in ("toolPending", "toolStarted") for e in entries)
    assert not (project / "one").exists() and not (project / "two").exists()


@pytest.mark.parametrize("answer", ["y", "n"])
async def test_terminal_shows_script_then_reads_one_answer(setup, answer):
    config, project = setup
    (config / "settings.json").write_text('{"approval":"ask"}')
    proc = await start(project)
    try:
        proc.stdin.write(b"run\n")
        shown = await proc.stderr.readuntil(b"[y/n]")
        assert (
            b"codemode" in shown and CODE.encode() in shown and b"covers the nested calls" in shown
        )
        stdout, rest = await proc.communicate(os.fsencode(answer + "\n"))
        assert proc.returncode == 0, rest
        assert b"finished" in stdout and b"[y/n]" not in rest
        assert (project / "one").exists() == (answer == "y")
        assert (project / "two").exists() == (answer == "y")
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


@pytest.mark.parametrize("maximum", [0, -1, True, 2**53, 0.5, "60000", None])
async def test_invalid_operator_maximum_names_the_policy(setup, maximum):
    config, project = setup
    path = config / "policy.json"
    path.write_text(json.dumps({"approvalWaitMaxMs": maximum}))
    proc = await start(project, "--declaration")
    _, stderr = await proc.communicate()
    assert proc.returncode == 1 and str(path).encode() in stderr and b"approvalWaitMaxMs" in stderr
