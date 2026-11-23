"""Translate recipient events at the shared output gate boundary."""

from ma_core.wire import STATUS_IN, call_in, entry_in, entry_out, turn_end_out


def safe_shape(before, after, protected=False):
    if type(before) in {int, float} and type(after) in {int, float}:
        return before == after
    if type(before) is not type(after):
        return False
    if isinstance(before, dict):
        immutable = {
            "type",
            "kind",
            "status",
            "method",
            "stop",
            "id",
            "rights",
            "key",
            "credential",
        }
        return before.keys() == after.keys() and all(
            safe_shape(v, after[k], protected or k in immutable or k.endswith(("Id", "Ids")))
            for k, v in before.items()
        )
    if isinstance(before, list):
        return len(before) == len(after) and all(
            safe_shape(a, b, protected) for a, b in zip(before, after, strict=True)
        )
    return before == after or (isinstance(before, str) and not protected)


def overlay(native, before, after, *, normalized=False):
    """Apply changes to the native view without replacing untouched native fields."""
    if before == after:
        return native
    if isinstance(before, dict) and isinstance(after, dict) and before.keys() == after.keys():
        result = dict(native)
        for key in before:
            if before[key] != after[key]:
                if key not in native:
                    if not normalized:
                        raise ValueError("Cannot map output field")
                    # The decoder may add alternate spellings of fields that
                    # the native entry does not store. Keep the original shape.
                    continue
                result[key] = overlay(native[key], before[key], after[key], normalized=normalized)
        return result
    if isinstance(before, list) and isinstance(after, list) and len(before) == len(after):
        return [
            overlay(n, b, a, normalized=normalized)
            for n, b, a in zip(native, before, after, strict=True)
        ]
    if isinstance(before, str) and isinstance(after, str) and isinstance(native, str):
        return after
    raise ValueError("Output gate changed more than strings")


def project(event):
    kind, data = event["type"], event["data"]
    if kind in {"reply", "entry", "request", "toolCall"}:
        return [(event, lambda _, after: overlay(data, data, after))]
    if kind == "model_output":
        event_type = data.get("stream_type", "text")
        fields = {"delta": "text", "stepId": "step"}
    elif kind == "session_interrupted":
        # Like an outcome kind, the reason is a protocol tag, not display text.
        def restore_interruption(native, changed):
            if changed != {"reason": native["reason"]}:
                raise ValueError("The interruption reason cannot be redacted")
            return native

        return [
            (
                {"type": "sessionInterrupted", "data": {"reason": data["reason"]}},
                restore_interruption,
            )
        ]
    elif kind == "tool_progress":
        event_type = "toolOutput"
        fields = {"toolCallId": "call", "chunk": "text", "content": "content"}
    elif kind in {"history_entry", "history_view"}:
        e = data["entry"]
        wire = entry_out(e)

        def restore_entry(native, changed):
            after = changed["entry"]
            if wire == after:
                return native
            # Compare normalized views so the unmodified event keeps its native shape.
            overlay(wire, wire, after)
            scope = (e["session"], e.get("actor", "user"))
            return {
                **native,
                "entry": overlay(
                    e, entry_in(wire, *scope), entry_in(after, *scope), normalized=True
                ),
            }

        views = [({"type": "entry", "data": {"entry": wire}}, restore_entry)]
        if kind == "history_entry" and wire["kind"] == "toolStarted" and not wire.get("erased"):
            call = wire["data"]["call"]

            def restore_call(native, changed):
                after = changed["call"]
                overlay(call, call, after)
                entry = native["entry"]
                return {
                    **native,
                    "entry": {
                        **entry,
                        "data": {
                            **entry["data"],
                            "call": overlay(entry["data"]["call"], call_in(call), call_in(after)),
                        },
                    },
                }

            views.append(({"type": "toolCall", "data": {"call": call}}, restore_call))
        if kind == "history_entry" and wire["kind"] == "toolResult" and not wire.get("erased"):
            result = {
                "toolCallId": wire["toolCallId"],
                "status": wire["data"]["status"],
                "content": wire["message"]["content"],
            }

            def restore_result(native, changed):
                overlay(result, result, changed)
                entry = native["entry"]
                for shared, key in (("content", "content"), ("toolCallId", "call")):
                    if changed[shared] != result[shared]:
                        entry = {**entry, key: changed[shared]}
                status = changed["status"]
                if status != result["status"]:
                    entry = {
                        **entry,
                        "data": {**entry["data"], "status": STATUS_IN.get(status, status)},
                    }
                return {**native, "entry": entry}

            views.append(({"type": "toolResult", "data": result}, restore_result))
        return views
    elif kind == "turn_ended":
        shape = {"turnId": data["turn"], **turn_end_out(data)}

        def restore_turn(native, changed):
            overlay(shape, shape, changed)
            outcome, result = changed["outcome"], changed["result"]
            return {
                **native,
                "turn": changed["turnId"],
                "outcome": outcome["kind"],
                "error": outcome.get("error", native.get("error")),
                "shared_outcome": outcome,
                "shared_result": result,
                "open_calls": result["openToolCalls"],
                "content": (
                    [{"type": "text", "text": result["text"]}]
                    if result.get("text") != shape["result"].get("text")
                    else native["content"]
                ),
            }

        return [({"type": "turnEnded", "data": shape}, restore_turn)]
    else:
        return [
            (
                {"type": kind if "." in kind else "python." + kind, "data": data},
                lambda _, after: overlay(data, data, after),
            )
        ]
    shape = {shared: data[key] for shared, key in fields.items() if data.get(key) is not None}

    def restore(native, after):
        changed = overlay(shape, shape, after)
        return {**native, **{fields[key]: value for key, value in changed.items()}}

    return [({"type": event_type, "data": shape}, restore)]


async def gate(harness, sid, recipient, events):
    if not harness.holds_output():
        return events
    try:
        adapters = [project(item) for item in events]
        shared = [event for group in adapters for event, _ in group]
        answer = await harness.fire(
            "@harness",
            "binding.output",
            {
                "sessionId": sid or "",
                "recipient": recipient,
                "events": shared,
                "final": True,
            },
        )
        if answer.get("refused") or len(answer["events"]) != len(shared):
            return []
        changed = iter(answer["events"])
        result = []
        for item, group in zip(events, adapters, strict=True):
            native = item["data"]
            for before, restore in group:
                after = next(changed)
                if not safe_shape(before, after):
                    return []
                if before["data"] != after["data"]:
                    native = restore(native, after["data"])
            result.append({**item, "data": native})
        return result
    except (ValueError, TypeError, KeyError, AttributeError):
        return []
