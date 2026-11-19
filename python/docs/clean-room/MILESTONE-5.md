# Milestone 5: plugins in other processes

Milestone 5 and all five assigned milestones are complete. No subagents were
started, no T3 Code settings changed, no other build read, and `docs/` is unchanged.

## Run and select placement

```sh
uv sync --python 3.13
# Each selected plugin gets a separate process:
uv run modular-agent --runtime durable \
  --process-plugins runtime,files,local,mcp,claude --project /path/to/project
# Every plugin, including the terminal Interface:
uv run modular-agent --process-plugins all --project /path/to/project
# The ACP Interface can move too:
uv run modular-agent --process-plugins all --mode acp --project /path/to/project
```

`MA_PLUGIN_PROCESSES` supplies the same comma-separated names or roles when the
CLI option is absent. Empty placement keeps plugins local. Explicit CLI placement
wins over the environment. Embedding uses `build(..., process_plugins="all")` or
`Harness(process_plugins={"runtime", "files", "local", "mcp"})`.
`Harness.load(plugin, process=True|False)` overrides the startup selector.

A settings factory can choose placement without changing its plugin:

```json
{
  "plugins": [
    {
      "factory": "some_installed_package:PluginFactory",
      "options": {"example": true},
      "process": true
    }
  ]
}
```

The existing trust and replacement rules still apply. Placement is fixed when a
plugin loads, before sessions open. This is process separation, not a sandbox.
Plugins have the same local permissions as the Harness.

## Binding contract

`ma-process` is a separately installable package used by the Harness. The same
plugin implementation receives the version 1 API in either placement. The Harness
still owns sessions, routing, authority, declarations and hook combination. It
still runs no turns, models, tools or durable storage operations itself.

### Startup

The parent execs `python -m ma_process.worker`. Only stdio, one private socket
endpoint and an anonymous bootstrap file descriptor are inherited. There is no
listening socket, port, server or shared global registry. Another worker cannot
keep an unrelated plugin channel, history lock or command lifetime pipe open.

The bootstrap file transfers trusted pre-start construction and Python import
paths with pinned `cloudpickle==3.1.2`. It is unlinked temporary storage, not a
persistent plugin format or a place for credentials. The environment, Python and
installed library versions must match. Plugins open resources in `start`; an
already-running event loop, SDK session or uncopyable constructor state is not a
supported startup object. Serialization errors fail startup and clean up, never
silently change placement. No untrusted pickle is accepted. A fork-only prototype
was rejected after inherited SDK descriptors caused a reproducible connection
failure. The delivered binding always execs a clean interpreter.

The first live request checks both API version 1 and binding version 1. A child
registers services, hook definitions, handlers, commands and event followers with
connection-local object addresses. Registration calls are synchronous to plugin
code but are flushed and acknowledged before its next API operation or response.
Independent service objects work as well as capabilities implemented by the
plugin instance. Callback addresses last as long as their registration; temporary
stream emitters are removed when their call ends.

### Live protocol

All live traffic is JSON, never Python objects or executable code. A four-byte
unsigned network-order length precedes each UTF-8 frame. Frames are limited to
64 MiB, including large history snapshots. Both endpoints have their own request
ID sequence and may request work concurrently.

- Request: `kind=request`, `id`, `operation`, `data`.
- Answer: `kind=answer`, `id`, and either `result` or `error`.
- Cancel: `kind=cancel`, `id` of the request being cancelled.
- Results distinguish ordinary JSON values from the explicit transform-hook
  `Stop` sentinel. Errors preserve the error code and message; timeout and
  cancellation retain their Python exception categories.

The parent accepts registration, role-bound API calls, owned hook invocations and
stream pieces. The child accepts startup, addressed service/callback invocation
and shutdown. The stream emitter is an addressed callback, not a function in
request data. Every piece waits for an answer, so a slow gate or recipient slows
the producer instead of accumulating an unbounded output queue. A dedicated reader
keeps dispatching during every outstanding call, allowing callbacks into the
sender without deadlock. Output still passes the Harness output gate before any
recipient sees it. Hook owner checks, load order and combination rules do not move.

Only metadata enters the existing Harness trace: caller, capability and operation.
Credentials are obtained at run time by the same permitted roles. A child cannot
forge a caller or role in request data. The Runtime still receives no credentials.

### Cancellation, loss and shutdown

Cancellation follows the awaiting call chain, including while its initial frame
is being sent. Each hop waits for the remote terminal answer before completing
cancellation, so nested `finally` cleanup has finished. Cancelling a turn does not
cancel unrelated session jobs or commands from an earlier completed call.

EOF fails every outstanding request with `AgentError(code="process_lost")` naming
the plugin and the unknown outcome. The Harness emits gated, session-scoped
`plugin_failed` events, and the declaration marks that plugin unavailable. There
is no automatic process restart or replay of unknown effects. The Runtime records
one unknown result for an affected dispatched tool and can continue inference.
Lost collect sources no longer offer tools; a lost tool router yields no tools.
Lost observe-only handlers are skipped, failed gates refuse, and failed transforms
still fail closed. Losing the Provider, Runtime or history store may prevent
further progress; the binding does not invent a replacement or claim success.

