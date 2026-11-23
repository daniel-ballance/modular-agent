import asyncio
import sqlite3
import sys

import pytest
from ma_core import AgentError, Plugin, Stop, content
from ma_harness import Harness
from ma_history import History


@pytest.fixture
async def base(tmp_path):
    h = Harness()
    await h.load(History(tmp_path / "store"))
    try:
        yield h, h.api(), tmp_path
    finally:
        await h.stop()


async def test_empty_harness_has_no_features():
    h = Harness()
    assert not h.capabilities
    with pytest.raises(AgentError, match="Unavailable"):
        await h.api().call("runtime", "run")


@pytest.mark.parametrize(
    "rule, expected",
    [
        ("observe", {"n": 0}),
        ("transform", {"n": 12}),
        ("gate", {"n": 12}),
        ("first", {"n": 1}),
        ("collect", [{"n": 1}, {"n": 2}]),
    ],
)
async def test_fixed_hook_rules_and_owner(rule, expected):
    h = Harness()
    api = h.api("owner")
    api.define_hook("example", rule)

    async def one(d):
        return {"n": d["n"] * 10 + 1}

    async def two(d):
        return {"n": d["n"] * 10 + 2}

    api.on("example", one)
    api.on("example", two)
    assert await api.hook("example", {"n": 0}) == expected
    with pytest.raises(AgentError, match="Only"):
        await h.api("intruder").hook("example", {})


async def test_first_last_gate_failure_and_transform_stop():
    h = Harness()
    a = h.api("owner")
    a.define_hook("order", "transform")

    async def change(d):
        return d + ["normal"]

    async def first(d):
        return d + ["first"]

    async def last(d):
        return Stop(d + ["last"])

    a.on("order", change)
    a.on("order", last, "last")
    a.on("order", first, "first")
    assert await a.hook("order", []) == ["first", "normal", "last"]
    a.define_hook("check", "gate")

    async def broken(d):
        raise ValueError("unavailable")

    a.on("check", broken)
    assert (await a.hook("check", {}))["refused"]


async def test_plugin_defined_capability_replacement_and_cleanup():
    class Service(Plugin):
        name = "old"

        async def start(self, api):
            await super().start(api)
            api.provide("example", self)
            api.define_hook("custom", "collect")
            api.command("custom", "custom command", self.answer)

        async def answer(self, d, emit=None):
            return "old"

    class Replacement(Service):
        name = "new"

        async def answer(self, d, emit=None):
            return "new"

    h = Harness()
    await h.load(Service())
    assert await h.api().call("example", "answer") == "old"
    with pytest.raises(AgentError):
        await h.load(Replacement())
    await h.load(Replacement(), replaces="old")
    assert await h.api().call("example", "answer") == "new"
    assert h.hooks["custom"][0] == "new"
    await h.stop()


async def test_unused_session_leaves_no_files(base):
    h, a, root = base
    s = await a.session("create", project=str(root))
    await a.session("get", session=s["id"])
    await a.session("close", session=s["id"])
    assert not (root / "store").exists()


async def test_history_tree_move_fork_restart_list_and_unknown_content(base):
    h, a, root = base
    s = await a.session("create", project=str(root / "one"))
    sid = s["id"]
    e1 = await a.session(
        "append",
        session=sid,
        kind="input",
        visible=True,
        content=[{"type": "alien", "value": {"opaque": 7}}],
    )
    e2 = await a.session("append", session=sid, kind="input", content=content("later"))
    await a.session("move", session=sid, point=e1["id"])
    branch = await a.session("branch", session=sid)
    assert e2["id"] not in {e["id"] for e in branch}
    child = await a.session("fork", session=sid, project=str(root / "two"))
    assert next(e for e in child["entries"] if e["kind"] == "input")["copies"] == [e1["id"]]
    assert len(await a.session("list")) == 2
    assert len(await a.session("list", project=str(root / "one"))) == 1
    await a.session("close", session=sid)
    reopened = await a.session("open", session=sid)
    assert reopened["position"] == branch[-1]["id"]
    assert next(e for e in reopened["entries"] if e["kind"] == "input")["content"] == e1["content"]
    with pytest.raises(AgentError, match="rewind"):
        await a.session("move", session=sid, point=e1["id"], rewind=True)
    assert (await a.session("get", session=sid))["position"] == reopened["position"]


