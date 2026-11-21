"""Session authority. Local Interfaces bind authenticated identities, not permissions."""

import json
import math
from contextvars import ContextVar

from ma_core import AgentError, clone
from ma_core.wire import usage_out

PERMISSIONS = {
    "watch",
    "propose",
    "input",
    "answer",
    "approve",
    "settings",
    "erase",
    "grant",
    "jobs",
    "delegate",
    "tools",
    "cancel",
    "administer",
}


def read_tenants(raw):
    try:
        tenants = json.loads(raw)
        if not isinstance(tenants, dict):
            raise ValueError
        for name, config in tenants.items():
            rights, tokens = config["rights"], config.get("tokens")
            if (
                not name
                or not isinstance(rights, list)
                or not all(isinstance(r, str) for r in rights)
            ):
                raise ValueError
            if tokens is not None and (
                type(tokens) not in {int, float} or not math.isfinite(tokens) or tokens < 0
            ):
                raise ValueError
        return tenants
    except (KeyError, TypeError, ValueError, AttributeError, OverflowError):
        raise AgentError("Invalid MODULAR_AGENT_TENANTS configuration") from None


# Only an authenticated Interface installs this context; request data cannot
# supply it. Child work also records its granted ceiling at admission.
CONNECTION_AUTHORITY = ContextVar("connection_authority", default=None)


