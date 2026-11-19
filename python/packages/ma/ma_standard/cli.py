"""The ma command, built on the public Python SDK."""

import argparse
import asyncio
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
    Answer,
    Durability,
    Event,
    JsonObject,
    Provider,
    ProviderContext,
    Question,
    QuestionContext,
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
    data = event.data.fields
    if args.json:
        _json(
            {
                "type": event.type,
                "time": event.time,
                "sessionId": event.session_id,
                **{
                    key: value
                    for key, value in (
                        ("turnId", event.turn_id),
                        ("stepId", event.step_id),
                        ("toolCallId", event.call_id),
                    )
                    if value is not None
                },
                "data": data,
            }
        )
    elif event.type == "text" and line and event.data.delta:
        print(event.data.delta, end="", flush=True)
    elif event.type == "toolStarted" and (args.verbose or not data.get("parentCallId")):
        name = data.get("name", "tool")
        arguments = data.get("input")
        if (
            name == "codemode"
            and isinstance(arguments, dict)
            and isinstance(code := arguments.get("code"), str)
        ):
            print(
                "codemode\n" + "\n".join(f"  | {s}" for s in code.splitlines()),
                file=sys.stderr,
                flush=True,
            )
        else:
            print(
                f"{name}({json.dumps(arguments, ensure_ascii=False)[:200]})",
                file=sys.stderr,
                flush=True,
            )
    elif args.verbose and event.type in {"toolOutput", "toolResult"}:
        print(f"{event.type}: {data}", file=sys.stderr, flush=True)


async def _print_turn(session: Session, args: argparse.Namespace) -> int:
    saw_turn = False
    async for event in session.prompt_stream(args.prompt):
        saw_turn |= event.type == "turnEnded"
        _event(event, args)
    if not saw_turn:
        return 1
    result = await session.last_turn()
    if result is None or result.outcome is None:
        return 0 if result and result.disposition == "handled" else 1
    if not args.json:
        if result.outcome.kind is OutcomeKind.COMPLETED or result.text:
            print(result.text)
        if result.outcome.error:
            print(result.outcome.error, file=sys.stderr)
    return 0 if result.outcome.kind is OutcomeKind.COMPLETED else 1


async def _line(session: Session, args: argparse.Namespace) -> int:
    loop = asyncio.get_running_loop()
    active = False
    pending: dict[str, asyncio.Future[Answer]] = {}
    eof = False

    async def question(q: Question, context: QuestionContext) -> Answer:
        if eof or q.kind == "secret":
            return Answer("decline")
        reply: asyncio.Future[Answer] = loop.create_future()
        pending[q.id] = reply
        print(
            f"Question {q.id}: {q.question} {q.options}\nUse /answer REQUEST_ID VALUE",
            file=sys.stderr,
            flush=True,
        )
        try:
            return await reply
        finally:
            pending.pop(q.id, None)

    await session.on_question(question)

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
                eof = True
                for outstanding in pending.values():
                    if not outstanding.done():
                        outstanding.set_result(Answer("decline"))
                await session.wait_idle()
                await asyncio.sleep(0)
                break
            line = line.strip()
            if not line:
                continue
            if line == "/quit":
                break
            if line == "/cancel":
                await cancel()
            elif line.startswith("/answer "):
                id, _, value = line.removeprefix("/answer ").partition(" ")
                reply = pending.get(id)
                if reply is None or reply.done() or not value:
                    print("Use /answer REQUEST_ID VALUE for an open question", file=sys.stderr)
                else:
                    reply.set_result(
                        Answer("decline") if value == "decline" else Answer("value", value)
                    )
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


def _signed_in_model(paths: Paths) -> str | None:
    auth = AuthFile(paths.config / "auth.json")
    if auth.login("openai-codex"):
        return "openai-codex/gpt-6.1-sol"
    if auth.login("xai"):
        return "xai/grok-4.7"
    if claude_launch() and _claude_status().startswith("signed in"):
        return "claude/claude-sonnet-5-5"
    return None


