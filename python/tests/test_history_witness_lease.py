"""A write refused for a lost lease leaves the freshness witness usable."""

import json
import os
import stat
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest
from ma_history import freshness
from ma_history.registry import Registry
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


def entry(key, **extra):
    return {"id": key, "parentId": None, "kind": "note", **extra}


def _start_service(tmp_path, monkeypatch):
    token = tmp_path / "token"
    token.write_text(TOKEN)
    witness = tmp_path / "witness"
    stores = []
    init = Store.__init__

    def capture(self, *args, **kwargs):
        init(self, *args, **kwargs)
        stores.append(self)

    monkeypatch.setattr(Store, "__init__", capture)
    listener = serve_history(
        file_history(tmp_path / "store"),
        address=("127.0.0.1", 0),
        token_file=token,
        lease_ttl=60,
        witness=witness,
    )
    assert listener is not None
    assert len(stores) == 1
    return listener, witness, stores[0]


def _prepare_route(url, route):
    assert call(url, "PUT", "/v1/sessions/writer", {"project": "/p", "created": 1})[0] == 200
    lease = acquire(url, "run-a")
    assert (
        call(
            url, "POST", "/v1/sessions/writer/entries", {"lease": lease, "entries": [entry("w1")]}
        )[0]
        == 200
    )
    if route == "append":
        return lease, "/v1/sessions/writer/entries", {"entries": [entry("w2")]}
    if route == "erase":
        return lease, "/v1/sessions/writer/erase", {"entryIds": ["w1"]}
    status, reg = call(url, "GET", "/v1/sessions/writer/pending-erasure")
    assert status == 200
    publish_payload = {
        "revision": reg["revision"],
        "intentId": "i1",
        "entryIds": ["w1"],
        "copies": [{"sessionId": "writer", "recordId": "rec1", "entryIds": ["w1"]}],
    }
    if route == "registry":
        return lease, "/v1/sessions/writer/pending-erasure", publish_payload
    assert route == "complete"
    assert (
        call(
            url,
            "POST",
            "/v1/sessions/writer/pending-erasure",
            {"lease": lease, **publish_payload},
        )[0]
        == 200
    )
    bookkeeping = {
        "id": "rec1",
        "parentId": "w1",
        "kind": "erasure",
        "data": {"entryIds": ["w1"]},
    }
    assert (
        call(
            url,
            "POST",
            "/v1/sessions/writer/entries",
            {"lease": lease, "entries": [bookkeeping]},
        )[0]
        == 200
    )
    assert (
        call(url, "POST", "/v1/sessions/writer/erase", {"lease": lease, "entryIds": ["w1"]})[0]
        == 200
    )
    return lease, "/v1/sessions/writer/pending-erasure/i1/complete", {"entryIds": ["w1"]}


def _assert_uncommitted(url, route, rev_before):
    status, reg = call(url, "GET", "/v1/sessions/writer/pending-erasure")
    assert status == 200
    assert reg["revision"] == rev_before
    status, session = call(url, "GET", "/v1/sessions/writer")
    assert status == 200
    if route == "append":
        assert [e["id"] for e in session["entries"]] == ["w1"]
    elif route == "erase":
        assert session["entries"][0].get("erased") is not True
    elif route == "registry":
        assert reg["plans"] == []
    else:
        assert route == "complete"
        assert reg["plans"][0]["copies"] == [{"entryId": "w1", "complete": False}]


def _assert_committed(url, route):
    status, reg = call(url, "GET", "/v1/sessions/writer/pending-erasure")
    assert status == 200
    status, session = call(url, "GET", "/v1/sessions/writer")
    assert status == 200
    if route == "append":
        assert [e["id"] for e in session["entries"]] == ["w1", "w2"]
    elif route == "erase":
        assert session["entries"][0].get("erased") is True
    elif route == "registry":
        assert [p["intentId"] for p in reg["plans"]] == ["i1"]
    else:
        assert route == "complete"
        assert reg["plans"][0]["copies"] == [{"entryId": "w1", "complete": True}]


