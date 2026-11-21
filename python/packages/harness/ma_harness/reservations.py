"""Account for current and in-flight history obligations on the host event loop."""

import asyncio
import json
from collections import Counter

from ma_core import AgentError
from ma_core.wire import entry_out, recorded_as

MIB = 1 << 20
COUNT_MAX = (1 << 53) - 1
COUNTS = ("inputs", "calls", "jobs")
DEFAULTS = {
    "session": dict(
        inputs=64,
        calls=128,
        jobs=32,
        bufferedBytes=4 * MIB,
        storageBytes=256 * MIB,
        controlBytes=4 * MIB,
    ),
    "tenant": dict(
        inputs=512,
        calls=1024,
        jobs=256,
        bufferedBytes=16 * MIB,
        storageBytes=1024 * MIB,
        controlBytes=16 * MIB,
    ),
    "agent": dict(
        inputs=2048,
        calls=4096,
        jobs=1024,
        bufferedBytes=64 * MIB,
        storageBytes=4096 * MIB,
        controlBytes=64 * MIB,
    ),
}
MAX_ENTRY = 4 * MIB
CONTROL = {"limit", "authority", "actor_left", "erase", "position_move", "job_cleanup_unconfirmed"}


def size(value):
    return len(json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode())


def fold(entries):
    pending, calls, attempts, jobs, turns, questions = {}, set(), set(), {}, set(), set()
    stored = control = 0
    for entry in entries:
        n = size(entry_out(entry))
        if entry["kind"] in CONTROL:
            control += n
        else:
            stored += n
        if entry.get("fork_source"):
            continue
        d = entry.get("data") or {}
        kind = entry["kind"]
        if kind == "input_queued":
            pending[d.get("input") or entry["id"]] = n
        if kind in {"input", "input_withdrawn", "input_handled"} or any(
            recorded_as(entry, k) for k in ("input", "input_withdrawn", "input_handled")
        ):
            for iid in [d.get("input") or d.get("inputId"), *d.get("inputIds", [])]:
                pending.pop(iid, None)
        if kind == "model_started":
            attempts.add(entry.get("step"))
        if recorded_as(entry, "response"):
            attempts.discard(entry.get("step"))
            calls.update(c["id"] for c in d.get("calls", []))
        if kind == "tool_call":
            calls.add(entry.get("call"))
        if recorded_as(entry, "tool_result"):
            calls.discard(entry.get("call"))
        if kind == "job_start":
            jobs[entry.get("job")] = d.get("report", True)
        if recorded_as(entry, "job_end"):
            jobs.pop(entry.get("job"), None)
        if kind == "turn_start":
            turns.add(entry.get("turn"))
        if recorded_as(entry, "turn_end"):
            turns.discard(entry.get("turn"))
        if kind == "question_open":
            questions.add(d["id"])
        if kind in {"question_closed", "question_answer"}:
            questions.discard(d["request"])
    return Counter(
        inputs=len(pending) + sum(jobs.values()),
        calls=len(calls) + len(attempts),
        jobs=len(jobs),
        storageBytes=stored
        + sum(n + 64 * 1024 for n in pending.values())
        + len(calls) * 64 * 1024
        + len(attempts) * (MAX_ENTRY + 65536)
        + len(jobs) * 128 * 1024
        + len(turns) * 64 * 1024
        + len(questions) * 8192,
        controlBytes=control,
    )


