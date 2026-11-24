"""A real HTTP client talking to the public Python SDK."""

import asyncio
from contextlib import asynccontextmanager
import json
from pathlib import Path
from secrets import token_urlsafe

from httpx2 import AsyncClient
import pytest

from modular_agent import AgentError, ErrorCode, Plugin, create_agent, tool
from modular_agent.testing import scripted_provider

pytestmark = pytest.mark.loopback


def principal(folder, client="editor", actor="alice", rights=("input", "watch", "tools")):
    token = token_urlsafe()
    path = folder / token_urlsafe()
    path.touch(mode=0o600)
    path.write_text(token)
    return {
        "actor": {"id": actor, "kind": "user", "rights": list(rights)},
        "client_id": client,
        "token_file": path,
    }, token


@asynccontextmanager
async def service(tmp_path, *, script=({"text": "Hello."},), server=None, **options):
    a, token = principal(tmp_path)
    async with create_agent(
        project=tmp_path, providers=[scripted_provider(script)], **options
    ) as agent:
        listener = await agent.serve_agui(listen="127.0.0.1:0", actors=[a], **(server or {}))
        async with AsyncClient(
            base_url=listener.url + "/agui/v1/",
            headers={"Authorization": "Bearer " + token},
            trust_env=False,
        ) as client:
            yield agent, client
        await listener.close()


async def new(client):
    response = await client.post("threads", json={})
    assert response.status_code == 201
    return response.json()["threadId"]


def prompt(sid, content="Hi.", **kwargs):
    return {
        "threadId": sid,
        "runId": "one",
        "protocolVersion": "1.0",
        "messages": [{"role": "user", "id": "tmp", "content": content}],
        **kwargs,
    }


def events(response):
    assert response.status_code == 200
    return [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]


async def test_authenticated_run_and_reconnect(tmp_path: Path):
    async with service(tmp_path) as (_, client):
        sid = await new(client)
        assert events(await client.post("run", json=prompt(sid)))[-1]["type"] == "RUN_FINISHED"
        assert [m["content"] for m in (await client.get("threads/" + sid)).json()["messages"]] == [
            "Hi.",
            "Hello.",
        ]


@pytest.mark.parametrize("durability", ["durable", "ephemeral"])
async def test_thread_listing_only_returns_committed_kept_sessions(tmp_path, durability):
    async with service(tmp_path, data_dir=tmp_path / "store", durability=durability) as (_, client):
        sid = await new(client)
        assert (await client.get("threads")).json() == {"threads": []}
        assert events(await client.post("run", json=prompt(sid)))[-1]["type"] == "RUN_FINISHED"
        reply = await client.get("threads")
        assert reply.status_code == 200
        rows = reply.json()["threads"]
        if durability == "ephemeral":
            assert rows == []
        else:
            from datetime import datetime

            assert datetime.fromisoformat(rows[0]["updatedAt"]).tzinfo is not None
            assert rows == [
                {
                    "threadId": sid,
                    "updatedAt": rows[0]["updatedAt"],
                    "waiting": {"questions": 0, "toolCalls": 0, "turn": "none"},
                }
            ]


async def test_approval_setting_requires_current_session_and_connection_rights(tmp_path):
    writer, token = principal(tmp_path, rights=("input", "watch", "settings", "tools"))
    reader, limited = principal(tmp_path, client="inbox", rights=("input", "watch"))
    script = [{"toolCalls": [{"name": "effect", "input": {}}]}, {"text": "done"}]

    @tool
    async def effect() -> str:
        """A tool the new policy should refuse."""
        return "ran the effect"

    async with create_agent(
        project=tmp_path,
        providers=[scripted_provider(script)],
        tools=[effect],
        approval="off",
        approval_covers_nested=True,
    ) as agent:
        listener = await agent.serve_agui(listen="127.0.0.1:0", actors=[writer, reader])
        async with AsyncClient(
            base_url=listener.url + "/agui/v1/",
            headers={"Authorization": "Bearer " + token},
            trust_env=False,
        ) as client:
            sid = await new(client)
            path = f"threads/{sid}/settings"
            response = await client.post(path, json={"approval": "never"})
            assert response.status_code == 200 and response.json() == {"approval": "never"}
            assert (
                await client.post(path, json={"approval": "off", "extra": True})
            ).status_code == 400
            assert (
                await client.post(
                    path, json={"approval": "off"}, headers={"Authorization": "Bearer " + limited}
                )
            ).status_code == 403
            await client.post("run", json=prompt(sid))
            messages = (await client.get("threads/" + sid)).json()["messages"]
            [result] = [m for m in messages if m["role"] == "tool"]
            assert result["error"] and "ran the effect" not in result["content"]
        await listener.close()


