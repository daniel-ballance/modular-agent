"""Plugin host and owner of open sessions. No turn, model or tool implementation."""

import asyncio
from pathlib import Path

from ma_core import API, AgentError, Stop, clone, content, identity, now, silent
from ma_core import telemetry as ot
from ma_core.wire import provider_projection, recorded_as

from .authority import Authority, PERMISSIONS, read_tenants
from .erasure import Erasure
from .output import gate
from .reservations import Reservations, size


class Harness(Authority, Erasure):
    MAX_TOOL_DEPTH = 4

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
        self.output_streams = {}
        self.erasure_locks = {}
        self.capacity = Reservations(reservations)
        self.trace = []
        self.agent_name = agent_name
        self.provider_trace_ids = {}
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
            if "history" in self.capabilities:
                await self.call("@harness", "history", "close", {"session": sid})
            del self.sessions[sid]
        for name in list(self.plugins)[::-1]:
            await self.unload(name)

    def provide(self, owner, name, service):
        if name in self.capabilities:
            raise AgentError("Duplicate capability: " + name)
        self.capabilities[name] = (owner, service)

    def define_hook(self, owner, name, rule):
        if rule not in {"observe", "gate", "transform", "first", "collect"}:
            raise AgentError("Unknown combination rule")
        if name in self.hooks:
            raise AgentError("Hook already defined: " + name)
        self.hooks[name] = (owner, rule)

    def on(self, owner, name, handler, order):
        if order not in {"first", "normal", "last"}:
            raise AgentError("Invalid handler order")
        self.handlers.append((owner, name, handler, order))

    def command(self, owner, name, description, handler):
        if name in self.commands:
            raise AgentError("Duplicate command: " + name)
        self.commands[name] = (owner, description, handler)

    def follow(self, owner, recipient, handler):
        self.followers.append((owner, recipient, handler))

    async def fire(self, owner, name, data):
        if name not in self.hooks or self.hooks[name][0] != owner:
            raise AgentError("Only the hook's owner may fire " + name, "forbidden")
        rule = self.hooks[name][1]
        value, answers = clone(data), []
        handlers = [h for h in self.handlers if h[1] == name]
        handlers.sort(key=lambda h: {"first": 0, "normal": 1, "last": 2}[h[3]])
        for _, _, handler, _ in handlers:
            try:
                answer = await handler(clone(value))
            except Exception as exc:
                if (
                    rule in {"observe", "collect"}
                    and isinstance(exc, AgentError)
                    and exc.code == "process_lost"
                ):
                    continue  # Reported lost sources no longer contribute tools or observations.
                if rule == "gate":
                    return {**value, "refused": True, "reason": str(exc)}
                raise
            if rule == "observe":
                continue
            if rule == "collect":
                if answer is not None:
                    answers.append(answer)
            elif rule == "first":
                if answer is not None:
                    return answer
            elif isinstance(answer, Stop):
                return answer.value
            elif answer is not None:
                value = answer
            if rule == "gate" and value.get("refused"):
                break
        return answers if rule == "collect" else (None if rule == "first" else value)

    async def call(self, caller, target, operation, data, emit=silent):
        self.trace.append((caller, target, operation))  # Metadata only, never content or secrets.
        data = clone(data)
        if target in {"jobs", "questions", "credentials"}:
            plugin = self.plugins.get(caller)
            data["_caller"] = (
                getattr(plugin, "registration", {}).get("name", caller)
                if target == "jobs"
                else caller
            )
            data["_caller_role"] = self.plugins[caller].role if caller in self.plugins else None
        if target == "@harness":
            return clone(await self.handle(operation, data, emit))
        if target not in self.capabilities:
            raise AgentError("Unavailable capability: " + target, "unavailable")
        _, service = self.capabilities[target]
        method = getattr(service, operation, None)
        if method is None or operation.startswith("_"):
            raise AgentError("Unknown operation: " + operation)
        sid = data.get("session")
        effect = (
            isinstance(sid, str)
            and sid in self.sessions
            and (
                operation in {"run", "bash", "write", "restore", "save", "generate"}
                or (
                    target == "environment"
                    and operation
                    in {"read", "read_bytes", "write_bytes", "list_directory", "exists"}
                )
            )
            and (target != "runtime" and target != "history")
        )
        if target != "tools" or operation != "run" or "call" not in data:
            if effect:
                return clone(
                    await self._effect(
                        sid,
                        method,
                        data,
                        emit,
                        allow_provisional=target == "environment"
                        and operation in {"read", "read_bytes", "list_directory", "exists"},
                    )
                )
            return clone(await method(data, emit))
        call = data["call"]
        if call.get("parentCallId") and (definition := data.get("definition")):
            tools = await self.call("@harness", "tools", "definitions", {"session": sid})
            current = next((t for t in tools if t["name"] == call["name"]), None)
            if current != definition:
                return {
                    "call": call["id"],
                    "status": "refused",
                    "content": content("Tool registration changed before dispatch"),
                }
            await self._assert_writable(sid)
        if "tools" not in self.permissions(
            self.sessions[sid], call["actor"], call.get("authority")
        ):
            raise AgentError("Actor lacks authority: tools", "forbidden")
        token = identity()
        scope = {"data": data, "children": set(), "closing": False}
        self.tool_dispatches[token] = scope
        attributes = ot.tool_attrs(
            sid, data.get("turn"), data.get("step"), call, data["definition"]["name"]
        )
        provider_id = ot.name(self.provider_trace_ids.pop((sid, call["id"]), None))
        if provider_id:
            attributes["gen_ai.tool.call.id"] = provider_id
        tool_name = attributes.get("gen_ai.tool.name")
        with ot.span(
            "execute_tool " + tool_name if tool_name else "execute_tool", attributes
        ) as operation:
            return await self._dispatch_tool(sid, method, data, emit, token, scope, operation)

    async def _dispatch_tool(self, sid, method, data, emit, token, scope, operation):
        try:
            result = clone(await self._effect(sid, method, {**data, "dispatch": token}, emit))
            status = ot.tool_status(result)
            ot.set_attrs(operation, {"modular_agent.tool.status": status})
            if status == "failed":
                ot.error(operation, "tool_failed")
            return result
        except asyncio.CancelledError:
            ot.set_attrs(operation, {"modular_agent.tool.status": "cancelled"})
            raise
        except Exception:
            ot.set_attrs(operation, {"modular_agent.tool.status": "failed"})
            raise
        finally:
            scope["closing"] = True
            children = list(scope["children"])
            for task in children:
                if not task.done() and not task.cancelling():
                    task.cancel()
            if children:
                await asyncio.gather(*children, return_exceptions=True)
            self.tool_dispatches.pop(token, None)

    async def nested_tools(self, token, name=None, arguments=None):
        scope = self.tool_dispatches.get(token)
        if scope is None or scope["closing"]:
            raise AgentError("Nested tools need a live dispatched parent", "invalid_request")
        runtime = self.capabilities.get("runtime", (None, None))[0]
        if runtime is None or not self.plugins[runtime].declarations.get("nested_tools"):
            raise AgentError("Nested calls are unavailable", "not_supported")
        parent = scope["data"]
        sid, turn, step = (parent.get(k) for k in ("session", "turn", "step"))
        source = parent["call"]

        async def definitions():
            return await self.call("@harness", "tools", "definitions", {"session": sid})

        if name is None:
            return [t for t in await definitions() if "plugin" in t.get("callers", [])]
        if not isinstance(name, str) or not name or not isinstance(arguments, dict):
            raise AgentError("Nested tools need a name and object input", "invalid_request")
        depth = source.get("nesting_depth", 1) + 1
        call = {
            "id": identity(),
            "name": name,
            "input": clone(arguments),
            "actor": source["actor"],
            "authority": source.get("authority"),
            "initiator": "tool",
            "parentCallId": source["id"],
            "nesting_depth": depth,
        }

        async def run():
            answer = None
            try:
                await self.handle(
                    "append",
                    {
                        "session": sid,
                        "turn": turn,
                        "step": step,
                        "actor": call["actor"],
                        "kind": "tool_call",
                        "call": call["id"],
                        "data": call,
                        "writer": "@harness",
                    },
                    silent,
                )
                if depth > self.MAX_TOOL_DEPTH:
                    answer = {
                        "status": "refused",
                        "content": content("Tool nesting depth exceeded"),
                    }
                else:
                    definition = next((t for t in await definitions() if t["name"] == name), None)
                    answer = await self.call(
                        "@harness",
                        "runtime",
                        "dispatch_nested",
                        {
                            "session": sid,
                            "turn": turn,
                            "step": step,
                            "call": call,
                            "definition": definition,
                        },
                    )
                    if answer.get("open"):
                        await self._close_nested_questions(sid, call["id"])
                        answer = {
                            "status": "refused",
                            "content": content("Nested calls cannot be left open"),
                        }
            finally:
                if sid in self.sessions and not self.sessions[sid].get("suspending"):
                    await self._settle_nested(sid, only=call["id"], answer=answer, cancelled=True)
            return {**answer, "call": call["id"]}

        task = asyncio.create_task(run(), name="nested-tool:" + call["id"])
        scope["children"].add(task)
        try:
            return await task
        finally:
            scope["children"].discard(task)

    async def _close_nested_questions(self, sid, call):
        if "questions" in self.capabilities:
            await self.call("@harness", "questions", "close_call", {"session": sid, "call": call})

    async def _settle_nested(self, sid, *, only=None, answer=None, cancelled=False):
        entries = self.sessions[sid]["entries"]
        results = {e.get("call") for e in entries if recorded_as(e, "tool_result")}
        starts = {e["call"] for e in entries if e["kind"] == "tool_started"}
        receipts = {e["call"]: e["data"] for e in entries if e["kind"] == "tool_finished"}
        for e in reversed(entries):
            if e["kind"] != "tool_call" or not e["data"].get("parentCallId"):
                continue
            cid = e["call"]
            if cid in results or (only is not None and cid != only):
                continue
            await self._close_nested_questions(sid, cid)
            result = answer or receipts.get(cid)
            if result is None:
                status = (
                    ("cancelled" if cancelled else "outcome_unknown")
                    if cid in starts
                    else "not_started"
                )
                result = {
                    "status": status,
                    "content": content(
                        {
                            "cancelled": "Tool call cancelled",
                            "outcome_unknown": "Tool outcome unknown after interruption",
                            "not_started": "Tool call did not start",
                        }[status]
                    ),
                }
            await self.handle(
                "append",
                {
                    "session": sid,
                    "turn": e.get("turn"),
                    "step": e.get("step"),
                    "actor": e["data"]["actor"],
                    "kind": "tool_result",
                    "call": cid,
                    "content": result["content"],
                    "copies": [e["id"]],
                    "writer": "@harness",
                    "data": {
                        **{k: v for k, v in result.items() if k not in {"call", "content"}},
                        "toolName": e["data"]["name"],
                        "parentCallId": e["data"]["parentCallId"],
                    },
                },
                silent,
            )

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
        charged = self.capacity.stage(session, entries, response=response)
        if "history" in self.capabilities:
            cancellation = await self._commit(sid, session, entries)
        self.capacity.finish(sid, session.get("tenant"), charged, response=response)
        # Calls to an out-of-process store yield. Preserve flags changed by a
        # concurrent cancellation/close while that durable write was in flight.
        current = self.sessions.get(session["id"], {})
        for key in ("busy", "moving", "closing", "suspending", "writer_lost", "interruption"):
            if key in current:
                session[key] = current[key]
        self.sessions[session["id"]] = session
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
                self.call("@harness", "history", "keep", {"session": session, "entries": entries})
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

    def active_plugins(self):
        return [
            {"name": name}
            for name in dict.fromkeys(
                getattr(plugin, "registration", {}).get("name", key)
                for key, plugin in self.plugins.items()
                if not getattr(plugin, "connection_local", False)
            )
        ]

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

    async def _append(self, d):
        # An entry may attribute an effect to a historical actor who has left.
        s = self._session(d, check_actor=False)
        sid = s["id"]
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
                if d["kind"] == "actor_joined" and d.get("data", {}).get("operatorAdmission")
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
        paired = {"turn_start": ("first_input", "input"), "job_end": ("job_report", "input_queued")}
        field, kind = paired.get(e["kind"], (None, None))
        if field in d:
            batch.append(
                {
                    **d[field],
                    "id": identity(),
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
        updated = clone(s)
        updated["entries"].extend(batch)
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
        if e["kind"] == "setting":
            if s.get("busy"):
                raise AgentError("Settings may change only between turns")
            updated["settings"].update(e["data"])
        updated.pop("setup_pending", None)
        await self._keep(updated, batch)
        return batch[len(setup) :]

    def holds_output(self):
        return any(h[1] == "binding.output" for h in self.handlers)

    async def output(self, sid, recipient, events):
        if sid is None:
            return await gate(self, sid, recipient, events)
        try:
            before = await self.erasure_revision(sid)
            result = await gate(self, sid, recipient, events)
            return result if before == await self.erasure_revision(sid) else []
        except AgentError as exc:
            if exc.code == "unavailable":
                return []
            raise

    async def _emit(self, event):
        event = provider_projection(event)
        sid = event.get("session")
        for owner, recipient, handler in list(self.followers):
            try:
                kind = event["kind"]
                events = [{"type": kind, "data": event}]
                if self.holds_output() and kind in {"model_output", "tool_progress"}:
                    key = (owner, recipient, sid, kind, event.get("step"), event.get("call"))
                    if not event.get("final") and sid in self.sessions:
                        buffered = self.output_streams.setdefault(key, [])
                        try:
                            reservation = self.capacity.hold(
                                self.sessions[sid], bufferedBytes=size(events)
                            )
                        except AgentError:
                            continue  # Optional output never spends settlement capacity.
                        buffered.append((reservation, events[0]))
                        continue
                    buffered = self.output_streams.pop(key, [])
                    for reservation, _ in buffered:
                        self.capacity.release(reservation)
                    events = [piece for _, piece in buffered] + events
                revision = await self.erasure_revision(sid) if sid is not None else 0
                for item in await self.output(sid, recipient, events):
                    view = await self.fire(
                        "@harness", "output", {"recipient": recipient, "value": item["data"]}
                    )
                    if view is not None and view.get("value") is not None:
                        value = clone(view["value"])
                        if sid is not None and revision != await self.erasure_revision(sid):
                            break
                        await handler(value)
            except Exception:
                # A failed output gate or recipient can never expose ungated output.
                continue

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
        if operation is None or d.get("draft"):
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
                "settings": {"approval": "off", **settings, **d.get("settings", {})},
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
                    {**d, "actor": d.get("actor", command_session["actor"]), "args": args.strip()},
                    allow_provisional=True,
                )
            finally:
                self.capacity.release(reservation)
        if op == "event":
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
            delivery_sid = d.get("session")
            guarded = delivery_sid in self.sessions and d.get("method") != "_modular-agent/erase"
            revision = await self.erasure_revision(delivery_sid) if guarded else 0
            result = await self.fire(
                "@harness",
                "output",
                {"recipient": d.get("recipient", "user"), "value": provider_projection(d["value"])},
            )
            if guarded and revision != await self.erasure_revision(delivery_sid):
                raise AgentError("Session view changed during delivery", "unavailable")
            if not result or result.get("value") is None or d.get("alreadyGated"):
                return result.get("value") if result else None
            events = await self.output(
                d.get("session"),
                d.get("recipient", "user"),
                [
                    {
                        "type": "history_view"
                        if d.get("type") == "entry"
                        else "entry"
                        if d.get("type") == "projected_entry"
                        else d.get("type", "python.view"),
                        "data": (
                            {"method": d["method"], "result": result["value"]}
                            if "method" in d
                            else {"entry": result["value"]}
                            if d.get("type") in {"entry", "projected_entry"}
                            else result["value"]
                        ),
                    }
                ],
            )
            if not events:
                return None
            value = events[0]["data"]
            return (
                value["result"]
                if "method" in d
                else value["entry"]
                if d.get("type") in {"entry", "projected_entry"}
                else value
            )
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
            return s
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
            result = await self.fire("@harness", "input.arrives", d)
            if result.get("handled") and (command := result.get("command")):
                result["result"] = await self.handle("command", {**d, "text": command}, emit)
            return result
        if op == "prepare":
            return await self.fire("@harness", "turn.prepare", d)
        if op == "invalidate":
            await self.fire("@harness", "session.invalidate", d)
            return {}
        if op == "branch":
            by_id = {e["id"]: e for e in s["entries"]}
            branch, pos = [], s["position"]
            while pos:
                entry = by_id[pos]
                branch.append(entry)
                pos = entry["parent"]
            return branch[::-1]
        if op == "append":
            async with self.append_locks.setdefault(sid, asyncio.Lock()):
                entries = await self._append(d)
            for entry in entries:
                await self._emit({"kind": "history_entry", "session": sid, "entry": entry})
            return entries[0]
        if op == "settings":
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
            self._require_materialized(s)
            if s.get("busy"):
                raise AgentError("Cannot move during a turn", "busy")
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
                raise AgentError("Cannot fork during a turn")
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
                raise AgentError("Cannot fork pending work; finish or cancel it first")
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
            branch = [e for e in branch if e["kind"] != ot.TURN_TRACE]
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
                if "input" in copied.get("data", {}):
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
            if "actor" in d and (s.get("busy") or started - ended):
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
            del self.sessions[sid]
            return {}
        if op == "declaration":
            return self.declarations(s["project"])
        raise AgentError("Unknown session operation: " + op)
