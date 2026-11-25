"""Lossless shared-data boundary translations. Native aliases stay inside the build."""

from datetime import datetime
import json

from ma_core import plain

STOP_OUT = {"tools": "toolUse", "output_limit": "length"}
STOP_IN = {v: k for k, v in STOP_OUT.items()}
STATUS_OUT = {"not_started": "notStarted", "outcome_unknown": "outcomeUnknown"}
STATUS_IN = {v: k for k, v in STATUS_OUT.items()}
HINTS = {"read_only": "readOnly", "safe_to_repeat": "safeToRepeat", "external": "openWorld"}


def json_equal(left, right):
    """Shared JSON equality. Python's True == 1 is not JSON equality."""
    if type(left) in (int, float) and type(right) in (int, float):
        return float(left) == float(right)
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(json_equal(v, right[k]) for k, v in left.items())
    if isinstance(left, list):
        return len(left) == len(right) and all(json_equal(a, b) for a, b in zip(left, right))
    return left == right


def tool_out(t):
    return {
        **{k: v for k, v in t.items() if k not in {"schema", "target"}},
        "parameters": t.get("schema", t.get("parameters", {})),
        "hints": {HINTS.get(k, k): v for k, v in t.get("hints", {}).items()},
        "callers": [
            "ui" if c == "interface" else c
            for c in t.get("callers", ["model", "plugin", "interface"])
        ],
    }


def tool_in(t):
    return {
        **t,
        "schema": t["parameters"],
        "hints": {
            next((a for a, b in HINTS.items() if b == k), k): v
            for k, v in (t.get("hints") or {}).items()
        },
        "callers": [
            "interface" if c == "ui" else c
            for c in (t["callers"] if t.get("callers") is not None else ["model", "ui", "plugin"])
        ],
    }


def call_out(c):
    return {
        **c,
        "startedBy": {"interface": "ui"}.get(
            c.get("initiator"), c.get("startedBy", c.get("initiator", "model"))
        ),
        **({"actorId": c["actor"]} if "actor" in c else {}),
        **({"stepId": c["step"]} if "step" in c else {}),
    }


def call_in(c, original=None):
    return {
        **(original or {}),
        **c,
        **({"actor": c["actorId"]} if c.get("actorId") else {}),
        "initiator": "interface" if c.get("startedBy") == "ui" else c.get("startedBy", "model"),
    }


def result_out(r):
    return {
        **r,
        "callId": r.get("call", r.get("callId")),
        "status": STATUS_OUT.get(r["status"], r["status"]),
    }


def result_in(r, call=None):
    if "pending" in r:
        return {**r, "open": True}
    return {**r, "call": call or r.get("callId"), "status": STATUS_IN.get(r["status"], r["status"])}


def model_out(m, provider=None):
    owner, _, name = m["id"].partition("/")
    return {
        **{
            k: v
            for k, v in m.items()
            if k
            not in {"context_window", "output_limit", "input_types", "target", "_host_prepares"}
        },
        "provider": provider or owner,
        "id": name or owner,
        "contextWindow": m.get("context_window", m.get("contextWindow", 1_000_000)),
        "maxOutput": m.get("output_limit", m.get("maxOutput", 4096)),
        "input": m.get("input_types", m.get("input", ["text"])),
        "reasoning": m.get("reasoning", any(x != "off" for x in m.get("thinking", []))),
    }


def model_in(m, supports):
    return {
        **m,
        "id": m["provider"] + "/" + m["id"],
        "context_window": m["contextWindow"],
        "output_limit": m["maxOutput"],
        "input_types": m["input"],
        "provider": {
            "stateful": supports.get("keepsState", False),
            "runs_tools": supports.get("runsTools", False),
            "live": False,
        },
    }


