# SDK findings: decisions and dispositions

These are review notes, not requirements. The SDK and binding pages contain the wording that was adopted. Repeated findings from different languages are counted once. A finding that made several independently actionable claims is split below.

## Open decisions

1. **ACP service liveness.** The WebSocket binding calls for a JSON-RPC ping, but only the plugin binding supplies message and deadline rules. All four ACP servers recognize `$/ping`; this does not establish a client requirement. Go proposed control messages only for plugins; Rust proposed defining the ACP reply without changing initialization. Options: define ping for ACP over this transport, or use only WebSocket ping/pong for ACP. **Recommend** defining `$/ping` (`{}` to `{}`, before or after `initialize`, without changing session state) and a five-second default control deadline here, not in the stdio ACP binding. Keep the pending-work rule for plugin clients; for ACP, decide explicitly whether to require the same client timer or permit WebSocket frame liveness instead. Recommend permitting either liveness mechanism for ACP.
2. **ACP token scope.** Rust and TypeScript treat omitted tenants as unrestricted; Go and Python allow only sessions without a tenant. Rust includes descendants of a listed project; the others match canonical project paths exactly. TypeScript proposes capping recorded grants at connection time; Go rejects a connection's access to a session when the durable grant is broader than the token. Options: wide or narrow omitted scopes, exact projects or subtrees, and a token-rights ceiling or rejection of broader grants. **Recommend** no-tenant only by default, an explicit list with null for no tenant, exact canonical project matching, and omitted projects bounded by the serving composition. Empty lists grant nothing in their scope. Intersect rights at connection time without rewriting history; specify this as a network ceiling in the authority rules, not as an implicit change to ACP recorded grants.
3. **Persistent history under `ephemeral`.** The SDK says `portableSessions` is false there. Go and Rust tie that declaration to the mode; TypeScript and Python can report portability based on the selected store. Options: reject persistent history under `ephemeral`, accept it but never promise portability, or let a store determine portability independently of the mode. **Recommend** reject explicit persistent stores under `ephemeral` and direct callers to `kept`; the mode should say whether records survive, not just which store was picked by default. Until decided, use `kept` or `durable` for portable sessions.
4. **Inference from a command.** The [core command contract](../contracts.md#commands) already requires authorization, dispatch checks, recording and metering. It does not settle the SDK's public call shape, which prepared context a command gets, or how to handle a model's tool requests. Options: expose only higher-level commands supplied by the SDK, or expose a call-scoped auxiliary request operation for developer commands. **Recommend** the latter: use the session's current model and normal Provider hooks, account to the session and tenant, record by `stepId`, and neither start a turn nor dispatch tools from the model reply. Do not expose an unscoped Provider adapter.
5. **API-key reasoning levels.** See the [vendor research, options and recommended request mappings](sdk-api-key-reasoning.md). Recommend one vendored capability table shared by all four SDKs; no guessed settings for new ids.

## Applied (19)

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
| ACP factory, identity and actor option spellings | Rust, Go, TypeScript, Python findings for Guides 05 and 08 |
| History service and client spellings and scheduling | All four Guide 09 findings |
| Go, Rust, TypeScript and Python question guide corrections | All four Guide 04 findings |
| Provider catalog, readiness and credentials | Go and Python Guide 06 findings; Rust and TypeScript served-catalog findings |
| Hook examples, placement and failures | Rust, Go, Python Guide 07 findings |
| Offline process tests | Rust and TypeScript examples in [Guide 03](../sdk/guides/03-tool-in-another-process.md) |

## Rejected (24)

| Point | Reason |
|---|---|
| Setting names and busy setting changes | Portable keys and `settingsDuringTurn` already define the boundary; native names differ by build. |
| Failure before normal input recording | The fallback is Rust-specific; the SDK already requires the prompt to return the disposition or the matching turn outcome. |
| Local command containment, points and file confinement | Declarations already come from the selected environment. Do not claim local paths are confined when a build follows paths outside the project. |
| Memory capabilities | Erasure depends on the store and agent, not on the store being named memory. No portability is promised by in-memory history. |
| Writer conflicts | The native lock's lack of expiry is not a reason to change the HTTP lease contract. |
| ACP sharing a Harness | Internal composition and connection lifetimes are not a new public API. |
| Event cursor, replay and actor gating | Cursor and per-actor gating are already specified. Do not make Rust's shared live sink an exception or permit dropping live pieces instead of disconnecting on SDK overrun. |
| Plugin setup preflight and failure | The SDK already says to register after config and refuse unsupported registrations, without running setup twice; passing a base PluginApi and partial loads remain prohibited. |
| Missing base history store | The SDK already installs a store; the base default is not the SDK default. |
| Late questions and job-started turns | Already opt-in. Only the binding and the declared capabilities decide which points can leave work open. |
| Native hook translation and extra shared fields | The SDK already requires the binding's shapes, inert unknown fields, and rechecking changed tool input. |
| Native and served history layouts | Serving eligibility and separate opaque namespaces are already specified; SQLite, JSONL and a relay are not SDK requirements. A nonconforming memory fixture is not a conforming service. |
| One installed model catalog | The catalog note already tells a developer to choose an offered id. Do not require the base dependency's catalog. |
| Invalid composition for missing history | Already rejects kept/durable without a persistent store and permits an explicit one. `dataDir` for a part that needs it is separate. |
| ACP open waiting for recovery | Already forbids waiting on ACP and permits it on the embedded SDK. |
| Unknown models and post-admission failures | The boundary errors and failed AssistantMessage are already specified. A saved model that disappears follows the shared failed-turn rule, not a new input refusal. |
| Unexpected scripted answers | Separate verification and boundary decline already specified. |
| Rust stream import | Guide 01 already imports `futures_util::StreamExt`. |
| Fixture argument count, one fixture and zombie reaping | Already four arguments, one fixture, and no live process group member before reopen. |
| Structured turn result and simulated restart | Already defines text-to-JSON and feedback, and interruption without graceful settlement. |
| `waitingThroughRestart` and `nestedToolCalls` | Already conditional; the nested-call declaration already excludes private flags. |
| Tool hints and failure diagnostics | Already defines the shared serialization, fixed wording allowance and placement equality. |
| Scenario requests | Approval hints, input validation, nested call lineage and cancellation/idempotency are coverage requests for existing rules, not new specification rules. |
| Explicit processes with `pluginHost: false` | The host role requires discovery; the SDK intentionally rejects the contradiction. |
