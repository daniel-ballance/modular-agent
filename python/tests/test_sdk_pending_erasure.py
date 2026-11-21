import asyncio
import sqlite3
from contextlib import closing

import pytest

from modular_agent import (
    AgentError,
    ErrorCode,
    create_agent,
    file_history,
    http_history,
    serve_history,
)
from modular_agent.testing import scripted_provider


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
            history=http_history(server.url, token_file, coordination=path, witness=witness),
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
