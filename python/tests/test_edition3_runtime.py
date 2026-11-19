"""Runtime wire regressions independent of another build's binary."""

import pytest
from ma_core import content
from ma_core.recovery import STEP_AFTER
from ma_plugin.rpc import WireError
from ma_plugin.runtime_server import PublicTurn

ABSENT = object()


class Port:
    def __init__(self, entries=()):
        self.entries = entries
        self.calls = []

    async def request(self, method, params):
        self.calls.append((method, params))
        if method == "host/history":
            return {"entries": self.entries}
        if method == "host/runtime/definition":
            return {}
        if method == "host/runtime/record":
            return {"id": "result"}
        if method == "host/runtime/takeSteering":
            return {"entries": []}
        if method == "host/runtime/hook":
            if params["hook"] == "tool.before":
                return {
                    "value": params["payload"],
                    "refused": "denied",
                    "result": {
                        "callId": "call",
                        "status": "refused",
                        "content": content("committed, transformed refusal"),
                        "value": {"rated": True},
                    },
                }
            return {"value": params["payload"]}
        raise AssertionError(method)


def turn(peer):
    return PublicTurn(peer, 1, {"sessionId": "session", "turnId": "turn"})


async def test_runtime_acknowledges_transformed_refusal_without_dispatch():
    port = Port()
    runtime = turn(port)
    await runtime.tools(runtime.admit([{"id": "call", "name": "read", "input": {"path": "a"}}]))
    record = port.calls[-1][1]["entry"]
    assert record["kind"] == "toolResult"
    assert record["data"] == {"status": "refused", "value": {"rated": True}}
    assert record["message"]["content"] == content("committed, transformed refusal")
    assert not any(name == "host/runtime/runToolCall" for name, _ in port.calls)


@pytest.mark.parametrize("decision", [ABSENT, None, {"refuse": "committed refusal"}])
async def test_runtime_restores_gate_without_replaying_a_committed_decision(decision):
    scope = {"turnId": "turn", "stepId": "step"}
    rows = [
        {**scope, "kind": "modelRequest", "data": {"tracksStepAfter": True}},
        {
            **scope,
            "kind": "response",
            "message": {"role": "assistant", "stop": "finished", "content": content("ok")},
        },
    ]
    last = {"stepId": "step"}
    if decision is not ABSENT:
        last["decision"] = decision
        rows.append(
            {**scope, "kind": STEP_AFTER, "modelVisible": False, "data": {"decision": decision}}
        )
    port = Port(rows)
    result = await turn(port).run(
        "resumeTurn", {"interrupted": {"turnId": "turn", "lastStep": last, "calls": []}}, True
    )
    expected = (
        {"kind": "failed", "error": decision["refuse"]}
        if isinstance(decision, dict)
        else {"kind": "completed"}
    )
    assert result["outcome"] == expected
    assert sum(p.get("hook") == "step.after" for _, p in port.calls) == (decision is ABSENT)


@pytest.mark.parametrize(
    "last", [ABSENT, {"stepId": "wrong"}, {"stepId": "step", "decision": None}]
)
async def test_runtime_rejects_mismatched_last_step_before_effects(last):
    port = Port(
        [
            {
                "turnId": "turn",
                "stepId": "step",
                "kind": "modelRequest",
                "data": {"tracksStepAfter": True},
            },
            {
                "turnId": "turn",
                "stepId": "step",
                "kind": "response",
                "message": {"role": "assistant", "stop": "finished", "content": []},
            },
        ]
    )
    interrupted = {"turnId": "turn", "calls": []}
    if last is not ABSENT:
        interrupted["lastStep"] = last
    with pytest.raises(WireError) as exc:
        await turn(port).run("resumeTurn", {"interrupted": interrupted}, True)
    assert exc.value.code == "invalid_request"
    assert [name for name, _ in port.calls] == ["host/history"]
