# Modular Agent in Python

The Python SDK distribution is `modular-agent`, imported as `modular_agent`. Use `create_agent` to build an async embedded agent or `modular_agent.testing.test_agent` for an offline test. See [the SDK README](SDK.md) for the implemented API, fixture matrix and known gaps.

The SDK wraps the clean-room Python build, which implements [production edition 3](../docs/adr/0021-production-edition.md): the Harness, the transient and durable Runtimes, ACP, the plugin binding and local and HTTP history. The base CLI still runs as `modular-agent` and its composition lives in `ma_cli`. The separate [`ma` package](packages/ma/README.md) is the Python standard configuration, built on the SDK.

The base build's notes are in [docs/clean-room](docs/clean-room/README.md). Paths in those notes are relative to the old repository root. `conformance` links to this repository's kits.

## Install and check

Python is pinned with mise; dependencies are managed by uv. The kit tests need the ACP kit's dependencies: run `npm ci` in `../conformance/acp` first.

```sh
uv sync --python 3.13
uv run --offline pytest -q --runtime transient
uv run --offline pytest -q --runtime durable
uv run --offline pytest -q --runtime transient --binding process
uv run --offline pytest -q --runtime durable --binding process
uv run --offline ruff check .
uv run --offline ruff format --check .
uv run --offline mypy
```

Run whole suites one at a time: command cleanup looks for stale work across data directories.

### Process-lifetime regressions

- The served plugin kit could sample an empty heartbeat between shell redirection truncating it and `date` writing it. Holding session 2's second write open across the first sample reproduced `[true,false]` with the process still running. [Command lifetime](../docs/bindings/plugin.md#command-lifetime) requires background work to survive a normal exec answer, not an always-readable timestamp; the kit now measures append-only growth after the answer and checks that only the ended session stops growing.
- In `test_cancel_bash_during_process_bootstrap`, the private RPC reader could receive an invocation and its cancel in the same batch and cancel the answer task before it started. The caller then waited for an acknowledgement that could never arrive. `tests/test_process_rpc.py` buffers both frames to force the order. The reader now records early cancellation so the answer task can acknowledge it without dispatching the invocation.

### Known flaky test, fixed

`test_foreign_job_report_runs_as_a_turn` could time out when the plugin committed its job report during `session.open`, before transient recovery read the queue. Recovery handed the new report back as if it had been queued before restart, so no turn ended. Restart policy now applies only to admissions loaded from history, and ordinary queue dispatch waits for recovery. The test also forces the old failing order without extending its timeout.
