"""A custom Runtime drives the host's checked turn callbacks in either placement."""

import asyncio

import pytest

from modular_agent import (
    AgentError,
    ErrorCode,
    JsonObject,
    Plugin,
    RuntimeContext,
    RuntimeDeclaration,
    create_agent,
)
from modular_agent.testing import memory_environment, over_wire, scripted_provider


class OneStep:
    def __init__(self):
        self.used = None

    def declaration(self) -> RuntimeDeclaration:
        return {
            "id": "one",
            "supports": {
                "inputDuringTurn": True,
                "waitingThroughRestart": False,
                "continuesAfterRestart": False,
            },
        }

    async def run_turn(self, turn: JsonObject, context: RuntimeContext) -> JsonObject:
        self.used = context
        assert context.turn_id == turn["turnId"]
        assert any(e["kind"] == "turnStart" for e in (await context.history())["entries"])
        await context.hook("turn.start", {})
        step = await context.new_id()
        request = await context.prepare_step(step, {})
        pieces = []

        async def receive(piece):
            # A child task's callback reply must not wait behind modelEvent.
            page = await asyncio.create_task(context.history())
            assert any(e["kind"] == "turnStart" for e in page["entries"])
            pieces.append(piece)

        response = await context.model(request, step, on_piece=receive)
        assert pieces == [{"type": "text", "delta": "from model"}]
        await context.report("model.verified", {"text": pieces[0]["delta"]}, step_id=step)
        saved = await context.record(
            {
                "kind": "response",
                "stepId": step,
                "writer": "one",
                "modelVisible": True,
                "message": response,
            }
        )
        await context.hook("step.after", {"stepId": step, "response": response})
        result = {"text": "from model", "openToolCalls": []}
        await context.hook("turn.result", {"result": {"text": "from model"}})
        assert await context.take_steering(final=True) == {"entries": []}
        outcome = {"kind": "completed"}
        reply = {"outcome": outcome, "result": result, "usage": {}, "entries": [saved["id"]]}
        await context.hook("turn.end", reply)
        return reply

    async def resume_turn(self, turn, interrupted, context):
        return {
            "outcome": {"kind": "failed", "error": "interrupted"},
            "result": {"text": "", "openToolCalls": []},
            "entries": [],
            "usage": {},
        }

    async def continue_open_calls(self, turn, calls, context):
        raise AssertionError("No calls were opened")


@pytest.mark.parametrize("served", [False, True])
async def test_custom_runtime_runs_one_step(served):
    port = OneStep()
    seen = asyncio.Event()

    def output(payload):
        for event in payload["events"]:
            if event["type"] == "python.runtime_report":
                assert event["data"]["type"] == "model.verified"
                assert event["data"]["data"] == {"text": "from model"}
                seen.set()

    def setup(r):
        r.runtime(port)
        r.provider(scripted_provider([{"text": "from model"}]))
        r.on("output", output)

    plugin = Plugin("one-step", replaces=["runtime"], setup=setup)
    async with create_agent(
        environment=memory_environment(),
        plugins=[over_wire(plugin) if served else plugin],
    ) as agent:
        session = await agent.session()
        async with asyncio.timeout(5):
            result = await session.prompt("hello")
            await seen.wait()
        assert result.outcome.kind == "completed", result.outcome
        assert result.text == "from model"
        assert port.used is not None
        with pytest.raises(AgentError) as stale:
            await port.used.new_id()
        assert stale.value.code is ErrorCode.INVALID_REQUEST