def provider_projection(value, provider=None):
    """Project records, messages and requests without disclosing opaque reasoning."""
    if isinstance(value, list):
        return [
            projected
            for item in value
            if (projected := provider_projection(item, provider)) is not _OMIT_REASONING
        ]
    if not isinstance(value, dict):
        return value
    # Each assistant message establishes its own identity, not that of the request.
    if value.get("role") == "assistant":
        model = value.get("model")
        provider = (
            provider if isinstance(model, dict) and model.get("provider") == provider else None
        )
        if provider is not None:
            return value
    if value.get("type") == "reasoning" and "providerData" in value and "text" not in value:
        return _OMIT_REASONING
    return {
        key: projected
        for key, item in value.items()
        if not (
            key == "providerData"
            and (value.get("role") == "assistant" or value.get("type") == "reasoning")
        )
        and (projected := provider_projection(item, None)) is not _OMIT_REASONING
    }


_OMIT_REASONING = object()


def request_for_provider(request, provider):
    return {**request, "messages": provider_projection(request.get("messages", []), provider)}


def restore_provider_messages(request, original, provider):
    """A hook sees only public content; only unchanged messages regain opaque data."""
    original = request_for_provider(original, provider)
    originals = {m.get("id"): m for m in original["messages"] if m.get("id")}
    public = provider_projection(request)
    for index, message in enumerate(public["messages"]):
        prior = originals.get(message.get("id"))
        if prior is not None and provider_projection(prior) == message:
            public["messages"][index] = prior
    return public


def response_out(r):
    parts = [p for p in r.get("content", []) if p.get("type") != "toolCall"]
    parts += [
        {
            **{k: v for k, v in c.items() if k != "input"},
            "type": "toolCall",
            "arguments": c["input"],
        }
        for c in r.get("calls", [])
    ]
    usage = r.get("usage") or {}
    return {
        **{k: v for k, v in r.items() if k != "calls"},
        "role": "assistant",
        "content": parts,
        "stop": STOP_OUT.get(r.get("stop"), r.get("stop", "finished")),
        "usage": {
            **{
                k: v
                for k, v in usage.items()
                if k not in {"input_tokens", "output_tokens", "cache_read", "cache_write"}
            },
            "input": usage.get("input_tokens", usage.get("input", 0)),
            "output": usage.get("output_tokens", usage.get("output", 0)),
            "cacheRead": usage.get("cache_read", usage.get("cacheRead", 0)),
            "cacheWrite": usage.get("cache_write", usage.get("cacheWrite", 0)),
            "cost": usage.get("cost", 0),
        },
    }


def response_in(r):
    usage = r.get("usage")
    return {
        **r,
        "calls": [
            {**p, "input": p["arguments"]} for p in r["content"] if p.get("type") == "toolCall"
        ],
        "content": [p for p in r["content"] if p.get("type") != "toolCall"],
        "stop": STOP_IN.get(r["stop"], r["stop"]),
        **(
            {
                "usage": {
                    **usage,
                    "input_tokens": usage.get("input", 0),
                    "output_tokens": usage.get("output", 0),
                    "cache_read": usage.get("cacheRead", 0),
                    "cache_write": usage.get("cacheWrite", 0),
                    "cost": usage.get("cost", 0),
                }
            }
            if isinstance(usage, dict)
            else {}
        ),
    }


def messages_out(messages):
    result = []
    names = {}
    for m in messages:
        kind = m.get("kind")
        if kind is None and "role" in m:
            # Already a shared message, not a native record to project.
            result.append(m)
            continue
        # Keep additive members supplied by a shared request. Native context
        # records instead carry a history envelope and private tool bookkeeping.
        shared = (
            {k: v for k, v in m.items() if k not in {"kind", "data", "call"}} if "role" in m else {}
        )
        if kind == "tool_call":
            names[m["call"]] = m["data"]["name"]
        elif kind == "response":
            r = response_out({**m.get("data", {}), "content": m.get("content", [])})
            for c in r["content"]:
                if c.get("type") == "toolCall":
                    names[c["id"]] = c["name"]
            result.append({**r, **({"id": m["id"]} if m.get("id") else {})})
        elif kind == "tool_result":
            result.append(
                {
                    **shared,
                    **({"id": m["id"]} if m.get("id") else {}),
                    "content": m["content"],
                    "role": "toolResult",
                    "toolCallId": m["call"],
                    "toolName": m.get("data", {}).get(
                        "toolName", m.get("toolName", names.get(m["call"], "unknown"))
                    ),
                    "isError": m.get("data", {}).get("status") != "completed",
                }
            )
        elif kind != "waiting":
            result.append(
                {
                    **shared,
                    **({"id": m["id"]} if m.get("id") else {}),
                    "role": m.get("role", "user"),
                    "content": m.get("content", []),
                }
            )
    return result


