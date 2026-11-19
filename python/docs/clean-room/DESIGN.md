# Design through milestone 5

Read against the full frozen description and glossary, including all research notes.

## Parts

The uv workspace has an installable package for each part. `ma-core` supplies JSON
data helpers and the plugin API contract. The Harness hosts plugins, routes addressed
calls, dispatches owner-defined hooks, and keeps open sessions. It does no inference,
turn looping, file access, command execution or durable storage.

A plugin installs named capabilities with async operations taking JSON data. A call
can emit a stream of JSON progress. The API routes by capability and operation, not
by a concrete class. No session, tool or Provider object travels as request data.
The milestone 5 process binding implements this seam without changing the API.
Plugins use only this API to reach each other.

Separate packages provide SQLite history, a transient Runtime, the local working
environment, file/shell tools, scripted and Claude Providers, configuration,
credentials, context management, system prompt, model selection, a guardrail,
commands and the terminal Interface. Each is independently installable.

## Invariants

- Hook definitions fix their combination rule. Only the registered owner fires them.
  Handler code is dispatched by the Harness, including Runtime and Provider hooks.
- Runtime receives model access as an address plus declared limits, never credentials.
- Requested calls are recorded before execution and settled once on every exit.
- History entries have a parent, attribution, typed content and copy references.
  Position moves and compaction append entries. Only explicit erasure changes content.
- History uses transactions, per-session writer locks and lazy persistence.
- Streams and history views go through an output gate for each recipient. Trusted
  plugins may read raw records. The terminal never renders a raw return value.
- Stateful Providers discard their native context on non-prefix history, model or
  prompt changes, compaction, forks, position moves, erasure and cancellation.

## Runtime swap

`ma-runtime` supplies the transient Runtime and a journalled turn engine.
`ma-durable` is separately installable and replaces only recovery behaviour,
keeping the same capability and hook contracts. Composition chooses it at startup.
The Harness refreshes the active plugin list when an existing session opens.

The Runtime writes progress through the session API, never directly to SQLite.
One committed response contains all requested calls. A crash while admitting
individual call entries is repaired from that response, without inference.
Model intents, tool-start records, hidden tool receipts and step decisions make
recovery unambiguous. Hidden records carrying copied data have erasure provenance.

The durable Runtime preserves turn and step IDs, results, usage and step limits.
A started call needs explicit old and current replay safety plus environment
cleanup before retry. All retried calls run the gates again. Unknown results
tell the model that the call did not finish and to check before relying on it.
Provider state is discarded; interrupted model requests with unknown native
effects fail rather than repeat. No-tools Providers can be restarted safely.

If every requested tool allows parallel execution, the Runtime starts all calls.
Completion receipts persist immediately; visible results commit in request order.
Cancellation joins every started call before settling unfinished calls.
Arbitrary plugin hook effects are at-least-once, not exactly-once operations.

## Local command lifetimes

Each command has a cgroup v2 group and a small watcher outside that group.
The agent persists ownership before creating the group. The watcher forks a
child that enters the group before executing bash. All forks inherit the group,
regardless of process-group or session changes. A private pipe signals agent
death through EOF, including SIGKILL. The watcher writes cgroup.kill and acts as
a child subreaper so background descendants are also reaped.

If the watcher dies too, startup discovers stale groups in the delegated per-user
subtree, using PID plus kernel start time. The data-directory journal adds boot
identity and supports idempotent cleanup. Cleanup finishes before the Harness
opens a stored session. Normal session close and call cancellation use the same
cleanup path; cancellation touches only that call's group.

A writable delegated Linux cgroup v2 subtree is required for bash. There is no
weaker fallback. File tools do not need delegation. Programs are not sandboxed
against deliberately modifying same-user containment machinery.

Sources read for this implementation:
- https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html
  documents cgroup inheritance and cgroup.kill handling concurrent forks.
- Linux man-pages 6.13, PR_SET_CHILD_SUBREAPER(2const), documents orphan adoption
  and reaping, also published at
  https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html .
