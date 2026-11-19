import asyncio
import json
import sys
from pathlib import Path

import acp
import pytest
from sdk_plugin_program import plugin

from modular_agent import (
    AgentError,
    Answer,
    ErrorCode,
    Plugin,
    ProcessPlugin,
    ToolContext,
    ToolOutput,
    create_agent,
    tool,
)
from modular_agent.fixtures import fixture
from modular_agent.testing import scripted_provider, test_agent as scripted_agent


@pytest.mark.parametrize("command", [["/no/such/program"], [sys.executable, "-c", "pass"]])
async def test_bad_process(command):
    with pytest.raises(AgentError) as err:
        await create_agent(process_plugins=[ProcessPlugin(command)])
    assert err.value.code == ErrorCode.INVALID_COMPOSITION


async def test_plugin_host_is_opt_in(monkeypatch):
    monkeypatch.setenv("MODULAR_AGENT_PLUGINS", json.dumps([{"command": ["/no/such/program"]}]))
    async with create_agent() as agent:
        assert await agent.models() == []
    with pytest.raises(AgentError) as err:
        await create_agent(plugin_host=True)
    assert err.value.code == ErrorCode.INVALID_COMPOSITION


async def test_missing_data_dir():
    for durability in ("kept", "durable"):
        with pytest.raises(AgentError) as err:
            await create_agent(durability=durability)
        assert err.value.code == "invalid_composition"


async def test_hooks_commands_and_refusal_match_served():
    script = [
        {"toolCalls": [{"name": "refused", "input": {"why": "not today"}}]},
        {"text": "Done."},
    ]
    all_results = []
    for options in (
        {"plugins": [plugin()]},
        {
            "process_plugins": [
                ProcessPlugin(
                    [sys.executable, str(Path(__file__).with_name("sdk_plugin_program.py"))]
                )
            ]
        },
    ):
        async with scripted_agent(script=script, **options) as agent:
            session = await agent.session()
            assert await session.run_command("/echo payload") == "user: payload"
            turn = await session.prompt("Try it")
            [result] = turn.tool_results()
            assert result.status == "refused"
            assert result.text() == "after"
            records = await session.history()
            started = next(e for e in records if e["kind"] == "turnStart")
            assert started["data"]["system"] == "From the hook"
            all_results.append((result.status, result.text()))
    assert all_results[0] == all_results[1]


async def test_raw_refusal_wording(tmp_path):
    program = Path(__file__).with_name("sdk_plugin_program.py")
    plain = tmp_path / "refusal.py"
    plain.write_text(
        program.read_text().replace("serve(plugin())", 'serve(Plugin("refusal", tools=[refused]))')
    )
    from sdk_plugin_program import refused

    script = [
        {"toolCalls": [{"name": "refused", "input": {"why": "not today"}}]},
        {"text": "Done."},
    ]
    for options in (
        {"tools": [refused]},
        {"process_plugins": [ProcessPlugin([sys.executable, str(plain)])]},
    ):
        async with scripted_agent(script=script, **options) as agent:
            [result] = (await (await agent.session()).prompt("Try it")).tool_results()
            assert result.status == "refused"
            assert result.text() == "not today"


async def test_item_replacement():
    original = fixture("tide")

    @tool(name="tide")
    async def later(harbour: str) -> str:
        """An alternative tide measurement."""
        return f"15:00 at {harbour}"

    script = [{"toolCalls": [{"name": "tide", "input": {"harbour": "Whitby"}}]}, {"text": "Done."}]
    async with scripted_agent(
        script=script, plugins=[original, Plugin("other", tools=[later], replaces=["tool:tide"])]
    ) as agent:
        [result] = (await (await agent.session()).prompt("Check tide")).tool_results()
        assert result.text() == "15:00 at Whitby"
    with pytest.raises(AgentError) as err:
        await scripted_agent(script=script, plugins=[original, Plugin("other", tools=[later])])
    assert err.value.code == "invalid_composition"


async def test_settings_fork_and_keyed_retry():
    async with scripted_agent(script=[{"text": "One"}, {"text": "Two"}]) as agent:
        session = await agent.session()
        await session.set_setting("maxSteps", 3)
        first = await session.prompt("One", key="first")
        repeat = await session.prompt("Does not matter", key="first")
        assert first == repeat
        await (await agent.session()).close()
        child = await session.fork()
        assert child.id != session.id
        assert (await child.settings())["maxSteps"] == 3
        assert (await child.prompt("Two")).text == "Two"
        assert (await session.last_turn()).text == "One"
        await session.close()
        with pytest.raises(AgentError) as err:
            await session.prompt("Closed")
        assert err.value.code == "not_open"


