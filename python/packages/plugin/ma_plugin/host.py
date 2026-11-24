"""Language-neutral registrations hosted through the native Harness API."""

import asyncio
import base64
import json
import os
from functools import partial
from importlib.metadata import version as _package_version
from pathlib import Path

from ma_core import telemetry as ot
from ma_core import AgentError, Plugin, identity, plain, silent

from . import hooks
from ma_core.wire import (
    call_out,
    entry_out,
    model_in,
    model_out,
    model_request_fields,
    provider_projection,
    request_for_provider,
    request_in,
    request_out,
    response_in,
    response_out,
    restore_provider_messages,
    result_in,
    result_out,
    tool_in,
    tool_out,
)
from .rpc import MAX_FRAME, Peer, WireError, rpc_id
from .rpc import trace_offer, work_method
from .runtime_host import HostedRuntime
from .server import BINDING, DATA
from .websocket import connect_plugin


class Provider:
    def __init__(self, plugin, registration):
        self.plugin, self.registration = plugin, registration
        self.id = registration["id"]

    async def catalog(self, d, emit):
        result = await self.plugin.request("provider/models", {"provider": self.id})
        available = await self.plugin.request("provider/available", {"provider": self.id})
        return [self.model(m) for m in result["models"]] if available["available"] else []

    def model(self, wire):
        model = model_in(wire, self.registration.get("supports", {}))
        model["provider"]["wire_provider"] = True
        model["provider"]["requests_safe_to_repeat"] = bool(
            self.registration.get("supports", {}).get("safeToRepeat")
        )
        model["provider"]["explicit_repeat_promise"] = True
        return model

    async def generate(self, d, emit):
        d = {**d}
        if d.get("purpose") == "summary":
            d["session"] = d["session"].removesuffix(":summary")
        model = d["access"]["id"].removeprefix(self.id + "/")
        if d.get("session") and not d.get("attempt_id"):
            d.update(attempt_id=identity(), auxiliary_step=identity())
        r = await ot.inference(self.id, d, lambda: self._request(d, model, emit))
        return r

    async def _request(self, d, model, emit):
        r = await self.plugin.request(
            "provider/request",
            {
                "provider": self.id,
                "model": {"provider": self.id, "id": model},
                "request": request_for_provider(
                    d["_shared_request"] if d.get("exact_replay") else request_out(d), self.id
                ),
                "sessionId": d.get("session"),
            },
            d,
            emit,
        )
        # Preserve an omitted optional model unless replay of opaque data needs
        # trusted provenance. Never use the Provider's claimed identity for it.
        if (
            "model" in r
            or "providerData" in r
            or any(p.get("type") == "reasoning" and "providerData" in p for p in r["content"])
        ):
            r = {**r, "model": {"provider": self.id, "id": model}}
        if d.get("auxiliary_step"):
            await self.plugin.api.session(
                "append",
                session=d["session"],
                kind="response",
                writer="@harness",
                step=d["auxiliary_step"],
                copies=[d["attempt_id"]],
                content=response_in(r)["content"],
                data=response_in(r),
            )
        response = response_in(r)
        for call in response["calls"]:
            self.plugin.h.provider_trace_ids[d["session"], call["id"]] = call["id"]
        return response

    async def discard(self, d, emit):
        return await self.plugin.request(
            "provider/discard",
            {
                "provider": self.id,
                "sessionId": d["session"],
                **({"erase": True, "entryIds": d["entryIds"]} if d.get("erase") else {}),
            },
            d,
        )


class NativeProvider:
    """Expose shared Provider hooks around a local Provider's native operation."""

    def __init__(self, harness, target, service):
        self.h, self.target, self.service = harness, target, service

    def __getattr__(self, name):
        return getattr(self.service, name)

    async def prepare_request(self, d):
        model = {"provider": self.target, "id": d["access"]["id"].removeprefix(self.target + "/")}
        original = d["_shared_request"] if d.get("exact_replay") else request_out(d)
        payload = {
            "sessionId": d["session"],
            "provider": self.target,
            "model": model,
            "request": provider_projection(original),
        }
        if d.get("exact_replay"):
            changed = payload
            request = request_for_provider(original, self.target)
        else:
            changed = await self.h.fire("@harness", "provider.request", payload)
            request = restore_provider_messages(changed["request"], original, self.target)
        offered = {t["name"]: t for t in original["tools"]}
        if any(offered.get(t["name"]) != t for t in request["tools"]):
            raise AgentError("Provider request expanded the tool offer", "invalid_request")
        return {
            **request_in(request, d),
            "_provider_scope": {k: payload[k] for k in ("sessionId", "provider", "model")},
        }

    async def generate(self, d, emit):
        if "_provider_scope" not in d:
            d = await self.prepare_request(d)

        async def piece(event):
            await self.h.fire(
                "@harness",
                "provider.piece",
                {
                    **d["_provider_scope"],
                    **({"stepId": d["step"]} if d.get("step") else {}),
                    "event": provider_projection(
                        event.get("event", {"type": "text", "delta": event.get("text", "")})
                    ),
                },
            )
            await emit(event)

        response = await ot.inference(
            self.target,
            d,
            lambda: self.service.generate(d, piece),
            local=self.target in {"fake", "scripted"},
        )
        for call in response.get("calls", []):
            original = call.pop("_provider_call_id", call["id"])
            self.h.provider_trace_ids[d["session"], call["id"]] = original
        await self.h.fire(
            "@harness",
            "provider.response",
            {
                **d["_provider_scope"],
                "message": provider_projection(response_out(response)),
            },
        )
        return response


