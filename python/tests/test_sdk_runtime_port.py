"""A custom Runtime drives the host's checked turn callbacks in either placement."""

import pytest

from modular_agent import (
    AgentError,
    ErrorCode,
    JsonObject,
    Plugin,
    RuntimeContext,
    RuntimeDeclaration,
)
from modular_agent.testing import over_wire, test_agent as agent_fixture


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
            pieces.append(piece)

        response = await context.model(request, step, on_piece=receive)
        assert pieces == [{"type": "text", "delta": "from model"}]
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
    plugin = Plugin("one-step", replaces=["runtime"], setup=lambda r: r.runtime(port))
    async with agent_fixture(
        script=[{"text": "from model"}], plugins=[over_wire(plugin) if served else plugin]
    ) as agent:
        session = await agent.session()
        result = await session.prompt("hello")
        assert result.outcome.kind == "completed", result.outcome
        assert result.text == "from model"
        assert port.used is not None
        with pytest.raises(AgentError) as stale:
            await port.used.new_id()
        assert stale.value.code is ErrorCode.INVALID_REQUEST