@pytest.mark.loopback
@pytest.mark.parametrize("route", ["append", "erase", "registry", "complete"])
def test_lost_lease_write_leaves_witness_matching(tmp_path, monkeypatch, route):
    listener, witness, _ = _start_service(tmp_path, monkeypatch)
    url = listener.url
    try:
        lease, path, payload = _prepare_route(url, route)
        stamp = witness.read_bytes()
        status, reg_before = call(url, "GET", "/v1/sessions/writer/pending-erasure")
        assert status == 200
        rev_before = reg_before["revision"]
        apply = Store.apply
        real_write = freshness._write
        witness_writes = 0

        def count_write(target, value):
            nonlocal witness_writes
            witness_writes += 1
            return real_write(target, value)

        def expire(self, method, name, sid, *args):
            result = apply(self, method, name, sid, *args)
            if name == route:
                with self.lease_lock:
                    owner, value, _ = self.leases[sid]
                    self.leases[sid] = (owner, value, time.monotonic() - 1)
            return result

        monkeypatch.setattr(freshness, "_write", count_write)
        monkeypatch.setattr(Store, "apply", expire)
        status, body = call(url, "POST", path, {"lease": lease, **payload})
        assert (status, body.get("code")) == (409, "lost")
        assert witness_writes == 0
        monkeypatch.undo()

        assert witness.read_bytes() == stamp
        _assert_uncommitted(url, route, rev_before)
        assert call(url, "PUT", "/v1/sessions/other", {"project": "/p", "created": 2})[0] == 200
        retry_payload = dict(payload)
        if route == "registry":
            retry_payload["revision"] = call(url, "GET", "/v1/sessions/writer/pending-erasure")[1][
                "revision"
            ]
        status, _ = call(url, "POST", path, {"lease": acquire(url, "run-b"), **retry_payload})
        assert status == 200
        assert witness.read_bytes() != stamp
        _assert_committed(url, route)
    finally:
        listener.close()


@pytest.mark.loopback
@pytest.mark.parametrize("route", ["append", "erase", "registry", "complete"])
def test_lease_expires_during_witness_write(tmp_path, monkeypatch, route):
    listener, witness, store = _start_service(tmp_path, monkeypatch)
    url = listener.url
    try:
        lease, path, payload = _prepare_route(url, route)
        stamp = witness.read_bytes()
        status, reg_before = call(url, "GET", "/v1/sessions/writer/pending-erasure")
        assert status == 200
        rev_before = reg_before["revision"]

        armed = threading.Event()
        in_write = threading.Event()
        expired = threading.Event()
        real_write = freshness._write
        real_fsync = os.fsync
        restore_fsyncs = []

        def seam_fsync(fd):
            if expired.is_set():
                mode = os.fstat(fd).st_mode
                if stat.S_ISDIR(mode):
                    restore_fsyncs.append("dir")
                elif stat.S_ISREG(mode):
                    restore_fsyncs.append("file")
            return real_fsync(fd)

        def seam_write(target, value):
            real_write(target, value)
            if armed.is_set():
                armed.clear()
                in_write.set()
                assert expired.wait(10)

        monkeypatch.setattr(freshness, "_write", seam_write)
        monkeypatch.setattr(os, "fsync", seam_fsync)
        armed.set()
        with ThreadPoolExecutor(1) as pool:
            try:
                write = pool.submit(call, url, "POST", path, {"lease": lease, **payload})
                assert in_write.wait(10), "write did not reach freshness._write"
                assert witness.read_bytes() != stamp
                with store.lease_lock:
                    owner, value, _ = store.leases["writer"]
                    store.leases["writer"] = (owner, value, time.monotonic() - 1)
            finally:
                expired.set()
            status, body = write.result(timeout=10)
        monkeypatch.undo()

        assert (status, body.get("code")) == (409, "lost")
        assert "file" in restore_fsyncs and "dir" in restore_fsyncs
        assert witness.read_bytes() == stamp
        _assert_uncommitted(url, route, rev_before)

        assert call(url, "PUT", "/v1/sessions/other", {"project": "/p", "created": 2})[0] == 200
        retry_payload = dict(payload)
        if route == "registry":
            retry_payload["revision"] = call(url, "GET", "/v1/sessions/writer/pending-erasure")[1][
                "revision"
            ]
        status, _ = call(url, "POST", path, {"lease": acquire(url, "run-b"), **retry_payload})
        assert status == 200
        assert witness.read_bytes() != stamp
        _assert_committed(url, route)
    finally:
        listener.close()


