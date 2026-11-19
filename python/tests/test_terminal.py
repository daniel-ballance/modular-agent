import asyncio
import json
import os
import sys


from ma_fake import reply
from ma_terminal import Terminal


async def process(tmp_path, script, *args, stdin=None, include_project=True):
    fake = tmp_path / "fake.json"
    fake.write_text(json.dumps(script))
    p = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "modular_agent",
        "--runtime",
        os.environ["MA_TEST_RUNTIME"],
        "--home",
        str(tmp_path / "store"),
        *(["--project", str(tmp_path)] if include_project else []),
        "--fake-script",
        str(fake),
        *args,
        stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(
            p.communicate(stdin.encode() if stdin is not None else None), 5
        )
    finally:
        if p.returncode is None:
            p.kill()
            await p.wait()
    return p.returncode, out.decode(), err.decode()


async def test_print_and_reopen_in_new_process(tmp_path):
    code, out, err = await process(tmp_path, [reply("first")], "-p", "remember")
    assert code == 0 and out.strip() == "first"
    sid = err.split("Session: ")[1].splitlines()[0]
    code, out, err = await process(
        tmp_path, [reply("continued")], "--session", sid, "-p", "continue"
    )
    assert code == 0 and out.strip() == "continued"
    code, out, err = await process(tmp_path, [], "--list", "project")
    assert code == 0 and json.loads(out)[0]["id"] == sid


async def test_reopen_without_project_uses_saved_project_before_plugin_loading(tmp_path):
    code, out, err = await process(tmp_path, [reply("first")], "-p", "remember")
    assert code == 0
    sid = err.split("Session: ")[1].splitlines()[0]
    code, out, err = await process(
        tmp_path, [reply("continued")], "--session", sid, "-p", "continue", include_project=False
    )
    assert code == 0 and out.strip() == "continued"


async def test_json_events_include_declaration_outcome_and_usage(tmp_path):
    code, out, err = await process(tmp_path, [reply("answer")], "--mode", "json", "-p", "go")
    assert code == 0
    events = [json.loads(line) for line in out.splitlines()]
    assert events[0]["kind"] == "session_opened"
    assert events[0]["declaration"][os.environ["MA_TEST_RUNTIME"]]["keyed_input"]
    assert events[-1]["kind"] == "turn_ended" and events[-1]["outcome"] == "completed"
    assert events[-1]["usage"]["output_tokens"] == 5


async def test_interactive_line_input_and_model_free_command(tmp_path):
    code, out, err = await process(tmp_path, [reply("line answer")], stdin="/thinking low\nhello\n")
    assert code == 0 and "line answer" in out and '"thinking": "low"' in out


async def test_failed_turn_exit_code(tmp_path):
    code, out, err = await process(tmp_path, [{"error": "offline failure"}], "-p", "go")
    assert code == 1 and "failed: offline failure" in err


async def test_terminal_return_values_gated_not_just_streams(agent):
    import io

    h, a, sid, fake = await agent(secrets=["SECRET"])
    output = io.StringIO()
    terminal = Terminal("json", output)
    # A separate terminal instance may be installed only before sessions exist.
    # Bind it through the same public API to exercise rendering without hot-loading.
    await terminal.start(h.api("test-terminal", "interface"))
    await terminal.show({"command_result": "SECRET"})
    assert "SECRET" not in output.getvalue()
    assert "[REDACTED]" in output.getvalue()
