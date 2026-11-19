"""Regression from the first real Haiku run: SDK usage includes nested metadata."""

from test_claude import setup, submit
from test_claude import sdk as sdk


async def test_nested_vendor_usage_does_not_fail_completed_turn(tmp_path, sdk):
    h, a, sid, provider, instances = await setup(tmp_path, sdk, "usage")
    try:
        out = await submit(a, sid)
        assert out[-1]["outcome"] == "completed", out[-1]["error"]
        assert all(isinstance(value, (int, float)) for value in out[-1]["usage"].values())
    finally:
        await h.stop()
