"""Run the repository's shared SDK scenarios (python -m modular_agent._scenarios)."""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
from collections.abc import Iterator
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from . import Agent, AgentError, JsonObject, ProcessPlugin, PromptResult, Session
from .fixtures import count, fixture
from .testing import answers, test_agent


def _load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"Expected an object in {path}")
    return value


def placements(repo: Path) -> Iterator[tuple[str, list[str]]]:
    yield "inProcess", []
    required = set(os.environ.get("MODULAR_AGENT_SDK_REQUIRE", "").replace(",", " ").split())
    missing = required - {"all", "inProcess"}
    for file in sorted((repo / "conformance/sdk/fixtures").glob("*.json")):
        config = _load(file)
        sdk = config["sdk"]
        command = [arg.replace("{repo}", str(repo)) for arg in config["command"]]
        paths = [
            p
            for arg, p in zip(config["command"], command, strict=True)
            if arg.startswith("{repo}") and not Path(p).exists()
        ]
        missing.discard(sdk)
        if paths:
            message = f"process:{sdk} not built ({', '.join(paths)}); build with: {config['build']}"
            if sdk in required or "all" in required:
                raise RuntimeError(message)
            print(f"Skip {message}", file=sys.stderr)
        else:
            yield "process:" + sdk, command
    if missing:
        raise RuntimeError(f"No fixture registry entry for {', '.join(sorted(missing))}")


async def _agent(scenario: dict[str, Any], directory: Path, command: list[str]) -> Agent:
    options = scenario["agent"]
    project = directory / "project"
    project.mkdir(exist_ok=True)
    plugins, processes = [], []
    for name in options.get("plugins", []):
        config: JsonObject = {"path": str(directory / "count")} if name == "counter" else {}
        if command:
            processes.append(ProcessPlugin([*command, name], config=config))
        else:
            plugins.append(fixture(name, config=config))
    return await test_agent(
        script=scenario["model"],
        project=project,
        data_dir=directory / "data",
        durability=options.get("durability", "ephemeral"),
        approval=options.get("approval"),
        settings=options.get("settings"),
        plugins=plugins,
        process_plugins=processes if command else None,
        on_question=answers(options["answers"]) if "answers" in options else None,
    )


async def _crash_child(path: Path, directory: Path, index: int, command: list[str]) -> None:
    scenario = _load(path)
    async with await _agent(scenario, directory, command) as agent:
        session = await agent.session()
        print(session.id, flush=True)
        async for event in session.prompt_stream(scenario["steps"][index]["prompt"]):
            if event.type == "entry":
                entry = event.data.fields["entry"]
                if isinstance(entry, dict):
                    print(entry["kind"], flush=True)


def _live_group(pgid: int) -> bool:
    if sys.platform == "linux":
        # An orphan zombie cannot race recovery; a container's PID 1 may never reap it.
        for path in Path("/proc").glob("[0-9]*/stat"):
            try:
                state, _, group, *_ = path.read_text().rsplit(")", 1)[1].split()
            except (OSError, ValueError):
                continue
            if group == str(pgid) and state not in {"Z", "X"}:
                return True
        return False
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    return True


async def _crash(
    path: Path, directory: Path, index: int, condition: dict[str, Any], command: list[str]
) -> str:
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "modular_agent._scenarios",
        "--child",
        str(path),
        str(directory),
        str(index),
        *command,
        stdout=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    assert proc.stdout is not None
    try:
        async with asyncio.timeout(15):
            sid = (await proc.stdout.readline()).decode().strip()
            if not sid:
                raise RuntimeError("Crash child did not create a session")
            if "count" in condition:
                while count(directory / "count") < condition["count"]:
                    if proc.returncode is not None:
                        raise RuntimeError("Crash child exited before reaching the count")
                    await asyncio.sleep(0.005)
            elif "record" in condition:
                while (line := await proc.stdout.readline()).decode().strip() != condition[
                    "record"
                ]:
                    if not line:
                        raise RuntimeError("Crash child exited before committing the record")
            else:
                raise ValueError(f"Unknown crash condition: {condition}")
        if proc.returncode is not None:
            raise RuntimeError("Crash child exited before it could be killed")
        return sid
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await proc.wait()
        async with asyncio.timeout(5):
            while _live_group(proc.pid):
                await asyncio.sleep(0.01)


