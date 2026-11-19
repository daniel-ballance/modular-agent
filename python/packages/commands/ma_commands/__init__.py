"""Model-free command routing and history commands."""

from ma_core import Plugin, Stop, plain


class Commands(Plugin):
    name = "commands"

    async def start(self, api):
        await super().start(api)
        api.on("input.arrives", self.input, "first")
        for name, description, handler in [
            ("sessions", "List sessions for this project, or all", self.sessions),
            ("fork", "Fork the current branch", self.fork),
            ("tree", "Show entries, or move to an entry ID", self.tree),
            ("erase", "Erase an entry and copies controlled by the agent", self.erase),
        ]:
            api.command(name, description, handler)

    async def input(self, d):
        text = plain(d["content"])
        if d.get("commands", True) and text.startswith("/"):
            result = await self.api.session(
                "command",
                session=d["session"],
                text=text,
                **({"actor": d["actor"]} if "actor" in d else {}),
            )
            await self.api.session(
                "append",
                session=d["session"],
                kind="command",
                actor=d.get("actor", "user"),
                writer=self.name,
                data={"name": text.split()[0]},
            )
            return Stop({"handled": True, "result": result})
        return d

    async def sessions(self, d):
        s = await self.api.session("get", session=d["session"])
        return await self.api.session(
            "list", **({} if d["args"] == "all" else {"project": s["project"]})
        )

    async def fork(self, d):
        child = await self.api.session("fork", session=d["session"], actor=d.get("actor", "user"))
        return {"session": child["id"]}

    async def tree(self, d):
        if d["args"]:
            return await self.api.session(
                "move", session=d["session"], point=d["args"], actor=d.get("actor", "user")
            )
        branch = await self.api.session("branch", session=d["session"])
        return [{"id": e["id"], "parent": e["parent"], "kind": e["kind"]} for e in branch]

    async def erase(self, d):
        return await self.api.session(
            "erase", session=d["session"], entries=[d["args"]], actor=d.get("actor", "user")
        )
