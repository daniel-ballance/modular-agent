"""Open, recover, suspend and close sessions. Effects run only while the writer holds one."""

import asyncio
from pathlib import Path

from ma_core import AgentError, identity, now
from ma_core.wire import recorded_as

from .authority import PERMISSIONS
from .interface_tools import branch_entries, handoff_fold, unfinished_turn


class SessionLifecycle:
    async def _start_session(self, s, attachments=None, actor=None, connection_host=False):
        sid = s["id"]
        self.sessions[sid] = s
        try:
            self.tenant_config(s.get("tenant"))
            if not self.connection_allows(s) or (
                actor is not None and not self.can_open(s, actor, local=connection_host)
            ):
                raise AgentError("Session inaccessible", "forbidden")
            if not s["entries"] and (s.get("provisional") or s.get("tenant") is not None):
                await self._append(
                    {
                        "session": sid,
                        "writer": "@harness",
                        "kind": "plugins",
                        "data": {"active": self.active_plugins()},
                    }
                )
            if connection_host:
                # This stdio launcher is a single-user deployment. It can join
                # a new principal, but can never reissue or widen a recorded grant.
                if actor in s.get("departed", []):
                    raise AgentError("Session inaccessible", "forbidden")
                if actor not in s["actors"]:
                    rights = self.session_ceiling(s)
                    if "watch" not in rights:
                        raise AgentError("Session inaccessible", "forbidden")
                    self.sessions[sid]["actors"][actor] = {
                        "kind": "host",
                        "authority": sorted(rights),
                    }
                    await self._append(
                        {
                            "session": sid,
                            "writer": "@harness",
                            "kind": "actor_joined",
                            "data": {
                                "actor": {"id": actor, "kind": "host", "rights": sorted(rights)},
                                "operatorAdmission": True,
                            },
                        }
                    )
                self.require(self.sessions[sid], actor, "watch")
                # The history store has no portable default actor. Use the
                # admitted connection for local defaults, not a synthetic user.
                self.sessions[sid]["actor"] = actor
            self._session({"session": sid, "actor": actor or s["actor"]})
            await self.guard_erasure(sid, reconcile=True)
            await self._resume_rewind(sid)
            if s["entries"] and not any(
                e["kind"] == "plugins" and e["data"]["active"] == self.active_plugins()
                for e in self.sessions[sid]["entries"][-1:]
            ):
                prior = next(
                    (
                        e["data"]["active"]
                        for e in reversed(self.sessions[sid]["entries"])
                        if e["kind"] == "plugins"
                    ),
                    None,
                )
                if prior != self.active_plugins():
                    await self._append(
                        {
                            "session": sid,
                            "kind": "plugins",
                            "writer": "@harness",
                            "data": {"active": self.active_plugins()},
                        }
                    )
            opening = {
                "session": sid,
                "project": s["project"],
                "child": bool((s.get("origin") or {}).get("parent")),
                **(attachments or {}),
            }
            await self.fire("@harness", "session.prepare", opening)
            await self.fire("@harness", "session.start", opening)
        except BaseException:
            try:
                if sid in self.interruptions:
                    await self._end_interrupted(sid)
                else:
                    await self.suspend_session(sid)
            finally:
                self.sessions.pop(sid, None)
            raise

    async def suspend_session(self, sid):
        self.forget_waits(sid)
        self.forget_interface_session(sid)
        self.sessions[sid]["suspending"] = True
        try:
            await self.fire("@harness", "session.suspend", {"session": sid})
        finally:
            if "history" in self.capabilities:
                await self.call("@harness", "history", "close", {"session": sid})
            self.sessions.pop(sid, None)

    async def stop(self):
        for s in self.sessions.values():
            s["suspending"] = True
        for sid in list(self.sessions):
            if sid in self.interruptions:
                await self._end_interrupted(sid)
            elif sid in self.sessions:
                await self.fire("@harness", "session.suspend", {"session": sid})
        for sid in list(self.sessions):
            self.forget_waits(sid)
            self.forget_interface_session(sid)
            if "history" in self.capabilities:
                await self.call("@harness", "history", "close", {"session": sid})
            del self.sessions[sid]
        for name in list(self.plugins)[::-1]:
            await self.unload(name)

    async def _effect(self, sid, callback, *args, allow_provisional=False):
        if not allow_provisional:
            self._require_materialized(self.sessions[sid])
        await self._assert_writable(sid)
        await self.guard_erasure(sid, reconcile=True)
        revision = await self.erasure_revision(sid)
        await self._assert_writable(sid)
        tasks = self.effects.setdefault(sid, {})
        task = asyncio.current_task()
        own = task not in tasks
        if own:
            tasks[task] = asyncio.Event()
        try:
            result = await callback(*args)
            if revision != await self.erasure_revision(sid):
                raise AgentError("Session content changed during an effect", "unavailable")
            return result
        except asyncio.CancelledError as exc:
            if self.sessions.get(sid, {}).get("writer_lost"):
                raise AgentError("Session interrupted", "lost") from exc
            raise
        finally:
            if own:
                tasks.pop(task).set()
            if not tasks:
                self.effects.pop(sid, None)

    def _interrupt(self, sid, reason):
        state = self.sessions.get(sid)
        if state is None or state.get("writer_lost"):
            return
        # Fence dispatch synchronously. The commit caller may be the Runtime
        # task that suspension needs to cancel and join.
        state["writer_lost"] = True
        state["interruption"] = reason
        self.interruptions[sid] = asyncio.create_task(self._finish_interruption(sid, reason))
        for task in self.effects.get(sid, ()):
            if task is not asyncio.current_task() and not task.cancelling():
                task.cancel()

    async def _finish_interruption(self, sid, reason):
        await self._emit(
            {"kind": "session_interrupted", "session": sid, "reason": reason, "time": now()}
        )
        await self.fire("@harness", "session.suspend", {"session": sid, "interrupted": reason})
        await asyncio.gather(*(settled.wait() for settled in self.effects.get(sid, {}).values()))

    async def _end_interrupted(self, sid):
        task = self.interruptions[sid]
        await asyncio.shield(task)
        if self.interruptions.get(sid) is not task:
            return
        if "history" in self.capabilities:
            await self.call("@harness", "history", "close", {"session": sid})
        self.interruptions.pop(sid, None)
        self.sessions.pop(sid, None)

    async def _assert_writable(self, sid):
        if self.sessions[sid].get("writer_lost"):
            raise AgentError("Session writer was lost; reopen before continuing", "lost")
        history = self.capabilities.get("history")
        if history and self.plugins[history[0]].declarations.get("remote_lease"):
            try:
                await self.call("@harness", "history", "writable", {"session": sid})
            except Exception as exc:
                self._interrupt(sid, "writerLost")
                raise AgentError("Session writer was lost", "lost") from exc

    def _session(self, data, *, check_actor=True):
        sid = data["session"]
        if sid not in self.sessions:
            raise AgentError("Session is not open")
        s = self.sessions[sid]
        actor = data.get("actor", s["actor"])
        if not self.connection_allows(s):
            raise AgentError("Session inaccessible", "forbidden")
        if check_actor and "actor" in data and actor not in s.get("actors", {s["actor"]: {}}):
            raise AgentError("Actor is not enrolled in the session", "forbidden")
        return s

    @staticmethod
    def _require_materialized(session):
        if session.get("provisional"):
            raise AgentError("Session has not admitted its first input", "unavailable")

    async def _create_session(self, d):
        await self.capacity.rebuild(self)
        parent = self.sessions.get((d.get("origin") or {}).get("parent"))
        tenant = parent.get("tenant") if parent else d.get("tenant")
        self.tenant_config(tenant)
        project = str(Path(d["project"]).resolve())
        if not self.connection_allows({"project": project, "tenant": tenant}):
            raise AgentError("Session inaccessible", "forbidden")
        settings = {}
        if "config" in self.capabilities:
            settings = await self.call("@harness", "config", "load", {"project": project})
        history = self.capabilities.get("history")
        provisional = (
            d.get("defer_setup")
            and history is not None
            and self.plugins[history[0]].declarations.get("retention") != "process"
        )
        self.validate_wait_setting({**settings, **d.get("settings", {})})
        s = {
            "id": d.get("id", identity()),
            "project": project,
            "created": __import__("time").time_ns() // 1_000_000,
            **(
                {"setup_pending": True} if provisional or getattr(self, "lazy_setup", False) else {}
            ),
            **({"provisional": True} if provisional else {}),
            "settings": {
                **({"approvalWait": "live"} if self.max_approval_wait_ms else {}),
                **settings,
                **d.get("settings", {}),
            },
            "actor": d.get("actor", "user"),
            "entries": [],
            "position": None,
            "plugins": list(self.plugins),
            "origin": d.get("origin"),
            "tenant": tenant,
        }
        allowed = set(d.get("authority", PERMISSIONS)) & self.admin & self.tenant & PERMISSIONS
        s["authority"] = sorted(allowed)
        s["actors"] = {
            s["actor"]: {"kind": d.get("actor_kind", "user"), "authority": sorted(allowed)}
        }
        if d.get("draft"):
            return s
        await self._start_session(s, {"mcp_servers": d.get("mcp_servers", [])})
        return self.sessions[s["id"]]

    async def _open_session(self, d):
        await self.capacity.rebuild(self)
        sid = d["session"]
        if sid in self.interruptions:
            self._session(d)
            await self._end_interrupted(sid)
        if sid in self.sessions:
            s = self._session(d)
            if d.get("actor") is not None:
                self.require(s, d["actor"], "watch")
            if "mcp_servers" in d:
                self.require(s, d.get("actor", s["actor"]), "settings")
                if s.get("busy"):
                    raise AgentError("Cannot replace session attachments during a turn")
                await self.fire(
                    "@harness",
                    "session.attach",
                    {"session": s["id"], "mcp_servers": d["mcp_servers"]},
                )
            return s
        s = await self.call("@harness", "history", "open", d)
        if s is None:
            raise AgentError("Unknown session", "unknown_session")
        if d.get("if_interrupted"):
            # The history list was a read. Another writer could have finished
            # the turn or revoked access before we acquired this lease.
            branch = branch_entries(s)
            ended = {e.get("turn") for e in branch if recorded_as(e, "turn_end")}
            if not (
                self.can_open(s, d["actor"], kind=d.get("actor_kind"))
                and unfinished_turn(branch, ended)
            ):
                await self.call("@harness", "history", "close", {"session": sid})
                return None
        policy = s["settings"].get("approval", "ask always")
        s["settings"]["approval"] = (
            policy
            if policy in ("off", "ask unless read-only", "ask always", "never ask, refuse")
            else "never ask, refuse"
        )
        self.capacity.restore(s)
        s["plugins"] = list(self.plugins)
        s.setdefault("authority", sorted(self.admin & self.tenant))
        s.setdefault("actors", {s["actor"]: {"kind": "user", "authority": s["authority"]}})
        sid = s["id"]
        recover = d.get("recover", True)
        if recover:
            # Start hooks may admit input (e.g. an unfinished job can report).
            # Only admissions loaded from history are subject to restart policy.
            prior_inputs = [e["id"] for e in s["entries"] if e["kind"] == "input_queued"]
            self.reopening.add(sid)
        try:
            await self._start_session(
                s,
                {"mcp_servers": d.get("mcp_servers", []), "resumed": True},
                d.get("actor"),
                connection_host=bool(d.get("connection_host") and d.get("actor")),
            )
            if recover:
                await self.reconcile_waits(sid, kick=False)
                await self.interface_recover(sid)
                await self._settle_nested(sid)
                if "runtime" in self.capabilities:
                    await self.call(
                        "@harness",
                        "runtime",
                        "recover",
                        {"session": sid, "prior_inputs": prior_inputs},
                    )
        finally:
            if recover:
                self.reopening.discard(sid)
        if recover:
            if "runtime" in self.capabilities:
                await self.call("@harness", "runtime", "kick", {"session": sid})
            await self.fire("@harness", "session.ready", {"session": sid})
        return self.sessions[sid]

    async def _close_session(self, s, d):
        # Closing an idle attachment is not cancellation. A close that
        # would stop work still needs cancel, just like an explicit cancel.
        sid = s["id"]
        started = {e["job"] for e in s["entries"] if e["kind"] == "job_start"}
        ended = {e["job"] for e in s["entries"] if e["kind"] == "job_end"}
        open_interface = any(not result for _, _, result in handoff_fold(s["entries"]).values())
        if "actor" in d and (s.get("busy") or started - ended or open_interface):
            self.require(s, d["actor"], "cancel")
            if represented_by := d.get("acting_for"):
                self.require(s, represented_by, "cancel")
        self.sessions[sid]["closing"] = True
        if sid in self.interruptions:
            await self._end_interrupted(sid)
            return {}
        await self.fire(
            "@harness",
            "session.suspend" if s.get("writer_lost") else "session.end",
            {"session": sid},
        )
        if "history" in self.capabilities:
            await self.call("@harness", "history", "close", {"session": sid})
        self.forget_interface_session(sid)
        self.forget_waits(sid)
        del self.sessions[sid]
        return {}
