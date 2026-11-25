"""History service leases against storage work on other sessions."""

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest
from ma_history.service import Store

from modular_agent import file_history, serve_history

TOKEN = "c79e2509a4395582e0fac55c25c18df1"


def call(url, method, path, body=None, timeout=10.0):
    request = Request(
        url + path,
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
    )
    try:
        with urlopen(request, timeout=timeout) as reply:
            return reply.status, json.loads(reply.read())
    except HTTPError as error:
        with error:
            return error.code, json.loads(error.read())


@pytest.fixture
def service(tmp_path):
    token = tmp_path / "token"
    token.write_text(TOKEN)
    listener = serve_history(
        file_history(tmp_path / "store"), address=("127.0.0.1", 0), token_file=token, lease_ttl=60
    )
    assert listener is not None
    yield listener.url
    listener.close()


def writer(url, sid):
    assert call(url, "PUT", f"/v1/sessions/{sid}", {"project": "/p", "created": 1})[0] == 200
    status, body = call(url, "POST", f"/v1/sessions/{sid}/lease", {"owner": "run-" + sid})
    assert status == 200
    return body["lease"]


def entry(key):
    return {"id": key, "parentId": None, "kind": "note"}


@pytest.mark.loopback
def test_renewal_does_not_wait_for_another_sessions_write(service, monkeypatch):
    lease = writer(service, "writer")
    other = writer(service, "unrelated")
    stalled, release = threading.Event(), threading.Event()
    apply = Store.apply

    def held(self, method, route, sid, *args):
        result = apply(self, method, route, sid, *args)
        if sid == "unrelated" and route == "append":
            stalled.set()
            release.wait()
        return result

    monkeypatch.setattr(Store, "apply", held)
    with ThreadPoolExecutor(1) as pool:
        try:
            write = pool.submit(
                call,
                service,
                "POST",
                "/v1/sessions/unrelated/entries",
                {"lease": other, "entries": [entry("u1")]},
            )
            assert stalled.wait(10), "the unrelated write did not reach its transaction"
            try:
                renewed = call(
                    service, "POST", f"/v1/sessions/writer/lease/{lease}/renew", timeout=5
                )
            except TimeoutError:
                pytest.fail("renewal waited for the unrelated write")
            assert renewed == (200, {"ttlMs": 60_000})
            assert not write.done()
        finally:
            release.set()
        assert write.result() == (200, {"kept": 1})


@pytest.mark.loopback
def test_write_whose_lease_ends_before_commit_is_refused(service, monkeypatch):
    lease = writer(service, "writer")
    apply = Store.apply

    def expire(self, method, route, sid, *args):
        result = apply(self, method, route, sid, *args)
        if route == "append":
            owner, token, _ = self.leases[sid]
            self.leases[sid] = (owner, token, time.monotonic() - 1)
        return result

    monkeypatch.setattr(Store, "apply", expire)
    status, body = call(
        service, "POST", "/v1/sessions/writer/entries", {"lease": lease, "entries": [entry("w1")]}
    )
    assert (status, body["code"]) == (409, "lost")
    assert call(service, "GET", "/v1/sessions/writer")[1]["entries"] == []
