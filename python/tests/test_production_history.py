"""History client tests using scripted HTTP exchanges, without a listener."""

import asyncio

import pytest
from ma_core import AgentError
from ma_history.http import HTTPHistory


async def test_history_list_paginates_with_original_filter(tmp_path, monkeypatch):
    history = HTTPHistory("http://127.0.0.1:8080", tmp_path / "token")
    paths = []

    async def exchange(method, path, body=None):
        assert method == "GET"
        paths.append(path)
        if len(paths) == 1:
            return {"sessions": [{"id": "a b"}], "next": "a b"}
        return {"sessions": [{"id": "c"}]}

    monkeypatch.setattr(history, "request", exchange)
    assert await history.list({"project": "/demo project"}, None) == [{"id": "a b"}, {"id": "c"}]
    assert paths == [
        "/v1/sessions?project=%2Fdemo%20project",
        "/v1/sessions?project=%2Fdemo%20project&after=a%20b",
    ]


async def test_late_successful_renewal_cannot_extend_old_lease(tmp_path, monkeypatch):
    history = HTTPHistory("http://127.0.0.1:8080", tmp_path / "token")
    history.ttl = 120
    renewing = asyncio.Event()
    reply = asyncio.Event()

    async def exchange(method, path, body=None):
        if path.endswith("/renew"):
            renewing.set()
            await reply.wait()
            return {"ttlMs": 120}
        if method == "DELETE":
            return {}
        return {"lease": "first", "ttlMs": 120}

    monkeypatch.setattr(history, "request", exchange)
    try:
        assert await history.acquire("session") == "first"
        await asyncio.wait_for(renewing.wait(), 1)
        await asyncio.sleep(0.07)
        with pytest.raises(AgentError, match="lease was lost"):
            await history.acquire("session")
        reply.set()
        await asyncio.sleep(0)
        with pytest.raises(AgentError, match="lease was lost"):
            await history.acquire("session")
    finally:
        await history.stop()
