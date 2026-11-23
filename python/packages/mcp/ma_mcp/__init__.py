"""Official MCP client transports adapted to session-scoped agent tool definitions."""

import asyncio
import hashlib
import logging
from pathlib import Path
import re
from contextlib import AsyncExitStack

from ma_core import telemetry as ot
from ma_core import AgentError, Plugin, content


# Names remain valid Claude tool names and stable across reconnection and tool reordering.
def tool_name(server, name):
    digest = hashlib.sha256((server + "\0" + name).encode()).hexdigest()[:12]
    return "mcp_" + re.sub(r"[^a-zA-Z0-9_-]", "_", name)[:30] + "_" + digest


def mapping(value):
    return {v["name"]: v["value"] for v in value} if isinstance(value, list) else value


def validate_servers(servers):
    names = set()
    for spec in servers:
        if not isinstance(spec.get("name"), str) or not spec["name"] or spec["name"] in names:
            raise AgentError("MCP server names must be unique and nonempty")
        names.add(spec["name"])
        transport = spec.get("type", "stdio")
        if transport == "stdio":
            if not isinstance(spec.get("command"), str) or not spec["command"]:
                raise AgentError("An MCP stdio server needs a command")
        elif transport == "http":
            if not isinstance(spec.get("url"), str) or not spec["url"].startswith(
                ("http://", "https://")
            ):
                raise AgentError("An MCP HTTP server needs an http(s) URL")
        else:
            raise AgentError("Unsupported MCP transport: " + transport, "unsupported")


class Connection:
    """One task owns all SDK async scopes, including their teardown."""

    def __init__(self, spec, project=None, http_factory=None):
        self.spec, self.project, self.http_factory = spec, project, http_factory
        self.closed = asyncio.Event()
        self.ready = asyncio.get_running_loop().create_future()
        self.task = asyncio.create_task(self._serve())
        self.session = None
        self.previous = None

    async def _serve(self):
        try:
            from mcp import ClientSession

            # SDK contexts MUST enter and exit in this same task (AnyIO cancel scopes).
            # https://github.com/modelcontextprotocol/python-sdk/blob/v2.3.0/docs/client/transports.md
            async with AsyncExitStack() as stack:
                spec = self.spec
                if spec.get("type", "stdio") == "stdio":
                    from mcp.client.stdio import StdioServerParameters, stdio_client

                    streams = await stack.enter_async_context(
                        stdio_client(
                            StdioServerParameters(
                                command=spec["command"],
                                args=spec.get("args", []),
                                env=mapping(spec.get("env", {})),
                                cwd=self.project,
                            )
                        )
                    )
                else:
                    import httpx2
                    from mcp.client.streamable_http import streamable_http_client

                    client = (self.http_factory or httpx2.AsyncClient)(
                        headers=mapping(spec.get("headers", {}))
                    )
                    await stack.enter_async_context(client)
                    streams = await stack.enter_async_context(
                        streamable_http_client(spec["url"], http_client=client)
                    )
                self.session = await stack.enter_async_context(
                    ClientSession(
                        *streams,
                        read_timeout_seconds=self.spec.get("timeout", 30),
                    )
                )
                await self.session.initialize()
                self.ready.set_result(None)
                await self.closed.wait()
        except BaseException as exc:
            if not self.ready.done():
                self.ready.set_exception(
                    AgentError(
                        "MCP server "
                        + self.spec["name"]
                        + " could not connect ("
                        + type(exc).__name__
                        + ")"
                    )
                )
        finally:
            self.session = None

    async def start(self):
        try:
            async with asyncio.timeout(self.spec.get("timeout", 30)):
                await asyncio.shield(self.ready)
        except BaseException:
            await self.close()
            # Retrieve a possible failed initialization even when the caller timed out.
            if self.ready.done() and not self.ready.cancelled():
                self.ready.exception()
            raise
        return self

    async def close(self):
        self.closed.set()
        if not self.ready.done():
            self.task.cancel()
        await self.task

    def current(self):
        if self.session is None or self.task.done():
            raise AgentError("MCP server " + self.spec["name"] + " disconnected", "unavailable")
        return self.session

    async def tools(self):
        from mcp import types

        tools, cursor, seen = [], None, set()
        while True:
            metadata = ot.inject()
            page = await self.current().list_tools(
                params=types.PaginatedRequestParams(cursor=cursor, _meta=metadata or None)
                if cursor or metadata
                else None
            )
            tools.extend(page.tools)
            cursor = page.next_cursor
            if cursor is None:
                break
            if cursor in seen:
                raise AgentError("MCP pagination repeated a cursor")
            seen.add(cursor)
        if len({t.name for t in tools}) != len(tools):
            raise AgentError("MCP server returned duplicate tool names")
        return tools


