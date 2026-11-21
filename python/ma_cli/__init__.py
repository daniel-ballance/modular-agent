"""Vanilla composition, kept outside the Harness."""

from ma_approval import Approval
from ma_questions import Questions
from ma_jobs import Jobs
from ma_subagents import Subagents
from ma_commands import Commands
from ma_config import Config
from ma_context import Context
from ma_credentials import Credentials
from ma_guardrail import Guardrail
from ma_harness import Harness
from ma_history.http import configured_history
from ma_local import local_for_platform
from ma_prompt import Prompt
from ma_runtime import Runtime
from ma_selection import Selection
from ma_tools import Tools


async def build(
    root, provider, secrets=(), runtime=None, subagents=None, project=None, process_plugins=None
):
    import os
    from ma_fake.conformance import Echo, Nest

    providers = [provider]
    if os.environ.get("MODULAR_AGENT_CONFORMANCE") == "1":
        providers.append(Echo())
    history = configured_history(root)
    h = Harness(process_plugins=process_plugins)
    h.lazy_setup = True
    config = Config(root, project)
    try:
        for plugin in [
            history,
            config,
            Credentials(root),
            local_for_platform(root),
            Tools(),
            *([Nest()] if os.environ.get("MODULAR_AGENT_CONFORMANCE") == "1" else []),
            *providers,
            Selection([p.name for p in providers]),
            runtime or Runtime(),
            Questions(),
            Approval(),
            Jobs(),
            subagents or Subagents(),
            Prompt(),
            Context(),
            Commands(),
            Guardrail(secrets),
        ]:
            await h.load(plugin)
        from pathlib import Path

        plan = await h.api().call(
            "config",
            "plan",
            {"project": str(project or Path.cwd()), "global_only": project is None},
        )
        from ma_mcp import MCP

        await h.load(MCP(**plan["options"].get("mcp", {})))
        for spec in plan["plugins"]:
            spec["options"] = {
                **spec.get("options", {}),
                **plan["options"].get(spec["factory"], {}),
            }
            await h.load_named(spec)
        if os.environ.get("MODULAR_AGENT_PLUGINS"):
            import json
            from ma_plugin.host import load_plugins

            specs = json.loads(os.environ["MODULAR_AGENT_PLUGINS"])
            if not isinstance(specs, list):
                raise ValueError("MODULAR_AGENT_PLUGINS must be an array")
            await load_plugins(h, specs, project or Path.cwd(), root)
    except BaseException:
        await h.stop()
        raise
    return h


