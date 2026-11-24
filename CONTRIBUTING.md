# Contributing

## How work moves through the layers

The project has five layers, and each is made only from the layers below it ([ADR 0024](docs/adr/0024-five-layers.md)):

1. the specification (`docs/`, the kits in `conformance/`);
2. the SDK specification (`docs/sdk/`, the shared scenarios in `conformance/sdk/`);
3. the SDKs (`rust/`, `typescript/`, `go/`, `python/`);
4. the reference implementations (`docs/reference/`, each language's `ma`, the checks in `conformance/reference/`);
5. demonstrative implementations (none yet).

**A gap goes down a layer.** When code needs something the layer below does not give, change the lower layer first: the documents, then the code, then the code that found the gap. Do not work around a lower layer from above it. In practice:

- A change to what an agent or part must do starts in `docs/contracts.md`, `docs/security.md` or a binding, with a kit check where one can be written, and an ADR if it is hard to reverse.
- A change to the developer API starts in `docs/sdk/`, usually with a shared scenario in `conformance/sdk/scenarios/` that every SDK then passes, and a guide example that runs as a test.
- A change to `ma` starts in `docs/reference/standard-configuration.md`, with a reference check where the behavior can be seen from outside.
- The four SDKs are one SDK in four languages, and the four `ma` builds are one program. A change to one language is a change to all four, or a recorded gap in the others.

**No backward compatibility before 1.0.** The project's owner is its only user. Change or remove a rule, field, option or API outright; do not keep an old spelling, alias, fallback, migration or "optional for older builds" form beside the new one. Interoperability with outside protocols and clients (ACP, AG-UI, OpenTelemetry, model APIs) is not backward compatibility and stays.

## Writing

The documents are plain, specific English: short sentences, one idea each, no marketing words. The capitalized keywords (MUST, SHOULD, MAY) have their [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) meanings and belong only in normative documents ([Conformance](docs/conformance.md#keywords)). Use the [glossary's](GLOSSARY.md) terms and avoid the words it lists under *Avoid*.

Decisions that are hard to reverse, surprising without context and the result of a real trade-off get an ADR in `docs/adr/`, with the next number, and a row in its index.

## Checking a change

There is no hosted CI. Run the checks locally before pushing:

```sh
scripts/check.sh --quick      # builds, lint, SDK tests and cross-language checks
scripts/check.sh              # every suite and the binding kits
scripts/check.sh go python    # only the Go and Python lanes
scripts/check.sh --serial     # one step at a time, in the original order
scripts/stress.sh 3           # three independent full checks at once
```

Each selected language runs in its own lane. A failing step does not stop that lane or the others. The shared scenarios, reference checks, demo, telemetry peer placements and erasure matrix wait for all four lanes. They are skipped if you select fewer than four languages. The erasure pairings also run together unless you pass `--serial`.

The script prints each finished step with its lane and elapsed time. It prints the wall time and log folder in the final summary. On the 32-core reference machine, the full run went from about 79 to 45 minutes, the quick run from 11 to 8 minutes, and the erasure matrix from 17 to 3 minutes. The measured full run overlapped a stress run and had four failed steps. The quick run and the full run's erasure matrix passed. Cold builds and other work on the machine affect these times.

Use `scripts/stress.sh N [check.sh options]` to reproduce failures under load. It copies the tracked files as they are on disk, including uncommitted changes to tracked files. Each check builds from scratch and writes to its own scratch directory. Allow disk space for all the builds. The final table counts how many runs failed each step and lists their log paths. The script keeps the logs and removes the build trees. A check that fails intermittently is a bug to fix, not to retry until it passes.

Each step has a 30-minute hang guard (`MA_CHECK_STEP_LIMIT`, in seconds). A step that reaches it is stopped with its processes and reported as failed; its log ends with `hang guard: stopped after`. The guard catches hangs; a step that is merely slow is a problem to find, not a reason to raise it.

The checks need Linux with unprivileged user, PID and mount namespaces, [mise](https://mise.jdx.dev) (which pins Rust and Go), Node.js 22.12 or later, and [uv](https://docs.astral.sh/uv/) (which pins Python 3.13). Leave `TMPDIR` and `CARGO_INCREMENTAL` unset. No suite needs an on-disk temp directory or a shared Cargo incremental setting. A full RAM-backed `/tmp` once filled and caused spurious failures; that is a size limit. The check scripts therefore run their steps with `TMPDIR` at `~/.cache/ma-std-tmp` when it is unset. A suite run on its own uses the system temp directory. Parallel worktrees keep separate Cargo target directories. A shared `CARGO_TARGET_DIR` would make those worktrees wait on one build lock.

A coding agent's shell commands may run inside a systemd scope that ends with the agent's process; T3 Code does this. Ending the scope kills everything in it, including a check started with `nohup` or `setsid`. Start a long run as its own user unit instead, so it survives:

```sh
mkdir -p "$HOME/.cache/ma-std-tmp"
systemd-run --user --unit=ma-check --collect --same-dir \
  --setenv=PATH="$PATH" \
  -p Delegate=yes -p StandardOutput=file:"$HOME/.cache/ma-std-tmp/check.log" -p StandardError=inherit \
  scripts/check.sh
systemctl --user is-active ma-check    # active while it runs
```

For a stress run, use a different unit name and log file and pass `scripts/stress.sh 3` instead of `scripts/check.sh`.

On an Apple silicon Mac, run `scripts/macos-check.sh` from a fresh clone in a native arm64 shell. It checks for mise, Node.js 22 or later, uv and the Xcode command line tools. It builds all four `ma` programs, including the Go Monty worker, then runs the language suites, reference checks and ACP kits. It needs no sudo. It uses a temporary home, removes it when the run ends and leaves the logs at the paths in its summary table.

What the full run covers:

| Check | What it shows |
|---|---|
| Each language's suites | The base build, its SDK and its `ma`, including the base builds' own kit runs |
| Shared scenarios, `MODULAR_AGENT_SDK_REQUIRE=all` | Every SDK's runner passes every scenario in process and served by every SDK |
| Reference checks, `MODULAR_AGENT_REF_REQUIRE=all` | All four `ma` builds behave as the standard configuration says |
| ACP kit and `scripts/websocket-kits.sh` | ACP on each `ma`, plus the direct WebSocket ACP and plugin checks, including separate-listener plugin isolation |
| `scripts/production-kits.sh` | ADR 0030 isolation, capacity and erasure over ACP on each `ma` and base agent; deployment isolation against two copies of each language's history service; the [pending-erasure registry profile](docs/bindings/history-http.md#pending-erasure-registry-profile-pendingerasure-1) across a service restart |
| `scripts/erasure-matrix.sh` | The ACP erasure checks with each language's agents on each other language's history service: 12 pairings, all through the registry profile |
| `scripts/check-links.mjs` | Every relative link and anchor in the Markdown resolves |

To run only the ADR 0030 kits for a built language, use `scripts/production-kits.sh rust` (or `typescript`, `go` or `python`). Use the builds from `scripts/check.sh`, including the Rust `history_service` example or Go `modular-service`, and install the kit dependencies with `npm ci --prefix conformance/acp` and `npm ci --prefix conformance/tools`. The runner uses disposable loopback listeners, tokens and stores. It checks ACP on stdio and over direct WebSocket listeners where available; Go's base agent serves ACP on stdio only. The full check runs this step for each selected language; `--quick` skips it.

To look at traces while working on [telemetry](docs/telemetry.md), run `scripts/phoenix.sh start`. It starts [Arize Phoenix](https://arize.com/docs/phoenix) in podman or docker on loopback, with authentication off, from a pinned image. Point an exporter at it with `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:6006` and `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`; its HTTP endpoint does not take JSON. Phoenix shows `invoke_agent`, `chat` and `execute_tool` spans as agent, model and tool steps, and groups them by `gen_ai.conversation.id`. Its span API (`/v1/projects/default/spans`) does not return resource attributes such as `service.name`; check those at an OTLP receiver. It runs as the systemd user unit `ma-phoenix` where one is available, so it outlives the shell that started it. `scripts/phoenix.sh stop` stops it and keeps its traces in the `ma-phoenix-data` volume; `scripts/phoenix.sh reset` also deletes them. To open it from another device on your tailnet without MagicDNS, forward the port with `tailscale serve --bg --tcp=6006 tcp://127.0.0.1:6006` and browse to `http://TAILSCALE-IP:6006`; raw TCP forwarding does not depend on the hostname the browser sends. The checks do not need it.

## Commits

Commit in small steps, each one passing the checks it touches. Write the message for a reader who was not there: what changed and why, and the checks you ran with their counts.