def request_out(d):
    return {
        **d.get("_shared_request", {}),
        "systemPrompt": d.get("system", ""),
        "messages": messages_out(d.get("messages", [])),
        "tools": [tool_out(t) for t in d.get("tools", [])],
        "settings": {
            **d.get("_shared_request", {}).get("settings", {}),
            **{
                k: v
                for k, v in settings_out(d.get("settings", {})).items()
                if k in {"reasoning", "maxOutput"}
            },
        },
    }


def model_request_fields(model, request, repeatable, *, auxiliary=False):
    return {
        "data": {
            "model": model,
            "safeToRepeat": repeatable,
            **({"auxiliary": True} if auxiliary else {}),
            "tools": [t["name"] for t in request["tools"]],
            **({"request": request} if repeatable else {}),
        },
        "copies": [m["id"] for m in request["messages"] if m.get("id")],
    }


def request_in(r, d):
    return {
        **d,
        "_shared_request": r,
        "system": r["systemPrompt"],
        "tools": [tool_in(t) for t in r["tools"]],
        "messages": [
            {
                **m,
                "kind": "response"
                if m["role"] == "assistant"
                else "tool_result"
                if m["role"] == "toolResult"
                else "input",
                **({"data": response_in(m)} if m["role"] == "assistant" else {}),
                **(
                    {
                        "call": m["toolCallId"],
                        "data": {"status": "failed" if m.get("isError") else "completed"},
                    }
                    if m["role"] == "toolResult"
                    else {}
                ),
            }
            for m in r["messages"]
        ],
        "settings": {
            **r["settings"],
            **({"thinking": r["settings"]["reasoning"]} if "reasoning" in r["settings"] else {}),
        },
    }


KINDS = {
    "input_queued": "inputAccepted",
    "input_withdrawn": "inputHandedBack",
    "model_started": "modelRequest",
    "result_feedback": "resultFeedback",
    "job_start": "jobStarted",
    "job_end": "jobEnded",
    "job_cleanup_unconfirmed": "jobCleanupUnconfirmed",
    "tool_started": "toolStarted",
    "tool_result": "toolResult",
    "turn_start": "turnStart",
    "turn_end": "turnEnd",
    "question_open": "inputRequest",
    "secret_answer_accepted": "secretAnswerAccepted",
    "question_answer": "inputAnswer",
    "question_closed": "inputAnswer",
    "authority": "actorJoined",
    "actor_joined": "actorJoined",
    "actor_left": "actorLeft",
    "position_move": "position",
    "erase": "erasure",
}
TAGS = {
    "parent": "parentId",
    "session": "sessionId",
    "visible": "modelVisible",
    "copies": "sources",
    "turn": "turnId",
    "step": "stepId",
    "call": "toolCallId",
    "job": "jobId",
    "actor": "actorId",
}
SETTINGS = {"thinking": "reasoning", "max_steps": "maxSteps", "max_output": "maxOutput"}
USAGE = {
    "input_tokens": "input",
    "output_tokens": "output",
    "cache_read": "cacheRead",
    "cache_write": "cacheWrite",
    "cost": "cost",
}


def settings_out(d):
    result = {SETTINGS.get(k, k): v for k, v in d.items()}
    model = result.get("model")
    policy = result.get("approval")
    if isinstance(policy, str):
        result["approval"] = {
            "ask unless read-only": "ask",
            "ask always": "all",
            "never ask, refuse": "never",
        }.get(policy, policy)
    if isinstance(model, str):
        provider, _, name = model.partition("/")
        result["model"] = {
            "provider": "claude" if not name and provider == "claude-haiku-5-5" else provider,
            "id": name or provider,
        }
    return result


