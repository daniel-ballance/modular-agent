# Modular Agent

Build AI agents from interchangeable parts: model Providers, tools, the working environment, where history is kept, the Interfaces, and the Runtime that runs the agent loop itself. A part can run in the agent's process, in its own process, or in another language, and work the same.

This repository holds three things:

- **SDKs in Rust and TypeScript.** One SDK in two languages, with the same concepts and names in each.
- **`ma`, a coding agent** with Pi's feature set, built on each SDK: the same program in both languages.
- **The specification** they are built from, with kits that check a build against it.

Status: **0.4.0, for developers to try, on Linux and macOS.** Nothing is published to a package registry; use the code from this repository as shown below. It is not production software: see [Known gaps](#known-gaps).

## Build an agent

Each example below is a complete program; the first guide explains it. The scripted Provider answers from a list, so it needs no model or key. Swap in a real Provider (`openai`, `anthropic`) when you are ready.

**Rust.** In `Cargo.toml`: `modular-agent = { git = "https://github.com/daniel-ballance/modular-agent" }`, plus `tokio` and `serde_json`.

```rust
use modular_agent::{Agent, testing::scripted_provider};

#[tokio::main]
async fn main() -> modular_agent::Result<()> {
    let agent = Agent::builder()
        .provider(scripted_provider(serde_json::json!([{ "text": "Hello." }])))
        .build()
        .await?;
    let turn = agent.session().await?.prompt("Say hello.").await?;
    println!("{}", turn.text);
    agent.close().await
}
```

**TypeScript.** The packages are not on npm. Clone this repository, build it, and install the SDK's folders into your app. Node.js 22 or later.

```sh
git clone https://github.com/daniel-ballance/modular-agent.git
(cd modular-agent/typescript && npm ci && npm run build)
npm install $(node modular-agent/typescript/scripts/sdk-packages.mjs core)
```

```ts
import { createAgent } from "@modular-agent/core";
import { scriptedProvider } from "@modular-agent/core/testing";

const agent = await createAgent({ providers: [scriptedProvider([{ text: "Hello." }])] });
const turn = await (await agent.session()).prompt("Say hello.");
console.log(turn.text);
await agent.close();
```

Then read on:

| Read | To learn |
|---|---|
| [Guides](docs/sdk/guides/README.md) | Task by task, in both languages: a first agent, tools, plugins in other processes, questions and approvals, durability, Providers, hooks, ACP, shared sessions |
| [SDK specification](docs/sdk/README.md) | The concepts, the API in language-neutral terms, placement and durability, testing |
| [API reference](docs/sdk/reference.md) | How to build each language's reference from source |
| Each SDK's README | What it implements and what it lacks: [Rust](rust/crates/sdk/README.md), [TypeScript](typescript/packages/core/README.md) |

## Use `ma`

`ma` is a coding agent for everyday use: one `codemode` tool that runs Python in a [Monty](https://github.com/pydantic/monty) sandbox and reaches files, commands and MCP servers through it; Agent Skills; Providers for ChatGPT, Grok and Claude subscriptions; a line-based terminal, ACP for editors and hosts such as T3 Code, and AG-UI for web apps. The [standard configuration](docs/reference/standard-configuration.md) describes it; both implementations pass the same [reference checks](conformance/reference/README.md).

```sh
git clone https://github.com/daniel-ballance/modular-agent.git && cd modular-agent
rust/scripts/install.sh      # builds ma into ~/.local/bin, with the Claude sidecar
ma login chatgpt             # or grok, or claude (uses your Claude Code sign-in)
ma                           # in a project folder
```

The TypeScript build is in [`typescript/packages/ma`](typescript/packages/ma/README.md).

## Known gaps

Tracked in #30. Real Provider use is tracked in #20.

- **Command containment varies by OS.** Linux uses namespaces, ptrace and cgroups. macOS (Apple silicon; checked with `scripts/macos-check.sh`, which runs both language suites, reference checks and the ACP kit) uses process-group containment, not strong containment: a process that leaves its command's group is not stopped, so a command interrupted by a crash is never repeated there. Windows is unsupported.
- **Few real requests.** The test suites use scripted models and local fakes. The ChatGPT, Grok and Claude subscription Providers have answered real requests through both `ma` builds, each reading a file through `codemode`, and the `openai` and `anthropic` API-key Providers pass the [live checks](docs/sdk/testing.md#live-checks) in both SDKs.
- **`ma` turns off several actors, session limits and tenants.** The SDKs offer them as options.
- **Parts as network services are new.** Both SDKs serve plugins and agents over the [WebSocket transport](docs/bindings/websocket.md), and the kits check each one, but only on loopback in tests; nothing has run across machines yet.

Each SDK's README lists its own gaps.

## The specification

The specification says **what** each part does, what passes between the parts, and what must always hold, not how a part works inside. Optional **bindings** fix the wire where two builds work together: ACP for hosts, [AG-UI](docs/bindings/agui.md) for applications, a plugin protocol, and an HTTP history service. Implement the current normative documents and run the kits from the same revision.

It was proven before any SDK existed. Five builds were made from the documents alone, four of them clean-room builds in Rust, Python, Go and Elixir. In the final swap round every build ran with every other build's parts and reopened every other build's sessions, through real `kill -9` crashes: 125 of 125 pairings passed ([status](docs/status.md#production-edition-3), [build notes](docs/build-notes.md#round-seven)). The Rust and TypeScript SDKs now repeat that check on every change: each runs the [shared scenarios](conformance/sdk/README.md) with parts served by both SDKs. The [`four-languages`](https://github.com/daniel-ballance/modular-agent/tree/four-languages) tag preserves the Go and Python builds and their results ([ADR 0037](docs/adr/0037-two-languages.md)).

| Read | To learn | Status |
|---|---|---|
| [Conformance](docs/conformance.md) | which documents set requirements, how to claim conformance, and how bindings change | normative |
| [Implementer's guide](docs/implementers-guide.md) | what to build, how a turn runs, and which kit checks each milestone | informative |
| [Glossary](GLOSSARY.md) | the vocabulary | informative |
| [Architecture](docs/architecture.md) | the parts, their responsibilities, and why | informative |
| [Contracts](docs/contracts.md) | what passes between the parts, and the rules every implementation follows | normative |
| [Security](docs/security.md) | the trust boundaries, and the rules that keep them | normative |
| [OpenTelemetry](docs/telemetry.md) | Harness instrumentation and trace context, metadata only | optional profile |
| [Scenarios](docs/scenarios.md) | seventeen situations, told with the parts and rules | informative |
| [Bindings](docs/bindings/README.md) | the wire: [shared data](docs/bindings/data.md), [plugins](docs/bindings/plugin.md), [ACP](docs/bindings/acp.md), [AG-UI](docs/bindings/agui.md), [history service](docs/bindings/history-http.md) | linked bindings are normative |
| [Conformance kits](conformance/) | programs that check a build against the bindings | informative |
| [Decision records](docs/adr/README.md) | why each decision was made, and what was rejected | informative |
| [Open questions](docs/open-questions.md) | this edition's limits and implementation choices, with safe defaults | informative |

### Acceptance test

Conformance does not establish production readiness. A deployment pins the specification revision, records its own profile (bindings, declarations, kit results), and tests that it keeps authority, isolation and recovery across the swaps it allows. See [Security](docs/security.md).

## How the repository is organised

The project has five layers, each made only from the layers below it; a gap found in one is fixed in the layer below first ([ADR 0024](docs/adr/0024-five-layers.md)).

| Layer | What it is | Where it is |
|---|---|---|
| 1. Specification | What every agent and part must do, and the wire | [`docs/`](docs/conformance.md#the-documents), [kits](conformance/) |
| 2. SDK specification | What a developer sees, in each language | [`docs/sdk/`](docs/sdk/README.md); [shared scenarios](conformance/sdk/) |
| 3. SDKs | One SDK in Rust and TypeScript | each language's directory |
| 4. Reference implementations | `ma`, the same coding agent in each language | [`docs/reference/`](docs/reference/README.md); [reference checks](conformance/reference/) |
| 5. Demonstrative implementations | Agents that combine SDKs and placements | [`demos/`](demos/) |

The [project notes demo](demos/project-notes/README.md) runs one agent with Rust and TypeScript parts in four placements (in process, stdio, WebSocket and HTTP) and reopens its session after a crash.

Each language is a peer directory with its own toolchain: [`rust/`](rust/README.md) and [`typescript/`](typescript/README.md). Each also holds the clean-room build its SDK wraps. Background, such as the research and pressure tests that shaped the design, is in [`docs/research/`](docs/research/), [`docs/pressure-test/`](docs/pressure-test/), [`docs/build-notes.md`](docs/build-notes.md) and [`docs/one-pager.html`](docs/one-pager.html).

To change anything, read [CONTRIBUTING.md](CONTRIBUTING.md). There is no hosted CI: [`scripts/check.sh`](scripts/check.sh) runs every check locally.

## License

[MIT](LICENSE).
