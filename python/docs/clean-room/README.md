# Modular Agent in Python

A clean-room build from the frozen description in `docs/` and `GLOSSARY.md`.
All five milestones complete. Read `PROGRESS.md` for current status and `GAPS.md` for
decisions the description did not settle.

## Install and test

```sh
uv sync --python 3.13
uv run --offline pytest -q --runtime transient
uv run --offline pytest -q --runtime durable
uv run --offline pytest -q --runtime transient --binding process
uv run --offline pytest -q --runtime durable --binding process
uv run ruff check .
uv run ruff format --check .
```

Tests run offline with a scripted Provider. They use official ACP clients over
subprocess stdio and official MCP servers over stdio and in-memory Streamable HTTP.
No test needs credentials or starts real inference. All 212 tests pass in each
of the four configurations. Run whole suites sequentially, not concurrently;
command cleanup intentionally discovers stale work across data directories.

## Run

Sign in to Claude Code on this machine first. There is no API key. The only
real model permitted is `claude-haiku-5-5`.

```sh
uv run modular-agent --project /path/to/project
uv run modular-agent --runtime durable --subagents durable --project /path/to/project
# An ACP host launches this with stdin/stdout pipes:
uv run modular-agent --mode acp --runtime durable --project /path/to/project
uv run modular-agent --project /path/to/project -p "Read README.md and summarize it."
uv run modular-agent --mode json --project /path/to/project -p "Hello"
uv run modular-agent --session SESSION_ID -p "Continue our earlier work."
# Resume an interrupted turn without new input:
printf '' | uv run modular-agent --runtime durable --session SESSION_ID --mode json
uv run modular-agent --project /path/to/project --list project
uv run modular-agent --list all
```

Each run prints its session ID. Use `--home PATH` to choose the data directory,
otherwise `~/.local/state/modular-agent-py` is used. Tools, context files and
project-filtered listings use the saved session project on reopening.

Line mode accepts input during work. Ordinary input steers the active turn,
`/after TEXT` queues, `/steer TEXT` steers explicitly and `/cancel` cancels
and returns unconsumed input. EOF and `/quit` wait for accepted work.

Commands: `/model`, `/thinking`, `/compact`, `/sessions [all]`,
`/tree [ENTRY_ID]`, `/fork`, `/erase ENTRY_ID`. Settings and compaction
are allowed between turns. Erasure reaches summaries and forks and refuses
during active turns. Moving does not rewind files.
Tools have full local-machine access within the actor's authority. Approval is
installed but defaults to off. It is not a security sandbox.

## Settings and parts

Global `settings.json` lives under the data directory. Project defaults are in
`.modular-agent/settings.json`. Common settings: `model`, `thinking`,
`max_steps`, `max_retries`, `context_budget`, `approval`, `approval_timeout`,
`max_depth`, `max_tokens`.

`plugins` names installed Python factories with options. `plugin_settings` holds
executable plugin configuration, including `mcp.servers`. Global plugins load at
startup. Project plugins and plugin settings apply only after an explicit
`--trust-project`; `--untrust-project` revokes that trust at next startup. Session
defaults still apply before trust. The runnable composition binds to one project,
with many sessions. Reopen without `--project` selects the saved project first.
See `MILESTONE-4.md` for the settings format and trust boundary.

Each part is an independently installable uv workspace package under `packages/`.
The default composition is in `modular_agent/__init__.py`, outside the Harness.
See `DESIGN.md` for the API and SDK sources.

For offline CLI use, pass `--fake-script FILE`, a JSON list of normalized
responses. See `ma_fake.reply` in `packages/fake/ma_fake/__init__.py`.
Do not put secrets in scripts or settings.

## Runtime swap and command cleanup

The default Runtime is transient. Choose `--runtime durable` to carry an
interrupted turn on automatically when its session opens. No other plugin changes.
The transient Runtime fails an interrupted turn. Both record exactly one result
per call; unknown outcomes explicitly tell the model to check outside state.

Read calls allow parallel execution. A step runs concurrently only if every
requested tool allows it. Results stay in the model's request order.

Local commands require Linux cgroup v2 and a writable delegated subtree. By
default this is `/sys/fs/cgroup/user.slice/user-UID.slice/user@UID.service`.
Set `MA_CGROUP_ROOT` to another delegated subtree if needed. Without delegation,
commands are refused before starting; file tools still work. No sudo is used.
This is lifetime containment, not a sandbox against hostile same-user programs.

