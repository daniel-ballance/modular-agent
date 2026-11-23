"""Private state that a normal tool turn should not copy between plugins."""

import json

from ma_cli import build
from ma_core import content, silent
from ma_fake import Fake
from ma_core.wire import messages_out, request_in, request_out


async def test_turn_does_not_copy_an_unrelated_record(tmp_path, monkeypatch):
    # Check the arguments and answers at the same API boundary the private
    # workers serialize. No wall-clock assertion or large history needed.
    monkeypatch.setenv("MODULAR_AGENT_CONFORMANCE", "1")
    h = await build(tmp_path / "state", Fake(), project=tmp_path, process_plugins=[])
    (tmp_path / "file").write_text("read me")
    marker = "a hidden record from before the turn"
    try:
        api = h.api()
        sid = (
            await api.session(
                "create", project=str(tmp_path), settings={"model": "conformance/echo"}
            )
        )["id"]
        await api.session("append", session=sid, kind="bench.hidden", data={"note": marker})
        leaked = set()
        original = h.call

        async def traced(caller, target, operation, data, emit=silent):
            result = await original(caller, target, operation, data, emit)
            if marker in json.dumps([data, result]):
                leaked.add((caller, target, operation))
            return result

        monkeypatch.setattr(h, "call", traced)
        receipt = await api.call(
            "runtime", "submit", {"session": sid, "content": content('tool:read {"path":"file"}')}
        )
        (result,) = await api.call("runtime", "wait", {"session": sid, "input": receipt["input"]})
        assert result["content"] == content("done: read me")
        assert not leaked, sorted(leaked)
    finally:
        await h.stop()


def test_shared_request_preserves_tool_name_and_extensions():
    request = {
        "systemPrompt": "",
        "tools": [],
        "settings": {"x-mode": 7},
        "messages": [
            {"role": "user", "content": content("hi"), "x-tag": "user"},
            {
                "role": "toolResult",
                "toolCallId": "c",
                "toolName": "read",
                "isError": False,
                "content": content("answer"),
                "x-tag": "tool",
            },
        ],
    }
    assert request_out(request_in(request, {})) == request


def test_model_messages_do_not_copy_native_record_data():
    projected = messages_out(
        [
            {
                "id": "i",
                "kind": "input",
                "content": content("ask"),
                "data": {"authority": ["input"]},
            },
            {
                "id": "r",
                "kind": "tool_result",
                "call": "c",
                "content": content("answer"),
                "data": {"status": "completed", "toolName": "read", "value": "not model content"},
            },
        ]
    )
    assert projected == [
        {"id": "i", "role": "user", "content": content("ask")},
        {
            "id": "r",
            "role": "toolResult",
            "toolCallId": "c",
            "toolName": "read",
            "content": content("answer"),
            "isError": False,
        },
    ]