@pytest.mark.loopback
def test_witness_restore_failure_fails_closed(tmp_path, monkeypatch):
    listener, witness, store = _start_service(tmp_path, monkeypatch)
    url = listener.url
    try:
        lease, path, payload = _prepare_route(url, "append")
        stamp = witness.read_bytes()

        armed = threading.Event()
        in_write = threading.Event()
        expired = threading.Event()
        fail_restore = threading.Event()
        real_write = freshness._write
        real_replace = os.replace

        def seam_write(target, value):
            real_write(target, value)
            if armed.is_set():
                armed.clear()
                in_write.set()
                assert expired.wait(10)

        def seam_replace(src, dst):
            if fail_restore.is_set() and dst == witness:
                raise OSError("simulated witness restore failure")
            return real_replace(src, dst)

        monkeypatch.setattr(freshness, "_write", seam_write)
        monkeypatch.setattr(os, "replace", seam_replace)
        armed.set()
        with ThreadPoolExecutor(1) as pool:
            try:
                write = pool.submit(call, url, "POST", path, {"lease": lease, **payload})
                assert in_write.wait(10), "write did not reach freshness._write"
                assert witness.read_bytes() != stamp
                with store.lease_lock:
                    owner, value, _ = store.leases["writer"]
                    store.leases["writer"] = (owner, value, time.monotonic() - 1)
                fail_restore.set()
            finally:
                expired.set()
            status, body = write.result(timeout=10)
        monkeypatch.undo()

        assert (status, body.get("code")) == (503, "unavailable")
        assert witness.read_bytes() != stamp
        assert [e["id"] for e in call(url, "GET", "/v1/sessions/writer")[1]["entries"]] == ["w1"]
        status, body = call(url, "GET", "/v1/sessions/writer/pending-erasure")
        assert (status, body.get("code")) == (503, "unavailable")
    finally:
        listener.close()


@pytest.mark.loopback
def test_lease_expires_during_registry_advance_without_witness(tmp_path, monkeypatch):
    token = tmp_path / "token"
    token.write_text(TOKEN)
    stores = []
    init = Store.__init__

    def capture(self, *args, **kwargs):
        init(self, *args, **kwargs)
        stores.append(self)

    monkeypatch.setattr(Store, "__init__", capture)
    listener = serve_history(
        file_history(tmp_path / "store"),
        address=("127.0.0.1", 0),
        token_file=token,
        lease_ttl=60,
    )
    assert listener is not None
    assert len(stores) == 1
    store = stores[0]
    url = listener.url
    try:
        lease, path, payload = _prepare_route(url, "append")
        status, reg_before = call(url, "GET", "/v1/sessions/writer/pending-erasure")
        assert status == 200
        rev_before = reg_before["revision"]

        armed = threading.Event()
        in_advance = threading.Event()
        expired = threading.Event()
        real_advance = Registry.advance

        def seam_advance(self):
            real_advance(self)
            if armed.is_set():
                armed.clear()
                in_advance.set()
                assert expired.wait(10)

        monkeypatch.setattr(Registry, "advance", seam_advance)
        armed.set()
        with ThreadPoolExecutor(1) as pool:
            try:
                write = pool.submit(call, url, "POST", path, {"lease": lease, **payload})
                assert in_advance.wait(10), "write did not reach Registry.advance"
                with store.lease_lock:
                    owner, value, _ = store.leases["writer"]
                    store.leases["writer"] = (owner, value, time.monotonic() - 1)
            finally:
                expired.set()
            status, body = write.result(timeout=10)
        monkeypatch.undo()

        assert (status, body.get("code")) == (409, "lost")
        _assert_uncommitted(url, "append", rev_before)
    finally:
        listener.close()
