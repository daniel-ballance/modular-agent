"""The embedded history adapter talks to custom stores in binding shapes."""

import json
from urllib.request import Request, urlopen

import pytest

from modular_agent import (
    AgentError,
    ErrorCode,
    Plugin,
    file_history,
    serve_history,
    sqlite_history_port,
)
from modular_agent.testing import test_agent as make_agent


@pytest.mark.loopback
@pytest.mark.parametrize(
    ("custom", "options", "ttl_ms"),
    [
        pytest.param(False, {}, 15_000, id="default"),
        pytest.param(False, {"lease_ttl": 1.001}, 1001, id="configured"),
        pytest.param(False, {"lease_ttl": 0.001}, 1, id="minimum"),
        pytest.param(True, {}, 2500, id="custom"),
    ],
)
def test_serve_history_port_zero(tmp_path, custom, options, ttl_ms):
    from contextlib import nullcontext

    token_file = tmp_path / "token"
    token = "2a6230d8df016fe824ddaee0ab763999"
    token_file.write_text(token)
    directory = tmp_path / "records"
    backend = sqlite_history_port(directory) if custom else nullcontext(file_history(directory))
    with backend as store:
        server = serve_history(store, address=("127.0.0.1", 0), token_file=token_file, **options)
        assert server is not None
        try:
            assert server.url.startswith("http://127.0.0.1:")
            assert not server.url.endswith(":0")
            headers = {"Authorization": f"Bearer {token}"}
            with urlopen(Request(server.url + "/v1", headers=headers), timeout=2) as response:
                info = json.load(response)
                assert info["binding"] == "modular-agent-history/1"
                assert type(info["ttlMs"]) is int
                assert info["ttlMs"] == ttl_ms
            with urlopen(
                Request(server.url + "/v1/sessions", headers=headers), timeout=2
            ) as response:
                assert json.load(response)["sessions"] == []
        finally:
            server.close()
            server.close()


@pytest.mark.parametrize("lease_ttl", [0, 0.0005, 0.0015, float("nan"), float("inf"), 1e308])
def test_serve_history_refuses_invalid_lease_ttl(tmp_path, lease_ttl):
    with pytest.raises(AgentError, match="whole milliseconds") as exc:
        serve_history(
            file_history(tmp_path / "records"),
            address=("127.0.0.1", 0),
            token_file=tmp_path / "unused",
            lease_ttl=lease_ttl,
        )
    assert exc.value.code is ErrorCode.INVALID_PARAMS


async def test_history_port_create_and_paging(tmp_path):
    creates, reads, lists = {}, [], []

    class PagedStore:
        def __getattr__(self, name):
            return getattr(backend, name)

        async def create(self, session_id, metadata):
            creates[session_id] = metadata
            await backend.create(session_id, metadata)

        # Force page boundaries without a large journal or session count.
        async def read(self, session_id, *, after, limit):
            reads.append((session_id, after, limit))
            return await backend.read(session_id, after=after, limit=1)

        async def list(self, *, project, after, limit):
            lists.append((project, after, limit))
            return await backend.list(project=project, after=after, limit=1)

    with sqlite_history_port(tmp_path / "store", ttl_ms=10_000) as backend:

        def setup(r):
            r.history_store(PagedStore())

        with pytest.raises(AgentError, match="Unlisted history replacement") as denied:
            await make_agent(
                project=tmp_path,
                durability="kept",
                plugins=[Plugin("paged-store", setup=setup)],
                script=[],
            )
        assert denied.value.code is ErrorCode.INVALID_COMPOSITION
        plugin = Plugin("paged-store", setup=setup, replaces=["history"])
        async with make_agent(
            project=tmp_path,
            durability="kept",
            plugins=[plugin],
            script=[{"text": "first"}, {"text": "second"}],
        ) as agent:
            first, second = await agent.session(), await agent.session()
            assert not creates
            await first.prompt("one")
            await second.prompt("two")
            assert creates.keys() == {first.id, second.id}

            assert lists == [(None, None, 500)]  # Rebuild before accepting new work.
            lists.clear()
            saved = await agent.sessions(project=tmp_path)
            assert {row["id"] for row in saved} == {first.id, second.id}
            assert lists == [(str(tmp_path), None, 500), (str(tmp_path), saved[0]["id"], 500)]

            history = await first.history()
            reads.clear()
            metadata = await agent.session_info(first.id)
            assert creates[first.id] == {"project": str(tmp_path), "created": metadata["created"]}
            assert len(history) > 1
            assert reads == [
                (first.id, cursor, 500) for cursor in [None, *[e["id"] for e in history[:-1]]]
            ]
