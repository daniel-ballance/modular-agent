"""Managed plugin-kit fixture. Only the authenticated factory context selects state."""

import asyncio
import json
import os
from pathlib import Path

from ma_plugin.websocket import wait_for_stop
from modular_agent import AgentError, ErrorCode, Plugin, ToolContext, serve, tool


class Files:
    supports = {"containment": "none", "confinesFiles": True}

    def __init__(self, files):
        self.files = files

    async def read(self, params):
        return {"data": self.files[params["path"]]}

    async def write(self, params):
        self.files[params["path"]] = params["data"]
        return {}

    async def exists(self, params):
        return {"exists": params["path"] in self.files}

    async def exec(self, params, progress):
        raise AgentError(ErrorCode.NOT_SUPPORTED, "No local command execution")

    async def session_ended(self, params):
        pass


async def main(config):
    bounds = {s["callerId"]: s for s in config["scopes"]}
    files = {cid: {} for cid in bounds}

    def audit(event, cid):
        with Path(config["auditFile"]).open("a") as f:
            print(json.dumps({"event": event, "callerId": cid}), file=f)

    def factory(context):
        cid = context["caller_id"]
        audit("factory", cid)
        marker = Path(bounds[cid]["stateDir"]) / "marker"

        @tool(output=dict)
        async def caller_probe(callerId: str, write: str | None = None):
            """Return the marker for the authenticated caller."""
            previous = marker.read_text() if marker.exists() else None
            if write is not None:
                marker.write_text(write)
            return {"callerId": cid, "previous": previous}

        @tool
        async def bash(command: str, cx: ToolContext) -> str:
            """Delegate a command to the live parent."""
            return (await cx.environment.exec(command))["text"]

        def setup(r):
            audit("setup", cid)
            r.tool(caller_probe)
            r.tool(bash)
            r.environment(Files(files[cid]))

        return Plugin("named-fixture", setup=setup)

    callers = [
        {"caller_id": c["callerId"], "token_file": c["tokenFile"]} for c in config["callers"]
    ]
    try:
        server = await serve(
            factory,
            listen=config["listen"],
            callers=callers,
            projects={cid: [s["project"]] for cid, s in bounds.items()},
            **({"token_file": config["tokenFile"]} if "tokenFile" in config else {}),
        )
    except AgentError as exc:
        if exc.code != ErrorCode.INVALID_COMPOSITION:
            raise
        print(json.dumps({"error": "invalid_composition"}), flush=True)
        raise SystemExit(1) from None
    print(json.dumps({"url": server.url}), flush=True)
    await wait_for_stop(server)


if __name__ == "__main__":
    asyncio.run(main(json.loads(Path(os.environ["MA_PLUGIN_FIXTURE"]).read_text())))