def settings_in(d):
    result = {next((a for a, b in SETTINGS.items() if b == k), k): v for k, v in d.items()}
    model = result.get("model")
    if "approval" in result:
        policy = result["approval"]
        result["approval"] = (
            {
                "off": "off",
                "ask": "ask unless read-only",
                "all": "ask always",
                "never": "never ask, refuse",
                "ask unless read-only": "ask unless read-only",
                "ask always": "ask always",
                "never ask, refuse": "never ask, refuse",
            }.get(policy, policy)
            if isinstance(policy, str)
            else "never ask, refuse"
        )
    if isinstance(model, dict):
        result["model"] = (
            model["provider"] + "/" + model["id"]
            if model["provider"] != model["id"]
            else model["id"]
        )
    return result


def usage_out(d):
    return {w: d.get(n, d.get(w, 0)) for n, w in USAGE.items()}


def kind_out(kind):
    if kind in KINDS:
        return KINDS[kind]
    if "." in kind or kind in {
        "input",
        "response",
        "summary",
        "setting",
        "erasure",
        "plugins",
        "limit",
        "tenant",
    }:
        return kind
    return "python." + kind


def recorded_as(entry, kind):
    """An erased record still closes the operation named by its identities."""
    return entry["kind"] == kind or (
        entry.get("data", {}).get("erased") and entry["data"].get("originalKind") == kind_out(kind)
    )


