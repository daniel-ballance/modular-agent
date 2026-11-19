"""Process placement for unchanged plugins using the version 1 API.

Only trusted startup construction uses cloudpickle, over an inherited anonymous
file, between identical Python environments. All live calls use JSON frames.
https://github.com/cloudpipe/cloudpickle#cloudpickle
https://docs.python.org/3.13/library/subprocess.html#subprocess.Popen
"""

import asyncio
import inspect
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

import cloudpickle

from ma_core import API, AgentError, Plugin, clone, silent

from .rpc import Peer


class RemoteService:
    def __init__(self, plugin, key, own=False):
        self.plugin, self.key, self.own = plugin, key, own

    def __getattr__(self, operation):
        if operation.startswith("_"):
            raise AttributeError(operation)

        async def call(data, emit):
            # Explicit embedding test doubles can wrap an operation. The original
            # method they save is still the remote method, not a second local plugin.
            override = self.plugin.__dict__.get(operation) if self.own else None
            if override is not None:
                return await override(data, emit)
            return await self.plugin.invoke(self.key, operation, [data], emit)

        return call


class ChildAPI(API):
    def __init__(self, peer, owner, role):
        self.peer, self.owner, self.role = peer, owner, role
        self.objects, self.registrations = {}, []
        self.sequence = 0
        self.flushing = asyncio.Lock()

    def remember(self, value):
        self.sequence += 1
        key = str(self.sequence)
        self.objects[key] = value
        return key

    def provide(self, name, service):
        self.registrations.append(
            {
                "kind": "provide",
                "name": name,
                "key": self.remember(service),
                "own": service is self.objects.get("plugin"),
            }
        )

    def define_hook(self, name, rule):
        self.registrations.append({"kind": "define_hook", "name": name, "rule": rule})

    def on(self, name, handler, order="normal"):
        self.registrations.append(
            {"kind": "on", "name": name, "key": self.remember(handler), "order": order}
        )

    def command(self, name, description, handler):
        self.registrations.append(
            {
                "kind": "command",
                "name": name,
                "description": description,
                "key": self.remember(handler),
            }
        )

    def follow(self, recipient, handler):
        self.registrations.append(
            {"kind": "follow", "recipient": recipient, "key": self.remember(handler)}
        )

    async def flush(self):
        async with self.flushing:
            while self.registrations:
                registration = self.registrations.pop(0)
                await self.peer.request("register", registration)

    async def call(self, target, operation, data=None, emit=None):
        await self.flush()
        key = self.remember(emit or silent)
        try:
            return await self.peer.request(
                "call", {"target": target, "operation": operation, "data": data or {}, "emit": key}
            )
        finally:
            self.objects.pop(key, None)

    async def nested_tools(self, dispatch, name=None, arguments=None):
        return await self.peer.request(
            "nested_tools", {"dispatch": dispatch, "name": name, "arguments": arguments}
        )

    async def hook(self, name, data):
        await self.flush()
        return await self.peer.request("hook", {"name": name, "data": data})


async def child_main(plugin, sock):
    reader, writer = await asyncio.open_connection(sock=sock)
    stopping = asyncio.Event()
    stopped = False
    api = None

    async def dispatch(operation, d):
        nonlocal stopped, api
        if operation == "start":
            if d != {"api_version": 1, "binding_version": 1}:
                raise AgentError("Incompatible plugin binding version", "protocol_error")
            api = ChildAPI(peer, plugin.name, plugin.role)
            api.objects["plugin"] = plugin
            await plugin.start(api)
            await api.flush()
            return {"declarations": plugin.declarations}
        if operation == "stop":
            stopped = True
            await plugin.stop()
            stopping.set()
            return {}
        if operation == "inspect":
            # Trusted embedding diagnostics, metadata only. Never exported to Interfaces.
            value = getattr(plugin, d["attribute"])
            return list(value) if isinstance(value, (dict, set)) else clone(value)
        if operation == "invoke":
            value = api.objects[d["key"]]
            if d.get("method"):
                if d["method"].startswith("_"):
                    raise AgentError("Private plugin operation", "forbidden")
                value = getattr(value, d["method"])
            args = d["args"]
            if d.get("emit"):

                async def emit(piece):
                    await peer.request("emit", {"key": d["emit"], "piece": piece})

                args = [*args, emit]
            result = await value(*args)
            await api.flush()
            return result
        raise AgentError("Unknown binding operation")

    peer = Peer(reader, writer, dispatch, "Harness")
    gone = asyncio.create_task(peer.closed.wait())
    stop = asyncio.create_task(stopping.wait())
    try:
        await asyncio.wait({gone, stop}, return_when=asyncio.FIRST_COMPLETED)
        if gone.done():
            await asyncio.gather(*list(peer.running.values()), return_exceptions=True)
        if not stopped:
            await plugin.stop()
        # The stop answer must leave before the channel closes.
        await asyncio.gather(*list(peer.running.values()), return_exceptions=True)
    finally:
        gone.cancel()
        stop.cancel()
        await asyncio.gather(gone, stop, return_exceptions=True)
        await peer.close()


