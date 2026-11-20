# Guides

Each guide walks through one task in all four languages. The examples are the API the SDKs must offer: once an SDK exists, every example in these guides is compiled and run as one of its tests ([How the SDKs are checked](../README.md#how-the-sdks-are-checked)). An example that cannot be written as shown means the guide or the [API](../api.md) changes first.

| Guide | Covers | Status |
|---|---|---|
| [Your first agent](01-first-agent.md) | Building an agent, a prompt, streaming, a first test | draft |
| [Add a tool](02-add-a-tool.md) | Writing a tool, using it, testing it with a scripted model | draft |
| [A tool in another process](03-tool-in-another-process.md) | Serving a plugin and loading it into an agent in another language | draft |
| Answer questions and approvals | Question handlers, approval policy, answering later | planned |
| Sessions that survive a crash | `kept` and `durable`, reopening, what a restart does to a tool call | planned |
| Write a Provider | Catalog, streaming, model errors, credentials | planned |
| Hooks | Gates, transforms, ordering, what a served hook cannot do | planned |
| Drive an agent over ACP | `serveAcp`, connecting an editor or T3 Code | planned |
| Share sessions between agents | The history service, actor ids, portable sessions | planned |

The examples use `openai/gpt-6-luna` as the model and `OPENAI_API_KEY` for its key. The model stands for any model the Provider offers: use one from `provider.models()`, since an agent refuses a model no Provider offers. Any Provider and model work the same way.
