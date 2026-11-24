"""Assemble the system prompt from base guidance, project and plugin sections."""

from ma_core import AgentError, Plugin


class Prompt(Plugin):
    name = "prompt"

    async def start(self, api):
        await super().start(api)
        api.define_hook("prompt.sections", "collect")
        api.on("turn.prepare", self.prepare)

    async def prepare(self, d):
        s = await self.api.session("get", session=d["session"], include_entries=False)
        sections = [
            "You are a helpful agent. Use the supplied tools for file and shell work. "
            "Never invent tool results. Follow the project instructions below.",
            "Session project: " + s["project"],
        ]
        try:
            text = await self.api.call(
                "environment", "read", {"session": s["id"], "path": "AGENTS.md"}
            )
            sections.append("Project AGENTS.md:\n" + text)
        except AgentError as exc:
            # Missing context is normal; other file errors must not silently hide rules.
            if exc.code != "not_found":
                raise
        sections.extend(await self.api.hook("prompt.sections", d))
        return {"system": "\n\n".join(sections)}
