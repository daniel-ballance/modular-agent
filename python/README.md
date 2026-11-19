# Modular Agent in Python

The Python SDK distribution is `modular-agent`, imported as `modular_agent`. Use `create_agent` to build an async embedded agent or `modular_agent.testing.test_agent` for an offline test. See [the SDK README](SDK.md) for the implemented API, fixture matrix and known gaps.

The SDK wraps the clean-room Python build, which implements [production edition 3](../docs/adr/0021-production-edition.md): the Harness, the transient and durable Runtimes, ACP, the plugin binding and local and HTTP history. The base CLI still runs as `modular-agent` and its composition lives in `ma_cli`. This directory does not contain a reference implementation.

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
