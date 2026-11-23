"""Run ma over stdio without live Providers and verify per-project ACP composition."""

import asyncio
import json
import os
from pathlib import Path
import sys

import acp
import pytest

from acp_fixture import Client, prompt


async def test_acp_serves_two_projects_and_reopens_only_in_the_saved_project(tmp_path):
    launch, other = [tmp_path / name for name in ("launch", "other")]
    for project in (launch, other):
        project.mkdir()
        (project / "AGENTS.md").write_text(f"instructions only for {project.name}")
    script = tmp_path / "script.json"
    script.write_text(json.dumps([{"text": "first"}, {"text": "second"}]))
    log = tmp_path / "requests.jsonl"
    env = {
        **os.environ,
        "MODULAR_AGENT_CONFORMANCE": "",
        "MODULAR_AGENT_SCRIPT": str(script),
        "MODULAR_AGENT_SCRIPT_LOG": str(log),
        "MODULAR_AGENT_DATA_DIR": str(tmp_path / "data"),
    }
    proc = await asyncio.create_subprocess_exec(
        str(Path(sys.executable).with_name("ma")),
        "--acp",
        "--project",
        str(launch),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        env=env,
    )
    conn = acp.connect_to_agent(Client(), proc.stdin, proc.stdout)
    try:
        async with asyncio.timeout(15):
            init = await conn.initialize(protocol_version=1)
            assert "projectRoot" not in init.field_meta["modular-agent"]["declaration"]
            first = (await conn.new_session(cwd=str(launch), mcp_servers=[])).session_id
            second = (await conn.new_session(cwd=str(other), mcp_servers=[])).session_id
            for sid in (first, second):
                assert (await prompt(conn, sid, "one")).stop_reason == "end_turn"
            [row] = (await conn.list_sessions(cwd=str(other))).sessions
            assert row.session_id == second
            assert row.field_meta == {
                "modular-agent": {
                    "waiting": {
                        "questions": 0,
                        "toolCalls": 0,
                        "turn": "none",
                    }
                }
            }
            with pytest.raises(acp.RequestError):
                await conn.load_session(cwd=str(other), session_id=first, mcp_servers=[])
            await conn.close_session(session_id=first)
            await conn.load_session(cwd=str(launch), session_id=first, mcp_servers=[])
            assert (await prompt(conn, first, "two")).stop_reason == "end_turn"
    finally:
        proc.stdin.close()
        await proc.stdin.wait_closed()
        await conn.close()
        try:
            await asyncio.wait_for(proc.wait(), 5)
        except TimeoutError:
            proc.kill()
            await proc.wait()
            raise
    assert proc.returncode == 0
    requests = [json.loads(row) for row in log.read_text().splitlines()]
    assert [r["system"].count("instructions only for other") for r in requests] == [0, 1, 0]
    assert [r["system"].count("instructions only for launch") for r in requests] == [1, 0, 1]
