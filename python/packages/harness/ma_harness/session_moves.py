"""Move a session's position, or rewind its project, only at a quiescent point."""

import asyncio

from ma_core import AgentError, clone, identity, now

from .interface_tools import handoff_fold
from .waiting_approvals import waiting_entries


class SessionMoves:
    async def _position(self, sid, target, actor, restore=None):
        current = self.sessions[sid]
        updated = clone(current)
        entry = {
            "id": identity(),
            "parent": current["position"],
            "session": sid,
            "writer": "@harness",
            "actor": actor,
            "time": now(),
            "kind": "position_move",
            "visible": False,
            "content": [],
            "copies": [],
            "data": {"to": target, **({"restore": restore} if restore else {})},
        }
        updated["position"] = target
        updated["entries"].append(entry)
        await self._keep(updated, [entry])
        return entry

    async def _resume_rewind(self, sid):
        entries = self.sessions[sid]["entries"]
        if not entries:
            return
        intent = entries[-1]
        restore = intent["data"].get("restore") if intent["kind"] == "position_move" else None
        if not restore:
            return
        previous = entries[-2] if len(entries) > 1 else {}
        compensating = (
            previous.get("kind") == "position_move"
            and bool(previous["data"].get("restore"))
            and intent["data"]["to"] == previous["parent"]
            and restore
            == {
                "point": previous["data"]["restore"]["undo"],
                "undo": previous["data"]["restore"]["point"],
            }
        )
        await self._finish_restore(sid, intent, compensating=compensating, reopening=True)

    async def _finish_restore(self, sid, intent, *, compensating=False, reopening=False):
        restore = intent["data"]["restore"]
        try:
            await self.call(
                "@harness", "environment", "restore", {"session": sid, "point": restore["point"]}
            )
        except (AgentError, OSError) as exc:
            if (
                compensating
                or self.sessions[sid].get("writer_lost")
                or getattr(exc, "code", None) == "lost"
            ):
                self._interrupt(sid, "commitFailed")
                raise AgentError("Cannot confirm project restoration", "lost") from exc
            rollback = await self._position(
                sid,
                intent["parent"],
                intent["actor"],
                {"point": restore["undo"], "undo": restore["point"]},
            )
            result = await self._finish_restore(sid, rollback, compensating=True)
            if reopening:
                return result
            raise AgentError(
                "Project restore failed; restored previous position", "conflict"
            ) from exc
        return await self._position(sid, intent["data"]["to"], intent["actor"])

    async def _move(self, s, d, emit):
        sid = s["id"]
        if any(not self.wait_state(s, e)[2] for e in waiting_entries(s)):
            raise AgentError("Cannot move with a waiting approval", "conflict")
        self._require_materialized(s)
        if s.get("busy") or any(not ended for _, _, ended in handoff_fold(s["entries"]).values()):
            raise AgentError("Cannot move with unfinished work", "busy")
        if d.get("rewind"):
            if not any(p.get("rewind") for p in self.declarations(s["project"]).values()):
                raise AgentError("Working environment does not support rewind", "not_supported")
            if any(x["id"] != sid and x["project"] == s["project"] for x in self.sessions.values()):
                raise AgentError("Another open session uses this project", "busy")
        ids = {e["id"] for e in s["entries"] if e["kind"] != "position_move"}
        if d["point"] is not None and d["point"] not in ids:
            code = "conflict" if any(e["id"] == d["point"] for e in s["entries"]) else "not_found"
            raise AgentError("Unknown or ineligible history point", code)
        branch = await self.handle("branch", d, emit)
        if d["point"] is not None:
            target = next((e for e in branch if e["id"] == d["point"]), None)
            if target is None or (target.get("turn") and target["kind"] != "turn_end"):
                raise AgentError("Move needs a quiescent point on the current branch", "conflict")
        if s.get("moving"):
            raise AgentError("Session is already moving")
        self.sessions[sid]["moving"] = True
        out_of_reach, point = [], None
        try:
            if d.get("rewind"):
                branch = await self.handle("branch", d, emit)
                ids = [e["id"] for e in branch]
                if d["point"] is not None and d["point"] not in ids:
                    raise AgentError("Rewind target must be on the current branch")
                later = branch[ids.index(d["point"]) + 1 :] if d["point"] else branch
                if any(
                    e["kind"] in {"job_start", "job_end"}
                    or e.get("data", {}).get("originalKind")
                    in {"jobStarted", "jobEnded", "turnStart", "toolStarted"}
                    or e.get("data", {}).get("pointUnavailable")
                    for e in later
                ):
                    raise AgentError("Cannot rewind work without a restorable point")
                points = [
                    e["data"].get("point")
                    for e in later
                    if e["kind"] == "turn_start"
                    or (e["kind"] == "tool_started" and not e.get("turn"))
                ]
                for candidate in points:
                    if (
                        not candidate
                        or not (
                            await self.call(
                                "@harness",
                                "environment",
                                "check_point",
                                {"session": sid, "point": candidate},
                            )
                        )["exists"]
                    ):
                        raise AgentError("Missing working environment point", "conflict")
                point = points[0] if points else None
                out_of_reach = [
                    f"Tool call {e['call']} may have changed things outside the working environment."
                    for e in later
                    if e["kind"] == "tool_started" and e["data"].get("openWorld", True)
                ]
            await self.fire("@harness", "session.moving", {"session": sid})
            async with self.append_locks.setdefault(sid, asyncio.Lock()):
                actor = d.get("actor", s["actor"])
                if point is None:
                    e = await self._position(sid, d["point"], actor)
                else:
                    saved = await self.call("@harness", "environment", "save", {"session": sid})
                    journal = await self._position(
                        sid, d["point"], actor, {"point": point, "undo": saved["point"]}
                    )
                    try:
                        e = await self._finish_restore(sid, journal)
                    except asyncio.CancelledError:
                        self._interrupt(sid, "commitFailed")
                        raise
        finally:
            self.sessions[sid]["moving"] = False
        await self.fire("@harness", "session.invalidate", {"session": sid, "reason": "move"})
        return {**e, "outOfReach": list(dict.fromkeys(out_of_reach))}
