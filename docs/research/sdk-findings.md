# SDK findings: decisions and dispositions

These are review notes, not requirements. The SDK and binding pages contain the wording that was adopted. Repeated findings from different languages are counted once. A finding that made several independently actionable claims is split below.

## Decided by ADR 0029

[ADR 0029](../adr/0029-sdk-decisions-after-four-builds.md) settled these five points.

1. **ACP service liveness.** The service answers `$/ping` even before initialization; the client can use JSON-RPC or WebSocket pings. See [An agent service](../bindings/websocket.md#an-agent-service).
2. **ACP token scope.** Omitted tenants allow only sessions without a tenant. Projects match canonical paths exactly; an omitted list uses the composition's scope. An empty list grants nothing. Token rights cap recorded grants without rewriting them. See [An agent service](../bindings/websocket.md#an-agent-service).
3. **Persistent history under `ephemeral`.** Reject persistent stores and history services with `invalid_composition`, naming `kept`. See [Durability](../sdk/placement.md#durability).
4. **Model requests from a command.** A call-scoped operation sends auxiliary requests through the session's Provider without starting a turn or dispatching tools. See [Commands](../sdk/api.md#commands).
5. **API-key reasoning levels.** Use one [shared model table](../sdk/api-key-models.md) for offered levels and request mappings. See the [vendor research](sdk-api-key-reasoning.md).

## Applied (22)

| Point | Findings covered |
|---|---|
| Plugin-host lists, defaults, order and startup errors | Rust, TypeScript, Go, Python WebSocket startup |
| ACP listener handle | Rust, TypeScript and Python listener findings; Go spelling in Languages |
| Service-owned `home` state | Go WebSocket startup |
| Per-connection registration and plugin factories | TypeScript and Python service findings |
| Service liveness option spelling | Python service finding |
| WebSocket serving spellings | Rust services |
| Duplicate credential option | Rust, Go, Python |
| Commit before returning a secret answer | Rust questions |
| Scratch versus persistent `dataDir` | Rust, Go, TypeScript |
| Queue policy ownership and fallback | Rust and TypeScript Runtime declaration findings |
| Truthful held-output declaration | TypeScript current findings |
| Completed tool value required and checked after the hook | Go and TypeScript result-processing findings |
| Latest settled turn | All four Guide 05 findings |
| ACP composition and saved-session factory | Rust, Go, TypeScript, Python Guide 08 findings |
| Operator-set ACP actor id | TypeScript Guide 08 finding |
| Embedded session options and represented actors | Rust, Go and Python Guide 05 findings |
| History service and client spellings and scheduling | All four Guide 09 findings |
| Go, Rust, TypeScript and Python question guide corrections | All four Guide 04 findings |
| Provider catalog notifications and refresh | Rust and TypeScript served-catalog findings; Go and Python Guide 06 |
| Provider readiness and credential context | Go and Python Guide 06 findings |
| Hook examples, placement and failures | Rust, Go, Python Guide 07 findings |
| Offline process tests | Rust and TypeScript examples in [Guide 03](../sdk/guides/03-tool-in-another-process.md) |

## Rejected (30)

| Point | Reason |
|---|---|
| Setting names and busy setting changes | Portable keys and `settingsDuringTurn` already define the boundary; native names differ by build. |
| Failure before normal input recording | The fallback is Rust-specific; the SDK already requires the prompt to return the disposition or the matching turn outcome. |
| Local command containment, points and file confinement | Declarations already come from the selected environment. Do not claim local paths are confined when a build follows paths outside the project. |
| Memory capabilities | Erasure depends on the store and agent, not on the store being named memory. No portability is promised by in-memory history. |
| Writer conflicts | The native lock's lack of expiry is not a reason to change the HTTP lease contract. |
| ACP sharing a Harness | Internal composition and connection lifetimes are not a new public API. |
| Event cursor and replay | The SDK already requires exclusive replay after the cursor, `null` for the beginning and disconnection on overrun. |
| Per-actor event gating | Already required, including for live events. Do not make Rust's shared live sink an exception. |
| Plugin setup preflight and failure | The SDK already says to register after config and refuse unsupported registrations, without running setup twice; passing a base PluginApi and partial loads remain prohibited. |
| Missing base history store | The SDK already installs a store; the base default is not the SDK default. |
| Late questions and job-started turns | Already opt-in. Only the binding and the declared capabilities decide which points can leave work open. |
| Native hook translation and extra shared fields | The SDK already requires the binding's shapes, inert unknown fields, and rechecking changed tool input. |
| Native and served history layouts | Serving eligibility and separate opaque namespaces are already specified; SQLite, JSONL and a relay are not SDK requirements. A nonconforming memory fixture is not a conforming service. |
| One installed model catalog | The catalog note already tells a developer to choose an offered id. Do not require the base dependency's catalog. |
| Invalid composition for missing history | Already rejects kept/durable without a persistent store and permits an explicit one. `dataDir` for a part that needs it is separate. |
| ACP open waiting for recovery | Already forbids waiting on ACP and permits it on the embedded SDK. |
| Unknown models | Boundary errors are already specified. A saved model that disappears follows the shared failed-turn rule, not a new input refusal. |
| Post-admission Provider failures | The SDK already records a failed AssistantMessage and uses `other` for an untyped error. |
| Unexpected scripted answers | Separate verification and boundary decline already specified. |
| Rust stream import | Guide 01 already imports `futures_util::StreamExt`. |
| Fixture command line | Already takes one fixture name and appends four service arguments. |
| Process group exit | Already requires reaping the child and waiting for every live member to stop; zombies count as exited. |
| Structured turn result | Already defines text-to-JSON, null and validation feedback. |
| Simulated restart | Already defines interruption without graceful settlement and distinguishes it from a real crash. |
| `waitingThroughRestart` | Already conditional on durable re-asking, not on a live unanswered wire request. |
| `nestedToolCalls` | Already derives support from the Runtime path and excludes private wire flags. |
| Tool hints | Shared serialization already puts the four hints in `hints`. |
| Tool failure diagnostics | Fixed wording is allowed; placement equality is already required. |
| Scenario requests | Approval hints, input validation, nested call lineage and cancellation/idempotency are coverage requests for existing rules, not new specification rules. |
| Explicit processes with `pluginHost: false` | The host role requires discovery; the SDK intentionally rejects the contradiction. |
