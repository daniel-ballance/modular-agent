"""Exercise ma's ACP composition with the shared served Runtime fixtures."""

import asyncio
import json
import shutil
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import acp
import pytest

from acp_fixture import Client, prompt


@asynccontextmanager
async def running_ma(tmp_path, monkeypatch, program, config):
    node = shutil.which("node")
    if node is None:
        pytest.skip("the shared plugin fixtures require Node.js")
    plugin = Path(__file__).resolve().parents[2] / "conformance" / "plugin" / program
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("MODULAR_AGENT_CONFORMANCE", "1")
    monkeypatch.setenv("MODULAR_AGENT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv(
        "MODULAR_AGENT_PLUGINS", json.dumps([{"command": [node, str(plugin)], "config": config}])
    )
    for key in (
        "MODULAR_AGENT_HISTORY_URL",
        "MODULAR_AGENT_HISTORY_TOKEN_FILE",
        "MODULAR_AGENT_SCRIPT",
    ):
        monkeypatch.delenv(key, raising=False)
    proc = await asyncio.create_subprocess_exec(
        str(Path(sys.executable).with_name("ma")),
        "--acp",
        cwd=tmp_path,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
    )
    conn = acp.connect_to_agent(Client(), proc.stdin, proc.stdout)
    try:
        async with asyncio.timeout(15):
            await conn.initialize(protocol_version=1)
            yield conn, proc
    finally:
        proc.stdin.close()
        await conn.close()
        try:
            await asyncio.wait_for(proc.wait(), 5)
        except TimeoutError:
            proc.kill()
            await proc.wait()
            raise


async def test_default_ma_hosts_transient_runtime_with_kept_history(tmp_path, monkeypatch):
    config = {"role": "runtime", "out": str(tmp_path / "runtime.jsonl")}
    async with running_ma(tmp_path, monkeypatch, "probe.mjs", config) as (conn, _):
        session = await conn.new_session(cwd=str(tmp_path), mcp_servers=[])
        declaration = session.field_meta["modular-agent"]["declaration"]
        assert declaration["continuesAfterRestart"] is False
        assert declaration["portableSessions"] is True


async def test_served_provider_response_survives_additive_callback_member(tmp_path, monkeypatch):
    out = tmp_path / "runtime.jsonl"
    config = {"role": "runtime", "out": str(out)}
    async with running_ma(tmp_path, monkeypatch, "probe.mjs", config) as (conn, _):
        sid = (await conn.new_session(cwd=str(tmp_path), mcp_servers=[])).session_id
        await conn.set_config_option(session_id=sid, config_id="model", value="kit-probe/scripted")
        reply = await prompt(conn, sid, "fixture extra-response-member")
        rows = [json.loads(line) for line in out.read_text().splitlines()]
        accepted = next(row for row in rows if row.get("extraResponseAccepted") == sid)
        assert reply.field_meta["modular-agent"]["outcome"] == {"kind": "completed"}
        history = await conn.ext_method("modular-agent/history", {"sessionId": sid})
        assert [row["message"] for row in history["entries"] if row["kind"] == "response"] == [
            accepted["message"]
        ]


async def test_default_ma_reopens_served_runtime_checkpoint(tmp_path, monkeypatch):
    out = tmp_path / "runtime.jsonl"
    config = {"boundary": "after", "out": str(out)}
    async with running_ma(tmp_path, monkeypatch, "gate-recovery.mjs", config) as (conn, proc):
        session = await conn.new_session(cwd=str(tmp_path), mcp_servers=[])
        sid = session.session_id
        await conn.set_config_option(
            session_id=sid, config_id="model", value="kit-gate-recovery/echo"
        )
        pending = asyncio.create_task(prompt(conn, sid, "fixture gate recovery"))
        try:
            while not (out.exists() and '"latch":"after"' in out.read_text()):
                assert not pending.done(), "the turn ended before reaching the crash boundary"
                await asyncio.sleep(0.02)
            proc.kill()
            await proc.wait()
        finally:
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
    async with running_ma(tmp_path, monkeypatch, "gate-recovery.mjs", config) as (conn, _):
        await conn.load_session(cwd=str(tmp_path), session_id=sid, mcp_servers=[])
        while True:
            history = await conn.ext_method("modular-agent/history", {"sessionId": sid})
            if ends := [row for row in history["entries"] if row["kind"] == "turnEnd"]:
                break
            await asyncio.sleep(0.02)
    rows = [json.loads(line) for line in out.read_text().splitlines()]
    resumed = next(row for row in rows if "resumed" in row)
    step = next(row["stepId"] for row in rows if row.get("latch") == "after")
    assert resumed["interrupted"]["lastStep"] == {"stepId": step, "decision": None}
    assert [row["gate"] for row in rows if "gate" in row] == [step]
    assert len(ends) == 1 and ends[0]["turnId"] == resumed["resumed"]
    assert ends[0]["data"]["outcome"] == {"kind": "completed"}
