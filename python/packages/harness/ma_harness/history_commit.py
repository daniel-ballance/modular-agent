"""Commit an append's batch to history before it becomes the session's state."""

import asyncio

from ma_core import AgentError, clone, identity, now
from ma_core import telemetry as ot

from .authority import CONNECTION_AUTHORITY
from .interface_tools import HANDOFF, branch_entries, handoff_fold
from .waiting_approvals import waiting_entries


class HistoryCommit:
    def watch_continuation(self, sid, origin, refused):
        key = sid, origin
        waiters = self.continuation_waiters.setdefault(key, set())
        waiters.add(refused)

        def detach():
            waiters.discard(refused)
            if not waiters:
                self.continuation_waiters.pop(key, None)

        return detach

    async def _keep(self, session, entries):
        if session.get("provisional"):
            if not any(e["kind"] == "input_queued" for e in entries):
                # Keep the original IDs, timestamps and parent links in memory.
                self.sessions[session["id"]] = session
                return
            del session["provisional"]
            entries = session["entries"]

        cancellation = None
        sid = session["id"]
        await self.capacity.rebuild(self)
        if sid in self.sessions:
            await self._assert_writable(sid)
        response = next(((sid, e.get("step")) for e in entries if e["kind"] == "response"), None)
        try:
            charged = self.capacity.stage(session, entries, response=response)
        except AgentError as exc:
            if exc.code == "busy":
                for entry in entries:
                    if entry["kind"] == "turn_start":
                        origin = (entry["data"].get("source") or {}).get("continuesTurnId")
                        for notify in self.continuation_waiters.get((sid, origin), ()):
                            notify()
            raise
        if "history" in self.capabilities:
            cancellation = await self._commit(sid, session, entries)
        self.capacity.finish(sid, session.get("tenant"), charged, response=response)
        # Calls to an out-of-process store yield. Preserve flags changed by a
        # concurrent cancellation/close while that durable write was in flight.
        current = self.sessions.get(session["id"], {})
        for key in ("busy", "moving", "closing", "suspending", "writer_lost", "interruption"):
            if key in current:
                session[key] = current[key]
        self.sessions[sid] = session
        for notify in self.commit_listeners.get(sid, ()):
            notify(entries)
        # A cancelled caller cannot dispatch from this append. The next
        # writer still needs the confirmed parent and call associations.
        if session.get("writer_lost"):
            raise AgentError("Session interrupted", "lost")
        if cancellation is not None:
            raise cancellation

    async def _commit(self, sid, session, entries):
        cancellation = None
        with ot.span(
            "modular_agent.history.commit",
            ot.attrs(
                sid,
                **{
                    "modular_agent.history.entry.count": len(entries),
                },
            ),
        ) as operation:
            commit = asyncio.create_task(
                self.call(
                    "@harness",
                    "history",
                    "keep",
                    {
                        "session": {k: v for k, v in session.items() if k != "entries"},
                        "entries": entries,
                    },
                )
            )
            try:
                while True:
                    try:
                        await asyncio.shield(commit)
                        break
                    except asyncio.CancelledError as exc:
                        if commit.cancelled():
                            raise
                        cancellation = exc
            except (Exception, asyncio.CancelledError) as exc:
                reason = "writerLost" if getattr(exc, "writer_lost", False) else "commitFailed"
                self._interrupt(sid, reason)
                ot.set_attrs(
                    operation,
                    {
                        "modular_agent.history.commit.status": (
                            "uncertain"
                            if getattr(exc, "writer_lost", False)
                            or isinstance(exc, asyncio.CancelledError)
                            else "failed"
                        )
                    },
                )
                if isinstance(exc, AgentError) and exc.code == "lost":
                    raise
                raise AgentError(
                    "Cannot confirm the session commit; reopen to recover", "lost"
                ) from exc
            ot.set_attrs(operation, {"modular_agent.history.commit.status": "committed"})
        return cancellation

    async def _append(self, d):
        # An entry may attribute an effect to a historical actor who has left.
        s = self._session(d, check_actor=False)
        sid = s["id"]
        if d["kind"] == "tool_started" and (wait := self.waiting_request(s, d["call"])):
            current = next(
                (
                    t
                    for t in await self.call(
                        "@harness", "tools", "definitions", {"session": sid, "turn": d["turn"]}
                    )
                    if t["name"] == d["data"]["call"]["name"]
                ),
                None,
            )
            status, sources = await self.check_wait_dispatch(
                sid, d["turn"], d["step"], d["data"]["call"], current
            )
            if status:
                return [{"denied": status}]
            registration = wait["data"]["approval_registration"]
            d = {
                **d,
                "copies": [*d.get("copies", []), *sources],
                "data": {
                    **d["data"],
                    "source": registration["source"],
                    "definition": registration["definition"],
                },
            }
        if d["kind"] == "tool_result" and (wait := self.waiting_request(s, d["call"])):
            decision, _, result = self.wait_state(s, wait)
            if result:
                return [result]
            d = {
                **d,
                "copies": list(
                    dict.fromkeys(
                        [*d.get("copies", []), wait["id"], *([decision["id"]] if decision else [])]
                    )
                ),
            }
        if d["kind"] == "turn_end" and (listed := d["data"].get("open_calls")):
            settled = {cid for cid, (_, _, result) in handoff_fold(s["entries"]).items() if result}
            settled.update(e["call"] for e in waiting_entries(s) if self.wait_state(s, e)[2])
            if settled.intersection(listed):
                data = {**d["data"], "open_calls": [cid for cid in listed if cid not in settled]}
                if "shared_result" in data:
                    data["shared_result"] = {
                        **data["shared_result"],
                        "openToolCalls": data["open_calls"],
                    }
                d = {**d, "data": data}
        if d["kind"] not in {
            "input_queued",
            "setting",
            "plugins",
            "actor_joined",
            "actor_left",
            "authority",
            "limit",
        }:
            self._require_materialized(s)
        if d["kind"] in {"question_answer", "question_closed", "secret_answer_accepted"} and any(
            (
                entry["kind"] in {"question_answer", "question_closed"}
                or (entry["kind"] == "secret_answer_accepted" and not d["data"].get("activation"))
            )
            and entry["data"]["request"] == d["data"]["request"]
            for entry in s["entries"]
        ):
            raise AgentError("Question is closed or no longer answerable", "refused")
        setup = []
        if not s["entries"] and s.get("tenant") is not None:
            setup.append(
                {
                    "id": identity(),
                    "parent": None,
                    "session": sid,
                    "writer": "@harness",
                    "time": now(),
                    "kind": "tenant",
                    "content": [],
                    "visible": False,
                    "copies": [],
                    "data": {"tenant": s["tenant"]},
                }
            )
        if (s.get("setup_pending") or setup) and not s["entries"]:
            setup.append(
                {
                    "id": identity(),
                    "parent": setup[-1]["id"] if setup else None,
                    "session": sid,
                    "writer": "@harness",
                    "actor": s["actor"],
                    "time": now(),
                    "kind": "setting",
                    "content": [],
                    "visible": False,
                    "copies": [],
                    "data": s["settings"],
                }
            )
            for aid, actor in s["actors"].items():
                setup.append(
                    {
                        **{k: v for k, v in setup[-1].items() if k != "actor"},
                        "id": identity(),
                        "parent": setup[-1]["id"],
                        "kind": "actor_joined",
                        "data": {
                            "actor": {
                                "id": aid,
                                "kind": actor["kind"],
                                "rights": actor["authority"],
                            },
                            "operatorAdmission": True,
                        },
                    }
                )
        prior_plugins = next(
            (e["data"]["active"] for e in reversed(s["entries"]) if e["kind"] == "plugins"), None
        )
        active = self.active_plugins()
        if d["kind"] != "plugins" and prior_plugins != active:
            setup.append(
                {
                    "id": identity(),
                    "parent": setup[-1]["id"] if setup else s["position"],
                    "session": sid,
                    "kind": "plugins",
                    "time": now(),
                    "writer": "@harness",
                    "visible": False,
                    "content": [],
                    "copies": [],
                    "data": {"active": active},
                }
            )
        e = {
            "id": d.get("id", identity()),
            "parent": setup[-1]["id"] if setup else s["position"],
            "session": sid,
            "writer": d.get("writer", "plugin"),
            **(
                {}
                if (d["kind"] == "actor_joined" and d.get("data", {}).get("operatorAdmission"))
                or ("actor" in d and d["actor"] is None)
                else {"actor": d.get("actor", s["actor"])}
            ),
            "time": now(),
            "kind": d["kind"],
            "content": d.get("content", []),
            "visible": d.get("visible", False),
            "copies": d.get("copies", []),
            **{k: d[k] for k in ("turn", "step", "call", "job", "data") if k in d},
        }
        if prior := d.get("close_attempt"):
            aborted = {
                **e,
                "id": identity(),
                "kind": "response",
                "step": prior["step"],
                "content": [],
                "visible": False,
                "copies": [prior["id"]],
                "data": {"stop": "aborted", "recovery": True},
            }
            setup.append(aborted)
            e["parent"] = aborted["id"]
        batch = [*setup, e]
        if d.get("handled") and e["kind"] == "input_queued":
            batch.append(
                {
                    **e,
                    "kind": "input_withdrawn",
                    "id": identity(),
                    "parent": e["id"],
                    "content": [],
                    "data": {"input": e["id"], "reason": "handled"},
                }
            )
        paired = {"turn_start": ("first_input", "input"), "job_end": ("job_report", "input_queued")}
        field, kind = paired.get(e["kind"], (None, None))
        if field in d:
            batch.append(
                {
                    **d[field],
                    "id": d[field].get("id") or identity(),
                    "parent": e["id"],
                    "session": sid,
                    "writer": e["writer"],
                    "time": now(),
                    "kind": kind,
                    **(
                        {"turn": e["turn"]}
                        if kind == "input"
                        else {"job": e["job"], "copies": [e["id"]]}
                    ),
                }
            )
        if d.get("gate_pending") or d.get("wait_result"):
            if d.get("approval_time"):
                e["time"] = d["approval_time"]
            batch.append(
                {
                    **{k: e[k] for k in ("session", "time", "writer", "turn", "step", "call")},
                    "id": identity(),
                    "parent": e["id"],
                    "kind": "tool_deferred",
                    "visible": False,
                    "content": [],
                    "copies": [*d.get("copies", []), e["id"]],
                    "data": {"requestIds": [e["data"].get("id")]},
                    **d.get("wait_result", {}),
                }
            )
        if handoff := d.get("interface_handoff"):
            batch.append(
                {
                    **{k: e[k] for k in ("session", "time", "writer", "turn", "step", "call")},
                    "id": identity(),
                    "parent": e["id"],
                    "kind": HANDOFF,
                    "visible": False,
                    "content": [],
                    "copies": [e["id"]],
                    "data": {**handoff, "toolStartedId": e["id"]},
                }
            )
        # A commit builds a new list. Previously committed entries do not change.
        updated = clone({k: v for k, v in s.items() if k != "entries"})
        updated["entries"] = [*s["entries"], *batch]
        updated["position"] = batch[-1]["id"]
        if e["kind"] == "limit":
            actor = e["actor"]
            self.require(s, actor, "administer")
            rights = e["data"]["rights"]
            if rights is not None:
                if not isinstance(rights, list) or not all(isinstance(r, str) for r in rights):
                    raise AgentError("Expected an array of rights or null", "invalid_request")
                if not set(rights) <= self.permissions(s, actor):
                    raise AgentError("Cannot set a limit above the actor's authority", "forbidden")
            updated["limit"] = rights
        if e["kind"] == "actor_left":
            left = e["data"]["actorId"]
            updated["actors"].pop(left, None)
            updated["departed"] = sorted(set(updated.get("departed", [])) | {left})
        if e["kind"] in {"actor_joined", "authority"}:
            joined = e["data"].get("actor", {}).get("id") or e["data"].get("subject")
            updated["departed"] = [aid for aid in updated.get("departed", []) if aid != joined]
        if e["kind"] == "authority":
            grant = e["data"]
            updated["actors"][grant["subject"]] = {
                "kind": grant["kind"],
                "authority": grant["authority"],
            }
        if e["kind"] in {"authority", "actor_left", "limit"} and "questions" in self.capabilities:
            branch = branch_entries(s)
            closed = {
                row["data"]["request"]
                for row in branch
                if row["kind"] in ("question_answer", "question_closed", "secret_answer_accepted")
            }
            openings = {
                row["data"]["id"]: row
                for row in branch
                if row["kind"] == "question_open" and row["data"]["id"] not in closed
            }
            # Compare both views before publishing either the grant or its consequences.
            # A competing answer takes the same append lock.
            token = CONNECTION_AUTHORITY.set(None)
            try:
                revoked = (
                    await self.call(
                        "@harness",
                        "questions",
                        "revoked_requests",
                        {
                            "session": sid,
                            "requests": [opening["data"] for opening in openings.values()],
                            "before": {a: sorted(self.permissions(s, a)) for a in s["actors"]},
                            "after": {
                                a: sorted(self.permissions(updated, a)) for a in updated["actors"]
                            },
                        },
                    )
                    if openings
                    else []
                )
            finally:
                CONNECTION_AUTHORITY.reset(token)
            for qid in revoked:
                opening = openings[qid]
                q = opening["data"]
                reason = (
                    "refused"
                    if q["kind"] == "approval" and not q.get("approvalWait")
                    else "noLongerAnswerable"
                )
                if q.get("approvalWait") and self.wait_reason(updated, opening) != (
                    reason,
                    "refused",
                ):
                    continue
                decision = {
                    **{k: opening[k] for k in ("turn", "step", "call") if opening.get(k)},
                    "id": identity(),
                    "parent": updated["position"],
                    "session": sid,
                    "time": e["time"],
                    "kind": "question_closed",
                    "writer": "@harness",
                    "content": [],
                    "visible": False,
                    "copies": [opening["id"]],
                    "data": {"request": q["id"], "reason": reason, "cause": "revoked"},
                }
                batch.append(decision)
                updated["entries"].append(decision)
                updated["position"] = decision["id"]
                if q.get("approvalWait"):
                    result = {
                        **decision,
                        **self.wait_result(opening, "refused"),
                        "id": identity(),
                        "parent": decision["id"],
                        "copies": [opening["id"], decision["id"]],
                    }
                    batch.append(result)
                    updated["entries"].append(result)
                    updated["position"] = result["id"]
        if e["kind"] == "setting":
            if s.get("busy"):
                raise AgentError("Settings may change only between turns")
            updated["settings"].update(e["data"])
        updated.pop("setup_pending", None)
        await self._keep(updated, batch)
        return batch[len(setup) :]