Harness EOF stops the child's independent work as well as incoming requests.
Normal shutdown suspends Runtimes before environment cleanup, then joins and reaps
workers. A stuck stop gets ten seconds before escalation through its owned Popen
process handle. Command cgroups and their separate watcher retain the existing
SIGKILL, setsid and double-fork cleanup guarantees.

Embedding tests that wrap an operation do so explicitly on the proxy; a saved
original operation still calls the child. Mutable plugin state is not silently
copied back. Trusted embedding diagnostics can inspect JSON metadata or container
keys. These diagnostics are not Interface capabilities. Acceptance proofs use
actual child PIDs and public calls, not those test doubles.

## Acceptance evidence

| Binding requirement | Offline evidence |
| --- | --- |
| Whole suite with either Runtime, local and with Runtime, file tools, environment and MCP independently moved | Four sequential full-suite runs; 212 passing tests each |
| Only Harness local, Provider included, with streamed output crossing processes | `test_only_harness_local_all_plugins_moved_stream_and_gate`; all plugins are process proxies, distinct direct-child PIDs, Provider PID in output, live pieces before response record, split-secret redaction |
| Cancelling a turn stops bash two processes away | `test_cancel_turn_joins_bash_two_processes_away`; separate Runtime, tools and environment PIDs, live bash output, shell and setsid descendant stopped before cancel returns, one result |
| Plugin death fails waiting calls, turn continues, Harness reports it | `test_plugin_death_fails_all_waiters_turn_continues_harness_reports`; two concurrent waiters, one unknown recorded result, completed next model step, gated session event and unavailable declaration |
| Death during nested work also cleans commands | `test_lost_tool_or_environment_stops_descendants_and_continues`, separately killing file source and environment |
| Any plugin kind can move without implementation changes | All-plugin composition includes stores and feature plugins; custom independent capability/hooks/commands; settings-selected placement; terminal and official ACP client tests |
| Required real run | The two-request Haiku run below |

Additional tests cover fail-closed policy loss, caller roles, large Unicode frames,
remote cleanup acknowledgement, cancellation during send, partial-start cleanup,
failed connection setup, forced shutdown, concurrent appends, keyed admission,
and offline validation and tamper rejection of the entire live driver.

The original 190 tests remain. MCP HTTP tests now construct their official ASGI
server and lifespan in the process that owns its client, rather than attempting
to serialize a live SDK server. Tool-change coverage now uses actual stdio. The
watcher-loss test finds the watcher below the recorded environment-owner PID.
These changes retain the assertions and let the same tests cross the binding.

```sh
# Run whole suites sequentially, not concurrently:
for binding in local process; do
  for runtime in transient durable; do
    uv run --offline pytest -q --runtime "$runtime" --binding "$binding"
  done
done
uv run ruff check .
uv run ruff format --check .
uv build --all-packages
```

`--binding process` moves Runtime, files, local environment and MCP in every normal
composition. Black-box isolation tests additionally move the Provider, all feature
plugins and both Interfaces. Pure internal unit tests remain unit tests in both
runs. All 212 tests pass in each configuration, 848 passing executions, no skips.
Logs and all 26 package source/wheel builds: `/tmp/ma-m5-release/`.
`FLAKE-REVIEW.md` explains why suites sharing stale-command discovery must not run
concurrently. A deliberate parallel trial failed once and was diagnosed with a
controlled reproducer, not hidden by a retry.

## Real run

One deliberate invocation on 2026-11-17 UTC, first attempt, exactly two requests
to `claude-haiku-5-5`, thinking off. Session
`579d025c65e941ffa6cfffcdb3d96878`, durable Runtime, Harness PID 1294810.
All 18 plugins ran in distinct processes, including Provider 1294816, Runtime
1294818, file tools 1294815, working environment 1294814 and audit feature 1294828.

Haiku requested exactly one `bash` call, `cat proof.txt`. The marker was in that
file, not in the prompt. Bash output crossed the environment and tool processes,
and model text crossed the Provider and Runtime processes. The answer was:

> The marker is M5-PROCESS-PROOF-96427.

The validator checked request identity, exact tool/result pairing, execution
routes, process placement, both streams and cleanup of plugin, SDK and command
processes. No workers, command descendants, zombies or command cgroups remained.
Evidence: `/tmp/modular-agent-py-m5-live/`. The command-line driver was exercised
without inference immediately before the real run. No other model was used.

```sh
# Saved evidence only, no inference:
uv run python scripts/milestone5_live.py --verify-only \
  --output /tmp/modular-agent-py-m5-live
# Entire proof without inference, use a new directory:
uv run python scripts/milestone5_live.py --offline --output /tmp/ma-m5-offline-new
# New inference only if deliberately needed, use a new directory:
uv run python scripts/milestone5_live.py --confirm-live --output /tmp/ma-m5-live-new
```

## Gaps and boundaries

Milestone 5 logs five new sourced decisions with swap tests: G39 placement and
binding; G40 acknowledged cancellation and streaming; G41 process loss and fallback;
G42 startup construction and resource ownership; G43 cross-process ordering,
report admission and atomic history appends. There are now 43 gap entries.

No required milestone 5 item was skipped. The optional milestone 4 full-screen UI
remains skipped. This is a local, same-version binding for trusted plugins, not a
network service, cross-language ABI, live plugin migration or security sandbox.
Previously declared ACP/MCP feature limits remain unchanged. Stop here.
