# Bindings

The description says what the parts do, not how they are wired ([ADR 0010](../adr/0010-describe-parts-not-wiring.md)). That stays true. But when two builds must work together, they need to agree on the wire as well. A host driving any build over ACP needs this, and so does an agent using another build's history service. A binding is that agreement for one protocol. It is separate from the description: a build can follow the description without following any binding, and declares the bindings it follows.

| Binding | Version | Covers |
|---|---|---|
| [ACP host binding](acp.md) | `modular-agent-acp/1` | Driving an agent over ACP v1: the declaration, input keys, approvals, questions, extension methods, and a conformance mode |
| [History service binding](history-http.md) | `modular-agent-history/1` | A history store as an HTTP service: leases, entries and erasure |
| [Plugin binding](plugin.md) | `modular-agent-plugin/1` | A plugin in any language, hosted by any build: tool sources, Providers, the working environment, hook handlers and commands. The Runtime follows in stage 2. |
| [Shared data](data.md) | `modular-agent-data/1` | The JSON shapes every binding uses for content, messages, tools, questions and history entries |

Both were written after four builds had each chosen their own wire details, in TypeScript, Rust, Python and Go. Where the builds agreed, the binding follows them. Where they differed, the binding picks one, and says why where it isn't obvious.

Conformance kits are in [`conformance/acp`](../../conformance/acp/README.md), [`conformance/history`](../../conformance/history/README.md) and [`conformance/plugin`](../../conformance/plugin/README.md). Each needs no network and no model.
