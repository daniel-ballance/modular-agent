"""A write refused for a lost lease leaves the freshness witness usable."""

import json
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest
from ma_history.service import Store

from modular_agent import file_history, serve_history

TOKEN = "c79e2509a4395582e0fac55c25c18df1"


def call(url, method, path, body=None):
    request = Request(
        url + path,
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
    )
    try:
        with urlopen(request, timeout=10) as reply:
            return reply.status, json.loads(reply.read())
    except HTTPError as error:
        with error:
            return error.code, json.loads(error.read())


def acquire(url, owner):
    status, body = call(url, "POST", "/v1/sessions/writer/lease", {"owner": owner})
    assert status == 200
    return body["lease"]


def entry(key):
    return {"id": key, "parentId": None, "kind": "note"}


@pytest.mark.loopback
@pytest.mark.parametrize(
    "route, payload",
    [("append", {"entries": [entry("w2")]}), ("erase", {"entryIds": ["w1"]})],
)
def test_lost_lease_write_leaves_witness_matching(tmp_path, monkeypatch, route, payload):
    token = tmp_path / "token"
    token.write_text(TOKEN)
    witness = tmp_path / "witness"
    listener = serve_history(
        file_history(tmp_path / "store"),
        address=("127.0.0.1", 0),
        token_file=token,
        lease_ttl=60,
        witness=witness,
    )
    assert listener is not None
    url = listener.url
    path = "/v1/sessions/writer/" + {"append": "entries", "erase": "erase"}[route]
    try:
        assert call(url, "PUT", "/v1/sessions/writer", {"project": "/p", "created": 1})[0] == 200
        lease = acquire(url, "run-a")
        first = {"lease": lease, "entries": [entry("w1")]}
        assert call(url, "POST", "/v1/sessions/writer/entries", first)[0] == 200
        stamp = witness.read_text()
        apply = Store.apply

        def expire(self, method, name, sid, *args):
            result = apply(self, method, name, sid, *args)
            if name == route:
                owner, value, _ = self.leases[sid]
                self.leases[sid] = (owner, value, time.monotonic() - 1)
            return result

        monkeypatch.setattr(Store, "apply", expire)
        status, body = call(url, "POST", path, {"lease": lease, **payload})
        assert (status, body["code"]) == (409, "lost")
        monkeypatch.undo()

        assert call(url, "GET", "/v1/sessions/writer/pending-erasure")[0] == 200
        assert witness.read_text() == stamp
        assert [e["id"] for e in call(url, "GET", "/v1/sessions/writer")[1]["entries"]] == ["w1"]
        assert call(url, "PUT", "/v1/sessions/other", {"project": "/p", "created": 2})[0] == 200
        status, _ = call(url, "POST", path, {"lease": acquire(url, "run-b"), **payload})
        assert status == 200
        assert witness.read_text() != stamp
    finally:
        listener.close()
