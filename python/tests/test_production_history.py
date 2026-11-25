"""History client tests using scripted HTTP exchanges, without a listener."""

import asyncio
import sys
import time

import pytest
from ma_core import AgentError
from ma_history.http import HTTPHistory, ServiceError, lease_clock


@pytest.mark.parametrize(
    "platform, boottime, expected_clock",
    [("darwin", None, 6), ("linux", 7, 7), ("freebsd", None, None)],
)
def test_writer_clock_and_margin(tmp_path, monkeypatch, platform, boottime, expected_clock):
    reads = []

    def clock_gettime(clock_id):
        reads.append(clock_id)
        return 12.5

    with monkeypatch.context() as patch:
        patch.setattr(sys, "platform", platform)
        patch.setattr(time, "CLOCK_MONOTONIC", 6, raising=False)
        if boottime is None:
            patch.delattr(time, "CLOCK_BOOTTIME", raising=False)
        else:
            patch.setattr(time, "CLOCK_BOOTTIME", boottime, raising=False)
        patch.setattr(time, "clock_gettime", clock_gettime)
        patch.setattr(time, "monotonic", lambda: 4.0)
        patch.delenv("MODULAR_AGENT_HISTORY_LEASE_MARGIN_MS", raising=False)
        args = ("http://127.0.0.1:8080", tmp_path / "token")
        if expected_clock is None:
            with pytest.raises(AgentError, match="Configure MODULAR_AGENT_HISTORY_LEASE_MARGIN_MS"):
                HTTPHistory(*args)
            patch.setenv("MODULAR_AGENT_HISTORY_LEASE_MARGIN_MS", "250")
            assert HTTPHistory(*args).margin == 0.25
            assert lease_clock() == 4.0
            assert not reads
        else:
            assert HTTPHistory(*args).margin == 0
            assert lease_clock() == 12.5
            assert reads == [expected_clock]


async def test_history_list_paginates_with_original_filter(tmp_path, monkeypatch):
    history = HTTPHistory("http://127.0.0.1:8080", tmp_path / "token")
    paths = []

    async def exchange(method, path, body=None):
        assert method == "GET"
        paths.append(path)
        if path.startswith("/v1/sessions?"):
            if len(paths) == 1:
                return {"sessions": [{"id": "a b"}], "next": "a b"}
            return {"sessions": [{"id": "c"}]}
        # The list response has no last activity, so the client reads each session.
        entries = {
            "/v1/sessions/a%20b": [{"id": "1", "time": 9}, {"id": "2", "time": 5}],
            "/v1/sessions/c": [],
        }[path]
        return {"session": {"id": "x"}, "entries": entries}

    monkeypatch.setattr(history, "request", exchange)
    # Last activity is the last entry's time in append order, not the largest; 0 with none.
    assert await history.list({"project": "/demo project"}, None) == [
        {"id": "a b", "lastActivity": 5},
        {"id": "c", "lastActivity": 0},
    ]
    assert paths == [
        "/v1/sessions?project=%2Fdemo%20project",
        "/v1/sessions?project=%2Fdemo%20project&after=a%20b",
        "/v1/sessions/a%20b",
        "/v1/sessions/c",
    ]


async def test_history_open_for_erasure_reports_held_without_waiting(tmp_path, monkeypatch):
    history = HTTPHistory("http://127.0.0.1:8080", tmp_path / "token")
    history.ttl = 15_000
    held = False

    async def exchange(method, path, body=None):
        nonlocal held
        assert (method, path) == ("POST", "/v1/sessions/copy/lease")
        assert not held, "Erasure must leave the held copy pending after the first refusal"
        held = True
        raise ServiceError(409, {"code": "held", "retryAfterMs": 1})

    monkeypatch.setattr(history, "request", exchange)
    with pytest.raises(ServiceError) as exc:
        await history.open({"session": "copy", "wait_for_lease": False}, None)
    assert exc.value.code == "held"


@pytest.mark.parametrize("details", [{}, {"retryAfterMs": 0}, {"retryAfterMs": True}])
async def test_acquire_refuses_invalid_hold_without_retry(tmp_path, monkeypatch, details):
    history = HTTPHistory("http://127.0.0.1", tmp_path / "token")
    calls = 0

    async def exchange(*args):
        nonlocal calls
        calls += 1
        raise ServiceError(409, {"code": "held", **details})

    monkeypatch.setattr(history, "request", exchange)
    with pytest.raises(AgentError, match="Invalid history lease hold"):
        await history.acquire("s")
    assert calls == 1 and not history.leases


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
