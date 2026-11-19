"""Durable Runtime. Replaces transient without changing any other plugin."""

import asyncio

from ma_core.wire import recorded_as
from ma_runtime import Runtime


class Durable(Runtime):
    name = "durable"
    declarations = {**Runtime.declarations, "durable": True}

    async def recover(self, d, emit):
        sid = d["session"]
        if sid in self.tasks and not self.tasks[sid].done():
            return {"already_running": True}
        await self._settle(sid, None)
        entries = await self.api.session("branch", session=sid)
        ended = {e.get("turn") for e in entries if recorded_as(e, "turn_end")}
        turns = [e["turn"] for e in entries if e["kind"] == "turn_start" and e["turn"] not in ended]
        if not turns:
            await self.wake(d, emit)
            if sid in self.tasks and not self.tasks[sid].done():
                return {"resuming_questions": True}

        async def resume():
            results = []
            try:
                for turn in turns:
                    results.append(await self._turn(sid, turn=turn))
                if sid not in self.cancelled:
                    results.extend(await self._drain(sid))
            finally:
                await self.api.session("busy", session=sid, value=False)
            return results

        # A resumed job can admit a report while open is still reconciling.
        # Reserve the same scheduler slot used by an ordinary admission.
        async with self.scheduling.setdefault(sid, asyncio.Lock()):
            if sid in self.tasks and not self.tasks[sid].done():
                return {"already_running": True}
            if not turns and not await self._pending(sid):
                return {}
            self.cancelled.discard(sid)
            await self.api.session("invalidate", session=sid, reason="recovery")
            await self.api.session("busy", session=sid, value=True)
            self.tasks[sid] = asyncio.create_task(resume(), name="recover:" + sid)
            return {"resuming": turns}