Background children of a returned shell remain until session close. Cancelling
a later turn leaves earlier children alone. Agent death stops all command
descendants, including `setsid` and double forks. If the watcher also dies, the
next agent scans for stale cgroups before recovering a session, even with another
data directory.

See `MILESTONE-2.md` for the offline evidence and the completed real Haiku run.
To repeat it deliberately, using a new output directory:

```sh
uv run python scripts/milestone2_live.py --confirm-live --output /tmp/ma-m2-new
# Revalidate saved logs without inference:
uv run python scripts/milestone2_live.py --verify-only --output /tmp/ma-m2-new
```

## Questions, jobs and subagents

The model can use `ask_user` for approval, choice, text and named secrets, and
`delegate` for a child task. A child gets only its task, has narrowed authority,
and retains its own history for follow-up. `delegate` takes `task`, `background`
(default true), and optional `child`. The default depth cap is three. Background
reports enter as input and can start another parent turn. Waiting returns only
through the original call. Questions forward through every parent to the user.

`--subagents durable` chooses durable jobs independently of `--runtime durable`.
Transient subagents report an unknown outcome after process loss. Durable ones
continue from the child record, checking interrupted effects conservatively.
Process exit suspends work; explicit session close cancels jobs. Cancelling a
parent turn leaves its background jobs and their questions running.

Terminal controls:
- `/answer ID VALUE`: answer a recorded question.
- `/secret ID`: hidden intake directly into the credential store. Never put the
  value in ordinary input, tool arguments, settings or command-line arguments.
- `/jobs`: list jobs. `/job_cancel ID`: cancel one.

Approval policy is the session setting `approval`: `ask unless read-only`,
`ask always`, `never ask, refuse`, or `off` (default). With nobody to answer,
approval refuses. Print mode and EOF do not pretend an answerer is present.
`approval_timeout` may leave the call open beyond its turn; a later valid answer
rechecks the call and continues in a new turn. No placeholder result is recorded.

`MILESTONE-3.md` maps every acceptance item to offline tests and the five-request
real Haiku run. `FLAKE-REVIEW.md` explains both reproduced flake fixes. The final
144-test suite passed 30 full runs per Runtime, without retries.

```sh
# Recheck saved real evidence, no inference:
uv run python scripts/milestone3_live.py --verify-only \
  --output /tmp/modular-agent-py-m3-live
# Opt in to a new real demonstration only when needed:
uv run python scripts/milestone3_live.py --confirm-live --output /tmp/ma-m3-new
```

## ACP and external MCP

`--mode acp` exposes ACP v1 over stdio, using the official Python library. It
supports session create/load/resume/list/close, streamed output, permission
requests, and negotiated form elicitation for non-sensitive questions. Model,
thinking and approval are configuration options. Declared extensions expose
keyed input, follow-from-entry, steering, commands, move/fork, erasure, jobs and
checked UI tool calls. Secret questions never use forms.

Settings MCP servers serve every session. MCP servers supplied by an ACP client
serve only that session and close with it. Both stdio and Streamable HTTP use the
official MCP library; annotations become tool hints. Connection env and headers
supplied by a host are ephemeral, not recorded in history.

`MILESTONE-4.md` has the protocol contract, settings examples, official sources,
acceptance map and real Haiku evidence. Revalidate that evidence without inference:

```sh
uv run python scripts/milestone4_live.py --verify-only \
  --output /tmp/modular-agent-py-m4-live
```

## Plugins in other processes

The same plugins can run locally or each in a separate process, selected at
startup without implementation changes:

```sh
uv run modular-agent --runtime durable \
  --process-plugins runtime,files,local,mcp,claude --project /path/to/project
uv run modular-agent --process-plugins all --project /path/to/project
```

`MA_PLUGIN_PROCESSES` accepts the same names, roles or `all`. Trusted settings
factories can specify `"process": true` or `false`. Live traffic uses private
full-duplex JSON frames with acknowledged streams, nested cancellation and clear
process-loss results. This is not a security sandbox or a cross-version protocol.
Plugins acquire live resources in start, not in their constructors.

`MILESTONE-5.md` gives the protocol, placement API, acceptance evidence and the
two-request real Haiku run with all 18 plugins moved. Revalidate without inference:

```sh
uv run python scripts/milestone5_live.py --verify-only \
  --output /tmp/modular-agent-py-m5-live
```

All five milestones are complete. The optional full-screen UI remains skipped.
No required item was skipped. Stop here.
