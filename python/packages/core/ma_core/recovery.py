"""Read the portable step gate checkpoint without relying on private records."""

HANDOFF = "modular-agent.interfaceHandoff"

STEP_AFTER = "modular-agent.stepAfter"


def step_checkpoint(entries, turn_id, step_id=None):
    """Return (response, lastStep), or raise if the gate state is unprovable."""
    attempts = {}
    responses = []
    for e in entries:
        if e.get("turnId") != turn_id or (step_id is not None and e.get("stepId") != step_id):
            continue
        step = e.get("stepId")
        data = e.get("data", {})
        if e["kind"] == "modelRequest":
            attempts.setdefault(step, []).append(e)
        elif e["kind"] == "response":
            intents = attempts.get(step, [])
            if len(intents) == 1 and intents[0].get("data", {}).get("auxiliary") is True:
                continue
            if not e.get("erased") and data.get("recovery") is True:
                continue
            responses.append((e, intents))
    if not responses:
        return None, None
    response, intents = responses[-1]
    step = response.get("stepId")
    if (
        not step
        or response.get("erased")
        or len(intents) != 1
        or intents[0].get("erased")
        or sum(e.get("stepId") == step for e, _ in responses) != 1
        or response.get("message", {}).get("role") != "assistant"
    ):
        raise ValueError("Unknown answered step checkpoint")
    decisions = [e for e in entries if e["kind"] == STEP_AFTER and e.get("stepId") == step]
    restored = {"stepId": step}
    if not decisions:
        return response, restored
    if (
        len(decisions) != 1
        or decisions[0].get("erased")
        or decisions[0].get("turnId") != turn_id
        or "decision" not in decisions[0].get("data", {})
        or decisions[0].get("modelVisible") is not False
    ):
        raise ValueError("Unknown step.after checkpoint")
    decision = decisions[0]["data"]["decision"]
    if decision is not None and (
        not isinstance(decision, dict) or not isinstance(decision.get("refuse"), str)
    ):
        raise ValueError("Invalid step.after checkpoint")
    restored["decision"] = decision
    return response, restored
