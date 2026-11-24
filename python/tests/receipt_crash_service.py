"""Disposable process used to stop either side of the transport marker commit."""

import asyncio
from pathlib import Path
import signal
import sys

from modular_agent import create_agent
from modular_agent._agui_receipts import ReceiptStore
from modular_agent.testing import scripted_provider


async def main(root, boundary):
    original = ReceiptStore.released

    def released(self, source, kind):
        if boundary == "after-marker":
            original(self, source, kind)
        print("released", flush=True)
        signal.pause()

    if boundary != "read":
        ReceiptStore.released = released
    async with create_agent(
        project=root,
        data_dir=root / "store",
        durability="kept",
        providers=[scripted_provider([{"text": "Finished."}])],
    ) as agent:
        listener = await agent.serve_agui(
            listen="127.0.0.1:0",
            actors=[
                {
                    "actor": {"id": "viewer", "kind": "user", "rights": ["input", "watch"]},
                    "client_id": "editor",
                    "token_file": root / "test-token",
                }
            ],
        )
        print(listener.url, flush=True)
        await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1]), sys.argv[2]))
