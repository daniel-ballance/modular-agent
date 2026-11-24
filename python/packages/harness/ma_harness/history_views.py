"""Read from the host's committed history before copying across the private plugin API."""

from ma_core import AgentError
from ma_core.recovery import STEP_AFTER, step_checkpoint
from ma_core.wire import entry_out, recorded_as

from .interface_tools import branch_entries


def select_entries(entries, query):
    for key in ("turn", "step", "call", "id", "kind", "visible"):
        if key in query:
            entries = [e for e in entries if e.get(key) == query[key]]
    if "kinds" in query:
        kinds = query["kinds"]
        entries = [e for e in entries if any(recorded_as(e, k) for k in kinds)]
    if "calls" in query:
        calls = set(query["calls"])
        entries = [e for e in entries if e.get("call") in calls]
    if query.get("omit_replay"):
        entries = [
            {**e, "data": {k: v for k, v in e["data"].items() if k != "request"}}
            if e["kind"] == "model_started"
            else e
            for e in entries
        ]
    if query.get("last"):
        entries = entries[-1:]
    if "fields" in query:
        fields = query["fields"]
        return [{k: e[k] for k in fields if k in e} for e in entries]
    return entries


def pending_inputs(entries, proposals, ready):
    settled, accepted = set(), {}
    for e in entries:
        if e.get("fork_source"):
            continue
        d = e.get("data", {})
        iid = d.get("input", e["id"])
        if e["kind"] == "input_queued":
            accepted[iid] = e
        elif recorded_as(e, "input") or recorded_as(e, "input_withdrawn"):
            settled.add(d.get("input"))
    pending = [
        e
        for iid, e in accepted.items()
        if iid not in settled
        and (proposals or (e["data"]["when"] != "propose" and not e["data"].get("parked")))
    ]
    if ready:
        order = {e["id"]: i for i, e in enumerate(entries)}
        pending = sorted(
            [*ready, *pending], key=lambda e: e.get("ready_order", order.get(e["id"], len(entries)))
        )
    return pending


def input_outcomes(entries, input_id=None):
    taken, ended = {}, {}
    for e in entries:
        if e["kind"] in {"input", "turn_start"}:
            iid = e["data"].get("input")
            if iid and (input_id is None or iid == input_id):
                taken.setdefault(iid, e["turn"])
        elif e["kind"] == "turn_end":
            ended.setdefault(e["turn"], e["data"])
    return {
        iid: {"turn": turn, "result": ended[turn]} for iid, turn in taken.items() if turn in ended
    }


def saved_step(session, turn, step):
    # Off-branch gate decisions still count: a move cannot license a second
    # execution of the gate. Include even conflicting or erased decisions.
    branch = branch_entries(session)
    on_branch = {e["id"] for e in branch}
    candidates = [e for e in branch if e.get("turn") == turn or recorded_as(e, STEP_AFTER)]
    candidates.extend(
        e for e in session["entries"] if e["id"] not in on_branch and recorded_as(e, STEP_AFTER)
    )
    try:
        return step_checkpoint(
            [
                entry_out(e)
                for e in candidates
                if not e.get("fork_source") and (step is None or e.get("step") == step)
            ],
            turn,
            step,
        )
    except ValueError as exc:
        raise AgentError(str(exc), "lost") from exc