def entry_out(e):
    if "sessionId" in e and "session" not in e:
        return e
    kind = kind_out(e["kind"])
    if e.get("data", {}).get("erased") or e.get("erased"):
        return {
            "id": e["id"],
            "parentId": e["parent"],
            "kind": e.get("data", {}).get("originalKind", kind),
            "erased": True,
            **({"requestId": e["data"]["request"]} if e.get("data", {}).get("request") else {}),
            **{TAGS[k]: e[k] for k in ("turn", "step", "call", "job") if e.get(k) is not None},
            **({"sources": e["copies"]} if e.get("data", {}).get("interfaceErasure") else {}),
            **{
                k: e["wire_fields"][k]
                for k in ("inputId", "requestId", "continuesTurnId", "sources", "usage", "jobKey")
                if k in e.get("wire_fields", {})
            },
        }
    r = {
        **{k: v for k, v in e.items() if k not in {*TAGS, "content", "wire_fields"}},
        **e.get("wire_fields", {}),
        **{
            new: e[old]
            for old, new in TAGS.items()
            if old in e and (e[old] is not None or old == "parent")
        },
        "kind": kind,
        "time": int(datetime.fromisoformat(e["time"]).timestamp() * 1000),
    }
    d = e.get("data", {})
    if kind == "actorJoined" and d.get("operatorAdmission") is True:
        r.pop("actorId", None)
    if kind == "inputAccepted":
        r["inputId"] = d.get("input", e["id"])
        r["data"] = {
            **{
                k: v
                for k, v in d.items()
                if v is not None and k not in {"input", "inputId", "authority"}
            },
            **({"rights": d["authority"]} if d.get("authority") is not None else {}),
            "content": e["content"],
        }
    elif kind == "inputHandedBack":
        r["inputId"] = d["input"]
        r["data"] = {"reason": d["reason"]} if d.get("reason") else {}
    elif kind == "input":
        r["inputId"] = d.get("input", e["id"])
        r["message"] = {"role": "user", "content": e["content"]}
        r["data"] = {k: v for k, v in d.items() if k not in {"input", "inputId"}}
    elif kind == "python.tool_call":
        r["modelVisible"] = False
    elif kind == "response":
        r["message"] = response_out({**d, "content": e["content"]})
    elif kind == "python.tool_deferred" and d.get("requestIds"):
        r["kind"] = "toolPending"
    elif kind == "toolStarted":
        call = d.get("call") or {"id": e["call"], "name": d.get("name", "unknown"), "input": {}}
        r["data"] = {**d, "call": call_out(call), "safeToRepeat": bool(d.get("safeToRepeat"))}
    elif kind == "toolResult":
        r["message"] = {
            "role": "toolResult",
            "toolCallId": e["call"],
            "toolName": d.get("toolName", "unknown"),
            "content": e["content"],
            "isError": d["status"] != "completed",
        }
        r["data"] = {**d, "status": STATUS_OUT.get(d["status"], d["status"])}
    elif kind == "setting":
        changes = settings_out(d)
        key = next(iter(changes)) if len(changes) == 1 else "settings"
        r["data"] = {"key": key, "value": changes[key] if len(changes) == 1 else changes}
    elif kind == "turnStart":
        snapshot = dict(d)
        source = snapshot.pop("source", None) or {}
        started_by = (
            {"kind": "job", "id": source["job"]}
            if source.get("job")
            else {"kind": "answer", "id": source["questions"][-1]}
            if source.get("questions")
            else {"kind": "actor", "id": e.get("actor", "user")}
        )
        r["data"] = {**snapshot, "startedBy": snapshot.get("startedBy") or started_by}
        if source.get("continuesTurnId"):
            r["continuesTurnId"] = source["continuesTurnId"]
    elif kind == "turnEnd":
        r["data"] = {**d, **turn_end_out(d), "usage": usage_out(d.get("usage") or {})}
    elif kind == "summary":
        r["data"] = {**d, "summary": plain(e["content"])}
        r["sources"] = list(dict.fromkeys([*e.get("copies", []), *d.get("covers", [])]))
    elif kind == "jobStarted":
        r["data"] = {**d, "rights": d.get("authority", d.get("rights", ["watch"]))}
    elif kind == "jobEnded":
        outcome = {"kind": d["state"] if d["state"] != "outcome_unknown" else "failed"}
        if d.get("error"):
            outcome["error"] = d["error"]
        r["data"] = {**d, "outcome": outcome, "report": bool(d.get("report", True))}
    elif kind == "inputRequest":
        r["requestId"] = d["id"]
        r["data"] = {
            **(d.get("approval_registration") or {}),
            "request": {
                **d,
                "id": d["id"],
                "sessionId": e["session"],
                "answerable": d.get("answerable", True),
                "askedBy": d["asker"],
                **(
                    {"answerers": d["restrictedResponders"]}
                    if d.get("restrictedResponders") is not None
                    else {}
                ),
                "toolCallId": d.get("call"),
                "credential": d.get("name"),
                "timeLimitMs": d.get(
                    "timeLimitMs", d["timeout"] * 1000 if d.get("timeout") is not None else None
                ),
                "whenTimeLimit": "leaveOpen" if d.get("park") else "decline",
            },
        }
    elif kind == "secretAnswerAccepted":
        r["requestId"] = d["request"]
        r["actorId"] = d["actor"]
        r.pop("data", None)
    elif kind == "inputAnswer":
        value = d.get("value")
        r["requestId"] = d["request"]
        r.pop("actorId", None)
        r["data"] = {}
        declined = d.get("declined", value == "declined")
        system_closed = e["kind"] == "question_closed" or (
            declined
            and d.get("system") is not False
            and d.get("reason")
            in {"timeLimit", "cancelled", "noLongerAnswerable", "refused", "superseded"}
        )
        if (
            system_closed
            and d.get("cause") == "revoked"
            and d.get("reason") in {"refused", "noLongerAnswerable"}
        ):
            r["data"]["cause"] = "revoked"
        if not system_closed:
            r["data"]["actorId"] = d.get("actor", e.get("actor", "user"))
            if d.get("actingFor"):
                r["data"]["actingFor"] = d["actingFor"]
        if isinstance(value, dict) and "credential" in value:
            r["data"]["stored"] = value["credential"]
        elif declined or e["kind"] == "question_closed":
            r["data"]["declined"] = True
            if d.get("reason") or e["kind"] == "question_closed":
                r["data"]["reason"] = d.get("reason", "noLongerAnswerable")
        else:
            r["data"]["value"] = value
            if "approvalView" in d:
                r["data"]["approvalView"] = d["approvalView"]
    elif kind == "actorJoined" and e["kind"] == "authority":
        r["data"] = {
            "actor": {"id": d["subject"], "kind": d.get("kind", "user"), "rights": d["authority"]}
        }
    elif kind == "erasure":
        r["data"] = {**d, "entryIds": d.get("entryIds", d.get("entries", []))}
    elif e.get("visible") and e.get("content"):
        r["message"] = {"role": "user", "content": e["content"]}
    elif e.get("content"):
        r["pythonContent"] = e["content"]
    return r


