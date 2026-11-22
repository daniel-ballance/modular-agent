---
status: accepted
date: 2026-11-22
---

# Subscription Providers in every SDK: chatgpt, grok and claude

Until now only `ma` could use a ChatGPT, Grok or Claude subscription. Each language's `ma` had its own sign-in and request code, under the Provider ids `openai-codex`, `xai` and `claude`, and an app built on the SDKs had API keys only. Go kept the code in an `internal` package that nothing else could import, and Rust and Go reached Claude only through a TypeScript sidecar that `ma` found itself.

## Decision

Each SDK ships three [subscription Providers](../sdk/subscription-providers.md):

- `chatgpt()`, Provider id `chatgpt`: OAuth sign-in to a ChatGPT plan, then the Responses API.
- `grok()`, Provider id `grok`: OAuth sign-in to The X Subscription (xAI's unified plan for Grok, Grok Bot, Cursor and X Premium, introduced 2026-10-12), then xAI's Responses API.
- `claude()`, Provider id `claude`: Claude through Anthropic's Claude Agent SDK, signed in by Claude Code itself.

The SDK owns sign-in (`signIn`, `signOut`), the login file shared across languages and processes (`subscriptionLogins`), token refresh under a kernel lock, the client identity option, and one shared model table. `ma` uses these Providers and keeps none of its own.

The ids are the names people know the plans by. `ma` accepts `openai-codex` and `xai` as aliases in `--model`, `ma login`, settings, `models.json` and reopened sessions, and moves logins stored under them to the new ids on the next write of `auth.json`, so existing sign-ins keep working. The aliases are removed in a later release.

`claude()` never offers a sign-in and never reads or stores a Claude credential, because Anthropic's terms forbid third-party apps to offer Claude.ai login or to intermediate its credentials ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). The person signs in with Claude Code, through Anthropic's own flow; Anthropic states that the Agent SDK then draws on that person's plan ([Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)). Anthropic publishes the Agent SDK for TypeScript and Python only, so Rust and Go run the TypeScript SDK's Claude program as a process plugin.

## Considered options

- **Keep the subscription Providers in `ma`.** Every developer who wanted a plan would copy `ma`'s code, and Go's could not be imported at all.
- **Reimplement the Claude Code protocol in Rust and Go.** It would avoid Node.js, but it would not be the Agent SDK: it would track a private protocol by hand, and an unofficial port is what the Agent SDK exists to replace.
- **A third-party Rust Agent SDK.** Not Anthropic's, and not available for Go.
- **Grok through Grok Build over ACP, as Claude goes through Claude Code.** xAI's supported route for a plan, but Grok Build is a whole agent with its own tools, not a model endpoint that hands tool calls back.
- **Grok with an xAI API key only.** Supported, but billed per request rather than drawing on the plan, which is what this Provider is for.
- **Keep `openai-codex` and `xai` as the ids.** They name an internal product and a company, not the plans people pay for.

## Consequences

- Rust and Go `claude()` need Node.js 22 or newer and the TypeScript Claude program installed. TypeScript and Python need only their Agent SDK package, which brings Claude Code.
- The ChatGPT and Grok sign-ins use the vendors' own coding tools' OAuth clients. The SDK documents this, and an app that ships them to other people must check the vendors' terms. Grok's is the riskier: xAI documents no sign-in for other tools and only API keys for `api.x.ai` ([research](../research/grok-x-subscription.md)). It was kept because it works and draws on the plan, checked on a real account on 2026-11-22; if xAI stops accepting it, `grok()` stops working until xAI offers a route.
- The shared table must be updated when a plan gains a model.
