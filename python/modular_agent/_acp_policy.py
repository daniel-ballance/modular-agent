"""The operator-owned policy file; project settings do not enter this parser."""

import json
import os
from pathlib import Path
from typing import Any, TypedDict, NotRequired, cast

from ._agent import ACP_RIGHTS, AcpActor, read_service_token, tenants_from_environment
from ._types import Actor

MIB = 1 << 20
FIELDS = ("inputs", "calls", "jobs", "bufferedBytes", "storageBytes", "controlBytes")
DEFAULT_LIMITS = {
    scope: dict(zip(FIELDS, values, strict=True))
    for scope, values in (
        ("session", (32, 64, 16, 16 * MIB, 1024 * MIB, 8 * MIB)),
        ("tenant", (128, 256, 64, 64 * MIB, 8192 * MIB, 32 * MIB)),
        ("agent", (512, 1024, 256, 256 * MIB, 32768 * MIB, 128 * MIB)),
    )
}


class StdioPolicy(TypedDict):
    actor: Actor
    trace_trusted: bool
    projects: NotRequired[list[Path]]
    tenants: NotRequired[list[str | None]]
    represents: NotRequired[list[str]]


class AcpPolicy:
    def __init__(self, path: Path, *, required: bool, several_actors: bool = False):
        self.path = path
        try:
            try:
                with path.open(encoding="utf-8") as source:
                    info = os.fstat(source.fileno())
                    if info.st_uid not in (0, os.geteuid()) or info.st_mode & 0o022:
                        raise ValueError(
                            "must be owned by the operator and not group or world writable"
                        )
                    raw = json.load(source, object_pairs_hook=_object)
            except FileNotFoundError:
                if required or path.is_symlink():
                    raise
                raw = {}
            _shape(raw, {"stdio", "actors", "limits"}, "policy")
            self.stdio = (
                cast(StdioPolicy, _principal(raw["stdio"], several_actors=several_actors))
                if "stdio" in raw
                else None
            )
            self.actors: list[AcpActor] | None = None
            if "actors" in raw:
                self.actors = []
                tokens: set[str] = set()
                kinds: dict[str, str] = {}
                if not isinstance(raw["actors"], list) or not raw["actors"]:
                    raise ValueError("actors must be a nonempty array")
                for value in raw["actors"]:
                    item = _principal(value, network=True, several_actors=several_actors)
                    if "clientId" in item:
                        client = item.pop("clientId")
                        if not isinstance(client, str) or not client:
                            raise ValueError("clientId must be a nonempty string")
                        item["client_id"] = client
                    filename = item.pop("tokenFile", None)
                    if not isinstance(filename, str) or not filename:
                        raise ValueError("actors requires a tokenFile path")
                    token_file = (path.absolute().parent / filename).resolve(strict=True)
                    token = read_service_token(token_file)
                    if token in tokens:
                        raise ValueError("actors must use distinct tokens")
                    tokens.add(token)
                    actor = item["actor"]
                    if kinds.setdefault(actor["id"], actor["kind"]) != actor["kind"]:
                        raise ValueError("actors with the same id must use the same kind")
                    self.actors.append(cast(AcpActor, {**item, "token_file": token_file}))
            self.limits = _limits(raw.get("limits", {}))
            configured = (self.stdio, *(self.actors or ()))
            named = any(
                t is not None for scope in configured if scope for t in scope.get("tenants", ())
            )
            self.tenants = (tenants_from_environment() or None) if named else None
        except Exception as exc:
            raise ValueError(f"policy {path}: {exc}") from exc


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate policy key: {key}")
        value[key] = item
    return value


def _shape(value: Any, keys: set[str], name: str) -> None:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    if extra := value.keys() - keys:
        raise ValueError(f"unknown {name} key: {sorted(extra)[0]}")


def _principal(
    value: Any, *, network: bool = False, several_actors: bool = False
) -> dict[str, Any]:
    _shape(
        value,
        {
            "actor",
            "projects",
            "tenants",
            "represents",
            "traceTrusted",
            *(["tokenFile", "clientId"] if network else []),
        },
        "actors entry" if network else "stdio",
    )
    trusted = value.pop("traceTrusted", not network)
    if not isinstance(trusted, bool):
        raise ValueError("traceTrusted must be a boolean")
    value["trace_trusted"] = trusted
    actor = value.get("actor")
    _shape(actor, {"id", "kind", "rights"}, "actor")
    if not isinstance(actor.get("id"), str) or not actor["id"]:
        raise ValueError("actor id must be a nonempty string")
    if actor.get("kind") not in ("host", "user", "program", "agent"):
        raise ValueError("invalid actor kind")
    rights = actor.get("rights")
    if not isinstance(rights, list) or any(
        not isinstance(r, str) or r not in ACP_RIGHTS for r in rights
    ):
        raise ValueError("rights must be an array of known rights")
    represents = value.get("represents", [])
    if not isinstance(represents, list) or any(not isinstance(a, str) or not a for a in represents):
        raise ValueError("represents must be an array of actor IDs")
    if represents and not several_actors:
        raise ValueError("ma requires represents to be an empty array")
    if "tenants" in value and (
        not isinstance(value["tenants"], list)
        or any(t is not None and (not isinstance(t, str) or not t) for t in value["tenants"])
    ):
        raise ValueError("tenants must be an array of tenant IDs or null")
    if "projects" in value:
        projects = value["projects"]
        if not isinstance(projects, list) or any(
            not isinstance(p, str) or not Path(p).is_absolute() or not Path(p).is_dir()
            for p in projects
        ):
            raise ValueError("projects must contain absolute project directories")
        value["projects"] = [Path(p).resolve(strict=True) for p in projects]
    return cast(dict[str, Any], value)


def _limits(value: Any) -> dict[str, dict[str, int]]:
    _shape(value, set(DEFAULT_LIMITS), "limits")
    result = {}
    for scope, defaults in DEFAULT_LIMITS.items():
        changes = value.get(scope, {})
        _shape(changes, set(FIELDS), f"limits.{scope}")
        if any(type(v) is not int or not 0 <= v < 2**53 for v in changes.values()):
            raise ValueError(f"limits.{scope} must contain nonnegative integer counts")
        limits = {**defaults, **changes}
        if limits["controlBytes"] > limits["storageBytes"]:
            raise ValueError(f"limits.{scope}.controlBytes exceeds storageBytes")
        result[scope] = limits
    return result
