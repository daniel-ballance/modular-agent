import base64

import pytest

from modular_agent import (
    AgentError,
    Answer,
    CredentialStore,
    EnvironmentSupports,
    HookContext,
    Plugin,
    ToolBefore,
    ToolContext,
    create_agent,
    file_history,
    tool,
)
from modular_agent.testing import (
    memory_environment,
    over_wire,
    scripted_provider,
    test_agent as make_agent,
)


@pytest.mark.parametrize("served", [False, True])
async def test_catalog_changes_before_next_dispatch(served):
    from modular_agent import ToolSource

    @tool
    async def next_tool():
        """Offer a new tool."""
        return "new result"

    @tool
    async def refresh():
        """Refresh the tools."""
        catalog.append(next_tool)
        source.changed()
        return "ready"

    catalog = [refresh]
    source = ToolSource("changing", lambda _: catalog)
    plugin = Plugin("catalog", setup=lambda r: r.tools(source))
    script = [
        {"toolCalls": [{"name": "refresh", "input": {}}]},
        {"toolCalls": [{"name": "next_tool", "input": {}}]},
        {"text": "done"},
    ]
    async with make_agent(
        script=script, plugins=[over_wire(plugin) if served else plugin]
    ) as agent:
        session = await agent.session()
        result = await session.prompt("Refresh, then call the new tool.")
        assert result.text == "done"
        assert [tool.text() for tool in result.tool_results()] == ["ready", "new result"]


@pytest.mark.parametrize("served", [False, True])
async def test_custom_working_environment(served):
    class Environment:
        supports: EnvironmentSupports = {"containment": "none", "confinesFiles": True}

        def __init__(self):
            self.files = {}
            self.ended = []

        async def read(self, params):
            if params["path"] not in self.files:
                from modular_agent import ErrorCode

                raise AgentError(ErrorCode.NOT_FOUND, "missing")
            return {"data": self.files[params["path"]]}

        async def exists(self, params):
            return {"exists": params["path"] in self.files}

        async def write(self, params):
            self.files[params["path"]] = params["data"]
            return {}

        async def exec(self, params, progress):
            await progress(params["command"])
            return {"exitCode": 0, "output": "ran", "timedOut": False}

        async def session_ended(self, params):
            self.ended.append(params["sessionId"])

    @tool
    async def check(cx: ToolContext):
        """Read and write through the active environment."""
        await cx.environment.write("receipt", b"written")
        assert await cx.environment.read("receipt") == b"written"
        assert (await cx.environment.exec("command"))["text"] == "ran"
        return "confirmed"

    env = Environment()
    plugin = Plugin("env", replaces=["working-environment"], setup=lambda r: r.environment(env))
    async with make_agent(
        script=[], tools=[check], plugins=[over_wire(plugin) if served else plugin]
    ) as agent:
        assert agent.declaration()["commandContainment"] == "none"
        assert agent.declaration()["confinesFiles"] is True
        session = await agent.session()
        assert (await session.call_tool("check", {})).text() == "confirmed"
        await session.close()
        assert env.ended == [session.id]
        assert env.files == {"receipt": base64.b64encode(b"written").decode()}


async def test_configuration_credentials_and_interface(tmp_path):
    lifecycle = []

    class Configuration:
        def settings(self, project):
            assert project == tmp_path
            return {"example": "from config"}

        def trusted(self, project):
            return project == tmp_path

    class Interface:
        async def start(self, agent):
            lifecycle.append(agent)

        async def stop(self):
            lifecycle.append("stop")

    provider = scripted_provider([{"text": "hello"}])
    standard_request = provider.request

    async def observing_request(model, request, cx):
        assert cx.credential() == "test-only"
        return await standard_request(model, request, cx)

    provider.request = observing_request

    def setup(r):
        r.configuration(Configuration())
        r.credential_store(
            CredentialStore(lambda name: "test-only" if name == "scripted" else None)
        )
        r.interface(Interface())

    async with create_agent(
        project=tmp_path, providers=[provider], plugins=[Plugin("parts", setup=setup)]
    ) as agent:
        assert lifecycle == [agent]
        session = await agent.session()
        assert (await session.settings())["example"] == "from config"
        assert (await session.prompt("Hello")).text == "hello"
    assert lifecycle[-1] == "stop"


