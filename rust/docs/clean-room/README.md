# Modular Agent in Rust

An independent, one-process build of the frozen description in docs/ and GLOSSARY.md. All five required milestones are complete, including stateless and stateful OpenAI modes.

## Build and check

Requires Linux, mise, Python 3 for protocol fixtures, and the Rust toolchain pinned in mise.toml.

```sh
mise exec -- cargo build --workspace --locked
mise exec -- cargo test --workspace --locked --offline
mise exec -- cargo test --workspace --locked --offline --features modular-agent/durable-default
mise exec -- cargo test --workspace --locked --offline --features modular-agent/stateful-provider-default
mise exec -- cargo test --workspace --locked --offline --features modular-agent/durable-default,modular-agent/stateful-provider-default
mise exec -- cargo clippy --workspace --all-targets --locked --offline -- -D warnings
mise exec -- cargo fmt --all -- --check
```

The first build downloads dependencies. Tests then run offline with scripted fake Providers or a fake OpenAI endpoint using a synthetic credential. There are **143 passing tests** with the transient default and **142** with the durable default, with either Provider default, including three self-exec helpers. Only the old transient-specific restart test differs. Fifteen new tests exercise the actual OpenAI adapter, including both modes with either Runtime. See MILESTONE-1.md through MILESTONE-5.md for acceptance evidence. HTTP fixtures use loopback only; no automated test needs external network access or the real key.

## Run

Only gpt-6-luna through the OpenAI Responses API is available for real inference. The credential plugin reads ~/.config/modular-agent-experiment/openai.key at request time. Never pass the key as an argument or put it in project settings.

```sh
# Interactive line mode
mise exec -- cargo run -p modular-agent --offline -- --project /path/to/project

# Print one final answer. The session ID is reported on stderr.
mise exec -- cargo run -p modular-agent --offline -- --project /path/to/project -p "Read README.md and summarize it."

# Let OpenAI keep state between requests, sending only new input items.
mise exec -- cargo run -p modular-agent --offline -- --provider-mode stateful --runtime durable --project /path/to/project

# Continue in a new process, using the recorded project
mise exec -- cargo run -p modular-agent --offline -- --session SESSION_ID -p "Continue."

# JSON events on stdout, one object per line
mise exec -- cargo run -p modular-agent --offline -- --json --prompt "Read README.md."

# Use the durable Runtime, or reopen an interrupted turn without new input
mise exec -- cargo run -p modular-agent --offline -- --runtime durable --project /path/to/project
mise exec -- cargo run -p modular-agent --offline -- --runtime durable --session SESSION_ID --json </dev/null

# List sessions for this project, or every project
mise exec -- cargo run -p modular-agent --offline -- --project /path/to/project --list
mise exec -- cargo run -p modular-agent --offline -- --list --all-projects

# Inspect a saved session or the agent's declaration
mise exec -- cargo run -p modular-agent --offline -- --session SESSION_ID --history
mise exec -- cargo run -p modular-agent --offline -- --declaration
```

Line mode accepts /commands, /model, /thinking, /settings, /compact, /sessions, /move ENTRY_ID, /move root, /fork [ENTRY_ID] and /erase ENTRY_ID [...]. A fork returns a new session ID; reopen that ID to use it. /move does not restore files. /compact may make an auxiliary summary request, but starts no Runtime turn. Other commands do not call the model.

While a turn runs, ordinary lines steer it. /after TEXT queues a new turn. /cancel or Ctrl-C cancels and returns untaken input. /quit closes line mode. EOF waits for accepted work to finish, but cancels questions that can no longer be answered.

## Provider state and erasure

Select --provider-mode stateless or stateful independently of the Runtime, in terminal or ACP mode. Stateless remains the default. The stateful-provider-default feature changes that compile-time default. Only gpt-6-luna is available in either mode.

The agent always supplies its full authoritative context. Stateful OpenAI sends a suffix with previous_response_id only when that view exactly extends the successful cached context. Movement, forks, compaction, erasure and changed views start fresh. A restart also sends full context; no continuation pointer is restored.

