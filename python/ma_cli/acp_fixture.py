"""ACP conformance launcher for the base build, without ma's standard parts."""

import asyncio
import os
import signal
from pathlib import Path

from modular_agent import ACP_RIGHTS, AcpPolicy, create_agent, file_history, http_history
from modular_agent.files import file_tools


async def serve(args):
    filename = os.environ.get("MODULAR_AGENT_CONFORMANCE_POLICY")
    policy = AcpPolicy(
        Path(filename) if filename else args.home / "policy.json",
        required=bool(filename),
        several_actors=True,
    )
    url = os.environ.get("MODULAR_AGENT_HISTORY_URL")
    token = os.environ.get("MODULAR_AGENT_HISTORY_TOKEN_FILE")
    if bool(url) != bool(token):
        raise ValueError("Set both MODULAR_AGENT_HISTORY_URL and MODULAR_AGENT_HISTORY_TOKEN_FILE")
    history = (
        http_history(
            url,
            token,
        )
        if url and token
        else file_history(args.home / "sessions")
    )
    project = (args.project or Path.cwd()).resolve(strict=True)

    async def compose(folder):
        return await create_agent(
            project=folder,
            data_dir=args.home,
            history=history,
            durability="durable" if args.runtime == "durable" else "kept",
            model=args.model or "conformance/echo",
            settings={"thinking": "off"},
            local_process_groups=True,
            plugins=[file_tools(args.home / "output")],
            job_reports_start_turns=True,
            several_actors=True,
            session_limits=True,
            tenants=policy.tenants,
            resource_reservations=policy.limits,
            commands=True,
            plugin_host=True,
            conformance=True,
        )

    async with await compose(project) as agent:

        async def select(folder):
            return agent if folder == project else await compose(folder)

        async def reopen(folder, session_id):
            return await select(folder)

        if args.listen is None:
            await agent.serve_acp(compose=select, compose_reopen=reopen, **(policy.stdio or {}))
            return 0
        if (args.token_file is None) == (policy.actors is None):
            raise ValueError(f"policy {policy.path}: use either actors or --token-file")
        listener = await agent.serve_acp(
            listen=args.listen,
            actors=policy.actors
            or [
                {
                    "token_file": args.token_file,
                    "actor": {"id": "user", "kind": "host", "rights": list(ACP_RIGHTS)},
                }
            ],
            compose=select,
            compose_reopen=reopen,
        )
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        loop.add_signal_handler(signal.SIGTERM, stop.set)
        try:
            await stop.wait()
        finally:
            loop.remove_signal_handler(signal.SIGTERM)
            await listener.close()
    return 0
