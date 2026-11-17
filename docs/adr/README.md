# Decision records

Each record explains one decision that is hard to reverse and would surprise a reader without its reasons. Records are kept even when later ones change them, so the reasoning stays visible. The current state of the design is in [Architecture](../architecture.md); this list says which records still stand.

| Record | Decision | Status |
|---|---|---|
| [0001](0001-contracts-are-messages.md) | Every contract is a message, with bindings kept separate | superseded by 0010 |
| [0002](0002-harness-is-the-standardizing-boundary.md) | The Harness is the centre, where the outside world is turned into standard forms | stands, amended by 0011 |
| [0003](0003-session-turn-step-ownership.md) | Sessions, turns and steps are nested, each with one owner | stands, amended by the pressure test |
| [0004](0004-merge-core-into-runtime.md) | There is no separate Core: the Runtime runs turns and makes model requests | stands |
| [0005](0005-provider-handles-from-the-harness.md) | The Runtime gets access to a model without its credentials, and never chooses the model | stands, amended by the pressure test |
| [0006](0006-hook-points-belong-to-the-operation-owner.md) | Whoever owns an operation defines its hook points; the Runtime never runs handlers itself | stands, amended by 0011 |
| [0007](0007-context-management-is-a-hook.md) | What the model sees is decided at a hook point before each step | stands, amended by 0011 and the pressure test |
| [0008](0008-pi-is-the-reference-implementation.md) | Pi is the reference implementation | stands, amended by 0010 |
| [0009](0009-own-protocol-south-adapters-north.md) | Our own protocol between Harness and Runtime, adapters elsewhere | withdrawn by 0010 |
| [0010](0010-describe-parts-not-wiring.md) | Describe the parts and how they fit, not how they are wired | stands |
| [0011](0011-minimal-harness-everything-is-a-plugin.md) | The Harness does the minimum, and everything else is a plugin | stands |
| [0012](0012-one-agent-is-the-scope.md) | One agent is the scope; hosts that coordinate several agents drive it from outside | stands |
| [0013](0013-first-binding-typescript-in-process.md) | The first implementation is TypeScript in one process, with a package per part | stands, extended by 0014 |
| [0014](0014-plugins-in-other-processes.md) | A plugin can run in another process, through one generic RPC | stands |
| [0015](0015-parts-as-services.md) | Parts can be services, each with its own HTTP API | stands |
| [0016](0016-rules-from-three-clean-room-builds.md) | The rules three clean-room builds agreed on become part of the contracts | stands |
