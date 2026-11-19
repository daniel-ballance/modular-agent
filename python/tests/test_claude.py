"""All SDK tests are offline. The CLI and inference are replaced, not our Runtime."""

import asyncio
import json
import os

from ma_durable import Durable
from ma_runtime import Runtime

import pytest
from claude_agent_sdk import AssistantMessage, ResultMessage, StreamEvent, TextBlock, ToolUseBlock

import ma_claude
from ma_claude import Claude, MODEL, PREFIX, Transport, isolated_options
from ma_core import AgentError, content, plain
from ma_tools import DEFINITIONS
from ma_cli import build


def result():
    return ResultMessage(
        "success", 1, 1, False, 1, "native", usage={"input_tokens": 10, "output_tokens": 2}
    )


class SDK:
    def __init__(self, options, scenario="tools"):
        self.options, self.scenario = options, scenario
        self.queue = asyncio.Queue()
        self.tasks = []
        self.queries, self.results = [], []
        self.closed = False
        self.entered = asyncio.Event()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.closed = True

    async def get_server_info(self):
        return (
            {"account": {"subscriptionType": "max"}}
            if self.scenario != "api_login"
            else {"account": {}}
        )

    async def query(self, prompt):
        self.queries.append(prompt)
        self.entered.set()
        if self.scenario == "wait":
            return
        if self.scenario == "tools" and len(self.queries) == 1:
            await self.queue.put(
                AssistantMessage(
                    [ToolUseBlock("native-call", PREFIX + "read", {"path": "facts"})], MODEL
                )
            )

            async def callback():
                # Deliberately delay callback admission until after the Runtime can return
                # the tool's result. The bridge must not lose an unclaimed wait.
                await asyncio.sleep(0.01)
                answer = await self.options.mcp_servers["agent"]["_test_bridge"]._bridge(
                    "read", {"path": "facts"}
                )
                self.results.append(answer)
                await self.queue.put(
                    AssistantMessage([TextBlock("from " + plain(answer["content"]))], MODEL)
                )
                await self.queue.put(result())

            self.tasks.append(asyncio.create_task(callback()))
        else:
            if self.scenario == "usage":
                await self.queue.put(
                    StreamEvent(
                        "u",
                        "native",
                        {
                            "type": "message_delta",
                            "usage": {
                                "output_tokens": 2,
                                "cache_creation": {"ephemeral_5m_input_tokens": 110},
                            },
                        },
                    )
                )
            await self.queue.put(
                StreamEvent(
                    "s",
                    "native",
                    {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "ok"}},
                )
            )
            await self.queue.put(AssistantMessage([TextBlock("ok")], MODEL))
            await self.queue.put(result())

    async def receive_messages(self):
        while True:
            yield await self.queue.get()


@pytest.fixture
def sdk(monkeypatch):
    instances = []
    original = ma_claude.Transport._server

    def server(transport):
        value = original(transport)
        value["_test_bridge"] = transport
        value["_test_tools"] = transport.initial["tools"]
        return value

    monkeypatch.setattr(ma_claude.Transport, "_server", server)

    def factory(scenario="tools"):
        def create(options):
            instance = SDK(options, scenario)
            instances.append(instance)
            return instance

        return create

    return instances, factory


async def setup(tmp_path, sdk, scenario="tools"):
    instances, factory = sdk
    provider = Claude(factory(scenario))
    runtime = Durable() if os.environ["MA_TEST_RUNTIME"] == "durable" else Runtime()
    h = await build(tmp_path / "store", provider, runtime=runtime)
    login = tmp_path / "login"
    login.mkdir()
    (login / ".credentials.json").write_text("{}")
    h.plugins["credentials"].claude_home = login
    s = await h.api().session("create", project=str(tmp_path))
    return h, h.api(), s["id"], provider, instances


async def submit(a, sid, text="go"):
    await a.call("runtime", "submit", {"session": sid, "content": content(text)})
    return await asyncio.wait_for(a.call("runtime", "wait", {"session": sid}), 2)


async def test_sdk_tool_call_ends_request_runtime_executes_then_native_continues(tmp_path, sdk):
    (tmp_path / "facts").write_text("canonical")
    h, a, sid, provider, instances = await setup(tmp_path, sdk)
    try:
        out = await submit(a, sid)
        assert out[-1]["outcome"] == "completed"
        assert plain(out[-1]["content"]) == "from canonical"
        assert len(instances) == 1 and len(instances[0].queries) == 1
        assert plain(instances[0].results[0]["content"]) == "canonical"
        es = (await a.session("get", session=sid))["entries"]
        assert len([e for e in es if e["kind"] == "tool_call"]) == 1
        assert len([e for e in es if e["kind"] == "tool_result"]) == 1
        schemas = instances[0].options.mcp_servers["agent"]["_test_tools"]
        assert {t["name"]: t["schema"] for t in schemas} == {
            t["name"]: t["schema"] for t in await a.call("tools", "definitions", {"session": sid})
        }
    finally:
        await h.stop()
    assert all(i.closed for i in instances)


async def test_sdk_refused_result_is_delivered_not_executed(tmp_path, sdk):
    h, a, sid, provider, instances = await setup(tmp_path, sdk)

    async def deny(d):
        return {**d, "refused": True, "reason": "denied by agent"}

    h.api("policy").on("tool.before", deny)
    try:
        out = await submit(a, sid)
        assert out[-1]["outcome"] == "completed"
        assert instances[0].results[0]["isError"]
        assert plain(instances[0].results[0]["content"]) == "denied by agent"
    finally:
        await h.stop()


