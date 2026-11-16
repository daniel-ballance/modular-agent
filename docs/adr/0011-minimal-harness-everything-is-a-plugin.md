---
status: accepted
date: 2026-11-16
---

# The base Harness does the minimum and exposes an API, and everything else is a plugin

The base Harness does as little as it can. It hosts plugins, connects the parts, and exposes a **plugin API**. Everything with behaviour of its own is a plugin that uses that API. That includes:
- the Runtime and Providers
- Interfaces
- native tools, and MCP client support
- Agent Skills support
- commands and prompt templates
- storage, context management and compaction
- approval, the system prompt, model selection and credentials

A plugin interacts with the system only through the plugin API. It can do nothing the API does not offer.

What stays in the base Harness, and what the plugin API offers, are proposed in [Architecture](../architecture.md#the-harness). Neither is decided yet.

## Considered options

- **A Harness with useful features built in, which extensions add to.** This is vanilla Pi. Its base system prompt, context files, skills, prompt templates, built-in tools, MCP support, slash commands, compaction, session tree and modes (terminal, print, JSON and RPC) are all built in. Extensions add tools, commands, providers, hook handlers and UI on top ([Pi reference](../research/pi-reference.md)). We rejected this because a built-in feature cannot be swapped or studied on its own.
- **Everything is a plugin, including the agent loop.** This is DeepSeek Harness, whose agent loop is a plugin like any other ([DeepSeek Harness reference](../research/deepseek-harness-reference.md#shape)). We follow it.

## Consequences

- We say "plugin", not "extension". What Pi calls an extension is a plugin in our terms.
- The plugin API is the base Harness's main responsibility. Describing it is describing what the system can do. Following [ADR 0010](0010-describe-parts-not-wiring.md), we describe what a plugin can offer and ask for through it, not its function signatures or wire format.
- Because plugins act only through the plugin API, everything a plugin does can be observed and recorded there.
- A useful agent is the base Harness plus a chosen set of plugins. Pi's out-of-the-box experience should be describable as one such set. DeepSeek Harness packages its sets as profiles and bundles.
- With no plugins, the Harness does nothing useful. That is expected.
- The Runtime is supplied by a plugin. This fits our aim that Runtimes are interchangeable.
- [ADR 0002](0002-harness-is-the-standardizing-boundary.md) still holds, with one refinement: the Harness defines the standard forms, and plugins adapt the outside world into them.
- [ADR 0006](0006-hook-points-belong-to-the-operation-owner.md) extends naturally: a plugin that owns an operation defines that operation's hook points, and other plugins handle them. For example, an approval plugin can define "approval requested", which Interface plugins answer.
- [ADR 0007](0007-context-management-is-a-hook.md) already treats context management as a hook point with a do-nothing default. Compaction becomes a plugin that handles that hook point.
- New open questions cover what stays in the base, how many of each capability there can be, whether plugins can define capabilities and hook points for each other, scope, and lifecycle.
