---
status: superseded by 0037
date: 2026-11-25
---

> **Superseded** on 2026-11-25 by [ADR 0037](0037-two-languages.md): the project keeps two languages, Rust and TypeScript, in lockstep. Go and Python will be kept at the tag `four-languages` when they leave `main`.

# Four languages in lockstep

[ADR 0024](0024-five-layers.md) makes the four SDKs one SDK in four languages, and the four `ma` programs one program. [CONTRIBUTING](../../CONTRIBUTING.md#how-work-moves-through-the-layers) turns that into a rule: a change to one language is a change to all four, or a recorded gap in the others. The 0.3.0 assessment weighed what the rule costs and asked whether to keep it.

## Decision

Keep strict lockstep. Every rule in the SDK specification and the standard configuration is implemented in Rust, TypeScript, Go and Python in the same release.

An agent builds each SDK and each `ma` from the documents. Doing that four times is how the project shows that its flow works: from the specification to the SDK specification, then to the SDKs and the reference implementations. Where the four agree, the documents were enough to build from. A rule that only one language follows has not been shown to be specifiable. It may depend on something that only that language's code says.

A language can fall behind for a time only through an issue with its `lang:` label. The issue is the recorded gap. It is planned in a milestone like any other work.

## Cost

Each rule is written four times. For example, the AG-UI view of an `approvalCall` is built in four files:

- `typescript/packages/core/src/agui-view.ts`
- `rust/crates/sdk/src/agui/view.rs`
- `go/modular/agui_history.go`
- `python/modular_agent/_agui.py`

A change takes longer, and a fix found in one language must be made in the other three. The shared scenarios and reference checks catch a language that differs, but they do not write the code.

## Considered options

- **Rust leads, the others follow behind recorded gaps.** Changes would land in Rust first, with an issue for each other language. This is cheaper per change. The other three would then be built from Rust's code, not from the documents. Gaps would pile up, and the documents would stop being checked by four independent builders.
- **Keep the current rule but allow gaps without an issue.** A gap that only a commit message records is easy to lose. An issue with a `lang:` label shows on the milestone and the Project.