def test_isolation_options_no_native_features_or_ambient_api_route(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "not-a-real-key")
    monkeypatch.setenv("CLAUDE_CODE_USE_BEDROCK", "1")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "parent")
    request = {"system": "our exact system", "tools": DEFINITIONS, "settings": {}}
    options = isolated_options(request, "/empty", {}, {"config_dir": "/login"})
    assert options.model == MODEL and options.fallback_model is None
    assert options.tools == [] and options.skills == [] and options.plugins == []
    assert options.setting_sources == [] and options.strict_mcp_config
    assert options.hooks == {} and options.verbatim_prompts
    assert options.extra_args["no-session-persistence"] is None
    assert options.env["ANTHROPIC_API_KEY"] == ""
    assert options.env["CLAUDE_CODE_USE_BEDROCK"] == "0"
    assert options.env["CLAUDE_CODE_SESSION_ID"] == ""
    assert options.system_prompt == "our exact system"
    assert not json.loads(options.settings)["autoMemoryEnabled"]


async def test_stateful_provider_prefix_reuse_and_discard_for_move_compact_model_fork_erase(
    tmp_path, sdk
):
    h, a, sid, provider, instances = await setup(tmp_path, sdk, "text")
    try:
        await submit(a, sid)
        point = (await a.session("get", session=sid))["position"]
        await submit(a, sid, "again")
        assert len(instances) == 1
        assert "again" in instances[0].queries[-1]
        await a.session("move", session=sid, point=point)
        assert instances[0].closed
        await submit(a, sid, "new branch")
        assert len(instances) == 2
        await a.session("command", session=sid, text="/compact")
        assert all(i.closed for i in instances)
        await submit(a, sid)
        await a.session("command", session=sid, text="/thinking high")
        assert instances[-1].closed
        await submit(a, sid)
        child = await a.session("fork", session=sid)
        await submit(a, child["id"], "forked")
        assert child["id"] in provider.transports and sid in provider.transports
        source = next(
            e for e in (await a.session("get", session=sid))["entries"] if e["kind"] == "input"
        )
        await a.session("erase", session=sid, entries=[source["id"]])
        assert not provider.transports and all(i.closed for i in instances)
    finally:
        await h.stop()


async def test_provider_non_subscription_refused_before_query(tmp_path, sdk):
    h, a, sid, provider, instances = await setup(tmp_path, sdk, "api_login")
    try:
        out = await submit(a, sid)
        assert out[-1]["outcome"] == "failed"
        assert "subscription" in out[-1]["error"]
        assert not instances[0].queries
    finally:
        await h.stop()


async def test_provider_cancel_discards_native_state(tmp_path, sdk):
    h, a, sid, provider, instances = await setup(tmp_path, sdk, "wait")
    try:
        await a.call("runtime", "submit", {"session": sid, "content": content("go")})
        for _ in range(100):
            if instances and instances[0].entered.is_set():
                break
            await asyncio.sleep(0.001)
        await a.call("runtime", "cancel", {"session": sid})
        assert instances[0].closed and not provider.transports
    finally:
        await h.stop()


async def test_disallowed_model_never_starts_sdk(tmp_path, sdk):
    h, a, sid, provider, instances = await setup(tmp_path, sdk)
    try:
        with pytest.raises(AgentError, match="Only"):
            await a.call(
                "claude",
                "generate",
                {"session": sid, "access": {"id": "other"}, "system": "", "messages": []},
            )
        assert not instances
    finally:
        await h.stop()


@pytest.mark.parametrize("path", ["facts", 7])
async def test_real_official_mcp_server_preserves_schema_and_waits_for_runtime_result(path):
    """Exercise the actual SDK-created MCP server over the official memory transport."""
    from mcp import ClientSession
    from mcp.shared.memory import create_client_server_memory_streams

    request = {"tools": DEFINITIONS, "messages": []}
    # No worker or CLI: use only Transport's bridge and real SDK server construction.
    bridge = object.__new__(Transport)
    bridge.initial, bridge.pending, bridge.waiting_callbacks = request, [], []
    bridge.ready = asyncio.Event()
    server = bridge._server()["instance"]
    async with create_client_server_memory_streams() as (client_streams, server_streams):
        task = asyncio.create_task(
            server.run(*server_streams, server.create_initialization_options())
        )
        try:
            async with ClientSession(*client_streams) as client:
                await client.initialize()
                listed = await client.list_tools()
                assert {t.name: t.input_schema for t in listed.tools} == {
                    t["name"]: t["schema"] for t in DEFINITIONS
                }
                future = asyncio.get_running_loop().create_future()
                bridge.waiting_callbacks = [
                    {
                        "id": "x",
                        "name": "read",
                        "input": {"path": path},
                        "claimed": False,
                        "future": future,
                    }
                ]
                pending = asyncio.create_task(client.call_tool("read", {"path": path}))
                await asyncio.sleep(0.01)
                assert not pending.done()
                future.set_result({"content": content("from Runtime"), "isError": True})
                answer = await asyncio.wait_for(pending, 1)
                assert answer.content[0].text == "from Runtime"
                assert answer.is_error
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
