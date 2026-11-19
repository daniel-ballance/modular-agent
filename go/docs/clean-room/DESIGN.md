# Milestones 1 to 4 design

Read before design: every file under `docs/`, including the raw research transcript, and `GLOSSARY.md`. The current architecture and contracts take precedence over superseded research.

## Parts and public boundaries

One Go module, using the standard library and pinned ACP/MCP SDKs for the protocol adapters. `api` holds common data and capability interfaces. `harness` hosts plugins and owns open sessions. Packages for history, transient and durable Runtimes, local working environment, tools, configuration, credentials, model selection, system prompt, context management, commands, guardrails, Anthropic, fake Provider and terminal each install through the plugin API. The composition root chooses plugins, resolves trusted configured factories and starts the selected terminal, ACP or HTTP capability. Real agents now receive a gateway Provider plugin, never a credential store or direct real Provider.

The Harness delegates turns to the Runtime, tool calls to a tool source, model selection to its plugin, and persistence to a history store. It implements no model loop, file tool, vendor request, compaction policy or terminal display. The Runtime receives model access without credentials and restricted session ports. Plugins invoke hooks through identity-bound API handles. Only the owner can invoke a point. Hook definitions fix combination rules, with stable first, normal and last handler groups.

Tests use these public boundaries:
- Plugin API: registration, replacement, ownership and hook combination. Does not test plugin internals.
- Session API: input, outcomes, tree history, restart, fork, erasure and disk writer exclusion. Recovery delegates the interrupted turn to the selected Runtime.
- Working environment and tools: real temporary folders and controlled subprocesses. Linux PID namespaces promise process lifetime cleanup, not filesystem containment.
- Provider: a scripted fake for all acceptance tests, and an HTTP test server for Anthropic protocol adaptation. No external network or credentials in tests; protocol adapters use loopback test servers and dummy credentials.
- Terminal: streams and subprocesses. Covers print, events and interactive line mode, not a full-screen UI.

## State and execution

Session history is a tree, physically stored as an atomically replaced JSON snapshot. Writes sync the file and its directory. Writer leases use Linux advisory locks. Unused sessions never save a snapshot. A position move is an audit entry separate from the branch position. Forks retain copy provenance for erasure.

Input receipts and keys live in history. Steering is consumed between steps, after all current calls settle. Follow-ups start subsequent turns. Cancellation returns queued inputs. Every returned model call is recorded before execution and receives one result, including validation errors and cancellation of the rest of a batch. Calls were sequential in milestone 1. In milestone 2 an all-parallel batch overlaps its tool bodies. Checks and start records remain ordered; after-tool hooks and result commits stay in model request order.

Context management computes the current branch before every step, adds summaries with provenance and keeps recent complete model/tool batches. Overflow retries are bounded. A guardrail may buffer all model text for a step until its stream ends, then redact it. Every external event and history view passes the output gate; the raw record does not.

## Scope

Milestones 1 to 4 only. Questions, approval, jobs, subagents, result checks, MCP and ACP are plugins. Configured factories load before sessions open, under explicit project trust. No live plugin replacement while sessions are open and no milestone 5 HTTP services. A plain shell descendant can outlive a turn, but is not a managed job. All descendants stop on agent death, including SIGKILL and process-group escape.

## Recovery and the swap

`transient` and `durable` provide one capability with the same standard hooks. They configure a shared `turnrun` protocol implementation; no feature plugin knows which Runtime is selected. Runtime declarations report durability, steering and parallel batches. Model access declares stateful requests and Provider-run tools; the working environment declares crash cleanup. `/support` reads these declarations rather than assuming a Runtime.

The Harness reconstructs receipt queues and finds the unmatched turn start on the current branch. It supplies the recorded identity, input and settings to the Runtime. A changed composition gets an active-plugin audit entry. Navigation into a partial turn is refused, so historical branching is not mistaken for a crash.

The runner journals a step before requesting the model, the complete response before tool execution, and each call start before outside effects. A step checkpoint preserves the count, accumulated usage and the decision to continue or finish. A response is authoritative for its calls even if their individual records were not yet written. Saved results never repeat. The transient Runtime settles pending calls as unknown or not started and fails. The durable Runtime runs not-started calls, repeats started calls only with both old and current safety declarations and crash cleanup, and gives other interrupted calls an explicit unknown result. Interrupted stateful or tool-running model requests fail without being resent.

