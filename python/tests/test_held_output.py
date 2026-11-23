"""A held stream has one disposition even when its gates see several segments."""

import pytest

from ma_harness.output import SEGMENT_BYTES, encoded_size


@pytest.mark.parametrize("mode", ["segments", "oversized", "buffer", "replacement", "block"])
async def test_held_stream_is_never_shortened(agent, mode):
    h, api, sid, _ = await agent()
    segments, seen = [], []

    async def gate(payload):
        if payload["recipient"] != "reader":
            return None
        batch = payload["events"]
        assert encoded_size(batch) <= SEGMENT_BYTES
        segments.append(len(batch))
        if len(segments) == 2:
            if mode == "replacement":
                batch[0]["data"]["delta"] = "y" * SEGMENT_BYTES
                return {**payload, "events": batch}
            if mode == "block":
                return {**payload, "refused": True}
        return None

    async def receive(event):
        seen.append(event["kind"])

    h.handlers.append(("test-gate", "binding.output", gate, "normal"))
    api.follow("reader", receive)
    for limits in h.capacity.limits.values():
        limits["bufferedBytes"] = 64 * 1024 * 1024
    if mode == "buffer":
        h.capacity.limits["session"]["bufferedBytes"] = 512
    sizes = {
        "oversized": [5, SEGMENT_BYTES, 5],
        "buffer": [5, 1024, 5],
    }.get(mode, [SEGMENT_BYTES // 2, SEGMENT_BYTES // 2])
    for n in sizes:
        await api.event("model_output", session=sid, step="step", text="x" * n)
    assert not seen
    await api.event("model_output", session=sid, step="step", text="", final=True)
    if mode == "segments":
        assert len(segments) == 2 and seen == ["model_output"] * 3
    elif mode == "block":
        assert len(segments) == 2 and not seen
    else:
        assert seen == ["output_overflow"]
