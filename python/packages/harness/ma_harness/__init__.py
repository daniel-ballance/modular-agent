"""Plugin host and owner of open sessions. No turn, model or tool implementation."""

import asyncio

from ma_core import API, AgentError, now
from ma_core import telemetry as ot

from .authority import Authority, PERMISSIONS, read_tenants
from .calls import CapabilityCalls
from .delivery import OutputDelivery
from .erasure import Erasure
from .history_commit import HistoryCommit
from .history_views import input_outcomes, pending_inputs, select_entries, saved_step
from .hooks import Hooks
from .interface_tools import HANDOFF, SOURCE, InterfaceTools, branch_entries
from .nested_tools import NestedTools
from .reservations import Reservations
from .session_forks import SessionForks
from .session_lifecycle import SessionLifecycle
from .session_moves import SessionMoves
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
    SessionForks,
    SessionLifecycle,
    SessionMoves,
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
            return await self._create_session(d)
        if op == "open":
            return await self._open_session(d)
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
            return await self._move(s, d, emit)
        if op == "fork":
            return await self._fork(s, d, emit)
        if op == "erase":
            return await self.erase_entries(s, d)
        if op == "close":
            return await self._close_session(s, d)
        if op == "declaration":
            return self.declarations(s["project"])
        raise AgentError("Unknown session operation: " + op)