def turn_end_out(d):
    outcome = d.get("shared_outcome")
    if outcome is None:
        outcome = {"kind": d["outcome"]}
        if d["outcome"] == "limit":
            outcome["limit"] = {
                "step limit": "steps",
                "output limit": "output",
                "session token limit": "sessionTokens",
            }.get(d.get("error"), d.get("error") or "steps")
        elif d.get("error"):
            outcome["error"] = d["error"]
    result = d.get("shared_result") or {
        "text": plain(d.get("content", [])),
        "openToolCalls": d.get("open_calls", []),
        **({"value": d["value"]} if "value" in d else {}),
    }
    return {"outcome": outcome, "result": result}


def question_signature(q):
    fields = {
        k: q[k]
        for k in (
            "kind",
            "question",
            "options",
            "name",
            "binding",
            "details",
            "approval_call",
            "approval_registration",
            "coversNested",
        )
        if k in q
    }
    return json.dumps(
        {
            **fields,
            "responders": q.get("restrictedResponders"),
            "timeout": float(q["timeout"]) if q.get("timeout") is not None else None,
            "park": q["park"],
            "call": q.get("call"),
        },
        sort_keys=True,
    )


def validate_recorded_approval(settings):
    if isinstance(settings, dict) and "approval" in settings:
        if not isinstance(settings["approval"], str):
            raise ValueError("Recorded approval must be a string")


