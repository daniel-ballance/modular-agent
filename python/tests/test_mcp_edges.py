import asyncio
import os

import pytest
from mcp import types

from ma_core import AgentError
from ma_mcp import MCP, Connection, tool_name


async def test_mcp_pagination_and_duplicate_cursor():
    connection = Connection.__new__(Connection)
    pages = [
        types.ListToolsResult(tools=[types.Tool(name="a", input_schema={})], next_cursor="next"),
        types.ListToolsResult(tools=[types.Tool(name="b", input_schema={})]),
    ]
    seen = []

    class Session:
        async def list_tools(self, *, params):
            seen.append(params.cursor if params else None)
            return pages.pop(0)

    connection.session = Session()
    connection.task = asyncio.create_task(asyncio.Event().wait())
    try:
        assert [t.name for t in await connection.tools()] == ["a", "b"]
        assert seen == [None, "next"]
        pages[:] = [types.ListToolsResult(tools=[], next_cursor="same")] * 2
        with pytest.raises(AgentError, match="repeated a cursor"):
            await connection.tools()
    finally:
        connection.task.cancel()
        await asyncio.gather(connection.task, return_exceptions=True)


async def test_live_tool_changes_and_annotation_defaults(agent):
    h, api, sid, provider = await agent()
    from test_mcp import stdio, call

    await h.plugins["mcp"].attach({"session": sid, "mcp_servers": [stdio("memory")]})
    before = await api.call("tools", "definitions", {"session": sid})
    fail = next(t for t in before if t["name"] == tool_name("memory", "fail"))
    assert fail["hints"] == {
        "read_only": False,
        "safe_to_repeat": False,
        "destructive": True,
        "external": True,
    }
    assert (await call(api, sid, "memory", "add_tool", {}))["status"] == "completed"
    after = await api.call("tools", "definitions", {"session": sid})
    assert tool_name("memory", "appeared") not in {t["name"] for t in before}
    assert tool_name("memory", "appeared") in {t["name"] for t in after}


@pytest.mark.parametrize(
    "specs",
    [
        [{"name": "x", "type": "sse", "url": "http://localhost"}],
        [{"name": "x", "command": "x"}, {"name": "x", "command": "y"}],
        [{"name": "x", "type": "http", "url": "file:///x"}],
    ],
)
async def test_invalid_mcp_config_refuses_before_starting(specs):
    with pytest.raises(AgentError):
        MCP(specs)


async def test_server_dies_mid_call_reports_unknown_not_failed(agent, tmp_path):
    from test_mcp import stdio

    h, api, sid, _ = await agent()
    await h.plugins["mcp"].attach({"session": sid, "mcp_servers": [stdio()]})
    result = await api.call(
        "runtime",
        "run_tool",
        {"session": sid, "name": tool_name("local", "echo"), "input": {"text": "pid"}},
    )
    pid = result["value"]["pid"]
    marker = tmp_path / "started"
    pending = asyncio.create_task(
        api.call(
            "runtime",
            "run_tool",
            {"session": sid, "name": tool_name("local", "wait"), "input": {"marker": str(marker)}},
        )
    )
    async with asyncio.timeout(5):
        while not marker.exists():
            await asyncio.sleep(0.005)
    os.kill(pid, 9)
    async with asyncio.timeout(5):
        result = await pending
    assert result["status"] == "unknown"
    assert "Call did not finish" in str(result["content"])
    entries = (await api.session("get", session=sid))["entries"]
    assert (
        len([e for e in entries if e["kind"] == "tool_result" and e["call"] == result["call"]]) == 1
    )


async def test_session_attachment_failure_releases_session(agent, tmp_path):
    h, api, sid, _ = await agent()
    with pytest.raises(AgentError):
        await api.session(
            "create",
            project=str(tmp_path),
            mcp_servers=[{"name": "bad", "command": "/does-not-exist"}],
        )
    assert list(h.sessions) == [sid]


async def test_mcp_tools_use_approval_gate(agent, tmp_path):
    from test_mcp import stdio

    h, api, sid, _ = await agent(settings={"approval": "never ask, refuse"})
    await h.plugins["mcp"].attach({"session": sid, "mcp_servers": [stdio()]})
    result = await api.call(
        "runtime",
        "run_tool",
        {"session": sid, "name": tool_name("local", "echo"), "input": {"text": "blocked"}},
    )
    assert result["status"] == "refused"
    es = (await api.session("get", session=sid))["entries"]
    assert len([e for e in es if e["kind"] == "tool_result"]) == 1
