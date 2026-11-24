"""Loopback history/1 service. SQLite stores opaque rows, not native session projections."""

import fcntl
import hmac
import ipaddress
import json
import math
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager, nullcontext
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import unquote

from ma_core import AgentError

from . import freshness
from .registry import Registry, Unavailable

PAGE = 4 * 1024 * 1024
BODY = 64 * 1024 * 1024
LEASE = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")


class Refusal(Exception):
    def __init__(self, status, code, *, headers=None, **data):
        self.status, self.headers = status, headers or {}
        self.body = {"error": code.replace("_", " "), "code": code, **data}


def invalid():
    raise Refusal(400, "invalid_request")


def encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()


def is_id(value):
    return isinstance(value, str) and bool(value)


def decode(raw):
    if re.search(r"%(?![\da-fA-F]{2})", raw):
        invalid()
    return unquote(raw, encoding="utf-8", errors="strict")


def check_json(value, depth=1):
    if isinstance(value, dict):
        if depth > 64:
            invalid()
        for key, child in value.items():
            key.encode()
            check_json(child, depth + 1)
    elif isinstance(value, list):
        if depth > 64:
            invalid()
        for child in value:
            check_json(child, depth + 1)
    elif isinstance(value, str):
        value.encode()
    elif type(value) is float and not math.isfinite(value):
        invalid()


