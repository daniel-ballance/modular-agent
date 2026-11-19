"""Transient subagents built only on jobs, sessions and the plugin API."""

import asyncio
import json

from ma_core import AgentError, Plugin, content, identity

DELEGATE = {
    "name": "delegate",
    "description": "Give a subagent only its task. Background jobs report later; wait returns its answer. Message a finished child again with child.",
    "schema": {
        "type": "object",
        "properties": {
            "task": {"type": "string", "minLength": 1},
            "background": {"type": "boolean"},
            "child": {"type": "string"},
        },
        "required": ["task"],
        "additionalProperties": False,
    },
    "hints": {"safe_to_repeat": True},
    "parallel": False,
    "callers": ["model", "interface", "plugin"],
    "target": "subagents",
}


class Subagents(Plugin):
    name = "subagents"
    durable = False
    declarations = {"subagents": True, "durable_subagents": False, "depth_limit": 3}

    def __init__(self):
        self.tasks = {}
        self.suspending = set()

    async def start(self, api):
        await super().start(api)
        api.provide("subagents", self)
        api.on("tools.list", self.definitions)
        api.on("session.ready", self.recover)
        api.on("session.suspend", self.suspend)
        api.on("session.end", self.close)

    async def definitions(self, d):
        return [DELEGATE]

    def _launch(self, job):
        task = self.tasks.get(job["id"])
        if task is None or task.done():
            self.tasks[job["id"]] = asyncio.create_task(
                self._work(job), name="subagent:" + job["id"]
            )

    async def run(self, d, emit):
        call = d["call"]
        sid = d["session"]
        s = await self.api.session("get", session=sid)
        authority = await self.api.session(
            "authority", session=sid, actor=call["actor"], ceiling=call.get("authority")
        )
        if "delegate" not in authority:
            raise AgentError("Actor lacks delegation authority", "forbidden")
        existing = next(
            (
                j
                for j in await self.api.call("jobs", "list", {"session": sid})
                if j["owner"] == self.name and j["key"] == call["id"]
            ),
            None,
        )
        if existing:
            job = existing
        else:
            args = call["input"]
            depth = (s.get("origin") or {}).get("depth", 0) + 1
            if depth > min(s["settings"].get("max_depth", 3), self.declarations["depth_limit"]):
                raise AgentError("Subagent depth limit reached")
            child = args.get("child")
            if child:
                cs = await self.api.session("get", session=child)
                if (cs.get("origin") or {}).get("parent") != sid:
                    raise AgentError("Child does not belong to this parent", "forbidden")
                if cs.get("busy"):
                    raise AgentError("Child still has running work")
                current = set(await self.api.session("authority", session=child, actor=cs["actor"]))
                authority = sorted(set(authority) & current)
            else:
                child = identity()
            job = await self.api.call(
                "jobs",
                "create",
                {
                    "session": sid,
                    "actor": call["actor"],
                    "authority": authority,
                    "kind": "subagent",
                    "copies": [
                        e["id"]
                        for e in s["entries"]
                        if e["kind"] == "tool_call" and e.get("call") == call["id"]
                    ],
                    "key": call["id"],
                    "turn": d.get("turn"),
                    "report": args.get("background", True),
                    "detail": {
                        "child": child,
                        "task": args["task"],
                        "project": s["project"],
                        "settings": s["settings"],
                        "depth": depth,
                    },
                },
            )
        if job["state"] == "running":
            self._launch(job)
        if job["report"]:
            return {
                "call": call["id"],
                "status": "completed",
                "content": content(json.dumps({"job": job["id"], "child": job["detail"]["child"]})),
                "value": {"job": job["id"], "child": job["detail"]["child"]},
            }
        try:
            answer = await self.api.call("jobs", "wait", {"session": sid, "job": job["id"]})
        except asyncio.CancelledError:
            session = await self.api.session("get", session=sid)
            if not session.get("suspending"):
                await self.api.call("jobs", "detach", {"session": sid, "job": job["id"]})
            raise
        return {
            "call": call["id"],
            "status": "completed" if answer["state"] == "completed" else "failed",
            "content": answer["result"],
            "value": {"job": job["id"], "child": job["detail"]["child"]},
        }

    async def _child(self, job):
        detail = job["detail"]
        child = detail["child"]
        try:
            return await self.api.session("get", session=child)
        except AgentError:
            pass
        known = await self.api.session("list")
        if any(s["id"] == child for s in known):
            return await self.api.session("open", session=child)
        return await self.api.session(
            "create",
            id=child,
            project=detail["project"],
            settings=detail["settings"],
            actor="agent:" + job["session"],
            actor_kind="agent",
            authority=job["authority"],
            origin={
                "parent": job["session"],
                "actor": job["actor"],
                "authority": job["authority"],
                "depth": detail["depth"],
            },
        )

    async def _work(self, job):
        sid, child = job["session"], job["detail"]["child"]
        try:
            cs = await self._child(job)
            key = "subagent:" + job["id"]
            queued = next(
                (
                    e
                    for e in cs["entries"]
                    if e["kind"] == "input_queued" and e["data"].get("key") == key
                ),
                None,
            )
            if queued is None:
                await self.api.call(
                    "runtime",
                    "submit",
                    {
                        "session": child,
                        "actor": cs["actor"],
                        "content": content(job["detail"]["task"]),
                        "copies": [
                            e["id"]
                            for e in (await self.api.session("get", session=sid))["entries"]
                            if e["kind"] == "job_start" and e.get("job") == job["id"]
                        ],
                        "key": key,
                        "authority": job["authority"],
                        "source": {"parent": sid, "job": job["id"]},
                    },
                )
            await self.api.call("runtime", "wait", {"session": child})
            cs = await self.api.session("get", session=child)
            ends = [e["data"] for e in cs["entries"] if e["kind"] == "turn_end"]
            if ends and ends[-1].get("error") == "Transient turn interrupted" and self.durable:
                await self.api.call(
                    "runtime",
                    "submit",
                    {
                        "session": child,
                        "actor": cs["actor"],
                        "content": content(
                            "Continue the interrupted task from this child's history. Check unknown effects before repeating work. Task: "
                            + job["detail"]["task"]
                        ),
                        "copies": [
                            e["id"]
                            for e in (await self.api.session("get", session=sid))["entries"]
                            if e["kind"] == "job_start" and e.get("job") == job["id"]
                        ],
                        "key": key + ":continue",
                        "authority": job["authority"],
                        "source": {"parent": sid, "job": job["id"]},
                    },
                )
                await self.api.call("runtime", "wait", {"session": child})
                cs = await self.api.session("get", session=child)
                ends = [e["data"] for e in cs["entries"] if e["kind"] == "turn_end"]
            if not ends:
                raise AgentError("Subagent has no completed turn")
            # Waiting questions are still work: do not report a partial child answer.
            while ends[-1].get("open_calls"):
                await asyncio.sleep(0.01)
                cs = await self.api.session("get", session=child)
                ends = [e["data"] for e in cs["entries"] if e["kind"] == "turn_end"]
            result = ends[-1]
            usage = await self._usage(job)
            await self.api.call(
                "jobs",
                "report",
                {
                    "session": sid,
                    "job": job["id"],
                    "state": "completed" if result["outcome"] == "completed" else "failed",
                    "result": result["content"],
                    "usage": usage,
                    "copies": [
                        e["id"]
                        for e in cs["entries"]
                        if e["kind"] == "turn_end" and e["data"].get("turn") == result["turn"]
                    ],
                },
            )
        except asyncio.CancelledError:
            if sid not in self.suspending:
                session = await self.api.session("get", session=sid)
                if not session.get("suspending"):
                    await self.api.call(
                        "jobs",
                        "report",
                        {
                            "session": sid,
                            "job": job["id"],
                            "state": "cancelled",
                            "usage": await self._usage(job),
                            "result": content("Subagent job cancelled"),
                        },
                    )
            raise
        except Exception as exc:
            await self.api.call(
                "jobs",
                "report",
                {
                    "session": sid,
                    "job": job["id"],
                    "state": "failed",
                    "result": content(str(exc)),
                    "usage": await self._usage(job),
                },
            )

    async def _usage(self, job):
        try:
            child = await self.api.session("get", session=job["detail"]["child"])
        except AgentError:
            return {}
        total, counting = {}, False
        for e in child["entries"]:
            if e["kind"] == "input_queued" and e["data"].get("key") == "subagent:" + job["id"]:
                counting = True
            if counting and e["kind"] in {"response", "job_end"}:
                for k, v in e["data"].get("usage", {}).items():
                    total[k] = total.get(k, 0) + v
        return total

    async def recover(self, d):
        for job in await self.api.call("jobs", "unfinished", d):
            if self.durable:
                job = await self.api.call(
                    "jobs", "take_up", {"session": d["session"], "job": job["id"]}
                )
                self._launch(job)
            else:
                await self._abandon_child(job["detail"]["child"])
                await self.api.call(
                    "jobs",
                    "report",
                    {
                        "session": d["session"],
                        "job": job["id"],
                        "state": "outcome_unknown",
                        "usage": await self._usage(job),
                        "result": content(
                            "Subagent process stopped. Outcome unknown; check outside state before relying on its work."
                        ),
                    },
                )

    async def _abandon_child(self, child):
        known = await self.api.session("list")
        if not any(s["id"] == child for s in known):
            return
        await self.api.session("open", session=child, recover=False)
        await self.api.call("runtime", "abandon", {"session": child})
        for job in await self.api.call("jobs", "unfinished", {"session": child}):
            await self._abandon_child(job["detail"]["child"])
            await self.api.call(
                "jobs",
                "report",
                {
                    "session": child,
                    "job": job["id"],
                    "state": "outcome_unknown",
                    "report": False,
                    "usage": await self._usage(job),
                    "result": content("Subagent process stopped. Outcome unknown."),
                },
            )

    async def cancel_job(self, d, emit):
        job = next(j for j in await self.api.call("jobs", "list", d) if j["id"] == d["job"])
        task = self.tasks.get(job["id"])
        if task and not task.done():
            task.cancel()
        try:
            await self.api.call("runtime", "cancel", {"session": job["detail"]["child"]})
        except AgentError:
            pass
        if task:
            await asyncio.gather(task, return_exceptions=True)
        await self.api.call(
            "jobs",
            "report",
            {
                "session": d["session"],
                "job": job["id"],
                "state": "cancelled",
                "usage": await self._usage(job),
                "result": content("Subagent job cancelled"),
            },
        )
        return {}

    async def suspend(self, d):
        sid = d["session"]
        self.suspending.add(sid)
        jobs = await self.api.call("jobs", "list", d)
        tasks = [self.tasks[j["id"]] for j in jobs if j["id"] in self.tasks]
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def close(self, d):
        children = {
            j["detail"]["child"]
            for j in await self.api.call("jobs", "list", d)
            if j["kind"] == "subagent"
        }
        children.update(await self.api.session("children", session=d["session"]))
        for child in children:
            try:
                await self.api.session("get", session=child)
            except AgentError:
                continue
            await self.api.session("close", session=child)

    async def stop(self):
        for task in self.tasks.values():
            if not task.done():
                task.cancel()
        await asyncio.gather(*self.tasks.values(), return_exceptions=True)
        self.tasks.clear()
