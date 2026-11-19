"""File and shell tool definitions and validation. Effects use the working environment."""

import asyncio

from jsonschema import Draft202012Validator
from ma_core import AgentError, Plugin, content


def definition(name, description, properties, required, **hints):
    return {
        "name": name,
        "description": description,
        "schema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": False,
        },
        "hints": hints,
        "parallel": name == "read",
        "callers": ["model", "plugin", "interface"],
    }


STRING = {"type": "string"}
DEFINITIONS = [
    definition(
        "read",
        "Read a UTF-8 text file in the session project.",
        {"path": STRING},
        ["path"],
        read_only=True,
        safe_to_repeat=True,
    ),
    definition(
        "write",
        "Write a UTF-8 text file.",
        {"path": STRING, "text": STRING},
        ["path", "text"],
        destructive=True,
    ),
    definition(
        "edit",
        "Apply unique, non-overlapping exact text replacements to a file.",
        {
            "path": STRING,
            "edits": {
                "type": "array",
                "minItems": 1,
                "items": {
                    "type": "object",
                    "properties": {"old": STRING, "new": STRING},
                    "required": ["old", "new"],
                    "additionalProperties": False,
                },
            },
        },
        ["path", "edits"],
        destructive=True,
    ),
    definition(
        "bash",
        "Run bash in the session project. Output streams live. Background children may remain until session close.",
        {"command": STRING, "timeout": {"type": "number", "exclusiveMinimum": 0}},
        ["command"],
        external=True,
        safe_to_repeat=False,
    ),
]


class Tools(Plugin):
    name = "files"
    role = "tool_source"

    def __init__(self):
        self.omissions = set()

    async def omit(self, d, emit):
        self.omissions.update(d["names"])
        return sorted(self.omissions)

    async def omitted(self, d, emit):
        return sorted(self.omissions)

    async def start(self, api):
        await super().start(api)
        api.provide("tools", self)
        api.define_hook("tools.list", "collect")

    async def definitions(self, d, emit):
        extra = await self.api.hook("tools.list", d)
        tools = [
            *[t for t in DEFINITIONS if t["name"] not in self.omissions],
            *[t for group in extra for t in group],
        ]
        if len({t["name"] for t in tools}) != len(tools):
            raise AgentError("Duplicate tool name")
        return tools

    async def run(self, d, emit):
        call = d["call"]
        try:
            tool = next(
                (t for t in await self.definitions(d, emit) if t["name"] == call["name"]), None
            )
            if not tool:
                raise AgentError("Unknown tool")
            Draft202012Validator(tool["schema"]).validate(call["input"])
            if tool.get("target"):
                return await self.api.call(tool["target"], "run", d, emit)
            result = await self.api.call(
                "environment", tool["name"], {"session": d["session"], **call["input"]}, emit
            )
            import json

            text = result if isinstance(result, str) else result.get("text", json.dumps(result))
            status = (
                "failed" if isinstance(result, dict) and result.get("exit_code", 0) else "completed"
            )
            return {"call": call["id"], "status": status, "content": content(text), "value": result}
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if isinstance(exc, AgentError) and exc.code == "process_lost":
                raise  # The Runtime must record an unknown effect, not a failed one.
            return {"call": call["id"], "status": "failed", "content": content(str(exc))}