def equal(a, b):
    if type(a) in (int, float) and type(b) in (int, float):
        return a == b
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(equal(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(equal(x, y) for x, y in zip(a, b, strict=True))
    return a == b


def tombstone(row):
    kind = row.get("kind") if isinstance(row.get("kind"), str) else None
    out = {"id": row["id"], "parentId": row["parentId"], "kind": kind, "erased": True}
    data = row.get("data") if isinstance(row.get("data"), dict) else {}
    message = row.get("message") if isinstance(row.get("message"), dict) else {}
    request = data.get("request") if isinstance(data.get("request"), dict) else {}
    fallback = {}
    if kind in {"input", "inputAccepted", "inputHandedBack"}:
        fallback["inputId"] = data.get("inputId")
    if kind in {"inputRequest", "inputAnswer"}:
        fallback["requestId"] = data.get("requestId")
        if kind == "inputRequest" and not is_id(fallback["requestId"]):
            fallback["requestId"] = request.get("id")
    if kind == "turnStart":
        fallback["continuesTurnId"] = data.get("continuesTurnId")
    for key in (
        "turnId",
        "stepId",
        "toolCallId",
        "jobId",
        "inputId",
        "requestId",
        "continuesTurnId",
    ):
        if isinstance(row.get(key), str):
            out[key] = row[key]
        elif key not in row and is_id(fallback.get(key)):
            out[key] = fallback[key]
    if kind == "inputHandedBack" and "inputId" not in row and "inputId" not in data:
        ids = data.get("inputIds")
        if isinstance(ids, list) and ids and all(is_id(i) for i in ids):
            out["inputIds"] = ids
    sources = row.get("sources")
    if isinstance(sources, list) and all(is_id(x) for x in sources):
        out["sources"] = sources
    usage = (
        message if kind == "response" else data if kind in {"turnEnd", "jobEnded"} else {}
    ).get("usage")
    if isinstance(usage, dict):
        fields = {
            k: usage[k]
            for k in ("input", "output", "cacheRead", "cacheWrite", "cost")
            if type(usage.get(k)) in (int, float) and usage[k] >= 0
        }
        if fields:
            out["usage"] = fields
    if kind == "jobStarted" and is_id(data.get("key")) and is_id(row.get("writer")):
        out.update(writer=row["writer"], jobKey=data["key"])
    return out


def page(envelope, field, rows, query, cursor_error):
    after = query.get("after")
    if after is not None:
        start = next((i + 1 for i, (key, _) in enumerate(rows) if key == after), None)
        if start is None:
            raise Refusal(404, cursor_error)
        rows = rows[start:]
    limit = int(query.get("limit", "500"))
    used = len(encode({**envelope, field: []}))
    count = 0
    for i, (key, row) in enumerate(rows[:limit]):
        used += len(encode(row)) + bool(i)
        if used > PAGE:
            break
        more = i + 1 < len(rows)
        size = used + (len(encode({"next": key})) - 1 if more else 0)
        if size <= PAGE:
            count = i + 1
    result = rows[:count]
    if rows and not result:
        raise Refusal(503, "unavailable")
    return {
        **envelope,
        field: [row for _, row in result],
        **({"next": result[-1][0]} if len(result) < len(rows) else {}),
    }


class Store:
    def __init__(self, db, ttl_ms, witness=None, *, previously_profiled=False):
        self.db, self.ttl_ms = db, ttl_ms
        self.witness = witness
        self.leases = {}
        version = db.execute("PRAGMA user_version").fetchone()[0]
        if version != 1 and (
            version != 0
            or previously_profiled
            or db.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
        ):
            raise Unavailable("Cannot initialize an erasure registry over an existing store")
        self.db.executescript(
            "PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;"
            "CREATE TABLE IF NOT EXISTS bound (ttl INTEGER NOT NULL);"
            "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, record BLOB NOT NULL);"
            "CREATE TABLE IF NOT EXISTS entries (session TEXT, id TEXT, record BLOB NOT NULL,"
            " UNIQUE(session, id));"
        )
        self.registry = None
        try:
            with self.db:
                self.db.execute("BEGIN IMMEDIATE")
                self.registry = Registry(self.db, initialized=version == 1)
        except (Unavailable, sqlite3.Error):
            pass
        if witness is not None:
            with self.db:
                self.db.execute("BEGIN IMMEDIATE")
                freshness.provision(self.db, witness)
        prior = self.db.execute("SELECT ttl FROM bound").fetchone()
        self.hold = time.monotonic() + max(ttl_ms, prior[0]) / 1000 if prior else 0
        with self.db:
            self.db.execute("DELETE FROM bound")
            self.db.execute(
                "INSERT INTO bound VALUES (?)", (max(ttl_ms, prior[0]) if prior else ttl_ms,)
            )

    def route(self, method, route, sid, generation, q, body, *, revision=None):
        if route == "version":
            return {"binding": "modular-agent-history/1", "ttlMs": self.ttl_ms, "pendingErasure": 1}
        changes = self.db.total_changes
        try:
            result = self.apply(method, route, sid, generation, q, body, revision)
            if self.db.total_changes != changes:
                self.registry.advance()
                if self.witness is not None:
                    freshness.advance(self.db, self.witness)
            return result
        except (Unavailable, sqlite3.Error, AgentError, OSError) as exc:
            # No commit has been attempted. The request transaction rolls back.
            raise Refusal(503, "unavailable") from exc

    def current_revision(self):
        if self.registry is None:
            raise Unavailable
        if self.witness is not None:
            freshness.check(self.db, self.witness)
        return self.registry.revision()

    def entry(self, sid, key):
        row = self.db.execute(
            "SELECT record FROM entries WHERE session=? AND id=?", (sid, key)
        ).fetchone()
        return json.loads(row[0]) if row else None

    def apply(self, method, route, sid, generation, q, body, revision):
        if route == "list":
            rows = [
                (sid, json.loads(raw))
                for sid, raw in self.db.execute(
                    "SELECT id,record FROM sessions WHERE EXISTS (SELECT 1 FROM entries WHERE session = sessions.id)"
                )
            ]
            filtered = [
                (sid, meta)
                for sid, meta in rows
                if "project" not in q or q["project"] == meta["project"]
            ]
            filtered.sort(key=lambda pair: (-pair[1]["created"], pair[0].encode()))
            return page({}, "sessions", filtered, q, "unknown_session")
        existing = self.db.execute("SELECT record FROM sessions WHERE id=?", (sid,)).fetchone()
        if method == "PUT":
            meta = {**body, "id": sid}
            if (
                max(
                    len(encode({"session": meta, "entries": []})),
                    len(encode({"sessions": [meta], "next": sid})),
                )
                > PAGE
            ):
                raise Refusal(413, "request_too_large")
            if existing and not equal(json.loads(existing[0]), meta):
                raise Refusal(409, "conflict")
            if existing is None:
                if self.db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] >= 100_000:
                    raise Refusal(503, "unavailable")
                self.current_revision()
                self.db.execute("INSERT INTO sessions VALUES (?,?)", (sid, encode(meta)))
            return {}
        if route == "registry" and method == "GET":
            revision = self.current_revision()
            if existing is None:
                raise Refusal(404, "unknown_session")
            rows = [(plan["intentId"], plan) for plan in self.registry.plans(sid)]
            return page({"revision": revision}, "plans", rows, q, "unknown_intent")
        if existing is None:
            raise Refusal(404, "unknown_session")
        meta = json.loads(existing[0])
        if route == "session":
            rows = [
                (key, json.loads(raw))
                for key, raw in self.db.execute(
                    "SELECT id,record FROM entries WHERE session=? ORDER BY rowid", (sid,)
                )
            ]
            return page({"session": meta}, "entries", rows, q, "unknown_entry")
        clock = time.monotonic()
        current = self.leases.get(sid)
        if current and current[2] <= clock:
            self.leases.pop(sid, None)
            current = None
        if route == "acquire" or (route == "erase" and "lease" not in body):
            expires = max(self.hold, current[2] if current else 0)
            if expires > clock and (route == "erase" or not current or current[0] != body["owner"]):
                raise Refusal(
                    409, "held", retryAfterMs=max(1, math.ceil((expires - time.monotonic()) * 1000))
                )
            if route == "acquire":
                if not current:
                    current = self.leases[sid] = (
                        body["owner"],
                        secrets.token_urlsafe(24),
                        clock + self.ttl_ms / 1000,
                    )
                return {"lease": current[1], "ttlMs": self.ttl_ms}
        supplied = body.get("lease", generation) if body is not None else generation
        valid = current is not None and supplied == current[1]
        if route == "release":
            if valid:
                self.leases.pop(sid)
            return {}
        if (route != "erase" or supplied is not None) and not valid:
            raise Refusal(409, "lost")
        if route == "renew":
            self.leases[sid] = (current[0], current[1], clock + self.ttl_ms / 1000)
            return {"ttlMs": self.ttl_ms}
        self.db.execute("BEGIN IMMEDIATE")
        current_revision = self.current_revision()
        if route == "registry":
            return self.publish(sid, body, current_revision)
        if route == "complete":
            return self.complete(sid, generation, body["entryIds"])
        if revision is not None and revision != current_revision:
            raise Refusal(409, "stale_revision")
        if route == "erase":
            erased = []
            for key in dict.fromkeys(body["entryIds"]):
                old = self.db.execute(
                    "SELECT record FROM entries WHERE session=? AND id=?", (sid, key)
                ).fetchone()
                if old:
                    erased.append(key)
                    row = json.loads(old[0])
                    if row.get("erased") is not True:
                        self.db.execute(
                            "UPDATE entries SET record=? WHERE session=? AND id=?",
                            (encode(tombstone(row)), sid, key),
                        )
            return {"erased": erased}
        kept = 0
        for row in body["entries"]:
            key = row["id"]
            old = self.db.execute(
                "SELECT record FROM entries WHERE session=? AND id=?", (sid, key)
            ).fetchone()
            if old:
                if not equal(json.loads(old[0]), row):
                    raise Refusal(409, "conflict")
                continue
            if any(
                len(encode({"session": meta, "entries": [item], "next": key})) > PAGE
                for item in (row, tombstone(row))
            ):
                raise Refusal(413, "entry_too_large")
            self.db.execute("INSERT INTO entries VALUES (?,?,?)", (sid, key, encode(row)))
            kept += 1
        return {"kept": kept}

    def publish(self, sid, body, revision):
        registry = self.registry
        intent = body["intentId"]
        targets = json.dumps(sorted(body["entryIds"]))
        sets = {c["sessionId"]: (c["recordId"], set(c["entryIds"])) for c in body["copies"]}
        if saved := registry.intent(intent):
            if saved != (sid, targets) or registry.copy_sets(intent) != sets:
                raise Refusal(409, "conflict")
            return {"intentId": intent, "sessionIds": registry.destinations(intent, sid)}
        if saved := registry.operation(sid, targets):
            original = saved[0]
            return {"intentId": original, "sessionIds": registry.destinations(original, sid)}
        if body["revision"] != revision:
            raise Refusal(409, "stale_revision")
        for destination in sets:
            if not self.db.execute("SELECT 1 FROM sessions WHERE id=?", (destination,)).fetchone():
                raise Refusal(404, "unknown_session")
        plans = {}
        for copy_set in body["copies"]:
            destination = copy_set["sessionId"]
            record = copy_set["recordId"]
            entries = copy_set["entryIds"]
            if any(self.entry(destination, key) is None for key in entries):
                raise Refusal(404, "unknown_entry")
            if (
                registry.reserved(destination, record)
                or self.entry(destination, record) is not None
            ):
                raise Refusal(409, "conflict")
            plan = {
                "intentId": intent,
                "sourceSessionId": sid,
                "recordId": record,
                "copies": [{"entryId": key, "complete": False} for key in entries],
            }
            if len(encode({"revision": "x" * 128, "plans": [plan], "next": intent})) > PAGE:
                raise Refusal(413, "request_too_large")
            plans[destination] = plan
        registry.publish(sid, targets, intent, plans)
        return {"intentId": intent, "sessionIds": list(plans)}

    def complete(self, sid, intent, entries):
        plan = next((p for p in self.registry.plans(sid) if p["intentId"] == intent), None)
        if plan is None:
            raise Refusal(404, "unknown_intent")
        if not set(entries) <= {c["entryId"] for c in plan["copies"]}:
            invalid()
        record = self.entry(sid, plan["recordId"]) or {}
        data = record.get("data")
        evidence = data.get("entryIds") if isinstance(data, dict) else None
        if (
            record.get("erased") is True
            or record.get("kind") != "erasure"
            or not isinstance(evidence, list)
            or any(key not in evidence for key in entries)
            or any((self.entry(sid, key) or {}).get("erased") is not True for key in entries)
        ):
            raise Refusal(409, "conflict")
        self.registry.complete(sid, plan, set(entries))
        return {}


def distinct_ids(values):
    return (
        isinstance(values, list)
        and bool(values)
        and all(is_id(x) for x in values)
        and len(set(values)) == len(values)
    )


def shape(route, method, body, sid):
    if method == "PUT":
        if (
            "id" in body
            or not isinstance(body.get("project"), str)
            or type(body.get("created")) is not int
            or not 0 <= body["created"] <= 2**53 - 1
        ):
            invalid()
        if "parentSessionId" in body and not is_id(body["parentSessionId"]):
            invalid()
        if "forkedFrom" in body:
            f = body["forkedFrom"]
            if not isinstance(f, dict) or not all(
                is_id(f.get(k)) for k in ("sessionId", "entryId")
            ):
                invalid()
    elif route in {"registry", "complete"}:
        lease = body.get("lease")
        if (
            not isinstance(lease, str)
            or not LEASE.fullmatch(lease)
            or not distinct_ids(body.get("entryIds"))
        ):
            invalid()
        if route == "complete":
            if set(body) != {"lease", "entryIds"}:
                invalid()
            return
        if set(body) != {"lease", "revision", "intentId", "entryIds", "copies"}:
            invalid()
        if not isinstance(body["revision"], str) or not LEASE.fullmatch(body["revision"]):
            invalid()
        if not is_id(body["intentId"]) or body["intentId"] in {".", ".."}:
            invalid()
        copies = body["copies"]
        if not isinstance(copies, list) or not copies:
            invalid()
        sessions = set()
        for copy_set in copies:
            if not isinstance(copy_set, dict) or set(copy_set) != {
                "sessionId",
                "recordId",
                "entryIds",
            }:
                invalid()
            destination = copy_set["sessionId"]
            if (
                not is_id(destination)
                or destination in {".", ".."}
                or destination in sessions
                or not is_id(copy_set["recordId"])
                or not distinct_ids(copy_set["entryIds"])
            ):
                invalid()
            sessions.add(destination)
            if destination == sid and not set(body["entryIds"]) <= set(copy_set["entryIds"]):
                invalid()
        if sid not in sessions:
            invalid()
    elif route == "acquire":
        if not is_id(body.get("owner")):
            invalid()
    elif route in {"append", "erase"}:
        if route == "append" or "lease" in body:
            lease = body.get("lease")
            if not isinstance(lease, str) or not LEASE.fullmatch(lease):
                invalid()
        values = body.get("entries" if route == "append" else "entryIds")
        if not isinstance(values, list):
            invalid()
        if route == "append":
            for row in values:
                if (
                    not isinstance(row, dict)
                    or not is_id(row.get("id"))
                    or "parentId" not in row
                    or (row["parentId"] is not None and not is_id(row["parentId"]))
                    or row.get("erased") is True
                ):
                    invalid()
        elif not all(is_id(key) for key in values):
            invalid()


@contextmanager
def sqlite_store(directory, ttl_ms, *, check_same_thread=True, witness=None):
    root = Path(directory) / "history-service"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    # One service instance per store: monotonic lease state is local. No other
    # instance may serve the same records until the prior instance loses its lock.
    with (root / "service.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        from contextlib import closing

        with closing(
            sqlite3.connect(root / "records.db", check_same_thread=check_same_thread)
        ) as db:
            lock.seek(0)
            previously_profiled = bool(lock.read())
            store = Store(db, ttl_ms, witness, previously_profiled=previously_profiled)
            if not previously_profiled and db.execute("PRAGMA user_version").fetchone()[0] == 1:
                import os

                lock.write("pendingErasure: 1\n")
                lock.flush()
                os.fsync(lock.fileno())
            yield store


def serve(
    directory,
    address,
    token_file,
    ttl_ms,
    *,
    ready=None,
    custom_route=None,
    started=None,
    witness=None,
):
    ip = ipaddress.ip_address(address[0])
    if not ip.is_loopback or type(ttl_ms) is not int or not 0 < ttl_ms <= 2**53 - 1:
        raise ValueError("History service requires a numeric loopback address and positive TTL")
    token = Path(token_file).read_bytes().strip(b" \t\r\n")
    if not re.fullmatch(rb"[A-Za-z0-9._~+/\-]{22,}=*", token):
        raise ValueError("Use a bearer token generated with at least 128 bits of entropy")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass  # Paths may contain lease values.

        def __getattr__(self, name):
            if name.startswith("do_"):
                return self.handle_method
            raise AttributeError(name)

        def handle_method(self):
            try:
                if store is None:
                    result = self.route()
                else:
                    with store.db:
                        result = self.route()
                status = 200
                headers = {"Cache-Control": "no-store"} if "plans" in result else {}
            except Refusal as exc:
                status, result, headers = exc.status, exc.body, exc.headers
            except (UnicodeError, ValueError, RecursionError):
                status, result, headers = (
                    400,
                    {"error": "Invalid request", "code": "invalid_request"},
                    {},
                )
            except Exception:
                # The caller cannot use an error as evidence that commit did not happen.
                self.close_connection = True
                return
            body = encode(result)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            for key, value in headers.items():
                self.send_header(key, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def route(self):
            auth = self.headers.get("Authorization", "").encode("latin-1")
            if not hmac.compare_digest(auth, b"Bearer " + token):
                raise Refusal(401, "unauthorized", headers={"WWW-Authenticate": "Bearer"})
            # BaseHTTPRequestHandler may normalize a leading // in self.path.
            target = self.requestline.split()[1]
            raw_path, _, query = target.partition("?")
            parts = [decode(part) for part in raw_path.split("/")]
            sid = generation = None
            if parts == ["", "v1"]:
                route, methods = "version", ("GET",)
            elif parts == ["", "v1", "sessions"]:
                route, methods = "list", ("GET",)
            elif len(parts) >= 4 and parts[:3] == ["", "v1", "sessions"]:
                sid = parts[3]
                match parts[4:]:
                    case []:
                        route, methods = "session", ("GET", "PUT")
                    case ["lease"]:
                        route, methods = "acquire", ("POST",)
                    case ["pending-erasure"] if store is not None:
                        route, methods = "registry", ("GET", "POST")
                    case ["pending-erasure", generation, "complete"] if store is not None:
                        route, methods = "complete", ("POST",)
                    case [generation]:
                        routes = {"entries": "append", "erase": "erase"}
                        if generation not in routes:
                            raise Refusal(404, "not_found")
                        route, methods = routes[generation], ("POST",)
                        generation = None
                    case ["lease", generation]:
                        route, methods = "release", ("DELETE",)
                    case ["lease", generation, "renew"]:
                        route, methods = "renew", ("POST",)
                    case _:
                        raise Refusal(404, "not_found")
            else:
                raise Refusal(404, "not_found")
            method = self.command
            if method not in methods:
                raise Refusal(405, "method_not_allowed", headers={"Allow": ", ".join(methods)})
            size = int(self.headers.get("Content-Length", "0"))
            if size > BODY:
                raise Refusal(413, "request_too_large")
            if "Content-Encoding" in self.headers or (
                size > 0 and self.headers.get_content_type() != "application/json"
            ):
                raise Refusal(415, "unsupported_media_type")
            if (
                size < 0
                or "Transfer-Encoding" in self.headers
                or (sid is not None and sid in {"", ".", ".."})
                or (route == "complete" and generation in {"", ".", ".."})
                or (route in {"renew", "release"} and not LEASE.fullmatch(generation))
            ):
                invalid()
            q = {}
            if query:
                allowed = (
                    {"project", "after", "limit"}
                    if route == "list"
                    else {"after", "limit"}
                    if route in {"session", "registry"} and method == "GET"
                    else set()
                )
                for item in query.split("&"):
                    key, equals, val = item.partition("=")
                    key, val = decode(key), decode(val)
                    if not equals or key not in allowed or key in q:
                        invalid()
                    q[key] = val
                if "limit" in q and (
                    not re.fullmatch(r"[0-9]{1,3}", q["limit"]) or not 1 <= int(q["limit"]) <= 500
                ):
                    invalid()
                if "after" in q and not q["after"]:
                    invalid()
            revision = None
            if route == "append" and store is not None:
                revisions = self.headers.get_all("History-Revision", [])
                if len(revisions) > 1 or (revisions and not LEASE.fullmatch(revisions[0])):
                    invalid()
                if revisions:
                    revision = revisions[0]
            body = None
            if method == "PUT" or (
                method == "POST" and route in {"acquire", "append", "erase", "registry", "complete"}
            ):
                body = json.loads(self.rfile.read(size).decode("utf-8"))
                if not isinstance(body, dict):
                    invalid()
                check_json(body)
                shape(route, method, body, sid)
            elif size:
                invalid()
            if store is not None:
                return store.route(method, route, sid, generation, q, body, revision=revision)
            return custom_route(method, route, sid, generation, q, body)

    with (
        sqlite_store(directory, ttl_ms, witness=witness)
        if custom_route is None
        else nullcontext() as store
    ):
        if ip.version == 6:
            import socket

            class Server(HTTPServer):
                address_family = socket.AF_INET6
        else:
            Server = HTTPServer
        with Server(address, Handler) as server:
            if ready is not None:
                ready(server.server_address)
            if started is not None:
                started(server.server_address, server.shutdown)
            server.serve_forever()
