"""The HTTP profile registry, in the same commit as opaque history records."""

import json
import secrets
import sqlite3


class Unavailable(Exception):
    pass


class Registry:
    def __init__(self, db, *, initialized):
        self.db = db
        if not initialized:
            db.execute(
                "CREATE TABLE registry_revision (id INTEGER PRIMARY KEY, value TEXT NOT NULL)"
            )
            db.execute(
                "CREATE TABLE registry_intents (id TEXT UNIQUE NOT NULL, source TEXT NOT NULL, "
                "targets TEXT NOT NULL, UNIQUE(source, targets))"
            )
            db.execute(
                "CREATE TABLE registry_plans (intent TEXT NOT NULL, session TEXT NOT NULL, "
                "record TEXT NOT NULL, copies BLOB NOT NULL, PRIMARY KEY(intent, session), "
                "UNIQUE(session, record))"
            )
            db.execute("INSERT INTO registry_revision VALUES (1, ?)", (secrets.token_urlsafe(32),))
            db.execute("PRAGMA user_version=1")

    def revision(self):
        try:
            row = self.db.execute("SELECT value FROM registry_revision WHERE id=1").fetchone()
            # Detect a missing table even before the first plan is read.
            self.db.execute("SELECT id, source, targets FROM registry_intents LIMIT 0")
            self.db.execute("SELECT intent, session, record, copies FROM registry_plans LIMIT 0")
            if row is not None and isinstance(row[0], str) and len(row[0]) == 43:
                return row[0]
        except sqlite3.Error as exc:
            raise Unavailable from exc
        raise Unavailable

    def advance(self):
        self.db.execute(
            "UPDATE registry_revision SET value=? WHERE id=1", (secrets.token_urlsafe(32),)
        )

    def plans(self, session):
        try:
            return [
                {
                    "intentId": intent,
                    "sourceSessionId": source,
                    "recordId": record,
                    "copies": json.loads(copies),
                }
                for intent, source, record, copies in self.db.execute(
                    "SELECT p.intent, i.source, p.record, p.copies FROM registry_plans p "
                    "JOIN registry_intents i ON i.id=p.intent WHERE p.session=? ORDER BY i.rowid",
                    (session,),
                )
            ]
        except (sqlite3.Error, ValueError, TypeError) as exc:
            raise Unavailable from exc

    def intent(self, intent):
        return self.db.execute(
            "SELECT source, targets FROM registry_intents WHERE id=?", (intent,)
        ).fetchone()

    def operation(self, source, targets):
        return self.db.execute(
            "SELECT id FROM registry_intents WHERE source=? AND targets=?", (source, targets)
        ).fetchone()

    def destinations(self, intent, source):
        # Every copy set's session, the source's own included, in published order.
        return [
            session
            for (session,) in self.db.execute(
                "SELECT session FROM registry_plans WHERE intent=? ORDER BY rowid", (intent,)
            )
        ]

    def copy_sets(self, intent):
        return {
            session: (record, {copy["entryId"] for copy in json.loads(copies)})
            for session, record, copies in self.db.execute(
                "SELECT session, record, copies FROM registry_plans WHERE intent=?", (intent,)
            )
        }

    def reserved(self, session, record):
        return (
            self.db.execute(
                "SELECT 1 FROM registry_plans WHERE session=? AND record=?", (session, record)
            ).fetchone()
            is not None
        )

    def publish(self, source, targets, intent, plans):
        self.db.execute("INSERT INTO registry_intents VALUES (?,?,?)", (intent, source, targets))
        self.db.executemany(
            "INSERT INTO registry_plans (intent, session, record, copies) VALUES (?,?,?,?)",
            [(intent, sid, p["recordId"], json.dumps(p["copies"])) for sid, p in plans.items()],
        )

    def complete(self, session, plan, targets):
        changed = False
        for copy in plan["copies"]:
            if copy["entryId"] in targets and not copy["complete"]:
                copy["complete"] = changed = True
        if changed:
            self.db.execute(
                "UPDATE registry_plans SET copies=? WHERE intent=? AND session=?",
                (json.dumps(plan["copies"]), plan["intentId"], session),
            )
