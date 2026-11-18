# ACP binding conformance kit

Checks an agent over the [ACP host binding](../../docs/bindings/acp.md), `modular-agent-acp/1` and `/2`. Start the agent on stdio with the conformance model and tools. The kit creates a fresh home, project and local data directory. It passes through `PATH`, explicit fixture plugin settings, and the test history service settings. It sets `MODULAR_AGENT_TENANTS` with a tenant without `tools` and one with zero tokens.

Run only with isolated, disposable processes, workspaces and services. The project directory is not a sandbox. Use no ambient credentials, production configuration, plugins or data. Fixture tools write files and start local commands. Crash checks kill agent processes. The kit removes its temporary directories and leaves test sessions in any configured history service.

```sh
npm ci --prefix conformance/acp
node conformance/acp/run.mjs -- <agent command> [args...]
node conformance/acp/run.mjs -- node "$PWD/packages/agent/dist/src/cli.js" --acp
```

Use Node.js and a Bash/POSIX test environment. The ACP client dependency needs a registry or package cache for installation. Basic execution uses no external model or service. Use absolute executable paths in the agent command. `--verbose` prints stderr and passing details. Exit code 0 means all checks run passed.

| Enable | What it checks |
|---|---|
| Always | Both ACP versions, declarations, required capabilities, echo, failure mapping, input receipts and cross-method deduplication, one turn per tested admission, history cursor, exact approval options and effects when the approval plugin is offered, unknown and live approval answers, first-answer wins, cancel and physical command completion under declared containment, unused session listing, and load replay and key recovery. |
| Session declaration and offered extensions | Joining an actor does not grant presence or representation. Also checks proposal release and withdrawal, recorded rights changes, refusal to move inside a turn, completed rewind on reopen, session-qualified erase results and erased duplicate receipts on both admission routes, session ceilings and a zero tenant budget. |
| `--plugin-checks` | Load a build's conformance `hooks` part with `MODULAR_AGENT_PLUGINS`. Check a refused tool, stream redaction and a redacted history projection. |
| `--probe-checks` | Load the probe plugin. Check registration rollback, history cursors and page count bounds, callback scope, method errors, early-arriving cancellation, gate payloads and rejected gate mutations, a tool refresh barrier, and answering a text question without forms (including a late answer when declared). Also checks that an altered approval view cannot authorize an answer and that a failed catalog refresh does not hide a completed result. Separate Runtime fixtures check exact-call dispatch, recorded tool registration, out-of-phase callbacks, record ownership, result acknowledgement and steering queued after the final check. |
| `--job-checks` | Load the jobs plugin. Check acknowledgment, deduplication, exact report admission and recorded initial disposition (`parked`), declared scheduling and cancellation if offered. With a history service, observe the actual append batch for the report. With `--crash-checks`, check take-up after loss and refusal to resume a job already running on the plugin connection. |
| `--crash-checks` | Kill the agent while the fixture's non-repeatable command is running. Check that it did not finish if within declared containment, then check one `outcomeUnknown`, no replay and the reopener's declared recovery outcome. With a service declaring a TTL between 1 and 10 seconds, delay a successful renewal reply and check that it does not restore dispatch authority. |
| `--portable-checks` | Require a shared history service and the portability declaration. Sample kept fixture logs across pages for fields, order, associations and tombstones. Reopen independently seeded standard-only histories with a narrower or revoked principal, a cleanup marker and a parked job report. Test an unknown approval value when approvals are offered. If the source declares forking, seed a branch over 64 MiB in separate batches and inspect history HTTP requests for any destination write. With `--probe-checks`, test a remote Runtime reopening seeded interrupted model attempts: abort before resume, fresh preparation without replay, and exact replay under a fresh step id. |

For a local service, use the [history kit setup](../history/README.md). Point both agents at it:

```sh
MODULAR_AGENT_HISTORY_URL=http://127.0.0.1:39071 \
MODULAR_AGENT_HISTORY_TOKEN_FILE=/path/to/disposable/token \
  node conformance/acp/run.mjs --crash-checks --portable-checks \
  -- <agent A> [args...] --then <agent B> [args...]
```

After `--then`, B reopens A's sessions for load and enabled recovery checks; both use the same store. The independent `/2` probe still uses A. For cross-build runs, configure both launchers with the same principal ID and project access.

The kit does not test all declarations or malformed wire values. It does not establish independent principal or tenant isolation, question recovery across a process restart or secret question handling, nonzero budget accounting, arbitrary history migration, or erasure across external copies and backups. Early-arrival cancellation is not proof of pre-dispatch cancellation. The rewind journal is inspected only with a history service. The fork preflight check leaves about 65 MiB in the disposable store; it checks history HTTP, not a build's private file format. The remote recovery fixture covers interrupted model attempts, not every tool or continuation path. Watchdogs limit the kit run; they do not add protocol deadlines. Passing is not proof of [conformance](../../docs/conformance.md#what-conforms).
