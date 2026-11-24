"""Deployment-local transport markers. History is the commit record for the link."""

from __future__ import annotations

import json
import os
import sqlite3
from contextlib import closing, contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Iterator
from uuid import uuid4

from ma_core.wire import entry_out, recorded_as
from ma_harness.interface_tools import branch_entries, continuation_origin, same_json
from ma_questions import question_state

from ._agui_waits import question_fact, tool_fact
from ._agui_wire import Obj, event, fingerprint, require, triad

if TYPE_CHECKING:
    from ._agui import View


def input_key(client: str, run: str) -> str:
    return "agui:" + json.dumps([client, run], separators=(",", ":"))


def receipt_key(v: View, run: str) -> bytes:
    return fingerprint([v.sid, v.actor, v.principal["actor"]["kind"], v.client, run])


def work_records(entries: list[Obj], anchor: Obj) -> tuple[list[Obj], Obj | None]:
    """The acceptance, its opening, and only the turn this exchange followed."""
    records = [anchor]
    kind, data = anchor["kind"], anchor["data"]
    if kind == "input_queued":
        iid = data.get("input") or anchor["id"]
        turn = None
        for e in entries:
            d = e["data"]
            if recorded_as(e, "input_withdrawn") and iid in (
                d.get("inputIds") or [d.get("input") or d.get("inputId")]
            ):
                return [anchor, e], e
            if recorded_as(e, "input") and (d.get("input") or d.get("inputId")) == iid:
                records.append(e)
                turn = e.get("turn")
                break
    else:
        turn = anchor.get("turn")
        before = entries[: entries.index(anchor)]
        if kind == "question_answer":
            records.extend(
                e
                for e in before
                if e["kind"] == "question_open" and e["data"]["id"] == data["request"]
            )
        records.extend(e for e in before if e["id"] in anchor["copies"])
        origin = next(
            (e for e in before if recorded_as(e, "turn_end") and e.get("turn") == turn), None
        )
        if origin:
            records.append(origin)
            start = next(
                (
                    e
                    for e in entries
                    if e["kind"] == "turn_start" and continuation_origin(e) == turn
                ),
                None,
            )
            turn = start["turn"] if start else None
    if turn:
        records.extend(e for e in entries if e["kind"] == "turn_start" and e.get("turn") == turn)
        end = next(
            (e for e in entries if recorded_as(e, "turn_end") and e.get("turn") == turn), None
        )
        if end:
            return [*records, end], end
    return records, None


class ReceiptStore:
    """Reserve a random source ID and a fixed-size terminal slot before admission.

    A reservation without that ID in history is not a receipt and cannot prevent
    reuse. The first accepted operation commits that very ID. This cutoff works
    with a remote History too; no second write after acceptance completes a link.
    """

    def __init__(self, root: Path) -> None:
        self.path = root / "agui-receipts.sqlite3"

    @contextmanager
    def db(self) -> Iterator[sqlite3.Connection]:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("PRAGMA secure_delete=ON")
            db.execute("""CREATE TABLE IF NOT EXISTS runs (
                key BLOB PRIMARY KEY, session TEXT, source TEXT, terminal CHAR(1), detail TEXT)""")
            yield db

    def lookup(self, key: bytes) -> tuple[str, str, str] | None:
        if not self.path.exists():
            return None
        with self.db() as db:
            row = db.execute(
                "SELECT source,terminal,detail FROM runs WHERE key=?", (key,)
            ).fetchone()
        return (row[0], row[1], row[2]) if row else None

    def reserve(self, key: bytes, sid: str, entries: list[Obj]) -> str:
        source = uuid4().hex
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT source FROM runs WHERE key=?", (key,)).fetchone()
            require(not row or row[0] and not any(e["id"] == row[0] for e in entries), "conflict")
            db.execute("INSERT OR REPLACE INTO runs VALUES (?,?,?,'?','{}')", (key, sid, source))
        return source

    def stage(self, source: str, detail: Obj) -> None:
        with self.db() as db:
            db.execute("UPDATE runs SET detail=? WHERE source=?", (json.dumps(detail), source))

    def released(self, source: str, kind: str) -> None:
        with self.db() as db:
            db.execute("UPDATE runs SET terminal=? WHERE source=?", (kind[0], source))

    def erase(self, state: Obj, ids: list[str]) -> None:
        if not self.path.exists():
            return
        entries = state["entries"]
        by_id = {e["id"]: e for e in entries}
        targets = set(ids)
        with self.db() as db:
            for key, source, raw in db.execute(
                "SELECT key,source,detail FROM runs WHERE session=? AND source!=''", (state["id"],)
            ).fetchall():
                if not (anchor := by_id.get(source)):
                    continue
                records, _ = work_records(entries, anchor)
                if targets.intersection(
                    [*(e["id"] for e in records), *json.loads(raw).get("sources", [])]
                ):
                    if anchor["kind"] == "input_queued":
                        # The admission (or its erasure inputKeys) already reserves the key.
                        db.execute("DELETE FROM runs WHERE key=?", (key,))
                    else:
                        db.execute(
                            "UPDATE runs SET session='',source='',terminal='?',detail='{}' WHERE key=?",
                            (key,),
                        )