class Authority:
    def tenant_config(self, name):
        if name is None:
            return {}
        if not isinstance(name, str) or name not in self.tenants:
            raise AgentError("Unknown tenant", "forbidden")
        return self.tenants[name]

    def session_ceiling(self, s):
        allowed = set(s.get("authority", PERMISSIONS)) & self.admin & self.tenant & PERMISSIONS
        if s.get("limit") is not None:
            allowed &= set(s["limit"]) | {"administer"}
        tenant = self.tenant_config(s.get("tenant"))
        if tenant:
            allowed &= set(tenant["rights"])
        return allowed

    async def tenant_info(self, s):
        name = s.get("tenant")
        config = self.tenant_config(name)
        budget = config.get("tokens")
        tokens = None
        if budget is not None:
            sessions = dict(self.sessions)
            if "history" in self.capabilities:
                for item in await self.call("@harness", "history", "list", {}):
                    if item["id"] not in sessions:
                        saved = await self.call(
                            "@harness", "history", "read", {"session": item["id"]}
                        )
                        if saved is not None:
                            sessions[item["id"]] = saved
            used = 0
            for saved in sessions.values():
                if saved.get("tenant") != name:
                    continue
                entries = [e for e in saved["entries"] if not e.get("fork_source")]
                ended = {e.get("turn") for e in entries if e["kind"] == "turn_end"}
                for e in entries:
                    if e["kind"] == "turn_end" or (
                        e["kind"] == "response" and e.get("turn") not in ended
                    ):
                        usage = usage_out(e.get("data", {}).get("usage", {}))
                        used += usage["input"] + usage["output"]
            tokens = {"budget": budget, "used": used}
        return {"tenant": name, "rights": config.get("rights"), "tokens": tokens}

    def connection_allows(self, s):
        connection = CONNECTION_AUTHORITY.get()
        return connection is None or connection[3](s)

    def can_open(self, s, actor, *, local=False):
        if not self.connection_allows(s):
            return False
        if actor in s.get("actors", {}):
            return "watch" in self.permissions(s, actor)
        # Local stdio retains the operator fallback for an unrecorded principal.
        if not local or actor in s.get("departed", []):
            return False
        connection = CONNECTION_AUTHORITY.get()
        ceiling = connection[1] if connection else None
        rights = self.session_ceiling(s)
        return "watch" in rights and (ceiling is None or "watch" in ceiling)

    def permissions(self, s, actor, ceiling=None):
        if not self.connection_allows(s):
            return set()
        actors = s.get("actors", {s["actor"]: {"authority": sorted(PERMISSIONS)}})
        if actor not in actors:
            return set()
        allowed = set(actors[actor]["authority"]) & self.session_ceiling(s)
        origin = s.get("origin") or {}
        if origin.get("parent"):
            parent = self.sessions.get(origin["parent"])
            if parent is None:
                return set()
            allowed &= self.permissions(parent, origin["actor"], origin.get("authority"))
        if connection := CONNECTION_AUTHORITY.get():
            principal, token_rights, grants, _ = connection
            if actor == principal and token_rights is not None:
                allowed &= grants.get(s["id"], token_rights)
        if ceiling is not None:
            allowed &= set(ceiling)
        return allowed

    def require(self, s, actor, permission, ceiling=None):
        if permission not in self.permissions(s, actor, ceiling):
            raise AgentError("Actor lacks authority: " + permission, "forbidden")

    async def authorize(self, target, operation, data):
        public = {
            "create",
            "open",
            "list",
            "commands",
            "config_view",
            "command",
            "get",
            "branch",
            "settings",
            "move",
            "fork",
            "erase",
            "close",
            "declaration",
            "grant",
            "leave",
            "authority",
            "limit",
            "tenant",
            "children",
            "view",
            "erasure_cutoff",
        }
        if target == "@harness" and (
            operation not in public
            or data.get("recover") is False
            or (operation == "create" and any(k in data for k in ("id", "origin", "draft")))
        ):
            raise AgentError("Session operation is private", "forbidden")
        if target not in {"@harness", "runtime", "questions", "credentials", "jobs"}:
            capability = self.capabilities.get(target)
            if not capability or getattr(capability[1], "role", None) != "interface":
                raise AgentError("Use the checked Runtime or session API", "forbidden")
        if not data.get("session") or data["session"] not in self.sessions:
            return
        s = self.sessions[data["session"]]
        if not self.connection_allows(s):
            raise AgentError("Session inaccessible", "forbidden")
        if operation not in {
            "erase",
            "erasure_cutoff",
            "cancel",
            "leave",
            "close",
            "limit",
            "grant",
            "authority",
            "disconnect",
            "answer",
            "withdraw",
            "withdraw_proposal",
        } and not (operation == "view" and data.get("method") == "_modular-agent/erase"):
            await self.guard_erasure(s["id"], reconcile=True)
            s = self.sessions[data["session"]]
        actor = data.get("actor", s["actor"])
        permission = "watch"
        if target == "runtime":
            permission = {
                "submit": "propose" if data.get("when") == "propose" else "input",
                "release": "input",
                "withdraw": "input",
                "cancel": "cancel",
                "run_tool": "tools",
            }.get(operation, "watch")
            if operation not in {
                "submit",
                "release",
                "withdraw",
                "withdraw_proposal",
                "proposals",
                "cancel",
                "run_tool",
                "wait",
            }:
                raise AgentError("Runtime operation is private", "forbidden")
            if operation == "withdraw_proposal":
                return  # Runtime checks proposal ownership and effective input rights together.
        elif target == "questions":
            if operation not in {"connect", "disconnect", "list", "answer", "present"}:
                raise AgentError("Question operation is private", "forbidden")
            # These operations check membership or answer authority separately.
            if operation in {"connect", "disconnect", "answer"}:
                return
            permission = "watch"
        elif target == "credentials":
            if operation != "answer":
                raise AgentError("Credential operation is private", "forbidden")
            permission = "answer"
        elif target == "jobs":
            if operation not in {"list", "cancel", "wait", "usage"}:
                raise AgentError("Job operation is private", "forbidden")
            permission = "cancel" if operation == "cancel" else "watch"
        elif target == "@harness":
            permission = {
                "settings": "settings",
                "command": "input",
                "erase": "erase",
                "grant": "grant",
                "limit": "administer",
                "move": "settings",
                "fork": "input",
                "close": "watch",
            }.get(operation, "watch")
            if operation in {"authority", "config_view", "declaration", "close", "view"}:
                return  # Control replies and configuration do not read session history.
        elif target in {"tools", "environment", "history", "subagents"}:
            raise AgentError("Use the checked Runtime or session API", "forbidden")
        if operation != "leave":
            self.require(s, actor, permission)
            if represented_by := data.get("acting_for"):
                self.require(s, represented_by, permission)

    async def leave(self, d):
        s = self._session(d)
        actor, subject = d.get("actor", s["actor"]), d["subject"]
        if actor != subject:
            self.require(s, actor, "grant")
            if represented_by := d.get("acting_for"):
                self.require(s, represented_by, "grant")
        if subject not in s["actors"]:
            raise AgentError("Unknown actor", "forbidden")
        return await self.handle(
            "append",
            {**d, "writer": "@harness", "kind": "actor_left", "data": {"actorId": subject}},
            None,
        )

    async def grant(self, d):
        s = self._session(d)
        actor = d.get("actor", s["actor"])
        self.require(s, actor, "grant")
        authority = set(d["authority"])
        ceiling = self.permissions(s, d["acting_for"]) if d.get("acting_for") else None
        if not (authority & PERMISSIONS) <= self.permissions(s, actor, ceiling):
            raise AgentError("Cannot grant more authority than the grantor has", "forbidden")
        prior = s["actors"].get(d["subject"])
        kind = d.get("kind", "user")
        if prior and prior["kind"] != kind:
            raise AgentError("A recorded actor cannot change kind", "forbidden")
        updated = clone(s)
        updated["actors"][d["subject"]] = {
            "kind": kind,
            "authority": sorted(authority),
        }
        self.sessions[s["id"]] = updated
        try:
            return await self.handle(
                "append",
                {
                    "session": s["id"],
                    "actor": actor,
                    "writer": "@harness",
                    "kind": "authority",
                    "data": {
                        "subject": d["subject"],
                        "kind": d.get("kind", "user"),
                        "authority": sorted(authority),
                    },
                },
                None,
            )
        except BaseException:
            self.sessions[s["id"]] = s
            raise
