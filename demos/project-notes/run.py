#!/usr/bin/env python3
"""Start the four parts, check one turn per case, and clean up their processes."""

import argparse
import json
import os
import secrets
import signal
import subprocess
import sys
import time
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory, gettempdir
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

DEMO = Path(__file__).resolve().parent
REPO = DEMO.parent.parent
NOTE = "The ferry leaves at 14:02."
SEED = "Bring a raincoat.\n"
ANSWER = f"Found: {NOTE}"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


HTTP = build_opener(ProxyHandler({}), NoRedirect())


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def await_value(process, ready, description):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        running = process.poll() is None
        if value := ready():
            return value
        require(running, f"process exited before {description}")
        time.sleep(0.02)
    raise RuntimeError(f"timed out waiting for {description}")


def stop(process, sig):
    # A group includes the agent's stdio plugin, even if the agent has exited.
    try:
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        pass


def group_running(group):
    for stat in Path("/proc").glob("[0-9]*/stat"):
        try:
            # After the command name come state, parent PID and process group.
            state, _, pgid, *_ = stat.read_bytes().rsplit(b")", 1)[1].split()
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        if int(pgid) == group and state not in {b"Z", b"X"}:
            return True
    return False


def wait_group(group):
    deadline = time.monotonic() + 5
    while group_running(group):
        require(time.monotonic() < deadline, f"process group {group} did not stop")
        time.sleep(0.02)


def cleanup(process):
    if process.returncode is None:
        stop(process, signal.SIGTERM)
    try:
        process.wait(timeout=5)
    finally:
        if process.returncode is None or group_running(process.pid):
            stop(process, signal.SIGKILL)
        process.wait()
        wait_group(process.pid)


def start(stack, root, name, argv, env, *, live=False):
    output = root / f"{name}.out"
    error = root / f"{name}.err"
    with output.open("wb") as stdout, error.open("wb") as stderr:
        process = subprocess.Popen(
            argv,
            env=env,
            cwd=root,
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=subprocess.DEVNULL if live else stderr,
            start_new_session=True,
        )
    stack.callback(cleanup, process)
    return process, output


def first_line(process, path):
    def complete_line():
        line, newline, _ = path.read_text().partition("\n")
        return line if newline else None

    return await_value(process, complete_line, path.name)


def token_file(root, name):
    path = root / f"{name}.token"
    path.write_text(secrets.token_hex(32) + "\n")
    return path


def read_history(url, token, session_id):
    endpoint = urlsplit(url)
    require(
        endpoint.scheme == "http"
        and endpoint.hostname == "127.0.0.1"
        and endpoint.username is None,
        "expected a loopback history service",
    )
    path = f"/v1/sessions/{quote(session_id, safe='')}"
    request = Request(
        url + path, headers={"Authorization": f"Bearer {token.read_text().strip()}"}
    )
    with HTTP.open(request, timeout=5) as response:
        page = json.load(response)
    require("next" not in page, "the demo transcript must fit one history page")
    require(page["session"]["id"] == session_id, "history returned a different session")
    return page["entries"]


def records(entries, kind):
    return [entry for entry in entries if entry["kind"] == kind]


def verify(entries, turn, crash, live):
    tools = turn["tools"]
    require(turn["outcome"] == "completed", "turn did not complete")
    require(
        [tool["name"] for tool in tools] == ["add_note", "search_notes"],
        "unexpected tool call order",
    )
    require(
        tools[0]["status"] == ("outcomeUnknown" if crash else "completed"),
        "wrong write settlement",
    )
    require(
        tools[1] == {"name": "search_notes", "status": "completed", "text": NOTE},
        "search returned the wrong line",
    )
    if not crash:
        require(tools[0]["text"] == f"Added: {NOTE}", "the write result did not match")
    require(
        NOTE in turn["text"] if live else turn["text"] == ANSWER,
        "unexpected final answer",
    )

    starts = records(entries, "toolStarted")
    results = records(entries, "toolResult")
    ended = records(entries, "turnEnd")
    require(
        len(records(entries, "input")) == 1 and len(records(entries, "turnStart")) == 1,
        "more than one input or turn in the transcript",
    )
    require(
        [entry["data"]["call"]["name"] for entry in starts]
        == ["add_note", "search_notes"],
        "history does not show exactly one dispatch per tool",
    )
    require(
        len(results) == 2
        and all(
            result["toolCallId"] == start["toolCallId"]
            and result["data"]["status"] == tool["status"]
            for start, result, tool in zip(starts, results, tools)
        ),
        "history settlements do not match the reported tool calls",
    )
    require(
        len(ended) == 1
        and ended[0]["turnId"] == turn["turnId"]
        and ended[0]["data"]["outcome"]["kind"] == "completed"
        and ended[0]["data"]["result"]["text"] == turn["text"],
        "history does not contain the reported completion",
    )


