"""Credential access is granted only to Providers, tool sources and environments."""

import asyncio
import json
import os
from pathlib import Path

from ma_core import AgentError, Plugin


class Credentials(Plugin):
    name = "credentials"
    role = "credential_store"
    declarations = {"stores_secrets": True}

    def __init__(self, root, claude_home=None):
        self.root = Path(root)
        self.claude_home = Path(claude_home or Path.home() / ".claude")
        self.intake = asyncio.Lock()

    async def start(self, api):
        await super().start(api)
        api.provide("credentials", self)

    async def answer(self, d, emit):
        # This is the only raw-secret intake. It never calls the Runtime and never
        # includes the supplied value in an exception, event or history entry.
        async with self.intake:
            q = await self.api.call(
                "questions",
                "validate",
                {"session": d["session"], "request": d["request"], "actor": d["actor"]},
            )
            if (
                q["kind"] != "secret"
                or q["name"] == "claude_login"
                or not isinstance(d.get("value"), str)
            ):
                raise AgentError("Invalid secret intake", "refused")
            path = self.root / "credentials.json"
            temp = self.root / "credentials.tmp"
            try:
                self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
                values = json.loads(path.read_text()) if path.exists() else {}
                values[q["name"]] = d["value"]
                fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w") as file:
                    os.fchmod(file.fileno(), 0o600)
                    json.dump(values, file)
                    file.flush()
                    os.fsync(file.fileno())
                temp.replace(path)
                directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
            except Exception:
                temp.unlink(missing_ok=True)
                raise AgentError("Credential could not be stored", "credentials") from None
            return await self.api.call(
                "questions",
                "record_secret",
                {
                    "session": d["session"],
                    "request": d["request"],
                    "actor": d["actor"],
                    "name": q["name"],
                },
            )

    async def get(self, d, emit):
        if d["name"] == "claude_login":
            if not (self.claude_home / ".credentials.json").is_file():
                raise AgentError(
                    "Claude Code sign-in needed. Run claude auth login outside the agent.",
                    "credentials",
                )
            # Claude Code reads its own login. Never copy its token into agent history.
            return {"kind": "claude_code_login", "config_dir": str(self.claude_home)}
        path = self.root / "credentials.json"
        if path.is_file():
            values = json.loads(path.read_text())
            if d["name"] in values:
                return values[d["name"]]
        raise AgentError("Sign-in needed for " + d["name"], "credentials")
