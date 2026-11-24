"""Deterministic modular-agent-acp/1 model. No SDK, credentials or network."""

import json

from ma_core import AgentError, Plugin, content, identity, plain


from ma_core.conformance import NEST
from ma_core.wire import messages_out


class Nest(Plugin):
    name = "conformance-nest"
    role = "tool_source"

    async def start(self, api):
        await super().start(api)
        api.provide(self.name, self)
        api.on("tools.list", self.tools)

    async def tools(self, d):
        return [{**NEST, "target": "conformance-nest"}]

    async def run(self, d, emit):
        args = d["call"]["input"]
        try:
            return await self.api.nested_tools(d["dispatch"], args["name"], args["input"])
        except AgentError as exc:
            return {"status": "failed", "content": content(exc.code)}


class Echo(Plugin):
    name = "conformance"
    role = "provider"
    declarations = {"stateful": False, "runs_tools": False, "live": False}

    async def start(self, api):
        await super().start(api)
        api.provide(self.name, self)

    async def catalog(self, d, emit):
        return [
            {
                "id": "conformance/echo",
                "context_window": 1_000_000,
                "output_limit": 4096,
                "input_types": ["text"],
                "thinking": ["off"],
                "provider": self.declarations,
            }
        ]

    async def generate(self, d, emit):
        messages = messages_out(d["messages"])
        last = max((i for i, m in enumerate(messages) if m["role"] == "user"), default=-1)
        text = plain(messages[last]["content"]) if last >= 0 else ""
        results = [m for m in messages[last + 1 :] if m["role"] == "toolResult"]
        calls = []
        if text.startswith("fail:"):
            return {
                "content": [],
                "calls": [],
                "stop": "failed",
                "error": {"kind": "other", "message": text[5:]},
            }
        if text.startswith("tool:"):
            name, _, raw = text[5:].partition(" ")
            try:
                arguments = json.loads(raw)
            except ValueError:
                arguments = None
            if not isinstance(arguments, dict) or name not in {tool["name"] for tool in d["tools"]}:
                return {
                    "content": [],
                    "calls": [],
                    "stop": "failed",
                    "error": {"kind": "other", "message": "Invalid tool directive"},
                }
            if results:
                answer = "done: " + plain(results[0]["content"])[:200]
            else:
                calls = [{"id": identity(), "name": name, "input": arguments}]
                answer = ""
        else:
            answer = "echo: " + text
        if answer:
            await emit({"text": answer})
        return {
            "content": content(answer),
            "calls": calls,
            "stop": "tools" if calls else "finished",
            "usage": {"input_tokens": 0, "output_tokens": 0},
        }

    async def discard(self, d, emit):
        return {}