async def test_cancel_and_queued_prompt():
    started = asyncio.Event()

    @tool
    async def hold(cx: ToolContext) -> str:
        """Wait for cancellation."""
        started.set()
        await cx.cancelled.wait()
        return "not returned"

    script = [{"toolCalls": [{"name": "hold", "input": {}}]}, {"text": "Two"}]
    async with scripted_agent(script=script, tools=[hold]) as agent:
        session = await agent.session()
        one = asyncio.create_task(session.prompt("One"))
        async with asyncio.timeout(5):
            await started.wait()
            receipt = await session.send("Two", "now")
            assert receipt.timing == "after"
            returns = await session.cancel()
            result = await one
        assert [r.input_id for r in returns] == [receipt.input_id]
        assert result.outcome.kind == "cancelled"
        assert result.tool_results()[0].status == "cancelled"


async def test_question_decline_is_not_an_error():
    @tool
    async def ask(cx: ToolContext) -> str:
        """Ask the user a question."""
        answer = await cx.ask({"kind": "text", "question": "Why?"})
        return answer.reason or answer.kind

    async with scripted_agent(
        script=[{"toolCalls": [{"name": "ask", "input": {}}]}, {"text": "Done"}],
        tools=[ask],
        on_question=lambda q, ctx: Answer("decline", reason="not now"),
    ) as agent:
        [result] = (await (await agent.session()).prompt("Ask")).tool_results()
        assert result.status == "completed"
        assert result.text() == "not now"


async def test_typed_output_and_defaults():
    @tool(output=dict[str, int], read_only=True)
    async def structured(count: int) -> ToolOutput:
        """Return the count.

        Args:
            count: The count to return.
        """
        return ToolOutput(value={"n": count})

    assert structured.parameters["properties"]["count"]["description"] == "The count to return."
    assert structured.definition["hints"] == {
        "readOnly": True,
        "destructive": True,
        "openWorld": True,
        "safeToRepeat": False,
    }
    async with scripted_agent(
        script=[{"toolCalls": [{"name": "structured", "input": {"count": 2}}]}, {"text": "Done"}],
        tools=[structured],
    ) as agent:
        [result] = (await (await agent.session()).prompt("Count")).tool_results()
        assert result.value == {"n": 2}
        assert json.loads(result.text()) == {"n": 2}


async def test_acp_prompt(tmp_path):
    from acp_fixture import Client, prompt

    code = """
import sys
from modular_agent import create_agent, run
from modular_agent.testing import scripted_provider
async def main():
    async with create_agent(project=sys.argv[1], providers=[scripted_provider([{"text":"Hello ACP"}])], plugin_host=True) as agent:
        await agent.serve_acp()
run(main())
"""
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        code,
        str(tmp_path),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
    )
    client = Client()
    conn = acp.connect_to_agent(client, proc.stdin, proc.stdout)
    try:
        async with asyncio.timeout(10):
            await conn.initialize(protocol_version=1)
            session = await conn.new_session(cwd=str(tmp_path), mcp_servers=[])
            response = await prompt(conn, session.session_id, "Hello")
            assert response.stop_reason == "end_turn"
            assert any(
                getattr(getattr(u, "content", None), "text", None) == "Hello ACP"
                for _, u in client.updates
            )
    finally:
        proc.stdin.close()
        await proc.stdin.wait_closed()
        await conn.close()
        try:
            async with asyncio.timeout(5):
                await proc.wait()
        except TimeoutError:
            proc.kill()
            await proc.wait()
            raise
    assert proc.returncode == 0


async def test_no_model_is_a_failed_turn():
    async with create_agent() as agent:
        result = await (await agent.session()).prompt("Hello")
        assert result.outcome.kind == "failed"
        assert "No model selected" in str(result.outcome.error)


async def test_declaration(tmp_path):
    for durability in ("ephemeral", "kept", "durable"):
        async with create_agent(
            durability=durability, data_dir=tmp_path, providers=[scripted_provider([])]
        ) as agent:
            result = agent.declaration()
            assert result["continuesAfterRestart"] == (durability == "durable")
            assert result["portableSessions"] == (durability != "ephemeral")
            assert result["waitingThroughRestart"] is False
            assert result["nestedToolCalls"] is False
