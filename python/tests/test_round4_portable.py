"""Round-four checks at the history service and session boundaries, without sockets."""

import asyncio
import time

import pytest
from acp_fixture import Client
from ma_acp import ACP
from ma_core import AgentError, content
from ma_fake import Fake, reply
from ma_history.http import HTTPHistory, ServiceError

from modular_agent import build


async def test_lease_waits_and_never_reacquires_after_loss(tmp_path, monkeypatch):
    client = HTTPHistory("https://example.invalid", tmp_path / "token")
    client.ttl = 300
    calls = []

    async def exchange(method, path, body=None):
        calls.append((method, path, body, time.monotonic()))
        if path.endswith("/renew"):
            raise ServiceError(409, {"code": "lost"})
        if len(calls) == 1:
            raise ServiceError(409, {"code": "held", "retryAfterMs": 15})
        return {"lease": "first", "ttlMs": 30}

    monkeypatch.setattr(client, "request", exchange)
    try:
        assert await client.acquire("remote") == "first"
        assert calls[1][3] - calls[0][3] >= 0.014
        assert calls[0][2] == calls[1][2] == {"owner": client.owner}
        async with asyncio.timeout(1):
            while not client.leases["remote"]["lost"]:
                await asyncio.sleep(0.001)
        with pytest.raises(AgentError, match="lease was lost"):
            await client.acquire("remote")
        assert len(calls) == 3
    finally:
        await client.stop()
    assert calls[-1][:2] == ("DELETE", "/v1/sessions/remote/lease/first")


async def test_acp_joins_foreign_session_before_replay(tmp_path, monkeypatch):
    sid = "foreign-session"
    meta = {"id": sid, "project": str(tmp_path), "created": 0}
    foreign = {"id": "other-host", "kind": "host", "rights": ["watch", "input", "future"]}
    records = [
        {
            "id": "join-other",
            "parentId": None,
            "sessionId": sid,
            "kind": "actorJoined",
            "time": 0,
            "writer": "swap.fixture",
            "modelVisible": False,
            "data": {"actor": foreign},
        },
        {
            "id": "old-input",
            "parentId": "join-other",
            "sessionId": sid,
            "kind": "input",
            "time": 1,
            "writer": "swap.fixture",
            "modelVisible": True,
            "actorId": foreign["id"],
            "message": {"role": "user", "content": content("foreign message")},
            "data": {"inputId": "old-receipt"},
        },
    ]

    async def exchange(self, method, path, body=None):
        if path == "/v1":
            return {"binding": "modular-agent-history/1", "ttlMs": 60000}
        if method == "GET" and "?" in path:
            return {"sessions": [meta]}
        if method == "GET":
            return {"session": meta, "entries": records}
        if path.endswith("/lease"):
            return {"lease": "held", "ttlMs": 60000}
        if path.endswith("/entries"):
            assert body["lease"] == "held"
            records.extend(body["entries"])
            return {"kept": len(body["entries"])}
        assert method == "DELETE"
        return {}

    token = tmp_path / "token"
    token.write_text("offline-placeholder")
    (tmp_path / "state").mkdir()
    (tmp_path / "state/settings.json").write_text('{"model":"fake"}')
    monkeypatch.setattr(HTTPHistory, "request", exchange)
    monkeypatch.setenv("MODULAR_AGENT_HISTORY_URL", "http://example.invalid")
    monkeypatch.setenv("MODULAR_AGENT_HISTORY_TOKEN_FILE", str(token))
    monkeypatch.setenv("MODULAR_AGENT_HISTORY_URL", "https://example.invalid")
    for replay in (True, False):
        h = await build(tmp_path / "state", Fake([reply("new answer")]), project=tmp_path)
        try:
            interface = ACP(tmp_path)
            await h.load(interface, process=False)
            client = Client()
            interface.on_connect(client)
            init = await interface.initialize(protocol_version=1)
            actor = init.field_meta["modular-agent"]["actor"]
            open_session = interface.load_session if replay else interface.resume_session
            await open_session(cwd=str(tmp_path), session_id=sid)
            assert [u.session_update for _, u in client.updates] == (
                ["user_message_chunk"] if replay else []
            )
            joins = [e["data"]["actor"] for e in records if e["kind"] == "actorJoined"]
            assert joins == [foreign, {**actor, "rights": sorted(h.admin & h.tenant)}]
            history = await interface.bound_extension("history", {"sessionId": sid, "all": True})
            assert [
                (e["id"], e["data"]["actor"])
                for e in history["entries"]
                if e["kind"] == "actorJoined"
            ] == [(e["id"], e["data"]["actor"]) for e in records if e["kind"] == "actorJoined"]
            assert next(
                e for e in records if e["kind"] == "actorJoined" and e["id"] != "join-other"
            )["parentId"] in {"old-input", records[2]["id"]}
            assert records[1]["actorId"] == foreign["id"]
            assert await h.api().session("authority", session=sid, actor=foreign["id"]) == [
                "input",
                "watch",
            ]
        finally:
            await h.stop()