class ProcessPlugin(Plugin):
    stop_timeout = 10

    def __init__(self, plugin):
        self.original = plugin
        self.name, self.role = plugin.name, plugin.role
        self.declarations = clone(plugin.declarations)
        self.peer = None
        self.pid = None
        self.emitters = {}
        self.sequence = 0
        self.expected_stop = False

    def __getattr__(self, attribute):
        original = getattr(self.original, attribute)
        if inspect.iscoroutinefunction(original):

            async def method(*args):
                emit = args[-1] if args and callable(args[-1]) else None
                return await self.invoke(
                    "plugin", attribute, list(args[:-1] if emit else args), emit
                )

            return method
        if isinstance(original, (str, int, float, bool, Path, type(None))):
            return original
        raise AttributeError("Remote state requires await plugin.inspect(attribute): " + attribute)

    async def inspect(self, attribute):
        return await self.peer.request("inspect", {"attribute": attribute})

    async def start(self, api):
        await super().start(api)
        parent, child = socket.socketpair()
        try:
            with tempfile.TemporaryFile() as bootstrap:
                cloudpickle.dump(sys.path, bootstrap)
                cloudpickle.dump(self.original, bootstrap)
                bootstrap.seek(0)
                self.process = subprocess.Popen(
                    [
                        sys.executable,
                        "-m",
                        "ma_process.worker",
                        str(child.fileno()),
                        str(bootstrap.fileno()),
                    ],
                    pass_fds=(child.fileno(), bootstrap.fileno()),
                    close_fds=True,
                )
                self.pid = self.process.pid
        except BaseException:
            parent.close()
            raise
        finally:
            child.close()
        parent.setblocking(False)
        try:
            reader, writer = await asyncio.open_connection(sock=parent)
        except BaseException:
            parent.close()
            raise
        self.peer = Peer(reader, writer, self.dispatch, "Plugin " + self.name)
        self.monitor = asyncio.create_task(self.watch())
        result = await self.peer.request("start", {"api_version": 1, "binding_version": 1})
        self.declarations = result["declarations"]

    async def invoke(self, key, method, args, emit=None):
        self.sequence += 1
        emitter = str(self.sequence) if emit else None
        if emit:
            self.emitters[emitter] = emit
        try:
            return await self.peer.request(
                "invoke", {"key": key, "method": method, "args": args, "emit": emitter}
            )
        finally:
            self.emitters.pop(emitter, None)

    def callback(self, key):
        async def run(data):
            return await self.invoke(key, None, [data])

        return run

    async def dispatch(self, operation, d):
        if operation == "register":
            kind = d["kind"]
            if kind == "provide":
                # Most capabilities use the plugin itself; independent service
                # objects are addressed identically without requiring inheritance.
                self.api.provide(d["name"], RemoteService(self, d["key"], own=d["own"]))
            elif kind == "define_hook":
                self.api.define_hook(d["name"], d["rule"])
            elif kind == "on":
                self.api.on(d["name"], self.callback(d["key"]), d["order"])
            elif kind == "command":
                self.api.command(d["name"], d["description"], self.callback(d["key"]))
            elif kind == "follow":
                self.api.follow(d["recipient"], self.callback(d["key"]))
            else:
                raise AgentError("Invalid plugin registration")
            return {}
        if operation == "call":

            async def emit(piece):
                await self.invoke(d["emit"], None, [piece])

            return await self.api.call(d["target"], d["operation"], d["data"], emit)
        if operation == "nested_tools":
            return await self.api.nested_tools(d["dispatch"], d["name"], d["arguments"])
        if operation == "hook":
            return await self.api.hook(d["name"], d["data"])
        if operation == "emit":
            await self.emitters[d["key"]](d["piece"])
            return None
        raise AgentError("Unknown binding operation")

    async def watch(self):
        await self.peer.closed.wait()
        while self.process.poll() is None:
            await asyncio.sleep(0.01)
        self.exit_status = self.process.returncode
        if not self.expected_stop:
            self.declarations = {**self.declarations, "available": False}
            await self.api.event(
                "plugin_failed",
                plugin=self.name,
                pid=self.pid,
                exit_code=self.exit_status,
                error="Plugin process disconnected",
            )

    async def stop(self):
        self.expected_stop = True
        if self.peer is None:
            process = self.__dict__.get("process")
            if process is not None:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=5)
            return
        stopping = None
        try:
            if not self.peer.closed.is_set():
                stopping = asyncio.create_task(self.peer.request("stop", {}))
                done, _ = await asyncio.wait({stopping}, timeout=self.stop_timeout)
                if not done:
                    self.process.kill()
        finally:
            await self.peer.close()
            if stopping is not None:
                await asyncio.gather(stopping, return_exceptions=True)
            try:
                async with asyncio.timeout(10):
                    await asyncio.shield(self.monitor)
            except TimeoutError:
                self.process.kill()  # Popen checks cached exit status before signalling.
                await self.monitor
