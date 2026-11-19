# Modular Agent in Go

All five milestones are complete: a modular agent with swappable Runtimes, questions, approval, jobs, subagents, ACP, MCP, trusted configured plugins and authenticated HTTP services. Built only from this repository's frozen description. Read [AGENTS.md](AGENTS.md), [PROGRESS.md](PROGRESS.md), [GAPS.md](GAPS.md) and [milestone 5 evidence](MILESTONE_5.md). Earlier evidence is in `MILESTONE_1.md` through `MILESTONE_4.md`.

## Build and test

Go 1.27.4 is pinned with mise. Protocol adapters use the official MCP Go SDK and the maintained Caelis Labs ACP Go SDK, pinned in `go.mod`. See [protocol sources](PROTOCOL_SOURCES.md).

```sh
mise exec -- go build -o bin/modular ./cmd/modular
mise exec -- go build -o bin/modular-service ./cmd/modular-service
mise exec -- go test -count=1 ./...
mise exec -- go test -race -count=1 ./...
mise exec -- go vet ./...
```

All tests run offline. Protocol tests use local HTTP servers and controlled subprocesses. The Anthropic adapter tests use dummy credentials. Linux with unprivileged user, PID and mount namespaces is required for bash. The service sandbox also requires Bubblewrap. Namespace creation failures are explicit; there is no weaker process-group fallback.

## Run

Real inference uses only Haiku 5.5 through the Anthropic Messages API. Only the model gateway reads `~/.config/modular-agent-experiment/anthropic.key`, at request time. Agent composition has no credential store. See [SERVICES.md](SERVICES.md) to launch the gateway or the complete four-process HTTP agent. Do not pass credential bytes on the command line.

For the local terminal examples below, launch the gateway first, then use a shell wrapper that adds its service access:

```sh
modular() {
  bin/modular --model-gateway http://127.0.0.1:8303 \
    --service-token-file /tmp/modular-service.token "$@"
}
```

These terminal compositions still use local history and local commands; the full service composition is documented separately.

```sh
# Interactive line mode
modular --project /path/to/project

# One prompt, final text on stdout, tool progress and session ID on stderr
modular --project /path/to/project --mode print \
  --prompt 'Read README.md and summarize it briefly.'

# Reopen the printed session ID in another process, emitting JSON events
modular --session SESSION_ID --mode json --prompt 'Continue.'

# Use the durable Runtime, including when reopening an interrupted turn
modular --runtime durable --project /path/to/project --mode print --prompt 'Read README.md.'
modular --runtime durable --session SESSION_ID --mode print

# Wait for background children and the parent turns their reports start
modular --runtime durable --subagents durable --wait-jobs \
  --project /path/to/project --mode print \
  --prompt 'Delegate a background task to write a note with bash, then describe its report.'
```

The default Runtime is transient. Opening an interrupted turn with it repairs tool results and ends that turn as failed. With `--runtime durable`, opening carries on automatically, without a new prompt. Recorded results are reused, safe interrupted calls may repeat, and unsafe ones get an unknown outcome that tells the model to check outside state. Keep selecting the desired Runtime on each invocation. `/support` reports the active declarations.

A reopened session keeps its original project. Relative tools, project instructions and project-filtered session lists follow that folder, not the caller's current directory. This local working environment is not a sandbox.

Line mode takes ordinary input as steering between steps. Use `/after text` for a follow-up, `/cancel` to cancel and return queued input, and `/quit` to leave. Ctrl-C interrupts work for recovery; `/quit` closes the session and cancels its jobs. Approval defaults to off for compatibility. Use `/approval ask-unless-read-only`, `/approval ask-always`, `/approval never` (refuse without asking), or `/approval off`. Print/JSON modes have no answering actor connected, so new approvals fail closed.

Commands: `/help`, `/settings`, `/model [id]`, `/thinking [off|low|medium|high]`, `/compact`, `/history`, `/move entry-id`, `/fork [entry-id]`, `/erase entry-id`, `/sessions [all]` and `/support`. Milestone 3 adds `/approval POLICY`, `/requests`, `/jobs`, `/job-cancel JOB_ID` and `/usage`. In line mode answer with `/answer REQUEST_ID value`. Secret collection is unavailable in gateway-only agents. The existing secret capability is still tested in explicit offline compositions with a dummy credential store; its values bypass input hooks, history and the model. A fork prints an ID to reopen. Commands do not call the model, except `/compact`, which uses the Provider directly for a summary rather than starting a Runtime turn.

`--key KEY` deduplicates model input across retries, branches and restarts. Keyed slash commands are refused.

## ACP and the wider world

An ACP client can launch:

```sh
bin/modular --project /absolute/project/path --runtime durable --mode acp \
  --model-gateway http://127.0.0.1:8303 --service-token-file /tmp/modular-service.token
```

The stable ACP v1 Interface supports create/load/resume/list/close, model and thinking selectors, permission requests, text and choice elicitation, streaming tool updates and host extensions for keyed input and recorded follow. Stdio is protocol-only. EOF interrupts sessions for recovery; explicit close cancels their work. Model/thinking changes during generation apply next turn, retaining the old selection for active-turn recovery.

Configured plugins come from a named factory catalog. The defaults are `mcp` and `guardrail`. Global entries load automatically. Project plugins and project overrides of global plugin options require `--trust-project` for that invocation. Project session defaults still apply without trust. Each configured process is bound to its canonical project root.

