# Bindings

The core specification describes what the parts do, not how they are wired ([ADR 0010](../adr/0010-describe-parts-not-wiring.md)). Bindings are optional profiles. A build names the profiles and versions it claims; it can conform to the core without claiming any. See [Conformance and versioning](../conformance.md) for the requirements, version selection, and rules for changes.

| Binding | Version | Covers |
|---|---|---|
| [ACP host binding](acp.md) | `modular-agent-acp/1` and `/2` over ACP v1 | Driving an agent: the declaration, input keys, approvals, questions and extension methods |
| [History service binding](history-http.md) | `modular-agent-history/1` | A history store as an HTTP service: leases, entries and erasure |
| [Plugin binding](plugin.md) | `modular-agent-plugin/1` | A plugin in another process: tool sources, Providers, the working environment, hook handlers, commands, the Runtime, jobs and the output gate |
| [Shared data](data.md) | `modular-agent-data/1` | JSON shapes used by the bindings and by portable sessions |

The bindings draw on five independent builds: TypeScript, Rust, Python, Go and Elixir. Each binding describes what a peer can omit and how to discover it. Matching versions alone do not establish trust or authority. Network services without a binding here need a deployment-specific agreement and the [security rules](../security.md).

The [ACP](../../conformance/acp/README.md), [history](../../conformance/history/README.md) and [plugin](../../conformance/plugin/README.md) kits check the wire without a live model. The history kit talks to the service under test over HTTP.
