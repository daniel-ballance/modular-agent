"""Public session lifecycle against each persistent history selection."""

import asyncio
import json
import secrets
import sys
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest
from websockets.asyncio.client import connect

from modular_agent import (
    AgentError,
    HistoryError,
    Plugin,
    create_agent,
    file_history,
    http_history,
    sqlite_history_port,
)
from modular_agent.testing import memory_environment, scripted_provider


class RecordingStore:
    def __init__(self, port, journal):
        self.port = port
        self.journal = journal

    def __getattr__(self, name):
        return getattr(self.port, name)

    def record(self, *row):
        with self.journal.open("a") as stream:
            stream.write(json.dumps(row) + "\n")

    async def create(self, sid, metadata):
        self.record(sid, "create", metadata)
        return await self.port.create(sid, metadata)

    async def acquire(self, sid, owner):
        self.record(sid, "acquire", owner)
        return await self.port.acquire(sid, owner)

    async def append(self, sid, lease, entries):
        self.record(sid, "append", entries)
        return await self.port.append(sid, lease, entries)


@contextmanager
def composition(root, store, placement, url):
    runtime = (
        [
            {
                "command": [str(Path(sys.executable).with_name("modular-agent-plugin"))],
                "env": {"MODULAR_AGENT_PLUGIN_PARTS": "runtime"},
            }
        ]
        if placement == "served"
        else None
    )
    options = dict(
        project=root,
        data_dir=root / "data",
        process_plugins=runtime,
        durability="kept",
        several_actors=True,
        tenants={"demo": {"rights": ["watch", "input", "settings", "grant"]}},
        environment=memory_environment(),
        providers=[scripted_provider([{"text": "done"}])],
    )
    if store == "custom":
        with sqlite_history_port(root / "store", ttl_ms=60_000) as port:
            wrapped = RecordingStore(port, root / "writes.jsonl")
            plugin = Plugin("test-store", setup=lambda r: r.history_store(wrapped))
            yield create_agent(**options, plugins=[plugin]), port
    else:
        selection = (
            file_history(root / "store") if store == "file" else http_history(url, root / "token")
        )
        yield create_agent(**options, history=selection), None


@asynccontextmanager
async def worker(*args):
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        __file__,
        *map(str, args),
        stdout=asyncio.subprocess.PIPE,
    )
    try:
        async with asyncio.timeout(10):
            ready = (await proc.stdout.readline()).decode().strip()
            assert ready, f"{args[0]} exited before announcing readiness"
        yield ready
    finally:
        if proc.returncode is None:
            proc.kill()
        await proc.wait()


@asynccontextmanager
async def history_service(root, store):
    if store != "http":
        yield ""
        return
    (root / "token").touch(mode=0o600)
    (root / "token").write_text(secrets.token_hex(32))
    async with worker("service", root) as url:
        yield url


def mutations(root, sid):
    journal = root / "writes.jsonl"
    return [
        (op, data)
        for ref, op, data in map(
            json.loads, journal.read_text().splitlines() if journal.exists() else []
        )
        if ref == sid
    ]


async def assert_unpublished(root, store, url, port, sid, agent):
    assert sid not in {item["id"] for item in await agent.sessions()}
    with pytest.raises(AgentError) as info:
        await agent.session_info(sid)
    assert info.value.code == "not_found"
    if store == "file":
        assert not list((root / "store").iterdir())
    else:
        assert not mutations(root, sid)
        if port is not None:
            with pytest.raises(HistoryError) as error:
                await port.read(sid, after=None, limit=1)
            assert error.value.history_code == "unknown_session"
        else:

            def read():
                request = Request(
                    f"{url}/v1/sessions/{sid}",
                    headers={"Authorization": f"Bearer {(root / 'token').read_text()}"},
                )
                with pytest.raises(HTTPError) as error:
                    urlopen(request, timeout=5)
                assert error.value.code == 404
                assert json.load(error.value)["code"] == "unknown_session"

            await asyncio.to_thread(read)


