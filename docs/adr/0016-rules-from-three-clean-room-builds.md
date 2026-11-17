---
status: accepted
date: 2026-11-17
---

# The rules three clean-room builds agreed on become part of the contracts

The description was tested by building it three more times. Each build used a different language (Rust, Python and Go) and a different binding (one process, plugins in other processes, and HTTP services). Each was built by GPT-6.1 Sol from the description alone. None saw the TypeScript build or the others. All three finished every milestone, and each logged where the description left a choice open: 112 entries in all. For each one, the builder said whether two builds that chose differently would break a plugin or a host.

Two things came out of the logs.
- **The parts and the line between *what* and *how* held.** No build needed a wire format the description leaves out, and all three said so.
- **The *what* was too loose at the level of rules.** Almost every area with behaviour was flagged by all three, as breaking a plugin or host if builds disagreed. Areas include how hook handlers combine, input keys, the output gate, erasure, recovery and authority. On most of them the three builds had independently made the same choice.

## Decision

Where all three builds made the same choice, it is now a rule, in [Contracts](../contracts.md#rules-every-implementation-follows). Where they made different choices and the difference matters, the rule says what must be declared instead, such as what a restart does with queued input, or whether moving away from unfinished work cancels it or is refused. Rules that only one or two builds raised are adopted where they close a hole the others would fall into: records of authority can't be erased, and content is never authority.

The hook point table now gives each standard point its fixed rule. It also says what a failing handler does, and that a handler may run more than once after a restart. Two scenarios were corrected: a timed-out question (3), and moving back (14), which was unsafe with a Provider that keeps state. Most open questions about turns, tools and durability are now settled.

## Considered options

- **Leave the rules to each build, and declare differences.** Rejected for rules that a plugin or host depends on. A plugin that relies on how handlers combine can't adapt at run time to a build that combines them differently.
- **Adopt the TypeScript build's choices.** Rejected. The TypeScript build was written beside the description, so its choices aren't evidence of what the description implies. Where it disagreed with all three clean-room builds, as in letting the first tool with a name hide later ones, it was changed.
- **Specify wire formats too.** Rejected for the description, as before ([ADR 0010](0010-describe-parts-not-wiring.md)). What hosts must share across builds is now in [bindings](../bindings/README.md), separate from the description.

## Consequences

- The contracts grew by about 2,300 words, as short rules grouped by area, each traceable to the builds' gap logs.
- Each build now has rules it doesn't yet follow. The TypeScript build's status is in [Status](../status.md#the-rules-from-the-clean-room-builds).
- The three gap logs remain the evidence. They are in the builds' repositories, in `GAPS.md`.