Incomplete hooks may run again. Arbitrary plugin outside effects are not exactly-once; plugins must record idempotent progress. Recorded model/tool bodies and step decisions are reused. Checkpoints carry copy provenance so erasure reaches cached results too.

## Linux command lifetime

Each bash call re-executes the executable into an internal helper as PID 1 of a fresh unprivileged user/PID/mount namespace. The helper mounts namespace-correct `/proc` and clears its temporary namespace mount capabilities on the same locked OS thread before starting the command. The helper has no agent, Provider or credentials. It receives the project and command over a private pipe, forwards live output, reports shell completion on a separate pipe, and then owns background descendants until agent shutdown. A shell output wrapper and `os/exec.Cmd.WaitDelay` let shell backgrounding return without waiting for descendants holding output descriptors.

The lifetime watcher drains until EOF; a trailing request newline is not shutdown. On EOF the helper exits. Linux PID namespace teardown kills all remaining members, even if the helper itself gets SIGKILL. A registry is published atomically and synced before commands may start. It names owning agent and helper by host PID, start time and boot ID. Startup removes dead entries and kills abandoned helpers before turns resume. Unsupported namespace creation fails explicitly.

These mechanics were checked against the pinned Go `os/exec` and `syscall` documentation and installed Linux man-pages 6.13:
- https://pkg.go.dev/os/exec#Cmd.WaitDelay
- https://pkg.go.dev/syscall#SysProcAttr
- https://man7.org/linux/man-pages/man7/pid_namespaces.7.html
- https://man7.org/linux/man-pages/man2/clone.2.html
- https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html

Go is pinned to the installed 1.27.4 rather than the initial moving `latest` selector.

## Questions, authority and UI calls

The Harness owns actor membership and grants as session state. Trusted Interfaces supply authenticated actor identities. Child authority intersects a saved ceiling with the parent's current authority recursively. Grants cannot exceed the grantor's rights, forks retain their ceilings, and different actors cannot steer one existing turn.

`questions` records keyed requests and answers, waits on notifications, and derives answerability from the current branch and call results. A key binds the request shape. Replayed answers must still have authorized actors, including every forwarding hop. `approval` supplies the policies on the standard tool gate and validates the allow again after later gates and immediately before the body. It fails closed without a connected responder. A secret bypasses the Runtime: the answering Interface calls the question capability, which writes directly to `credentials`; every record, event and return value contains only the destination name.

An explicitly parked call has a tool.open checkpoint and no tool.result. Its turn returns the call as open. Once the batch's questions are answered, keyed intake starts a continuation turn that reuses the original call identities and reruns checks. `contextview` describes nonadjacent open calls and late results as text only in the model view, preserving valid vendor exchanges and the untouched raw record. Navigation and erasure require finished calls and jobs.

The Runtime's model-free RunCall uses that same pipeline for UI calls. External starts preserve definitions before per-call records exist, so reopen can apply the selected Runtime's normal safety rules. Ordinary UI calls do not start a model turn; their late questions and job reports can. `resultcheck` is an optional plugin using the existing result hook; rejected results add a recorded reason and continue within the original step limit.

## Jobs and subagents

`jobs` records keyed starts and ends. An owner plugin takes up unfinished work, rather than the Harness guessing its outcome. Completion precedes keyed report intake; reopen retries reports without duplicating them. Waited work returns through its initiating call without a second report. Job usage contributes to session totals. Copy links connect initiating calls, child task input, child results, job ends, reports and waited tool results, so erasure reaches all those history copies without restarting erased work.

`subagents` uses only those APIs. Each job names its separate child session before the task starts. Child input is keyed by job, with no parent history copied. Follow-ups are new jobs on the same remembered session, narrowed again. Questions are mirrored one parent at a time, and sanitized answers return through recorded links. The transient variant reports interruption as unknown. The durable variant reopens the child; a transient Runtime can repair its interrupted turn and mark the outcome interrupted, allowing the owner plugin to continue in a fresh turn keyed by that interruption. Repeated process stops do not strand that continuation.

