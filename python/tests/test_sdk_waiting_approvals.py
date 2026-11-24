"""A waiting approval is consent for one unstarted call, not a new prompt."""

import sys
from pathlib import Path

import pytest

from modular_agent import AgentError, tool
from modular_agent.testing import test_agent as make_agent


SCRIPT = [{"toolCalls": [{"name": "bump", "input": {"amount": 1}}]}, {"text": "done"}]


def options(path, process=False, durability="kept", **overrides):
    @tool
    async def bump(amount: int) -> str:
        """Count an effect."""
        with (path / "effects").open("a") as f:
            f.write(f"{amount}\n")
        return "counted"

    return {
        "script": SCRIPT,
        "project": path,
        "data_dir": path / "store",
        "durability": durability,
        "approval": "all",
        "late_answers_start_turns": True,
        "max_approval_wait_ms": 30_000,
        "tools": [bump],
        "process_plugins": [
            {
                "command": [str(Path(sys.executable).with_name("modular-agent-plugin"))],
                "env": {
                    "MODULAR_AGENT_PLUGIN_PARTS": "durable-runtime"
                    if durability == "durable"
                    else "runtime"
                },
            }
        ]
        if process
        else [],
        **overrides,
    }


@pytest.mark.parametrize("process", [False, True])
async def test_allow_on_exact_handle_after_turn(tmp_path, process):
    async with make_agent(**options(tmp_path, process)) as agent:
        assert agent.declaration()["approvalsOutlastTurns"]
        session = await agent.session(settings={"approvalWait": "untilDeadline"})
        result = await session.prompt("bump")
        [cid] = result.open_tool_calls
        assert result.outcome.kind == "completed" and not result.tool_results()
        await session.wait_idle()
        rows = await session.history()
        request, pending, end = [
            r for r in rows if r["kind"] in ("inputRequest", "toolPending", "turnEnd")
        ]
        assert not request["data"]["request"]["answerable"]
        assert pending["parentId"] == request["id"]
        assert not any(r["kind"] == "toolStarted" for r in rows)
        assert not (tmp_path / "effects").exists()
        [listed] = await session.questions()
        with pytest.raises(AgentError):
            await session.answer(listed.id, "allow")
        [q] = await session.questions(present=True)
        assert q.call == {"name": "bump", "input": {"amount": 1}}
        assert q.tool_call_id == cid and q.approval_wait == "untilDeadline"
        assert q.deadline == request["data"]["request"]["deadlineAt"]
        with pytest.raises(AgentError):
            await session.as_actor("user").answer(q.id, "allow")
        await session.answer(q.id, "allow")
        await session.wait_idle()
        rows = await session.history()
        [started] = [r for r in rows if r["kind"] == "toolStarted"]
        [answer] = [r for r in rows if r["kind"] == "inputAnswer"]
        assert "approvalView" not in answer["data"]
        assert {request["id"], answer["id"]} <= set(started["sources"])
        assert (started["toolCallId"], started["stepId"]) == (cid, pending["stepId"])
        origin, continuation = [r for r in rows if r["kind"] == "turnStart"]
        assert continuation["continuesTurnId"] == origin["turnId"] == end["turnId"]
        assert started["turnId"] == continuation["turnId"]
        assert continuation["data"]["startedBy"] == {"kind": "answer", "id": q.id}
        assert sum(r["kind"] in ("input", "inputAccepted") for r in rows) == 2
        assert (tmp_path / "effects").read_text() == "1\n"
        with pytest.raises(AgentError):
            await session.answer(q.id, "allow")
