import asyncio
import json
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import acp
from acp import schema as s


class Client:
    def __init__(self, permission="allow", answer="from host"):
        self.permission, self.answer = permission, answer
        self.updates, self.events, self.permissions, self.elicitations = [], [], [], []
        self.question = asyncio.Event()
        self.changed = asyncio.Event()
        self.release = asyncio.Event()

    async def request_permission(self, session_id, tool_call, options, **kwargs):
        self.permissions.append((session_id, tool_call, options))
        self.question.set()
        if self.permission == "wait":
            await self.release.wait()
            return s.RequestPermissionResponse(outcome=s.DeniedOutcome())
        if self.permission == "cancelled":
            return s.RequestPermissionResponse(outcome=s.DeniedOutcome())
        return s.RequestPermissionResponse(outcome=s.AllowedOutcome(option_id=self.permission))

    async def create_elicitation(self, message, mode, **kwargs):
        self.elicitations.append((message, mode))
        self.question.set()
        if self.answer is None:
            await self.release.wait()
        return s.AcceptElicitationResponse(content={"answer": self.answer})

    async def session_update(self, session_id, update, **kwargs):
        self.updates.append((session_id, update))
        self.changed.set()

    async def ext_notification(self, method, params):
        self.events.append((method, params))
        self.changed.set()

    async def wait_event(self, kind):
        async with asyncio.timeout(10):
            while not any(e[1].get("kind") == kind for e in self.events):
                self.changed.clear()
                await self.changed.wait()


@asynccontextmanager
async def running(tmp_path, script, runtime_kind, client=None, forms=True, binding=None):
    client = client or Client()
    script_path = tmp_path / "script.json"
    script_path.write_text(json.dumps(script))
    stderr = (tmp_path / "agent-stderr.log").open("ab")
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "modular_agent",
        "--mode",
        "acp",
        "--home",
        str(tmp_path / "store"),
        "--project",
        str(tmp_path),
        "--runtime",
        runtime_kind,
        "--fake-script",
        str(script_path),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=stderr,
        cwd=Path(__file__).resolve().parents[1],
    )
    conn = acp.connect_to_agent(client, proc.stdin, proc.stdout, use_unstable_protocol=True)
    try:
        initialized = await conn.initialize(
            protocol_version=1,
            **({"modular-agent": {"binding": binding}} if binding else {}),
            client_capabilities=s.ClientCapabilities(
                elicitation=s.ElicitationCapabilities(form=s.ElicitationFormCapabilities())
                if forms
                else None,
                field_meta={"modular-agent": {"events": True}},
            ),
        )
        yield conn, client, initialized
    finally:
        proc.stdin.close()
        await proc.stdin.wait_closed()
        await conn.close()
        try:
            async with asyncio.timeout(10):
                await proc.wait()
        except TimeoutError:
            proc.kill()
            await proc.wait()
            raise
        finally:
            stderr.close()


async def extension(conn, operation, sid, **data):
    return (await conn.ext_method("modular-agent/" + operation, {"session": sid, **data}))["value"]


async def prompt(conn, sid, text="hello", **meta):
    return await conn.prompt(
        session_id=sid,
        prompt=[s.TextContentBlock(text=text)],
        **({"modular-agent": meta} if meta else {}),
    )
