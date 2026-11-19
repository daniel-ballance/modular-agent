"""Production checkpoint regressions at the Runtime and history interfaces."""

import pytest

from ma_core import AgentError, content
from ma_history import History
from ma_fake import reply


@pytest.mark.parametrize("reject_take", [False, True])
async def test_turn_start_and_first_input_are_one_commit(agent, monkeypatch, reject_take):
    batches = []
    keep = History.keep

    async def capture(self, request, emit):
        kinds = [e["kind"] for e in request["entries"]]
        if reject_take and "input" in kinds:
            raise AgentError("Cannot commit taken input", "lost")
        answer = await keep(self, request, emit)
        batches.append(kinds)
        return answer

    monkeypatch.setattr(History, "keep", capture)
    _, api, sid, provider = await agent([reply("answer")])
    await api.call("runtime", "submit", {"session": sid, "content": content("input")})
    if reject_take:
        with pytest.raises(AgentError, match="Cannot commit taken input"):
            await api.call("runtime", "wait", {"session": sid})
        assert not provider.requests
        assert [batch for batch in batches if "turn_start" in batch] == []
    else:
        await api.call("runtime", "wait", {"session": sid})
        assert [batch for batch in batches if "turn_start" in batch] == [["turn_start", "input"]]
        assert len(provider.requests) == 1


async def test_job_report_and_end_are_one_commit(agent, monkeypatch):
    batches = []
    keep = History.keep

    async def capture(self, request, emit):
        answer = await keep(self, request, emit)
        batches.append(request["entries"])
        return answer

    monkeypatch.setattr(History, "keep", capture)
    _, api, sid, _ = await agent([reply("done")])
    scope = {"session": sid}
    await api.call("runtime", "submit", {**scope, "content": content("start")})
    await api.call("runtime", "wait", scope)
    job = await api.call("jobs", "create", {**scope, "kind": "fixture"})
    end = {**scope, "job": job["id"], "result": content("exact report"), "strict": True}
    await api.call("jobs", "report", end)
    await api.call("jobs", "report", end)
    await api.call("runtime", "wait", scope)
    commits = [batch for batch in batches if any(e["kind"] == "job_end" for e in batch)]
    assert len(commits) == 1
    ended, reported = commits[0]
    assert ended["kind"] == "job_end"
    assert reported["kind"] == "input_queued"
    assert reported["job"] == job["id"]
    assert reported["content"] == content("exact report")
    assert reported["data"]["parked"] is False
