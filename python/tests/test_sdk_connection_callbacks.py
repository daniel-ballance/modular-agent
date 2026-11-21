"""A served role can receive callbacks on the connection that reported output."""

import asyncio
import secrets
import sys
from contextlib import AsyncExitStack, aclosing
from pathlib import Path

import pytest

from modular_agent import (
    AgentError,
    JobProgressEvent,
    Plugin,
    ToolContext,
    ToolSource,
    create_agent,
    serve,
    tool,
)
from modular_agent.testing import memory_environment, over_wire, scripted_provider
from modular_agent.testing import test_agent as make_agent

IMAGE = {
    "type": "image",
    "mimeType": "image/gif",
    "data": "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
}


def preview(text):
    return [{"type": "text", "text": text}, IMAGE]


def progress_plugin():
    class Owner:
        async def cancel(self, job, cx):
            await job.end("cancelled")

    async def start(_, cx):
        job = await cx.jobs.start("preview", {})
        for text in ("first", "second"):
            await job.progress(preview(text))
        await job.end("completed")
        return job.id

    def output(payload):
        events = payload["events"]
        for event in events:
            if event["type"] == "python.job_progress":
                text = event["data"]["content"][0]["text"]
                assert event["data"]["content"] == preview(text)
                event["data"]["content"] = preview("gated " + text)
        return {"redact": events}

    def setup(r):
        r.jobs(Owner())
        r.command("preview", "Report two image previews", start)
        r.on("output", output)

    return Plugin("preview", setup=setup)


@pytest.mark.parametrize(
    "transport", ["stdio", pytest.param("websocket", marks=pytest.mark.loopback)]
)
async def test_job_progress_through_own_output_gate(tmp_path, transport):
    async with asyncio.timeout(10), AsyncExitStack() as stack:
        if transport == "stdio":
            options = {
                "process_plugins": [{"command": [sys.executable, str(Path(__file__).resolve())]}]
            }
        else:
            token_file = tmp_path / "token"
            token_file.touch(mode=0o600)
            token_file.write_text(secrets.token_hex(32))
            server = await serve(progress_plugin, listen="127.0.0.1:0", token_file=token_file)
            stack.push_async_callback(server.close)
            options = {"service_plugins": [{"url": server.url, "token_file": token_file}]}
        agent = await stack.enter_async_context(
            create_agent(project=tmp_path, environment=memory_environment(), **options)
        )
        session = await agent.session()
        async with asyncio.timeout(5), aclosing(session.events()) as events:
            assert (await anext(events)).type == "entry"

            async def follow():
                result = []
                async for event in events:
                    if isinstance(event, JobProgressEvent):
                        result.append(event.data.fields)
                    if event.type == "jobEnded":
                        return result

            async with asyncio.TaskGroup() as tasks:
                progress = tasks.create_task(follow())
                command = tasks.create_task(session.run_command("/preview"))
            assert progress.result() == [
                {"job": command.result(), "content": preview("gated first")},
                {"job": command.result(), "content": preview("gated second")},
            ]


async def test_provider_piece_can_wait_for_same_peer_from_a_child_task(tmp_path):
    dispatched = []

    class Environment:
        supports = {"containment": "none"}

        async def exec(self, params, progress):
            dispatched.append(params["command"])
            await progress("unreachable")
            return {"output": "unreachable", "exitCode": 0, "timedOut": False}

        async def session_ended(self, _):
            pass

    async def status(args, cx):
        if args == "stream":
            try:
                await cx.environment.exec("inspect")
            except AgentError as exc:
                return exc.code.value
        return "ready"

    def setup(r):
        r.provider(scripted_provider([{"text": "answer"}]))
        r.command("status", "Return a status", status)
        r.environment(Environment())

    seen = []

    async def piece(payload):
        # The old bypass only recognized RPCs made by the notification task
        # itself, not replies needed by its child tasks.
        command = asyncio.create_task(session.run_command("/status"))
        done, _ = await asyncio.wait({command}, timeout=3)
        # On the broken host, leave the notification and unblock teardown
        # instead of cancelling a request whose reply is already queued.
        assert command in done, "command reply waited behind the Provider piece"
        seen.append((payload["event"]["delta"], command.result()))
        # Unlike a plain reply, a reentrant env/exec result would need its
        # own progress delivered behind this Provider piece. Refuse dispatch.
        command = asyncio.create_task(session.run_command("/status stream"))
        done, _ = await asyncio.wait({command}, timeout=3)
        assert command in done, "cyclic environment request was not refused"
        seen.append(command.result())

    observer = Plugin("observer", hooks={"provider.piece": piece})
    async with create_agent(
        project=tmp_path,
        environment=memory_environment(),
        plugins=[
            over_wire(Plugin("both", replaces=["working-environment"], setup=setup)),
            observer,
        ],
        model="scripted/script",
    ) as agent:
        session = await agent.session()
        async with asyncio.timeout(5):
            result = await session.prompt("Generate")
        assert result.text == "answer"
        assert seen == [("answer", "ready"), "internal"]
        assert not dispatched