class MCP(Plugin):
    name = "mcp"
    role = "tool_source"
    # A private process placement can restore an older serialized instance.
    standard_names = False
    project_servers = None
    prepare_hook = "session.start"
    declarations = {
        "transports": ["stdio", "http"],
        "session_tools": True,
        "annotations_are_hints": True,
        "parallel": False,
        "sampling": False,
        "server_elicitation": False,
        "stdio_crash_cleanup": False,
    }

    def __init__(
        self,
        servers=(),
        http_factory=None,
        standard_names=False,
        project_servers=None,
        prepare_hook="session.start",
    ):
        self.standard_names = standard_names
        self.project_servers = project_servers
        self.prepare_hook = prepare_hook
        self.servers = list(servers)
        validate_servers(self.servers)
        self.http_factory = http_factory
        self.global_connections, self.session_connections = {}, {}
        self.routes = {}

    async def start(self, api):
        await super().start(api)
        api.provide("mcp", self)
        api.on("tools.list", self.definitions)
        api.on(self.prepare_hook, self.attach)
        api.on("session.attach", self.attach)
        api.on("session.end", self.detach, "last")
        api.on("session.suspend", self.detach, "last")
        try:
            for spec in self.servers:
                try:
                    self.global_connections[spec["name"]] = await Connection(
                        spec, spec.get("cwd"), http_factory=self.http_factory
                    ).start()
                except Exception as exc:
                    if not self.standard_names:
                        raise
                    logging.getLogger(__name__).warning("%s: %s", spec["name"], exc)
        except BaseException:
            await self.stop()
            raise

    async def attach(self, d):
        specs = d.get("mcp_servers", [])
        validate_servers(specs)
        if any(s["name"] in self.global_connections for s in specs):
            raise AgentError("Session MCP server shadows a configured server")
        if self.standard_names and any(
            spec.get("type", "stdio") == "stdio" and not Path(spec["command"]).is_absolute()
            for spec in specs
        ):
            raise AgentError("ACP MCP executable paths must be absolute", "invalid_request")
        sid = d["session"]
        project = (await self.api.session("get", session=sid))["project"]
        connections = {}
        try:
            explicit = {spec["name"] for spec in specs}
            if self.project_servers is not None:
                for spec in self.project_servers(Path(project)):
                    if spec["name"] in explicit or spec["name"] in self.global_connections:
                        continue
                    try:
                        validate_servers([spec])
                        connections[spec["name"]] = await Connection(
                            spec, project, self.http_factory
                        ).start()
                    except Exception as exc:
                        logging.getLogger(__name__).warning("%s: %s", spec["name"], exc)
            for spec in specs:
                connections[spec["name"]] = await Connection(
                    spec, project, self.http_factory
                ).start()
        except BaseException:
            for connection in connections.values():
                await connection.close()
            raise
        old = self.session_connections.pop(sid, {})
        self.session_connections[sid] = connections
        for connection in old.values():
            await connection.close()

    async def detach(self, d):
        for connection in self.session_connections.pop(d["session"], {}).values():
            await connection.close()
        self.routes.pop(d["session"], None)

    async def definitions(self, d):
        sid = d.get("session")
        result, routes = [], {}
        for server, connection in {
            **self.global_connections,
            **self.session_connections.get(sid, {}),
        }.items():
            try:
                tools = await connection.tools()
            except Exception as exc:
                await self.api.event(
                    "mcp_unavailable", session=sid, server=server, error=type(exc).__name__
                )
                continue
            if self.standard_names and any(
                not re.fullmatch(r"[A-Za-z0-9_-]+", tool.name)
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", f"mcp_{server}__{tool.name}")
                for tool in tools
            ):
                logging.getLogger(__name__).warning(
                    "MCP server %s has an invalid tool name", server
                )
                continue
            snapshot = [t.model_dump(mode="json", by_alias=True, exclude_none=True) for t in tools]
            if connection.previous != snapshot:
                connection.previous = snapshot
                await self.api.event("tools_changed", session=sid, source="mcp", server=server)
            for tool in tools:
                from mcp import types

                a = tool.annotations or types.ToolAnnotations()
                read_only = a.read_only_hint is True
                name = (
                    f"mcp_{server}__{tool.name}"
                    if self.standard_names
                    else tool_name(server, tool.name)
                )
                if name in routes:
                    raise AgentError("MCP tool name collision")
                routes[name] = (connection, tool.name)
                result.append(
                    {
                        "name": name,
                        "description": tool.description or tool.name,
                        "schema": tool.input_schema,
                        "output_schema": tool.output_schema,
                        "hints": {
                            "read_only": read_only,
                            "destructive": not read_only and a.destructive_hint is not False,
                            "safe_to_repeat": read_only or a.idempotent_hint is True,
                            "external": a.open_world_hint is not False,
                        },
                        "parallel": False,
                        "callers": ["model", "plugin", "interface"],
                        "target": "mcp",
                        "mcp": {
                            "server": server,
                            "tool": tool.model_dump(mode="json", by_alias=True, exclude_none=True),
                        },
                    }
                )
        self.routes[sid] = routes
        return result

    async def run(self, d, emit):
        call = d["call"]
        dispatched = False
        try:
            connection, original = self.routes.get(d["session"], {})[call["name"]]

            async def progress(value, total, message):
                await emit({"text": message or "", "progress": value, "total": total})

            session = connection.current()
            dispatched = True
            result = await session.call_tool(
                original, call["input"], progress_callback=progress, meta=ot.inject() or None
            )
            return {
                "call": call["id"],
                "status": "failed" if result.is_error else "completed",
                "content": [
                    p.model_dump(mode="json", by_alias=True, exclude_none=True)
                    for p in result.content
                ],
                "value": result.structured_content,
                "mcp": result.model_dump(mode="json", by_alias=True, exclude_none=True),
            }
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            return {
                "call": call["id"],
                "status": "unknown" if dispatched else "failed",
                "content": content(
                    (
                        "Call did not finish. Its outcome is unknown. "
                        if dispatched
                        else "MCP call could not start. "
                    )
                    + "Check external state before relying on it ("
                    + type(exc).__name__
                    + ")."
                ),
            }

    async def stop(self):
        for sid in list(self.session_connections):
            await self.detach({"session": sid})
        for connection in self.global_connections.values():
            await connection.close()
        self.global_connections.clear()
