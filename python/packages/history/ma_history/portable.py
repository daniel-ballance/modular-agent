"""Project an open session from the ordered shared history record."""

from ma_core.wire import entry_in

from .profile import fork_prefix
from .service import tombstone


def session_view(meta, records, defaults=None):
    actor = (defaults or {}).get("actor", "user")
    entries = [entry_in(e, meta["id"], actor) for e in records]
    prefix = fork_prefix(meta, records)
    settings = dict((defaults or {}).get("settings", {}))
    settings["approval"] = "ask always"
    actors = dict((defaults or {}).get("actors", {}))
    has_actor_record = "actors" in (defaults or {})
    departed = set((defaults or {}).get("departed", []))
    position = None
    tenant, limit = None, None
    erased = {
        eid
        for e in entries
        if e["kind"] in {"erase", "erasure"}
        for eid in e["data"].get("entryIds", [])
    }
    identities = {
        eid: ids
        for e in entries
        if e["kind"] in {"erase", "erasure"}
        for eid, ids in e["data"].get("identities", {}).items()
    }
    for index, e in enumerate(entries):
        kind, data = e["kind"], e.get("data", {})
        if e["id"] in erased and not data.get("erased"):
            e = entries[index] = entry_in(tombstone(records[index]), meta["id"], actor)
            kind, data = e["kind"], e["data"]
        if data.get("erased"):
            for native, wire in (
                ("turn", "turnId"),
                ("step", "stepId"),
                ("call", "toolCallId"),
                ("job", "jobId"),
            ):
                if wire in identities.get(e["id"], {}):
                    e[native] = identities[e["id"]][wire]
        if e["id"] in prefix:
            if origin := prefix[e["id"]]:
                e["fork_source"] = origin[1]
            position = e["id"]
            continue  # Copied records do not grant authority in the fork.
        if e.get("fork_source"):
            position = e["id"]
            continue  # Legacy native projection.
        if kind == "position_move":
            position = data["to"]
            continue
        position = e["id"]
        if kind == "setting":
            settings.update(data)
        elif kind == "actor_joined":
            has_actor_record = True
            a = data["actor"]
            departed.discard(a["id"])
            actors[a["id"]] = {
                "kind": "program" if a["kind"] == "plugin" else a["kind"],
                "authority": a["rights"],
            }
        elif kind == "tenant":
            tenant = data["tenant"]
        elif kind == "limit":
            limit = data["rights"]
        elif kind == "actor_left":
            has_actor_record = True
            actors.pop(data["actorId"], None)
            departed.add(data["actorId"])
    # Record insertion order is never changed. Native helpers below use standard
    # turnEnd and assistant calls as the source of late continuation state.
    origin = (defaults or {}).get("origin")
    if fork := meta.get("forkedFrom"):
        origin = {"session": fork["sessionId"], "point": fork.get("entryId")}
    return {
        **(defaults or {}),
        **meta,
        "origin": origin,
        "actor": actor,
        "settings": settings,
        "tenant": tenant,
        "limit": limit,
        "departed": sorted(departed),
        **({"actors": actors} if has_actor_record else {}),
        "entries": entries,
        "position": position,
    }
