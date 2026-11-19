"""Owner-controlled job records and idempotent report admission, outside turns."""

import asyncio

from ma_core import AgentError, Plugin, identity


class Jobs(Plugin):
    name = "jobs"
    declarations = {
        "jobs": True,
        "job_reports_start_turns": True,
        "cancel_turn_cancels_jobs": False,
    }

    def __init__(self):
        self.signals = {}
        self.locks = {}

    async def start(self, api):
        await super().start(api)
        api.provide("jobs", self)
        api.on("session.ready", self.recover)
        api.on("session.end", self.close)
        api.on("session.moving", self.close)
        api.command("jobs", "List session-owned jobs", self.command_list)
        api.command("job_cancel", "Cancel one job by ID", self.command_cancel)

    async def command_list(self, d):
        return await self.list(d, None)

    async def command_cancel(self, d):
        s = await self.api.session("get", session=d["session"])
        allowed = await self.api.session(
            "authority", session=d["session"], actor=d.get("actor", s["actor"])
        )
        if "cancel" not in allowed:
            raise AgentError("Actor lacks cancellation authority", "forbidden")
        return await self.cancel({**d, "job": d["args"]}, None)

    async def list(self, d, emit):
        es = (await self.api.session("get", session=d["session"]))["entries"]
        jobs = {
            e["job"]: {
                **e["data"],
                "id": e["job"],
                "owner": e["data"].get("owner", e["writer"]),
                "actor": e["actor"],
                "session": d["session"],
                "historical": bool(e.get("fork_source")),
                "state": "running",
            }
            for e in es
            if e["kind"] == "job_start"
        }
        for e in es:
            if e["kind"] == "job_cleanup_unconfirmed" and e["job"] in jobs:
                jobs[e["job"]]["state"] = "cleanupUnconfirmed"
            if e["kind"] == "job_end" and e["job"] in jobs:
                jobs[e["job"]].update(e["data"])
            if e.get("data", {}).get("originalKind") == "jobEnded" and e.get("job") in jobs:
                jobs[e["job"]].update(state="ended", report=False)
            if e["kind"] == "job_detached" and e["job"] in jobs:
                jobs[e["job"]]["report"] = True
        return list(jobs.values())

    async def _get(self, d):
        job = next((j for j in await self.list(d, None) if j["id"] == d["job"]), None)
        if job is None:
            raise AgentError("Unknown job", "refused")
        return job

    async def create(self, d, emit):
        async with self.locks.setdefault(d["session"], asyncio.Lock()):
            return await self._create(d, emit)

    async def _create(self, d, emit):
        if d.get("key") is not None:
            for job in await self.list(d, emit):
                if job.get("key") == d["key"]:
                    return {**job, "started": False}
        s = await self.api.session("get", session=d["session"])
        if s.get("closing") or s.get("moving"):
            raise AgentError("Session is not admitting jobs")
        actor = d.get("actor", s["actor"])
        authority = await self.api.session(
            "authority", session=s["id"], actor=actor, ceiling=d.get("authority")
        )
        if "jobs" not in authority:
            raise AgentError("Actor lacks authority: jobs", "forbidden")
        job = {
            "id": identity(),
            "owner": d["_caller"],
            "session": s["id"],
            "actor": actor,
            "authority": authority,
            "key": d.get("key"),
            "kind": d["kind"],
            "detail": d.get("detail", {}),
            "report": d.get("report", True),
            "turn": d.get("turn"),
            "state": "running",
        }
        await self.api.session(
            "append",
            session=s["id"],
            kind="job_start",
            writer=d["_caller"],
            actor=actor,
            job=job["id"],
            **({"call": d["call"]} if d.get("call") else {}),
            turn=job["turn"],
            data=job,
            copies=d.get("copies", []),
        )
        await self.api.event("job_started", session=s["id"], job=job)
        return {**job, "started": True}

    async def unfinished(self, d, emit):
        return [
            j
            for j in await self.list(d, emit)
            if j["state"] == "running" and j["owner"] == d["_caller"]
        ]

    async def take_up(self, d, emit):
        job = await self._get(d)
        if job["owner"] != d["_caller"] or job["state"] != "running":
            raise AgentError("Only the owner may take up an unfinished job", "forbidden")
        await self.api.event("job_resumed", session=job["session"], job=job["id"])
        return job

    async def progress(self, d, emit):
        job = await self.take_up(d, emit)
        await self.api.session(
            "append",
            session=job["session"],
            kind="job_progress",
            job=job["id"],
            writer=self.name,
            content=d.get("content", []),
        )
        await self.api.event(
            "job_progress", session=job["session"], job=job["id"], content=d.get("content", [])
        )
        return {}

    async def report(self, d, emit):
        async with self.locks.setdefault(d["session"], asyncio.Lock()):
            job = await self._end(d)
        await self._deliver(job)
        return job

    async def _end(self, d):
        job = await self._get(d)
        if job["owner"] != d["_caller"]:
            raise AgentError("Only a job's owner may report its result", "forbidden")
        state = d.get("state", "completed")
        if state not in {"completed", "failed", "cancelled", "outcome_unknown"}:
            raise AgentError("Invalid job end state")
        end = {
            "state": state,
            **({"error": d["error"]} if d.get("error") is not None else {}),
            "result": d.get("result", []),
            "usage": d.get("usage", {}),
            "report": d.get("report", job["report"]),
        }
        if job["state"] != "running":
            if d.get("strict") and any(job.get(k) != v for k, v in end.items()):
                raise AgentError("Job already ended with a different outcome", "invalid_request")
            return job
        report = {
            "actor": job["actor"],
            "content": end["result"],
            "visible": False,
            "data": {
                "when": "after",
                "key": "job:" + job["id"],
                "authority": job.get("authority", ["watch"]),
                "source": {"job": job["id"], "kind": job["kind"], "actor_kind": "agent"},
                "parked": not self.declarations["job_reports_start_turns"],
            },
        }
        await self.api.session(
            "append",
            session=job["session"],
            kind="job_end",
            **({"job_report": report} if end["report"] else {}),
            job=job["id"],
            writer=job["owner"],
            actor=job["actor"],
            data=end,
            copies=[
                *[
                    e["id"]
                    for e in await self.api.session("branch", session=job["session"])
                    if e["kind"] == "job_start" and e.get("job") == job["id"]
                ],
                *d.get("copies", []),
            ],
        )
        job.update(end)
        self.signals.setdefault((job["session"], job["id"]), asyncio.Event()).set()
        await self.api.event("job_ended", session=job["session"], job=job)
        return job

    async def _deliver(self, job):
        session = await self.api.session("get", session=job["session"])
        if not job["report"] or session.get("closing") or session.get("moving"):
            return
        if any(
            e["kind"] == "input_queued" and e["data"].get("key") == "job:" + job["id"]
            for e in session["entries"]
        ):
            await self.api.call("runtime", "kick", {"session": job["session"]})
            return
        try:
            await self.api.call(
                "runtime",
                "submit",
                {
                    "session": job["session"],
                    "actor": job["actor"],
                    "authority": job.get("authority"),
                    "key": "job:" + job["id"],
                    "when": "after",
                    "source": {"job": job["id"], "kind": job["kind"], "actor_kind": "agent"},
                    "copies": [
                        e["id"]
                        for e in session["entries"]
                        if e["kind"] == "job_end" and e.get("job") == job["id"]
                    ],
                    "content": job["result"],
                },
            )
        except AgentError as exc:
            if exc.code != "forbidden":
                raise
            await self.api.event(
                "job_report_refused",
                session=job["session"],
                job=job["id"],
                reason="Actor no longer has input authority",
            )

    async def detach(self, d, emit):
        job = await self._get(d)
        if job["owner"] != d["_caller"]:
            raise AgentError("Only a job's owner may detach it", "forbidden")
        await self.api.session(
            "append", session=job["session"], kind="job_detached", job=job["id"], writer=self.name
        )
        if job["state"] != "running":
            job["report"] = True
            await self._deliver(job)
        return {}

    async def wait(self, d, emit):
        signal = self.signals.setdefault((d["session"], d["job"]), asyncio.Event())
        while True:
            job = await self._get(d)
            if job["state"] != "running":
                # A committed end can precede report admission on another process.
                # wait is a delivery barrier, not merely a storage observation.
                if not job.get("historical"):
                    await self._deliver(job)
                return job
            await signal.wait()
            signal.clear()

    async def cancel(self, d, emit):
        job = await self._get(d)
        if job["state"] == "running":
            args = {"session": job["session"], "job": job["id"]}
            try:
                await self.api.call("job-owner:" + job["owner"], "cancel_job", args)
            except AgentError as exc:
                if exc.code != "unavailable":
                    raise
                await self.api.call(job["owner"], "cancel_job", args)
        return await self._get(d)

    async def usage(self, d, emit):
        total = {}
        for e in await self.api.session("branch", session=d["session"]):
            if e["kind"] in {"response", "job_end"}:
                for k, v in e.get("data", {}).get("usage", {}).items():
                    total[k] = total.get(k, 0) + v
        return total

    async def recover(self, d):
        for job in await self.list(d, None):
            if job["state"] not in {"running", "cleanupUnconfirmed"} and not job.get("historical"):
                await self._deliver(job)

    async def close(self, d):
        for job in await self.list(d, None):
            if job["state"] == "running":
                try:
                    await self.cancel({"session": d["session"], "job": job["id"]}, None)
                except AgentError:
                    continue  # An absent owner cannot take instructions.
