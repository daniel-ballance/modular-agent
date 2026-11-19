"""A real official-SDK MCP server for offline transport tests."""

import asyncio
import os
from pathlib import Path

from pydantic import BaseModel
from mcp import types
from mcp.server.mcpserver import MCPServer


class Echo(BaseModel):
    echo: str
    cwd: str
    pid: int


def server():
    mcp = MCPServer("offline-proof", log_level="ERROR")

    @mcp.tool(
        structured_output=True,
        annotations=types.ToolAnnotations(read_only_hint=True, open_world_hint=False),
    )
    def echo(text: str) -> Echo:
        return Echo(echo=text, cwd=str(Path.cwd()), pid=os.getpid())

    @mcp.tool()
    def add_tool() -> str:
        @mcp.tool()
        def appeared() -> str:
            return "new"

        return "added"

    @mcp.tool()
    def fail() -> str:
        raise ValueError("deliberate tool error")

    @mcp.tool()
    async def wait(marker: str) -> str:
        Path(marker).write_text("started")
        try:
            await asyncio.Event().wait()
        finally:
            Path(marker).write_text("cancelled")
        return "unreachable"

    return mcp


class OfflineHTTP(__import__("httpx2").AsyncClient):
    """Own the official server lifespan in the same process/task as its client."""

    def __init__(self, *, json_response, log, **kwargs):
        import httpx2
        import json

        self.app = server().streamable_http_app(stateless_http=True, json_response=json_response)
        self.lifespan = self.app.router.lifespan_context(self.app)

        async def inspect_request(request):
            with Path(log).open("a") as file:
                file.write(
                    json.dumps({"method": request.method, "headers": dict(request.headers)}) + "\n"
                )

        super().__init__(
            transport=httpx2.ASGITransport(app=self.app),
            event_hooks={"request": [inspect_request]},
            **kwargs,
        )

    async def __aenter__(self):
        await self.lifespan.__aenter__()
        return await super().__aenter__()

    async def __aexit__(self, *args):
        try:
            return await super().__aexit__(*args)
        finally:
            await self.lifespan.__aexit__(*args)


if __name__ == "__main__":
    server().run()
