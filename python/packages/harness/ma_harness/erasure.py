"""Coordinate native history erasure without treating a lease as read authority."""

from collections import defaultdict

from ma_core import AgentError, silent

from .authority import CONNECTION_AUTHORITY


class Erasure:
    def supports_erasure(self):
        history = self.capabilities.get("history")
        if history is None:
            return False
        declaration = self.plugins[history[0]].declarations
        return bool(declaration.get("erasure") and declaration.get("pending_erasure"))

    def _erasure_view(self, sid):
        state = self.sessions.get(sid, {})
        return {
            "session": sid,
            "provisional": bool(state.get("provisional")),
            "tombstones": state.get("_history_tombstones", []),
        }

    async def _pending_erasure(self, sid):
        if not self.supports_erasure():
            return []
        return await self.call("@harness", "history", "pending_erasure", self._erasure_view(sid))

    async def erasure_revision(self, sid):
        if not self.supports_erasure():
            return 0
        return await self.call("@harness", "history", "erasure_revision", self._erasure_view(sid))

    async def guard_erasure(self, sid, *, reconcile=False):
        if reconcile and sid in self.sessions and await self._pending_erasure(sid):
            if not await self._reconcile_erasure(sid):
                raise AgentError("Session content is pending erasure", "unavailable")
        await self.erasure_revision(sid)

    async def _reconcile_erasure(self, sid):
        async with self.erasure_locks.setdefault(sid, __import__("asyncio").Lock()):
            pending = await self._pending_erasure(sid)
            if not pending:
                return True
            s = self.sessions[sid]
            if s.get("busy") or s.get("closing") or s.get("writer_lost"):
                return False
            entries = s["entries"]
            jobs = {e.get("job") for e in entries if e["kind"] == "job_start"}
            jobs -= {e.get("job") for e in entries if e["kind"] == "job_end"}
            calls = {e.get("call") for e in entries if e["kind"] == "tool_deferred"}
            calls -= {e.get("call") for e in entries if e["kind"] == "tool_result"}
            affected = {p["id"] for p in pending}
            token = CONNECTION_AUTHORITY.set(None)
            try:
                await self.reconcile_waits(sid, reason="cancelled", affected=affected, kick=False)
            finally:
                CONNECTION_AUTHORITY.reset(token)
            calls -= {
                e.get("call") for e in self.sessions[sid]["entries"] if e["kind"] == "tool_result"
            }
            if any(
                e["id"] in affected and (e.get("job") in jobs or e.get("call") in calls)
                for e in entries
            ):
                return False
            token = CONNECTION_AUTHORITY.set(None)
            try:
                await self.interface_settle(sid, "Interface handoff erased", affected=affected)
                return await self._apply_erasure(sid, pending)
            finally:
                CONNECTION_AUTHORITY.reset(token)

    async def _apply_erasure(self, sid, pending):
        groups = defaultdict(list)
        for p in pending:
            groups[p["intent"], p.get("recordId")].append(p["id"])
        for key in [k for k in self.output_streams if k[2] == sid]:
            for reservation, _ in self.output_streams.pop(key) or ():
                self.capacity.release(reservation)
        for (operation, record_id), targets in groups.items():
            s = self.sessions[sid]
            if not any(
                e["kind"] == "erase"
                and (e["id"] == record_id if record_id else e["data"].get("operation") == operation)
                for e in s["entries"]
            ):
                reservations = [
                    {
                        "inputId": row["data"].get("input") or row["id"],
                        "key": row["data"]["key"],
                        "actorId": row["actor"],
                        "submittedBy": row["data"].get("submittedBy", row["actor"]),
                    }
                    for row in s["entries"]
                    if row["id"] in targets
                    and row["kind"] == "input_queued"
                    and row["data"].get("key")
                ]
                await self.handle(
                    "append",
                    {
                        "session": sid,
                        "writer": "@harness",
                        "kind": "erase",
                        **({"id": record_id} if record_id is not None else {}),
                        "data": {
                            "operation": operation,
                            "entryIds": targets,
                            "inputKeys": reservations,
                        },
                    },
                    silent,
                )
            # Discard before lifting the pending mark. A failed remote request does
            # not give evidence of deletion or allow a subsequent affected model call.
            for plugin in self.plugins.values():
                if erase_provider := getattr(type(plugin), "erase_provider", None):
                    result = await erase_provider(plugin, sid, targets)
                    if result.get("pending") or result.get("outOfReach"):
                        return False
            await self.call(
                "@harness",
                "history",
                "erase",
                {
                    "session": sid,
                    "entries": targets,
                    "intent": operation,
                },
            )
        loaded = await self.call("@harness", "history", "read", {"session": sid})
        if not loaded:
            return False
        self.sessions[sid] = {**self.sessions[sid], **loaded}
        self.capacity.restore(self.sessions[sid])
        await self.fire("@harness", "session.invalidate", {"session": sid, "reason": "erasure"})
        return not await self._pending_erasure(sid)

    async def erase_entries(self, s, d):
        if not self.supports_erasure():
            raise AgentError("History does not coordinate pending erasure", "not_supported")
        sid = s["id"]
        ids = d.get("entries")
        if (
            not isinstance(ids, list)
            or not ids
            or any(not isinstance(i, str) or not i for i in ids)
        ):
            raise AgentError("Erasure requires entry IDs", "invalid_request")
        if s.get("busy"):
            raise AgentError("Erasure requires an idle turn", "busy")
        self._require_materialized(s)
        request = {"session": sid, "entries": ids}
        await self._assert_writable(sid)
        async with self.interface_lock(sid):
            progress = await self.call("@harness", "history", "publish_erasure", request)
        for destination in dict.fromkeys(p["sessionId"] for p in progress if not p["confirmed"]):
            if destination in self.sessions:
                await self._reconcile_erasure(destination)
                continue
            try:
                # A held copy stays pending for its current or next writer.
                loaded = await self.call(
                    "@harness", "history", "open", {"session": destination, "wait_for_lease": False}
                )
            except AgentError as exc:
                if exc.code not in {"locked", "held", "unknown_session", "not_found"}:
                    raise
                continue
            try:
                if loaded:
                    self.sessions[destination] = loaded
                    await self._reconcile_erasure(destination)
            finally:
                self.sessions.pop(destination, None)
                await self.call("@harness", "history", "close", {"session": destination})
        progress = await self.call("@harness", "history", "publish_erasure", request)
        result = {
            "erasedPairs": [],
            "pendingPairs": [],
            "out_of_reach": ["Output already delivered to recipients"],
        }
        hidden = False
        views = {}
        for p in progress:
            destination = p["sessionId"]
            if destination not in views:
                views[destination] = self.sessions.get(destination) or await self.call(
                    "@harness", "history", "read", {"session": destination}
                )
            view = views[destination]
            if view is None or "watch" not in self.permissions(view, d.get("actor", s["actor"])):
                hidden = True
                continue
            result["erasedPairs" if p["confirmed"] else "pendingPairs"].append(
                {"sessionId": destination, "id": p["id"]}
            )
        if hidden:
            result["out_of_reach"].append("copies in other sessions")
        for state in ("erased", "pending"):
            result[state] = [p["id"] for p in result[state + "Pairs"]]
        return result