class Environment:
    def __init__(self, plugin):
        self.plugin = plugin

    async def invoke(self, op, d, emit=silent):
        s = await self.plugin.api.session("get", session=d["session"], include_entries=False)
        params = {"cwd": d.get("cwd", s["project"]), "sessionId": s["id"]}
        if op in {"read", "exists", "list"}:
            params["path"] = d["path"]
        elif op == "write":
            params.update(
                path=d["path"],
                data=d.get("data") or base64.b64encode(d.get("text", "").encode()).decode(),
            )
        elif op in {"checkPoint", "restore"}:
            params["point"] = d["point"]
        elif op == "exec":
            params["command"] = d["command"]
            if d.get("timeout") is not None:
                params["timeoutMs"] = d["timeout"] * 1000
        return await self.plugin.request("env/" + op, params, d, emit)

    async def save(self, d, emit):
        return await self.invoke("save", d, emit)

    async def check_point(self, d, emit):
        return await self.invoke("checkPoint", d, emit)

    async def restore(self, d, emit):
        return await self.invoke("restore", d, emit)

    async def read_bytes(self, d, emit):
        return await self.invoke("read", d, emit)

    async def write_bytes(self, d, emit):
        return await self.invoke("write", d, emit)

    async def exists(self, d, emit):
        return await self.invoke("exists", d, emit)

    async def list_directory(self, d, emit):
        try:
            return await self.invoke("list", d, emit)
        except WireError as exc:
            if exc.code == "method_not_found":
                raise WireError(str(exc), "not_supported") from exc
            raise

    async def read(self, d, emit):
        return base64.b64decode((await self.invoke("read", d, emit))["data"]).decode()

    async def write(self, d, emit):
        await self.invoke("write", d, emit)
        return {"bytes": len(d["text"].encode())}

    async def edit(self, d, emit):
        text = await self.read(d, emit)
        matches = []
        for e in d["edits"]:
            if not e["old"] or text.count(e["old"]) != 1:
                raise AgentError("Each old text must occur exactly once")
            start = text.index(e["old"])
            matches.append((start, start + len(e["old"]), e["new"]))
        matches.sort()
        if any(a[1] > b[0] for a, b in zip(matches, matches[1:])):
            raise AgentError("Edits overlap")
        for start, end, new in reversed(matches):
            text = text[:start] + new + text[end:]
        await self.write({**d, "text": text}, emit)
        return {"edits": len(matches)}

    async def bash(self, d, emit):
        r = await self.invoke("exec", d, emit)
        return {**r, "text": r["output"], "exit_code": r["exitCode"], "timed_out": r["timedOut"]}


