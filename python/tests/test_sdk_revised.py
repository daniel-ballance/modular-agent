"""Public SDK checks for the second standard-configuration pass."""

import json

import pytest

from modular_agent import Answer, Plugin, ProviderSupports, Tool, create_agent
from modular_agent.testing import over_wire, scripted_provider


class Recorder:
    supports = ProviderSupports()

    def __init__(self, name):
        self.id = name
        self.requests = []

    def models(self):
        return [
            {
                "id": "model",
                "provider": self.id,
                "contextWindow": 100_000,
                "maxOutput": 1000,
                "thinking": ["off"],
                "input": ["text"],
                "reasoning": True,
            }
        ]

    async def request(self, model, request, context):
        self.requests.append(request)
        return {
            "role": "assistant",
            "stop": "finished",
            "content": [
                {"type": "text", "text": "answer"},
                {"type": "reasoning", "providerData": "sealed-part"},
            ],
            "providerData": "sealed-response",
            # The adapter binds the record to the actual Provider, not a claimed id.
            "model": {"provider": "someone-else", "id": "model"},
        }


async def test_provider_data_only_reaches_its_producer_after_reopen(tmp_path):
    a, b = Recorder("alpha"), Recorder("beta")
    options = dict(
        project=tmp_path,
        data_dir=tmp_path / "state",
        durability="durable",
        providers=[a, b],
        model="alpha/model",
    )
    async with create_agent(**options) as agent:
        session = await agent.session()
        assert (await session.prompt("one")).text == "answer"
        assert "sealed-" not in json.dumps(await session.history())
        sid = session.id
    async with create_agent(**options) as agent:
        assert (await agent.session_info(sid))["project"] == str(tmp_path)
        assert [row["id"] for row in await agent.sessions(project=tmp_path)] == [sid]
        assert await agent.sessions(project=tmp_path / "another") == []
        session = await agent.open_session(sid)
        assert (await session.prompt("two")).text == "answer"
        assert "sealed-part" in json.dumps(a.requests[-1])
        assert "sealed-response" in json.dumps(a.requests[-1])
        await session.set_setting("model", "beta/model")
        assert (await session.prompt("three")).text == "answer"
        assert "sealed-" not in json.dumps(b.requests[-1])
        assert "sealed-" not in json.dumps(await session.history())


async def test_session_prepare_installs_resources_before_start(tmp_path):
    seen = []

    def setup(registrar):
        registrar.on("session.prepare", lambda p: seen.append((p["project"], p["resumed"])))
        registrar.on("session.start", lambda p: seen.append("start"))

    options = dict(
        project=tmp_path,
        data_dir=tmp_path / "state",
        durability="durable",
        providers=[scripted_provider([{"text": "ready"}])],
        plugins=[Plugin("resource", setup=setup)],
    )
    async with create_agent(**options) as agent:
        session = await agent.session()
        sid = session.id
        await session.prompt("Keep this session.")
    async with create_agent(**options) as agent:
        await agent.session_info(sid)
        assert seen == [(str(tmp_path), False), "start"]
        await agent.open_session(sid)
        assert seen == [(str(tmp_path), False), "start", (str(tmp_path), True), "start"]


@pytest.mark.parametrize("served", [False, True])
async def test_a_late_answer_resumes_a_tool_in_a_new_turn(served):
    async def ask(arguments, context):
        answer = await context.ask(
            {"kind": "text", "question": "Which file?"}, wait=0, then="leaveOpen"
        )
        return str(answer.value)

    def setup(registrar):
        registrar.tool(Tool.from_schema("ask_file", "Ask for a file", {"type": "object"}, ask))

    plugin = Plugin("asker", setup=setup)
    provider = scripted_provider(
        [{"toolCalls": [{"name": "ask_file", "input": {}}]}, {"text": "continued"}]
    )
    async with create_agent(
        providers=[provider],
        plugins=[over_wire(plugin) if served else plugin],
        late_answers_start_turns=True,
    ) as agent:
        session = await agent.session()
        initial = await session.prompt("ask")
        assert len(initial.open_tool_calls) == 1
        questions = await session.questions()
        assert len(questions) == 1 and questions[0].question == "Which file?"
        await session.answer(questions[0].id, Answer("value", "notes.md"))
        await session.wait_idle()
        assert (await session.last_turn()).text == "continued"


@pytest.mark.parametrize("served", [False, True])
async def test_scoped_environment_bytes_listing_and_exec(tmp_path, served):
    async def roundtrip(arguments, context):
        await context.environment.write("test.txt", b"hello\n")
        data = await context.environment.read("test.txt")
        entries = await context.environment.list(".")
        result = await context.environment.exec("printf hello")
        return f"{data.decode().strip()} {entries[0]['name']} {result['text']}"

    t = Tool.from_schema("roundtrip", "Exercise scoped file access", {"type": "object"}, roundtrip)
    part = Plugin("scoped", tools=[t])
    async with create_agent(
        project=tmp_path, plugins=[over_wire(part) if served else part], local_process_groups=True
    ) as agent:
        session = await agent.session()
        result = await session.call_tool("roundtrip", {})
        assert result.text() == "hello test.txt hello"
        assert (tmp_path / "test.txt").read_bytes() == b"hello\n"
