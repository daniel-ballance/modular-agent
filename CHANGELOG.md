# Changelog

The four SDKs share one version, the revision of the [SDK specification](docs/sdk/README.md). Nothing is published to a registry; a version names a commit on `main`.

## 0.1.0

The first version for developers to try, on Linux.

- **Specification.** [Edition 4](docs/adr/0027-sdk-0-1-and-edition-4.md) replaces production edition 3: nested tool calls, `modelTools`, directory listing, a nested call's parent over ACP, and three Provider clarifications. The ACP kit now also checks that an agent refuses the features it declares off.
- **SDK specification 0.1,** accepted: the Agent and sessions, typed tools, plugins that run in process or in another process unchanged, durability (`ephemeral`, `kept`, `durable`), questions, hooks, Providers, ACP, history over HTTP, and a testing kit with a scripted model ([`docs/sdk/`](docs/sdk/README.md)).
- **SDKs in Rust, TypeScript, Go and Python,** each wrapping that language's clean-room build. Each passes the eleven shared scenarios in process and with the test plugins served by every SDK: 220 runs.
- **Guides 01 to 09,** each with its examples running as tests in all four languages.
- **`ma`, the standard configuration,** in all four languages: one `codemode` tool on Monty, the six file tools, MCP, Agent Skills, ChatGPT, Grok and Claude subscription Providers, a terminal and ACP. All four pass the fifteen reference checks and the identical 188 ACP kit checks.
- **Repository.** MIT license; `scripts/check.sh` runs every check locally; [CONTRIBUTING.md](CONTRIBUTING.md).

Known gaps are listed in the [README](README.md#known-gaps) and each SDK's README.