@pytest.mark.loopback
@pytest.mark.parametrize("store", ["file", "http", "custom"])
@pytest.mark.parametrize("placement", ["native", "served"])
async def test_sdk_materializes_only_at_first_admission(tmp_path, store, placement):
    async with history_service(tmp_path, store) as url:
        # Restart the custom backend to inspect the crash; use a fresh store for
        # the live path so it does not wait on the backend's restart hold.
        crash_root = tmp_path / "crash" if store == "custom" else tmp_path
        crash_root.mkdir(exist_ok=True)
        async with worker("session", crash_root, store, placement, url) as crashed:
            assert not mutations(crash_root, crashed)
        with composition(crash_root, store, placement, url) as (start, port):
            async with start as agent:
                await assert_unpublished(crash_root, store, url, port, crashed, agent)
                with pytest.raises(AgentError) as missing:
                    await agent.open_session(crashed)
                assert missing.value.code == "not_found"

        with composition(tmp_path, store, placement, url) as (start, port):
            async with start as agent:
                unused = await agent.session(
                    actors=[{"id": "guest", "kind": "user", "rights": ["watch"]}]
                )
                await unused.set_setting("maxSteps", 2)
                await assert_unpublished(tmp_path, store, url, port, unused.id, agent)
                await unused.close()
                await assert_unpublished(tmp_path, store, url, port, unused.id, agent)

                session = await agent.session(
                    tenant="demo",
                    actors=[{"id": "guest", "kind": "user", "rights": ["watch"]}],
                )
                await session.set_setting("maxSteps", 3)
                with pytest.raises(AgentError) as refused:
                    await session.as_actor("guest").send("refuse this", "now")
                assert refused.value.code == "forbidden"
                await assert_unpublished(tmp_path, store, url, port, session.id, agent)
                setup = await session.history()
                assert [e["kind"] for e in setup] == [
                    "tenant",
                    "setting",
                    "actorJoined",
                    "plugins",
                    "actorJoined",
                    "setting",
                ]
                assert (await session.prompt("keep this")).text == "done"
                entries = await session.history()
                assert entries[: len(setup)] == setup
                accepted = entries[len(setup)]
                assert accepted["kind"] == "inputAccepted"
                assert accepted["parentId"] == setup[-1]["id"]
                assert entries[len(setup) + 1]["kind"] == "turnStart"
                if store != "file":
                    initial = mutations(tmp_path, session.id)
                    assert [op for op, _ in initial[:3]] == ["create", "acquire", "append"]
                    assert initial[2][1] == [*setup, accepted]

                fork = await session.fork()
                copied = await fork.history()
                assert [e["sources"] for e in copied[: len(entries)]] == [
                    [e["id"]] for e in entries
                ]
                assert [e["kind"] for e in copied[len(entries) :]] == [
                    "tenant",
                    "setting",
                    "actorJoined",
                    "actorJoined",
                    "plugins",
                ]
                if store != "file":
                    writes = mutations(tmp_path, fork.id)
                    assert [op for op, _ in writes] == ["create", "acquire", "append"]
                    assert writes[2][1] == copied
                await fork.close()
                reopened = await agent.open_session(fork.id)
                assert [e["id"] for e in await reopened.history()] == [e["id"] for e in copied]


@pytest.mark.loopback
async def test_acp_new_and_close_do_not_create_a_history_record(tmp_path):
    async with history_service(tmp_path, "http") as url:
        with composition(tmp_path, "http", "native", url) as (start, port):
            async with start as agent:
                listener = await agent.serve_acp(
                    listen="127.0.0.1:0",
                    actors=[
                        {
                            "token_file": tmp_path / "token",
                            "actor": {
                                "id": "user",
                                "kind": "user",
                                "rights": ["watch", "input", "settings"],
                            },
                        }
                    ],
                )
                async with (
                    connect(
                        listener.url,
                        subprotocols=["modular-agent-acp-1"],
                        additional_headers={
                            "Authorization": f"Bearer {(tmp_path / 'token').read_text()}"
                        },
                    ) as ws,
                    asyncio.timeout(10),
                ):

                    async def rpc(key, method, params):
                        await ws.send(
                            json.dumps(
                                {"jsonrpc": "2.0", "id": key, "method": method, "params": params}
                            )
                        )
                        while (reply := json.loads(await ws.recv())).get("id") != key:
                            pass
                        assert "error" not in reply, reply
                        return reply["result"]

                    await rpc(1, "initialize", {"protocolVersion": 1})
                    sid = (await rpc(2, "session/new", {"cwd": str(tmp_path), "mcpServers": []}))[
                        "sessionId"
                    ]
                    await assert_unpublished(tmp_path, "http", url, port, sid, agent)
                    await rpc(3, "session/close", {"sessionId": sid})
                    await assert_unpublished(tmp_path, "http", url, port, sid, agent)


async def crash_session(root, store, placement, url):
    with composition(root, store, placement, url) as (start, _):
        async with start as agent:
            session = await agent.session(settings={"maxSteps": 4})
            print(session.id, flush=True)
            await asyncio.Future()  # The test kills the process without running any close hooks.


def run_service(root):
    from ma_history.service import serve

    from modular_agent._history_port import _route

    with sqlite_history_port(root / "store", ttl_ms=60_000) as port, asyncio.Runner() as runner:
        wrapped = RecordingStore(port, root / "writes.jsonl")
        serve(
            None,
            ("127.0.0.1", 0),
            root / "token",
            port.ttl_ms,
            ready=lambda address: print(f"http://{address[0]}:{address[1]}", flush=True),
            custom_route=lambda *args: runner.run(_route(wrapped, *args)),
        )


if __name__ == "__main__":
    mode, directory, *args = sys.argv[1:]
    if mode == "service":
        run_service(Path(directory))
    else:
        asyncio.run(crash_session(Path(directory), *args))
