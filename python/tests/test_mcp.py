import asyncio
import json
import os
import sys
from pathlib import Path

from functools import partial

import pytest

from ma_config import Config
from ma_core import AgentError, content
from ma_fake import Fake
from ma_mcp import MCP, tool_name
from ma_cli import build
from mcp_fixture import OfflineHTTP


FIXTURE = Path(__file__).with_name("mcp_fixture.py")


def stdio(name="local"):
    return {"name": name, "command": sys.executable, "args": [str(FIXTURE)], "env": []}


async def tools(api, sid):
    return await api.call("tools", "definitions", {"session": sid})


async def call(api, sid, server, name, value):
    return await api.call(
        "runtime",
        "run_tool",
        {
            "session": sid,
            "name": tool_name(server, name),
            "input": value,
        },
    )


async def test_stdio_global_and_session_scope_close(tmp_path, runtime_type):
    h = await build(tmp_path / "store", Fake(), runtime=runtime_type())
    await h.load(MCP([stdio("global")]), replaces="mcp")
    api = h.api()
    pids = []
    try:
        a = await api.session(
            "create", project=str(tmp_path), settings={"model": "fake"}, mcp_servers=[stdio()]
        )
        b = await api.session("create", project=str(tmp_path), settings={"model": "fake"})
        sid, other = a["id"], b["id"]
        defs = await tools(api, sid)
        echo = next(t for t in defs if t["name"] == tool_name("local", "echo"))
        assert echo["schema"]["required"] == ["text"]
        assert echo["hints"] == {
            "read_only": True,
            "safe_to_repeat": True,
            "destructive": False,
            "external": False,
        }
        assert tool_name("local", "echo") not in {t["name"] for t in await tools(api, other)}
        result = await call(api, sid, "local", "echo", {"text": "stdio proof"})
        assert result["status"] == "completed"
        assert result["value"]["echo"] == "stdio proof"
        assert result["value"]["cwd"] == str(tmp_path)
        local_pid = result["value"]["pid"]
        global_result = await call(api, other, "global", "echo", {"text": "every session"})
        global_pid = global_result["value"]["pid"]
        pids = [local_pid, global_pid]
        await api.session("close", session=sid)
        with pytest.raises(ProcessLookupError):
            os.kill(local_pid, 0)
        os.kill(global_pid, 0)
        assert (await call(api, other, "global", "echo", {"text": "still alive"}))[
            "status"
        ] == "completed"
    finally:
        await h.stop()
    for pid in pids:
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)


@pytest.mark.parametrize("json_response", [True, False])
async def test_streamable_http_offline_official_server(tmp_path, runtime_type, json_response):
    log = tmp_path / "http-requests.jsonl"
    h = await build(tmp_path / "store", Fake(), runtime=runtime_type())
    try:
        await h.load(
            MCP(
                [
                    {
                        "type": "http",
                        "name": "http",
                        "url": "http://127.0.0.1:8765/mcp",
                        "headers": [{"name": "X-Proof", "value": "offline"}],
                    }
                ],
                partial(OfflineHTTP, json_response=json_response, log=log),
            ),
            replaces="mcp",
        )
        s = await h.api().session("create", project=str(tmp_path), settings={"model": "fake"})
        result = await call(h.api(), s["id"], "http", "echo", {"text": "http proof"})
        assert result["status"] == "completed"
        assert result["value"]["echo"] == "http proof"
        failure = await call(h.api(), s["id"], "http", "fail", {})
        assert failure["status"] == "failed"
        assert "Error executing tool fail" in str(failure["content"])
    finally:
        await h.stop()
    requests = [json.loads(line) for line in log.read_text().splitlines()]
    assert requests and all(r["headers"]["x-proof"] == "offline" for r in requests)
    assert any("mcp-protocol-version" in r["headers"] for r in requests)
    assert any(r["method"] == "POST" for r in requests)


async def test_mcp_cancellation_stops_remote_handler(tmp_path, runtime_type):
    h = await build(tmp_path / "store", Fake(), runtime=runtime_type())
    api = h.api()
    marker = tmp_path / "marker"
    try:
        s = await api.session(
            "create", project=str(tmp_path), settings={"model": "fake"}, mcp_servers=[stdio()]
        )
        task = asyncio.create_task(call(api, s["id"], "local", "wait", {"marker": str(marker)}))
        async with asyncio.timeout(5):
            while not marker.exists():
                await asyncio.sleep(0.005)
        await api.call("runtime", "cancel", {"session": s["id"]})
        result = await task
        assert result["status"] == "cancelled"
        async with asyncio.timeout(5):
            while marker.read_text() != "cancelled":
                await asyncio.sleep(0.005)
    finally:
        await h.stop()


async def test_untrusted_project_mcp_does_not_start(tmp_path, runtime_type):
    project, root = tmp_path / "project", tmp_path / "store"
    (project / ".modular-agent").mkdir(parents=True)
    spec = stdio()
    spec["command"] = "/must-not-execute"
    (project / ".modular-agent/settings.json").write_text(
        json.dumps({"model": "fake", "plugin_settings": {"mcp": {"servers": [spec]}}})
    )
    h = await build(root, Fake(), runtime=runtime_type(), project=project)
    await h.stop()
    Config(root).set_trust(project)
    with pytest.raises(AgentError, match="could not connect"):
        await build(root, Fake(), runtime=runtime_type(), project=project)


async def test_server_death_fails_call_and_turn_continues(tmp_path, runtime_type):
    provider = Fake(
        [
            {
                "calls": [
                    {"id": "mcp-call", "name": tool_name("local", "echo"), "input": {"text": "ok"}}
                ]
            },
            {"text": "continued"},
        ]
    )
    h = await build(tmp_path / "store", provider, runtime=runtime_type())
    try:
        api = h.api()
        s = await api.session(
            "create", project=str(tmp_path), settings={"model": "fake"}, mcp_servers=[stdio()]
        )
        result = await call(api, s["id"], "local", "echo", {"text": "pid"})
        pid = result["value"]["pid"]
        os.kill(pid, 9)
        await api.call(
            "runtime",
            "submit",
            {"session": s["id"], "content": content("continue despite disconnected tool")},
        )
        results = await api.call("runtime", "wait", {"session": s["id"]})
        assert results[-1]["outcome"] == "completed"
        entries = (await api.session("get", session=s["id"]))["entries"]
        assert any(
            e["kind"] == "tool_result"
            and e["call"] == "mcp-call"
            and e["data"]["status"] == "refused"
            and e["content"] == content("not offered")
            for e in entries
        )
    finally:
        await h.stop()
