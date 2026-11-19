"""Public plugin stdio framing rules, without a Provider or a network."""

import asyncio
import json
from pathlib import Path


async def test_bad_frames_are_distinct_and_settled_ids_cannot_be_reused():
    root = Path(__file__).resolve().parents[1]
    proc = await asyncio.create_subprocess_exec(
        str(root / ".venv/bin/modular-agent-plugin"),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
    )

    async def send(frame):
        proc.stdin.write(frame + b"\r\n")
        await proc.stdin.drain()
        return await proc.stdout.readline()

    try:
        async with asyncio.timeout(5):
            assert json.loads(await send(b'{"id":1,"id":2}'))["error"]["code"] == -32700
            assert json.loads(await send(b"[]"))["error"]["code"] == -32600
            ping = b'{"jsonrpc":"2.0","id":0,"method":"$/ping","params":{}}'
            assert json.loads(await send(ping))["result"] == {}
            assert await send(ping) == b""
            assert await proc.wait() == 0
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