async def run_scenario(path: Path, placement: str, command: list[str]) -> list[str]:
    scenario = _load(path)
    failures: list[str] = []
    agent: Agent | None = None
    session: Session | None = None
    session_id: str | None = None
    with TemporaryDirectory(prefix="sdk-scenario-") as temp:
        directory = Path(temp)
        try:
            for n, step in enumerate(scenario["steps"]):
                label = f"{scenario['scenario']} ({placement}) step {n}"
                expect = step.get("expect", {})
                result: PromptResult | None = None

                def compare(field: str, want: Any, got: Any) -> None:
                    if want != got:
                        failures.append(f"{label}: {field}: want {want!r}, got {got!r}")

                try:
                    async with asyncio.timeout(25):
                        if "crashWhen" in step:
                            if agent is not None:
                                raise RuntimeError(
                                    "Crash step must own the session from its first prompt"
                                )
                            session_id = await _crash(
                                path, directory, n, step["crashWhen"], command
                            )
                        elif "prompt" in step:
                            if agent is None:
                                agent = await _agent(scenario, directory, command)
                                session = await agent.session()
                                session_id = session.id
                            assert session is not None
                            result = await session.prompt(step["prompt"])
                        elif step.get("reopen"):
                            if agent is not None:
                                await agent.close()
                            if session_id is None:
                                raise RuntimeError("No session to reopen")
                            agent = await _agent(scenario, directory, command)
                            session = await agent.open_session(session_id)
                            result = await session.last_turn()
                        else:
                            raise ValueError("Unknown scenario step")
                except Exception as exc:
                    got = (
                        exc.code.value
                        if isinstance(exc, AgentError)
                        else f"{type(exc).__name__}: {exc}"
                    )
                    compare("error", expect.get("error", "no error"), got)
                    if "error" not in expect:
                        break
                    continue

                if "error" in expect:
                    compare("error", expect["error"], "no error")
                if "outcome" in expect:
                    compare(
                        "outcome",
                        expect["outcome"],
                        result.outcome.kind.value if result and result.outcome else None,
                    )
                if "text" in expect:
                    compare("text", expect["text"], result.text if result else None)
                if "toolResults" in expect:
                    want = expect["toolResults"]
                    results = result.tool_results() if result else ()
                    compare("toolResults count", len(want), len(results))
                    for i, (w, g) in enumerate(zip(want, results)):
                        compare(f"toolResults[{i}].name", w["name"], g.name)
                        compare(f"toolResults[{i}].status", w["status"], g.status.value)
                        if "text" in w:
                            compare(f"toolResults[{i}].text", w["text"], g.text())
                        if "contains" in w and w["contains"] not in g.text():
                            compare(f"toolResults[{i}].contains", w["contains"], g.text())
                if "records" in expect:
                    kinds = [e["kind"] for e in await session.history()] if session else []
                    remaining = iter(kinds)
                    if not all(
                        any(kind == record for kind in remaining) for record in expect["records"]
                    ):
                        compare("records (in order)", expect["records"], kinds)
                if "count" in expect:
                    compare("count", expect["count"], count(directory / "count"))
        finally:
            if agent is not None:
                await agent.close()
    return failures


async def _main(files: list[str]) -> int:
    repo = Path(__file__).resolve().parents[2]
    paths = [Path(f).resolve() for f in files] or sorted(
        (repo / "conformance/sdk/scenarios").glob("*.json")
    )
    success, failure = 0, 0
    for placement, command in placements(repo):
        for path in paths:
            if placement not in _load(path).get("placements", [placement]):
                continue
            errors = await run_scenario(path, placement, command)
            if errors:
                failure += 1
                print("\n".join(errors), file=sys.stderr)
            else:
                print(f"PASS {path.stem} ({placement})")
                success += 1
    print(f"{success} passed; {failure} failed")
    return int(bool(failure))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--child":
        asyncio.run(
            _crash_child(Path(sys.argv[2]), Path(sys.argv[3]), int(sys.argv[4]), sys.argv[5:])
        )
    else:
        raise SystemExit(asyncio.run(_main(sys.argv[1:])))