def run_case(root, *, crash=False, model="scripted/script"):
    live = model != "scripted/script"
    project = root / "project"
    project.mkdir()
    notes = project / "notes.txt"
    notes.write_text(SEED)
    expected = SEED + NOTE + "\n"
    history_token = token_file(root, "history")
    environment_token = token_file(root, "environment")
    # No ambient plugin or history configuration, and no keys in the services.
    home = root / "home"
    home.mkdir()
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(home),
        "TMPDIR": os.environ["TMPDIR"],
    }

    try:
        with ExitStack() as stack:
            history, history_output = start(
                stack,
                root,
                "history",
                [
                    REPO / "rust/target/debug/project-notes-history",
                    root / "history",
                    history_token,
                ],
                env,
            )
            history_url = first_line(history, history_output)
            environment, environment_output = start(
                stack,
                root,
                "environment",
                [
                    "node",
                    DEMO / "environment/dist/service.js",
                    project,
                    environment_token,
                ],
                env,
            )
            environment_url = first_line(environment, environment_output)

            command = [
                "node",
                DEMO / "agent/dist/main.js",
                "--project",
                project,
                "--history",
                history_url,
                "--history-token",
                history_token,
                "--environment",
                environment_url,
                "--environment-token",
                environment_token,
                "--tools",
                REPO / "rust/target/debug/project-notes-tools",
                "--model",
                model,
            ]
            args = ["--pause-after-write"] if crash else []
            agent_env = env.copy()
            if model.startswith("openai/"):
                agent_env["OPENAI_API_KEY"] = os.environ["OPENAI_API_KEY"]
            elif model.startswith("claude/"):
                args += [
                    "--claude-sidecar",
                    REPO / "typescript/packages/claude/dist/src/main.js",
                ]
                agent_env["HOME"] = str(Path.home())
                if config := os.environ.get("CLAUDE_CONFIG_DIR"):
                    agent_env["CLAUDE_CONFIG_DIR"] = config
            agent, output = start(
                stack,
                root,
                "agent",
                [*command, "--data", root / "agent-data", *args],
                agent_env,
                live=live,
            )
            session_id = first_line(agent, output)
            if crash:
                await_value(agent, lambda: notes.read_text() == expected, "note write")
                before = read_history(history_url, history_token, session_id)
                starts = records(before, "toolStarted")
                require(
                    len(starts) == 1
                    and starts[0]["data"]["call"]["name"] == "add_note"
                    and not records(before, "toolResult")
                    and not records(before, "turnEnd"),
                    "the crash barrier must be after the write and before its result",
                )
                stop(agent, signal.SIGKILL)
                require(
                    agent.wait(timeout=5) == -signal.SIGKILL, "agent was not killed"
                )
                wait_group(agent.pid)
                # Use an empty local directory. The new agent only has the session ID and the service.
                agent, output = start(
                    stack,
                    root,
                    "reopened",
                    [
                        *command,
                        "--data",
                        root / "reopened-data",
                        "--reopen",
                        session_id,
                    ],
                    env,
                )

            require(
                agent.wait(timeout=180 if live else 15) == 0,
                "agent exited with an error",
            )
            sid, result = output.read_text().splitlines()
            require(sid == session_id, "reopen returned a different session ID")
            turn = json.loads(result)
            require(
                notes.read_text() == expected,
                "the note was missing, changed, or written twice",
            )
            entries = read_history(history_url, history_token, session_id)
            if crash:
                require(
                    entries[: len(before)] == before,
                    "recovery changed the committed history prefix",
                )
            verify(entries, turn, crash, live)
    except Exception:
        # Vendor errors are not a transcript. Do not echo stderr on a live run.
        if not live:
            for log in sorted(root.glob("*.err")):
                if detail := log.read_text(errors="replace")[-4000:].strip():
                    print(f"{log.stem}: {detail}", file=sys.stderr)
        raise

    case = "crash and reopen" if crash else "live" if live else "scripted"
    statuses = ", ".join(f"{tool['name']}={tool['status']}" for tool in turn["tools"])
    print(
        f"{case}: 1 file, 1 session, 1 completed turn, 2 tool results, {len(entries)} history entries"
    )
    print(f"  {statuses}; {turn['text']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument(
        "--crash", action="store_true", help="run only the crash and reopen case"
    )
    modes.add_argument(
        "--real",
        metavar="PROVIDER/MODEL",
        help="run once with an openai or claude model",
    )
    args = parser.parse_args()
    if args.real:
        provider, _, model = args.real.partition("/")
        if not model or provider not in {"openai", "claude"}:
            parser.error("use openai/MODEL or claude/MODEL with --real")
        if provider == "openai" and not os.environ.get("OPENAI_API_KEY"):
            parser.error("set OPENAI_API_KEY before using an OpenAI model")
        if (
            provider == "claude"
            and not (REPO / "typescript/packages/claude/dist/src/main.js").is_file()
        ):
            parser.error("build the Claude sidecar first (see the demo README)")

    temp = Path(os.environ.get("TMPDIR") or gettempdir()).resolve()
    temp.mkdir(parents=True, exist_ok=True)
    os.environ["TMPDIR"] = str(temp)
    os.umask(0o077)

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    try:
        if not args.crash:
            with TemporaryDirectory(prefix="project-notes-", dir=temp) as directory:
                run_case(Path(directory), model=args.real or "scripted/script")
        if not args.real:
            with TemporaryDirectory(
                prefix="project-notes-crash-", dir=temp
            ) as directory:
                run_case(Path(directory), crash=True)
    except KeyboardInterrupt:
        parser.exit(130, "project notes run interrupted\n")
    except (RuntimeError, ValueError, OSError, subprocess.TimeoutExpired) as error:
        parser.exit(1, f"project notes check failed: {error}\n")


if __name__ == "__main__":
    main()
