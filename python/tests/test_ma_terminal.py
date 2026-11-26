"""How ma's interactive mode answers a secret question."""

import argparse
import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import json
from pathlib import Path
import queue
import re

import pytest

from modular_agent import (
    AcpPolicy,
    Answer,
    Session,
    Tool,
    ToolStatus,
    create_agent,
    file_credentials,
    subscription_logins,
)
from modular_agent.testing import scripted_provider
from ma_standard import cli
from ma_standard.config import Paths


class Keyboard:
    def __init__(self, tty: bool) -> None:
        self.tty = tty
        self.lines: queue.Queue[str] = queue.Queue()

    def isatty(self) -> bool:
        return self.tty

    def readline(self) -> str:
        return self.lines.get()

    def type(self, text: str) -> None:
        self.lines.put(text + "\n")


@dataclass
class Terminal:
    session: Session
    keyboard: Keyboard
    auth: Path
    results: list[str] = field(default_factory=list)


@asynccontextmanager
async def terminal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, tty: bool
) -> AsyncIterator[Terminal]:
    auth = subscription_logins(tmp_path / "auth.json")
    results: list[str] = []

    async def ask(arguments, context):
        reply = await context.ask(
            {"kind": "secret", "question": "Deploy key?", "credential": "deploy"}
        )
        results.append("declined" if reply.kind == "decline" else "stored")
        return results[-1]

    tool = Tool.from_schema("ask_secret", "Ask for a key", {"type": "object"}, ask)
    provider = scripted_provider([{"toolCalls": [{"name": "ask_secret"}]}, {"text": "done"}])
    keyboard = Keyboard(tty)
    monkeypatch.setattr(cli.sys, "stdin", keyboard)
    async with create_agent(
        project=tmp_path, tools=[tool], providers=[provider], credentials=file_credentials(auth)
    ) as agent:
        session = await agent.session()
        line = asyncio.create_task(
            cli._line(session, argparse.Namespace(json=False, verbose=False))
        )
        yield Terminal(session, keyboard, auth.path, results)
        keyboard.lines.put("")
        assert await asyncio.wait_for(line, 5) == 0


async def until(check, what: str):
    for _ in range(500):
        if value := check():
            return value
        await asyncio.sleep(0.01)
    raise AssertionError("timed out waiting for " + what)


def stored(auth: Path) -> object:
    return json.loads(auth.read_text()).get("answers", {}).get("deploy") if auth.exists() else None


async def test_without_a_terminal_a_secret_question_is_declined_when_it_opens(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async with terminal(tmp_path, monkeypatch, tty=False) as term:
        term.keyboard.type("Ask.")
        await until(lambda: term.results, "the tool's result")
    assert term.results == ["declined"]
    assert "Question" not in capsys.readouterr().err
    assert stored(term.auth) is None


async def test_a_secret_on_the_answer_line_is_refused_and_getpass_reads_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    prompts: list[str] = []
    monkeypatch.setattr(cli.getpass, "getpass", lambda prompt: prompts.append(prompt) or "typed")
    shown = ""

    def show(text: str) -> str | None:
        nonlocal shown
        shown += capsys.readouterr().err
        return shown if text in shown else None

    async with terminal(tmp_path, monkeypatch, tty=True) as term:
        term.keyboard.type("Ask.")
        await until(lambda: show("Use /answer REQUEST_ID (hidden input)"), "the question")
        match = re.search(r"Question (\S+): Deploy key\?\n", shown)
        assert match, shown
        term.keyboard.type(f"/answer {match[1]} typed-in-view")
        await until(
            lambda: show("Do not put the secret on the command line; use /answer REQUEST_ID"),
            "the refusal",
        )
        assert len(await term.session.questions()) == 1
        assert prompts == [] and term.results == []
        term.keyboard.type(f"/answer {match[1]}")
        await until(lambda: term.results, "the tool's result")
    assert prompts == ["Secret: "]
    assert term.results == ["stored"]
    assert stored(term.auth) == "typed"
    assert "typed-in-view" not in term.auth.read_text()


async def test_ask_secret_hook_is_unreachable_without_modular_agent_script(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = tmp_path / "config"
    state = tmp_path / "state"
    project = tmp_path / "project"
    for folder in (config, state, project):
        folder.mkdir()
    script_file = tmp_path / "script.json"
    script_file.write_text('[{"text": "ok"}]', encoding="utf-8")

    def make_args() -> argparse.Namespace:
        args = cli._parser().parse_args(
            ["--project", str(project), "--runtime", "transient", "--declaration"]
        )
        args.client_identity = "test-client"
        args.operator_policy = AcpPolicy(config / "policy.json", required=False)
        return args

    monkeypatch.delenv("MODULAR_AGENT_CONFORMANCE", raising=False)
    monkeypatch.delenv("MODULAR_AGENT_HISTORY_URL", raising=False)
    monkeypatch.delenv("MODULAR_AGENT_HISTORY_TOKEN_FILE", raising=False)
    monkeypatch.setenv("MODULAR_AGENT_SCRIPT", str(script_file))
    async with await cli._agent(Paths(config, state), project, make_args()) as scripted:
        session = await scripted.session()
        await session.on_question(lambda _q, _ctx: Answer("decline"))
        await session.prompt("init")
        session_id = session.id
        direct = await session.call_tool(
            "test_ask_secret", {"question": "Key?", "credential": "deploy"}
        )
        assert direct.status is ToolStatus.COMPLETED
        assert direct.text() == "declined"

    monkeypatch.delenv("MODULAR_AGENT_SCRIPT", raising=False)
    async with await cli._agent(Paths(config, state), project, make_args()) as unscripted:
        session = await unscripted.open_session(session_id)
        direct = await session.call_tool(
            "test_ask_secret", {"question": "Key?", "credential": "deploy"}
        )
        assert direct.status is ToolStatus.FAILED
        assert "Unknown tool: test_ask_secret" in direct.text()
        nested = await session.call_tool(
            "codemode",
            {"code": "tools.test_ask_secret(question='Key?', credential='deploy')"},
        )
        assert nested.status is ToolStatus.FAILED
        assert "AttributeError" in nested.text()
