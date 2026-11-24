"""The public modular-agent-acp/1 view, independent of private plugin data shapes.

Source: docs/bindings/acp.md. Internal entries are retained as additional fields.
"""

from datetime import datetime

from ma_core import telemetry as ot
from ma_core.wire import entry_out


BINDING = "modular-agent-acp/1"
APPROVAL = {
    "off": "off",
    "ask": "ask unless read-only",
    "all": "ask always",
    "never": "never ask, refuse",
}
KINDS = {"tool_result": "toolResult", "turn_start": "turnStart", "turn_end": "turnEnd"}


def model_id(model):
    return model["id"] if "/" in model["id"] else model["target"] + "/" + model["id"]


def outcome(result):
    value = {"kind": result["outcome"]}
    if result.get("error"):
        value["limit" if value["kind"] == "limit" else "error"] = (
            {
                "step limit": "steps",
                "output limit": "output",
                "session token limit": "sessionTokens",
            }.get(result["error"], result["error"])
            if value["kind"] == "limit"
            else result["error"]
        )
    return result.get("shared_outcome") or value


def stop_reason(result):
    if result["outcome"] == "limit":
        tokens = outcome(result).get("limit") == "tenantTokens" or result.get("error") in {
            "output limit",
            "session token limit",
        }
        return "max_tokens" if tokens else "max_turn_requests"
    return {"completed": "end_turn", "cancelled": "cancelled", "failed": "refusal"}[
        result["outcome"]
    ]


def question(q):
    return {
        **{k: q[k] for k in ("id", "kind", "question")},
        **({"toolCallId": q["call"]} if q.get("call") else {}),
        **(
            {"approvalWait": "untilDeadline", "deadlineAt": q["deadlineAt"]}
            if q.get("approvalWait") == "untilDeadline"
            else {}
        ),
        **({"call": q["approval_call"]} if q.get("approval_call") else {}),
        **({"coversNested": True} if q.get("coversNested") is True else {}),
        **({"options": q["options"]} if q["kind"] == "choice" else {}),
        **({"details": q["details"]} if isinstance(q.get("details"), str) else {}),
    }


def entry(value):
    if value["kind"] == "question_open":
        wire = entry_out(value)
        wire["data"] = {"request": question(value["data"])}
        return wire
    if value["kind"] == "turn_start" or value["kind"] not in {
        "input",
        "response",
        "tool_result",
        "turn_end",
    }:
        return ot.project_entry(entry_out(value))
    result = {
        **value,
        "parentId": value["parent"],
        "kind": KINDS.get(value["kind"], value["kind"]),
        "time": int(datetime.fromisoformat(value["time"]).timestamp() * 1000),
    }
    for old, new in (
        ("turn", "turnId"),
        ("step", "stepId"),
        ("call", "toolCallId"),
        ("actor", "actorId"),
    ):
        if value.get(old) is not None:
            result[new] = value[old]
    role = {"input": "user", "response": "assistant", "tool_result": "toolResult"}.get(
        value["kind"]
    )
    if role:
        result["message"] = {"role": role, "content": value["content"]}
    data = value.get("data", {})
    if value["kind"] == "input":
        result["inputId"] = data.get("input", value["id"])
        result["data"] = {**data, "inputId": result["inputId"]}
    elif value["kind"] == "response":
        result["message"] = entry_out(value)["message"]
    elif value["kind"] == "tool_result":
        result["message"].update(
            toolCallId=value["call"],
            toolName=data.get("toolName", "unknown"),
            isError=data["status"] != "completed",
        )
        result["data"] = {
            **data,
            "status": {
                "outcome_unknown": "outcomeUnknown",
                "not_started": "notStarted",
            }.get(data["status"], data["status"]),
        }
    elif value["kind"] == "turn_end":
        result["data"] = {**data, **entry_out(value)["data"]}
    return result


def declaration(plugins, provider=None, *, interface_tools=False):
    runtime = next((p for p in plugins.values() if "parallel_tools" in p), {})
    providers = [p for p in plugins.values() if "stateful" in p]
    provider = (
        provider
        if provider is not None
        else {
            "stateful": any(p.get("stateful") for p in providers),
            "runs_tools": any(p.get("runs_tools") for p in providers),
            "live": any(p.get("live") for p in providers),
        }
    )
    environment = next((p for p in plugins.values() if "stops_commands_on_crash" in p), {})
    return {
        "inputDuringTurn": bool(runtime.get("steering")),
        "waitingThroughRestart": bool(
            runtime.get("waiting_through_restart", runtime.get("durable"))
        ),
        "continuesAfterRestart": bool(runtime.get("durable")),
        "rewinding": bool(environment.get("rewind")),
        "forking": True,
        "nestedToolCalls": bool(runtime.get("nested_tools")),
        **({"interfaceTools": True} if interface_tools and runtime.get("interface_tools") else {}),
        "portableSessions": True,
        "keepsStateAtProvider": bool(provider.get("stateful")),
        "runsToolsAtProvider": bool(provider.get("runs_tools")),
        "liveSessions": bool(provider.get("live")),
        "severalActors": True,
        "sessionLimits": True,
        "tenants": True,
        "holdsOutput": any(p.get("holds_output") for p in plugins.values()),
        "outputBypassesAgent": False,
        "cancellingTurnCancelsJobs": False,
        "pluginsDuringSession": False,
        "erasure": any(p.get("erasure") and p.get("pending_erasure") for p in plugins.values()),
        "inputKeys": bool(runtime.get("keyed_input")),
        "telemetry": 1,
        "questionsOutlastTurns": bool(runtime.get("open_calls")),
        "startsTurnsUnasked": "jobReports",
        "queuedInputAfterRestart": runtime.get("queued_input_after_restart", "handedBack"),
        "movingWithUnfinishedWork": "refused",
        "mixedActorInput": "shared",
        "settingsDuringTurn": "refused",
        "erasureDuringTurn": "refused",
        "commandContainment": environment.get(
            "containment", "strong" if environment.get("stops_commands_on_crash") else "none"
        ),
        "plugins": plugins,
        # Late question answers also resume turns. The binding's enum has no such value.
        "lateAnswersStartTurns": True,
    }
