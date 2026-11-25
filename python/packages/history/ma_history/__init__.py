"""SQLite history with one writer per open session, lazy files and physical erasure."""

import fcntl
import json
import os
import sqlite3
import stat
import sys
from contextlib import contextmanager
from pathlib import Path

from ma_core import AgentError, Plugin
from ma_core.wire import entry_out

from . import pending
from .portable import session_view
from .service import tombstone


class History(Plugin):
    name = "history"
    role = "history_store"
    declarations = {
        "erasure": True,
        "pending_erasure": True,
        "retention": "indefinite",
        "single_writer": True,
        "observes_writer": sys.platform == "linux",
    }

    def __init__(self, root):
        self.root = Path(root)
        self.db = self.root / "history.sqlite3"
        self.locks = {}
        self.connection = None
        self.file_stat = None

    async def start(self, api):
        await super().start(api)
        api.provide("history", self)

    def _open(self):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        db = sqlite3.connect(self.db)
        try:
            os.chmod(self.db, 0o600)
            db.execute("PRAGMA secure_delete=ON")
            db.execute(
                "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project TEXT, meta TEXT)"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, session TEXT, record TEXT)"
            )
            pending.schema(db)
            self.file_stat = self.db.stat()
        except BaseException:
            db.close()
            raise
        return db

    @contextmanager
    def _connect(self):
        if self.connection is None:
            self.connection = self._open()
        elif not os.path.samestat(self.file_stat, self.db.stat()):
            raise AgentError("History database was replaced", "unavailable")
        # Each operation ends its transaction before yielding the event loop.
        # Reuse the connection, not a read snapshot or an erasure revision.
        with self.connection:
            yield self.connection

    def _lock(self, sid):
        if sid in self.locks:
            return
        if not sid.isalnum():
            raise AgentError("Invalid session ID")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(self.root / (sid + ".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise AgentError("Session already has a writer", "locked") from None
        if sys.platform == "linux":
            # A hint, not a lease. Readers must confirm the descriptor still
            # names this inode and still holds its flock. A crash leaves no lock.
            info = os.fstat(fd)
            if stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                try:
                    os.pwrite(fd, f"{os.getpid()} {fd}\n".encode(), 0)
                except OSError:
                    pass  # The kernel lock, not discovery metadata, owns the write.
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
        s = dict(d["session"])
        self._lock(s["id"])
        for flag in ("busy", "suspending", "closing", "moving", "writer_lost"):
            s.pop(flag, None)
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            pending.check_batch(db, d["entries"])
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

    async def writer_present(self, d, emit):
        # proc_pid_fdinfo(5) reports the locks of this open file description.
        # Do not try a lock: even a shared lock could exclude the next writer.
        path = self.root / (d["session"] + ".lock")
        try:
            with path.open("rb") as hint:
                fields = hint.readline(64).split()
                if len(fields) != 2 or not all(field.isdigit() for field in fields):
                    return False
                pid, fd = (field.decode("ascii") for field in fields)
                process = Path("/proc") / pid
                info = (process / "fdinfo" / fd).read_bytes()
                return os.path.samestat(
                    os.fstat(hint.fileno()), (process / "fd" / fd).stat()
                ) and any(
                    line.split()[2:5] == [b"FLOCK", b"ADVISORY", b"WRITE"]
                    for line in info.splitlines()
                    if line.startswith(b"lock:")
                )
        except OSError:
            return False  # No positive evidence of a live writer in this namespace.

    async def open(self, d, emit):
        self._lock(d["session"])
        try:
            s = await self.read(d, emit)
            if s is None:
                raise AgentError("Unknown session")
            return s
        except BaseException:
            await self.close(d, emit)
            raise

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
                    "position": state["position"],
                    "model": state.get("settings", {}).get("model"),
                    "lastActivity": json.loads(last or "{}").get("time", 0),
                }
                for sid, p, meta, last in rows
                for state in [json.loads(meta)]
                if project is None or p == project
            ]

    async def publish_erasure(self, d, emit):
        if d["session"] not in self.locks or not self.db.exists():
            raise AgentError("Pending-erasure state is unavailable", "unavailable")
        try:
            with self._connect() as db:
                db.execute("BEGIN IMMEDIATE")
                intent = pending.publish(db, d["session"], d["entries"])
                return pending.copies(db, intent=intent)
        except (OSError, sqlite3.Error) as exc:
            raise AgentError("Pending-erasure state is unavailable", "unavailable") from exc

    async def pending_erasure(self, d, emit):
        if not self.db.exists():
            if self.locks:
                raise AgentError("Pending-erasure state is unavailable", "unavailable")
            return []
        try:
            with self._connect() as db:
                return pending.copies(db, session=d["session"])
        except (OSError, sqlite3.Error) as exc:
            raise AgentError("Pending-erasure state is unavailable", "unavailable") from exc

    async def erasure_revision(self, d, emit):
        if not self.db.exists():
            if self.locks:
                raise AgentError("Pending-erasure state is unavailable", "unavailable")
            return 0
        try:
            with self._connect() as db:
                revision, unresolved = db.execute(
                    "SELECT COUNT(DISTINCT intent), MAX(confirmed=0) FROM erase_copies WHERE session=?",
                    (d["session"],),
                ).fetchone()
                if unresolved:
                    raise AgentError("Session content is pending erasure", "unavailable")
                return revision
        except (OSError, sqlite3.Error) as exc:
            raise AgentError("Pending-erasure state is unavailable", "unavailable") from exc

    async def erase(self, d, emit):
        sid = d["session"]
        if sid not in self.locks:
            raise AgentError("Erasure requires the current writer", "lost")
        confirmed = []
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            for eid in dict.fromkeys(d["entries"]):
                value = db.execute(
                    "SELECT record FROM entries WHERE session=? AND id=?", (sid, eid)
                ).fetchone()
                if value is None:
                    continue
                row = json.loads(value[0])
                if not row.get("erased"):
                    db.execute(
                        "UPDATE entries SET record=? WHERE session=? AND id=?",
                        (json.dumps(tombstone(row)), sid, eid),
                    )
                confirmed.append(eid)
                if d.get("intent"):
                    db.execute(
                        "UPDATE erase_copies SET confirmed=1 WHERE intent=? AND session=? AND entry=?",
                        (d["intent"], sid, eid),
                    )
        return {"erased": confirmed}

    async def close(self, d, emit):
        fd = self.locks.pop(d["session"], None)
        if fd is not None:
            os.close(fd)
        return {}

    async def stop(self):
        for fd in self.locks.values():
            os.close(fd)
        self.locks.clear()
        if self.connection is not None:
            self.connection.close()
            self.connection = None
