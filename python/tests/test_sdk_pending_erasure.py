import asyncio
import sqlite3
from contextlib import closing
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from modular_agent import (
    AgentError,
    ErrorCode,
    create_agent,
    file_history,
    http_history,
    serve_history,
    sqlite_history_port,
)
from modular_agent.testing import scripted_provider
from ma_history.http import HTTPHistory


async def test_held_fork_is_pending_and_next_writer_confirms_it(tmp_path):
    history = file_history(tmp_path / "history")
    options = dict(project=tmp_path, data_dir=tmp_path / "data", history=history, durability="kept")
    async with create_agent(**options, providers=[scripted_provider([{"text": "reply"}])]) as a:
        source = await a.session()
        await source.prompt("erase this phrase", key="source-key")
        target = next(e["id"] for e in await source.history() if e["kind"] == "input")
        fork = await source.fork()
        fork_id = fork.id
        copied = next(e["id"] for e in await fork.history() if e["kind"] == "input")
        await fork.close()
        pair = {"sessionId": fork_id, "id": copied}
        async with create_agent(**options, providers=[scripted_provider([])]) as b:
            attached = await b.open_session(fork_id)
            report = await source.erase([target, target])
            assert pair in report["pending"] and pair not in report["erased"]
            receipt = await source.send("ignored", "now", key="source-key")
            assert receipt.duplicate and receipt.input_id == ""
            # The current writer exits without asking for the pending content.
            await attached.close()
        async with create_agent(**options, providers=[scripted_provider([])]) as c:
            loaded = await c.open_session(fork_id)
            entries = await loaded.history()
            assert "erase this phrase" not in repr(entries)
            assert sum(e["kind"] == "erasure" and not e.get("erased") for e in entries) == 1
            assert any(e["id"] == copied and e.get("erased") for e in entries)
            again = await source.erase([target])
            assert pair in again["erased"] and again["pending"] == []


@pytest.mark.loopback
async def test_http_history_discovers_registry_and_reconciles_on_takeover(tmp_path):
    token = tmp_path / "token"
    token.write_text("c79e2509a4395582e0fac55c25c18df1")
    server = serve_history(
        file_history(tmp_path / "store"), address=("127.0.0.1", 0), token_file=token
    )
    assert server is not None
    options = dict(project=tmp_path, history=http_history(server.url, token), durability="kept")
    try:
        async with create_agent(
            **options, data_dir=tmp_path / "a", providers=[scripted_provider([{"text": "reply"}])]
        ) as a:
            source = await a.session()
            await source.prompt("kept until marked", key="spent")
            target = next(e["id"] for e in await source.history() if e["kind"] == "input")
            fork = await source.fork()
            sid = fork.id
            copied = next(e["id"] for e in await fork.history() if e["kind"] == "inputAccepted")
            await fork.close()
            async with create_agent(
                **options, data_dir=tmp_path / "b", providers=[scripted_provider([])]
            ) as b:
                attached = await b.open_session(sid)
                assert "kept until marked" in repr(await attached.history())
                report = await source.erase([target])
                assert {"id": copied, "sessionId": sid} in report["pending"]
                # An active writer can reconcile before a new view; it may not
                # let a queued snapshot cross the pending mark.
                await attached.close()
            async with create_agent(
                **options, data_dir=tmp_path / "c", providers=[scripted_provider([])]
            ) as c:
                loaded = await c.open_session(sid)
                history = await loaded.history()
                assert "kept until marked" not in repr(history)
                assert sum(e["kind"] == "erasure" for e in history) == 1
                assert any(e["id"] == copied and e.get("erased") for e in history)
                duplicate = await loaded.send("ignored", "now", key="spent")
                assert duplicate.duplicate and not duplicate.input_id
    finally:
        server.close()