async def test_custom_hook_and_command_question():
    contexts = []

    async def survey(_, cx):
        contexts.append(cx)
        response = await cx.ask({"kind": "text", "question": "Your name?"})
        result = await cx.call_hook("survey.result", {"value": response.value})
        assert (await cx.history())["entries"]
        return str(result["value"])

    def owner(r):
        r.define_hook("survey.result", "transform")
        r.command("survey", "Ask a question", survey, in_process_only=True)

    def listener(r):
        r.on("survey.result", lambda p: {"change": {"value": f"Hello {p['value']}"}})

    async with make_agent(
        script=[],
        plugins=[Plugin("survey", setup=owner), Plugin("listener", setup=listener)],
        on_question=lambda q, cx: Answer("value", "Ada"),
    ) as agent:
        session = await agent.session()
        assert await session.run_command("/survey") == "Hello Ada"
        assert await session.last_turn() is None
        with pytest.raises(AgentError) as exc:
            await contexts[0].history()
        assert exc.value.code == "invalid_request"


async def test_in_process_hooks_include_actor_lifecycle_and_pieces():
    seen = []

    def setup(r):
        r.on("session.join", lambda p, cx: seen.append(("join", cx.session_id)))
        r.on("session.leave", lambda p, cx: seen.append(("leave", cx.session_id)))
        r.on("provider.piece", lambda p, cx: seen.append((p["event"]["type"], cx.session_id)))

    async with make_agent(
        script=[{"text": "ok"}], several_actors=True, plugins=[Plugin("observe", setup=setup)]
    ) as agent:
        session = await agent.session()
        await session.join({"id": "guest", "kind": "user", "rights": ["watch"]})
        await session.prompt("hello")
        await session.leave("guest")
    assert seen == [("join", session.id), ("text", session.id), ("leave", session.id)]


async def test_move_erase_and_proposals_with_shared_content(tmp_path):
    async with make_agent(
        script=[{"text": "first"}, {"text": "second"}],
        several_actors=True,
        durability="kept",
        history=file_history(tmp_path / "history"),
        environment=memory_environment(),
    ) as agent:
        session = await agent.session()
        await session.join({"id": "guest", "kind": "user", "rights": ["watch", "propose", "tools"]})
        guest = session.as_actor("guest")
        parts = [{"type": "text", "text": "first prompt"}, {"type": "example", "opaque": [1, 2]}]
        abandoned = await guest.send(parts, "propose")
        assert (await session.proposals())[0]["content"] == parts
        await guest.withdraw(abandoned.input_id)
        assert await session.proposals() == []
        proposal = await guest.send(parts, "propose")
        assert (await session.release(proposal.input_id)).input_id == proposal.input_id
        await session.wait_idle()
        first_point = next(e["id"] for e in await session.history() if e["kind"] == "turnEnd")
        assert (await session.prompt("second prompt")).text == "second"
        second_input = next(
            e["id"]
            for e in await session.history()
            if e["kind"] == "input"
            and e.get("message", {}).get("content") == [{"type": "text", "text": "second prompt"}]
        )
        await session.move_to(first_point)
        assert (await session.last_turn()).text == "first"
        report = await session.erase([second_input])
        assert {"sessionId": session.id, "id": second_input} in report["erased"]


async def test_gate_pending_leaves_call_for_a_later_turn():
    executed = []

    @tool
    async def action():
        """Carry on once the gate is settled."""
        executed.append(True)
        return "ran"

    async def gate(payload: ToolBefore, cx: HookContext):
        assert cx.session_id == payload["sessionId"]
        return {"pending": {"kind": "text", "question": "Enter a value"}}

    def setup(r):
        r.on("tool.before", gate, in_process_only=True)

    async with make_agent(
        script=[
            {"toolCalls": [{"name": "action", "input": {}}]},
            {"text": "ready"},
            {"text": "continued"},
        ],
        tools=[action],
        plugins=[Plugin("defer", setup=setup)],
        late_answers_start_turns=True,
    ) as agent:
        session = await agent.session()
        first = await session.prompt("Run the action")
        assert len(first.open_tool_calls) == 1 and executed == []
        [question] = await session.questions()
        await session.answer(question.id, Answer("value", "yes"))
        await session.wait_idle()
        assert executed == [True]
        settled = await session.last_turn()
        assert settled.turn_id != first.turn_id and settled.outcome.kind == "completed"
