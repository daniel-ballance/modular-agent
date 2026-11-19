# Milestone 1 acceptance evidence

Milestone 1 is complete. No milestone 2 features were started.

## What was built

The Harness, 14 plugin packages and a shared API package. The default
composition is in `ma_cli/__init__.py`. All dependencies between plugins
go through the addressed API in `packages/core/ma_core/__init__.py`.
The Harness hosts plugins, dispatches owner-defined hooks and holds open sessions.
It contains no turn loop, model client, tool implementation or durable store.

```sh
uv sync --python 3.13
uv run modular-agent --project /path/to/project
uv run modular-agent --project /path/to/project -p "Read README.md and summarize it."
uv run modular-agent --session SESSION_ID -p "Continue"
uv run modular-agent --mode json -p "Hello"
```

Full instructions and settings are in `README.md`. Tools run with local-machine
permissions. There is no approval plugin in this milestone.

## Offline tests

**58 tests pass.** No real inference runs in the suite. The suite blocks socket
connections in the test process. CLI subprocess tests explicitly select the fake
Provider. SDK tests use a fake SDK client and the actual official MCP library's
in-memory transport.

```sh
uv run --offline pytest -q
uv run ruff check .
uv run ruff format --check .
uv build --all-packages
```

| Acceptance item | Offline proof |
|---|---|
| 1. Plugins | `test_foundation.py`: empty Harness, five fixed hook rules, stable first/last ordering, owner-only firing, gate failure, plugin-defined capability/hook, replacement and registration cleanup |
| 2. Providers | `test_vanilla.py::test_read_then_answer_and_runtime_credential_free`; `test_claude.py`: exact schemas, isolated options, canonical results, rejected non-subscription login, forbidden model, state invalidation |
| 3. Transient Runtime | `test_vanilla.py`: multi-step turn, one result per call, refusal, validation error, model failure, limit and cancellation; interrupted-turn settlement without replay |
| 4. Tools and project | `test_vanilla.py`: read/write/edit/bash, atomic failed edits, per-project files/settings/context; `test_edges.py`: live bash output reaches the Interface before the result and background commands end on close |
| 5. History | `test_foundation.py`: durable tree, recorded position, fork, project/all listing, second-process writer refusal, idempotent writes; `test_terminal.py`: reopening in a new process; `test_edges.py`: no consumed-input replay in forks and unused vanilla sessions leave no files |
| 6. Context | `test_vanilla.py`: proactive summary, retained originals, context overflow compaction/retry, /compact; `test_claude.py`: native state discarded on compaction |
| 7. Prompt, selection, settings, credentials | Project AGENTS.md and configuration tests; model/thinking commands; next-request selection and active-turn refusal; atomic setting record/snapshot; Runtime credential-access refusal |
| 8. Input | Steering versus follow-up, withdrawal, cancellation returns queued content, keyed admission once across reopen; earlier shell background work survives later turn cancellation |
| 9. Output gate | Split secret held across streamed pieces, gated events and history views, original record retained, gated terminal return values, fail-closed output exceptions |
| 10. Erasure | Physical store bytes checked after erasure; summaries, fork originals/siblings, admission receipts, tool results, native state and Runtime result caches covered |
| 11. Terminal | Print, interactive line, JSON events/declaration/usage, process exit codes and new-process continuation |
| 12. Commands | Registered commands, model/thinking changes without turns, model-free routing, /compact as an auxiliary Provider request |

## Real model proof

Date: **2026-11-17 UTC**. Model: **claude-haiku-5-5 only**, through the official
Claude Agent SDK and the machine's existing Claude Code subscription login.
No API key was used or copied. Claude Code tools, settings, hooks, memory, skills,
plugins, auto-compaction and native session persistence were disabled.

Three short CLI invocations were made, totalling five agent model requests:
1. The first attempt read the file and answered correctly, but its turn failed
   while the Runtime added nested SDK usage metadata. The failure was reproduced
   offline in `test_usage_regression.py`, then fixed by scalar usage normalization.
2. A fresh session completed the required read-and-answer proof.
3. A new process reopened that session and continued from the saved history.

The successful session was `fe831273e72c4dd683745aceb9ff750f`.
Its project was `/tmp/modular-agent-py-m1-live/project`. The file contained:

```text
The orchard lantern is amber. Its inventory code is M1-7426.
```

First successful invocation:

```sh
uv run modular-agent \
  --home /tmp/modular-agent-py-m1-live/store \
  --project /tmp/modular-agent-py-m1-live/project --mode json \
  -p "Use the read tool to read facts.txt, then tell me the lantern color and inventory code in one sentence."
```

Observed:
- Exit code 0 and turn outcome `completed`.
- Exactly one `read` call, input `{"path":"facts.txt"}`, and one completed result.
- Two steps, with streamed answer:
  **The lantern is amber, and its inventory code is M1-7426.**

New-process invocation:

```sh
uv run modular-agent \
  --home /tmp/modular-agent-py-m1-live/store \
  --session fe831273e72c4dd683745aceb9ff750f --mode json \
  -p "Without reading the file again, what inventory code did we just find? Reply with only the code."
```

Observed:
- Exit code 0, the same session ID and the saved project.
- Turn outcome `completed`, one step and no tool calls.
- Answer: **M1-7426**.

The native SDK conversation was not persisted. The second process reconstructed
the context from the agent's own history as a labelled record. The successful
logs remain under `/tmp/modular-agent-py-m1-live/proof-first.jsonl` and
`proof-reopened.jsonl`. This document preserves the relevant evidence if those
temporary files are later removed. No process from these runs was left running.

## Gaps

All 16 entries are in `GAPS.md`, with sources, choices and swap-test outcomes:

1. G01: callable contracts and content encoding.
2. G02: registration, plugin scope and replacement.
3. G03: exact hook composition.
4. G04: persistent format and unused sessions.
5. G05: limits and settings during turns.
6. G06: file tools and local command lifetime.
7. G07: input admission and cancellation.
8. G08: compaction and summary provenance.
9. G09: output gate scope and holding policy.
10. G10: erasure of derived data and native state.
11. G11: stateful Claude Code transport.
12. G12: credentials and file settings.
13. G13: terminal controls and model-free commands.
14. G14: non-additive vendor usage.
15. G15: forked input and provenance references.
16. G16: settings after moving or forking.

## Scope and declared limits

No milestone 1 acceptance item was skipped. Full job management, durable recovery,
parallel tools, SIGKILL/escaped-process cleanup, approvals, questions, subagents,
ACP, external MCP sources, settings-driven plugin loading, project trust and a
full-screen UI belong to later milestones and were not started.

The local environment guarantees normal-shutdown cleanup only. It explicitly
declares that commands may survive an unclean process stop. Moving does not
rewind files. Claude Code adds its own transport context and fresh-process replay
is a text record rather than native message replay. These are declared limits,
not claims of unsupported guarantees.
