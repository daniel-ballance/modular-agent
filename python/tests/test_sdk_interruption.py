"""Writer interruptions are live signals and not ordinary failed turns."""

import asyncio
import json
import secrets
from contextlib import aclosing

import pytest
from websockets.asyncio.client import connect

from modular_agent import (
    AgentError,
    ErrorCode,
    HistoryError,
    Plugin,
    create_agent,
    sqlite_history_port,
)
from modular_agent.testing import memory_environment, scripted_provider


class FaultStore:
    """A store that, once active, refuses appends (commitFailed) or reports its writer lost.

    Writer loss is reported through wait_writer_lost, as soon as the fault is switched on,
    so the test does not depend on a renewal tick: a lease short enough to renew quickly
    is also short enough to lapse for a healthy writer on a busy machine.
    """

    def __init__(self, backend, reason):
        self.backend = backend
        self.reason = reason
        self._lost = asyncio.Event()
        self._active = False

    def __getattr__(self, name):
        return getattr(self.backend, name)

    @property
    def active(self):
        return self._active

    @active.setter
    def active(self, value):
        self._active = value
        if value and self.reason == "writerLost":
            self._lost.set()
        elif not value:
            self._lost = asyncio.Event()

    async def wait_writer_lost(self, session_id, lease):
        lost = self._lost
        await lost.wait()
        await self.backend.release(session_id, lease)

    async def append(self, session_id, lease, entries):
        if self.active and self.reason == "commitFailed":
            raise HistoryError("unavailable", "Storage write refused")
        return await self.backend.append(session_id, lease, entries)


async def test_idle_session_is_interrupted_when_custom_store_reports_revocation(tmp_path):
    watching, revoked = asyncio.Event(), asyncio.Event()
    lease = None
    renewed = []

    class RevocableStore:
        def __getattr__(self, name):
            return getattr(backend, name)

        async def wait_writer_lost(self, session_id, writer_lease):
            nonlocal lease
            lease = session_id, writer_lease
            watching.set()
            await revoked.wait()

        async def renew(self, session_id, writer_lease):
            renewed.append(session_id)
            return await backend.renew(session_id, writer_lease)

    # A long TTL separates an explicit notice from periodic renewal.
    with sqlite_history_port(tmp_path, ttl_ms=60_000) as backend:
        plugin = Plugin("revocable-store", setup=lambda r: r.history_store(RevocableStore()))
        async with create_agent(
            project=tmp_path, durability="kept", plugins=[plugin], environment=memory_environment()
        ) as agent:
            session = await agent.session()
            async with aclosing(session.events()) as events, asyncio.timeout(5):
                assert (await anext(events)).type == "entry"
                await watching.wait()
                assert lease is not None and lease[0] == session.id
                await backend.release(*lease)
                revoked.set()
                interruptions = [event async for event in events if event.type != "entry"]
                assert [event.type for event in interruptions] == ["sessionInterrupted"]
                assert interruptions[0].data.fields == {"reason": "writerLost"}
                assert not renewed


@pytest.mark.parametrize("reason", ["commitFailed", "writerLost"])
@pytest.mark.parametrize("placement", ["prompt", "stream", "acp"])
@pytest.mark.loopback
async def test_waiter_loses_writer_and_follower_can_reopen(tmp_path, reason, placement):
    entered, cancelled = asyncio.Event(), asyncio.Event()
    provider = scripted_provider([{"text": "recovered"}])

    class Provider:
        id, supports, models = provider.id, provider.supports, staticmethod(provider.models)

        async def request(self, model, request, context):
            if not entered.is_set():
                entered.set()
                try:
                    await asyncio.Future()
                finally:
                    cancelled.set()
            return await provider.request(model, request, context)

    with sqlite_history_port(tmp_path, ttl_ms=60_000) as backend:
        await _exercise(tmp_path, reason, placement, backend, Provider(), entered, cancelled)


async def _exercise(tmp_path, reason, placement, backend, provider, entered, cancelled):
    async with asyncio.timeout(10):
        store = FaultStore(backend, reason)
        plugin = Plugin("fault-store", setup=lambda r: r.history_store(store))
        async with create_agent(
            project=tmp_path,
            durability="kept",
            plugins=[plugin],
            providers=[provider],
            environment=memory_environment(),
        ) as agent:
            if placement == "acp":
                token = secrets.token_hex(32)
                path = tmp_path / "token"
                path.touch(mode=0o600)
                path.write_text(token)
                listener = await agent.serve_acp(
                    listen="127.0.0.1:0",
                    actors=[
                        {
                            "token_file": path,
                            "actor": {"id": "user", "kind": "user", "rights": ["watch", "input"]},
                        }
                    ],
                )
                async with connect(
                    listener.url,
                    subprotocols=["modular-agent-acp-1"],
                    additional_headers={"Authorization": f"Bearer {token}"},
                ) as ws:

                    async def send(key, method, params):
                        await ws.send(
                            json.dumps(
                                {"jsonrpc": "2.0", "id": key, "method": method, "params": params}
                            )
                        )

                    async def reply(key):
                        while (frame := json.loads(await ws.recv())).get("id") != key:
                            pass
                        return frame

                    await send(1, "initialize", {"protocolVersion": 1})
                    assert "result" in await reply(1)
                    options = {"cwd": str(tmp_path), "mcpServers": []}
                    await send(2, "session/new", options)
                    sid = (await reply(2))["result"]["sessionId"]
                    await send(
                        3,
                        "session/prompt",
                        {"sessionId": sid, "prompt": [{"type": "text", "text": "wait"}]},
                    )
                    await entered.wait()
                    store.active = True
                    if reason == "commitFailed":
                        await send(
                            4,
                            "_modular-agent/submit",
                            {
                                "sessionId": sid,
                                "content": [{"type": "text", "text": "second"}],
                                "when": "after",
                            },
                        )
                    observed = set()
                    while observed != {"event", "lost"}:
                        frame = json.loads(await ws.recv())
                        if frame.get("method") == "_modular-agent/interrupted":
                            assert frame["params"] == {"sessionId": sid, "reason": reason}
                            observed.add("event")
                        if frame.get("id") == 3:
                            assert frame["error"]["data"]["code"] == "lost"
                            observed.add("lost")
                    await cancelled.wait()
                    store.active = False
                    await send(5, "session/resume", {**options, "sessionId": sid})
                    assert "result" in await reply(5)
                    await send(
                        6,
                        "session/prompt",
                        {"sessionId": sid, "prompt": [{"type": "text", "text": "again"}]},
                    )
                    assert (await reply(6))["result"]["stopReason"] == "end_turn"
                return

            session = await agent.session()
            events = session.events()
            assert (await anext(events)).type == "entry"

            async def waiter():
                if placement == "prompt":
                    await session.prompt("wait")
                else:
                    async for _ in session.prompt_stream("wait"):
                        pass

            task = asyncio.create_task(waiter())
            try:
                await entered.wait()
                store.active = True
                if reason == "commitFailed":
                    with pytest.raises(AgentError) as failure:
                        await session.send("second", "after")
                    assert failure.value.code is ErrorCode.LOST
                event = next(
                    iter([event async for event in events if event.type == "sessionInterrupted"])
                )
                assert event.data.fields == {"reason": reason}
                with pytest.raises(AgentError) as failure:
                    await task
                assert failure.value.code is ErrorCode.LOST
                await cancelled.wait()
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                await events.aclose()
            store.active = False
            reopened = await agent.open_session(session.id)
            assert (await reopened.prompt("again")).text == "recovered"
            assert all(e.get("kind") != "sessionInterrupted" for e in await reopened.history())