class External(Plugin):
    trace_context = True
    """One process may register several different capability kinds."""

    role = "feature"

    def __init__(self, harness, spec, project, home, index):
        self.h = harness
        self.spec, self.project, self.home = spec, Path(project).resolve(), Path(home).resolve()
        self.name = "external:" + str(index)
        self.process = self.peer = None
        self.registration = {}
        self.runtime = None
        self.active, self.sources = {}, {}
        self.claimed_jobs = set()
        self.stopping = False
        self.shutdown_reason = {"reason": "stop"}
        self.declarations = {}
        self.api = harness.api(self.name)

    ping_interval = 30.0
    control_timeout = 5.0

    async def open_transport(self):
        service = "url" in self.spec
        decision = await self.h.fire(
            "@harness",
            "plugin.load",
            {
                "plugin": self.spec["url"] if service else self.spec["command"][0],
                "origin": "startup-environment",
            },
        )
        if decision.get("refused"):
            raise WireError(decision["reason"], "invalid_request")
        if service:
            frames = await connect_plugin(
                self.spec["url"], self.spec["tokenFile"], timeout=self.control_timeout
            )
            self.peer = self.connection(None, None, frames=frames)
            self.peer.start_liveness(self.ping_interval, self.control_timeout)
            return
        self.process = await asyncio.create_subprocess_exec(
            *self.spec["command"],
            cwd=self.project,
            env={
                **{
                    k: os.environ[k]
                    for k in ("PATH", "LANG", "LC_ALL", "TZ", "TMPDIR")
                    if k in os.environ
                },
                **self.spec.get("env", {}),
            },
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=None,
            limit=MAX_FRAME + 2,
        )
        self.peer = self.connection(self.process.stdout, self.process.stdin)

    def connection(self, reader, writer, *, frames=None):
        return Peer(
            reader,
            writer,
            self.callback,
            label=self.name,
            frames=frames,
            prepare_notification=self.prepare_notification,
        )

    async def connect(self):
        await self.open_transport()
        self.home.mkdir(parents=True, exist_ok=True)
        self.registration = await asyncio.wait_for(
            self.peer.request(
                "plugin/initialize",
                {
                    "binding": BINDING,
                    "data": DATA,
                    "host": {"name": "modular-agent-py", "version": _package_version("ma-plugin")},
                    "project": str(self.project),
                    "home": str(self.home),
                    "config": self.spec.get("config", {}),
                    **({"traceContext": 1} if self.trace_context else {}),
                },
                cancel_on_interrupt=False,
            ),
            timeout=self.control_timeout,
        )
        if self.registration.get("binding") != BINDING or not self.registration.get("name"):
            raise WireError("Invalid registration", "invalid_request")
        self.peer.trace_agreed = self.trace_context and trace_offer(
            self.registration.get("traceContext")
        )
        self.peer.trace_name = self.registration["name"]
        for source in self.registration.get("toolSources", []):
            if source["id"] in self.sources:
                raise WireError("Duplicate tool source", "invalid_request")
            self.sources[source["id"]] = {
                **source,
                "cache": {None: source.get("tools", [])},
                "invalid": {},
                "refresh_locks": {},
            }
        environment = self.registration.get("workingEnvironment")
        if environment:
            self.declarations.update(
                stops_commands_on_crash=environment["containment"] == "strong",
                containment=environment["containment"],
                rewind=bool(environment.get("points")),
                confines_files=bool(environment.get("confinesFiles")),
                platforms=environment.get("platforms", []),
            )
        providers = self.registration.get("providers", [])
        if providers:
            self.declarations.update(
                stateful=any(p.get("supports", {}).get("keepsState") for p in providers),
                runs_tools=any(p.get("supports", {}).get("runsTools") for p in providers),
                live=False,
            )
        if runtime := self.registration.get("runtime"):
            if not isinstance(runtime.get("id"), str) or not runtime["id"]:
                raise WireError("Runtime registration needs an id", "invalid_request")
            self.runtime = HostedRuntime(self, runtime)
            self.role = "runtime"
            self.declarations.update(self.runtime.declarations)

    async def start(self, api):
        await super().start(api)
        job_owner = "job-owner:" + self.registration["name"]
        if job_owner not in self.h.capabilities:
            api.provide(job_owner, self)
        if self.runtime:
            await self.runtime.start(api)
        for p in self.registration.get("providers", []):
            api.provide(p["id"], Provider(self, p))
        if self.registration.get("workingEnvironment"):
            api.provide("environment", Environment(self))
            api.on("session.end", self.session_ended)
            api.on("session.suspend", self.session_ended)
        for source in self.sources:
            api.provide(self.name + ":tools:" + source, ToolSource(self, source))
        if self.sources:
            api.on("tools.list", self.definitions)
        if self.registration.get("providers"):
            api.on("session.invalidate", self.invalidate)
        for handler in self.registration.get("hooks", []):
            if handler["hook"] == "output":
                self.declarations["holds_output"] = True
            hook = handler["hook"]
            native = hooks.NAMES.get(hook, hook)

            async def run(d, hook=hook, handler=handler):
                p = await hooks.payload(self, hook, d)
                a = await self.request(
                    "hook/handle",
                    {"handlerId": handler["handlerId"], "hook": hook, "payload": p},
                    d,
                )
                return hooks.answer(hook, d, a)

            api.on(native, run, handler.get("order", "normal"))
        for command in self.registration.get("commands", []):

            async def run(d, command=command):
                return await self.request(
                    "command/run",
                    {
                        "name": command["name"],
                        "args": d["args"],
                        "sessionId": d["session"],
                        "actorId": d["actor"],
                    },
                    d,
                )

            api.command(command["name"], command.get("description", ""), run)
        self.watcher = asyncio.create_task(self.watch())

    async def watch(self):
        await self.peer.closed.wait()
        if not self.stopping:
            for source in self.sources.values():
                source["cache"].clear()
            await self.api.event(
                "plugin_failed",
                plugin=self.name,
                message="External plugin lost; interrupted calls are not replayed",
            )

    async def session_ended(self, d):
        if not self.peer.closed.is_set():
            await self.request("env/sessionEnded", {"sessionId": d["session"]}, d)

    async def invalidate(self, d):
        if d.get("reason") != "erasure":
            for provider in self.registration.get("providers", []):
                if provider.get("supports", {}).get("keepsState"):
                    await Provider(self, provider).discard(d, silent)

    async def cancel_job(self, d, emit):
        await self.request("jobs/cancel", {"jobId": d["job"]}, d)
        return {}

    async def owned_job(self, job_id):
        for sid, s in self.h.sessions.items():
            if self.name not in s["plugins"]:
                continue
            if any(
                e["kind"] == "job_start"
                and e["writer"] == self.registration["name"]
                and e.get("job") == job_id
                for e in s["entries"]
            ):
                return {"session": sid, "job": job_id}
        raise WireError("Unknown job owned by this plugin", "invalid_request")

    async def erase_provider(self, sid, ids):
        report = {"pending": [], "outOfReach": []}
        for provider in self.registration.get("providers", []):
            if provider.get("supports", {}).get("keepsState"):
                try:
                    result = await Provider(self, provider).discard(
                        {"session": sid, "erase": True, "entryIds": ids}, silent
                    )
                except AgentError:
                    report["pending"].extend(ids)
                else:
                    for key in report:
                        report[key].extend(result.get(key) or [])
        return report

    async def request(
        self,
        method,
        params,
        context=None,
        emit=silent,
        *,
        return_on_cancel=False,
        cancel_on_interrupt=True,
    ):
        key = identity()
        self.active[key] = {
            "method": method,
            "params": params,
            "context": context or {},
            "trace": ot.current(),
            "emit": emit,
            "questions": 0,
            "pending_questions": {},
        }
        try:
            try:
                result = await self.peer.request(
                    method,
                    params,
                    key=key,
                    return_on_cancel=return_on_cancel,
                    cancel_on_interrupt=cancel_on_interrupt,
                )
            finally:
                # Catalog admission is synchronous. Fetch the new view here,
                # not behind notifications that may need this very reply.
                if not self.peer.closed.is_set():
                    for source, sid in self.active[key].get("tool_changes", ()):
                        try:
                            await self.refresh(source, sid)
                        except AgentError:
                            continue  # Preserve the triggering result.
            if method == "provider/request":
                parent = self.active[key]
                if (
                    not parent.get("provider_committed")
                    or parent.get("provider_response") != result
                ):
                    raise WireError("Provider result lacks matching callbacks", "invalid_request")
            if method == "tools/call" and "pending" in result:
                pending = self.active[key]["pending_questions"]
                result = {
                    **result,
                    "requestIds": list(dict.fromkeys(pending[i] for i in sorted(pending))),
                }
            return result
        except WireError as exc:
            if exc.code == "lost":
                raise AgentError(str(exc), "process_lost") from exc
            raise
        finally:
            self.active.pop(key, None)

    async def definitions(self, d):
        if self.peer.closed.is_set():
            return []
        tools = []
        for source_id, source in self.sources.items():
            sid = d.get("session") if source.get("perSession") else None
            if sid not in source["cache"] or sid in source["invalid"]:
                try:
                    await self.refresh(source_id, sid)
                except AgentError:
                    continue  # Last registered list is reserved, but cannot dispatch.
            tools += [
                {**tool_in(t), "target": self.name + ":tools:" + source_id}
                for t in source["cache"][sid]
            ]
        return tools

    async def refresh(self, source_id, sid):
        source = self.sources[source_id]
        try:
            async with asyncio.timeout(self.control_timeout):
                async with source["refresh_locks"].setdefault(sid, asyncio.Lock()):
                    while sid not in source["cache"] or sid in source["invalid"]:
                        version = source["invalid"].get(sid)
                        r = await self.request(
                            "tools/list",
                            {"toolSource": source_id, **({"sessionId": sid} if sid else {})},
                            {"session": sid},
                            cancel_on_interrupt=False,
                        )
                        if source["invalid"].get(sid) is version:
                            self.validate_tools(r["tools"], source_id, sid)
                            source["cache"][sid] = r["tools"]
                            source["invalid"].pop(sid, None)
        except TimeoutError as exc:
            # A late response to a retired request is not safe to accept.
            self.peer.reader_task.cancel()
            raise WireError("Tool catalog refresh timed out", "lost") from exc

    def validate_tools(self, tools, source_id, session=None):
        names = [t["name"] for t in tools]
        if len(set(names)) != len(names):
            raise WireError("Duplicate tool name", "invalid_request")
        names = set(names) | {
            t["name"]
            for sid, cached in self.sources[source_id]["cache"].items()
            if sid != session
            for t in cached
        }
        for name in names:
            owner = self.h.external_tool_names.get(name)
            if owner and owner != (self.name, source_id):
                raise WireError("Duplicate tool: " + name, "invalid_request")
        old = [
            name
            for name, owner in self.h.external_tool_names.items()
            if owner == (self.name, source_id)
        ]
        for name in old:
            self.h.external_tool_names.pop(name)
        self.h.external_tool_names.update({name: (self.name, source_id) for name in names})

    def prepare_notification(self, method, p):
        """Capture parent authority and catalog invalidations at wire receipt."""
        key = p.get("parentRequestId")
        parent = self.live_parent(p)
        if key is not None and parent is None:
            return None
        if method == "tools/changed":
            source_id = p.get("toolSource")
            if not isinstance(source_id, str) or source_id not in self.sources:
                return None
            if parent and parent["method"] == "tools/list":
                return None  # Listing is read-only.
            source = self.sources[source_id]
            if source.get("perSession"):
                context = (parent or {}).get("context", {})
                sid = context.get("session") or context.get("sessionId")
                sessions = [sid] if sid else list(self.h.sessions)
            else:
                sessions = [None]
            for sid in sessions:
                source["invalid"][sid] = object()
            if parent is not None:
                parent.setdefault("tool_changes", set()).update(
                    (source_id, sid) for sid in sessions
                )
                return None
            return partial(self.refresh_changed, source_id, sessions)
        if method == "host/emit" and (
            key in self.peer.cancelled_outbound
            or any(
                request["method"] == "hook/handle"
                and request["params"]["hook"] == "output"
                and rid in self.peer.outgoing_methods
                and rid not in self.peer.answered
                for rid, request in self.active.items()
            )
        ):
            return None
        if method == "provider/event" and (
            not parent or not parent.get("provider_committed") or "provider_response" in parent
        ):
            return None
        if method == "host/runtime/report" and (
            not parent
            or parent["method"]
            not in {
                "runtime/runTurn",
                "runtime/resumeTurn",
                "runtime/continueOpenCalls",
            }
        ):
            return None
        if method not in {
            "provider/event",
            "tools/progress",
            "env/output",
            "host/emit",
            "host/problem",
            "host/runtime/report",
            "host/jobs/progress",
        }:
            return None

        fallback = (
            self.peer.outgoing_traces.get(key, parent["trace"]) if parent is not None else None
        )

        async def deliver():
            if fallback is None:
                return await self.notification(method, p, parent)
            received = (
                ot.extract(p.get("traceContext")) if self.peer.trace_agreed else ot.extract(None)
            )
            with ot.use(received if ot.same_trace(fallback, received) else fallback):
                return await self.notification(method, p, parent)

        return deliver

    async def refresh_changed(self, source, sessions):
        for sid in sessions:
            try:
                await self.refresh(source, sid)
            except AgentError:
                continue

    async def notification(self, method, p, parent):
        if parent:
            if method == "provider/event":
                event = p["event"]
                ctx = parent["context"]
                access = ctx["access"]
                await self.h.fire(
                    "@harness",
                    "provider.piece",
                    {
                        "sessionId": ctx.get("session"),
                        "stepId": ctx.get("step"),
                        "provider": access["target"],
                        "model": model_out(access, access["target"]),
                        "event": provider_projection(event),
                    },
                )
                await parent["emit"](
                    {
                        "text": event.get("delta", "") if event["type"] == "text" else "",
                        "event": event,
                    }
                )
            elif method == "tools/progress":
                await parent["emit"]({"text": plain(p["content"]), "content": p["content"]})
            elif method == "env/output":
                await parent["emit"]({"text": p["chunk"]})
        if method in {"host/emit", "host/problem", "host/runtime/report", "host/jobs/progress"}:
            try:
                await self.callback(method, p, None, notification_parent=parent)
            except WireError:
                return  # Notifications have no error reply.

    def context(self, p, required=True, *, notification_parent=None):
        parent = notification_parent if notification_parent is not None else self.live_parent(p)
        if p.get("parentRequestId") is not None and parent is None:
            raise WireError("Unknown parent request", "invalid_request")
        d = parent["context"] if parent else {}
        parent_session = d.get("session") or d.get("sessionId")
        sid = parent_session or p.get("sessionId")
        if p.get("sessionId") and parent_session and p["sessionId"] != parent_session:
            raise WireError("Session does not match parent", "invalid_request")
        if not sid:
            if required:
                raise WireError("A session is required", "invalid_request")
            return parent, d, None
        if sid not in self.h.sessions:
            raise WireError("Session is not open", "invalid_request")
        s = self.h.sessions[sid]
        if self.name not in s["plugins"]:
            raise WireError("Plugin is not in this session", "invalid_request")
        return parent, d, s

    def live_parent(self, p):
        key = p.get("parentRequestId")
        if rpc_id(key) and key in self.peer.outgoing_methods and key not in self.peer.answered:
            return self.active.get(key)
        return None

    async def callback(self, method, p, key, *, notification_parent=None):
        parent = notification_parent if notification_parent is not None else self.live_parent(p)
        try:
            if parent is None or not work_method(method):
                with ot.use(ot.extract(None)):
                    return await self.host_call(
                        method, p, key, notification_parent=notification_parent
                    )
            d = parent["context"]
            fallback = self.peer.outgoing_traces.get(p["parentRequestId"], parent["trace"])
            received = (
                ot.extract(p.get("traceContext")) if self.peer.trace_agreed else ot.extract(None)
            )
            trace_parent = received if ot.same_trace(fallback, received) else fallback
            attributes = ot.attrs(
                d.get("session") or d.get("sessionId"),
                d.get("turn"),
                d.get("step"),
                **{
                    "modular_agent.plugin.name": self.registration["name"],
                    "modular_agent.plugin.method": method,
                },
            )
            if key is None:
                with ot.use(trace_parent):
                    return await self.host_call(
                        method, p, key, notification_parent=notification_parent
                    )
            with ot.span(
                "modular_agent.plugin.request",
                attributes,
                parent=trace_parent,
                kind=ot.trace.SpanKind.SERVER,
            ):
                return await self.host_call(method, p, key, notification_parent=notification_parent)
        except AgentError as exc:
            if isinstance(exc, WireError):
                raise
            code = {
                "process_lost": "lost",
                "not_found": "not_found",
                "not_supported": "not_supported",
                "internal": "internal",
            }.get(exc.code, "invalid_request")
            raise WireError(str(exc), code) from exc

    async def _job_callback(self, method, p, args):
        if method == "host/jobs/end":
            outcome = p["outcome"]
            if (
                outcome["kind"] not in {"completed", "failed", "cancelled"}
                or type(p["report"]) is not bool
                or (p["report"] and "result" not in p)
            ):
                raise WireError("Invalid job outcome", "invalid_request")
            try:
                await self.api.call(
                    "jobs",
                    "report",
                    {
                        **args,
                        "state": outcome["kind"],
                        "error": outcome.get("error"),
                        "result": p.get("result") or [],
                        "report": p["report"],
                        "usage": p.get("usage", {}),
                        "strict": True,
                    },
                )
            except AgentError as exc:
                if exc.code != "result_too_large":
                    raise
                raise WireError(str(exc), "result_too_large") from exc
        elif method == "host/jobs/progress":
            await self.api.call("jobs", "progress", {**args, "content": p["content"]})
            return None
        else:
            jid = p["jobId"]
            if jid in self.claimed_jobs:
                raise WireError("Job was already taken up on this connection", "invalid_request")
            self.claimed_jobs.add(jid)
            try:
                await self.api.call("jobs", "take_up", args)
            except BaseException:
                self.claimed_jobs.discard(jid)
                raise
        return {}

    async def host_call(self, method, p, key, *, notification_parent=None):
        direct = {
            "host/history",
            "host/session",
            "host/emit",
            "host/declaration",
            "host/jobs/unfinished",
        }
        job_only = {"host/jobs/progress", "host/jobs/end", "host/jobs/resume"}
        unscoped = {"host/credentials/read", "host/problem"}
        parent_only = {
            "host/ask",
            "host/hook",
            "host/jobs/start",
            "host/tools/list",
            "host/tools/call",
            *("host/env/" + op for op in ("read", "write", "exists", "exec", "list")),
        }
        runtime_only = {
            "host/runtime/" + op
            for op in (
                "newId",
                "prepareStep",
                "model",
                "hook",
                "definition",
                "runToolCall",
                "record",
                "takeSteering",
                "hasSteering",
                "report",
            )
        }
        if method not in direct | unscoped | parent_only | runtime_only | job_only:
            raise WireError("Method not found: " + method, "method_not_found", -32601)
        if method in unscoped and (
            p.get("sessionId") is not None or p.get("parentRequestId") is not None
        ):
            raise WireError("This method has no session or parent", "invalid_request")
        if method in parent_only | runtime_only and p.get("parentRequestId") is None:
            raise WireError("This method needs a live parent", "invalid_request")
        if (
            method in {"host/emit", "host/problem", "host/runtime/report", "host/jobs/progress"}
            and key is not None
        ):
            raise WireError("Expected a notification", "invalid_request")
        if p.get("parentRequestId") in self.peer.cancelled_outbound and (
            method
            in {
                "host/ask",
                "host/jobs/start",
                "host/tools/call",
                "host/env/write",
                "host/env/exec",
                "host/runtime/runToolCall",
                "host/runtime/model",
            }
            or (method == "host/hook" and p.get("hook") == "provider.request")
        ):
            self.context(p)
            raise WireError("Parent request was cancelled", "cancelled")
        if method in runtime_only:
            parent, d, _ = self.context(p, notification_parent=notification_parent)
            if not parent or not parent["method"].startswith("runtime/") or "runtime" not in d:
                raise WireError("Runtime callback needs parent turn work", "invalid_request")
            return await d["runtime"].callback(method.removeprefix("host/runtime/"), p, key)
        parent = notification_parent if notification_parent is not None else self.live_parent(p)
        runtime_parent = parent is not None and parent["method"].startswith("runtime/")
        if runtime_parent and method != "host/history":
            raise WireError(
                "A Runtime turn can only call host/runtime/* or host/history", "invalid_request"
            )
        if method in job_only:
            args = await self.owned_job(p["jobId"])
            jobs = self.h.capabilities["jobs"][1]
            trace_context = getattr(type(jobs), "_trace_context", None)
            fallback = (
                trace_context(jobs, args["session"], args["job"])
                if trace_context
                else ot.extract(None)
            )
            received = (
                ot.extract(p.get("traceContext")) if self.peer.trace_agreed else ot.extract(None)
            )
            if parent is None and ot.valid(fallback):
                with ot.use(received if ot.same_trace(fallback, received) else fallback):
                    return await self._job_callback(method, p, args)
            return await self._job_callback(method, p, args)
        if method == "host/credentials/read":
            if p.get("provider") not in {x["id"] for x in self.registration.get("providers", [])}:
                raise WireError("Provider is not owned by this plugin", "invalid_request")
            # The binding names the provider, never an arbitrary credential-store key.
            try:
                result = await self.h.call(self.name, "credentials", "get", {"name": p["provider"]})
            except AgentError as exc:
                if exc.code == "credentials":
                    return {"credential": None}
                raise
            return {
                "credential": result
                if isinstance(result, dict) or result is None
                else {"type": "apiKey", "key": result}
            }
        if method == "host/problem":
            await self.api.event(
                "plugin_problem", plugin=self.name, where=p["where"], message=p["message"]
            )
            return None
        if method == "host/declaration":
            _, _, s = self.context(p, required=False)
            from ma_acp.binding import declaration

            provider = None
            if s:
                access = await self.api.call("selection", "access", {"session": s["id"]})
                provider = access["provider"]
            return declaration(self.h.declarations(), provider)
        parent, d, s = self.context(
            p, required=method != "host/hook", notification_parent=notification_parent
        )
        if (
            method in parent_only
            and p.get("sessionId") is not None
            and not (d.get("session") or d.get("sessionId"))
        ):
            raise WireError("The parent has no session", "invalid_request")
        if method == "host/hook":
            if (
                not parent
                or parent["method"] != "provider/request"
                or p.get("hook") not in {"provider.request", "provider.response"}
            ):
                raise WireError("Plugin does not own this hook", "invalid_request")
            params, payload = parent["params"], p["payload"]
            scope = {k: params.get(k) for k in ("provider", "model", "sessionId")}
            if any(payload.get(k) != v for k, v in scope.items()):
                raise WireError("Hook payload does not match parent", "invalid_request")
            hook = p["hook"]
            if hook == "provider.response":
                if not parent.get("provider_committed") or "provider_response" in parent:
                    raise WireError("Provider response is out of phase", "invalid_request")
                parent["provider_response"] = payload["message"]
                await self.h.fire(
                    "@harness", hook, {**scope, "message": provider_projection(payload["message"])}
                )
                return None
            if parent.get("provider_seen") or payload.get("request") != params["request"]:
                raise WireError("Provider request is out of phase", "invalid_request")
            parent["provider_seen"] = True
            if d.get("exact_replay"):
                final = params["request"]
            else:
                public = {**payload, "request": provider_projection(params["request"])}
                changed = await self.h.fire("@harness", hook, public)
                final = restore_provider_messages(
                    changed["request"], params["request"], scope["provider"]
                )
            offered = {t["name"]: t for t in params["request"]["tools"]}
            if any(offered.get(t["name"]) != t for t in final["tools"]):
                raise WireError("Provider request expanded the tool offer", "invalid_request")
            if s:
                sid = s["id"]
                if await self.api.session("tenant_exhausted", session=sid):
                    raise WireError(
                        "Tenant token budget reached",
                        "turn_limit",
                        details={"limit": "tenantTokens"},
                    )
                repeatable = bool(d["access"]["provider"].get("requests_safe_to_repeat"))
                fields = model_request_fields(
                    scope["model"], final, repeatable, auxiliary=bool(d.get("auxiliary_step"))
                )
                await self.api.session(
                    "append",
                    session=sid,
                    id=d["attempt_id"],
                    actor=d.get("actor", s["actor"]),
                    writer="@harness",
                    kind="model_started",
                    step=d.get("step") or d["auxiliary_step"],
                    **({"turn": d["turn"]} if d.get("turn") else {}),
                    **({"close_attempt": d["close_attempt"]} if d.get("close_attempt") else {}),
                    **fields,
                )
                await self.h._assert_writable(sid)
                if await self.api.session("tenant_exhausted", session=sid):
                    await self.api.session(
                        "append",
                        session=sid,
                        writer="@harness",
                        actor=d.get("actor", s["actor"]),
                        kind="response",
                        step=d.get("step") or d["auxiliary_step"],
                        copies=[d["attempt_id"]],
                        **({"turn": d["turn"]} if d.get("turn") else {}),
                        data={"stop": "aborted", "recovery": True},
                    )
                    raise WireError(
                        "Tenant token budget reached",
                        "turn_limit",
                        details={"limit": "tenantTokens"},
                    )
            parent.update(provider_request=final, provider_committed=True)
            return {**scope, "request": final}
        sid = s["id"]
        turn_inputs = [
            e
            for e in s["entries"]
            if d.get("turn") and e.get("turn") == d["turn"] and e["kind"] == "input"
        ]
        actor = d.get("call", {}).get(
            "actor", d.get("actor", turn_inputs[0]["actor"] if turn_inputs else s["actor"])
        )
        authority = await self.api.session(
            "authority",
            session=sid,
            actor=actor,
            ceiling=d.get("call", {}).get("authority", d.get("authority")),
        )
        for entry in turn_inputs:
            authority = sorted(
                set(authority)
                & self.h.permissions(s, entry["actor"], entry.get("data", {}).get("authority"))
            )
        if method == "host/jobs/unfinished":
            jobs = await self.api.call("jobs", "unfinished", {"session": sid})
            return {
                "jobs": [
                    {
                        "jobId": j["id"],
                        "kind": j["kind"],
                        "detail": j["detail"],
                        "actorId": j["actor"],
                        **({"key": j["key"]} if j.get("key") else {}),
                        **(
                            {"cleanup": "unconfirmed"} if j["state"] == "cleanupUnconfirmed" else {}
                        ),
                    }
                    for j in jobs
                ]
            }
        if method == "host/jobs/start":
            if (
                parent is None
                or not (d.get("session") or d.get("sessionId"))
                or self.h.capabilities["job-owner:" + self.registration["name"]][1] is not self
                or "jobs" not in authority
            ):
                raise WireError("Job needs parent work with jobs authority", "invalid_request")
            if not isinstance(p["kind"], str) or (
                p.get("key") is not None and not isinstance(p["key"], str)
            ):
                raise WireError("Invalid job kind or key", "invalid_request")
            try:
                j = await self.api.call(
                    "jobs",
                    "create",
                    {
                        "session": sid,
                        "actor": actor,
                        "authority": authority,
                        "turn": d.get("turn"),
                        "call": d.get("call", {}).get("id"),
                        "key": p.get("key"),
                        "kind": p["kind"],
                        "detail": p["detail"],
                    },
                )
            except AgentError as exc:
                if exc.code != "busy":
                    raise
                raise WireError(str(exc), "busy") from exc
            return {"jobId": j["id"], "started": j["started"]}
        if method in {"host/tools/list", "host/tools/call"}:
            if not parent or parent["method"] != "tools/call" or not d.get("dispatch"):
                raise WireError("Nested tools need a live dispatched parent", "invalid_request")
            if method == "host/tools/list":
                return {"tools": [tool_out(t) for t in await self.api.nested_tools(d["dispatch"])]}
            if (
                not isinstance(p.get("name"), str)
                or not p["name"]
                or not isinstance(p.get("input"), dict)
            ):
                raise WireError("Nested tools need a name and object input", "invalid_request")
            return result_out(await self.api.nested_tools(d["dispatch"], p["name"], p["input"]))
        if method.startswith("host/env/"):
            required = {"tools/call": "tools", "command/run": "input"}
            if (
                parent is None
                or p.get("sessionId") != sid
                or required.get(parent["method"]) not in authority
            ):
                raise WireError(
                    "No authorized parent work for this environment call", "invalid_request"
                )
            cwd = Path(p["cwd"]).resolve()
            if not cwd.is_relative_to(Path(s["project"]).resolve()):
                raise WireError("cwd is outside the session project", "invalid_request")
            op = method.removeprefix("host/env/")
            operations = {
                "read": "read_bytes",
                "write": "write_bytes",
                "exists": "exists",
                "list": "list_directory",
                "exec": "bash",
            }
            if op not in operations:
                raise WireError("Unknown environment operation", "not_supported", -32601)

            pieces = []

            async def output(piece):
                pieces.append(piece.get("text", ""))
                await self.peer.notify(
                    "host/env/output", {"parentRequestId": key, "chunk": piece.get("text", "")}
                )

            args = {**p, "session": sid, "cwd": str(cwd)}
            if op == "exec":
                args["timeout"] = p.get("timeoutMs", 0) / 1000 or None
            try:
                r = await self.api.call("environment", operations[op], args, output)
            except AgentError as exc:
                if op == "list" and exc.code in {"unavailable", "not_supported"}:
                    raise WireError(str(exc), "not_supported") from exc
                raise
            except TimeoutError:
                if op != "exec":
                    raise
                return {"exitCode": None, "output": "".join(pieces), "timedOut": True}
            if op == "exec":
                return {
                    "exitCode": r["exit_code"],
                    "output": r["text"],
                    "timedOut": r.get("timed_out", False),
                }
            return r
        if method == "host/ask":
            if parent is None:
                raise WireError("Question needs parent work", "invalid_request")
            draft = p["request"]
            provider_names = {
                name
                for name, (_, service) in self.h.capabilities.items()
                if isinstance(service, (Provider, NativeProvider))
            }
            if draft.get("kind") == "secret" and draft.get("credential") in provider_names:
                return {"requestId": identity(), "actorId": actor, "declined": True}
            parent["questions"] += 1
            ask_order = parent["questions"]
            args = {
                **draft,
                "session": sid,
                "actor": actor,
                "authority": authority,
                "call": d.get("call", {}).get("id"),
                "turn": d.get("turn"),
                "step": d.get("step"),
                "key": draft.get("key")
                or ("call:" if d.get("call", {}).get("id") else "wire:")
                + str(d.get("call", {}).get("id", d.get("turn", parent["method"])))
                + ":"
                + str(parent["questions"]),
                "park": draft.get("whenTimeLimit") == "leaveOpen",
                **({"responders": draft["answerers"]} if "answerers" in draft else {}),
            }
            if draft.get("timeLimitMs") is not None:
                args["timeout"] = draft["timeLimitMs"] / 1000
            if draft.get("credential"):
                args["name"] = draft["credential"]
            r = await self.api.call("questions", "ask", args)
            if r.get("open") and draft["kind"] != "approval":
                parent["pending_questions"][ask_order] = r["request"]
            return {
                "requestId": r.get("request", ""),
                "actorId": r.get("actor", actor),
                **(
                    {"pending": True}
                    if r.get("open")
                    else {"declined": True, **({"reason": r["reason"]} if r.get("reason") else {})}
                    if r.get("declined", r.get("value") == "declined")
                    else {"stored": r["value"]["credential"]}
                    if isinstance(r.get("value"), dict) and "credential" in r["value"]
                    else {"value": r.get("value")}
                ),
            }
        if method == "host/history":
            try:
                await self.api._harness.guard_erasure(sid)
            except AgentError as exc:
                raise WireError("History pending state is unavailable", "internal") from exc
            if runtime_parent:
                scope = d["runtime"]
                if scope.ended:
                    raise WireError(
                        "History read does not belong to an active turn", "invalid_request"
                    )
                if "watch" not in authority:
                    raise WireError("History read requires watch authority", "invalid_request")
            entries = (
                s["entries"] if p.get("all") else await self.api.session("branch", session=sid)
            )
            tool_names = {
                e["call"]: e["data"]["name"] for e in s["entries"] if e["kind"] == "tool_call"
            }
            ids = [e["id"] for e in entries]
            if p.get("after") is not None:
                if p["after"] not in ids:
                    raise WireError("Unknown history cursor", "invalid_request")
                entries = entries[ids.index(p["after"]) + 1 :]
            limit = 500 if p.get("limit") is None else p["limit"]
            if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 500:
                raise WireError("Invalid history limit", "invalid_request")
            page, size = [], len(b'{"entries": []}')
            for e in entries[:limit]:
                value = ot.project_entry(entry_out(e))
                if value.get("message", {}).get("role") == "toolResult":
                    value["message"]["toolName"] = tool_names.get(e["call"], "unknown")
                length = len(json.dumps(value, ensure_ascii=False).encode()) + (2 if page else 0)
                cursor_size = (
                    len(b', "next": ') + len(json.dumps(value["id"], ensure_ascii=False).encode())
                    if len(page) + 1 < len(entries)
                    else 0
                )
                cap = 4 * 1024 * 1024
                if size + length + cursor_size > cap:
                    if not page:
                        raise WireError(
                            "History entry and cursor exceed page cap", "result_too_large"
                        )
                    break
                page.append(value)
                size += length
            return {
                "entries": page,
                **({"next": page[-1]["id"]} if page and len(page) < len(entries) else {}),
            }
        if method == "host/session":
            return {
                "id": sid,
                "project": s["project"],
                "settings": s["settings"],
                "busy": bool(s.get("busy")),
                "actors": [
                    {"id": aid, "kind": a["kind"], "rights": a["authority"]}
                    for aid, a in s["actors"].items()
                ],
            }
        if method == "host/emit":
            await self.api.event(p["type"], session=sid, data=p["data"], plugin=self.name)
            return None
        raise WireError("Method not found: " + method, "not_supported", -32601)

    async def stop(self):
        self.stopping = True
        if self.runtime and hasattr(self.runtime, "api"):
            await self.runtime.stop()
        if not self.peer:
            return
        try:
            if self.peer and not self.peer.closed.is_set() and self.registration:
                task = asyncio.create_task(
                    self.peer.request("plugin/shutdown", self.shutdown_reason)
                )
                done, _ = await asyncio.wait({task}, timeout=self.control_timeout)
                if not done:
                    # Bound shutdown without interrupting request cancellation cleanup.
                    await self.peer.close()
                await asyncio.gather(task, return_exceptions=True)
        except (Exception, asyncio.CancelledError):
            pass
        finally:
            if self.peer:
                await self.peer.close()
            if self.process:
                if self.process.stdin:
                    self.process.stdin.close()
                try:
                    async with asyncio.timeout(5):
                        await self.process.wait()
                except TimeoutError:
                    self.process.kill()
                    await self.process.wait()
            if hasattr(self, "watcher"):
                await self.watcher