async def cli(args):
    import signal
    from ma_claude import Claude
    from ma_core import AgentError
    from ma_fake import Fake
    from ma_terminal import Terminal

    import os

    if (
        args.mode == "acp"
        and os.environ.get("MODULAR_AGENT_CONFORMANCE") == "1"
        and not args.fake_script
        and (args.acp or os.environ.get("MODULAR_AGENT_CONFORMANCE_POLICY"))
    ):
        from .acp_fixture import serve

        return await serve(args)
    if args.listen is not None or args.token_file is not None:
        raise ValueError("This base build serves WebSocket only in ACP conformance mode")
    if args.project is None:
        from pathlib import Path

        args.project = Path.cwd()
        if args.session:
            # Select the saved project's composition before importing its plugins.
            directory = Harness()
            try:
                await directory.load(configured_history(args.home))
                sessions = await directory.api().session("list")
                match = next((s for s in sessions if s["id"] == args.session), None)
                if match:
                    args.project = Path(match["project"])
            finally:
                await directory.stop()
    provider = (
        Fake(__import__("json").loads(args.fake_script.read_text()))
        if args.fake_script
        else Claude()
    )
    actor = os.environ.get("MODULAR_AGENT_ACTOR", "user")
    if args.mode == "acp" and (not actor or any(0xD800 <= ord(c) <= 0xDFFF for c in actor)):
        raise SystemExit("MODULAR_AGENT_ACTOR must be a nonempty Unicode Id")

    from ma_durable import Durable

    from ma_durable_subagents import DurableSubagents

    if args.trust_project or args.untrust_project:
        Config(args.home).set_trust(args.project, not args.untrust_project)
    h = await build(
        args.home,
        provider,
        runtime=Durable() if args.runtime == "durable" else Runtime(),
        subagents=DurableSubagents() if args.subagents == "durable" else Subagents(),
        project=args.project,
        process_plugins=args.process_plugins,
    )
    if args.mode == "acp":
        from ma_acp import ACP

        settings = {"model": "fake"} if args.fake_script else {}
        if args.model:
            settings["model"] = args.model
        interface = ACP(args.project, settings, actor=actor)
        try:
            await h.load(interface)
            await h.plugins["acp"].serve()
            return 0
        finally:
            await h.stop()
    terminal = Terminal(
        args.mode if args.mode == "json" else "print" if args.prompt is not None else "line"
    )
    try:
        await h.load(terminal)
        loop = __import__("asyncio").get_running_loop()

        async def cancel():
            from ma_process import ProcessPlugin

            loaded = h.plugins["terminal"]
            sid = (
                await loaded.inspect("session_id")
                if isinstance(loaded, ProcessPlugin)
                else loaded.session_id
            )
            if sid:
                await h.api().call("runtime", "cancel", {"session": sid})

        loop.add_signal_handler(signal.SIGINT, lambda: loop.create_task(cancel()))
        settings = {"model": "fake"} if args.fake_script else {}
        if args.model:
            settings["model"] = args.model
        result = await h.api().call(
            "terminal",
            "run",
            {
                "project": str(args.project),
                "session": args.session,
                "settings": settings,
                "prompt": args.prompt,
                "list": args.list,
            },
        )
        return result["exit_code"]
    except AgentError as exc:
        await h.plugins["terminal"].show({"error": str(exc)})
        return 1
    finally:
        await h.stop()


def main():
    import argparse
    import asyncio
    import os
    from pathlib import Path

    parser = argparse.ArgumentParser(description="Modular Agent, vanilla milestone")
    parser.add_argument(
        "--project",
        type=Path,
        help="Project folder; defaults to saved session project or current directory",
    )
    parser.add_argument("--home", type=Path, default=Path.home() / ".local/state/modular-agent-py")
    parser.add_argument("--session")
    trust = parser.add_mutually_exclusive_group()
    trust.add_argument(
        "--trust-project",
        action="store_true",
        help="Trust this project's executable plugin settings",
    )
    trust.add_argument(
        "--untrust-project", action="store_true", help="Revoke this project's plugin trust"
    )
    parser.add_argument("--runtime", choices=["transient", "durable"], default="transient")
    parser.add_argument("--subagents", choices=["transient", "durable"], default="transient")
    parser.add_argument(
        "--process-plugins",
        default=None,
        help="Comma-separated plugin names or roles, or all; default MA_PLUGIN_PROCESSES",
    )
    parser.add_argument("--model")
    parser.add_argument("-p", "--print", dest="prompt")
    parser.add_argument("--mode", choices=["line", "json", "acp"], default="line")
    parser.add_argument("--acp", action="store_true")
    parser.add_argument("--listen")
    parser.add_argument("--token-file", type=Path)
    parser.add_argument("--list", choices=["project", "all"])
    parser.add_argument("--fake-script", type=Path, help="Offline scripted Provider JSON file")
    args = parser.parse_args()
    if args.acp:
        args.mode = "acp"
    if os.environ.get("MODULAR_AGENT_DATA_DIR"):
        args.home = Path(os.environ["MODULAR_AGENT_DATA_DIR"])
    if args.mode == "acp" and (args.prompt is not None or args.session or args.list):
        parser.error("ACP session and prompt operations must come through the ACP client")
    raise SystemExit(asyncio.run(cli(args)))