The MCP plugin offers servers over subprocess stdio and Streamable HTTP. Configured servers serve every session; ACP-provided servers belong only to their session and close with it. Annotations become tool hints. See [HOSTS.md](HOSTS.md) for configuration examples, extension contracts, trust and limits.

## Files and settings

- History: `~/.local/share/modular-agent-go/history/`, overridden with `--state PATH`.
- Global settings: `~/.config/modular-agent-go/settings.json`, overridden with `--settings PATH`.
- Project settings: `<project>/.modular-agent/settings.json`. They override global defaults for new sessions.
- Project instructions: `<project>/AGENTS.md`.
- Reopened sessions keep their saved settings.
- Command lifetime registry: `<history>/commands/`. Keep this folder with the state so startup can clean up abandoned supervisors before recovery.

Example settings:

```json
{
  "model": "claude-haiku-5-5",
  "thinking": "off",
  "approval": "off",
  "max_steps": 12,
  "max_output": 1024,
  "context_limit": 0
}
```

A zero context limit uses the model catalog's limit. Compaction uses a conservative byte estimate, not an exact tokenizer.

## Offline executable example

```sh
bin/modular --script examples/offline.json --state /tmp/modular-go-offline \
  --project . --mode print --prompt hello
```

`--script` installs the fake Provider instead of a gateway plugin. It reads no credentials. Scripts contain responses, streamed chunks and optional `Require` text that must appear in the request. More involved fake behavior is available through its Go API.

## Parts

`api` defines the in-process binding and standard Runtime hook rules. `harness` owns plugins and open sessions, but has no model loop or tool implementations. All other packages provide plugins. `vanilla` chooses the plugin set and `cmd/modular` starts the selected terminal or ACP Interface. `historyhttp`, `environmenthttp`, `gateway` and `agenthttp` provide the service bindings; `cmd/modular-service` runs one part per process.

The optional guardrail is installed through settings, `vanilla.Options.Secrets` or `guardrail.Plugin` in a Go composition. It holds streamed model pieces and redacts recipient views while leaving raw history unchanged. Interfaces use gated events, views, outcomes and command results, not trusted raw snapshots.

## Deliberate limits

History, sandbox working environment, model gateway and agent HTTP services are implemented and authenticated. Their APIs and limits are in [SERVICES.md](SERVICES.md). The optional full-screen terminal was skipped in milestone 4. ACP v2, client-owned file/terminal execution, sign-in flows and secret forms are not offered. One configured process serves one canonical project. Plugins run with full agent permissions, not in a sandbox. Moves, forks and erasure are refused while calls or jobs are unfinished. Navigation into an unfinished turn boundary is also refused. Interfaces authenticate actors; the in-process plugin API is trusted, not a security sandbox. Different actors cannot steer the same turn. There are no tenant-wide budgets.

Local commands run under per-call Linux PID namespace supervisors. Agent death closes a private lifetime pipe. Supervisor death itself makes the kernel kill every remaining namespace member, including setsid and background descendants. Files remain on the local machine; this is not a filesystem sandbox. Shell PIDs are namespace-local, numeric UID and primary GID are preserved, and supplementary groups are not available. Cancelling a turn stops its foreground command, not earlier background commands. Closing the agent stops all of them.

`vanilla.Options.Runtime` selects the Runtime plugin in Go compositions. `durable.Plugin()` can also explicitly replace `transient` before sessions open. Standard feature hooks and all other plugins stay the same. Calls overlap only when every tool in their batch allows parallel execution. Results and after-tool hooks retain request order. A plugin with outside effects in a replayed hook must record its own idempotent progress.

The model has `ask_user` (text, choice or named secret) and `delegate` (task, optional child session, background true/false). Questions normally wait in the turn. `wait_ms` with `defer=true` can leave a call open; its late answer runs the original checks and continues in a new keyed turn. No stand-in result is stored. Explicit offline secret-store compositions persist named secrets in private hashed files, never in history; gateway-only agents have no such destination and refuse secret collection.

Subagent recovery is selected independently with `--subagents transient` (default, reports unknown after interruption) or `--subagents durable` (continues the child and reports its real result). Children get only their task, a separate remembered session, the parent's project/settings and no more authority. Their questions pass up one parent at a time. The default maximum depth is three. Turn cancellation leaves jobs running. `--wait-jobs` makes print/JSON mode wait for their reports before closing. Plain shell backgrounding remains distinct from a managed job.

For Go compositions, `api.API.Grant` narrows actor rights, `api.Questions` handles requests and answers, and `api.API.CallTool` runs recorded, checked UI calls without inference. `resultcheck.Plugin` can reject a final result with a reason inside the same bounded turn. `Harness.Close` interrupts all jobs before stopping sessions; `CloseSession` cancels their work instead.

Real runs are recorded in `REAL_RUN.md` and `REAL_RUN_2.md` through [REAL_RUN_5.md](REAL_RUN_5.md). Earlier drivers remain historical evidence and require gateway-aware launch changes before reuse. They no longer obtain direct inference from the CLI.

To deliberately repeat the milestone 5 four-process demonstration, making two short real Haiku requests:

```sh
python3 scripts/milestone5-real.py
```

The driver never reads the Anthropic key. It creates a private service token outside the repository, launches each part separately, drives the agent over HTTP, checks keyed input and reconnect replay, saves evidence in a temporary folder, stops all processes and deletes its service token.