class ToolSource:
    def __init__(self, plugin, source):
        self.plugin, self.source = plugin, source

    async def run(self, d, emit):
        s = await self.plugin.api.session("get", session=d["session"], include_entries=False)
        result = await self.plugin.request(
            "tools/call",
            {
                "toolSource": self.source,
                "sessionId": s["id"],
                "project": s["project"],
                "call": call_out(d["call"]),
            },
            d,
            emit,
        )
        return result_in(result, d["call"]["id"])


def configure_binding_hooks(harness):
    if "binding.turn.result" in harness.hooks:
        return
    for hook, rule in (("provider.request", "transform"), ("provider.response", "observe")):
        if hook not in harness.hooks:
            harness.define_hook("@harness", hook, rule)
    harness.define_hook("@harness", "binding.turn.result", "gate")

    async def result_gate(d):
        decision = await harness.fire("@harness", "binding.turn.result", d)
        if decision.get("refused"):
            return {"retry": True, "reason": decision["reason"]}
        if decision["result"] != d["result"]:
            return {"result": decision["result"]}
        return None

    harness.on("@harness", "result.ready", result_gate, "normal")


def wrap_native_providers(harness):
    for target, (owner, service) in list(harness.capabilities.items()):
        if harness.plugins[owner].role == "provider" and not isinstance(service, NativeProvider):
            harness.capabilities[target] = (owner, NativeProvider(harness, target, service))


