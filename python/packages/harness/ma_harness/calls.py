"""Route capability calls through the fences their targets need, and dispatch tool runs."""

import asyncio

from ma_core import AgentError, clone, content, identity, silent
from ma_core import telemetry as ot


class CapabilityCalls:
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
        if target == "tools" and operation == "definitions":
            definitions = await method(data, emit)
            if self.interface_tools:
                names = {t["name"] for t in definitions}
                if names & self.interface_tools.keys():
                    raise AgentError(
                        "A tool conflicts with a registered Interface tool", "conflict"
                    )
                definitions = [*definitions, *self.interface_definitions(sid, data.get("turn"))]
            return clone(definitions)
        if target == "selection" and operation == "access":
            access = await method(data, emit)
            _, provider = self.capabilities[access["target"]]
            # The composition is fixed while a session is open. A private
            # Runtime need not round-trip the request to a nonexistent transform.
            return clone({**access, "_host_prepares": hasattr(type(provider), "prepare_request")})
        if target == "runtime" and operation == "cancel" and self.interface_enabled():
            result = await method(data, emit)
            if sid in self.sessions and await self.interface_ready(sid):
                await self.interface_kick(sid)
            return clone(result)
        if target != "tools" or operation != "run" or "call" not in data:
            if (
                operation == "run"
                and data.get("_checked_definition")
                and (scope := self.tool_dispatches.get(data.get("dispatch")))
                and scope.pop("initial_wait_handoff", False)
                and target == scope["data"]["definition"].get("target")
            ):
                # The router has validated the input synchronously. This call is
                # still inside the guarded first handoff; do not insert another
                # lease RPC between its final deadline check and the executor.
                return clone(await method(data, emit))
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
        if call["name"] in self.interface_tools:
            raise AgentError("Use the Interface handoff boundary", "forbidden")
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
        scope = {
            "data": data,
            "children": set(),
            "closing": False,
            "covering_approval": data.pop("covering_approval", None),
        }
        self.tool_dispatches[token] = scope
        attributes = ot.tool_attrs(
            sid, data.get("turn"), data.get("step"), call, data["definition"]["name"]
        )
        if agent := ot.name(self.agent_name):
            attributes["gen_ai.agent.name"] = agent
        provider_id = ot.name(self.provider_trace_ids.pop((sid, call["id"]), None))
        if provider_id:
            attributes["gen_ai.tool.call.id"] = provider_id
        if self.waiting_request(self.sessions[sid], call["id"]):

            async def handoff():
                status, _ = await self.check_wait_dispatch(
                    sid, data.get("turn"), data.get("step"), call, data["definition"], started=True
                )
                if status:
                    self.tool_dispatches.pop(token, None)
                    result = {"call": call["id"], "status": status, "content": []}
                    ot.tool_disposition(
                        sid, data.get("turn"), data.get("step"), call, data["definition"], result
                    )
                    return result
                scope["initial_wait_handoff"] = True
                return await self._execute_tool(
                    sid,
                    method,
                    {**data, "_checked_definition": True},
                    emit,
                    token,
                    scope,
                    attributes,
                )

            return await self._effect(sid, handoff)
        return await self._effect(
            sid, self._execute_tool, sid, method, data, emit, token, scope, attributes
        )

    async def _execute_tool(self, sid, method, data, emit, token, scope, attributes):
        tool_name = attributes.get("gen_ai.tool.name")
        with ot.span(
            "execute_tool " + tool_name if tool_name else "execute_tool", attributes
        ) as operation:
            try:
                result = clone(await method({**data, "dispatch": token}, emit))
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
