"""Participating client for the history HTTP pending-erasure profile."""

import hashlib
import json
import re
from collections import defaultdict, deque

from ma_core import AgentError, identity

_TOKEN = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
_PROTECTED = {
    "tenant",
    "limit",
    "authority",
    "actorJoined",
    "actorLeft",
    "positionMove",
    "erasure",
    "jobCleanupUnconfirmed",
}


def _id(value):
    return isinstance(value, str) and bool(value)


def fork_prefix(metadata, entries):
    """Find the origin mapping from the portable header and leading prefix."""
    if not (fork := metadata.get("forkedFrom")):
        return {}
    result = {}
    for entry in entries:
        sources = entry.get("sources") or []
        if len(sources) == 1 and _id(sources[0]):
            result[entry["id"]] = (fork["sessionId"], sources[0])
        elif entry.get("erased") is True and not sources:
            # Legacy tombstone with no provable origin.
            result[entry["id"]] = None
        else:
            break
    return result


def discover(sessions, source, targets):
    """Follow portable copy links and input admission/taking associations."""
    records, edges = {}, defaultdict(set)
    for sid, (metadata, rows) in sessions.items():
        prefix = fork_prefix(metadata, rows)
        admissions = {}
        for entry in rows:
            if entry.get("kind") == "inputAccepted":
                eid = entry["id"]
                admissions[entry.get("inputId") or eid] = eid
        for entry in rows:
            key = sid, entry["id"]
            records[key] = entry
            sources = entry.get("sources") or []
            origin = prefix.get(key[1])
            if origin:
                edges[origin].add(key)
                edges[key].add(origin)
            else:
                for entry_id in sources:
                    edges[sid, entry_id].add(key)
            if entry.get("kind") in {
                "inputAccepted",
                "input",
                "inputHandedBack",
                "modular-agent.inputWithdrawn",
            }:
                inputs = entry.get("inputIds") or [entry.get("inputId")]
                for input_id in inputs:
                    if admission := admissions.get(input_id):
                        other = sid, admission
                        edges[other].add(key)
                        edges[key].add(other)
    todo = deque((source, key) for key in targets)
    if any(key not in records for key in todo):
        raise AgentError("Unknown erasure entry", "not_found")
    found = set()
    copies = defaultdict(list)
    while todo:
        key = todo.popleft()
        if key in found or key not in records:
            continue
        if records[key].get("kind") in _PROTECTED:
            raise AgentError("Cannot erase records of authority or control", "forbidden")
        found.add(key)
        copies[key[0]].append(key[1])
        todo.extend(sorted(edges[key] - found))
    return copies


