"""Scripted offline Provider. No network, credentials or SDK process."""

import asyncio

from ma_core import AgentError, Plugin, clone, content, identity, silent


def reply(text="", calls=None, **kw):
    return {
        "content": content(text),
        "calls": calls or [],
        "stop": "tools" if calls else "finished",
        "usage": {"input_tokens": 10, "output_tokens": 5},
        **kw,
    }


def call(name, /, **args):
    return {"id": identity(), "name": name, "input": args}


class Fake(Plugin):
    name = "fake"
    role = "provider"
    declarations = {"stateful": False, "runs_tools": False, "live": False}

    def __init__(self, script=(), summary="Summary of earlier work."):
        self.script = list(script)
        self.requests = []
        self.summary = summary
        self.discards = []
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def start(self, api):
        await super().start(api)
        api.provide("fake", self)
        api.define_hook("fake.before", "transform")
        api.define_hook("fake.piece", "observe")
        api.on("session.invalidate", self._invalidated)

    async def catalog(self, d, emit):
        return [
            {
                "id": "fake",
                "context_window": 8192,
                "output_limit": 1024,
                "input_types": ["text"],
                "thinking": ["off", "low", "high"],
                "provider": self.declarations,
            }
        ]

    async def generate(self, d, emit):
        d = await self.api.hook("fake.before", d)
        self.requests.append(clone(d))
        if d.get("purpose") == "summary":
            return reply(self.summary)
        if not self.script:
            raise AgentError("Fake script exhausted")
        item = self.script.pop(0)
        if item.get("wait"):
            self.entered.set()
            await self.release.wait()
        if item.get("error"):
            raise AgentError(item["error"], item.get("code", "failed"))
        for piece in item.get("pieces", []):
            await self.api.hook("fake.piece", {"text": piece})
            await emit({"text": piece})
            await asyncio.sleep(0)
        return {k: v for k, v in item.items() if k not in {"wait", "pieces"}}

    async def discard(self, d, emit):
        self.discards.append(d["session"])
        return {}

    async def _invalidated(self, d):
        await self.discard(d, silent)
        self.requests.clear()  # Do not retain copies after erasure or branch changes.
