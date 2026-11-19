"""The ma command, built on the public Python SDK."""

import argparse
import asyncio
from dataclasses import asdict
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
from typing import cast

from modular_agent import (
    Agent,
    AgentError,
    Durability,
    Event,
    JsonObject,
    Provider,
    ProviderContext,
    Session,
    ModelRef,
    OutcomeKind,
    create_agent,
    file_history,
    http_history,
)
from modular_agent.files import file_tools
from modular_agent.testing import ScriptedProvider

from .auth import AuthFile
from .code import code_tool
from .config import Paths, claude_launch
from .prompt import discover, prompt_plugin


class Script(ScriptedProvider):
    async def request(
        self, model: ModelRef, request: JsonObject, context: ProviderContext
    ) -> JsonObject:
        if path := os.environ.get("MODULAR_AGENT_SCRIPT_LOG"):
            messages: list[JsonObject] = []
            for item in cast(list[JsonObject], request.get("messages", [])):
                parts = cast(list[JsonObject], item.get("content", []))
                row: JsonObject = {
                    "role": item["role"],
                    "text": "".join(
                        str(p.get("text", "")) for p in parts if p.get("type") == "text"
                    ),
                }
                if item["role"] == "assistant":
                    row["toolCalls"] = [
                        {"name": p["name"], "input": p.get("arguments", {})}
                        for p in parts
                        if p.get("type") == "toolCall"
                    ]
                if item["role"] == "toolResult":
                    row["name"] = item.get("toolName", "")
                messages.append(row)
            with Path(path).open("a", encoding="utf-8") as file:
                file.write(
                    json.dumps(
                        {
                            "system": request.get("systemPrompt", ""),
                            "tools": [
                                t["name"] for t in cast(list[JsonObject], request.get("tools", []))
                            ],
                            "messages": messages,
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
        return await super().request(model, request, context)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ma", description="ma, the standard Modular Agent")
    parser.add_argument("-V", "--version", action="version", version="ma 0.1.0 (Python)")
    parser.add_argument("--model", metavar="PROVIDER/ID")
    parser.add_argument("--thinking", choices=("off", "minimal", "low", "medium", "high", "xhigh"))
    parser.add_argument("--session", metavar="ID")
    parser.add_argument("-c", "--continue", dest="resume", action="store_true")
    parser.add_argument("--project", type=Path, default=Path.cwd(), metavar="DIR")
    parser.add_argument("--trust-project", action="store_true")
    parser.add_argument("--runtime", choices=("durable", "transient"), default="durable")
    parser.add_argument("-p", "--print", dest="prompt", metavar="PROMPT")
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--history", action="store_true")
    parser.add_argument("--declaration", action="store_true")
    parser.add_argument("--acp", action="store_true")
    parser.add_argument("--all", action="store_true", help="list sessions across all projects")
    parser.add_argument("--device", action="store_true", help="use a device code to sign in")
    parser.add_argument(
        "command",
        nargs="?",
        choices=("login", "logout", "auth", "models", "skills", "mcp", "sessions"),
    )
    parser.add_argument("provider", nargs="?")
    return parser


def _json(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False), flush=True)


def _event(event: Event, args: argparse.Namespace, *, line: bool = False) -> None:
    if args.json:
        _json(asdict(event))
    elif event.type == "text" and line and event.data.delta:
        print(event.data.delta, end="", flush=True)
    elif args.verbose and event.type in {"toolCall", "toolStarted", "toolOutput", "toolResult"}:
        print(f"{event.type}: {event.data}", file=sys.stderr, flush=True)


async def _print_turn(session: Session, args: argparse.Namespace) -> int:
    if args.json or args.verbose:
        async for event in session.prompt_stream(args.prompt):
            _event(event, args)
        result = await session.last_turn()
    else:
        result = await session.prompt(args.prompt)
    if result is None or result.outcome is None:
        return 0 if result and result.disposition == "handled" else 1
    if not args.json:
        if result.text:
            print(result.text)
        if result.outcome.error:
            print(result.outcome.error, file=sys.stderr)
    return 0 if result.outcome.kind is OutcomeKind.COMPLETED else 1


async def _line(session: Session, args: argparse.Namespace) -> int:
    loop = asyncio.get_running_loop()
    active = False

    async def events() -> None:
        nonlocal active
        async for event in session.events():
            if event.type == "turnStarted":
                active = True
            _event(event, args, line=True)
            if event.type == "turnEnded":
                active = False
                if not args.json:
                    print(flush=True)

    async def cancel() -> None:
        await session.cancel()

    loop.add_signal_handler(signal.SIGINT, lambda: loop.create_task(cancel()))
    watcher = asyncio.create_task(events())
    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                if active:
                    await cancel()
                break
            line = line.strip()
            if not line:
                continue
            if line == "/cancel":
                await cancel()
            elif line.startswith("/after "):
                await session.send(line.removeprefix("/after "), "after")
            elif line.startswith("/") and not line.startswith("/skill:"):
                try:
                    if line == "/commands":
                        commands = await session.commands()
                        print(
                            "\n".join(
                                f"/{name}  {description}" for name, description in commands.items()
                            )
                        )
                    elif output := await session.run_command(line):
                        print(output)
                except AgentError as exc:
                    print(exc, file=sys.stderr)
            else:
                receipt = await session.send(line, "steer" if active else "now")
                active = receipt.disposition is None or active
    finally:
        loop.remove_signal_handler(signal.SIGINT)
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)
    return 0


def _claude_status() -> str:
    try:
        result = subprocess.run(
            ["claude", "auth", "status"], stdin=subprocess.DEVNULL, capture_output=True, check=False
        )
    except OSError:
        return "Claude Code is not installed"
    return (
        "signed in through Claude Code"
        if result.returncode == 0
        else "not signed in (run `ma login claude`)"
    )


async def _agent(
    paths: Paths, project: Path, args: argparse.Namespace, *, catalog_only: bool = False
) -> Agent:
    script = os.environ.get("MODULAR_AGENT_SCRIPT")
    testing = args.acp and os.environ.get("MODULAR_AGENT_CONFORMANCE") == "1"
    settings = paths.settings(project)
    providers: list[Provider] = []
    processes = None
    model = args.model or cast(str | None, settings.pop("model", None))
    if script:
        script_data = json.loads(Path(script).read_text(encoding="utf-8"))
        if not isinstance(script_data, list) or any(not isinstance(s, dict) for s in script_data):
            raise ValueError("the model script must be an array of objects")
        providers.append(Script(cast(list[JsonObject], script_data)))
        model = "scripted/script"
    elif testing:
        settings.pop("modelTools", None)
        settings["thinking"] = "off"
    else:
        from .responses import Responses

        auth = AuthFile(paths.config / "auth.json")
        providers.extend(
            [
                Responses(vendor, auth, paths.config / "models.json")
                for vendor in ("openai-codex", "xai")
            ]
        )
        if not model and not (
            args.session
            or args.resume
            or args.declaration
            or args.history
            or args.acp
            or args.command in {"models", "sessions"}
        ):
            if auth.login("openai-codex"):
                model = "openai-codex/gpt-6.1-sol"
            elif auth.login("xai"):
                model = "xai/grok-4.7"
            elif claude_launch() and _claude_status().startswith("signed in"):
                model = "claude/claude-sonnet-5-5"
            else:
                raise ValueError(
                    "no model is available. Sign in with `ma login openai-codex`, `ma login xai` or `ma login claude`, or pass --model. See `ma models`."
                )
        if (
            args.command == "models" or args.acp or (model and model.startswith("claude/"))
        ) and not catalog_only:
            sidecar = claude_launch()
            if model and model.startswith("claude/") and sidecar is None:
                raise ValueError(
                    "the Claude sidecar is not installed; build typescript/sidecars/claude or set MODULAR_AGENT_CLAUDE_SIDECAR"
                )
            if sidecar:
                processes = [sidecar]
    if args.thinking:
        settings["thinking"] = args.thinking
    if args.command != "models" and (
        script or model is not None and not model.startswith("claude/")
    ):
        for info in (info for provider in providers for info in provider.models()):
            if (
                model == f"{info['provider']}/{info['id']}"
                and settings.get("thinking") not in info["thinking"]
            ):
                if args.thinking:
                    raise ValueError(f"thinking level {args.thinking} is not available for {model}")
                levels = ["off", "minimal", "low", "medium", "high", "xhigh"]
                asked = levels.index(str(settings["thinking"]))
                settings["thinking"] = next(
                    (level for level in reversed(levels[: asked + 1]) if level in info["thinking"]),
                    "off",
                )
    durability: Durability = "durable" if args.runtime == "durable" else "kept"
    url, token = (
        os.environ.get("MODULAR_AGENT_HISTORY_URL"),
        os.environ.get("MODULAR_AGENT_HISTORY_TOKEN_FILE"),
    )
    history = http_history(url, token) if url and token else file_history(paths.state / "sessions")
    return await create_agent(
        project=project,
        data_dir=paths.state,
        history=history,
        durability=durability,
        local_process_groups=True,
        providers=providers,
        tools=[] if catalog_only else [code_tool()],
        plugins=[]
        if catalog_only
        else [file_tools(paths.state / "output"), prompt_plugin(paths.config, project)],
        model=None if catalog_only else model,
        settings=settings,
        process_plugins=processes,
        plugin_host=True,
        commands=not catalog_only,
        conformance=testing,
        mcp_servers=[] if catalog_only else paths.mcp(project),
    )


async def _run(args: argparse.Namespace) -> int:
    paths = Paths.from_env()
    project = args.project.resolve(strict=True)
    if args.provider and args.command not in {"login", "logout"}:
        raise ValueError(f"unknown argument {args.provider}; use --help")
    if args.acp and (args.prompt is not None or args.session or args.trust_project or args.resume):
        raise ValueError("with --acp the client creates sessions and grants trust")
    if args.trust_project:
        paths.trust(project)
    if args.command in {"login", "logout", "auth"}:
        from .oauth import account_command

        await account_command(
            args.command,
            args.provider,
            args.device,
            AuthFile(paths.config / "auth.json"),
            _claude_status,
        )
        return 0
    if args.command == "skills":
        skills, problems = discover(paths.config, project)
        for s in skills:
            print(f"{s.name:<28} {s.description}\n{'':28} {s.file}")
        for problem in problems:
            print(f"skipped {problem}", file=sys.stderr)
        return 0
    if args.command == "mcp":
        for server in paths.mcp(project):
            print(
                f"{server['name']:<20} http   {server['url']}"
                if server["type"] == "http"
                else f"{server['name']:<20} stdio  {server['command']} {' '.join(cast(list[str], server.get('args', [])))}"
            )
        return 0
    if args.command == "sessions" or args.resume or args.session:
        async with await _agent(paths, project, args, catalog_only=True) as preflight:
            sessions = await preflight.sessions()
        matching = [s for s in sessions if s["project"] == str(project)]
        if args.command == "sessions":
            for saved_session in sessions if args.all else matching:
                print(f"{saved_session['id']}  {saved_session['project']}")
            return 0
        if args.session is None:
            if not matching:
                raise ValueError("this folder has no saved session to continue")
            args.session = max(
                matching, key=lambda s: cast(int, s.get("updated_at", s.get("updated", 0)))
            )["id"]
        saved = next((s for s in sessions if s["id"] == args.session), None)
        if saved is None:
            raise ValueError("Unknown session")
        project = Path(cast(str, saved["project"]))
    async with await _agent(paths, project, args) as agent:
        if args.acp:
            await agent.serve_acp()
            return 0
        if args.command == "models":
            for info in await agent.models():
                name = f"{info['provider']}/{info['id']}"
                print(
                    f"{name:<34} context {info['contextWindow']:>7}  thinking {','.join(info['thinking'])}"
                )
            return 0
        if args.declaration:
            _json(agent.declaration())
            return 0
        session = await agent.open_session(args.session) if args.session else await agent.session()
        if args.session:
            for key in ("model", "thinking"):
                if value := getattr(args, key):
                    await session.set_setting(key, value)
        if args.history:
            _json({"sessionId": session.id, "entries": await session.history()})
            return 0
        return (
            await _print_turn(session, args)
            if args.prompt is not None
            else await _line(session, args)
        )


def main() -> None:
    try:
        status = asyncio.run(_run(_parser().parse_args()))
    except (AgentError, OSError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        status = 1
    except KeyboardInterrupt:
        status = 1
    raise SystemExit(status)