@pytest.mark.loopback
async def test_http_republication_recovers_original_destinations_in_order(tmp_path):
    token = tmp_path / "token"
    token.write_text("c79e2509a4395582e0fac55c25c18df1")
    directory = tmp_path / "store"
    server = serve_history(file_history(directory), address=("127.0.0.1", 0), token_file=token)
    http = HTTPHistory(server.url, token)
    http.token = token.read_text()
    destinations = ["z-copy", "source", "a-copy"]
    try:
        for sid in destinations:
            path = http.path(sid)
            await http.request("PUT", path, {"project": str(tmp_path), "created": 0})
            await http.acquire(sid)
            await http.erasure_request(
                sid,
                http.leases[sid],
                path + "/entries",
                {"entries": [{"id": "target", "parentId": None, "kind": "input"}]},
            )
            if sid != "source":
                await http.close({"session": sid}, None)
        revision, _ = await http.registry("source")
        body = {
            "intentId": "original",
            "revision": revision,
            "entryIds": ["target"],
            "copies": [
                {"sessionId": sid, "recordId": "mark", "entryIds": ["target"]}
                for sid in destinations
            ],
        }
        path = http.registry_path("source")
        lease = http.leases["source"]
        expected = {"intentId": "original", "sessionIds": ["z-copy", "a-copy"]}
        assert await http.erasure_request("source", lease, path, body) == expected

        # Simulate retention reclaiming records while keeping the ID and its plans reserved.
        with closing(sqlite3.connect(directory / "history-service" / "records.db")) as db, db:
            db.execute("DELETE FROM entries WHERE session='z-copy'")
        assert {row["id"] for row in await http.list({}, None)} == {"source", "a-copy"}
        assert await http.erasure_request("source", lease, path, body) == expected
        repeated = {**body, "intentId": "new", "copies": [body["copies"][1]]}
        assert await http.erasure_request("source", lease, path, repeated) == expected
        progress = await http.publish_erasure({"session": "source", "entries": ["target"]}, None)
        assert [copy["sessionId"] for copy in progress] == ["source", "z-copy", "a-copy"]
        assert all(copy["intent"] == "original" and not copy["confirmed"] for copy in progress)
    finally:
        await http.stop()
        server.close()


@pytest.mark.loopback
async def test_base_http_composition_does_not_declare_erasure(tmp_path):
    token = tmp_path / "token"
    token.write_text("c79e2509a4395582e0fac55c25c18df1")
    with sqlite_history_port(tmp_path / "store") as port:
        server = serve_history(port, address=("127.0.0.1", 0), token_file=token)
        assert server is not None
        try:
            async with create_agent(
                project=tmp_path,
                data_dir=tmp_path / "agent",
                history=http_history(server.url, token),
                durability="kept",
                providers=[scripted_provider([{"text": "reply"}])],
            ) as agent:
                session = await agent.session()
                await session.prompt("no registry")
                target = next(e["id"] for e in await session.history() if e["kind"] == "input")
                with pytest.raises(AgentError) as exc:
                    await session.erase([target])
                assert exc.value.code is ErrorCode.NOT_SUPPORTED
        finally:
            server.close()


@pytest.mark.loopback
def test_service_does_not_replace_missing_registry_on_restart(tmp_path):
    token = tmp_path / "token"
    token.write_text("c79e2509a4395582e0fac55c25c18df1")
    directory = tmp_path / "store"

    def listen():
        return serve_history(file_history(directory), address=("127.0.0.1", 0), token_file=token)

    def request(server, route, data=None):
        return urlopen(
            Request(
                server.url + route,
                data=data,
                method="PUT" if data else "GET",
                headers={
                    "Authorization": "Bearer " + token.read_text(),
                    "Content-Type": "application/json",
                },
            )
        )

    server = listen()
    assert server is not None
    try:
        with request(server, "/v1/sessions/saved", b'{"project":"project","created":0}') as reply:
            assert reply.status == 200
    finally:
        server.close()
    with closing(sqlite3.connect(directory / "history-service" / "records.db")) as db:
        db.execute("DROP TABLE registry_plans")
    server = listen()
    assert server is not None
    try:
        with pytest.raises(HTTPError) as failure:
            request(server, "/v1/sessions/saved/pending-erasure")
        with failure.value as response:
            assert response.status == 503
            assert b'"code":"unavailable"' in response.read()
    finally:
        server.close()


@pytest.mark.loopback
async def test_restored_http_store_refuses_stale_pending_state(tmp_path):
    directory = tmp_path / "history"
    path = directory / "history-service" / "records.db"
    token_file, witness = tmp_path / "token", tmp_path / "witness"
    token_file.write_text("c79e2509a4395582e0fac55c25c18df1")
    backend = file_history(directory)
    server = serve_history(
        backend, address=("127.0.0.1", 0), token_file=token_file, witness=witness
    )
    assert server is not None
    backup = tmp_path / "backup.db"
    try:
        async with create_agent(
            project=tmp_path,
            data_dir=tmp_path / "agent",
            history=http_history(server.url, token_file),
            durability="kept",
            providers=[scripted_provider([{"text": "reply"}])],
        ) as agent:
            session = await agent.session()
            await session.prompt("before erasure")

            def snapshot():
                with (
                    closing(sqlite3.connect(path)) as source,
                    closing(sqlite3.connect(backup)) as target,
                ):
                    source.backup(target)

            await asyncio.to_thread(snapshot)
            entry = next(e["id"] for e in await session.history() if e["kind"] == "input")
            assert (await session.erase([entry]))["erased"]
    finally:
        server.close()
    backup.replace(path)
    with pytest.raises(AgentError, match="freshness witness does not match") as failure:
        serve_history(backend, address=("127.0.0.1", 0), token_file=token_file, witness=witness)
    assert failure.value.code is ErrorCode.UNAVAILABLE
