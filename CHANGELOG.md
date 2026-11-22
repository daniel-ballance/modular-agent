# Changelog

The four SDKs share one version, the revision of the [SDK specification](docs/sdk/README.md). Nothing is published to a registry; a version names a commit on `main`.

## 0.1.0

The first release, for developers to try, on Linux and on macOS (Apple silicon). Nothing is published to a package registry; build from this tag.

- **Specification, [edition 4](docs/adr/0027-sdk-0-1-and-edition-4.md):** nested tool calls, `modelTools`, directory listing and a nested call's parent over ACP. Since edition 3 it also gained the WebSocket transport for the plugin and ACP bindings ([ADR 0028](docs/adr/0028-websocket-transport.md)), a `sessionInterrupted` event when an agent stops writing a session, ACP service liveness and token scope ([ADR 0029](docs/adr/0029-sdk-decisions-after-four-builds.md)), and the production rules of [ADR 0030](docs/adr/0030-production-gaps.md): per-connection isolation, reserved capacity so settlement completes under load, and cross-session erasure through the [`pendingErasure: 1` history profile](docs/bindings/history-http.md#pending-erasure-registry-profile-pendingerasure-1).
- **[SDK specification](docs/sdk/README.md) 0.1:** the Agent and sessions, typed tools, plugins that run in process or in another process unchanged, durability (`ephemeral`, `kept`, `durable`), questions that can be answered later, typed hooks and events, commands, jobs with owners and recovery, options for several actors, session limits and tenants, Providers, ACP, history over HTTP, and a testing kit with a scripted model. It was revised after four builds: 22 findings applied, 30 rejected ([findings](docs/research/sdk-findings.md)).
- **SDKs in Rust, TypeScript, Go and Python.** Each passes 17 shared scenarios in process and with the test plugins served by every SDK, over stdio and WebSocket: 612 runs. Live checks pass against OpenAI and Anthropic.
- **Subscription Providers in every SDK ([ADR 0031](docs/adr/0031-subscription-providers.md)):** `chatgpt()`, `grok()` and `claude()` use a person's own plan. ChatGPT and Grok sign in through OAuth and keep their logins in a shared login file, locked across processes and languages. `claude()` uses the Claude Code sign-in through Anthropic's Agent SDK and never handles a Claude credential; Rust and Go start the TypeScript Claude program, which needs Node.js 22 or later. ChatGPT and Grok sign in with the vendors' own coding tools' OAuth clients ([Terms of use](docs/sdk/subscription-providers.md#terms-of-use)).
- **Guides 01 to 09,** each with its examples running as tests in all four languages.
- **`ma`, the standard configuration,** in all four languages: one `codemode` tool on Monty 1.6.0 with one exact profile, run in a worker process with a 256 MiB limit; the six file tools; MCP; Agent Skills; the ChatGPT, Grok and Claude Providers; rewind points kept as commits in the project's git repository; an operator `policy.json`; a terminal; and ACP on stdio or a WebSocket. It names itself `modular-agent` to ChatGPT and Grok (`MA_CLIENT_IDENTITY` changes it). All four builds pass the 24 reference checks and the identical 188 ACP kit checks.
- **[Project notes demo](demos/project-notes/README.md):** one agent made of parts in all four languages, with a scripted check of normal running and crash recovery.
- **Repository.** MIT license. `scripts/check.sh` runs every check locally; `scripts/macos-check.sh` runs the suites on a Mac. [CONTRIBUTING.md](CONTRIBUTING.md).

Known gaps are listed in the [README](README.md#known-gaps) and each SDK's README.