- Linux man-pages pidfd_open(2) documents stable process references. The opt-in
  live driver uses glibc pidfd functions because this pinned Python build omits
  their optional os/signal wrappers.

## Scope

Milestones 1, 2 and 3 are complete: questions, authority, approval, secrets, jobs,
subagents and checked UI calls are proven offline and in the milestone 3 real run.
See `MILESTONE-3.md` for the API behaviour, acceptance map and declared boundaries.
Milestone 4 adds the ACP Interface, external MCP tool source, settings-loaded
plugins and project trust. `MILESTONE-4.md` records their contracts and official
sources. The optional full-screen UI is skipped. Milestone 5 supplies the complete
plugin process binding in `ma-process`; see `MILESTONE-5.md`. The working
environment's watcher and the external MCP transport are distinct from it.

## Host and tool-source adapters

`ma-acp` receives only a role-bound plugin API, not a Harness reference. It binds
the local stdio owner to the session actor and translates ACP lifecycle, config,
permission, elicitation and cancellation into checked operations. Advertised
extensions cover operations ACP v1 does not name. Outward events, snapshots,
response metadata and protocol errors are gated. Replay occurs in session opening,
before the Harness asks the Runtime to recover. EOF preserves unanswered requests;
explicit close cancels work. The Interface never starts inference itself.

`ma-mcp` supplies definitions through the tool router's owned collect hook. Global
connections serve every session; lifecycle attachments provide ephemeral host
connections to one session before recovery. Connections own their SDK context
managers in one task, because AnyIO cancel scopes must close in the task that
entered them. The official clients handle protocol negotiation, cancellation and
transport cleanup. Tools keep their schemas, structured data and original metadata.
Failure after dispatch without an answer is an unknown outcome, not a failed
effect or an automatic retry.

Configuration separates ordinary session defaults from executable `plugins` and
`plugin_settings`. Only global or explicitly trusted project configuration enters
the startup load plan. The Harness checks its load gate before importing a named
factory. The fixed composition binds to one project, avoiding cross-project plugin
leakage. On CLI reopen, the history capability supplies the saved project before
that plan is selected. Trust is stored outside project control and is not a sandbox.

## Process binding

The Harness wraps selected plugins at load time. Each wrapper execs a fresh
interpreter, transferring trusted pre-start construction through a private
anonymous descriptor with cloudpickle 3.1.2. No live SDK session or event loop is
copied. Only the worker's own descriptors and stdio are inherited. Plugin code
then receives the same API, implemented by a child-side bridge.

A private socket pair carries length-prefixed JSON request, answer and cancel
frames. Connection-local addresses represent services and callbacks. The Harness
retains owner checks, role checks, hook order and combination. A dedicated reader
allows nested calls in both directions. Stream pieces wait for acknowledgement
through the output gate. Cancellation waits for terminal cleanup across every hop.

EOF fails all waiters with a named process-loss error and triggers gated failure
events. Started effects get unknown results, not assumed failure or replay.
Unavailable collect sources withdraw their contributions; gates fail closed.
Workers stop on Harness EOF and are joined/reaped on normal shutdown. Local
command watchers still enforce the independent cgroup lifetime guarantee.

Process transport exposes scheduling boundaries that in-process calls did not:
Runtime admission is serialized per session; jobs.wait confirms keyed report
admission; Harness append locks span durable writes but release before callbacks.
G39 to G43 record these choices and their swap tests. The protocol is local and
same-version, for trusted plugins. It is neither an ABI nor a sandbox.

## SDK sources

The installed official `claude-agent-sdk==0.2.183` and `mcp==2.3.0` are pinned.
Python SDK signatures and custom MCP tools were checked against
https://github.com/anthropics/claude-agent-sdk-python and installed source.
Settings isolation is documented at
https://platform.claude.com/docs/en/agent-sdk/python .
The allowed Pi claude-subscription README and its session isolation options were
also read. Native transcript replay after a fresh transport is a labelled text
record, not a claim of vendor-native message replay.