async def test_recover_foreign_standard_record(tmp_path, monkeypatch):
    sid, turn, step = "foreign-session", "turn-1", "step-1"
    records = []

    def entry(kind, data, **fields):
        e = {
            "id": f"e-{len(records)}",
            "parentId": records[-1]["id"] if records else None,
            "sessionId": sid,
            "kind": kind,
            "time": len(records),
            "writer": "swap.fixture",
            "modelVisible": "message" in fields,
            "data": data,
            **fields,
        }
        records.append(e)
        return e

    model = {"provider": "fake", "id": "fake"}
    entry("setting", {"key": "settings", "value": {"model": model, "reasoning": "off"}})
    entry(
        "inputAccepted",
        {"content": content("foreign question"), "key": "once", "when": "now"},
        inputId="receipt",
        actorId="user",
    )
    start = entry(
        "turnStart",
        {
            "startedBy": {"kind": "actor", "id": "user"},
            "model": model,
            "system": "recorded system",
            "tools": [],
            "settings": {"maxSteps": 2},
        },
        turnId=turn,
    )
    entry(
        "input",
        {"inputId": "receipt", "key": "once"},
        turnId=turn,
        actorId="user",
        message={"role": "user", "content": content("foreign question")},
    )
    call = {
        "id": "unsafe",
        "name": "bash",
        "input": {"command": "touch repeated"},
        "startedBy": "model",
    }
    intent = entry(
        "modelRequest",
        {"model": model, "safeToRepeat": False, "tools": ["bash"], "tracksStepAfter": True},
        turnId=turn,
        stepId=step,
    )
    entry(
        "response",
        {},
        sources=[intent["id"]],
        turnId=turn,
        stepId=step,
        message={
            "role": "assistant",
            "stop": "toolUse",
            "content": [
                {"type": "toolCall", "id": "unsafe", "name": "bash", "arguments": call["input"]},
            ],
        },
    )
    entry(
        "toolStarted",
        {"call": call, "safeToRepeat": False},
        turnId=turn,
        stepId=step,
        toolCallId="unsafe",
    )

    async def exchange(self, method, path, body=None):
        if path == "/v1":
            return {"binding": "modular-agent-history/1", "ttlMs": 60000}
        if method == "GET":
            return {
                "session": {"id": sid, "project": str(tmp_path), "created": 0},
                "entries": records,
            }
        if path.endswith("/lease"):
            return {"lease": "held", "ttlMs": 60000}
        if path.endswith("/entries"):
            assert body["lease"] == "held"
            records.extend(body["entries"])
            return {"kept": len(body["entries"])}
        assert method == "DELETE"
        return {}

    token = tmp_path / "token"
    token.write_text("offline-placeholder")
    monkeypatch.setattr(HTTPHistory, "request", exchange)
    monkeypatch.setenv("MODULAR_AGENT_HISTORY_URL", "https://example.invalid")
    monkeypatch.setenv("MODULAR_AGENT_HISTORY_TOKEN_FILE", str(token))
    from ma_durable import Durable

    provider = Fake([reply("continued")])
    h = await build(
        tmp_path / "state", provider, project=tmp_path, runtime=Durable(), process_plugins=""
    )
    try:
        a = h.api()
        await a.session("open", session=sid)
        await a.call("runtime", "wait", {"session": sid})
        results = [e for e in records if e["kind"] == "toolResult"]
        assert len(results) == 1 and results[0]["data"]["status"] == "outcomeUnknown"
        assert not (tmp_path / "repeated").exists()
        assert records[-1]["data"]["outcome"] == {"kind": "completed"}
        assert [e for e in records if e["kind"] == "turnStart"] == [start]
        receipt = await a.call(
            "runtime", "submit", {"session": sid, "key": "once", "content": content("ignored")}
        )
        assert receipt == {"input": "receipt", "when": "now", "duplicate": True}
        assert len(provider.requests) == 1
        assert provider.requests[0]["system"] == "recorded system"
    finally:
        await h.stop()
