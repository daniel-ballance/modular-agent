"""Standard binding hook names and payloads mapped onto the native hook owners."""

from ma_core import Stop, content, plain

from ma_core.wire import (
    call_in,
    call_out,
    model_out,
    request_in,
    request_out,
    response_in,
    response_out,
    result_in,
    result_out,
    tool_out,
    turn_end_out,
)

NAMES = {
    "input": "input.arrives",
    "turn.before": "turn.prepare",
    "turn.result": "binding.turn.result",
    "output": "binding.output",
}
STANDARD = {
    "plugin.load",
    "session.start",
    "session.end",
    "input",
    "turn.before",
    "turn.start",
    "step.before",
    "step.after",
    "tool.before",
    "tool.after",
    "model.failed",
    "turn.result",
    "turn.end",
    "provider.request",
    "provider.response",
    "output",
}


async def payload(plugin, hook, d):
    sid = d.get("session")
    p = {**d, **({"sessionId": sid} if sid else {})}
    for old, new in (("actor", "actorId"), ("turn", "turnId"), ("step", "stepId")):
        if old in d:
            p[new] = d[old]
    if hook == "plugin.load":
        p.update(name=d["plugin"], origin="configured", project=str(plugin.project))
    elif hook == "session.start":
        p["resumed"] = bool(d.get("resumed"))
    elif hook == "input":
        p["when"] = "inTurn" if d.get("when") == "steer" else d.get("when", "now")
    elif hook == "turn.before":
        entries = await plugin.api.session("branch", session=sid)
        p["input"] = d.get(
            "input", next((e["content"] for e in reversed(entries) if e["kind"] == "input"), [])
        )
    elif hook == "step.before":
        p.update(model=model_out(d["access"]), request=request_out(d))
    elif hook == "step.after":
        p["response"] = response_out(d["response"])
    elif hook in {"tool.before", "tool.after"}:
        p["call"] = call_out(d["call"])
        if hook == "tool.before":
            p["definition"] = tool_out(d["definition"]) if d.get("definition") else None
        else:
            p["result"] = result_out(d["result"])
    elif hook == "model.failed":
        p["request"] = request_out(d["request"])
        p["error"] = {
            "kind": "contextTooLarge" if d.get("code") == "context_too_large" else "other",
            "message": d["error"],
        }
    elif hook == "turn.result":
        p["result"] = {**d.get("shared_result", {}), "text": plain(d["result"])}
    elif hook == "turn.end":
        return {"sessionId": sid, "turnId": d["turn"], **turn_end_out(d)}
    from ma_core.wire import provider_projection

    return provider_projection(p)


def answer(hook, d, a):
    if a is None:
        return None
    if hook == "output":
        if a.get("block"):
            return {**d, "refused": True}
        events = a["events"]
        if not isinstance(events, list) or not all(
            isinstance(e, dict) and isinstance(e.get("type"), str) and "data" in e for e in events
        ):
            raise ValueError("Invalid output gate response")
        return {**d, "events": events}
    if hook == "turn.before":
        return a
    if hook == "model.failed":
        return {
            **a,
            **({"request": request_in(a["request"], d["request"])} if a.get("request") else {}),
        }
    if hook == "turn.result":
        if a.get("refuse"):
            return {**d, "refused": True, "reason": a["refuse"]}
        if a.get("change"):
            changed = a["change"]["result"]
            return {**d, "result": content(changed.get("text", "")), "shared_result": changed}
        return None
    if "refuse" in a:
        return {**d, "refused": True, "reason": a["refuse"]}
    if "pending" in a:
        return {**d, "open": True, "request": None, "pending": a["pending"]}
    changed = a.get("value", a.get("change"))
    if changed is None:
        return a
    result = {**d}
    if hook == "tool.before":
        result["call"] = {
            **call_in(changed["call"], d["call"]),
            **{
                key: d["call"][key]
                for key in ("id", "name", "actor", "authority", "initiator", "step")
                if key in d["call"]
            },
        }
        # A gate may edit input, never the lineage which authorized the work.
    elif hook == "tool.after":
        result.update(call=call_in(changed["call"], d["call"]), result=result_in(changed["result"]))
    elif hook == "step.before":
        result = request_in(changed["request"], d)
    elif hook == "step.after":
        result["response"] = response_in(changed["response"])
    elif hook == "input":
        result["content"] = changed["content"]
        if a.get("stop"):
            result["handled"] = True
            result.setdefault("result", None)
    elif hook.startswith("provider."):
        result = changed
    else:
        result.update(changed)
    return Stop(result) if a.get("stop") else result
