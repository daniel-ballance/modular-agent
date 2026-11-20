"""Reusable method-table server and its deterministic conformance composition."""

import argparse
import asyncio
import base64
import json
import os
import sys
from pathlib import Path

from .output import redact

from ma_core import AgentError, content, identity, plain
from ma_core.conformance import NEST
from ma_durable import Durable
from ma_runtime import Runtime
from ma_local import Local
from ma_tools import DEFINITIONS

from ma_core.wire import tool_out
from .rpc import MAX_FRAME, Peer, WireError
from .runtime_server import METHODS, RuntimeServer
from .websocket import PLUGIN_PROTOCOL, listen_websocket, wait_for_stop

BINDING = "modular-agent-plugin/1"
DATA = "modular-agent-data/1"


class PluginServer:
    """Serve a registration and async method handlers. No host-language objects on wire."""

    def __init__(self, registration, methods, initialize=None, stop=None):
        self.registration, self.methods = registration, methods
        self.initialize, self.stop = initialize, stop
        self.ready = False
        self.peer = None

    async def dispatch(self, method, params, key):
        if method == "plugin/initialize":
            if self.ready:
                raise WireError("Already initialized", "invalid_request")
            if params.get("binding") != BINDING or params.get("data") != DATA:
                raise WireError("Unsupported binding or data version", "not_supported")
            if self.initialize:
                await self.initialize(params)
            self.ready = True
            return self.registration
        if not self.ready:
            raise WireError("Initialize first", "invalid_request")
        if method == "plugin/shutdown":
            if self.stop:
                await self.stop()
            return {}
        handler = self.methods.get(method)
        if not handler:
            raise WireError("Method not found: " + method, "method_not_found", -32601)
        return await handler(params, key)

    async def serve_frames(self, frames):
        self.peer = Peer(
            None,
            None,
            self.dispatch,
            getattr(self, "notification", None),
            "host",
            frames=frames,
            close_after_shutdown=True,
        )
        try:
            await self.peer.closed.wait()
        finally:
            await self.peer.close()
            if self.stop:
                await self.stop()

    async def serve(self):
        # Official pipe APIs: https://docs.python.org/3.13/library/asyncio-eventloop.html#working-with-pipes
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader(limit=MAX_FRAME + 2)
        await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
        transport, protocol = await loop.connect_write_pipe(
            asyncio.streams.FlowControlMixin, sys.stdout.buffer
        )
        writer = asyncio.StreamWriter(transport, protocol, reader, loop)
        self.peer = Peer(reader, writer, self.dispatch, getattr(self, "notification", None), "host")
        try:
            await self.peer.closed.wait()
        finally:
            await self.peer.close()
            if self.stop:
                await self.stop()


class EnvironmentAPI:
    """Local environment adapter: the wire's cwd is the native operation's project."""

    def provide(self, *args):
        pass

    def on(self, *args):
        pass

    async def session(self, operation, **data):
        return {"id": data["session"]}