async def load_plugins(harness, specs, project, home, *, external_factory=External):
    """Initialize in order, preflight collisions, then retract local registrations."""
    configure_binding_hooks(harness)
    harness.external_tool_names = {
        t["name"]: ("local", t.get("target", "files"))
        for t in await harness.api().call("tools", "definitions")
    }
    wrap_native_providers(harness)
    for spec in specs:
        if not isinstance(spec, dict) or not isinstance(spec.get("config", {}), dict):
            raise WireError("Plugin entry and its config must be objects", "invalid_request")
        if "url" in spec:
            if (
                "command" in spec
                or "env" in spec
                or not isinstance(spec["url"], str)
                or not isinstance(spec.get("tokenFile"), str)
                or not Path(spec["tokenFile"]).is_absolute()
            ):
                raise WireError(
                    "Plugin service needs a URL and absolute tokenFile", "invalid_request"
                )
        elif (
            not isinstance(spec.get("command"), list)
            or not spec["command"]
            or not all(isinstance(s, str) for s in spec["command"])
        ):
            raise WireError("Plugin command must be a nonempty string array", "invalid_request")
        env = spec.get("env", {})
        if not isinstance(env, dict) or any(
            not isinstance(k, str) or not isinstance(v, str) for k, v in env.items()
        ):
            raise WireError("Plugin env must map strings to strings", "invalid_request")
    offset = sum(isinstance(plugin, External) for plugin in harness.plugins.values())
    for index, spec in enumerate(specs, offset):
        plugin = external_factory(
            harness, spec, project, Path(home) / "external" / str(index), index
        )
        snapshot = {
            key: getattr(harness, key).copy()
            for key in ("capabilities", "hooks", "handlers", "commands", "external_tool_names")
        }
        omitted = []
        try:
            await plugin.connect()
            if plugin.registration["name"] in {p["name"] for p in harness.active_plugins()}:
                raise WireError(
                    "Duplicate plugin name: " + plugin.registration["name"], "invalid_request"
                )
            omitted = stage_registration(harness, plugin)
            plugin.shutdown_reason = {"reason": "refused", "detail": "Cannot install registration"}
            await harness.load(plugin, process=False)
            plugin.shutdown_reason = {"reason": "stop"}
        except Exception as exc:
            for key, value in snapshot.items():
                setattr(harness, key, value)
            plugin.shutdown_reason = {"reason": "refused", "detail": str(exc)}
            await plugin.stop()
            raise WireError(f"External plugin {index} refused: {exc}", "invalid_request") from exc
        except BaseException:
            await plugin.stop()
            raise
        # Retire a now-empty built-in Runtime or environment, preserving native
        # plugins that still contribute another registered item.
        for target in snapshot["capabilities"]:
            if target not in snapshot["capabilities"] or target not in harness.capabilities:
                continue
            old_owner = snapshot["capabilities"][target][0]
            if (
                old_owner != harness.capabilities[target][0]
                and harness.plugins[old_owner].role in {"runtime", "environment", "provider"}
                and not any(v[0] == old_owner for v in harness.capabilities.values())
                and not any(v[0] == old_owner for v in harness.commands.values())
                and not any(v[0] == old_owner for v in harness.hooks.values())
                and not any(
                    h[0] == old_owner and h[1] not in {"session.end", "session.suspend"}
                    for h in harness.handlers
                )
            ):
                await harness.unload(old_owner)
        if omitted:
            await harness.api().call("tools", "omit", {"names": omitted})
        for provider in plugin.registration.get("providers", []):
            await harness.api().call("selection", "add_provider", {"provider": provider["id"]})


