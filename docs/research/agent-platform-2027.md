# "Agent platform 2027": a summary

Source: John Suh, [post on X](https://x.com/john_ssuh/status/2124336124172935336), November 2026, four pages of text as images. Read on 2026-11-22. This is a paraphrase of each section, not the text. The author lists products he considers relevant under each section; they are repeated here as he gave them.

The post's thesis: one independent "agent platform" will become the application layer, an operating system on which very many agents work, with other software reduced to data sources behind it. Customers grow their own processes on it, changed by agents, people and signals from the business.

| Section | Claim | Named as relevant |
|---|---|---|
| Agents as actors | Agent workloads move from Temporal-style workflows to actors, each harness with its own isolated runtime. Isolation lets agents write their own extensions or hooks while running, and lets different agent loops share one backend, even inside one tenant. An agent's definition should be separate from its instances and sessions; in practice even mega-agent advocates prefer narrow, code-defined agents (the Fermat formalisation used only a shell and a file editor). | Cloudflare Durable Objects, Pi Durable with extensions, Vercel Eve, Rivet, DeepSeek's agent |
| Environments and computers | Two kinds of computer: clones of checkpointed sandboxes across providers, and people's own machines. N agents work with M computers (one agent with five sandboxes, one VM per agent, a thousand agents on a hundred VMs), configured by agents. | Claude remote sessions, Cursor's agent, Cua |
| RBAC-ed filesystem | Swarms share a POSIX filesystem in the cloud, with access control attached to the filesystem rather than the computer: part GitHub (agent code, extensions, definitions), part Google Drive (files and apps), with `.env` files and git or jj per directory. Permissions follow the agent's identity, the person who started the turn, or both. | Archil, S3 filesystems, JuiceFS |
| Separation of session and conversation | Showing users the raw agent session, tool calls included, is wrong. The user sees a "conversation" at the level of a Slack channel or email thread, and the agent posts to it by tool call. The session becomes a debugging view. Tools that wrap coding-agent sessions (T3 is named) face an innovator's dilemma. | Duet, Grokbot, Dots |
| Inbox | Users act from a focused inbox of approvals and questions, with tenant-specific apps for reviewing work that needs a person. | Microsoft Today, as described by @nicbstme |
| Listeners, monitors, single-tenant data | Agents define, per tenant and at run time, listeners on outside event streams (WebSockets, Kafka, change data capture) and turn events into signals, by code or by agent. Today's platforms mostly offer hourly cron triggers and bespoke webhook plugins. | Claude Code Monitor, a future Grokbot feature |
| Workflows | Durable, per-tenant workflows mixing agent and deterministic steps, defined in code, not drag and drop, living in the platform because data already flows through it. | Zapier Zaps, Rivet Workflows |
| Apps | Artifacts, Replit-style apps, ChatGPT Apps and embedded widgets are one idea: an app, kept in the user's filesystem, cloned per user and changed by agents on request, including the platform's own pages. Representation (JSON components, an HTML-like language, a framework) matters less than the concept. Vertical SaaS becomes configuration done by agents rather than by implementation teams. Containers for apps include tmux-like panes, apps in messages, app-first layouts with chat at the side, infinite canvases, windowed desktops and fixed panel grids. | Rex, OpenCode Rune |

## How it relates to Modular Agent

Research on the named systems and our gaps:

- [Agents as actors and durable runtimes](agent-runtimes-actors.md)
- [Computers and filesystems for agents](agent-computers-and-filesystems.md)
- [Agent conversations, inboxes, triggers and apps](agent-conversations-inbox-triggers-apps.md)

Most of what the post describes spans many whole agents, which [ADR 0012](../adr/0012-one-agent-is-the-scope.md) places in a host above the agent.
