"""SQLite history with one writer per open session, lazy files and physical erasure."""

import fcntl
import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from ma_core import AgentError, Plugin, clone
from ma_core.wire import entry_in, entry_out

from .portable import session_view


class History(Plugin):
    name = "history"
    role = "history_store"
    declarations = {"erasure": True, "retention": "indefinite", "single_writer": True}

    def __init__(self, root):
        self.root = Path(root)
        self.db = self.root / "history.sqlite3"
        self.locks = {}

    async def start(self, api):
        await super().start(api)
        api.provide("history", self)

    @contextmanager
    def _connect(self):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        db = sqlite3.connect(self.db)
        os.chmod(self.db, 0o600)
        db.execute("PRAGMA secure_delete=ON")
        db.execute(
            "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project TEXT, meta TEXT)"
        )
        db.execute(
            "CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, session TEXT, record TEXT)"
        )
        try:
            with db:
                yield db
        finally:
            db.close()

    def _lock(self, sid):
        if sid in self.locks:
            return
        if not sid.isalnum():
            raise AgentError("Invalid session ID")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(self.root / (sid + ".lock"), os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise AgentError("Session already has a writer", "locked") from None
        self.locks[sid] = fd

    def _read(self, db, sid):
        row = db.execute("SELECT meta FROM sessions WHERE id=?", (sid,)).fetchone()
        if not row:
            return None
        s = json.loads(row[0])
        for flag in ("busy", "suspending", "closing", "moving", "writer_lost"):
            s.pop(flag, None)
        records = [
            json.loads(x[0])
            for x in db.execute("SELECT record FROM entries WHERE session=? ORDER BY rowid", (sid,))
        ]
        return session_view({"id": sid, "project": s["project"]}, records, s)

    async def writable(self, d, emit):
        # A local writer lock has no expiry. The Harness has the interruption latch.
        return {}

    async def keep(self, d, emit):
        s = clone(d["session"])
        self._lock(s["id"])
        s.pop("entries")
        for flag in ("busy", "suspending", "closing", "moving", "writer_lost"):
            s.pop(flag, None)
        with self._connect() as db:
            for e in d["entries"]:
                value = json.dumps(entry_out(e), sort_keys=True)
                old = db.execute("SELECT record FROM entries WHERE id=?", (e["id"],)).fetchone()
                if old:
                    previous = json.loads(old[0])
                    if entry_out(previous) != json.loads(value):
                        raise AgentError("Entry ID reused with different content")
                db.execute(
                    "INSERT OR IGNORE INTO entries VALUES (?,?,?)", (e["id"], s["id"], value)
                )
            db.execute(
                "INSERT INTO sessions VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET meta=excluded.meta",
                (s["id"], s["project"], json.dumps(s)),
            )
        return {}

    async def read(self, d, emit):
        if not self.db.exists():
            return None
        with self._connect() as db:
            return self._read(db, d["session"])

    async def open(self, d, emit):
        self._lock(d["session"])
        s = await self.read(d, emit)
        if s is None:
            await self.close(d, emit)
            raise AgentError("Unknown session")
        return s

    async def list(self, d, emit):
        if not self.db.exists():
            return []
        with self._connect() as db:
            rows = db.execute(
                "SELECT id, project, meta, (SELECT record FROM entries "
                "WHERE session = sessions.id ORDER BY rowid DESC LIMIT 1) FROM sessions"
            ).fetchall()
            project = str(Path(d["project"]).resolve()) if d.get("project") else None
            return [
                {
                    "id": sid,
                    "project": p,
                    "position": json.loads(meta)["position"],
                    "lastActivity": json.loads(last or "{}").get("time", 0),
                }
                for sid, p, meta, last in rows
                if project is None or p == project
            ]

    async def erase(self, d, emit):
        self._lock(d["session"])
        with self._connect() as db:
            records = [
                entry_in(json.loads(record), sid)
                for sid, record in db.execute("SELECT session,record FROM entries")
            ]
            by_id = {e["id"]: e for e in records}
            targets = set(d["entries"])
            if any(x not in by_id or by_id[x]["session"] != d["session"] for x in targets):
                raise AgentError("Unknown erasure entry")
            # A visible input and its admission receipt contain the same payload.
            # Erasing either must reach both, including receipts in copied branches.
            targets.update(
                by_id[x].get("data", {}).get("input")
                for x in list(targets)
                if by_id[x]["kind"] == "input"
            )
            targets.discard(None)
            changed = True
            while changed:
                changed = False
                for e in records:
                    if e["id"] in targets:
                        source = e.get("fork_source")
                        receipt = e.get("data", {}).get("input") if e["kind"] == "input" else None
                        for linked in (source, receipt):
                            if linked in by_id and linked not in targets:
                                targets.add(linked)
                                changed = True
                    if e["id"] not in targets and targets.intersection(e["copies"]):
                        targets.add(e["id"])
                        changed = True
            # Copies held by another writer must not be changed behind its back.
            acquired = []
            try:
                for sid in {by_id[x]["session"] for x in targets} - set(self.locks):
                    self._lock(sid)
                    acquired.append(sid)
                for eid in targets:
                    e = by_id[eid]
                    e["data"] = {
                        "erased": True,
                        "originalKind": e["data"].get("originalKind", entry_out(e)["kind"]),
                    }
                    db.execute(
                        "UPDATE entries SET record=? WHERE id=?", (json.dumps(entry_out(e)), eid)
                    )
                db.commit()
                db.execute("VACUUM")
            finally:
                for sid in acquired:
                    await self.close({"session": sid}, emit)
        return {
            "erased": sorted(targets),
            "sessions": sorted({by_id[x]["session"] for x in targets}),
        }

    async def close(self, d, emit):
        fd = self.locks.pop(d["session"], None)
        if fd is not None:
            os.close(fd)
        return {}

    async def stop(self):
        for fd in self.locks.values():
            os.close(fd)
        self.locks.clear()
