"""A waiting approval is consent for one unstarted call, not a new prompt."""

import asyncio
import json
import os
import signal
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

from modular_agent import AgentError, Plugin, tool
from modular_agent.testing import test_agent as make_agent


SCRIPT = [{"toolCalls": [{"name": "bump", "input": {"amount": 1}}]}, {"text": "done"}]


def options(
    path, process=False, durability="kept", *, after_effect=None, readonly=False, **overrides
):
    @tool(read_only=readonly)
    async def bump(amount: int) -> str:
        """Count an effect."""
        with (path / "effects").open("a") as f:
            f.write(f"{amount}\n")
        if after_effect:
            await after_effect()
        return "counted"

    return {
        "script": SCRIPT,
        "project": path,
        "data_dir": path / "store",
        "durability": durability,
        "approval": "all",
        "late_answers_start_turns": True,
        "max_approval_wait": 30.0,
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
        assert datetime.fromisoformat(q.deadline) == datetime.fromtimestamp(
            request["data"]["request"]["deadlineAt"] / 1000, UTC
        )
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


@pytest.mark.parametrize("seconds,ms", [(0.001, 1), (1.001, 1001)])
async def test_wait_bound_in_seconds_is_recorded_in_whole_milliseconds(
    tmp_path, seconds, ms, monkeypatch
):
    from ma_harness import waiting_approvals

    now = 1_800_000_000_123
    monkeypatch.setattr(waiting_approvals, "clock_ms", lambda: now)
    async with make_agent(**options(tmp_path, max_approval_wait=seconds)) as agent:
        session = await agent.session(settings={"approvalWait": "untilDeadline"})
        await session.prompt("bump")
        [entry] = [e for e in await session.history() if e["kind"] == "inputRequest"]
        wire = entry["data"]["request"]
        assert entry["time"] == now and wire["timeLimitMs"] == ms and wire["deadlineAt"] == now + ms
        [q] = await session.questions(present=True)
        assert datetime.fromisoformat(q.deadline) == datetime.fromtimestamp((now + ms) / 1000, UTC)


async def test_refuse_a_deadline_the_approval_view_cannot_show(tmp_path):
    async with make_agent(**options(tmp_path, max_approval_wait=300_000_000_000.0)) as agent:
        session = await agent.session(settings={"approvalWait": "untilDeadline"})
        [result] = (await session.prompt("bump")).tool_results()
        assert result.status == "refused" and not await session.questions()


@pytest.mark.parametrize("bad", [True, 0, -1, 0.0005, 0.0015, float("nan"), float("inf"), 2**53])
async def test_invalid_maximum(tmp_path, bad):
    with pytest.raises(AgentError) as error:
        await make_agent(**options(tmp_path, max_approval_wait=bad))
    assert error.value.code == "invalid_composition"


@pytest.mark.parametrize(
    "incompatible",
    [{"approval": None}, {"durability": "ephemeral"}, {"late_answers_start_turns": False}],
)
async def test_incompatible_wait_composition(tmp_path, incompatible):
    with pytest.raises(AgentError) as error:
        await make_agent(**options(tmp_path, **incompatible))
    assert error.value.code == "invalid_composition"


@pytest.mark.parametrize("capable", [True, False])
async def test_live_is_still_the_default(tmp_path, capable):
    async with make_agent(
        **options(tmp_path, max_approval_wait=30.0 if capable else None)
    ) as agent:
        session = await agent.session()
        assert (await session.settings()).get("approvalWait", "live") == "live"
        assert bool(agent.declaration().get("approvalsOutlastTurns")) == capable
        if not capable:
            for action in (
                session.questions(present=True),
                session.set_setting("approvalWait", "untilDeadline"),
                agent.session(settings={"approvalWait": "untilDeadline"}),
            ):
                with pytest.raises(AgentError) as error:
                    await action
                assert error.value.code == "not_supported"
        [result] = (await session.prompt("bump")).tool_results()
        assert result.status == "refused" and not (tmp_path / "effects").exists()
        assert not await session.questions()


@pytest.mark.parametrize(
    "policy,expected", [("off", "completed"), ("ask", "completed"), ("never", "refused")]
)
async def test_wait_does_not_change_policy(tmp_path, policy, expected):
    async with make_agent(**options(tmp_path, approval=policy, readonly=True)) as agent:
        session = await agent.session(settings={"approvalWait": "untilDeadline"})
        [result] = (await session.prompt("bump")).tool_results()
        assert result.status == expected
        assert not any(e["kind"] == "inputRequest" for e in await session.history())


@pytest.mark.parametrize("process", [False, True])
@pytest.mark.parametrize(
    "how", ["decline", "early", "lapsed", "input", "worker", "approver", "control"]
)
async def test_decision_and_handoff_are_separate(tmp_path, process, how, monkeypatch):
    from ma_harness import waiting_approvals

    now = 1_800_000_000_000
    monkeypatch.setattr(waiting_approvals, "clock_ms", lambda: now)
    gate = asyncio.Event()
    release = asyncio.Event()
    continuing = False

    async def before(_):
        if continuing:
            gate.set()
            await release.wait()
            if how == "input":
                return {"change": {"input": {"amount": 2}}}

    opts = options(
        tmp_path,
        process,
        several_actors=True,
        plugins=[Plugin("barrier", hooks={"tool.before": before})],
    )
    async with make_agent(**opts) as agent:
        session = await agent.session(
            settings={
                "approvalWait": "untilDeadline",
                "approval_timeout": 10 if how == "early" else 60,
            },
            actors=[
                {"id": "worker", "kind": "program", "rights": ["watch", "input", "tools"]},
                {"id": "approver", "kind": "user", "rights": ["watch", "approve"]},
            ],
        )
        result = await session.as_actor("worker").prompt("bump")
        assert result.open_tool_calls
        await session.wait_idle()
        approver = session.as_actor("approver")
        [q] = await approver.questions(present=True)
        deadline = now + (10_000 if how == "early" else 30_000)
        assert datetime.fromisoformat(q.deadline) == datetime.fromtimestamp(deadline / 1000, UTC)
        if how == "early":
            now = deadline
            with pytest.raises(AgentError):
                await approver.answer(q.id, "allow")
        elif how == "decline":
            await approver.answer(q.id, "decline")
        else:
            now = deadline - 1
            continuing = True
            await approver.answer(q.id, "allow")
            try:
                async with asyncio.timeout(5):
                    await gate.wait()
                if how == "lapsed":
                    now += 1
                elif how in ("worker", "approver"):
                    await session.join(
                        {
                            "id": how,
                            "kind": "program" if how == "worker" else "user",
                            "rights": ["watch"],
                        }
                    )
            finally:
                release.set()
        await session.wait_idle()
        rows = await session.history()
        [answer] = [e for e in rows if e["kind"] == "inputAnswer"]
        [result] = [e for e in rows if e["kind"] == "toolResult"]
        assert result["data"]["status"] == (
            "completed"
            if how == "control"
            else "notStarted"
            if how in ("early", "lapsed")
            else "refused"
        )
        assert sum(e["kind"] == "toolStarted" for e in rows) == (how == "control")
        assert (tmp_path / "effects").exists() == (how == "control")
        assert sum(e["kind"] == "turnStart" for e in rows) == 2
        assert sum(e["kind"] == "inputRequest" for e in rows) == 1
        if how == "early":
            assert answer["data"]["reason"] == "timeLimit" and "actorId" not in answer["data"]
        else:
            assert answer["data"]["actorId"] == "approver"
            assert how == "decline" or answer["data"]["value"] == "allow"


@pytest.mark.parametrize("process", [False, True])
async def test_fork_move_and_erasure(tmp_path, process):
    async with make_agent(**options(tmp_path, process)) as agent:
        s = await agent.session(settings={"approvalWait": "untilDeadline"})
        await s.prompt("bump")
        await s.wait_idle()
        rows = await s.history()
        [request] = [e for e in rows if e["kind"] == "inputRequest"]
        [q] = await s.questions(present=True)
        with pytest.raises(AgentError):
            await s.fork()
        with pytest.raises(AgentError):
            await s.move_to(rows[0]["id"])
        result = await s.erase([request["id"]])
        assert {"id": request["id"], "sessionId": s.id} in result["erased"]
        with pytest.raises(AgentError):
            await s.answer(q.id, "allow")
        assert not (tmp_path / "effects").exists()
        assert not any(e["kind"] == "toolStarted" for e in await s.history())


@pytest.mark.parametrize("process", [False, True])
@pytest.mark.parametrize("changed", ["definition", "source", "maximum", "unsupported"])
async def test_reopen_with_changed_composition(tmp_path, process, changed):
    async with make_agent(**options(tmp_path, process)) as agent:
        s = await agent.session(settings={"approvalWait": "untilDeadline"})
        await s.prompt("bump")
        await s.wait_idle()
        sid = s.id
        await s.close()
    opts = options(tmp_path, process, readonly=changed == "definition")
    if changed == "source":
        opts["plugins"] = [Plugin("replacement", tools=opts.pop("tools"))]
    elif changed == "maximum":
        opts["max_approval_wait"] = 0.5
    elif changed == "unsupported":
        opts["max_approval_wait"] = None
    async with make_agent(**opts) as other:
        s = await other.open_session(sid)
        if changed not in ("maximum", "unsupported"):
            [q] = await s.questions(present=True)
            await s.answer(q.id, "allow")
        await s.wait_idle()
        rows = await s.history()
        assert sum(e["kind"] == "inputRequest" for e in rows) == 1
        [result] = [e for e in rows if e["kind"] == "toolResult"]
        assert result["data"]["status"] == ("notStarted" if changed == "unsupported" else "refused")
        assert not any(e["kind"] == "toolStarted" for e in rows)
        assert not (tmp_path / "effects").exists()


@pytest.mark.parametrize("process", [False, True])
async def test_early_and_withheld_views_cannot_answer(tmp_path, process):
    parked = asyncio.Event()
    release = asyncio.Event()
    blocked = True

    async def step(_):
        parked.set()
        await release.wait()

    async def output(payload):
        if (
            blocked
            and payload["recipient"] == "peer"
            and any(
                e["type"] == "reply" and e["data"].get("method") == "questions"
                for e in payload["events"]
            )
        ):
            return {"refuse": "private"}

    async with make_agent(
        **options(
            tmp_path,
            process,
            several_actors=True,
            plugins=[Plugin("test-view", hooks={"step.after": step, "output": output})],
        )
    ) as agent:
        s = await agent.session(
            settings={"approvalWait": "untilDeadline"},
            actors=[{"id": "peer", "kind": "user", "rights": ["watch", "approve"]}],
        )
        turn = asyncio.create_task(s.prompt("bump"))
        try:
            await parked.wait()
            [q] = await s.questions(present=True)
            assert not q.answerable
            with pytest.raises(AgentError):
                await s.answer(q.id, "allow")
        finally:
            release.set()
            await turn
        peer = s.as_actor("peer")
        assert await peer.questions(present=True) == []
        with pytest.raises(AgentError):
            await peer.answer(q.id, "allow")
        blocked = False
        [shown] = await peer.questions(present=True)
        assert shown.answerable
        blocked = True
        with pytest.raises(AgentError):
            await peer.answer(q.id, "allow")
        [unchanged] = await s.questions(present=True)
        await s.answer(unchanged.id, "allow")
        await s.wait_idle()
        assert (tmp_path / "effects").read_text() == "1\n"


@pytest.mark.parametrize("process", [False, True])
async def test_telemetry_covers_work_not_idle_time(tmp_path, process, monkeypatch):
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    trace_store = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(trace_store))
    monkeypatch.setattr(trace, "get_tracer", provider.get_tracer)
    try:
        async with make_agent(**options(tmp_path, process)) as agent:
            s = await agent.session(settings={"approvalWait": "untilDeadline"})
            await s.prompt("private-prompt")
            await s.wait_idle()
            ended = trace_store.get_finished_spans()
            [origin] = [span for span in ended if span.name == "invoke_agent"]
            assert not any(span.name.startswith("execute_tool") for span in ended)
            assert any(
                event.name == "modular_agent.question.open"
                for span in ended
                for event in span.events
            )
            [q] = await s.questions(present=True)
            await s.answer(q.id, "allow")
            await s.wait_idle()
        spans = trace_store.get_finished_spans()
        [execution] = [span for span in spans if span.name == "execute_tool bump"]
        [step] = [span for span in spans if span.context.span_id == execution.parent.span_id]
        assert step.name == "modular_agent.step"
        [continuation] = [span for span in spans if span.context.span_id == step.parent.span_id]
        assert (
            continuation.name == "invoke_agent"
            and continuation.links[0].context.span_id == origin.context.span_id
        )
        assert any(
            event.name == "modular_agent.question.close"
            for span in spans
            if span.name == "modular_agent.question.answer"
            for event in span.events
        )
        assert "private-prompt" not in str([span.attributes for span in spans])
    finally:
        provider.shutdown()


