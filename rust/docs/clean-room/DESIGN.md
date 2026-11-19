# Design through milestone 5

The frozen description and GLOSSARY.md are the spec. ACCEPTANCE.md is the test plan.

## Parts

The workspace has one crate per part. agent-api defines the in-process plugin API, standard data, capabilities and hook rules. agent-harness hosts registrations and owns open sessions only. It delegates all disk I/O, inference, tools and turns. Each other part is a plugin crate. runtime-engine is shared implementation code for the two Runtime plugins, not another capability. modular-agent is the composition root, not a second Harness.

Plugins install capabilities, hook points, handlers and commands through a Registrar. Typed capability values sit behind named registrations. A hook point carries an owner token. Only its owner gets that token, and only a matching token can invoke it. Installation is transactional. Replacement removes the old plugin's registrations before checking the new ones.

Each Runtime receives bound ModelAccess, not a Provider catalog or credentials. Model selection binds access before the turn. Runtime code uses only the plugin API, ModelAccess, cancellation and standard data.

## Public test surfaces

These follow the acceptance criteria, without requiring the user to choose implementation details:
- Plugin API: loading, replacement, capabilities and hook dispatch.
- Session API: tree history, queueing, cancellation, forks, erasure and restart.
- Complete composed agent with a scripted fake Provider: turns, tools, context and settings.
- Terminal Interface in fresh processes: print, JSON and line modes, locks and real continuation.

Tests inspect durable state to prove erasure, unused-session laziness, checkpoint boundaries and one result per interrupted call. Automated inference uses provider-fake or the real OpenAI adapter against a fake loopback endpoint with synthetic credentials. No test needs external network access or the real key. MCP HTTP fixtures also bind loopback.

## Storage and output

history-fs uses atomic whole-session JSON snapshots, diskless Linux abstract-socket writer leases and a short advisory store lock. Normal writes only append entries. Position moves append entries on the selected branch. Fork entries name their source entries. Erasure walks those links across all stored sessions and removes content from originals and copies.

Raw history is privileged plugin data. Interface output, events, results and model-facing views pass the Harness output gate. Live pieces are not persisted twice. The guardrail can hold a stream until its end, then redact literals, including those split across pieces.

## Durable turns and concurrent tools

Both Runtimes save turn inputs, request intent, responses, started calls, invisible completed-call checkpoints and step decisions. The durable policy revisits an incomplete step, reconstructs missing call records from its response, and dispatches only calls that never started or are safe to repeat. The transient policy settles unfinished calls and fails the turn. Completed-call checkpoints prevent replay even when results were waiting for their ordered publication. A committed terminal step decision finishes without another model request.

Every tool in a round must allow overlap; otherwise the round is serial. Completion order is independent of model-visible result order. Standard hooks, model access and all other plugins are unchanged by the Runtime choice. Recovery runs checks again on work it dispatches; arbitrary hook side effects must be keyed by their owner.

## Command containment

A dedicated thread forks the shell and traces its descendants with Linux exit-kill. The initial child has a parent-death signal and stops before exec, until tracing is established. Fork, vfork, clone and exec events track descendants independently of process groups. Shell completion, cancellation and dropped calls kill and reap their descendants. Agent or tracer death invokes the kernel backstop. Durable boot/PID/start-time records permit next-start cleanup using PID-pinned signaling, before a Runtime resumes any work.

This is an agent-owned thread, not another agent process or capability service. Commands themselves are subprocesses. Failed tracing setup fails the tool closed. This is not a hostile-code sandbox.

## Questions and authority

feature-questions owns the keyed request ledger and answer boundary. Questions and sanitized answers are record-only entries. The service serializes answer acceptance and wakes waits with Tokio Notify, registering before checking history. Secret values are handed directly to the credential store; only their names leave that service. feature-approval owns policy and calls the request service at the Runtime's before-tool gate. Presence is explicit, not inferred from an event observer.

Named authority is session state in the Harness. Grants may not exceed the grantor's rights. Inputs capture authority when admitted, and a turn intersects those caps with every contributor's current rights. Child caps are immutable and intersected through ancestors. Reports act as job:ID, not user. Protected grant records cannot be erased to restore rights.

A timed-out request leaves no tool result. The Runtime returns open calls and a limit outcome. When all questions in the call group are answered, Interface draining starts a new turn and reruns the usual checks before recording late results. Model views alone synthesize waiting placeholders. UI calls enter this same pipeline without model access or inference. The existing result-ready hook supports validation retries in the same turn.

## Jobs and subagents

