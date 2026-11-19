"""Explicit white-box diagnostics shared by local and process test placements."""

from ma_process import ProcessPlugin


async def keys(plugin, attribute):
    if isinstance(plugin, ProcessPlugin):
        return await plugin.inspect(attribute)
    return list(getattr(plugin, attribute))
