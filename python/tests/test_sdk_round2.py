import asyncio

import pytest
from modular_agent import (
    AgentError,
    Plugin,
    ToolContext,
    create_agent,
    file_history,
    memory_history,
    serve_history,
    tool,
)
from modular_agent.fixtures import fixture
from modular_agent.testing import (
    answers,
    memory_environment,
    over_wire,
    restart,
    test_agent as agent_for_test,
)


@pytest.mark.parametrize("wire", [False, True])
async def test_nested_model_offer_and_lineage(wire):
    placement = over_wire if wire else lambda p: p
    script = [{"toolCalls": [{"name": "pilot", "input": {"harbour": "Whitby"}}]}, {"text": "done"}]
    async with agent_for_test(
        script=script,
        plugins=[placement(fixture("tide")), placement(fixture("pilot"))],
        settings={"modelTools": ["pilot"]},
    ) as agent:
        session = await agent.session()
        result = await session.prompt("pilot")
        assert [t.text() for t in result.tool_results()] == ["Pilot: High tide at Whitby is 14:02."]
        rows = await session.history()
        requests = [e["data"]["tools"] for e in rows if e["kind"] == "modelRequest"]
        assert requests == [["pilot"], ["pilot"]]
        parent, child = [e for e in rows if e["kind"] == "toolStarted"]
        assert child["data"]["call"]["startedBy"] == "tool"
        assert child["data"]["call"]["parentCallId"] == parent["toolCallId"]
        assert (child["turnId"], child["stepId"], child["actorId"]) == (
            parent["turnId"],
            parent["stepId"],
            parent["actorId"],
        )
        child_result = next(
            e for e in rows if e["kind"] == "toolResult" and e["toolCallId"] == child["toolCallId"]
        )
        assert child_result["modelVisible"] is False


@pytest.mark.parametrize("wire", [False, True])
async def test_hooks_apply_full_transform_and_step_refuses(wire):
    hooks = Plugin(
        "change",
        hooks={
            "tool.after": lambda d: {"change": {"content": [{"type": "text", "text": "new"}]}},
            "step.after": lambda d: {"end": "no more"},
        },
    )
    async with agent_for_test(
        script=[{"toolCalls": [{"name": "tide", "input": {"harbour": "Whitby"}}]}],
        plugins=[fixture("tide"), over_wire(hooks) if wire else hooks],
    ) as agent:
        result = await (await agent.session()).prompt("hello")
        assert result.outcome.kind == "failed"
        assert result.outcome.error == "no more"
        assert result.tool_results()[0].text() == "new"


async def test_structured_retry_and_explicit_null():
    async with agent_for_test(script=[{"text": "not JSON"}, {"text": "null"}]) as agent:
        session = await agent.session()
        result = await session.prompt("return null", result={"type": "null"})
        assert result.outcome.kind == "completed"
        assert result.value is None
        rows = await session.history()
        assert rows[-1]["data"]["result"]["value"] is None
        assert any(e["kind"] == "resultFeedback" for e in rows)


async def test_events_resume_strictly_after_last_delivered_entry():
    async with agent_for_test(script=[]) as agent:
        session = await agent.session()
        async with asyncio.timeout(5):
            events = session.events()
            first = (await anext(events)).data.fields["entry"]["id"]
            for n in range(520):
                # Non-kept live pieces do not advance the history cursor.
                await agent._session("event", session=session.id, kind="model_output", text=str(n))
            delivered = first
            with pytest.raises(AgentError) as error:
                async for event in events:
                    if event.type == "entry":
                        delivered = event.data.fields["entry"]["id"]
            assert error.value.code == "lost"
            assert error.value.data == {"fromEntry": delivered}
            await session.set_setting("modelTools", [])
            rows = await session.history()
            resumed = session.events(delivered)
            row_ids = [row["id"] for row in rows]
            assert (await anext(resumed)).data.fields["entry"]["id"] == row_ids[
                row_ids.index(delivered) + 1
            ]
            await resumed.aclose()


async def test_simulated_restart_settles_nested_child_and_never_repeats(tmp_path):
    running = asyncio.Event()
    starts = []
    stops = []

    @tool
    async def parent(cx: ToolContext) -> str:
        """Start one child."""
        assert any(d["name"] == "child" for d in await cx.tools.list())
        return (await cx.tools.call("child", {})).text()

    @tool
    async def child() -> str:
        """Hold until interrupted."""
        starts.append(True)
        running.set()
        await asyncio.Future()
        return "unreachable"

    plugin = Plugin("hold", tools=[parent, child], stop=lambda: stops.append(True))
    script = [{"toolCalls": [{"name": "parent", "input": {}}]}, {"text": "recovered"}]
    agent = await agent_for_test(
        script=script, durability="durable", data_dir=tmp_path, plugins=[plugin]
    )
    session = await agent.session()
    await session.send("start", "now")
    async with asyncio.timeout(5):
        await running.wait()
        async with await restart(agent) as rebuilt:
            assert stops == []
            recovered = await rebuilt.open_session(session.id)
            rows = await recovered.history()
            results = [r for r in rows if r["kind"] == "toolResult"]
            assert [r["data"]["status"] for r in results] == ["outcomeUnknown", "outcomeUnknown"]
            assert len(starts) == 1


async def test_answer_queue_records_extra_questions():
    handler = answers([])
    async with agent_for_test(
        script=[
            {"toolCalls": [{"name": "confirm", "input": {"question": "Continue?"}}]},
            {"text": "done"},
        ],
        plugins=[fixture("confirm")],
        on_question=handler,
    ) as agent:
        result = await (await agent.session()).prompt("ask")
        assert result.tool_results()[0].text() == "declined"
        with pytest.raises(AssertionError, match="Continue"):
            handler.assert_done()


async def test_declaration_from_selected_parts_and_history_eligibility(tmp_path):
    async with create_agent(
        durability="kept", history=file_history(tmp_path), environment=memory_environment()
    ) as agent:
        declaration = agent.declaration()
        assert declaration["erasure"] is True
        assert declaration["confinesFiles"] is True
        assert declaration["commandContainment"] == "none"
        assert "queuedJobReportsAfterRestart" not in declaration
    for store in (None, memory_history(), file_history(tmp_path)):
        with pytest.raises(
            AgentError, match="(recovery needs|persistent store|History does not match)"
        ) as error:
            await create_agent(durability="kept", history=store)
        assert error.value.code == "invalid_composition"
    with pytest.raises(AgentError) as error:
        serve_history(memory_history(), address=("127.0.0.1", 0), token_file=tmp_path / "unused")
    assert error.value.code == "not_supported"