Process shutdown first interrupts every job, then stops the sessions, leaving recoverable work unfinished. Explicit session close cancels jobs, settles parked calls and closes child sessions. Both Runtime variants share these plugin contracts. `GAPS.md` records the choices where the description did not define them.

## Hosts, tool sources and trust

`acpinterface` is a stable ACP v1 Interface plugin using a maintained Go library's generated types, bidirectional dispatcher and stdio framing. It acts for the locally launched host, routes standard lifecycle/configuration/permission/elicitation operations through the plugin API, and uses only gated events and views for delivery. The full host surface uses declared extensions where ACP v1 has no matching method. Entry IDs let hosts resume recorded follow after reconnecting; missed live pieces are not replayed. Model/thinking changes can be recorded during generation but take effect next turn. Recovery resolves access from the interrupted turn's original settings, not newer defaults.

`mcptools` adapts the official MCP Go SDK to the standard tool-source contract. Configured connections are shared; ACP attachments are keyed by session and removed on close/stop. Attachment prepares all connections before publishing any tools. Names are deterministic and collision-checked. Standard annotations become conservative hints, rich definitions/results retain opaque metadata, and MCP list changes refresh the source. Transport failures return explicit unknown results. SDK transports own protocol negotiation and cancellation. The Runtime knows neither ACP nor MCP.

Configuration names compiled factories with JSON options. The composition root loads trusted global specifications and then explicitly trusted project additions/overrides before sessions open. Untrusted project plugin data is not decoded, though session defaults still apply. A project-policy capability rejects new/open for another canonical root before effects, so process-wide trusted registrations cannot leak into another project. Trust is an invocation choice and cannot be supplied by project content or the ACP peer. There is no plugin sandbox, source installer or shared-object ABI. `HOSTS.md`, `PROTOCOL_SOURCES.md` and G29 to G31 record the concrete binding and limitations.

## Parts as services

`cmd/modular-service` starts exactly one service role per process. `historyhttp`, `environmenthttp` and `gateway` expose capability-specific authenticated HTTP APIs; their agent plugins implement the existing Store, WorkingEnvironment and Provider interfaces. Neither Runtime changed for the service binding. `agenthttp` is a normal Interface plugin, not a second Harness or model loop. `servicehttp` supplies bounded JSON framing, bearer authentication, redirect refusal, loopback/HTTPS policy and explicit keyed retry support.

Remote history wraps the existing synced snapshot store with renewable expiring leases and server-generated fencing tokens. Every write must still own a live token. Acquisition and save identities survive a dropped answer within the lease lifetime; delayed successful-save retries cannot roll metadata back. Service restart preserves snapshots but invalidates tokens. Cross-client erasure refuses other active owners.

A persistent authenticated agent connection owns a Bubblewrap worker. The worker keeps a local supervised environment inside its private sandbox, so shell backgrounding returns while descendants remain bound to agent lifetime. Command-request cancellation stops that command; lifetime EOF stops every command. Service/worker death tears down their PID namespaces. File operations use Go's rooted API. Only the project tree is writable host storage, with read-only system binaries and private virtual filesystems/network. This does not turn trusted plugins or MCP programs into sandboxed code.

The gateway contains the real Provider and credential store together. Agent-side model access carries the selected model, request, streamed parts, response and error classifications, never model credentials. Vendor generation is not automatically retried. Unknown outcomes remain explicit, and recovery still checks Provider state/tool declarations. Secret requests are declined in agents without a credential destination; dummy-store offline compositions retain the earlier secret tests.

HTTP followers receive gated recorded entries after an exclusive entry-ID cursor, in append order across the entire record. Gated live events are separate and best effort. Polling the current gated snapshot avoids replay/live gaps caused by records without an emitted event, without retaining a second erasure-sensitive event log. The cursor advances only after a complete entry frame is sent. A live follower, not an idle open session, supplies responder presence. Keyed intake uses existing persisted receipts and continues despite a lost HTTP acknowledgement. `SERVICES.md` and G32 to G35 describe the concrete APIs, failure semantics and deployment limits.
