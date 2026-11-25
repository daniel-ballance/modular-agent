"""Fork a branch into a new session only when no work on it is pending."""

from ma_core import AgentError, clone, identity, now
from ma_core import telemetry as ot
from ma_core.wire import recorded_as

from .interface_tools import HANDOFF


class SessionForks:
    async def _fork(self, s, d, emit):
        sid = s["id"]
        await self.guard_erasure(sid)
        if s.get("busy"):
            raise AgentError("Cannot fork during a turn", "busy")
        branch = await self.handle("branch", d, emit)
        ended_jobs = {e["job"] for e in branch if e["kind"] == "job_end"}
        ended_calls = {e["call"] for e in branch if e["kind"] == "tool_result"}
        closed_questions = {
            e["data"]["request"]
            for e in branch
            if e["kind"] in {"question_answer", "question_closed"}
        }
        if any(
            (e["kind"] == "job_start" and e["job"] not in ended_jobs)
            or (e["kind"] == "tool_deferred" and e["call"] not in ended_calls)
            or (e["kind"] == "question_open" and e["data"]["id"] not in closed_questions)
            for e in branch
        ):
            raise AgentError("Cannot fork pending work; finish or cancel it first", "busy")
        if "point" in d:
            if d["point"] not in {e["id"] for e in branch}:
                raise AgentError("Fork point must be on current branch")
            branch = branch[: next(i for i, e in enumerate(branch) if e["id"] == d["point"]) + 1]
        child = await self.handle(
            "create",
            {
                "project": d.get("project", s["project"]),
                "settings": s["settings"],
                "actor": d.get("actor", s["actor"]),
                "actor_kind": s["actors"][d.get("actor", s["actor"])]["kind"],
                "authority": sorted(self.permissions(s, d.get("actor", s["actor"]))),
                "origin": {"session": sid, "point": branch[-1]["id"] if branch else None},
                "tenant": s.get("tenant"),
                "draft": True,
            },
            emit,
        )
        if self.supports_erasure():
            branch = [e for e in branch if not e.get("data", {}).get("erased")]
        branch = [e for e in branch if not recorded_as(e, HANDOFF) and e["kind"] != ot.TURN_TRACE]
        mapping = {e["id"]: identity() for e in branch}
        entries = list(child["entries"])
        for e in branch:
            copied = clone(ot.project_entry(e))
            copied.update(
                id=mapping[e["id"]],
                session=child["id"],
                parent=entries[-1]["id"] if entries else None,
                fork_source=e["id"],
                copies=[e["id"]],
            )
            if copied["kind"] in {
                "input_queued",
                "input",
                "input_withdrawn",
                "turn_start",
            } and "input" in copied.get("data", {}):
                copied["data"]["input"] = mapping.get(
                    copied["data"]["input"], copied["data"]["input"]
                )
            if copied["kind"] == "summary" and "covers" in copied.get("data", {}):
                copied["data"]["covers"] = [mapping.get(x, x) for x in copied["data"]["covers"]]
            entries.append(copied)
        child["actors"] = clone(s["actors"])
        child["departed"] = list(s.get("departed", []))
        child["limit"] = clone(s.get("limit"))
        setup = []
        if child.get("tenant") is not None:
            setup.append(("tenant", {"tenant": child["tenant"]}))
        setup.append(("setting", child["settings"]))
        setup.extend(
            (
                "actor_joined",
                {
                    "actor": {"id": aid, "kind": actor["kind"], "rights": actor["authority"]},
                    "operatorAdmission": True,
                },
            )
            for aid, actor in child["actors"].items()
        )
        setup.extend(("actor_left", {"actorId": aid}) for aid in child["departed"])
        if child["limit"] is not None:
            setup.append(("limit", {"rights": child["limit"]}))
        setup.append(("plugins", {"active": self.active_plugins()}))
        for kind, data in setup:
            entries.append(
                {
                    "id": identity(),
                    "session": child["id"],
                    "time": now(),
                    "parent": entries[-1]["id"] if entries else None,
                    "kind": kind,
                    "data": data,
                    "content": [],
                    "copies": [],
                    "visible": False,
                    "writer": "@harness",
                }
            )
        child.update(entries=entries, position=entries[-1]["id"])
        child.pop("setup_pending", None)
        try:
            await self._keep(child, entries)
        except BaseException:
            if "history" in self.capabilities:
                await self.call("@harness", "history", "close", {"session": child["id"]})
            raise
        await self._start_session(child)
        await self.fire(
            "@harness", "session.invalidate", {"session": child["id"], "reason": "fork"}
        )
        return child
