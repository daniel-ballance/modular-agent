from .stdio import REPLY_VIEW

RETRY_ERASURE = {"session/prompt", "_modular-agent/history", "_modular-agent/input"}


def guards_frame(method):
    return method not in {
        "session/new",
        "session/load",
        "session/resume",
        "session/close",
        "_modular-agent/erase",
        "_modular-agent/leave",
        "_modular-agent/interrupted",
    }


async def frame_revision(api, sid, actor, **retry):
    return await api.session("erasure_cutoff", session=sid, actor=actor, **retry)


async def prepare_reply_view(api, sid, actor, **retry):
    if (prepared := REPLY_VIEW.get()) is not None:
        prepared[:] = [sid, await frame_revision(api, sid, actor, **retry)]