feature-jobs records starts and asks named JobRunner capabilities to work. A job end and its report input are published in one Harness/history-store commit. Reports and child-task inputs are keyed and restored on reopening. A runner declares whether it resumes; otherwise an interrupted job reports unknown. Cancellation signals the runner and waits for cleanup. Cancelling a turn leaves its jobs running; session close cancels them.

feature-subagents offers delegate and provides a job runner. Child sessions use the same plugins/project, copied settings, an authority cap and only their task as initial input. A persistent parent link carries question routing through every ancestor. Each later message is another job in that child's existing history. Background work reports as parent input; waiting work returns through its call, never both. Child-task usage includes nested jobs and excludes earlier messages. Default depth is three.

Subagent durability is independent of the parent Runtime. Both Runtime installations provide child-policy handles, while only one selected Runtime runs each session. Durable children resume their saved turns; transient children close interrupted questions and report unknown. A crash between child initialization and parent job start can leave an unused session, but task execution cannot precede the job record.

## Hosts, settings and trust

interface-acp uses the official SDK to adapt ACP v1 onto the plugin API. The composition root supplies only a project-bound factory, storage discovery and MCP attachment. Each ACP session gets an isolated in-process composition, so project plugins/options and host tool sources cannot leak into another session. SDK request callbacks immediately schedule connection-owned tasks: awaiting turns in ordered dispatch would block the replies they need. An event worker maps gated events to typed ACP updates, flushes them before responses and routes questions through the request service. Session RPC results and history replay are gated too.

The existing local actor ID user represents the launch-user host over ACP and is declared as kind host. Standard lifecycle, prompts, cancellation and configuration methods are supplemented by declared _modular/ host operations. There is no hidden Interface turn scheduler. Reconnection recovers history entries and keyed receipts, not lost stream fragments.

config-files separates ordinary defaults from executable configuration. A prelinked catalog loads named plugins with options before session admission. Project plugin declarations/options are ignored unless an external canonical-path trust ledger allows them. Ordinary project defaults still apply. Internal underscore-prefixed state cannot come from configuration files. Compositions stay fixed while sessions are open, and reopening checks current trust rather than executing serialized old configuration.

## MCP tool sources

tools-mcp uses official rmcp for stdio and Streamable HTTP. Source instances are keyed by session. Settings sources connect on session preparation; host sources attach only to the receiving session. A Harness-owned session.prepare hook runs before interrupted Runtime work, making tools ready for recovery. Raw MCP definitions/results are retained in standard hints and structured values, while the current model-facing result is text. Annotations have conservative defaults; parallel execution is off.

Startup rolls back partial connections. Session close awaits SDK shutdown and reaping; direct stdio servers have a parent-death backstop. HTTP services remain external. Header/env options are not recorded, and redirects are off. Tool lists refresh between turns; an active turn keeps its captured definitions for consistent replay.

## Provider state and remote erasure

provider-openai has stateless and stateful composition modes. In both modes the Runtime supplies the full authoritative context. The adapter applies its middleware to that full request and only uses previous_response_id when exact input items extend its cached request plus raw output under unchanged instructions. It sends only the suffix, but always sends current instructions and tools. Unknown vendor items and encrypted reasoning remain in raw response data.

Bindings share a session-keyed cache and a request/deletion gate. Discard, movement, closing, model changes and erasure invalidate continuation. Forks start with independent identities. Compaction's auxiliary request is reconciled like any other, and discards after the summary is recorded. Caches do not survive restart; history does.

An atomic Provider inventory under DATA_DIR/openai stores response IDs, uncertain-request markers, erasure IDs and cleanup status, never prompts or credentials. The request marker precedes HTTP dispatch; received IDs are inventoried before response observers. Failed or cancelled exchanges do not advance the cache. A definite previous-ID rejection can retry with full context; unknown effects do not replay automatically.

Harness erasure is asynchronous and excludes active turns. It commits local history erasure, invalidates caches and asks Providers to delete controlled copies. OpenAI deletes every known ID, awaiting each acknowledgement. Failed deletion remains durable and blocks opening/inference. Comparing the inventory's erasure IDs with history catches a crash before cleanup intent was recorded. The result reports unreachable delivered output, unknown IDs and vendor-side retention/logs. No Runtime implementation needed a vendor-specific change.

## Scope

All five required milestones: multiple actors, questions/approval, local projects, both OpenAI modes, both Runtimes and subagent policies, jobs, validation, UI calls, parallel built-ins, Linux command containment, terminal and ACP Interfaces, MCP tools and settings-based plugins with project trust. The full-screen terminal UI was optional and skipped. Milestone 5 is the stopping point.
