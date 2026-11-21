"""A witness kept outside any history database backup."""

import os
import secrets
from pathlib import Path
from tempfile import NamedTemporaryFile

from ma_core import AgentError


def _read(path):
    return Path(path).read_text(encoding="ascii").strip()


def _write(path, value):
    path = Path(path)
    with NamedTemporaryFile(dir=path.parent, delete=False) as tmp:
        name = tmp.name
        try:
            tmp.write((value + "\n").encode("ascii"))
            tmp.flush()
            os.fsync(tmp.fileno())
            os.replace(name, path)
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            Path(name).unlink(missing_ok=True)


def provision(db, path):
    """Call under the database's write lock. Never reseed a prior store."""
    db.execute("CREATE TABLE IF NOT EXISTS erase_freshness (stamp TEXT NOT NULL)")
    if db.execute("SELECT stamp FROM erase_freshness").fetchone() is None:
        if Path(path).exists() or db.execute("SELECT 1 FROM entries LIMIT 1").fetchone():
            raise AgentError("Cannot initialize a witness for existing history", "unavailable")
        advance(db, path)
    check(db, path)


def check(db, path):
    row = db.execute("SELECT stamp FROM erase_freshness").fetchone()
    if row is None or row[0] != _read(path):
        raise AgentError("History freshness witness does not match", "unavailable")


def advance(db, path):
    stamp = secrets.token_hex(32)
    db.execute("DELETE FROM erase_freshness")
    db.execute("INSERT INTO erase_freshness VALUES (?)", (stamp,))
    # Witness first: a crash before the DB commit must fail closed. A restored
    # older database cannot roll the witness back with its records.
    _write(path, stamp)