class Reservations:
    def __init__(self, limits=None):
        limits = {} if limits is None else limits
        if not isinstance(limits, dict) or limits.keys() - DEFAULTS.keys():
            raise AgentError("Invalid resource reservation scopes", "invalid_composition")
        self.limits = {}
        for scope, defaults in DEFAULTS.items():
            overrides = limits.get(scope, {})
            if (
                not isinstance(overrides, dict)
                or overrides.keys() - defaults.keys()
                or any(type(v) is not int or not 0 <= v <= COUNT_MAX for v in overrides.values())
            ):
                raise AgentError("Invalid resource reservation bounds", "invalid_composition")
            self.limits[scope] = {**defaults, **overrides}
        self.current = {}
        self.inflight = {}
        self.responses = {}
        self.active = {}
        self.fresh = set()
        self.lock = asyncio.Lock()

    def declaration(self):
        return {scope: {name: row[name] for name in COUNTS} for scope, row in self.limits.items()}

    async def rebuild(self, harness):
        history = harness.capabilities.get("history")
        if history is None or id(history[1]) in self.fresh:
            return
        async with self.lock:
            if id(history[1]) in self.fresh:
                return
            for row in await harness.call("@harness", "history", "list", {}):
                if row["id"] in self.current:
                    continue
                saved = await harness.call("@harness", "history", "read", {"session": row["id"]})
                if saved:
                    self.restore(saved)
            self.fresh.add(id(history[1]))

    def restore(self, session):
        sid = session["id"]
        self.current[sid] = session.get("tenant"), fold(session["entries"])
        self.inflight.pop(sid, None)
        for key in [pair for pair in self.responses if pair[0] == sid]:
            del self.responses[key]

    def _usage(self, sid, tenant, *, skip=None):
        buckets = {scope: Counter() for scope in self.limits}
        for rows in (self.current, self.inflight, self.responses, self.active):
            for key, (owner, bucket, values) in self._rows(rows):
                if key == skip:
                    continue
                buckets["agent"].update(values)
                if bucket == tenant:
                    buckets["tenant"].update(values)
                if owner == sid:
                    buckets["session"].update(values)
        return buckets

    def _rows(self, rows):
        if rows is self.current or rows is self.inflight:
            for sid, (tenant, values) in rows.items():
                yield sid, (sid, tenant, values)
        else:
            yield from rows.items()

    def require(self, sid, tenant, delta, *, skip=None):
        for scope, usage in self._usage(sid, tenant, skip=skip).items():
            if any(v > 0 and v + usage[k] > self.limits[scope][k] for k, v in delta.items()):
                raise AgentError("Resource reservation capacity exhausted", "busy")

    def stage(self, session, entries, *, response=None):
        sid, tenant = session["id"], session.get("tenant")
        old = self.current.get(sid, (tenant, Counter()))[1]
        new = fold(session["entries"])
        delta = new - old
        if any(size(entry_out(e)) > MAX_ENTRY for e in entries):
            raise AgentError("Record exceeds the supported entry size", "result_too_large")
        self.require(sid, tenant, delta, skip=response)
        self.inflight[sid] = tenant, delta
        return new

    def finish(self, sid, tenant, values, *, response=None):
        self.current[sid] = tenant, values
        self.inflight.pop(sid, None)
        self.responses.pop(response, None)

    def model_response(self, session, response, step):
        sid, tenant = session["id"], session.get("tenant")
        key = (sid, step)
        calls = response.get("calls", [])
        extra = Counter(calls=max(0, len(calls) - 1), storageBytes=len(calls) * 64 * 1024)
        try:
            if size(response) > MAX_ENTRY - 16384:
                raise AgentError("Model result exceeds the record size", "result_too_large")
            self.require(sid, tenant, extra, skip=key)
        except AgentError as exc:
            reason = "capacity" if exc.code == "busy" else exc.code
            return {
                "content": [],
                "calls": [],
                "stop": "failed",
                "usage": response.get("usage", {}),
                "error": {"kind": "other", "message": str(exc)},
                "hostLimit": reason,
            }
        self.responses[key] = sid, tenant, extra
        return response

    def hold(self, session, **delta):
        sid, tenant = session["id"], session.get("tenant")
        charge = Counter(delta)
        self.require(sid, tenant, charge)
        key = object()
        self.active[key] = sid, tenant, charge
        return key

    def release(self, key):
        self.active.pop(key, None)