async def test_session_reads_can_leave_unrelated_history_in_the_harness(base):
    _, api, root = base
    sid = (await api.session("create", project=str(root)))["id"]
    for turn in ("earlier", "current"):
        await api.session("append", session=sid, kind="input", turn=turn, content=content(turn))

    metadata = await api.session("get", session=sid, include_entries=False)
    assert metadata["id"] == sid and "entries" not in metadata
    (entry,) = await api.session("entries", session=sid, turn="current")
    assert entry["content"] == content("current")
    entry["content"].clear()
    # The shorter read still returns an isolated value, not a live log entry.
    (again,) = await api.session("entries", session=sid, id=entry["id"])
    assert again["content"] == content("current")


async def test_history_idempotent_and_lock_in_second_process(base):
    h, a, root = base
    s = await a.session("create", project=str(root))
    e = await a.session("append", session=s["id"], kind="input", content=content("hello"))
    s = await a.session("get", session=s["id"])
    await a.call("history", "keep", {"session": s, "entries": [e]})
    stored = (await a.call("history", "read", {"session": s["id"]}))["entries"]
    assert [x["id"] for x in stored if x["kind"] == "input"] == [e["id"]]
    code = """
import asyncio, sys
from ma_harness import Harness
from ma_history import History
from ma_core import AgentError
async def main():
    h = Harness()
    await h.load(History(sys.argv[1]))
    try:
        await h.api().session("open", session=sys.argv[2])
    except AgentError as exc:
        assert exc.code == "locked"
        print("locked")
    else:
        raise AssertionError("second writer accepted")
    finally:
        await h.stop()
asyncio.run(main())
"""
    p = await asyncio.create_subprocess_exec(
        sys.executable, "-c", code, str(root / "store"), s["id"], stdout=asyncio.subprocess.PIPE
    )
    out, _ = await p.communicate()
    assert p.returncode == 0 and out.strip() == b"locked"
    with pytest.raises(AgentError, match="different"):
        await a.call("history", "keep", {"session": s, "entries": [{**e, "content": []}]})


async def test_erasure_checks_reuse_the_store_but_not_a_read_snapshot(base, monkeypatch):
    _, api, root = base
    sid = (await api.session("create", project=str(root)))["id"]
    entry = await api.session("append", session=sid, kind="input", content=content("private"))
    connect = sqlite3.connect
    opened = []

    def count(*args, **kwargs):
        opened.append(args[0])
        return connect(*args, **kwargs)

    monkeypatch.setattr(sqlite3, "connect", count)

    async def revision():
        return await api.call("history", "erasure_revision", {"session": sid})

    assert await revision() == 0
    db = connect(root / "store/history.sqlite3")
    try:
        with db:
            db.execute("INSERT INTO erase_copies VALUES (?,?,?,0)", ("intent", sid, entry["id"]))
        with pytest.raises(AgentError, match="pending erasure"):
            await revision()
        with db:
            db.execute("UPDATE erase_copies SET confirmed=1 WHERE intent='intent'")
        assert await revision() == 1
    finally:
        db.close()
    assert not opened

    # A live writer must not keep serving the old inode after replacement.
    path = root / "store/history.sqlite3"
    path.rename(path.with_suffix(".old"))
    path.touch()
    with pytest.raises(AgentError, match="replaced"):
        await revision()


async def test_erasure_follows_summary_fork_and_copies_of_copies(base):
    h, a, root = base
    s = await a.session("create", project=str(root))
    sid = s["id"]
    raw = await a.session("append", session=sid, kind="input", content=content("PERSONAL-XYZ"))
    summary = await a.session(
        "append",
        session=sid,
        kind="summary",
        content=content("PERSONAL-XYZ summary"),
        copies=[raw["id"]],
    )
    child = await a.session("fork", session=sid)
    result = await a.session("erase", session=sid, entries=[raw["id"]])
    assert len(result["erased"]) == 4
    assert summary["id"] in result["erased"]
    for x in (sid, child["id"]):
        s = await a.session("get", session=x)
        assert all(
            e["kind"] == "erasure" and not e["content"]
            for e in s["entries"]
            if e["id"] in result["erased"]
        )
        assert any(e["kind"] == "erase" for e in s["entries"])
    assert b"PERSONAL-XYZ" not in (root / "store" / "history.sqlite3").read_bytes()


async def test_credentials_unavailable_to_runtime():
    h = Harness()
    with pytest.raises(AgentError, match="credentials"):
        await h.api("runtime", "runtime").call("credentials", "get")
