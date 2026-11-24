"""Opt-in Haiku-only ACP/MCP proof. --offline exercises the entire driver without inference.

uv run python scripts/milestone4_live.py --confirm-live --output /tmp/ma-m4-live
uv run python scripts/milestone4_live.py --verify-only --output /tmp/ma-m4-live
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

import acp
from acp import schema as s
from ma_core import Plugin, plain
from ma_mcp import tool_name

MODEL = "claude-haiku-5-5"
MARKER = "M4-ACP-MCP-83109"
REPO = Path(__file__).resolve().parents[1]


class Trace(Plugin):
    """A settings-loaded audit plugin. Records request identity, never request content."""

    name = "request_audit"
    declarations = {"request_metadata_only": True}

    def __init__(self, path, provider):
        self.path, self.provider = Path(path), provider

    async def start(self, api):
        await super().start(api)
        api.on(self.provider + ".before", self.request)

    async def request(self, d):
        with self.path.open("a") as file:
            file.write(
                json.dumps(
                    {
                        "session": d["session"],
                        "model": d["access"]["id"],
                        "thinking": d.get("settings", {}).get("thinking", "off"),
                    }
                )
                + "\n"
            )
        return d


def save(output, name, value):
    (output / name).write_text(json.dumps(value, indent=2) + "\n")


class Client:
    def __init__(self, output):
        self.output = output
        self.updates, self.permissions, self.events = [], [], []

    async def session_update(self, session_id, update, **kwargs):
        value = {
            "session": session_id,
            "update": update.model_dump(mode="json", by_alias=True, exclude_none=True),
        }
        self.updates.append(value)
        with (self.output / "updates.jsonl").open("a") as file:
            file.write(json.dumps(value) + "\n")

    async def ext_notification(self, method, params):
        self.events.append({"method": method, "event": params})
        with (self.output / "events.jsonl").open("a") as file:
            file.write(json.dumps(self.events[-1]) + "\n")

    async def request_permission(self, session_id, tool_call, options, **kwargs):
        self.permissions.append(
            {
                "session": session_id,
                "call": tool_call.tool_call_id,
                "options": [o.model_dump(mode="json", by_alias=True) for o in options],
            }
        )
        return s.RequestPermissionResponse(outcome=s.AllowedOutcome(option_id="allow"))

    async def create_elicitation(self, message, mode, **kwargs):
        return s.DeclineElicitationResponse()


async def demonstrate(output, offline=False, runtime="durable"):
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    project = output / "project"
    project.mkdir()
    proof = project / "server-proof.txt"
    proof.write_text(MARKER + "\n")
    store = output / "store"
    store.mkdir()
    model = "fake" if offline else MODEL
    save(
        store,
        "settings.json",
        {
            "model": model,
            "max_steps": 4,
            "max_retries": 0,
            "plugins": [
                {
                    "factory": "scripts.milestone4_live:Trace",
                    "options": {
                        "path": str(output / "requests.jsonl"),
                        "provider": "fake" if offline else "claude",
                    },
                }
            ],
        },
    )
    args = [
        sys.executable,
        "-m",
        "modular_agent",
        "--mode",
        "acp",
        "--project",
        str(project),
        "--home",
        str(store),
        "--runtime",
        runtime,
    ]
    if offline:
        from ma_fake import reply

        save(
            output,
            "fake.json",
            [
                reply(
                    calls=[
                        {"id": "proof-call", "name": tool_name("proof", "read_proof"), "input": {}}
                    ]
                ),
                reply("The MCP server returned " + MARKER + "."),
            ],
        )
        args += ["--fake-script", str(output / "fake.json")]
    client = Client(output)
    with (output / "agent-stderr.log").open("w") as stderr:
        proc = await asyncio.create_subprocess_exec(
            *args,
            cwd=REPO,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=stderr,
        )
        conn = acp.connect_to_agent(client, proc.stdin, proc.stdout, use_unstable_protocol=True)
        try:
            async with asyncio.timeout(180):
                init = await conn.initialize(
                    protocol_version=1,
                    client_capabilities=s.ClientCapabilities(
                        field_meta={"modular-agent": {"events": True}}
                    ),
                )
                save(output, "initialize.json", init.model_dump(mode="json", by_alias=True))
                session = await conn.new_session(
                    cwd=str(project),
                    mcp_servers=[
                        s.McpServerStdio(
                            name="proof",
                            command=sys.executable,
                            args=[str(REPO / "scripts/milestone4_mcp.py"), "--file", str(proof)],
                            env=[],
                        )
                    ],
                )
                sid = session.session_id
                save(output, "session.json", session.model_dump(mode="json", by_alias=True))
                for key, value in [
                    ("model", ("fake/" if offline else "claude/") + model),
                    ("thinking", "off"),
                    ("approval", "all"),
                ]:
                    await conn.set_config_option(session_id=sid, config_id=key, value=value)
                prompt = "Use the MCP read_proof tool exactly once to obtain the proof marker. It takes no arguments. Then answer in one short sentence saying the MCP server returned that exact marker. Do not use any other tools, delegate, or ask questions."
                save(output, "input.json", {"text": prompt, "key": "milestone4-proof"})
                response = await conn.prompt(
                    session_id=sid,
                    prompt=[s.TextContentBlock(text=prompt)],
                    **{"modular-agent": {"key": "milestone4-proof"}},
                )
                save(output, "response.json", response.model_dump(mode="json", by_alias=True))
                history = await conn.ext_method("modular-agent/history", {"sessionId": sid})
                save(output, "history.json", history)
                save(output, "permissions.json", client.permissions)
                results = [e for e in history["entries"] if e["kind"] == "toolResult"]
                server_pid = results[0]["data"]["value"]["pid"]
                await conn.close_session(session_id=sid)
                try:
                    os.kill(server_pid, 0)
                except ProcessLookupError:
                    server_stopped = True
                else:
                    server_stopped = False
                start = len(client.updates)
                await conn.resume_session(session_id=sid, cwd=str(project), mcp_servers=[])
                resumed = client.updates[start:]
                await conn.close_session(session_id=sid)
                start = len(client.updates)
                await conn.load_session(session_id=sid, cwd=str(project), mcp_servers=[])
                loaded = client.updates[start:]
                save(output, "replay.json", {"resume": resumed, "load": loaded})
                await conn.close_session(session_id=sid)
                save(
                    output,
                    "run.json",
                    {
                        "model": model,
                        "offline": offline,
                        "runtime": runtime,
                        "session": sid,
                        "mcp_stopped": server_stopped,
                    },
                )
        finally:
            proc.stdin.close()
            try:
                await proc.stdin.wait_closed()
            except BrokenPipeError:
                pass
            await conn.close()
            try:
                async with asyncio.timeout(15):
                    await proc.wait()
            except TimeoutError:
                proc.kill()
                await proc.wait()
                raise
        save(output, "process.json", {"exit_code": proc.returncode})
    return validate(output)


def validate(output):
    output = Path(output)

    def read(name):
        return json.loads((output / name).read_text())

    run = read("run.json")
    assert run["model"] == ("fake" if run["offline"] else MODEL)
    init, session = read("initialize.json"), read("session.json")
    assert init["protocolVersion"] == 1 and init["agentCapabilities"]["loadSession"]
    assert "request_audit" in session["_meta"]["modular-agent"]["plugins"]
    es = read("history.json")["entries"]
    responses = [e for e in es if e["kind"] == "response"]
    calls = [e for e in es if e["kind"] == "toolStarted"]
    results = [e for e in es if e["kind"] == "toolResult"]
    assert len(calls) == len(results) == 1
    call, result = calls[0], results[0]
    assert call["data"]["call"]["name"] == tool_name("proof", "read_proof")
    assert call["data"]["definition"]["mcp"]["server"] == "proof"
    request = next(e["data"]["request"] for e in es if e["kind"] == "modelRequest")
    offered = next(t for t in request["tools"] if t["name"] == call["data"]["call"]["name"])
    assert offered["parameters"]["properties"] == {}
    assert result["toolCallId"] == call["toolCallId"] and result["data"]["status"] == "completed"
    assert result["data"]["value"]["marker"] == MARKER
    ends = [e for e in es if e["kind"] == "turnEnd"]
    assert len(ends) == 1 and ends[0]["data"]["outcome"]["kind"] == "completed"
    answer = plain(ends[0]["data"]["content"])
    assert MARKER in answer and "mcp" in answer.lower()
    assert MARKER not in read("input.json")["text"]
    permissions = read("permissions.json")
    assert len(permissions) == 1 and permissions[0]["call"] == call["toolCallId"]
    assert any(e["kind"] == "inputAnswer" and e["data"]["value"] == "allow" for e in es)
    requests = [json.loads(line) for line in (output / "requests.jsonl").read_text().splitlines()]
    assert len(requests) == len(responses) == 2
    assert {r["model"] for r in requests} == {run["model"]}
    assert read("response.json")["stopReason"] == "end_turn"
    replay = read("replay.json")
    assert not replay["resume"] and replay["load"]
    assert MARKER in json.dumps(replay["load"])
    assert run["mcp_stopped"] and read("process.json")["exit_code"] == 0
    summary = {
        "model": run["model"],
        "offline": run["offline"],
        "runtime": run["runtime"],
        "session": run["session"],
        "model_requests": len(requests),
        "mcp_calls": 1,
        "permissions": 1,
        "resume_replayed": False,
        "load_replayed": True,
        "answer": answer,
        "cleanup": "agent and session MCP server stopped",
    }
    save(output, "summary.json", summary)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runtime", choices=["transient", "durable"], default="durable")
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--confirm-live", action="store_true")
    modes.add_argument("--offline", action="store_true")
    modes.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    result = (
        validate(args.output)
        if args.verify_only
        else asyncio.run(demonstrate(args.output, args.offline, args.runtime))
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
