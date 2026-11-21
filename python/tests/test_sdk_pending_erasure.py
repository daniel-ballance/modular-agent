from modular_agent import create_agent, file_history
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