async def _agent(
    paths: Paths,
    project: Path,
    args: argparse.Namespace,
    *,
    saved_model: str | None = None,
    history_only: bool = False,
    acp_session: bool = False,
) -> Agent:
    durability: Durability = "durable" if args.runtime == "durable" else "kept"
    url, token = (
        os.environ.get("MODULAR_AGENT_HISTORY_URL"),
        os.environ.get("MODULAR_AGENT_HISTORY_TOKEN_FILE"),
    )
    if bool(url) != bool(token):
        raise ValueError("set both MODULAR_AGENT_HISTORY_URL and MODULAR_AGENT_HISTORY_TOKEN_FILE")
    history = http_history(url, token) if url and token else file_history(paths.state / "sessions")
    if history_only:
        return await create_agent(
            project=project,
            data_dir=paths.state,
            history=history,
            durability=durability,
            local_process_groups=True,
        )
    script = os.environ.get("MODULAR_AGENT_SCRIPT")
    testing = args.acp and os.environ.get("MODULAR_AGENT_CONFORMANCE") == "1"
    settings = paths.settings(project)
    providers: list[Provider] = []
    processes = None
    configured_model = settings.pop("model", None)
    if configured_model is not None and not isinstance(configured_model, str):
        raise ValueError("model must be PROVIDER/ID")
    model = (
        None
        if args.command == "models"
        else (saved_model if acp_session else args.model)
        or args.model
        or saved_model
        or (configured_model if not args.acp or acp_session else None)
    )
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
            model = _signed_in_model(paths)
            if model is None:
                raise ValueError(
                    "no model is available. Sign in with `ma login openai-codex`, `ma login xai` or `ma login claude`, or pass --model. See `ma models`."
                )
        if acp_session and model is None:
            model = _signed_in_model(paths)
        if args.command == "models" or (model and model.startswith("claude/")):
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
    inspecting = args.command == "models" or args.declaration or args.acp

    return await create_agent(
        project=project,
        data_dir=paths.state,
        history=history,
        durability=durability,
        local_process_groups=True,
        providers=providers,
        tools=[code_tool()],
        plugins=[file_tools(paths.state / "output"), prompt_plugin(paths.config, project)],
        model=model,
        settings=settings,
        process_plugins=processes,
        plugin_host=True,
        commands=True,
        job_reports_start_turns=True,
        late_answers_start_turns=True,
        conformance=testing,
        project_mcp=None if inspecting else paths.mcp,
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
    saved_model: str | None = None
    if args.command == "sessions" or args.resume or args.session:
        async with await _agent(paths, project, args, history_only=True) as preflight:
            if args.session is None:
                sessions = await preflight.sessions()
                matching = [s for s in sessions if s["project"] == str(project)]
                if args.command == "sessions":
                    for saved_session in sessions if args.all else matching:
                        print(f"{saved_session['id']}  {saved_session['project']}")
                    return 0
                if not matching:
                    raise ValueError("this folder has no saved session to continue")
                args.session = max(
                    reversed(matching), key=lambda s: int(cast(int | str, s.get("lastActivity", 0)))
                )["id"]
            saved = await preflight.session_info(args.session)
            project = Path(cast(str, saved["project"]))
            old = cast(JsonObject, saved["settings"]).get("model")
            if isinstance(old, dict):
                saved_model = f"{old['provider']}/{old['id']}"
    async with await _agent(paths, project, args, saved_model=saved_model) as agent:
        if args.acp:

            async def compose(folder: Path) -> Agent:
                if os.environ.get("MODULAR_AGENT_CONFORMANCE") == "1":
                    return agent
                return await _agent(paths, folder, args, acp_session=True)

            async def reopen(folder: Path, id: str) -> Agent:
                saved = await agent.session_info(id)
                if saved["project"] != str(folder):
                    raise ValueError("Session is not in this project")
                if os.environ.get("MODULAR_AGENT_CONFORMANCE") == "1":
                    return agent
                old = cast(JsonObject, saved["settings"]).get("model")
                selected = f"{old['provider']}/{old['id']}" if isinstance(old, dict) else None
                return await _agent(paths, folder, args, saved_model=selected, acp_session=True)

            await agent.serve_acp(compose=compose, compose_reopen=reopen, project_mcp=paths.mcp)
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
