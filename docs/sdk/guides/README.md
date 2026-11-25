# Guides

Each guide walks through one task in all four languages. The examples are the API the SDKs must offer: once an SDK exists, every example in these guides is compiled and run as one of its tests ([How the SDKs are checked](../README.md#how-the-sdks-are-checked)). An example that cannot be written as shown means the guide or the [API](../api.md) changes first.

| Guide | Covers |
|---|---|
| [Your first agent](01-first-agent.md) | Building an agent, a prompt, streaming, a first test |
| [Add a tool](02-add-a-tool.md) | Writing a tool, using it, testing it with a scripted model |
| [A tool in another process](03-tool-in-another-process.md) | Serving a plugin and loading it into an agent in another language |
| [Questions and approvals](04-questions-and-approvals.md) | Question handlers, approval policy, answering later |
| [Sessions that survive a crash](05-sessions-that-survive-a-crash.md) | `kept` and `durable`, reopening, what a restart does to a tool call |
| [Write a Provider](06-write-a-provider.md) | Catalog, streaming, model errors, credentials |
| [Hooks](07-hooks.md) | Gates, transforms, ordering, what a served hook cannot do |
| [Drive an agent over ACP](08-drive-an-agent-over-acp.md) | `serveAcp`, connecting an editor or T3 Code |
| [Share sessions between agents](09-share-sessions-between-agents.md) | The history service, actor ids, portable sessions |

Every example that needs no real model, network or editor runs as a test in its language; each guide says which examples are shown but not run. Where an SDK lacks something a guide uses, the guide shows what that SDK has today, and one issue with a `lang:` label for each SDK that lacks it records the gap.

The examples use `openai/gpt-6-luna` as the model and `OPENAI_API_KEY` for its key. The model stands for any model the Provider offers: use one from `provider.models()`, since an agent refuses a model no Provider offers. Any Provider and model work the same way.
