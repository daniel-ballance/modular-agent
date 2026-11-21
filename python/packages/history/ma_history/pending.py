"""Content-free intent in the same SQLite transaction domain as native history."""

import json
from collections import defaultdict, deque

from ma_core import AgentError, identity
from ma_core.wire import entry_in

PROTECTED = {
    "tenant",
    "limit",
    "authority",
    "actor_joined",
    "actor_left",
    "position_move",
    "erase",
    "job_cleanup_unconfirmed",
}


def schema(db):
    db.execute(
        "CREATE TABLE IF NOT EXISTS erase_intents (id TEXT PRIMARY KEY, source TEXT, targets TEXT, UNIQUE(source, targets))"
    )
    db.execute(
        "CREATE TABLE IF NOT EXISTS erase_copies (intent TEXT, session TEXT, entry TEXT, confirmed INTEGER DEFAULT 0, PRIMARY KEY(intent, session, entry))"
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS erase_copies_session ON erase_copies(session, confirmed)"
    )
    db.execute("CREATE INDEX IF NOT EXISTS erase_copies_entry ON erase_copies(entry)")


def publish(db, source, targets):
    key = json.dumps(sorted(set(targets)))
    old = db.execute(
        "SELECT id FROM erase_intents WHERE source=? AND targets=?", (source, key)
    ).fetchone()
    if old:
        return old[0]
    records = {
        row["id"]: row
        for sid, value in db.execute("SELECT session, record FROM entries")
        for row in [entry_in(json.loads(value), sid)]
    }
    for eid in targets:
        if eid not in records or records[eid]["session"] != source:
            raise AgentError("Unknown erasure entry", "not_found")
    edges = defaultdict(set)
    for eid, row in records.items():
        for parent in row["copies"]:
            edges[parent].add(eid)
        if row.get("fork_source"):
            edges[row["fork_source"]].add(eid)
            edges[eid].add(row["fork_source"])
        if row["kind"] == "input_queued":
            admission = row["data"].get("input") or eid
            if admission != eid:
                edges[admission].add(eid)
                edges[eid].add(admission)
        if row["kind"] in {"input", "input_handled", "input_withdrawn"}:
            admission = row["data"].get("input")
            if admission:
                edges[admission].add(eid)
                edges[eid].add(admission)
    todo = deque(targets)
    found = set()
    while todo:
        eid = todo.popleft()
        if eid in found or eid not in records:
            continue
        if records[eid]["kind"] in PROTECTED:
            raise AgentError("Cannot erase records of authority or control", "forbidden")
        found.add(eid)
        todo.extend(edges[eid] - found)
    intent = identity()
    db.execute("INSERT INTO erase_intents VALUES (?,?,?)", (intent, source, key))
    db.executemany(
        "INSERT INTO erase_copies (intent,session,entry) VALUES (?,?,?)",
        [(intent, records[eid]["session"], eid) for eid in sorted(found)],
    )
    return intent


def copies(db, *, intent=None, session=None):
    if intent is not None:
        where, key = "intent=?", intent
    else:
        where, key = "session=? AND confirmed=0", session
    return [
        {"intent": iid, "sessionId": sid, "id": eid, "confirmed": bool(done)}
        for iid, sid, eid, done in db.execute(
            f"SELECT intent,session,entry,confirmed FROM erase_copies WHERE {where} ORDER BY rowid",
            (key,),
        )
    ]


def revision(db, session):
    version, unresolved = db.execute(
        "SELECT COUNT(DISTINCT intent), MAX(confirmed=0) FROM erase_copies WHERE session=?",
        (session,),
    ).fetchone()
    if unresolved:
        raise AgentError("Session content is pending erasure", "unavailable")
    return version


def check_batch(db, entries):
    for entry in entries:
        if (entry.get("data") or {}).get("erased") or entry["kind"] in {"erase", "erasure"}:
            continue
        copies = entry.get("copies")
        deps = (
            {item for item in copies if isinstance(item, str)}
            if isinstance(copies, list)
            else set()
        )
        if isinstance(entry.get("fork_source"), str):
            deps.add(entry["fork_source"])
        if any(
            db.execute("SELECT 1 FROM erase_copies WHERE entry=? LIMIT 1", (source,)).fetchone()
            for source in deps
        ):
            raise AgentError("Cannot publish a copy of erased or pending content", "unavailable")