async def test_environment_and_tool_progress_on_same_peer():
    class Environment:
        supports = {"containment": "none"}

        async def exec(self, params, progress):
            assert params["command"] == "inspect"
            await progress("streamed")
            return {"output": "streamed", "exitCode": 0, "timedOut": False}

        async def read(self, params):
            assert params["path"] == "result"
            return {"data": "cmVhZHk="}

        async def session_ended(self, _):
            pass

    @tool
    async def inspect(cx: ToolContext) -> str:
        """Exec and read through the working environment."""
        await cx.progress(preview("starting"))
        assert (await cx.environment.exec("inspect"))["text"] == "streamed"
        return (await cx.environment.read("result")).decode()

    def output(payload):
        events = payload["events"]
        for event in events:
            if event["type"] == "toolOutput":
                data = event["data"]
                data["chunk"] = "gated " + data["chunk"]
        return {"redact": events}

    plugin = Plugin(
        "env-and-tool",
        tools=[inspect],
        hooks={"output": output},
        replaces=["working-environment"],
        setup=lambda r: r.environment(Environment()),
    )
    script = [{"toolCalls": [{"name": "inspect", "input": {}}]}, {"text": "done"}]
    async with make_agent(script=script, plugins=[over_wire(plugin)]) as agent:
        session = await agent.session()
        async with asyncio.timeout(5), aclosing(session.events()) as events:
            assert (await anext(events)).type == "entry"
            turn = await session.prompt("Inspect")
            [result] = turn.tool_results()
            assert result.text() == "ready"
            chunks = []
            async for event in events:
                if event.type == "toolOutput":
                    chunks.append(event.data.fields)
                if event.type == "turnEnded":
                    break
            assert chunks == [
                {
                    "toolCallId": result.call_id,
                    "chunk": "gated starting",
                    "content": preview("starting"),
                },
                {
                    "toolCallId": result.call_id,
                    "chunk": "gated streamed",
                    "content": [{"type": "text", "text": "streamed"}],
                },
            ]


async def test_catalog_refresh_and_custom_event_through_own_gate():
    changed = False
    listed = []

    @tool
    async def added() -> str:
        """A newly listed tool."""
        return "available"

    async def update(_, cx):
        nonlocal changed
        changed = True
        source.changed()
        await cx.emit("catalog.changed", {"message": "ready"})
        return "updated"

    def tools(sid):
        listed.append(sid)
        return [added] if changed else []

    source = ToolSource("catalog", tools)

    def output(payload):
        events = payload["events"]
        for event in events:
            if event["type"] == "catalog.changed":
                event["data"]["data"]["message"] = "gated ready"
        return {"redact": events}

    def setup(r):
        r.tools(source)
        r.command("update", "Change the catalog", update)
        r.on("output", output)

    async with make_agent(script=[], plugins=[over_wire(Plugin("catalog", setup=setup))]) as agent:
        session = await agent.session()
        async with asyncio.timeout(5), aclosing(session.events()) as events:
            assert (await anext(events)).type == "entry"
            assert await session.run_command("/update") == "updated"
            assert listed == [None, None]  # Registration and the scoped refresh.
            async for event in events:
                if event.type == "catalog.changed":
                    assert event.data.fields == {"message": "gated ready"}
                    break
            assert (await session.call_tool("added", {})).text() == "available"


if __name__ == "__main__":
    serve(progress_plugin())