async def test_waiting_approval_on_returning_presence(tmp_path):
    effects = []

    @tool
    async def bump(amount: int) -> str:
        """Count once."""
        effects.append(amount)
        return "done"

    a, token = principal(tmp_path, rights=("input", "watch", "tools", "approve"))
    async with create_agent(
        project=tmp_path,
        data_dir=tmp_path / "store",
        durability="kept",
        providers=[
            scripted_provider(
                [{"toolCalls": [{"name": "bump", "input": {"amount": 1}}]}, {"text": "done"}]
            )
        ],
        tools=[bump],
        approval="all",
        approval_covers_nested=True,
        late_answers_start_turns=True,
        max_approval_wait=60.0,
        settings={"approvalWait": "untilDeadline"},
    ) as agent:
        listener = await agent.serve_agui(listen="127.0.0.1:0", actors=[a])
        async with AsyncClient(
            base_url=listener.url + "/agui/v1/",
            headers={"Authorization": "Bearer " + token},
            trust_env=False,
        ) as client:
            sid = await new(client)
            first = events(await client.post("run", json=prompt(sid)))
            assert first[-1]["outcome"] == {"type": "success"}
            assert not any(e["type"].startswith("TOOL_CALL") for e in first)
            [listing] = (await client.get("threads")).json()["threads"]
            assert listing["waiting"] == {"questions": 1, "toolCalls": 0, "turn": "none"}
            path = "threads/" + sid
            assert (await client.get(path)).json()["waiting"] == {"questions": [], "toolCalls": []}
            async with client.stream("GET", path + "/presence") as stream:
                assert stream.status_code == 200
                snapshot = (await client.get(path)).json()
                [q] = snapshot["waiting"]["questions"]
                assert q["reason"] == "approval" and q["toolCallId"] and q["expiresAt"]
                assert snapshot["declaration"]["approvalCoversNested"] is True
                assert q["metadata"]["modular-agent.coversNested"] is True
                assert q["metadata"]["modular-agent.approvalCall"] == {
                    "name": "bump",
                    "input": {"amount": 1},
                }
                assert "covers the nested calls" in q["message"]
                assert "bump" in q["message"] and "amount" in q["message"]
                assert not effects
                reply = await client.post(
                    "run",
                    json=prompt(
                        sid,
                        runId="answer",
                        messages=snapshot["messages"],
                        resume=[
                            {
                                "interruptId": q["id"],
                                "status": "resolved",
                                "payload": {"allow": True},
                            }
                        ],
                    ),
                )
                assert events(reply)[-1]["outcome"] == {"type": "success"}
                assert effects == [1]
        await listener.close()


async def test_wait_closures_replay_then_follow_without_presence(tmp_path):
    async with service(tmp_path) as (agent, client):
        sid = await new(client)
        path = f"threads/{sid}"
        snapshot = (await client.get(path)).json()
        feed = path + "/wait-closures"
        assert (await client.get(feed)).status_code == 400
        assert (await client.get(feed, params={"after": snapshot["cursor"]})).status_code == 409
        await client.post("run", json=prompt(sid))

        # Ask without an answer route: each question is closed by the writer.
        async def question():
            answer = await agent._h.call(
                "@harness",
                "questions",
                "ask",
                {
                    "session": sid,
                    "actor": "alice",
                    "kind": "approval",
                    "question": "Private prompt",
                },
            )
            return answer["request"]

        first = await question()
        async with client.stream("GET", feed, params={"after": snapshot["waitCursor"]}) as stream:
            assert stream.status_code == 200
            assert await agent._call("questions", "present", session=sid) == []
            lines = (
                json.loads(line[6:])
                async for line in stream.aiter_lines()
                if line.startswith("data: ")
            )
            a = await anext(lines)
            assert a == {"cursor": a["cursor"], "reason": "refused", "requestId": first}
            second = await question()
            b = await anext(lines)
            assert b == {"cursor": b["cursor"], "reason": "refused", "requestId": second}
        async with client.stream("GET", feed, params={"after": a["cursor"]}) as stream:
            replay = (
                json.loads(line[6:])
                async for line in stream.aiter_lines()
                if line.startswith("data: ")
            )
            assert (await anext(replay))["requestId"] == second


