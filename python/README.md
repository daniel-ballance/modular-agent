# Modular Agent in Python

The clean-room Python build from the experiment (`modular-agent-py` at `1e3be25`), copied in unchanged. It implements [production edition 3](../docs/adr/0021-production-edition.md): the Harness, the transient and durable Runtimes, ACP, the plugin host and served plugins, and local and HTTP history. It is the starting point for the Python SDK, fourth in [the SDK order](../docs/adr/0024-five-layers.md#choices). It is not yet an SDK, and it has no reference implementation yet.

The build's own notes, including how to run it, are in [docs/clean-room](docs/clean-room/README.md). Paths in those notes are relative to the old repository root. `conformance` links to this repository's kits.

## Install and check

Python is pinned with mise; dependencies are managed by uv. The kit tests need the ACP kit's dependencies: run `npm ci` in `../conformance/acp` first.

```sh
uv sync --python 3.13
uv run --offline pytest -q --runtime transient
uv run --offline pytest -q --runtime durable
uv run --offline pytest -q --runtime transient --binding process
uv run --offline pytest -q --runtime durable --binding process
uv run ruff check .
uv run ruff format --check .
```

Run whole suites one at a time: command cleanup looks for stale work across data directories.