async def read_receipt(v: View, run: str) -> Obj:
    store = v.binding.receipts
    require(store is not None, "not_found")
    assert store is not None
    key = receipt_key(v, run)
    row = store.lookup(key)
    require(row and row[0], "not_found")
    assert row is not None
    source, marker, raw = row
    # Bracket the history read with marker reads. A remote read may yield.
    state = await v.inspect(v.sid, receipt=True)
    entries = state["entries"]
    branch = branch_entries(state)
    visible = {
        e["id"]: e for e in branch if not e.get("fork_source") and not e["data"].get("erased")
    }
    anchor = visible.get(source)
    require(anchor, "not_found")
    assert anchor is not None
    records, end = work_records(entries, anchor)
    detail = json.loads(raw)
    sources = set(detail.get("sources", [])).union(e["id"] for e in records)
    for eid in sources:
        require(eid in visible, "not_found")
        projected = await v.entry(visible[eid])
        require(projected is not None, "not_found")
        if end and eid == end["id"] and end["kind"] == "input_withdrawn":
            assert projected is not None
            require(projected["data"].get("reason") == end["data"].get("reason"), "not_found")
    if anchor["kind"] == "question_answer":
        op = next((e for e in records if e["kind"] == "question_open"), None)
        require(op and await question_fact(v, anchor, op), "not_found")
    if anchor["kind"] == "tool_result":
        require(await tool_fact(v, anchor, branch), "not_found")
    work = "unsettled"
    if end and end["kind"] == "input_withdrawn":
        work = "handled" if end["data"].get("reason") == "handled" else "handedBack"
    elif end:
        work = entry_out(end)["data"]["outcome"]["kind"]
        require(work in {"completed", "cancelled", "limit", "failed"}, "not_found")
        settlement = {
            "type": "turn_ended",
            "data": {
                "kind": "turn_ended",
                "session": v.sid,
                "turn": end["turn"],
                "content": end["content"],
                **end["data"],
            },
        }
        allowed = await v.h.output(v.sid, v.actor, [settlement])
        require(allowed and allowed[0]["data"]["outcome"] == work, "not_found")
    terminal = {"?": "unknown", "s": "success", "c": "cancelled", "i": "interrupt", "e": "error"}[
        marker
    ]
    bounds = {"threadId": v.sid, "runId": run}
    if terminal in ("interrupt", "success", "cancelled"):
        outcome: Obj = {"type": terminal}
        if terminal == "interrupt":
            interrupts = []
            qs = question_state(branch)
            for qid in detail["questions"]:
                q = qs.get(qid)
                require(
                    q
                    and q["kind"] != "secret"
                    and (
                        q.get("restrictedResponders") is None
                        or v.actor in q["restrictedResponders"]
                    ),
                    "not_found",
                )
                assert q is not None
                interrupt = await v.interrupt(q)
                require(interrupt, "not_found")
                interrupts.append(interrupt)
            outcome["interrupts"] = interrupts
        if calls := detail.get("calls"):
            if terminal == "success":
                outcome["pendingToolCallIds"] = calls
            for cid in calls:
                start = next(
                    e
                    for e in records_for(detail, visible)
                    if e["kind"] == "tool_started" and e["call"] == cid
                )
                projected = await v.entry(start)
                call = start["data"]["call"]
                require(projected and same_json(call, projected["data"]["call"]), "not_found")
                for frame in triad(cid, call["name"], call["input"]):
                    require(same_json(await v.gate("event", frame), frame), "not_found")
        frame = event("RUN_FINISHED", **bounds, outcome=outcome)
        require(same_json(await v.gate("event", frame), frame), "not_found")
    elif terminal == "error":
        frame = event(
            "RUN_ERROR",
            code=detail["code"],
            message="Output withheld." if detail["fallback"] else "Run could not be delivered.",
        )
        require(same_json(await v.gate("error", frame), frame), "not_found")
    reply = {"terminal": terminal, "work": work}
    await v.required("runReceipt", reply, exact=True)
    # Ordinary appends can advance work. They don't invalidate this watermark.
    current = await v.inspect(v.sid, receipt=True)
    require(
        sources <= {e["id"] for e in branch_entries(current) if not e["data"].get("erased")},
        "not_found",
    )
    require(store.lookup(key) == row, "unavailable")
    return reply


def records_for(detail: Obj, visible: dict[str, Obj]) -> list[Obj]:
    return [visible[eid] for eid in detail.get("sources", [])]