@pytest.mark.parametrize(
    "boundary,terminal", [("before-marker", "unknown"), ("after-marker", "success")]
)
async def test_crash_after_terminal_release(tmp_path, boundary, terminal):
    import sys

    token = token_urlsafe()
    path = tmp_path / "test-token"
    path.touch(mode=0o600)
    path.write_text(token)

    @asynccontextmanager
    async def process(phase):
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            str(Path(__file__).with_name("receipt_crash_service.py")),
            str(tmp_path),
            phase,
            stdout=asyncio.subprocess.PIPE,
        )
        try:
            origin = (await proc.stdout.readline()).decode().strip()
            assert origin.startswith("http://")
            async with AsyncClient(
                base_url=origin + "/agui/v1/",
                trust_env=False,
                headers={"Authorization": "Bearer " + token},
            ) as client:
                yield proc, client
        finally:
            proc.kill()
            await proc.wait()

    async with process(boundary) as (proc, client):
        sid = await new(client)
        post = asyncio.create_task(client.post("run", json=prompt(sid)))
        try:
            assert await proc.stdout.readline() == b"released\n"
        finally:
            post.cancel()
            await asyncio.gather(post, return_exceptions=True)
    async with process("read") as (_, client):
        # No opening snapshot, writer acquisition or recovery on this read.
        response = await client.get(f"threads/{sid}/run-receipt", params={"runId": "one"})
        assert response.json() == {"terminal": terminal, "work": "completed"}


async def test_preflight_does_not_need_identity_or_admit_work(tmp_path):
    origin = "https://allowed.invalid"
    async with service(tmp_path, server={"origins": [origin]}) as (agent, client):
        anonymous = {"Origin": origin, "Authorization": ""}
        reply = await client.options("threads", headers=anonymous)
        assert reply.status_code == 204 and reply.content == b""
        assert reply.headers["access-control-allow-origin"] == origin
        assert (await client.post("threads", json={}, headers=anonymous)).status_code == 401
        assert (
            await client.post("threads", json={}, headers={"Origin": "https://other.invalid"})
        ).status_code == 403
        assert await agent.sessions() == []


async def test_ambiguous_executor_or_token_rotation_is_rejected(tmp_path):
    a, _ = principal(tmp_path)
    b, _ = principal(tmp_path, actor="bob")
    async with create_agent(project=tmp_path) as agent:
        with pytest.raises(AgentError) as exc:
            await agent.serve_agui(listen="127.0.0.1:0", actors=[a, b])
        assert exc.value.code == ErrorCode.INVALID_COMPOSITION


async def test_each_queued_inputs_tool_offer_is_its_own(tmp_path):
    paused, resume = asyncio.Event(), asyncio.Event()
    offers = []

    async def first(_):
        if not paused.is_set():
            paused.set()
            await resume.wait()

    async def observe(payload):
        offers.append([d["name"] for d in payload["request"].get("tools", [])])

    a, token = principal(tmp_path, client="one")
    b, other = principal(tmp_path, client="two")
    offer = {"name": "pick", "description": "Pick", "parameters": {}}
    src = {
        "source_id": "browser",
        "actor_id": "alice",
        "route_id": "two",
        "result_timeout_ms": 60000,
        "tools": [{**offer, "callers": ["model"]}],
    }
    async with create_agent(
        project=tmp_path,
        providers=[scripted_provider([{"text": "First"}, {"text": "Second"}])],
        interface_tools=[src],
        plugins=[Plugin("observe", hooks={"turn.before": first, "provider.request": observe})],
    ) as agent:
        handle = await agent.serve_agui(listen="127.0.0.1:0", actors=[a, b])
        async with AsyncClient(
            base_url=handle.url + "/agui/v1/",
            headers={"Authorization": "Bearer " + token},
            trust_env=False,
        ) as client:
            sid = await new(client)
            first_run = asyncio.create_task(client.post("run", json=prompt(sid)))
            try:
                await paused.wait()
                async with client.stream(
                    "POST",
                    "run",
                    headers={"Authorization": "Bearer " + other},
                    json=prompt(sid, runId="two", tools=[offer]),
                ) as queued:
                    assert queued.status_code == 200
                    resume.set()
                    await queued.aread()
                    assert events(queued)[-1]["type"] == "RUN_FINISHED"
            finally:
                resume.set()
                assert events(await first_run)[-1]["type"] == "RUN_FINISHED"
        assert [("pick" in names) for names in offers] == [False, True]


