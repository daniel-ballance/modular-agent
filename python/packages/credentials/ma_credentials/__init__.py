"""Credential access is granted only to Providers, tool sources and environments."""

import asyncio
from pathlib import Path

from ma_core import AgentError, Plugin

from .staging import StagedFile


class StagedCredentials(Plugin):
    name = "credentials"
    role = "credential_store"

    async def start(self, api):
        await super().start(api)
        api.provide("credentials", self)
        if self.declarations.get("stores_secrets"):
            api.on("session.prepare", self.recover, "first")

    async def answer(self, d, emit):
        if not self.declarations.get("stores_secrets"):
            raise AgentError("Credential store is read-only", "not_supported")
        async with self.intake:
            identity = {k: d[k] for k in ("session", "request", "actor")}
            scope = {**identity, "authority": d.get("authority"), "acting_for": d.get("acting_for")}
            q = await self.api.call("questions", "validate", scope)
            name, value = q.get("name"), d.get("value")
            if q["kind"] != "secret" or not isinstance(name, str) or not isinstance(value, str):
                raise AgentError("Invalid secret intake", "invalid_request")
            sid, request, actor = (identity[k] for k in ("session", "request", "actor"))
            try:
                await self.store.stage(sid, request, name, actor, value)
                receipt = await self.store.lookup_staged(sid, request)
            except Exception:
                raise AgentError("Credential could not be staged", "credentials") from None
            if receipt != {**identity, "name": name}:
                raise AgentError("Invalid staging receipt", "conflict")
            await self.api.call("questions", "select_secret", {**scope, "name": name})
            return await self._finish(sid, request)

    async def _finish(self, sid, request):
        try:
            decision = await self.store.activate(sid, request)
        except Exception:
            raise AgentError(
                "Credential activation could not be confirmed", "credentials"
            ) from None
        if decision not in {"activated", "superseded"}:
            raise AgentError("Credential activation could not be confirmed", "credentials")
        return await self.api.call(
            "questions", "record_secret", {"session": sid, "request": request, "decision": decision}
        )

    async def recover(self, d):
        if not d.get("resumed"):
            return
        sid = d["session"]
        async with self.intake:
            for q in await self.api.call("questions", "list", {"session": sid}):
                if q["kind"] != "secret":
                    continue
                request = q["id"]
                if q.get("selected") and not q.get("answer") and not q.get("closed"):
                    await self._finish(sid, request)
                elif not q.get("selected"):
                    staged = await self.store.lookup_staged(sid, request)
                    if staged is not None or q.get("answer") or q.get("closed"):
                        await self.store.discard(sid, request)
                    if staged is not None and not q.get("answer") and not q.get("closed"):
                        await self.api.call(
                            "questions", "discard_secret", {"session": sid, "request": request}
                        )


class Credentials(StagedCredentials):
    declarations = {"stores_secrets": True}

    def __init__(self, root, claude_home=None):
        self.root = Path(root)
        self.claude_home = Path(claude_home or Path.home() / ".claude")
        self.intake = asyncio.Lock()
        self.store = StagedFile(self.root / "credentials.json")

    async def get(self, d, emit):
        if d["name"] == "claude_login":
            if not (self.claude_home / ".credentials.json").is_file():
                raise AgentError(
                    "Claude Code sign-in needed. Run claude auth login outside the agent.",
                    "credentials",
                )
            return {"kind": "claude_code_login", "config_dir": str(self.claude_home)}
        if (value := self.store.read(d["name"])) is not None:
            return value
        raise AgentError("Sign-in needed for " + d["name"], "credentials")
