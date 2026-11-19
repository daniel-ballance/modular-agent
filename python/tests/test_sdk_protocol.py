import asyncio
import json
import sys


async def test_serve_refuses_flagged_tool():
    code = '''
from modular_agent import Plugin, serve, tool
@tool(in_process_only=True)
async def private() -> str:
    """An in-process-only tool."""
    return "unused"
serve(Plugin("flagged", tools=[private]))
'''
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-c", code, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE
    )
    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "plugin/initialize",
        "params": {
            "binding": "modular-agent-plugin/1",
            "data": "modular-agent-data/1",
            "config": {},
        },
    }
    try:
        async with asyncio.timeout(5):
            proc.stdin.write(json.dumps(request).encode() + b"\n")
            await proc.stdin.drain()
            response = json.loads(await proc.stdout.readline())
            assert response["error"]["data"]["code"] == "not_supported"
            assert "tool:private" in response["error"]["message"]
    finally:
        proc.stdin.close()
        try:
            async with asyncio.timeout(5):
                await proc.wait()
        except TimeoutError:
            proc.kill()
            await proc.wait()
            raise