Erasure deletes all known remote response IDs before returning success, not just the latest pointer. The report lists unreachable copies, including delivered output, unknown response IDs and vendor-side retention/logs. Failed deletion remains pending and blocks reopening or inference until retried. Keep DATA_DIR/openai with the session data so later erasure can find earlier IDs, even when reopening in stateless mode. See MILESTONE-5.md for the tests, remote-retention limits and live proof.

Cargo's --offline prevents dependency downloads, not intentional model API calls.

## Questions, jobs and subagents

Approval is a plugin. Select --approval off, ask_unless_read_only, ask_always or never_ask. The default is off. Interactive mode registers an answerer; a print/JSON prompt does not. Approval fails closed with nobody authorized to answer.

The model's ask_user tool asks for text, a choice or a named secret. /questions lists requests; /answer REQUEST_ID VALUE answers one without putting raw answer input into ordinary history. A secret goes only to the credential store; the record and model see its name. Explicit question deadlines leave calls open without history stand-ins. A late answer lets the Interface start a new turn.

The delegate tool starts a subagent job with only its task and no more authority than its parent. background defaults to true; false waits for the answer without also reporting. A later session argument messages a finished child with its own history intact. The default depth limit is three. Leave authority null/omitted to inherit, or use the tool's named-right enum to narrow it.

Subagents default to durable independently of the parent Runtime. --subagents transient selects unknown-outcome reporting after interruption instead. --subagents durable resumes child work. /jobs lists jobs and usage; /cancel-job JOB_ID cancels one. Turn cancellation leaves jobs running; session close stops them. Prompt mode drains jobs and their report-triggered parent turns before exiting.

UI-started /tool JSON calls use the same authority and approval checks without a model request. Example: `/tool {"name":"read","input":{"path":"README.md"}}`.

## ACP, MCP and project trust

```sh
# ACP stdio Interface. The client creates and loads sessions.
mise exec -- cargo run -p modular-agent --locked --offline -- --acp --runtime durable

# Explicitly trust a project's executable plugin configuration for terminal use.
mise exec -- cargo run -p modular-agent --locked --offline -- --project /absolute/project --trust-project
```

ACP uses the official Rust SDK and declares its standard session lifecycle, configuration selectors and MCP transport support. Approvals become permission requests; text and choice questions become form elicitation when supported. Secret forms are never sent. The `_modular-agent/` extensions provide keyed input, history cursors and jobs. See [the ACP binding](../../../docs/bindings/acp.md) for request shapes.

MCP uses official rmcp over stdio and Streamable HTTP. Settings servers serve every session; servers passed by an ACP client serve only that session and close with it. Tool annotations become hints and raw definitions/results are retained. Names are mcp_SERVER__TOOL, with documented naming restrictions.

Settings can name the prelinked plugins guardrail.literal, feature.subagents and tools.mcp in an ordered plugins array, with options. Project plugin declarations and plugin_settings apply only after explicit trust. Ordinary project defaults, such as model/thinking, still apply before trust. The canonical-path trust ledger is trusted-projects.json beside the global settings file. The operator grants trust with `--trust-project` outside ACP. Trust affects new/reopened compositions, not running ones. MILESTONE-4.md has complete examples.

## Settings and data

Settings merge in this order:
1. Built-in defaults.
2. ~/.config/modular-agent-rs/settings.json.
3. PROJECT/.modular-agent.json.
4. Explicit settings when a session is created.

Example:

```json
{
  "model": "gpt-6-luna",
  "thinking": "low",
  "step_limit": 12,
  "output_limit": 2048,
  "context_tokens": 24000
}
```

The system prompt includes PROJECT/AGENTS.md. Session files live under ~/.local/state/modular-agent-rs/sessions. --data-dir DIR uses DIR/sessions instead. --global-config FILE chooses another global settings file.

