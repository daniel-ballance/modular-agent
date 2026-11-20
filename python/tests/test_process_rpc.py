"""Cancellation regressions for the private process transport."""

import asyncio
import json
import struct
from unittest.mock import AsyncMock, Mock

from ma_process.rpc import Peer


async def test_cancel_buffered_with_request_acknowledges_without_dispatching():
    def encode(frame):
        raw = json.dumps(frame).encode()
        return struct.pack("!I", len(raw)) + raw

    incoming = asyncio.StreamReader()
    outgoing = asyncio.StreamReader()
    writer = Mock(drain=AsyncMock(), wait_closed=AsyncMock())
    writer.write.side_effect = outgoing.feed_data
    dispatch = AsyncMock()
    peer = Peer(incoming, writer, dispatch, "test")
    try:
        # Both frames are already buffered when the reader resumes: it can
        # process the cancel before the request task takes its first step.
        incoming.feed_data(
            encode({"kind": "request", "id": "1", "operation": "invoke", "data": {}})
            + encode({"kind": "cancel", "id": "1"})
        )
        async with asyncio.timeout(1):
            (size,) = struct.unpack("!I", await outgoing.readexactly(4))
            answer = json.loads(await outgoing.readexactly(size))
        assert answer["kind"] == "answer" and answer["id"] == "1"
        assert answer["error"]["type"] == "CancelledError"
        dispatch.assert_not_called()
        assert not peer.running
    finally:
        await peer.close()
