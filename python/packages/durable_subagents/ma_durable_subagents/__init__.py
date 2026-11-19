"""Durable subagent plugin, swappable without changing jobs or tools."""

from ma_subagents import Subagents


class DurableSubagents(Subagents):
    durable = True
    declarations = {**Subagents.declarations, "durable_subagents": True}