async def crash_driver(path, process, durability, stage):
    async def barrier():
        print("barrier", flush=True)
        await asyncio.Event().wait()

    async def inspect(payload):
        for event in payload["events"]:
            if (
                stage == "answer"
                and event["type"] == "entry"
                and event["data"]["entry"]["kind"] == "inputAnswer"
            ):
                await barrier()

    opts = options(
        path,
        process,
        durability,
        after_effect=barrier if stage == "effect" else None,
        plugins=[Plugin("observer", hooks={"output": inspect})],
    )
    async with make_agent(**opts) as agent:
        s = await agent.session(settings={"approvalWait": "untilDeadline"})
        await s.prompt("bump")
        await s.wait_idle()
        [q] = await s.questions(present=True)
        print(json.dumps([s.id, q.id, q.tool_call_id, q.deadline]), flush=True)
        if stage == "open":
            await barrier()
        await s.answer(q.id, "allow")
        await s.wait_idle()


@pytest.mark.parametrize("durability", ["kept", "durable"])
@pytest.mark.parametrize("process", [False, True])
@pytest.mark.parametrize("stage", ["open", "answer", "effect"])
async def test_process_stopped_at_commit_or_effect(tmp_path, process, durability, stage):
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        __file__,
        str(tmp_path),
        str(int(process)),
        durability,
        stage,
        stdout=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    try:
        async with asyncio.timeout(10):
            sid, qid, cid, deadline = json.loads(await proc.stdout.readline())
            assert await proc.stdout.readline() == b"barrier\n"
    finally:
        if proc.returncode is None:
            os.killpg(proc.pid, signal.SIGKILL)
        await proc.wait()
    async with make_agent(**options(tmp_path, process, durability)) as other:
        s = await other.open_session(sid)
        if stage == "open":
            with pytest.raises(AgentError):
                await s.answer(qid, "allow")
            [q] = await s.questions(present=True)
            assert (q.id, q.tool_call_id, q.deadline) == (qid, cid, deadline)
            await s.answer(qid, "allow")
        await s.wait_idle()
        rows = await s.history()
        assert sum(e["kind"] == "turnStart" for e in rows) == 2
        assert sum(e["kind"] == "inputAnswer" for e in rows) == 1
        assert sum(e["kind"] == "toolStarted" for e in rows) == 1
        [result] = [e for e in rows if e["kind"] == "toolResult"]
        assert result["data"]["status"] == ("outcomeUnknown" if stage == "effect" else "completed")
        assert (tmp_path / "effects").read_text() == "1\n"


if __name__ == "__main__":
    asyncio.run(crash_driver(Path(sys.argv[1]), bool(int(sys.argv[2])), *sys.argv[3:]))
