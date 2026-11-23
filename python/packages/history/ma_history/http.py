"""Client for modular-agent-history/1, with renewable per-session write leases."""

import asyncio
import ipaddress
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from ma_core import telemetry as ot
from ma_core import AgentError, Plugin, identity
from ma_core.wire import entry_out

from .portable import session_view
from .profile import PendingErasure


def _suspend_aware_clock_id():
    if sys.platform == "darwin":
        # Darwin's CLOCK_MONOTONIC advances during sleep; time.monotonic()
        # uses mach_absolute_time, which stops during sleep.
        return getattr(time, "CLOCK_MONOTONIC", None)
    return getattr(time, "CLOCK_BOOTTIME", None)


def lease_clock():
    clock_id = _suspend_aware_clock_id()
    return time.clock_gettime(clock_id) if clock_id is not None else time.monotonic()


class ServiceError(AgentError):
    def __init__(self, status, body):
        self.status = status
        self.body = body
        super().__init__(body.get("error", "History service error"), body.get("code", "internal"))


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # Do not forward the bearer token to another origin.


class HTTPHistory(PendingErasure, Plugin):
    name = "history"
    role = "history_store"
    declarations = {
        "erasure": False,
        "single_writer": True,
        "remote_lease": True,
    }

    def __init__(self, url, token_file):
        parsed = urlsplit(url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or "?" in url
            or "#" in url
        ):
            raise AgentError("Invalid history service base URL")
        if parsed.scheme == "http" and not self._numeric_loopback(parsed.hostname):
            raise AgentError("Plaintext history service requires a numeric loopback address")
        self.url = url.rstrip("/")
        self.token_file = Path(token_file)
        self.owner = identity()
        self.leases = {}
        self.opening = {}
        self.must_renew = set()
        self.margin = 0
        if _suspend_aware_clock_id() is None:
            margin = os.environ.get("MODULAR_AGENT_HISTORY_LEASE_MARGIN_MS", "")
            if not re.fullmatch(r"[0-9]+", margin):
                raise AgentError("Configure MODULAR_AGENT_HISTORY_LEASE_MARGIN_MS on this platform")
            self.margin = int(margin) / 1000

    @staticmethod
    def _numeric_loopback(host):
        try:
            return ipaddress.ip_address(host).is_loopback
        except ValueError:
            return False

    async def start(self, api):
        await super().start(api)
        self.token = self.token_file.read_text(encoding="utf-8").strip(" \t\r\n")
        if not re.fullmatch(r"[A-Za-z0-9._~+/\-]+=*", self.token):
            raise AgentError("Invalid history bearer token")
        info = await self.request("GET", "/v1")
        if info.get("binding") != "modular-agent-history/1":
            raise AgentError("Unsupported history service binding")
        self.ttl = info.get("ttlMs")
        if type(self.ttl) is not int or self.ttl <= 0:
            raise AgentError("Invalid history lease TTL")
        version = info.get("pendingErasure")
        if type(version) is int and version == 1:
            self.declarations = {**self.declarations, "erasure": True, "pending_erasure": True}
        api.provide("history", self)

    @staticmethod
    def encode(body):
        return json.dumps(body, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()

    @staticmethod
    def decode(reply, limit):
        if reply.headers.get("Content-Encoding") is not None:
            raise ValueError("Encoded history body")
        raw = reply.read(limit + 1)
        if len(raw) > limit:
            raise ValueError("Oversized history body")
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("Invalid history body")
        return value

    async def request(self, method, path, body=None, *, headers=None):
        req = Request(
            self.url + path,
            method=method,
            data=self.encode(body) if body is not None else None,
            headers={
                "Authorization": "Bearer " + self.token,
                "Content-Type": "application/json",
                **(headers or {}),
                **ot.inject(),
            },
        )

        def once():
            try:
                with build_opener(ProxyHandler({}), NoRedirect()).open(req, timeout=5) as reply:
                    limit = 4 << 20 if method == "GET" else 64 << 20
                    return self.decode(reply, limit)
            except HTTPError as exc:
                with exc:
                    try:
                        detail = self.decode(exc, 64 << 20)
                    except (ValueError, RecursionError):
                        detail = {"error": f"History HTTP {exc.code}"}
                    raise ServiceError(exc.code, detail) from None

        try:
            return await asyncio.to_thread(once)
        except ServiceError:
            raise
        except (OSError, ValueError, RecursionError) as exc:
            raise AgentError("History service unavailable", "lost") from exc

    @staticmethod
    def segment(value):
        if not isinstance(value, str) or not value or value in {".", ".."}:
            raise AgentError("Invalid history path ID", "invalid_request")
        return quote(value, safe="")

    @classmethod
    def path(cls, sid):
        return "/v1/sessions/" + cls.segment(sid)

    async def pages(self, path, field, **query):
        items, metadata, cursors = [], None, set()
        while True:
            suffix = "?" + urlencode(query, quote_via=quote) if query else ""
            page = await self.request("GET", path + suffix)
            items.extend(page[field])
            metadata = page.get("session", metadata)
            cursor = page.get("next")
            if cursor is None:
                return metadata, items
            if cursor in cursors or not page[field] or page[field][-1]["id"] != cursor:
                raise AgentError("Invalid history page cursor", "lost")
            cursors.add(cursor)
            query["after"] = cursor

    def _lose(self, sid, lease, *, notify=True):
        if self.leases.get(sid) is not lease or lease["lost"]:
            return
        lease["lost"] = True
        if timer := lease.get("timer"):
            timer.cancel()
        if notify and hasattr(self, "api"):
            lease["interrupt"] = asyncio.create_task(self.api.session("writer_lost", session=sid))

    def _check(self, sid, lease):
        if lease_clock() >= lease["cutoff"]:
            self._lose(sid, lease)
        if lease["lost"]:
            raise AgentError("History write lease was lost", "lost")

    async def writable(self, d, emit):
        sid = d["session"]
        if sid in self.leases:
            self._check(sid, self.leases[sid])

    def _arm(self, sid, lease, sent, ttl):
        if type(ttl) is not int or ttl <= 0:
            raise AgentError("Invalid history lease TTL", "lost")
        cutoff = sent + ttl / 2000 - self.margin
        if lease_clock() >= min(cutoff, lease.get("cutoff", cutoff)):
            raise AgentError("History write lease was lost", "lost")
        if timer := lease.get("timer"):
            timer.cancel()
        lease["cutoff"] = cutoff
        lease["timer"] = asyncio.get_running_loop().call_later(
            max(0, cutoff - lease_clock()), self._lose, sid, lease
        )

    async def acquire(self, sid, *, wait_for_lease=True):
        async with self.opening.setdefault(sid, asyncio.Lock()):
            if sid in self.leases:
                lease = self.leases[sid]
                self._check(sid, lease)
                return lease["id"]
            path = self.path(sid) + "/lease"
            deadline, held = None, None
            while True:
                sent = lease_clock()
                if deadline is not None and sent >= deadline:
                    raise held
                try:
                    remaining = None if deadline is None else deadline - sent
                    async with asyncio.timeout(remaining):
                        value = await self.request("POST", path, {"owner": self.owner})
                    break
                except TimeoutError as exc:
                    self.must_renew.add(sid)
                    raise held from exc
                except ServiceError as exc:
                    if exc.code != "held" or not wait_for_lease:
                        raise
                    held = exc
                    now = lease_clock()
                    if deadline is None:
                        deadline = now + self.ttl / 1000 + 1
                    wait = exc.body.get("retryAfterMs")
                    # Compatibility with the pre-edition local test service only.
                    delay = 0.25 if wait is None else wait / 1000 if type(wait) is int else -1
                    if delay <= 0:
                        raise AgentError("Invalid history retry interval", "lost") from exc
                    if now + delay >= deadline:
                        raise
                    with ot.span(
                        "modular_agent.capacity.wait",
                        ot.attrs(
                            sid,
                            **{
                                "modular_agent.capacity.scope": "session",
                            },
                        ),
                    ):
                        await asyncio.sleep(max(0.001, delay))
                except (AgentError, asyncio.CancelledError):
                    # The grant may have reached the service. A future acquire
                    # for this session must not mistake it for a fresh grant.
                    self.must_renew.add(sid)
                    raise
            lease = self.leases[sid] = {"id": value["lease"], "lost": False}
            try:
                if not isinstance(lease["id"], str) or not re.fullmatch(
                    r"[A-Za-z0-9_-]{1,128}", lease["id"]
                ):
                    raise AgentError("Invalid history lease value", "lost")
                self._arm(sid, lease, sent, value["ttlMs"])
                if sid in self.must_renew:
                    sent = lease_clock()
                    renewal = path + "/" + self.segment(lease["id"]) + "/renew"
                    with ot.span("modular_agent.history.lease.renew", ot.attrs(sid)):
                        value = await self.request("POST", renewal)
                    self._check(sid, lease)
                    self._arm(sid, lease, sent, value["ttlMs"])
                    self.must_renew.discard(sid)
            except (AgentError, asyncio.CancelledError):
                self._lose(sid, lease)
                raise
            # This worker renews the session lease, not a particular turn.
            with ot.use(ot.extract(None)):
                lease["task"] = asyncio.create_task(self.renew(sid, lease, sent, value["ttlMs"]))
            lease["watcher"] = self._watch_writer(sid, lease)
            return lease["id"]

    def _watch_writer(self, sid, lease):
        # HTTP reports writer loss via renewals and the local deadline.
        return None

    async def renew(self, sid, lease, sent, ttl):
        path = self.path(sid) + "/lease/" + self.segment(lease["id"]) + "/renew"
        try:
            while True:
                await asyncio.sleep(max(0, sent + ttl / 3000 - self.margin - lease_clock()))
                self._check(sid, lease)
                sent = lease_clock()
                with ot.span("modular_agent.history.lease.renew", ot.attrs(sid)):
                    value = await self.request("POST", path)
                self._check(sid, lease)
                ttl = value["ttlMs"]
                self._arm(sid, lease, sent, ttl)
        except (AgentError, KeyError, TypeError):
            self._lose(sid, lease)

    async def close(self, d, emit):
        sid = d["session"]
        if lease := self.leases.pop(sid, None):
            if timer := lease.get("timer"):
                timer.cancel()
            tasks = [task for key in ("task", "watcher") if (task := lease.get(key))]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if task := lease.get("interrupt"):
                await asyncio.gather(task, return_exceptions=True)
            try:
                if lease.get("id"):
                    await self.request(
                        "DELETE", self.path(sid) + "/lease/" + self.segment(lease["id"])
                    )
            except AgentError:
                self.must_renew.add(sid)  # Release may not have reached the service.
        return {}

    async def stop(self):
        await asyncio.gather(*(self.close({"session": sid}, None) for sid in list(self.leases)))

    async def read(self, d, emit):
        try:
            metadata, entries = await self.pages(self.path(d["session"]), "entries")
        except ServiceError as exc:
            if exc.code == "unknown_session":
                return None
            raise
        if not entries:
            return None  # A metadata-only record is unpublished.
        defaults = None
        try:
            settings = await self.api.call("config", "load", {"project": metadata["project"]})
            defaults = {"settings": settings}
        except AgentError as exc:
            if exc.code != "unavailable":
                raise
        state = session_view(metadata, entries, defaults)
        if self.declarations.get("pending_erasure"):
            state["_history_tombstones"] = [e["id"] for e in entries if e.get("erased") is True]
            if d.get("view"):
                await self.erasure_revision(
                    {"session": d["session"], "tombstones": state["_history_tombstones"]}, emit
                )
        return state

    async def open(self, d, emit):
        await self.acquire(d["session"], wait_for_lease=d.get("wait_for_lease", True))
        try:
            result = await self.read(d, emit)
            self._check(d["session"], self.leases[d["session"]])
            if result is None:
                await self.close(d, emit)
            return result
        except BaseException:
            await self.close(d, emit)
            raise

    async def list(self, d, emit):
        query = {"project": str(Path(d["project"]).resolve())} if d.get("project") else {}
        _, sessions = await self.pages("/v1/sessions", "sessions", **query)
        return sessions

    async def keep(self, d, emit):
        s = d["session"]
        sid = s["id"]
        path = self.path(sid)
        if not d["entries"]:
            return {}
        entries = [entry_out(e) for e in d["entries"]]
        if sid not in self.leases:
            meta = {"project": s["project"], "created": s["created"]}
            origin = s.get("origin") or {}
            if origin.get("parent"):
                meta["parentSessionId"] = origin["parent"]
            elif origin.get("session") and origin.get("point"):
                if len(self.encode({"lease": "x" * 128, "entries": entries})) > 64 << 20:
                    raise AgentError("HTTP fork batch exceeds the append limit", "result_too_large")
                meta["forkedFrom"] = {"sessionId": origin["session"], "entryId": origin["point"]}
            await self.request("PUT", path, meta)
        await self.acquire(sid)
        body = {"entries": entries}
        if self.declarations.get("pending_erasure"):
            generation = self.leases[sid]
            while True:
                self._check(sid, generation)
                revision = await self.append_revision(s, entries)
                if revision is None:
                    continue
                try:
                    return await self.erasure_request(
                        sid,
                        generation,
                        path + "/entries",
                        body,
                        headers={"History-Revision": revision},
                    )
                except ServiceError as exc:
                    if exc.code != "stale_revision":
                        raise
        return await self.erasure_request(sid, self.leases[sid], path + "/entries", body)

    def erasure_lease(self, sid):
        lease = self.leases.get(sid)
        if lease is None:
            raise AgentError("Erasure requires the current writer", "lost")
        self._check(sid, lease)
        return lease

    async def erasure_request(self, sid, lease, path, data, *, headers=None):
        self._check(sid, lease)
        body = {**data, "lease": lease["id"]}
        try:
            result = await self.request(
                "POST", path, body, **({"headers": headers} if headers else {})
            )
            self._check(sid, lease)
            return result
        except ServiceError as exc:
            if exc.code == "lost":
                self._lose(sid, lease)
                exc.writer_lost = True
            raise
        except (AgentError, asyncio.CancelledError):
            self._lose(sid, lease)
            raise


def configured_history(root):
    from . import History

    if url := os.environ.get("MODULAR_AGENT_HISTORY_URL"):
        if not (token := os.environ.get("MODULAR_AGENT_HISTORY_TOKEN_FILE")):
            raise AgentError("Set MODULAR_AGENT_HISTORY_TOKEN_FILE for the history service")
        return HTTPHistory(url, token)
    return History(root)