def stage_registration(harness, plugin):
    reg = plugin.registration
    replacements = reg.get("replaces") or []
    replacing = set(replacements)
    if len(replacing) != len(replacements):
        raise WireError("Duplicate replacement name", "invalid_request")
    items = [("provider", p["id"]) for p in reg.get("providers") or []]
    items += [("tool", t["name"]) for s in reg.get("toolSources") or [] for t in s.get("tools", [])]
    items += [("command", c["name"]) for c in reg.get("commands") or []]
    if reg.get("workingEnvironment"):
        items.append(("working-environment", None))
    if plugin.runtime:
        items.append(("runtime", None))
        replacing.add("runtime")

    def label(item):
        kind, name = item
        return kind if name is None else f"{kind}:{name}"

    if len(set(items)) != len(items):
        raise WireError("Duplicate registration name", "invalid_request")
    if replacing - {label(item) for item in items}:
        raise WireError("Replacement not provided by registration", "invalid_request")
    for handler in reg.get("hooks") or []:
        hook = handler["hook"]
        if hook not in hooks.STANDARD or hooks.NAMES.get(hook, hook) not in harness.hooks:
            raise WireError("Unsupported hook: " + hook, "not_supported")
        if handler.get("order", "normal") not in {"first", "normal", "last"}:
            raise WireError("Invalid handler order", "invalid_request")

    omitted = []
    for kind, name in items:
        item = label((kind, name))
        target = "environment" if kind == "working-environment" else name or kind
        index = (
            harness.external_tool_names
            if kind == "tool"
            else harness.commands
            if kind == "command"
            else harness.capabilities
        )
        if target not in index:
            continue
        owner = index[target][0]
        if owner.startswith("external:") or item not in replacing:
            raise WireError("Name is already registered: " + item, "invalid_request")
        if kind == "provider" and harness.plugins[owner].role != "provider":
            raise WireError("Name is not a Provider: " + name, "invalid_request")
        previous = index.pop(target)
        if kind == "tool":
            source = previous[1]
            if source == "files":
                omitted.append(name)
            else:
                source_owner = harness.capabilities.get(source, (source,))[0]

                def filtered(handler, name):
                    async def run(d):
                        return [t for t in await handler(d) if t["name"] != name]

                    return run

                harness.handlers = [
                    (
                        o,
                        point,
                        filtered(h, name) if o == source_owner and point == "tools.list" else h,
                        order,
                    )
                    for o, point, h, order in harness.handlers
                ]
        elif kind == "runtime":
            # These points and lifecycle handlers belong to the single active Runtime.
            points = {*hooks.STANDARD, "result.ready"}
            harness.hooks = {
                k: v for k, v in harness.hooks.items() if v[0] != owner or k not in points
            }
            lifecycle = {
                "session.start",
                "session.end",
                "session.suspend",
                "session.moving",
                "session.invalidate",
            }
            harness.handlers = [
                row for row in harness.handlers if row[0] != owner or row[1] not in lifecycle
            ]
    for source in reg.get("toolSources") or []:
        plugin.validate_tools(source.get("tools", []), source["id"])
    return omitted