def entry_in(e, sid, default_actor="user"):
    if "session" in e and "sessionId" not in e:
        raise ValueError("History entry lacks its sessionId")
    from datetime import UTC

    kind = e["kind"]
    native = {v: k for k, v in KINDS.items() if k not in {"question_closed", "authority"}}.get(
        kind, kind.removeprefix("python.")
    )
    message = e.get("message") or {}
    d = e.get("data") or {}
    result = {
        "id": e["id"],
        "session": sid,
        "parent": e.get("parentId"),
        "kind": native,
        "writer": e.get("writer", "history"),
        **(
            {"actor": e.get("actorId") or default_actor}
            if kind != "toolResult" or "actorId" in e
            else {}
        ),
        "time": datetime.fromtimestamp(e.get("time", 0) / 1000, UTC).isoformat(),
        "visible": e.get("modelVisible", False),
        "copies": e.get("sources") or [],
        "content": message.get("content", e.get("pythonContent", [])),
        "data": d,
        "wire_fields": {
            k: v
            for k, v in e.items()
            if k
            not in {
                *TAGS.values(),
                "id",
                "kind",
                "time",
                "writer",
                "data",
                "message",
                "pythonContent",
                "erased",
            }
        },
    }
    result.update(
        {
            old: e[new]
            for old, new in TAGS.items()
            if old in {"turn", "step", "call", "job"} and e.get(new) is not None
        }
    )
    if "fork_source" in e:
        result["fork_source"] = e["fork_source"]
    if e.get("erased"):
        return {
            **result,
            "kind": "erasure",
            "visible": False,
            "data": {
                "erased": True,
                "originalKind": kind,
                **({"input": e["inputId"]} if "inputId" in e else {}),
            },
        }
    if kind == "inputAccepted":
        result.update(
            content=d["content"],
            data={
                **{k: v for k, v in d.items() if k != "inputId"},
                "input": e["inputId"],
                "authority": d.get("rights", d.get("authority")),
            },
        )
    elif kind in {"inputHandedBack", "input"}:
        result["data"] = {
            **{k: v for k, v in d.items() if k not in {"inputId", "inputIds"}},
            "input": e["inputId"],
        }
    elif kind == "response":
        response = response_in(message)
        result.update(data={**d, **response}, content=response["content"])
        result["data"]["usage"] = {k: (response.get("usage") or {}).get(k, 0) for k in USAGE}
    elif kind == "turnStart":
        validate_recorded_approval(d.get("settings"))
        if not e.get("actorId"):
            started_by = d.get("startedBy") or {}
            if started_by.get("kind") == "actor":
                result["actor"] = started_by["id"]
        data = {k: v for k, v in d.items() if k != "continuesTurnId"}
        if isinstance(source := data.get("source"), dict):
            data["source"] = {k: v for k, v in source.items() if k != "continuesTurnId"}
        result["data"] = data
    elif kind == "toolPending":
        result["kind"] = "tool_deferred"
    elif kind == "toolStarted":
        result["data"] = {**d, "call": call_in(d["call"])}
    elif kind == "toolResult":
        result["data"] = {
            **d,
            "status": STATUS_IN.get(d["status"], d["status"]),
            "toolName": message.get("toolName", "unknown"),
        }
    elif kind == "setting":
        patch = d["value"] if d["key"] == "settings" else {d["key"]: d["value"]}
        validate_recorded_approval(patch)
        result["data"] = settings_in(patch)
    elif kind == "turnEnd":
        outcome, final = d["outcome"], d["result"]
        limit = {"steps": "step limit", "output": "output limit"}.get(
            outcome.get("limit"), "session token limit"
        )
        result["data"] = {
            **d,
            "shared_outcome": outcome,
            "shared_result": final,
            "outcome": outcome["kind"],
            "error": outcome.get("error") or (limit if outcome["kind"] == "limit" else None),
            "open_calls": final["openToolCalls"],
            "content": d.get("content", [{"type": "text", "text": final.get("text", "")}]),
            "usage": {n: (d.get("usage") or {}).get(w, 0) for n, w in USAGE.items()},
        }
    elif kind == "summary":
        result["data"] = {**d, "covers": d.get("covers", e.get("sources", []))}
        result["content"] = [{"type": "text", "text": d["summary"]}]
    elif kind == "jobEnded":
        result["data"] = {
            **d,
            "state": d.get("state", d["outcome"]["kind"]),
            "result": d.get("result") or [],
        }
    elif kind == "jobStarted":
        result["data"] = {
            **d,
            "owner": result["writer"],
            "authority": d.get("rights") if d.get("rights") is not None else ["watch"],
            "key": d.get("key"),
            "report": d.get("report", True),
        }
    elif kind == "inputRequest":
        q = d["request"]
        if q["id"] != e["requestId"]:
            raise ValueError("Question ID does not match the envelope requestId")
        name = q.get("credential", q.get("name"))
        details = {
            "kind": q["kind"],
            "question": q["question"],
            "options": q.get("options", []),
            "name": name,
            "binding": q.get("binding"),
        }
        result["data"] = {
            **q,
            **details,
            "key": q.get("key") or q["id"],
            "asker": q.get("askedBy", q.get("asker", e["writer"])),
            "restrictedResponders": q.get("answerers"),
            **(
                {
                    "approval_registration": {k: d[k] for k in ("call", "source", "definition")},
                    "approval_call": {k: d["call"][k] for k in ("name", "input")},
                }
                if all(k in d for k in ("call", "source", "definition"))
                else {}
            ),
            "actor": q.get("actor", result["actor"]),
            "authority": q.get("authority"),
            "responders": q.get("responders", [default_actor]),
            "call": q.get("toolCallId") or result.get("call"),
            "turn": result.get("turn"),
            "step": result.get("step"),
            "timeout": q["timeLimitMs"] / 1000 if q.get("timeLimitMs") is not None else None,
            "park": q.get("whenTimeLimit") == "leaveOpen",
        }
        signature = question_signature(result["data"])
        if "signature" in q and q["signature"] != signature:
            raise ValueError("Question signature does not match the recorded request")
        result["data"]["signature"] = signature
    elif kind == "secretAnswerAccepted":
        result["data"] = {"request": e["requestId"], "actor": e["actorId"]}
    elif kind == "inputAnswer":
        value = (
            {"credential": d["stored"]}
            if d.get("stored")
            else "declined"
            if d.get("declined")
            else d.get("value")
        )
        if d.get("declined") and not d.get("actorId"):
            result["kind"] = "question_closed"
        result["data"] = {
            **{k: v for k, v in d.items() if k != "requestId"},
            **(
                {"system": False}
                if d.get("actorId") and d.get("declined") and d.get("reason")
                else {}
            ),
            "request": e["requestId"],
            "actor": d.get("actorId", result["actor"]),
            "value": value,
            "declined": d.get("declined", False),
        }
    return result
