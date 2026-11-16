# Pressure test

**Started:** 2026-11-16. **Status:** complete. Results: [synthesis](synthesis.md).

**Question:** can the [architecture](../architecture.md), [contracts](../contracts.md) and [glossary](../../GLOSSARY.md) describe every agent from a copy of vanilla Pi up to a system with ACP, several agents and users, MCP Apps and everything else, without changing their assumptions?

**Method:** take real and imagined target systems, from simple to complex. For each feature of each target, try to describe it using only our parts, capabilities, plugin API, interactions, hook points and guarantees. Each time that fails or strains, record a finding against the assumptions below. The reviewers are independent of the author of the docs, and each covers one rung of the ladder.

## Assumptions under test

Each is a claim the current docs make. A finding cites the IDs it affects.

**Structure**
- **A1** An agent is the Harness plus plugins. The Harness alone does nothing useful.
- **A2** The Harness does exactly three things: hosts plugins, offers the plugin API, and keeps sessions, including their history.
- **A3** Every feature, including the agent loop, can be a plugin that uses only the plugin API. No plugin needs privileged access.
- **A4** A plugin either provides a capability, adds behaviour, or both.
- **A5** Six capabilities are enough: Runtime, Provider, Interface, tool source, history store, credential store.
- **A6** There is one Runtime per session at a time, one history store and one credential store. There can be any number of Providers, Interfaces and tool sources.
- **A7** The plugin API, as listed in the architecture, covers everything a plugin needs.
- **A8** The Harness turns the outside world into a few standard forms, so the Runtime can't tell vendors, tool sources or Interfaces apart.

**Turns and the Runtime**
- **A9** Work nests as session, turn and step, each with one owner. The Harness owns sessions.
- **A10** A turn ends when the agent can't continue without outside input, or when it stops. Its outcome is completed, cancelled, failed or stopped at a limit.
- **A11** During a turn, the Runtime asks for only two things: run a tool call, and let plugins step in at a hook point.
- **A12** The Runtime never chooses the model, never holds credentials, never runs tools or plugin code itself, and never keeps the history.
- **A13** One standard set of hook points is enough, and every Runtime offers the same set.
- **A14** What the model sees is decided entirely at the before-each-step hook point, plus a retry when a model request fails.
- **A15** A step is one model request plus its tool calls. Repeating a model request has no effect outside the system.

**Providers and tools**
- **A16** A Provider only makes models available: it has a catalog and answers requests. It runs no tools and keeps no conversation state.
- **A17** Tools come from tool sources, and every tool call goes through the Harness.
- **A18** Every tool call ends with exactly one result, with one of six statuses.

**Users and Interfaces**
- **A19** The outside world uses the agent only through Interfaces. To the outside, it is one agent.
- **A20** There is one user. Input requests go to "the user". (The docs assume this without saying it.)
- **A21** Approval fails closed, and the approval policy is set per session.
- **A22** A question can outlast its turn, and a late answer arrives as new input.

**History and content**
- **A23** History only grows. Nothing recorded is changed or deleted.
- **A24** What the model sees is a view worked out from the history before each step.
- **A25** Partial output is live only, and never kept.
- **A26** Content is a list of typed parts, and parts of unknown types are passed on intact.

**Several agents**
- **A27** Another agent is either a tool source, when we use it, or uses us through an Interface. Subagents need nothing more.
- **A28** A subagent's session belongs to its parent's. Permissions only narrow, results arrive as input, and questions reach the user through the parent.

**Wiring independence**
- **A29** The same description fits an agent in one process and one spread across services. Nothing needs shared memory or passing functions between parts.
- **A30** Everything that passes between parts can be observed and recorded.
- **A31** A transient and a durable Runtime fit one description.
- **A32** Credentials never reach the Runtime.

## The ladder

| Rung | Target | Evidence | Findings |
|---|---|---|---|
| 1 | Vanilla Pi, plus the real plugins in pi-packages: p3stack's mode, persistent subagents with peer messaging and workflows, todo, claude-subscription, mcp-client, self-reload, computer-use and web-search | Pi 1.5.2 docs and source; `~/Code/pi-packages` | [rung-1-pi.md](rung-1-pi.md) |
| 2 | Agent frameworks: DeepSeek Harness and Pydantic AI, with Pydantic AI Harness | clones in `~/Code/_ref` | [rung-2-frameworks.md](rung-2-frameworks.md) |
| 3 | Several agents together: T3 Code driving several providers, with delegation, threads as peers, schedules, linked machines and outside agents | `~/Code/_ref/t3code` | [rung-3-multi-agent.md](rung-3-multi-agent.md) |
| 4 | Everything at once, imagined: one agent serving editors over ACP, a web app over AG-UI and other agents over A2A; several users in one session; MCP Apps in tool results and UI-started tool calls; a durable Runtime; remote sandboxes; voice; plugins the model loads; per-tenant budgets; guardrails. Plus a red team attacking each assumption directly. | protocol specs, our research notes | [rung-4-maximal.md](rung-4-maximal.md) |

## What each finding records

- **Feature or situation:** what was being described.
- **Described as:** the parts, plugin API items, interactions and hook points used.
- **Verdict:** *fits* (describable as is), *strains* (describable, but awkwardly or by stretching a definition), *gap* (needs something added), or *breaks* (contradicts a decision or guarantee).
- **Assumptions:** the IDs affected.
- **Evidence:** a file and line, a documentation page, or a spec section.
- **Suggested change:** what to add or change, described at the level of what, not how.

## Synthesis

When all rungs report, the results are combined per assumption: holds, needs changing, or false. They are listed in [synthesis.md](synthesis.md) with the changes to make.
