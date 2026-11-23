"""Read-only discovery through the public SDK and authenticated service."""

import asyncio
from contextlib import asynccontextmanager

from httpx2 import AsyncClient
import pytest
from websockets.asyncio.client import connect

from modular_agent import ToolContext, create_agent, tool
from modular_agent.testing import scripted_provider
from test_sdk_agui import events, new, principal, prompt
from test_websocket import rpc

pytestmark = pytest.mark.loopback


@asynccontextmanager
async def clients(agent, root, **options):
    actors, tokens = zip(
        principal(root, "editor", "user", ["input", "watch", "tools", "answer"]),
        principal(root, "reader", "user", ["watch"]),
        principal(root, "other", "bob", ["watch", "tools", "answer"]),
        principal(root, "blind", "user", ["answer"]),
        principal(root, "second-editor", "user", ["watch", "tools", "answer"]),
        strict=True,
    )
    handle = await agent.serve_agui(listen="127.0.0.1:0", actors=actors, **options)
    headers = [{"Authorization": "Bearer " + token} for token in tokens]
    try:
        async with AsyncClient(
            base_url=handle.url + "/agui/v1/", headers=headers[0], trust_env=False
        ) as client:
            yield client, headers
    finally:
        await handle.close()


def listing(reply):
    assert reply.status_code == 200, reply.text
    return {r["threadId"]: r["waiting"] for r in reply.json()["threads"]}


async def test_parked_question_is_counted_only_for_an_eligible_viewer(tmp_path):
    @tool(read_only=True)
    async def ask(cx: ToolContext) -> str:
        """Ask which file to edit."""
        answer = await cx.ask(
            {"kind": "text", "question": "Which private file?"}, wait=0, then="leaveOpen"
        )
        return str(answer.value)

    script = [{"toolCalls": [{"name": "ask", "input": {}}]}, {"text": "answered"}]
    options = dict(
        project=tmp_path,
        data_dir=tmp_path / "data",
        durability="durable",
        tools=[ask],
        providers=[scripted_provider(script)],
        late_answers_start_turns=True,
    )
    async with create_agent(**options) as agent:
        async with clients(agent, tmp_path) as (client, _):
            sid = await new(client)
            assert events(await client.post("run", json=prompt(sid)))[-1]["type"] == "RUN_FINISHED"
        # A cold service can count a parked question without its writer or any presence.
        reports = []
        async with (
            create_agent(**options) as observer,
            clients(
                observer,
                tmp_path,
                acp=True,
                resume_open={"report": lambda *row: reports.append(row)},
            ) as (client, auth),
        ):
            for i, count in [(0, 1), (1, 0)]:
                reply = await client.get("threads", headers=auth[i])
                assert listing(reply) == {sid: {"turn": "none", "questions": count, "toolCalls": 0}}
                assert "private" not in reply.text
                async with connect(
                    str(client.base_url.copy_with(scheme="ws", path="/")),
                    subprotocols=["modular-agent-acp-1"],
                    additional_headers=auth[i],
                ) as ws:
                    await rpc(ws, 1, "initialize", {"protocolVersion": 1})
                    page = await rpc(ws, 2, "session/list", {"cwd": str(tmp_path)})
                    [info] = page["result"]["sessions"]
                    assert info["sessionId"] == sid
                    assert info["_meta"]["modular-agent"]["waiting"] == listing(reply)[sid]
            for header in auth[2:4]:
                assert listing(await client.get("threads", headers=header)) == {}
                assert (await client.get("threads/" + sid, headers=header)).status_code == 404
            assert (await client.get("threads", headers={"Authorization": ""})).status_code == 401
        assert reports == []


async def test_handoff_is_counted_on_the_executor_route_only(tmp_path):
    definition = {"name": "pick", "parameters": {}, "description": "Pick", "callers": ["model"]}
    src = {
        "actor_id": "user",
        "source_id": "ui",
        "route_id": "editor",
        "tools": [definition],
        "result_timeout_ms": 60000,
    }
    script = [{"toolCalls": [{"name": "pick", "input": {"private": "argument"}}]}]
    options = dict(
        project=tmp_path,
        data_dir=tmp_path / "data",
        durability="durable",
        interface_tools=[src],
        providers=[scripted_provider(script)],
    )
    async with create_agent(**options) as agent:
        session = await agent.session()
        handoffs = []
        executor = agent.connect_interface_tools(
            actor_id="user", route_id="editor", on_handoff=handoffs.append
        )
        executor.advertise(session.id, [definition])
        await session.prompt("private input")
        executor.close()
        assert len(handoffs) == 1
        reports = []
        async with (
            create_agent(**options) as observer,
            clients(
                observer, tmp_path, resume_open={"report": lambda *row: reports.append(row)}
            ) as (client, auth),
        ):
            for i, count in [(0, 1), (1, 0), (4, 0)]:
                reply = await client.get("threads", headers=auth[i])
                assert listing(reply) == {
                    session.id: {"questions": 0, "toolCalls": count, "turn": "none"}
                }
                assert "private" not in reply.text and handoffs[0]["call_id"] not in reply.text
        assert reports == []


async def test_pages_are_ordered_scoped_and_expire_on_restart(tmp_path):
    entered, release = asyncio.Event(), asyncio.Event()

    @tool(read_only=True)
    async def pause() -> str:
        """Pause for the list."""
        entered.set()
        await release.wait()
        return "ok"

    kwargs = dict(
        project=tmp_path,
        data_dir=tmp_path / "data",
        durability="kept",
        providers=[scripted_provider([{"toolCalls": [{"name": "pause"}]}, {"text": "ok"}])],
        tools=[pause],
    )
    async with create_agent(**kwargs) as agent:
        async with clients(agent, tmp_path) as (client, auth):
            first, second = await new(client), await new(client)
            active = asyncio.create_task(client.post("run", json=prompt(first)))
            try:
                async with asyncio.timeout(5):
                    await entered.wait()
                assert listing(await client.get("threads")) == {
                    first: {"questions": 0, "toolCalls": 0, "turn": "running"}
                }
            finally:
                release.set()
                await active
            await client.post("run", json=prompt(second))
            page = (await client.get("threads", params={"limit": 1})).json()
            assert [r["threadId"] for r in page["threads"]] == [second]
            after = page["next"]
            final = (await client.get("threads", params={"after": after})).json()
            assert "next" not in final and [r["threadId"] for r in final["threads"]] == [first]
            for query in (
                "limit=0",
                "limit=501",
                "limit=-1",
                "limit=1.5",
                "after=bad",
                "limit=1&limit=2",
            ):
                bad = await client.get("threads?" + query)
                assert (bad.status_code, bad.json()) == (400, {"code": "invalid_request"})
            wrong_client = await client.get("threads", params={"after": after}, headers=auth[1])
            assert (wrong_client.status_code, wrong_client.json()) == (
                400,
                {"code": "invalid_request"},
            )
        async with clients(agent, tmp_path) as (client, _):
            expired = await client.get("threads", params={"after": after})
            assert (expired.status_code, expired.json()) == (400, {"code": "invalid_request"})
