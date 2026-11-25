import json
import sqlite3
import sys
from contextlib import closing
from pathlib import Path


def omit(value):
    if isinstance(value, dict):
        value.pop("approval", None)
        if value.get("kind") == "setting" and value["data"].get("key") == "approval":
            # Keep the entry so later entries can still name it as their parent.
            value["data"] = {"key": "settings", "value": {}}
        for child in value.values():
            omit(child)
    elif isinstance(value, list):
        for child in value:
            omit(child)
    return value


def rewrite(path):
    if path.suffix == ".sqlite3":
        with closing(sqlite3.connect(path)) as db, db:
            for table, column in [("sessions", "meta"), ("entries", "record")]:
                rows = db.execute(f"SELECT id, {column} FROM {table}").fetchall()
                db.executemany(
                    f"UPDATE {table} SET {column} = ? WHERE id = ?",
                    [(json.dumps(omit(json.loads(record))), row_id) for row_id, record in rows],
                )
    elif path.suffix == ".jsonl":
        lines = path.read_text().splitlines()
        path.write_text("".join(json.dumps(omit(json.loads(line))) + "\n" for line in lines))
    else:
        path.write_text(json.dumps(omit(json.loads(path.read_text()))))


state = Path(sys.argv[1])
files = sorted((state / "sessions").glob("*.json"))
files += sorted((state / "history").glob("*/*.jsonl"))
sqlite = state / "sessions" / "history.sqlite3"
if sqlite.is_file():
    files.append(sqlite)
if len(files) != 1:
    raise SystemExit(f"expected one saved history, found {files}")
rewrite(files[0])