class Conformance(PluginServer):
    def __init__(self, parts, *, network=False):
        self.network = network
        self.project = None
        runtime_parts = parts & {"runtime", "durable-runtime"}
        if len(runtime_parts) > 1:
            raise ValueError("Choose only one Runtime")
        unknown = parts - {"provider", "tools", "environment", "hooks", *runtime_parts}
        if unknown:
            raise ValueError("Unknown conformance parts: " + ",".join(sorted(unknown)))
        # The default and provider/hooks are one plugin. Other compositions can
        # be installed beside it and have identities of their own.
        name = "python-conformance"
        if parts not in ({"provider", "tools", "environment", "hooks"}, {"provider", "hooks"}):
            name += "-" + "-".join(sorted(parts))
        registration = {"binding": BINDING, "name": name, "replaces": []}
        methods = {}
        self.local = None
        self.output_handlers = {}
        self.runtime = None
        if runtime_parts:
            self.runtime = RuntimeServer(
                self, Durable() if "durable-runtime" in parts else Runtime()
            )
            registration["runtime"] = self.runtime.registration
            registration["replaces"].append("runtime")
            for method in METHODS:

                async def run(p, key, method=method):
                    return await self.runtime.run(method, p, key)

                methods["runtime/" + method] = run
        if "provider" in parts:
            self.models = [
                {
                    "provider": "conformance",
                    "id": "echo",
                    "contextWindow": 1_000_000,
                    "maxOutput": 4096,
                    "input": ["text"],
                    "reasoning": False,
                    "thinking": ["off"],
                }
            ]
            registration["providers"] = [
                {
                    "id": "conformance",
                    "supports": {"keepsState": False, "runsTools": False},
                    "models": self.models,
                }
            ]
            registration["replaces"].append("provider:conformance")
            methods.update(
                {
                    "provider/models": self.models_request,
                    "provider/available": self.available,
                    "provider/request": self.generate,
                    "provider/discard": self.discard,
                }
            )
        if "tools" in parts:
            self.tools = [
                tool_out(t) for t in [*DEFINITIONS, NEST] if t["name"] in {"bash", "read", "nest"}
            ]
            registration["toolSources"] = [
                {"id": "conformance-tools", "tools": self.tools, "perSession": False}
            ]
            registration["replaces"] += ["tool:bash", "tool:read", "tool:nest"]
            methods.update({"tools/list": self.list_tools, "tools/call": self.call_tool})
        if "environment" in parts:
            registration["workingEnvironment"] = {
                "containment": "strong",
                "platforms": ["linux"],
                "points": True,
            }
            registration["replaces"].append("working-environment")
            methods.update(
                {
                    "env/" + op: self.environment
                    for op in (
                        "read",
                        "write",
                        "exists",
                        "exec",
                        "list",
                        "save",
                        "checkPoint",
                        "restore",
                    )
                }
            )
        if "hooks" in parts:
            registration["hooks"] = [
                {"hook": "tool.before", "handlerId": 1, "order": "normal"},
                {"hook": "turn.before", "handlerId": 2, "order": "normal"},
                {"hook": "output", "handlerId": 3, "order": "normal"},
            ]
            methods["hook/handle"] = self.hook
        super().__init__(registration, methods, self.start, self.close)

    async def start(self, params):
        if self.registration.get("workingEnvironment"):
            if self.network:
                project = Path(params.get("project", ""))
                if not project.is_absolute() or not project.is_dir():
                    raise WireError("Service cannot see the host project path", "not_supported")
                self.project = project.resolve()
            self.local = Local(params["home"])
            await self.local.start(EnvironmentAPI())

    async def close(self):
        if self.local:
            await self.local.stop()

    async def notification(self, method, p):
        if method == "host/env/output" and p.get("parentRequestId") in self.output_handlers:
            await self.peer.notify(
                "tools/progress",
                {
                    "parentRequestId": self.output_handlers[p["parentRequestId"]],
                    "content": content(p["chunk"]),
                },
            )

    async def models_request(self, p, key):
        self.check_provider(p)
        return {"models": self.models}

    def check_provider(self, p):
        if p.get("provider") != "conformance":
            raise WireError("Unknown provider", "invalid_request")

    async def available(self, p, key):
        self.check_provider(p)
        return {"available": True}

    async def discard(self, p, key):
        self.check_provider(p)
        return {}

    async def generate(self, p, key):
        self.check_provider(p)
        payload = {
            "sessionId": p.get("sessionId"),
            "provider": p["provider"],
            "model": p["model"],
            "request": p["request"],
        }
        payload = await self.peer.request(
            "host/hook", {"parentRequestId": key, "hook": "provider.request", "payload": payload}
        )
        messages = payload["request"]["messages"]
        last_user = max((i for i, m in enumerate(messages) if m["role"] == "user"), default=-1)
        text = plain(messages[last_user]["content"]) if last_user >= 0 else ""
        results = [m for m in messages[last_user + 1 :] if m["role"] == "toolResult"]
        error = text[5:] if text.startswith("fail:") else None
        directive = None
        if text.startswith("tool:"):
            name, sep, raw = text[5:].partition(" ")
            try:
                arguments = json.loads(raw)
            except ValueError:
                arguments = None
            if (
                not sep
                or not isinstance(arguments, dict)
                or name not in {t["name"] for t in payload["request"]["tools"]}
            ):
                error = "Invalid tool directive"
            else:
                directive = {
                    "type": "toolCall",
                    "id": identity(),
                    "name": name,
                    "arguments": arguments,
                }
        if error is not None:
            parts, stop = [], "failed"
        elif directive and not results:
            parts, stop = [directive], "toolUse"
        else:
            answer = (
                "done: " + plain(results[0]["content"])[:200]
                if text.startswith("tool:") and results
                else "echo: " + text
            )
            parts, stop = content(answer), "finished"
            await self.peer.notify(
                "provider/event",
                {"parentRequestId": key, "event": {"type": "text", "delta": answer}},
            )
        response = {
            "role": "assistant",
            "content": parts,
            "stop": stop,
            **({"error": {"kind": "other", "message": error}} if stop == "failed" else {}),
            "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0},
        }
        await self.peer.request(
            "host/hook",
            {
                "parentRequestId": key,
                "hook": "provider.response",
                "payload": {
                    **{k: payload[k] for k in ("sessionId", "provider", "model")},
                    "message": response,
                },
            },
        )
        return response

    async def list_tools(self, p, key):
        if p.get("toolSource") != "conformance-tools":
            raise WireError("Unknown tool source", "invalid_request")
        return {"tools": self.tools}

    async def call_tool(self, p, key):
        await self.list_tools(p, key)
        c = p["call"]
        if c["name"] == "nest":
            try:
                result = await self.peer.request(
                    "host/tools/call", {"parentRequestId": key, **c["input"]}
                )
            except WireError as exc:
                return {"status": "failed", "content": content(exc.code)}
            return {k: result[k] for k in ("status", "content")}
        d = {**c["input"], "parentRequestId": key, "cwd": p["project"], "sessionId": p["sessionId"]}
        try:
            if c["name"] == "read":
                response = await self.peer.request("host/env/read", d)
                text = base64.b64decode(response["data"]).decode()
                return {"status": "completed", "content": content(text), "value": text}
            if c["name"] != "bash":
                raise WireError("Unknown tool", "invalid_request")
            callback_id = "env:" + str(key)
            self.output_handlers[callback_id] = key
            if "timeout" in d:
                d["timeoutMs"] = d.pop("timeout") * 1000
            try:
                r = await self.peer.request("host/env/exec", d, key=callback_id)
            finally:
                self.output_handlers.pop(callback_id, None)
            return {
                "status": "completed" if r["exitCode"] == 0 else "failed",
                "content": content(
                    r["output"].rstrip("\n")
                    + "\n"
                    + ("[timed out]" if r.get("timedOut") else f"[exit code {r['exitCode']}]")
                ),
                "value": r,
            }
        except WireError as exc:
            if exc.code in {"lost", "cancelled", "invalid_request"}:
                raise
            return {"status": "failed", "content": content(str(exc))}

    async def environment(self, p, key):
        # The dispatch adapter supplies the method without altering shared parameters.
        raise AssertionError("Bound in dispatch")

    async def dispatch(self, method, p, key):
        if self.ready and method.startswith("env/") and self.local:
            op = method[4:]
            sid = p.get("sessionId")
            if not isinstance(sid, str) or not sid:
                raise WireError("Environment work needs a sessionId", "invalid_request")
            if op == "sessionEnded":
                await self.local._close({"session": sid})
                return {}
            if op not in {
                "read",
                "write",
                "exists",
                "exec",
                "list",
                "save",
                "checkPoint",
                "restore",
            }:
                raise WireError("Unknown environment operation", "not_supported", -32601)
            cwd = str(Path(p["cwd"]).resolve())
            if self.project is not None and not Path(cwd).is_relative_to(self.project):
                raise WireError("Environment cwd is outside this host project", "forbidden")
            if op == "save":
                return await self.local.save({"session": sid, "cwd": cwd}, None)
            if op == "checkPoint":
                return {"exists": self.local.points.exists(sid, cwd, p["point"])}
            if op == "restore":
                return await self.local.restore(
                    {"session": sid, "cwd": cwd, "point": p["point"]}, None
                )
            path = Path(p.get("path", ""))
            path = path if path.is_absolute() else Path(cwd) / path
            if self.project is not None and not path.resolve().is_relative_to(self.project):
                raise WireError("Environment path is outside this host project", "forbidden")
            if op == "list":
                try:
                    return await self.local.list_directory(
                        {"session": sid, "cwd": cwd, "path": str(path)}, None
                    )
                except AgentError as exc:
                    raise WireError(str(exc), exc.code) from exc
            if op == "read":
                return await self.local.read_bytes(
                    {"session": sid, "cwd": cwd, "path": str(path)}, None
                )
            if op == "write":
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(base64.b64decode(p["data"], validate=True))
                return {}
            if op == "exists":
                return {"exists": path.exists()}
            if op == "exec":
                pieces = []

                async def output(piece):
                    pieces.append(piece["text"])
                    await self.peer.notify(
                        "env/output", {"parentRequestId": key, "chunk": piece["text"]}
                    )

                d = {
                    "session": sid,
                    "cwd": cwd,
                    "command": p["command"],
                    "timeout": p.get("timeoutMs", 0) / 1000 or None,
                }
                try:
                    result = await self.local.bash(d, output)
                except TimeoutError:
                    return {"exitCode": None, "output": "".join(pieces), "timedOut": True}
                return {
                    "exitCode": result["exit_code"],
                    "output": result["text"],
                    "timedOut": False,
                }
        return await super().dispatch(method, p, key)

    async def hook(self, p, key):
        if p.get("handlerId") == 1 and p.get("hook") == "tool.before":
            if "conformance-forbidden" in json.dumps(
                p["payload"]["call"]["input"], ensure_ascii=False
            ):
                return {"refuse": "refused by the conformance plugin"}
            return None
        if p.get("handlerId") == 2 and p.get("hook") == "turn.before":
            return {"system": "The conformance plugin is loaded."}
        if p.get("handlerId") == 3 and p.get("hook") == "output":
            return redact(p["payload"]["events"])
        raise WireError("Unknown handler", "unknown_handler")


def main():
    parser = argparse.ArgumentParser(description="Serve the Python conformance plugin")
    parser.add_argument("--listen")
    parser.add_argument("--token-file", type=Path)
    args = parser.parse_args()
    if (args.listen is None) != (args.token_file is None):
        parser.error("--listen and --token-file must be used together")
    parts = {
        part.strip()
        for part in os.environ.get(
            "MODULAR_AGENT_PLUGIN_PARTS", "provider,tools,environment,hooks"
        ).split(",")
        if part.strip()
    }
    if args.listen is None:
        asyncio.run(Conformance(parts).serve())
        return

    async def connected(frames, _):
        await Conformance(parts, network=True).serve_frames(frames)

    async def run():
        server = await listen_websocket(
            args.listen, [(args.token_file, None)], PLUGIN_PROTOCOL, connected, None
        )
        print(server.url, flush=True)
        await wait_for_stop(server)

    Conformance(parts)  # Validate the selected composition before accepting connections.
    asyncio.run(run())
