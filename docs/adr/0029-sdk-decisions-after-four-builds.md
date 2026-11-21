---
status: accepted
date: 2026-11-21
---

# Five SDK decisions the four builds could not settle

Building the SDK four times found about 90 points where the SDK specification was wrong, unclear or silent. Most were settled by the documents themselves: 22 were applied and 30 rejected ([findings](../research/sdk-findings.md)). Five needed a choice, because the four builds had each chosen differently and the documents gave no basis to prefer one. This record makes those choices.

## Decision

1. **Liveness on an ACP service.** Over the [WebSocket transport](../bindings/websocket.md), an ACP agent service answers `$/ping` with `{}`, before or after `initialize`, without changing session state, and the transport's five-second control deadline applies to it. An ACP client may check liveness with `$/ping` or with WebSocket ping frames; it need not do both. The stdio ACP binding is unchanged.
2. **What an ACP service token reaches.** The operator's entry for a token bounds its connections: a token with no `tenants` list reaches only sessions without a tenant; `projects` match canonical project paths exactly, not their subfolders, and when omitted are bounded by what the serving composition serves; an empty list grants nothing in its scope. The token's rights are a ceiling on the connection: effective rights are the intersection of the token's rights and the actor's recorded grants, computed at connection time. Recorded grants are never rewritten.
3. **Persistent history under `ephemeral`.** `createAgent` refuses an explicit persistent history store, or a history service, with `durability: "ephemeral"`, raising `invalid_composition` that names `kept`. `ephemeral` means nothing survives the process; a caller who wants sessions to survive chooses `kept` or `durable`.
4. **Model requests from a command.** A command handler may make one or more auxiliary model requests through a call-scoped operation on its context. A request uses the session's current model and Provider, passes through the Provider hooks, is authorized and metered to the session and its tenant, and is recorded under the command's step. It starts no turn, and tool calls in the reply are returned to the handler, never dispatched. There is no unscoped access to a Provider.
5. **Reasoning in the API-key Providers.** All four SDKs ship one table of the `openai` and `anthropic` models they know, with each model's reasoning levels and how each level is sent ([research](../research/sdk-api-key-reasoning.md)). The table is the source of both `ModelInfo.thinking` and the request mapping. An unset level leaves the vendor default. A model the table lists without a verified mapping, or a model id the developer names that the table does not list, offers no levels and sends no reasoning controls. No SDK guesses a model's levels or probes the vendor with a request to find them.

## Considered options

- **Liveness:** WebSocket frames only. Rejected because the four servers already answer `$/ping` and the plugin binding defines it; a browser client cannot send WebSocket ping frames, so it needs a message it can send.
- **Token scope:** omitted tenants meaning all tenants, and projects matching subtrees, as two of the builds did. Rejected: an operator who forgets a field should get the narrower grant, and subtree matching lets a token reach a project nested inside another by accident.
- **Ephemeral history:** accept a persistent store under `ephemeral` but never promise portability, or let the store decide. Rejected: the mode would then not say whether sessions survive, which is its only job.
- **Command requests:** offer only SDK-supplied commands that use a model. Rejected: developers write commands such as summarizing a session, and the [command contract](../contracts.md#commands) already gives the authorization, recording and metering rules a scoped operation needs.
- **Reasoning:** one fixed list for every model, or asking the vendor at run time. A fixed list sends settings some models refuse, as the live checks showed for `minimal` on GPT-6 Luna; OpenAI's model list does not report the levels a model accepts.

## Consequences

- The SDK specification and the WebSocket binding change to say the above; each SDK then implements it, and the shared scenarios and kits check it where they can.
- The shared model table has to be updated when a vendor adds a model. Until it is, a developer can still name the new model, but without reasoning levels.
- `ephemeral` agents that today pass a history store must change to `kept`.
