"""Select models outside the Runtime and hand it credential-free model access."""

from ma_core import AgentError, Plugin


class Selection(Plugin):
    name = "selection"

    def __init__(self, providers):
        self.providers = providers

    async def start(self, api):
        await super().start(api)
        api.provide("selection", self)
        api.command("model", "Show or change the session model", self.model)
        api.command("thinking", "Show or change the reasoning level", self.thinking)

    async def add_provider(self, d, emit):
        if d["provider"] not in self.providers:
            self.providers.append(d["provider"])
        return {}

    async def catalog(self, d, emit=None):
        result = []
        for target in self.providers:
            for model in await self.api.call(target, "catalog"):
                result.append({**model, "target": target})
        return result

    async def access(self, d, emit=None):
        s = await self.api.session("get", session=d["session"])
        model = d.get("model") or s["settings"].get("model")
        if not model:
            raise AgentError("No model selected", "invalid_request")
        match = next(
            (m for m in await self.catalog({}) if model in {m["id"], m["target"] + "/" + m["id"]}),
            None,
        )
        if not match:
            raise AgentError("Model is not available: " + model)
        return match

    async def model(self, d):
        s = await self.api.session("get", session=d["session"])
        if not d["args"]:
            return {"model": s["settings"]["model"], "catalog": await self.catalog({})}
        if d["args"] not in {m["id"] for m in await self.catalog({})}:
            raise AgentError("Unknown model")
        await self.api.session(
            "settings",
            session=d["session"],
            actor=d.get("actor", s["actor"]),
            changes={"model": d["args"]},
        )
        return {"model": d["args"]}

    async def thinking(self, d):
        s = await self.api.session("get", session=d["session"])
        if not d["args"]:
            return {"thinking": s["settings"].get("thinking")}
        access = await self.access(d)
        if d["args"] not in access.get("thinking", []):
            raise AgentError("Thinking level not supported")
        await self.api.session(
            "settings",
            session=d["session"],
            actor=d.get("actor", s["actor"]),
            changes={"thinking": d["args"]},
        )
        return {"thinking": d["args"]}
