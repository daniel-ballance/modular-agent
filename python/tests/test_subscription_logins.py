import asyncio
import json
import stat

from modular_agent import OAuth, subscription_logins
import pytest


async def test_login_file_preserves_metadata_and_mode(tmp_path):
    path = tmp_path / "auth.json"
    path.write_text('{"logins": {}, "answers": {"a": "fixture"}, "future": [1, null]}')
    path.chmod(0o600)
    logins = subscription_logins(path)
    await logins.set_login("chatgpt", OAuth("test-access", "test-refresh", 1))
    assert json.loads(path.read_text()) == {
        "logins": {
            "chatgpt": {
                "type": "oauth",
                "access": "test-access",
                "refresh": "test-refresh",
                "expires": 1,
            }
        },
        "answers": {"a": "fixture"},
        "future": [1, None],
    }
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.with_suffix(".lock").stat().st_mode) == 0o600
    path.chmod(0o640)
    with pytest.raises(ValueError, match="readable by others"):
        logins.login("chatgpt")
    with pytest.raises(ValueError, match="readable by others"):
        await logins.set_login("chatgpt", None)


async def test_independent_handles_share_refresh_transaction(tmp_path):
    path = tmp_path / "auth.json"
    first, second = subscription_logins(path), subscription_logins(path)
    old, fresh = OAuth("old", "test-refresh", 1), OAuth("fresh", "new-refresh", 2**62)
    await first.set_login("chatgpt", old)
    entered, reading, finished = asyncio.Event(), asyncio.Event(), asyncio.Event()
    count = 0

    async def refresh(token):
        nonlocal count
        assert token == old
        count += 1
        entered.set()
        await reading.wait()
        assert not finished.is_set()
        return fresh

    async def other():
        await entered.wait()
        reading.set()
        result = await second.current("chatgpt", refresh)
        finished.set()
        return result

    assert await asyncio.gather(first.current("chatgpt", refresh), other()) == [fresh, fresh]
    assert count == 1
    assert second.login("chatgpt") == fresh
