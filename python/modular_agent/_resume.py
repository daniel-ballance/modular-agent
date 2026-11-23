"""Start ordinary recovery before a service accepts clients."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, NotRequired, TypedDict, cast

from ma_harness.authority import CONNECTION_AUTHORITY

from ._types import Actor, AgentError, ErrorCode, JsonObject

if TYPE_CHECKING:
    from ._agent import Agent


class ResumeOpen(TypedDict):
    report: Callable[[str, Literal["resumed", "skipped"]], None]
    actor: NotRequired[Actor | str]
    projects: NotRequired[Sequence[Path]]
    tenants: NotRequired[Sequence[str | None]]


async def resume_sessions(
    root: Agent,
    options: ResumeOpen | None,
    compose: Callable[[Path, str], Awaitable[Agent]] | None = None,
    project_mcp: Callable[[Path], Sequence[JsonObject]] | None = None,
) -> None:
    if options is None or root._project not in options.get("projects", (root._project,)):
        return
    principal = options.get("actor", "user")
    actor = principal if isinstance(principal, str) else principal["id"]
    kind = None if isinstance(principal, str) else principal["kind"]
    rights = None if isinstance(principal, str) else frozenset(principal["rights"])
    tenants = options.get("tenants", (None,))

    def scope(state: dict[str, Any]) -> bool:
        return state["project"] == str(root._project) and state.get("tenant") in tenants

    token = CONNECTION_AUTHORITY.set((actor, rights, {}, scope))
    try:
        for row in await root.sessions(project=root._project):
            sid = cast(str, row["id"])
            summary = await root.session_summary(sid, actor=actor, kind=kind)
            if summary is None or summary["waiting"]["turn"] != "interrupted":
                continue
            selected = await compose(root._project, sid) if compose else root
            try:
                if selected._project != root._project:
                    raise AgentError(ErrorCode.INVALID_COMPOSITION, "Wrong recovery project")
                if selected is not root:
                    selected._h.capacity = root._h.capacity
                    await selected._install_acp_mcp(project_mcp)
                opened = await selected._session(
                    "open",
                    session=sid,
                    actor=actor,
                    actor_kind=kind,
                    if_interrupted=True,
                    wait_for_lease=False,
                )
                if opened and selected is not root:
                    root._resumed[sid] = selected
                options["report"](sid, "resumed" if opened else "skipped")
            except AgentError as exc:
                if exc.code != ErrorCode.HELD:
                    raise
                options["report"](sid, "skipped")
            finally:
                if selected is not root and selected is not root._resumed.get(sid):
                    await selected.close()
    finally:
        CONNECTION_AUTHORITY.reset(token)
