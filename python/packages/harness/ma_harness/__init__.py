"""Plugin host and owner of open sessions. No turn, model or tool implementation."""

import asyncio
from pathlib import Path

from ma_core import API, AgentError, clone, identity, now
from ma_core import telemetry as ot
from ma_core.wire import recorded_as

from .authority import Authority, PERMISSIONS, read_tenants
from .calls import CapabilityCalls
from .delivery import OutputDelivery
from .erasure import Erasure
from .history_commit import HistoryCommit
from .history_views import input_outcomes, pending_inputs, select_entries, saved_step
from .hooks import Hooks
from .interface_tools import (
    HANDOFF,
    SOURCE,
    InterfaceTools,
    branch_entries,
    handoff_fold,
    unfinished_turn,
)
from .nested_tools import NestedTools
from .reservations import Reservations
from .waiting_approvals import WaitingApprovals, marked, waiting_entries


class Harness(
    Authority,
    CapabilityCalls,
    Erasure,
    HistoryCommit,
    Hooks,
    InterfaceTools,
    NestedTools,
    OutputDelivery,
    WaitingApprovals,
):
    def __init__(
        self,
        admin=None,
        tenant=None,
        process_plugins=None,
        *,
        tenants=None,
        reservations=None,
        agent_name=None,
    ):
        import os

        placement = (
            process_plugins if process_plugins is not None else os.getenv("MA_PLUGIN_PROCESSES", "")
        )
        self.process_plugins = (
            set(placement.split(",")) if isinstance(placement, str) else set(placement)
        )
        self.admin = set(PERMISSIONS if admin is None else admin)
        self.tenant = set(PERMISSIONS if tenant is None else tenant)
        self.tenants = (
            read_tenants(os.getenv("MODULAR_AGENT_TENANTS", "{}"))
            if tenants is None
            else read_tenants(__import__("json").dumps(tenants))
        )
        self.plugins = {}
        self.capabilities = {}
        self.hooks = {}
        self.handlers = []
        self.commands = {}
        self.sessions = {}
        self.interruptions = {}
        self.effects = {}
        self.reopening = set()
        self.append_locks = {}
        self.tool_dispatches = {}
        self.followers = []
        self.delivery_observers = {}
        self.erase_host_reads = None
        self.commit_listeners = {}  # Per-session synchronous notifications after publication.
        self.output_streams = {}
        self.continuation_waiters = {}
        self.erasure_locks = {}
        self.capacity = Reservations(reservations)
        self.trace = []
        self.agent_name = agent_name
        self.provider_trace_ids = {}
        self.init_interface_tools()
        self.init_waiting_approvals()
        self.define_hook("@harness", "plugin.load", "gate")
        self.define_hook("@harness", "session.prepare", "observe")
        self.define_hook("@harness", "session.join", "observe")
        self.define_hook("@harness", "session.leave", "observe")
        self.define_hook("@harness", "provider.piece", "observe")
        self.define_hook("@harness", "session.start", "observe")
        self.define_hook("@harness", "session.end", "observe")
        self.define_hook("@harness", "session.suspend", "observe")
        self.define_hook("@harness", "session.ready", "observe")
        self.define_hook("@harness", "session.attach", "observe")
        self.define_hook("@harness", "session.moving", "observe")
        self.define_hook("@harness", "session.invalidate", "observe")
        self.define_hook("@harness", "input.arrives", "transform")
        self.define_hook("@harness", "turn.prepare", "collect")
        self.define_hook("@harness", "output", "transform")
        self.define_hook("@harness", "binding.output", "gate")

    def api(self, owner="embedding", role="feature"):
        return API(self, owner, role)

    async def load(self, plugin, replaces=None, process=None):
        if self.sessions:
            raise AgentError("Plugins are fixed while sessions are open")
        if replaces:
            if replaces not in self.plugins:
                raise AgentError("Replacement target does not exist")
            await self.unload(replaces)
        if plugin.name in self.plugins:
            raise AgentError("Duplicate plugin: " + plugin.name)
        decision = await self.fire("@harness", "plugin.load", {"plugin": plugin.name})
        if decision.get("refused"):
            raise AgentError(decision["reason"], "refused")
        if process is None:
            process = bool(self.process_plugins & {"all", plugin.name, plugin.role})
        if process:
            from ma_process import ProcessPlugin

            plugin = ProcessPlugin(plugin)
        self.plugins[plugin.name] = plugin
        try:
            await plugin.start(API(self, plugin.name, plugin.role))
        except BaseException:
            await self.unload(plugin.name)
            raise

    async def attach_interface(self, interface):
        """Attach connection-local callbacks, not a change to the composition."""
        if interface.role != "interface" or interface.name in self.plugins:
            raise AgentError("Invalid Interface attachment")
        interface.connection_local = True
        self.plugins[interface.name] = interface
        try:
            await interface.start(API(self, interface.name, "interface"))
        except BaseException:
            await self.unload(interface.name)
            raise

    async def load_named(self, spec):
        """Check before importing executable plugin code from an approved settings plan."""
        if self.sessions:
            raise AgentError("Plugins are fixed while sessions are open")
        decision = await self.fire(
            "@harness", "plugin.load", {"plugin": spec["factory"], "project": spec.get("project")}
        )
        if decision.get("refused"):
            raise AgentError(decision["reason"], "refused")
        import importlib

        module, separator, factory = spec["factory"].partition(":")
        if not separator or not module or not factory or "." in factory:
            raise AgentError("Plugin factory must be module:attribute")
        plugin = getattr(importlib.import_module(module), factory)(**spec.get("options", {}))
        await self.load(plugin, replaces=spec.get("replaces"), process=spec.get("process"))

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

    async def unload(self, name):
        plugin = self.plugins.pop(name)
        try:
            await plugin.stop()
        finally:
            self.capabilities = {k: v for k, v in self.capabilities.items() if v[0] != name}
            self.hooks = {k: v for k, v in self.hooks.items() if v[0] != name}
            self.handlers = [h for h in self.handlers if h[0] != name]
            self.commands = {k: v for k, v in self.commands.items() if v[0] != name}
            self.followers = [f for f in self.followers if f[0] != name]

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

    def provide(self, owner, name, service):
        if name in self.capabilities:
            raise AgentError("Duplicate capability: " + name)
        self.capabilities[name] = (owner, service)

    def command(self, owner, name, description, handler):
        if name in self.commands:
            raise AgentError("Duplicate command: " + name)
        self.commands[name] = (owner, description, handler)

    def follow(self, owner, recipient, handler):
        self.followers.append((owner, recipient, handler))

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

    def active_plugins(self):
        active = [
            {"name": name}
            for name in dict.fromkeys(
                getattr(plugin, "registration", {}).get("name", key)
                for key, plugin in self.plugins.items()
                if not getattr(plugin, "connection_local", False)
            )
        ]
        if self.interface_tools:
            active.append({"name": SOURCE})
        return active

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

    def declarations(self, project=None):
        active = {
            self.capabilities[k][0] for k in ("runtime", "environment") if k in self.capabilities
        }
        parts = {
            name: p.declarations
            for name, p in sorted(self.plugins.items(), key=lambda pair: pair[0] not in active)
            if not getattr(p, "connection_local", False)
            and (
                name in active
                or p.role not in {"runtime", "environment"}
                or not (
                    "parallel_tools" in p.declarations
                    or "stops_commands_on_crash" in p.declarations
                )
            )
        }
        if project is not None and "environment" in self.capabilities:
            name, environment = self.capabilities["environment"]
            # Remote services synthesize RPC methods via __getattr__; only a real
            # local method can override the static wire declaration here.
            if name in parts and (keeps_points := getattr(type(environment), "keeps_points", None)):
                parts[name] = {**parts[name], "rewind": keeps_points(environment, project)}
        return parts

    async def handle(self, op, d, emit):
        operation = {
            "create": "new",
            "open": "resume" if d.get("recover", True) else "load",
            "close": "close",
        }.get(op)
        # SDK session creation also includes actor joins and the first commit.
        if operation is None or d.get("draft") or (op == "create" and d.get("trace_at_caller")):
            return await self._handle(op, d, emit)
        action = "close" if op == "close" else "open"
        with ot.span(
            "modular_agent.session." + action,
            ot.attrs(
                d.get("session"),
                **{
                    "modular_agent.session.operation": operation,
                },
            ),
        ) as span:
            result = await self._handle(op, d, emit)
            if op == "create":
                ot.set_attrs(span, {"gen_ai.conversation.id": result["id"]})
            return result

    async def _handle(self, op, d, emit):
        if op == "bound_model_response":
            return self.capacity.model_response(self._session(d), d["response"], d["step"])
        if op == "prepare_model_request":
            _, provider = self.capabilities[d["access"]["target"]]
            if prepare := getattr(type(provider), "prepare_request", None):
                return await prepare(provider, d)
            return d
        if op == "credential_names":
            selection = self.capabilities.get("selection")
            return sorted(selection[1].providers) if selection else []
        if op == "writer_lost":
            self._interrupt(d["session"], "writerLost")
            return {}
        if op == "assert_writable":
            await self._assert_writable(d["session"])
            return {}
        if op == "create":
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
                    {"setup_pending": True}
                    if provisional or getattr(self, "lazy_setup", False)
                    else {}
                ),
                **({"provisional": True} if provisional else {}),
                "settings": {
                    "approval": "off",
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
        if op == "open":
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
        if op == "list":
            return await self.call("@harness", "history", "list", d)
        if op == "declaration" and "session" not in d:
            return self.declarations()
        if op == "commands":
            return {k: v[1] for k, v in self.commands.items()}
        if op == "command":
            command_session = self._session(d)
            ceiling = (
                self.permissions(command_session, d["acting_for"]) if d.get("acting_for") else None
            )
            self.require(
                command_session, d.get("actor", command_session["actor"]), "input", ceiling
            )
            await self._assert_writable(d["session"])
            name, _, args = d["text"].removeprefix("/").partition(" ")
            if name not in self.commands:
                raise AgentError("Unknown command: /" + name)
            reservation = self.capacity.hold(command_session, calls=1, storageBytes=65536)
            try:
                return await self._effect(
                    d["session"],
                    self.commands[name][2],
                    {**d, "actor": d.get("actor", command_session["actor"]), "args": args},
                    allow_provisional=True,
                )
            finally:
                self.capacity.release(reservation)
        if op == "event":
            if d.get("kind") == "turn_ended":
                for key in list(self.provider_trace_ids):
                    if key[0] == d.get("session"):
                        del self.provider_trace_ids[key]
            if d.get("kind") == "plugin_failed" and "session" not in d and self.sessions:
                for sid in list(self.sessions):
                    await self._emit({"time": now(), **d, "session": sid})
            else:
                await self._emit({"time": now(), **d})
            return {}
        if op == "erasure_cutoff":
            history = self.capabilities.get("history")
            if history and self.plugins[history[0]].declarations.get("remote_lease"):
                return await self.erasure_revision(d["session"])
            return 0
        if op == "view":
            return await self._view(d)
        s = self._session(d, check_actor=op not in {"append", "authority"})
        sid = s["id"]
        permission = {
            "settings": "settings",
            "move": "settings",
            "fork": "input",
            "erase": "erase",
        }.get(op)
        if permission and "actor" in d:
            self.require(s, d["actor"], permission)
        if op == "get":
            if d.get("include_entries", True):
                return s
            return {k: v for k, v in s.items() if k != "entries"}
        if op == "entries":
            return select_entries(s["entries"], d)
        if op == "context_records":
            # The context plugin needs visible records and call dispositions.
            # Model intents are feedback barriers, not model context.
            return [
                {"kind": "model_started", "turn": e.get("turn")}
                if e["kind"] == "model_started" and not e["visible"]
                else e
                for e in branch_entries(s)
                if e["visible"]
                or e["kind"] in {"tool_call", "tool_result"}
                or (
                    e.get("turn") == d.get("turn")
                    and e["kind"] in {"model_started", "result_feedback"}
                )
            ]
        if op == "pending_inputs":
            ready = []
            if not d.get("proposals") and any(
                e["kind"] == HANDOFF or marked(e) for e in s["entries"]
            ):
                ready = await self.interface_ready(sid)
            return pending_inputs(s["entries"], d.get("proposals"), ready)
        if op == "input_outcome":
            return input_outcomes(s["entries"], d["input"]).get(d["input"])
        if op == "input_outcomes":
            return input_outcomes(s["entries"])
        if op == "step_offer":
            return next(
                (
                    e["data"].get("tools", [])
                    for e in s["entries"]
                    if e.get("step") == d["step"] and e["kind"] == "model_started"
                ),
                [],
            )
        if op == "step_checkpoint":
            response, checkpoint = saved_step(s, d["turn"], d.get("step"))
            return (response, checkpoint) if d.get("include_response") else checkpoint
        if op == "children":
            return [
                child["id"]
                for child in self.sessions.values()
                if (child.get("origin") or {}).get("parent") == sid
            ]
        if op == "config_view":
            return {
                "settings": s["settings"],
                "catalog": await self.call("@harness", "selection", "catalog", {}),
            }
        if op == "authority":
            return sorted(self.permissions(s, d.get("actor", s["actor"]), d.get("ceiling")))
        if op == "tenant":
            return await self.tenant_info(s)
        if op == "tenant_exhausted":
            tokens = (await self.tenant_info(s))["tokens"]
            return tokens is not None and tokens["used"] >= tokens["budget"]
        if op == "limit":
            actor = d.get("actor", s["actor"])
            requested = PERMISSIONS if d["rights"] is None else set(d["rights"]) & PERMISSIONS
            unbounded = {**s, "limit": None}
            ceiling = self.permissions(unbounded, actor)
            if represented_by := d.get("acting_for"):
                ceiling &= self.permissions(unbounded, represented_by)
            if "administer" not in ceiling or not requested <= ceiling:
                raise AgentError("Session limit exceeds administrator authority", "forbidden")
            return await self.handle(
                "append",
                {
                    **d,
                    "writer": "@harness",
                    "kind": "limit",
                    "data": {"rights": d["rights"]},
                },
                emit,
            )
        if op == "grant":
            entry = await self.grant(d)
            await self.fire("@harness", "session.join", {**d, "entry": entry})
            return entry
        if op == "leave":
            entry = await self.leave(d)
            await self.fire("@harness", "session.leave", {**d, "entry": entry})
            return entry
        if op == "input":
            defer_command = d.pop("_defer_command", False)
            result = await self.fire("@harness", "input.arrives", d)
            if not defer_command and result.get("handled") and (command := result.get("command")):
                result["result"] = await self.handle("command", {**d, "text": command}, emit)
            return result
        if op == "prepare":
            return await self.fire("@harness", "turn.prepare", d)
        if op == "invalidate":
            await self.fire("@harness", "session.invalidate", d)
            return {}
        if op == "branch":
            return select_entries(branch_entries(s), d)
        if op == "waiting_gate":
            return await self.waiting_gate(d["gate"], d["ask"], d["question"], d["covers_nested"])
        if op == "interface_dispatch":
            return await self.interface_dispatch(d)
        if op == "interface_settle":
            await self.interface_settle(sid, d["reason"], turn=d.get("turn"))
            return {}
        if op == "interface_work_rights":
            return sorted(self.interface_work_rights(s, d["turn"], d["actor"]))
        if op == "interface_ready":
            return await self.interface_ready(sid)
        if op == "append":
            async with self.append_locks.setdefault(sid, asyncio.Lock()):
                entries = await self._append(d)
            if entries[0].get("denied"):
                return entries[0]
            for entry in entries:
                await self._emit({"kind": "history_entry", "session": sid, "entry": entry})
            if d["kind"] in {"limit", "authority", "actor_left"} and len(entries) > 1:
                for closed in entries[1:]:
                    if closed["kind"] == "question_closed":
                        qid = closed["data"]["request"]
                        await self.call(
                            "@harness",
                            "questions",
                            "notify_closed",
                            {"session": sid, "request": qid},
                        )
                await self.interface_kick(sid)
            if d["kind"] in {"limit", "authority", "actor_left", "setting"} and waiting_entries(
                self.sessions[sid]
            ):
                # Once a principal loses eligibility, restoring rights needs a fresh delivery.
                self.prune_wait_deliveries(sid)
                await self.reconcile_waits(sid)
            if d["kind"] == "turn_end" and d["data"].get("outcome") != "completed":
                await self.reconcile_waits(sid, reason="cancelled", turn=d["turn"], kick=False)
            return entries[0]
        if op == "settings":
            self.validate_wait_setting(d["changes"])
            if s.get("busy"):
                raise AgentError("Settings may change only between turns")
            e = await self.handle("append", {**d, "kind": "setting", "data": d["changes"]}, emit)
            await self.fire(
                "@harness", "session.invalidate", {"session": sid, "reason": "settings"}
            )
            return e
        if op == "busy":
            if d.get("unless_reopening") and sid in self.reopening:
                return {"deferred": True}
            s["busy"] = d["value"]
            return {}
        if op == "move":
            if any(not self.wait_state(s, e)[2] for e in waiting_entries(s)):
                raise AgentError("Cannot move with a waiting approval", "conflict")
            self._require_materialized(s)
            if s.get("busy") or any(
                not ended for _, _, ended in handoff_fold(s["entries"]).values()
            ):
                raise AgentError("Cannot move with unfinished work", "busy")
            if d.get("rewind"):
                if not any(p.get("rewind") for p in self.declarations(s["project"]).values()):
                    raise AgentError("Working environment does not support rewind", "not_supported")
                if any(
                    x["id"] != sid and x["project"] == s["project"] for x in self.sessions.values()
                ):
                    raise AgentError("Another open session uses this project", "busy")
            ids = {e["id"] for e in s["entries"] if e["kind"] != "position_move"}
            if d["point"] is not None and d["point"] not in ids:
                code = (
                    "conflict" if any(e["id"] == d["point"] for e in s["entries"]) else "not_found"
                )
                raise AgentError("Unknown or ineligible history point", code)
            branch = await self.handle("branch", d, emit)
            if d["point"] is not None:
                target = next((e for e in branch if e["id"] == d["point"]), None)
                if target is None or (target.get("turn") and target["kind"] != "turn_end"):
                    raise AgentError(
                        "Move needs a quiescent point on the current branch", "conflict"
                    )
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
        if op == "fork":
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
                branch = branch[
                    : next(i for i, e in enumerate(branch) if e["id"] == d["point"]) + 1
                ]
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
            branch = [
                e for e in branch if not recorded_as(e, HANDOFF) and e["kind"] != ot.TURN_TRACE
            ]
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
        if op == "erase":
            return await self.erase_entries(s, d)
        if op == "close":
            # Closing an idle attachment is not cancellation. A close that
            # would stop work still needs cancel, just like an explicit cancel.
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
        if op == "declaration":
            return self.declarations(s["project"])
        raise AgentError("Unknown session operation: " + op)
