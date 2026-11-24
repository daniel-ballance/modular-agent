"""Only a parent's explicit allow can answer its dispatch's nested approval checks."""

import asyncio

import pytest

from modular_agent import Plugin, ToolContext, tool
from modular_agent.testing import restart, test_agent as make_agent


SCRIPT = [{"toolCalls": [{"name": "parent", "input": {}}]}, {"text": "done"}]


def tree(ran, *, readonly_parent=False):
    @tool(read_only=readonly_parent)
    async def parent(cx: ToolContext) -> str:
        """Call a child twice."""
        ran.append("parent")
        for _ in range(2):
            await cx.tools.call("child", {})
        return "parent done"

    @tool
    async def child(cx: ToolContext) -> str:
        """Call a leaf."""
        ran.append("child")
        return (await cx.tools.call("leaf", {})).text()

    @tool
    async def leaf() -> str:
        """Record a leaf effect."""
        ran.append("leaf")
        return "leaf done"

    return [parent, child, leaf]


async def test_one_allow_covers_only_its_own_dispatch():
    ran, views = [], []

    def decide(q, _):
        views.append(q)
        return "allow" if len(views) == 1 else "decline"

    async with make_agent(
        script=[], tools=tree(ran), approval="all", approval_covers_nested=True, on_question=decide
    ) as agent:
        assert agent.declaration()["approvalCoversNested"] is True
        session = await agent.session()
        assert (await session.call_tool("parent", {})).status == "completed"
        assert (await session.call_tool("parent", {})).status == "refused"
        assert ran == ["parent", "child", "leaf", "child", "leaf"]
        assert len(views) == 2 and all(q.covers_nested for q in views)
        assert all(q.call == {"name": "parent", "input": {}} for q in views)
        rows = await session.history()
        requests = [r for r in rows if r["kind"] == "inputRequest"]
        assert all(r["data"]["request"]["coversNested"] is True for r in requests)
        parent, *children = [r for r in rows if r["kind"] == "toolStarted"]
        assert "approvalCoveredBy" not in parent["data"]
        assert len(children) == 4
        for child in children:
            assert child["data"]["approvalCoveredBy"] == {
                "toolCallId": parent["toolCallId"],
                "requestId": views[0].id,
            }


@pytest.mark.parametrize(
    "policy,covers,readonly,asked,runs",
    [
        ("all", False, False, ["parent", "child", "child"], ["parent"]),
        ("ask", True, True, ["child", "child"], ["parent"]),
        ("never", True, False, [], []),
        (None, True, False, [], ["parent", "child", "leaf", "child", "leaf"]),
    ],
)
async def test_coverage_needs_the_option_plugin_and_a_parent_allow(
    policy, covers, readonly, asked, runs
):
    ran, views = [], []

    def decide(q, _):
        views.append(q)
        return "allow" if q.call["name"] == "parent" else "decline"

    async with make_agent(
        script=SCRIPT,
        tools=tree(ran, readonly_parent=readonly),
        approval=policy,
        approval_covers_nested=covers,
        on_question=decide,
    ) as agent:
        assert ("approvalCoversNested" in agent.declaration()) == bool(covers and policy)
        session = await agent.session()
        await session.prompt("run")
        assert [q.call["name"] for q in views] == asked
        assert not any(q.covers_nested for q in views)
        assert ran == runs
        assert all("approvalCoveredBy" not in e.get("data", {}) for e in await session.history())


async def test_cover_does_not_skip_another_gate():
    ran, views = [], []

    def decide(q, _):
        views.append(q)
        return "allow"

    def check(call):
        if call["call"]["name"] == "leaf":
            return {"refuse": "leaf is unavailable"}

    async with make_agent(
        script=SCRIPT,
        tools=tree(ran),
        approval="all",
        approval_covers_nested=True,
        on_question=decide,
        plugins=[Plugin("other-gate", hooks={"tool.before": check})],
    ) as agent:
        session = await agent.session()
        await session.prompt("run")
        assert len(views) == 1 and ran == ["parent", "child", "child"]
        rows = await session.history()
        leaves = [
            e for e in rows if e["kind"] == "toolResult" and e["message"]["toolName"] == "leaf"
        ]
        assert [r["data"]["status"] for r in leaves] == ["refused", "refused"]


@pytest.mark.parametrize("marked", [False, True])
async def test_waiting_allow_covers_only_what_the_saved_view_offered(tmp_path, marked):
    ran = []
    options = dict(
        project=tmp_path,
        data_dir=tmp_path / "store",
        durability="kept",
        tools=tree(ran),
        approval="all",
        late_answers_start_turns=True,
        max_approval_wait_ms=60_000,
    )
    async with make_agent(script=SCRIPT, **options, approval_covers_nested=marked) as first:
        session = await first.session(settings={"approvalWait": "untilDeadline"})
        [cid] = (await session.prompt("run")).open_tool_calls
        assert ran == []
        sid = session.id
    async with make_agent(
        script=[{"text": "done"}], **options, approval_covers_nested=True
    ) as second:
        session = await second.open_session(sid)
        [q] = await session.questions(present=True)
        assert q.tool_call_id == cid and q.covers_nested == marked
        await session.answer(q.id, "allow")
        await session.wait_idle()
        assert ran == (["parent", "child", "leaf", "child", "leaf"] if marked else ["parent"])
        rows = await session.history()
        parent, *children = [e for e in rows if e["kind"] == "toolStarted"]
        assert parent["toolCallId"] == cid
        assert len(children) == (4 if marked else 0)
        assert all(
            c["data"]["approvalCoveredBy"] == {"toolCallId": cid, "requestId": q.id}
            for c in children
        )
        assert len([e for e in rows if e["kind"] == "inputRequest"]) == (1 if marked else 3)


async def test_withheld_covering_view_cannot_authorize_dispatch():
    ran, views = [], []

    def output(payload):
        if any(e["type"] == "python.input_request_opened" for e in payload["events"]):
            return {"refuse": "private approval view"}

    def decide(q, _):
        views.append(q)
        return "allow"

    async with make_agent(
        script=SCRIPT,
        tools=tree(ran),
        approval="all",
        approval_covers_nested=True,
        on_question=decide,
        plugins=[Plugin("withhold", hooks={"output": output})],
    ) as agent:
        session = await agent.session()
        [result] = (await session.prompt("run")).tool_results()
        assert result.status == "refused"
        assert not views and not ran


async def test_recovering_after_live_allow_needs_a_new_allow(tmp_path):
    after_allow = asyncio.Event()
    ran, views = [], []

    def decide(q, _):
        views.append(q)
        return "allow" if len(views) == 1 else "decline"

    async def barrier(_):
        if not after_allow.is_set():
            after_allow.set()
            await asyncio.Future()

    async with make_agent(
        script=SCRIPT,
        tools=tree(ran),
        project=tmp_path,
        data_dir=tmp_path / "store",
        durability="durable",
        approval="all",
        approval_covers_nested=True,
        on_question=decide,
        plugins=[
            Plugin("after-approval", setup=lambda r: r.on("tool.before", barrier, order="last"))
        ],
    ) as agent:
        session = await agent.session()
        await session.send("run", "now")
        await after_allow.wait()
        assert len(views) == 1 and not ran
        async with await restart(agent) as recovered:
            await recovered.open_session(session.id)
            assert len(views) == 2 and views[0].id != views[1].id
            assert views[0].tool_call_id == views[1].tool_call_id
            assert not ran
