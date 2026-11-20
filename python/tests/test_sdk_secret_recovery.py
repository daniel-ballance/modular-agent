"""Crash on each side of secret selection and activation, then reopen the session."""

import asyncio
import os
import signal
import sys
from dataclasses import replace
from pathlib import Path

import pytest

from modular_agent import ToolContext, file_credentials, run, tool
from modular_agent.testing import test_agent as build_agent

CANARY = "test-secret-never-in-history"
NAME = "survey-token"


@tool
async def ask_secret(cx: ToolContext) -> str:
    """Request the survey token."""
    answer = await cx.ask({"kind": "secret", "question": "Survey token?", "credential": NAME})
    return str(answer.value)


def agent_at(root, store):
    return build_agent(
        project=root,
        data_dir=root / "data",
        durability="kept",
        credentials=store,
        tools=[ask_secret],
        script=[{"toolCalls": [{"name": "ask_secret", "input": {}}]}, {"text": "Done"}],
    )


async def crash(root: Path, cutoff: str) -> None:
    store = file_credentials(root / "answers.json")
    stage, activate = store.stage, store.activate
    assert stage is not None and activate is not None

    async def stage_then_kill(*args):
        result = await stage(*args)
        if cutoff == "staged":
            os.kill(os.getpid(), signal.SIGKILL)
        return result

    async def activate_and_kill(*args):
        if cutoff == "selected":
            os.kill(os.getpid(), signal.SIGKILL)
        result = await activate(*args)
        if cutoff == "activated":
            os.kill(os.getpid(), signal.SIGKILL)
        return result

    store = replace(store, stage=stage_then_kill, activate=activate_and_kill)
    async with agent_at(root, store) as agent:
        session = await agent.session()
        (root / "session").write_text(session.id)
        await session.send("Ask for a secret.", "now")
        async with asyncio.timeout(5):
            while not (questions := await session.questions()):
                await asyncio.sleep(0.01)
        await session.answer(questions[0].id, {"value": CANARY})
    raise AssertionError("The credential path never reached its crash cutoff")


@pytest.mark.parametrize("cutoff", ["staged", "selected", "activated"])
async def test_reopens_secret_answer_after_sigkill(tmp_path: Path, cutoff: str) -> None:
    child = await asyncio.create_subprocess_exec(sys.executable, __file__, str(tmp_path), cutoff)
    try:
        assert await asyncio.wait_for(child.wait(), 15) == -signal.SIGKILL
    finally:
        if child.returncode is None:
            child.kill()
            await child.wait()
    store = file_credentials(tmp_path / "answers.json")
    assert store.read(NAME) == (CANARY if cutoff == "activated" else None)
    async with agent_at(tmp_path, store) as agent:
        session = await agent.open_session((tmp_path / "session").read_text())
        assert await session.questions() == []
        records = await session.history()
        assert CANARY not in repr(records)
        answers = [e["data"] for e in records if e["kind"] == "inputAnswer"]
        [answer] = answers
        if cutoff == "staged":
            assert answer["declined"] is True
            assert store.read(NAME) is None
        else:
            accepted = next(e for e in records if e["kind"] == "secretAnswerAccepted")
            assert answer["requestId"] == accepted["requestId"]
            assert answer["stored"] == NAME
            assert store.read(NAME) == CANARY


async def test_stages_do_not_replace_active_or_newer_answers(tmp_path: Path) -> None:
    store = file_credentials(tmp_path / "answers.json")
    assert store.stage and store.lookup_staged and store.activate and store.discard
    await store.stage("s", "old", NAME, "user", "old-value")
    receipt = await store.stage("s", "first", NAME, "user", "first-value")
    assert await store.lookup_staged("s", "first") == receipt
    assert "first-value" not in repr(receipt)
    assert store.read(NAME) is None
    assert await store.activate("s", "first") == "activated"
    assert await store.activate("s", "old") == "superseded"
    await store.stage("s", "second", NAME, "user", "second-value")
    assert await store.activate("s", "second") == "activated"
    assert await store.activate("s", "first") == "activated"
    assert store.read(NAME) == "second-value"
    await store.discard("s", "declined")
    with pytest.raises(Exception, match="already staged or discarded"):
        await store.stage("s", "declined", NAME, "user", "not-accepted")


if __name__ == "__main__":
    run(crash(Path(sys.argv[1]), sys.argv[2]))
