"""Run the repository's shared SDK scenarios (python -m modular_agent._scenarios)."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import signal
import sys
from collections.abc import Iterator, Sequence
from contextlib import nullcontext
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from . import (
    Agent,
    AgentError,
    JsonObject,
    Plugin,
    ProcessPlugin,
    PromptResult,
    ServicePlugin,
    Session,
)
from ._event_types import EntryEvent
from ._history import HistoryStore, file_history, http_history
from ._scenario_telemetry import TelemetryRun, exporter
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
    services = []
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
            services.append(("service:" + sdk, command))
    if missing:
        raise RuntimeError(f"No fixture registry entry for {', '.join(sorted(missing))}")
    yield from services


def _config(name: str, directory: Path) -> JsonObject:
    return {"path": str(directory / "count")} if name == "counter" else {}


class _Services:
    def __init__(
        self, command: list[str], directory: Path, *, separate_groups: bool = True
    ) -> None:
        self.separate_groups = separate_groups
        self.command = command
        self.directory = directory
        self.children: list[asyncio.subprocess.Process] = []

    async def start(self, fixtures: list[str]) -> list[ServicePlugin]:
        assert not self.children
        token = self.directory / "token"
        if not token.exists():
            with os.fdopen(os.open(token, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as f:
                f.write(secrets.token_hex(32))
        specs: list[ServicePlugin] = []
        for name in fixtures:
            proc = await asyncio.create_subprocess_exec(
                *self.command,
                name,
                "--listen",
                "127.0.0.1:0",
                "--token-file",
                str(token),
                cwd=self.directory,
                env={
                    k: os.environ[k]
                    for k in ("PATH", "LANG", "LC_ALL", "TZ", "TMPDIR")
                    if k in os.environ
                },
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                start_new_session=self.separate_groups,
            )
            self.children.append(proc)
            assert proc.stdout is not None
            line = (await proc.stdout.readline()).decode().strip()
            if not line.startswith("ws://"):
                raise RuntimeError(f"Fixture {name} did not announce a WebSocket URL: {line!r}")
            specs.append(
                {"url": line, "token_file": str(token), "config": _config(name, self.directory)}
            )
        return specs

    async def stop(self, other: asyncio.subprocess.Process | None = None) -> None:
        processes = [*self.children, *([other] if other else [])]
        self.children.clear()
        await _kill_groups(processes)


def _history_service(directory: Path, token: Path) -> None:
    from ma_history.service import serve

    serve(
        directory,
        ("127.0.0.1", 0),
        token,
        2500,
        ready=lambda address: print(f"http://127.0.0.1:{address[1]}", flush=True),
    )


async def _agent(
    scenario: dict[str, Any],
    directory: Path,
    command: list[str],
    services: list[ServicePlugin] | None = None,
    history: HistoryStore | None = None,
    telemetry: TelemetryRun | None = None,
    *,
    controls: Sequence[Plugin] = (),
    agent_name: str | None = None,
) -> Agent:
    options = scenario["agent"]
    project = directory / "project"
    project.mkdir(exist_ok=True)
    plugins, processes = [], []
    for name in options.get("plugins", []) if services is None else []:
        config = _config(name, directory)
        if telemetry and telemetry.process:
            processes.append(telemetry.fixture(name, config))
        elif command:
            processes.append(ProcessPlugin([*command, name], config=config))
        else:
            choice = telemetry.request["values"]["answer"] if telemetry else "yes"
            plugins.append(fixture(name, config=config, choice=choice))
    return await test_agent(
        script=scenario["model"],
        project=project,
        data_dir=directory / "data",
        durability=options.get("durability", "ephemeral"),
        history=history,
        approval=options.get("approval"),
        settings=options.get("settings"),
        several_actors=options.get("severalActors", False),
        plugins=[*plugins, *controls],
        max_approval_wait=options["maxApprovalWaitMs"] / 1000
        if "maxApprovalWaitMs" in options
        else None,
        approval_covers_nested=options.get("approvalCoversNested", False),
        late_answers_start_turns=options.get("lateAnswersStartTurns", False),
        agent_name=telemetry.request["agentName"] if telemetry else agent_name,
        process_plugins=processes or None,
        service_plugins=services,
        on_question=answers(options["answers"]) if "answers" in options else None,
    )


async def _crash_child(
    path: Path,
    directory: Path,
    index: int,
    command: list[str],
    services: list[ServicePlugin] | None,
    history_url: str,
    telemetry: TelemetryRun | None = None,
) -> None:
    scenario = _load(path)
    store = (
        file_history(directory / "history")
        if scenario["agent"].get("history") == "file"
        else http_history(history_url, directory / "history.token")
        if history_url
        else None
    )
    async with await _agent(scenario, directory, command, services, store, telemetry) as agent:
        session = await agent.session(actors=scenario["agent"].get("actors", []))
        print(session.id, flush=True)
        async for event in session.prompt_stream(scenario["steps"][index]["prompt"]):
            if isinstance(event, EntryEvent):
                print(event.data.fields["entry"]["kind"], flush=True)


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


async def _kill_groups(processes: list[asyncio.subprocess.Process]) -> None:
    for proc in processes:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    await asyncio.gather(*(proc.wait() for proc in processes))
    async with asyncio.timeout(5):
        while any(_live_group(proc.pid) for proc in processes):
            await asyncio.sleep(0.01)


async def _crash(
    path: Path,
    directory: Path,
    index: int,
    condition: dict[str, Any],
    command: list[str],
    services: list[ServicePlugin] | None,
    pool: _Services | None,
    history_url: str,
    telemetry: TelemetryRun | None = None,
) -> str:
    env = None
    if telemetry:
        env = {**os.environ, "MODULAR_AGENT_TELEMETRY_RUN": str(telemetry.path)}
        if telemetry.endpoint is not None:
            env["MODULAR_AGENT_TELEMETRY_OTLP"] = telemetry.endpoint
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "modular_agent._scenarios",
        "--child",
        str(path),
        str(directory),
        str(index),
        json.dumps(services),
        history_url,
        *command,
        env=env,
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
        if telemetry:
            telemetry.at_barrier(sid, count(directory / "count"))
        return sid
    finally:
        if pool is not None:
            await pool.stop(proc)
        else:
            await _kill_groups([proc])


async def run_scenario(
    path: Path, placement: str, command: list[str], *, telemetry: TelemetryRun | None = None
) -> list[str]:
    scenario = _load(path)
    failures: list[str] = []
    agent: Agent | None = None
    session: Session | None = None
    session_id: str | None = None
    report: dict[str, Any] | None = None
    scratch = (
        nullcontext(str(telemetry.directory))
        if telemetry
        else TemporaryDirectory(prefix="sdk-scenario-")
    )
    with scratch as temp:
        directory = Path(temp)
        # Use the scenario name because the telemetry kit copies the fixture.
        # The waiting driver owns the clock and batch observer across writer stops.
        if scenario["scenario"].startswith("waiting-approval"):
            kit = Path(__file__).resolve().parents[2] / "conformance/sdk/waiting.mjs"
            env = (
                {**os.environ, "MODULAR_AGENT_TELEMETRY_RUN": str(telemetry.path)}
                if telemetry
                else None
            )
            proc = await asyncio.create_subprocess_exec(
                "node",
                Path(__file__).resolve().parents[1] / "scripts/waiting-scenario.mjs",
                sys.executable,
                kit,
                directory,
                path,
                placement,
                *command,
                env=env,
            )
            return (
                []
                if await proc.wait() == 0
                else [f"{path.stem} ({placement}): waiting scenario failed"]
            )
        pool = _Services(command, directory) if placement.startswith("service:") else None
        process_command = command if pool is None else []
        service: asyncio.subprocess.Process | None = None
        store: HistoryStore | None = None
        history_url = ""

        async def start_services() -> list[ServicePlugin] | None:
            if pool is None:
                return None
            return await pool.start(scenario["agent"].get("plugins", []))

        async def start_agent() -> Agent:
            return await _agent(
                scenario, directory, process_command, await start_services(), store, telemetry
            )

        try:
            try:
                match scenario["agent"].get("history"):
                    case "file":
                        store = file_history(directory / "history")
                    case "service":
                        token = directory / "history.token"
                        with os.fdopen(
                            os.open(token, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"
                        ) as f:
                            f.write(secrets.token_hex(32))
                        service = await asyncio.create_subprocess_exec(
                            sys.executable,
                            "-m",
                            "modular_agent._scenarios",
                            "--history-service",
                            str(directory / "history"),
                            str(token),
                            stdout=asyncio.subprocess.PIPE,
                            start_new_session=True,
                        )
                        assert service.stdout is not None
                        async with asyncio.timeout(10):
                            url = (await service.stdout.readline()).decode().strip()
                        if not url.startswith("http://127.0.0.1:"):
                            raise RuntimeError("History fixture did not announce a loopback URL")
                        history_url = url
                        store = http_history(url, token)
                    case None:
                        pass
                    case value:
                        raise ValueError(f"Unknown scenario history: {value}")
                if "expectCreateError" in scenario:
                    services = await start_services()
            except Exception as exc:
                return [f"{scenario['scenario']} ({placement}) setup: {type(exc).__name__}: {exc}"]

            if want := scenario.get("expectCreateError"):
                label = f"{scenario['scenario']} ({placement}) createAgent"
                try:
                    agent = await _agent(scenario, directory, process_command, services, store)
                except AgentError as exc:
                    if want["code"] != exc.code or want["messageContains"] not in exc.message:
                        failures.append(f"{label}: want {want!r}, got {exc.code}: {exc.message}")
                except Exception as exc:
                    failures.append(f"{label}: want {want!r}, got {type(exc).__name__}: {exc}")
                else:
                    failures.append(f"{label}: want {want!r}, got success")
                return failures

            last_result: PromptResult | None = None
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
                                path,
                                directory,
                                n,
                                step["crashWhen"],
                                process_command,
                                await start_services(),
                                pool,
                                history_url,
                                telemetry,
                            )
                        elif any(field in step for field in ("prompt", "send", "answer", "wait")):
                            if agent is None:
                                agent = await start_agent()
                                session = await agent.session(
                                    actors=scenario["agent"].get("actors", [])
                                )
                                session_id = session.id
                            assert session is not None
                            acting = session.as_actor(step["as"]) if "as" in step else session
                            if "prompt" in step:
                                result = await acting.prompt(step["prompt"])
                            elif "send" in step:
                                await acting.send(step["send"], step.get("timing", "now"))
                            elif "answer" in step:
                                try:
                                    async with asyncio.timeout(10):
                                        while len(open_questions := await acting.questions()) != 1:
                                            await asyncio.sleep(0.005)
                                except TimeoutError:
                                    compare(
                                        "open questions count", 1, len(await acting.questions())
                                    )
                                    break
                                await acting.answer(open_questions[0].id, step["answer"])
                            else:
                                await acting.wait_idle()
                                result = await acting.last_turn()
                        elif step.get("reopen"):
                            if agent is not None:
                                await agent.close()
                                if pool is not None:
                                    await pool.stop()
                            if session_id is None:
                                raise RuntimeError("No session to reopen")
                            agent = await start_agent()
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

                if result is not None:
                    last_result = result
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
            if telemetry and not failures:
                assert agent is not None and session is not None and last_result is not None
                report = await telemetry.evidence(
                    agent, session, last_result, count(directory / "count")
                )
        finally:
            try:
                if agent is not None:
                    await agent.close()
            finally:
                try:
                    if pool is not None:
                        await pool.stop()
                finally:
                    if service is not None:
                        await _kill_groups([service])
    if telemetry and report is not None:
        if any(proc.returncode != 0 for proc in telemetry.fixtures):
            return ["A telemetry fixture did not exit successfully"]
        Path(telemetry.request["reportPath"]).write_text(json.dumps(report))
    return failures


async def _main(files: list[str]) -> int:
    repo = Path(__file__).resolve().parents[2]
    paths = [Path(f).resolve() for f in files]
    if not paths:
        sdk = repo / "conformance/sdk"
        paths = sorted((sdk / "scenarios").glob("*.json"))
        waiting = sdk / "fixtures/waiting-approval"
        names = json.loads((sdk / "waiting-scenarios.json").read_text())
        if (
            not paths
            or not names
            or sorted(names) != sorted(p.stem for p in waiting.glob("*.json"))
        ):
            raise ValueError(
                "SDK scenarios are missing or differ from the waiting fixture manifest"
            )
        paths.extend(waiting / f"{name}.json" for name in names)
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


async def _telemetry_main(telemetry: TelemetryRun) -> int:
    failures = await run_scenario(
        Path(telemetry.request["scenarioPath"]),
        telemetry.request["placement"],
        [],
        telemetry=telemetry,
    )
    if failures:
        print("\n".join(failures), file=sys.stderr)
    return int(bool(failures))


if __name__ == "__main__":
    request_path = os.environ.get("MODULAR_AGENT_TELEMETRY_RUN")
    telemetry_run = (
        TelemetryRun(Path(request_path), _load(Path(request_path))) if request_path else None
    )
    if len(sys.argv) > 1 and sys.argv[1] == "--history-service":
        _history_service(Path(sys.argv[2]), Path(sys.argv[3]))
    elif len(sys.argv) > 1 and sys.argv[1] == "--child":
        with (
            exporter(telemetry_run.endpoint if telemetry_run else None),
            telemetry_run.observe(crash_child=True) if telemetry_run else nullcontext(),
        ):
            asyncio.run(
                _crash_child(
                    Path(sys.argv[2]),
                    Path(sys.argv[3]),
                    int(sys.argv[4]),
                    sys.argv[7:],
                    json.loads(sys.argv[5]),
                    sys.argv[6],
                    telemetry_run,
                )
            )
    elif telemetry_run:
        with exporter(telemetry_run.endpoint), telemetry_run.observe():
            raise SystemExit(asyncio.run(_telemetry_main(telemetry_run)))
    else:
        raise SystemExit(asyncio.run(_main(sys.argv[1:])))