class PendingErasure:
    """Uses raw records only for planning, reconciliation and copy validation."""

    def registry_path(self, sid):
        return self.path(sid) + "/pending-erasure"

    async def registry(self, sid):
        path = self.registry_path(sid)
        revision, plans, seen = None, [], set()
        try:
            while True:
                page = await self.request("GET", path)
                current = page["revision"]
                if (
                    set(page) - {"revision", "plans", "next"}
                    or not isinstance(current, str)
                    or not _TOKEN.fullmatch(current)
                    or (revision is not None and revision != current)
                    or not isinstance(page["plans"], list)
                    or len(page["plans"]) > 500
                ):
                    raise ValueError("Invalid registry page or changed revision")
                revision = current
                for plan in page["plans"]:
                    if (
                        not isinstance(plan, dict)
                        or set(plan) != {"intentId", "sourceSessionId", "recordId", "copies"}
                        or not all(
                            _id(plan[k]) for k in ("intentId", "sourceSessionId", "recordId")
                        )
                        or plan["intentId"] in {".", ".."}
                        or plan["intentId"] in seen
                        or not isinstance(plan["copies"], list)
                        or not plan["copies"]
                    ):
                        raise ValueError("Invalid registry plan")
                    ids = set()
                    for copy in plan["copies"]:
                        if (
                            not isinstance(copy, dict)
                            or set(copy) != {"entryId", "complete"}
                            or not _id(copy["entryId"])
                            or type(copy["complete"]) is not bool
                            or copy["entryId"] in ids
                        ):
                            raise ValueError("Invalid registry copy")
                        ids.add(copy["entryId"])
                    seen.add(plan["intentId"])
                    plans.append(plan)
                if "next" not in page:
                    return revision, plans
                cursor = page["next"]
                if not page["plans"] or cursor != page["plans"][-1]["intentId"]:
                    raise ValueError("Invalid registry cursor")
                path = self.registry_path(sid) + "?after=" + self.segment(cursor)
        except (AgentError, KeyError, TypeError, ValueError) as exc:
            raise AgentError("Pending erasure registry is unavailable", "unavailable") from exc

    @staticmethod
    def _progress(sid, plans):
        return [
            {
                "intent": plan["intentId"],
                "recordId": plan["recordId"],
                "sessionId": sid,
                "id": copy["entryId"],
                "confirmed": copy["complete"],
            }
            for plan in plans
            for copy in plan["copies"]
        ]

    @staticmethod
    def check_view(plans, tombstones):
        if any(
            not copy["complete"] or copy["entryId"] not in tombstones
            for plan in plans
            for copy in plan["copies"]
        ):
            raise AgentError(
                "Session content is pending erasure or the view is stale", "unavailable"
            )

    async def pending_erasure(self, d, emit):
        if d.get("provisional"):
            return []  # An unpublished view contains no history-service data.
        sid = d["session"]
        _, plans = await self.registry(sid)
        return [copy for copy in self._progress(sid, plans) if not copy["confirmed"]]

    async def erasure_revision(self, d, emit):
        if d.get("provisional"):
            return 0
        _, plans = await self.registry(d["session"])
        self.check_view(plans, set(d.get("tombstones", ())))
        if not plans:
            return 0  # The first append can materialize a provisional session.
        # The global revision changes on ordinary writes, including one's own
        # effect results. Compare applicable plans, not unrelated changes.
        return int.from_bytes(hashlib.sha256(json.dumps(plans, sort_keys=True).encode()).digest())

    async def append_revision(self, session, entries):
        sid = session["id"]
        revision, plans = await self.registry(sid)
        raw_tombstones = set(session.get("_history_tombstones", ()))
        marks = {c["entryId"] for p in plans for c in p["copies"]}
        origin = (session.get("origin") or {}).get("session")
        foreign = None
        for entry in entries:
            if entry.get("fork_source"):
                if not origin:
                    raise AgentError("Unknown copy origin", "unavailable")
                if foreign is None:
                    _, rows = await self.pages(self.path(origin), "entries")
                    other_revision, other_plans = await self.registry(origin)
                    if other_revision != revision:
                        return None  # Start a new check before considering any sources.
                    self.check_view(other_plans, {e["id"] for e in rows if e.get("erased") is True})
                    foreign = {e["id"] for e in rows if e.get("erased") is not True}
                if any(source not in foreign for source in entry.get("sources", ())):
                    raise AgentError("Cannot append an erased or unknown copy", "unavailable")
            elif (marks | raw_tombstones).intersection(entry.get("sources", ())):
                raise AgentError("Cannot append a copy of erased or pending content", "unavailable")
        return revision

    async def publish_erasure(self, d, emit):
        sid = d["session"]
        lease = self.erasure_lease(sid)
        targets = list(dict.fromkeys(d["entries"]))
        while True:
            revision, _ = await self.registry(sid)
            sessions = {
                row["id"]: await self.pages(self.path(row["id"]), "entries")
                for row in await self.list({}, emit)
            }
            copies = discover(sessions, sid, targets)
            try:
                reply = await self.erasure_request(
                    sid,
                    lease,
                    self.registry_path(sid),
                    {
                        "intentId": identity(),
                        "revision": revision,
                        "entryIds": targets,
                        "copies": [
                            {"sessionId": dest, "recordId": identity(), "entryIds": ids}
                            for dest, ids in copies.items()
                        ],
                    },
                )
            except AgentError as exc:
                if exc.code == "stale_revision":
                    # Rediscover under the next revision, not just change the header.
                    continue
                raise
            break
        intent, destinations = reply.get("intentId"), reply.get("sessionIds")
        if (
            set(reply) != {"intentId", "sessionIds"}
            or not _id(intent)
            or intent in {".", ".."}
            or not isinstance(destinations, list)
            or any(not _id(dest) or dest in {".", ".."} for dest in destinations)
            or len(set(destinations)) != len(destinations)
        ):
            raise AgentError("Invalid erasure publication response", "unavailable")
        # The session list does not include expired destinations. Use the
        # original publication's destinations, whose plans are still readable.
        while True:
            revision, source_plans = await self.registry(sid)
            progress = []
            for dest in [sid, *(d for d in destinations if d != sid)]:
                current, plans = (
                    (revision, source_plans) if dest == sid else await self.registry(dest)
                )
                if current != revision:
                    self._check(sid, lease)
                    break
                plan = next((p for p in plans if p["intentId"] == intent), None)
                if plan is None or plan["sourceSessionId"] != sid:
                    raise AgentError("Published erasure plan is missing", "unavailable")
                progress.extend(self._progress(dest, [plan]))
            else:
                return progress

    async def erase(self, d, emit):
        sid = d["session"]
        lease = self.erasure_lease(sid)
        _, plans = await self.registry(sid)
        plan = next((p for p in plans if p["intentId"] == d["intent"]), None)
        if plan is None:
            raise AgentError("Unknown erasure plan", "unavailable")
        targets = d["entries"]
        result = await self.erasure_request(
            sid, lease, self.path(sid) + "/erase", {"entryIds": targets}
        )
        _, rows = await self.pages(self.path(sid), "entries")
        tombstones = {e["id"] for e in rows if e.get("erased") is True}
        verified = [key for key in targets if key in tombstones]
        if verified:
            await self.erasure_request(
                sid,
                lease,
                self.registry_path(sid) + "/" + self.segment(d["intent"]) + "/complete",
                {"entryIds": verified},
            )
        return result
