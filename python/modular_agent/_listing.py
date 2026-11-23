"""Read one committed branch without opening a session or registering a responder."""

from collections.abc import Collection
from datetime import UTC, datetime
from typing import Any, Literal, TypedDict

from ma_core.wire import recorded_as
from ma_harness.interface_tools import branch_entries, unfinished_turn
from ma_questions import eligible_question, question_state


class WaitingSummary(TypedDict):
    questions: int
    toolCalls: int
    turn: Literal["none", "running", "interrupted"]


class SessionSummary(TypedDict):
    id: str
    project: str
    updatedAt: str
    waiting: WaitingSummary


def summarize(
    harness: Any,
    state: dict[str, Any],
    *,
    running: bool,
    actor: str,
    rights: set[str],
    represents: Collection[str],
    route_id: str | None,
    live_questions: Collection[str] | None,
    approval_views: Collection[str],
) -> SessionSummary:
    branch = [e for e in branch_entries(state) if not e.get("fork_source")]
    ended = {e.get("turn") for e in branch if recorded_as(e, "turn_end")}
    unfinished = unfinished_turn(branch, ended)
    responders = {actor: rights}
    for represented in represents:
        responders[represented] = rights.intersection(harness.permissions(state, represented))
    questions = 0
    now = datetime.now(UTC)
    for q in question_state(branch).values():
        if q["kind"] == "secret" or {"answer", "selected", "closed"}.intersection(q):
            continue
        if q["kind"] == "approval" and (q["id"] not in approval_views or q["turn"] in ended):
            continue
        if live_questions is not None and q["turn"] not in ended and q["id"] not in live_questions:
            continue
        if not q.get("park") and q.get("deadline") and datetime.fromisoformat(q["deadline"]) <= now:
            continue
        if any(eligible_question(q, aid, allowed) for aid, allowed in responders.items()):
            questions += 1
    latest = max(datetime.fromisoformat(e["time"]) for e in state["entries"])
    return {
        "id": state["id"],
        "project": state["project"],
        "updatedAt": latest.astimezone(UTC).isoformat(timespec="milliseconds"),
        "waiting": {
            "questions": questions,
            "toolCalls": len(harness.open_interface_calls(state, branch, actor, route_id, rights)),
            "turn": "none" if not unfinished else "running" if running else "interrupted",
        },
    }