Unused sessions, including a new session used only to inspect /settings, leave no session file. Writer leases are diskless Linux abstract sockets, not processes or per-session lock files. Store snapshots use restrictive file permissions and atomic replacement.

For an offline terminal demonstration, create a JSON array of strings, such as ["offline answer"], then use --fake-script FILE. Structured ModelResponse objects can also appear in that array. This mode never contacts OpenAI or reads its credential.

## Parts and limits

Each part has its own crate under crates/. The Harness hosts registrations and owns sessions. It delegates turns, models, tools, storage, credentials, settings and presentation to plugins. The Runtime receives bound model access, never credentials or model-selection responsibility. The OpenAI Provider offers stateless and stateful modes. Select --runtime transient or --runtime durable without changing any other plugin. The Runtime default is transient unless built with the durable-default feature.

The output gate protects Interface events, results, history views and model context. A literal guardrail can be configured through settings or the Rust composition function; it holds selected streams and redacts split literals. It is disabled by default, and raw history remains intact until erasure.

File and bash tools are **not sandboxed**. Relative paths use the session project; absolute paths are allowed. Untracked background children are cleaned up when their shell exits. Linux exit-kill tracing also stops descendants after agent SIGKILL, including setsid escapes. Startup cleans stale command records and live survivors before recovering turns. This requires Linux ptrace and pidfd support; unsupported command containment fails closed.

Durable turns continue after reopening. Started unsafe calls get an explicit unknown result; safe calls repeat only with containment. Completed calls never repeat. Tools overlap only when every call permits it, and results are recorded in request order. Arbitrary unkeyed outside effects in hook handlers are not exactly-once, and plugin-code hot upgrades are not promised.

Questions, approvals, named jobs and subagents are implemented. Actors and captured work authority only narrow, including through steering, reports and child sessions. Moving with running jobs and forking unsettled work refuse; moving away cancels open calls. Authority-grant erasure is refused so revocations cannot be undone by deleting their records.

ACP, MCP, settings-based plugin loading, project trust and stateful OpenAI are implemented. The optional full-screen UI was skipped to keep milestone 5 focused on the required state and erasure proofs. Skills and prompt templates are not in the assigned acceptance lists and were not built.

## Evidence and handover

- MILESTONE-1.md: acceptance evidence and the milestone report.
- evidence/m1-real-run.json: the successful real-model continuation check.
- scripts/real-smoke.py: repeat that live check after building the binary. It makes three short real requests in two agent processes and removes temporary state.
- MILESTONE-2.md: Runtime swap, crash and containment acceptance evidence.
- evidence/m2-real-run.json: the successful kill -9 and same-turn recovery check.
- scripts/real-crash.py: repeat that live check after building. It makes three short real requests in two processes and removes temporary state.
- MILESTONE-3.md: questions, authority, jobs, subagents and all ten acceptance proofs.
- evidence/m3-real-run.json: background bash file creation and a report-triggered parent turn.
- scripts/real-subagent.py: repeat that live demonstration after building. It makes five short real requests in one agent process.
- MILESTONE-4.md: ACP, MCP, settings/trust acceptance evidence and protocol/configuration guide.
- evidence/m4-real-run.json: ACP permission-approved read and new-process replay, using two real requests.
- `mise exec -- cargo run -p modular-agent --example real-acp --locked --offline`: intentionally repeat that live run after building; never an automated test.
- MILESTONE-5.md: both OpenAI modes, full-view reconciliation and remote erasure acceptance proofs.
- evidence/m5-real-run.json: live stateful recall and UNKNOWN after erasure, with no private code retained in the evidence.
- `mise exec -- cargo run -p modular-agent --example real-state --locked --offline`: intentionally repeat that three-request live check; never an automated test.
- GAPS.md: all 34 description gaps, choices and swap tests.
- PROGRESS.md: status and the next session's starting point.
- DESIGN.md and SOURCES.md: implementation layout and library/API sources.

Do not edit docs/. It is a frozen snapshot.