async def test_input_parts_keep_order_but_never_resolve_a_url(tmp_path):
    image = {"type": "image", "source": {"type": "data", "value": "YWJj", "mimeType": "image/png"}}
    text = {"type": "text", "text": "Picture"}
    url = {
        "type": "image",
        "source": {"type": "url", "value": "https://not-a-resource.invalid/image"},
    }
    async with service(tmp_path) as (_, client):
        sid = await new(client)
        invalid = prompt(
            sid, [text, {**image, "source": {**image["source"], "value": "not base64"}}]
        )
        assert (await client.post("run", json=invalid)).status_code == 400
        run = events(await client.post("run", json=prompt(sid, [text, url, image, text])))
        assert run[-3]["messages"][0]["content"] == [text, image, text]
        assert "not-a-resource" not in str(run)


async def test_server_tool_group_and_snapshot_obey_result_gate(tmp_path):
    @tool
    async def read_note(note: str) -> str:
        """Read the note."""
        return "private result"

    async def gate(payload):
        if any(event["type"] == "toolResult" for event in payload["events"]):
            return {"block": True}

    script = [
        {"toolCalls": [{"name": "read_note", "input": {"note": "private argument"}}]},
        {"text": "Done."},
    ]
    async with service(
        tmp_path, script=script, tools=[read_note], plugins=[Plugin("gate", hooks={"output": gate})]
    ) as (_, client):
        sid = await new(client)
        run = events(await client.post("run", json=prompt(sid)))
        assert run[-1]["type"] == "RUN_FINISHED"
        assert not any(e["type"].startswith("TOOL_CALL_") for e in run)
        view = (await client.get("threads/" + sid)).json()
        for secret in ["private argument", "private result"]:
            assert secret not in str(run)
            assert secret not in str(view)


async def test_state_starts_from_plugin_not_client_copy(tmp_path):
    reads = []

    async def current(sid):
        reads.append(sid)
        return {"revisionId": "fresh", "snapshot": {"label": "current"}}

    async def change(_, ctx):
        await ctx.emit(
            "modular-agent.agui.stateDelta",
            {
                "baseRevisionId": "fresh",
                "revisionId": "next",
                "delta": [{"op": "replace", "path": "/label", "value": "next"}],
            },
        )

    async with service(
        tmp_path,
        plugins=[Plugin("doc", hooks={"step.before": change})],
        server={"state_plugin": "doc", "state_snapshot": current},
    ) as (_, client):
        sid = await new(client)
        run = events(await client.post("run", json=prompt(sid, state={"label": "untrusted"})))
        assert reads == [sid]
        assert run[1] == {"type": "STATE_SNAPSHOT", "snapshot": {"label": "current"}}
        assert any(e["type"] == "STATE_DELTA" for e in run)
        assert "untrusted" not in str(run)


async def test_detach_does_not_cancel_an_admitted_turn(tmp_path):
    started, proceed, ended = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def pause(_):
        started.set()
        await proceed.wait()

    async def settled(_):
        ended.set()

    async with service(
        tmp_path, plugins=[Plugin("pause", hooks={"step.before": pause, "turn.end": settled})]
    ) as (_, client):
        sid = await new(client)
        async with client.stream("POST", "run", json=prompt(sid)) as response:
            assert response.status_code == 200
            await started.wait()
        proceed.set()
        # The writer continues without an HTTP connection. Ask the record,
        # not a delay, when the work is complete.
        await ended.wait()
        view = (await client.get("threads/" + sid)).json()
        assert view["messages"][-1]["content"] == "Hello."
