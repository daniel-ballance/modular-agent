# AG-UI conformance kit

This kit checks [the Modular Agent AG-UI binding](../../docs/bindings/agui.md). It sends HTTP requests and checks SSE before handing JSON to the assertions. Two cases also run the official `@ag-ui/client` `HttpAgent` without a cursor or a presence stream. The app replaces provisional messages with each final snapshot. It waits for the terminal outcome before reporting a frontend result. It does not run anything from a snapshot.

Use Node.js 22.12 or later. The TLS self-test also uses OpenSSL 3 to generate a disposable CA and certificates. Use a disposable agent, tokens and store. Do not point the kit at a production listener.

```sh
export TMPDIR="$HOME/.cache/ma-std-tmp"
mkdir -p "$TMPDIR"
npm ci
npm test
node run.mjs --list
node run.mjs -- /absolute/path/to/agui-fixture
node run.mjs --only history --url http://127.0.0.1:39211 --token-file /path/to/disposable.token
```

The first invocation of `run.mjs` with a command runs every case, with a fresh fixture per case. Use `--only case,case` to select cases. A URL selects one case and assumes the listener is already configured for it. The URL is the origin, not `/agui/v1/run`. Cleartext is allowed only on numeric loopback. The kit uses normal certificate and hostname verification for HTTPS. Use `NODE_EXTRA_CA_CERTS` when launching the runner to trust a test CA. Never disable verification. Supply token files, not token values. Use `--rotated-token-file`, `--sibling-token-file`, `--foreign-token-file`, `--watch-token-file`, `--tenant-token-file` and `--project-token-file` as required by the case.

## Launching a fixture

The fixture is an SDK app, not a replacement AG-UI adapter. Use the real listener, Harness, Runtime, output gate and history store. For TypeScript, build the workspace and run `node conformance/agui/run.mjs -- "$(command -v node)" "$PWD/typescript/scripts/agui-ma.mjs"` from the repository root. The launcher uses `ma --agui --acp` for listener, encoding, history and stock conversation. Its SDK fixture supplies the registered frontend tool and the test controls for the other cases. See [Serving AG-UI](../../docs/sdk/placement.md#serving-ag-ui) for the proposed setup. `fake-agent.mjs` is only a launch-mode self-test for the basic cases. The Go launcher is `go.mjs`. From the repository root, `go/scripts/check-agui.sh` builds Go `ma` and the fixture, installs the pinned kit dependencies in scratch, and runs every case. Four cases launch `ma`; cases that need operator-only setup launch the test executable. See [Serving AG-UI](../../docs/sdk/placement.md#serving-ag-ui) for the proposed setup. `fake-agent.mjs` is only a launch-mode self-test for the basic cases.

The kit starts the command in a new process group, with a fresh home, working directory and data directory, and without the inherited environment except `PATH`. It sets:

| Variable | Meaning |
|---|---|
| `MA_AGUI_LISTEN` | `127.0.0.1:0`; bind an ephemeral port. |
| `MODULAR_AGENT_SCRIPT` | Path to the [model script](../../docs/sdk/testing.md#the-model-script). Use only `scripted/script`, with the same indexing as the reference Provider. The scripts are in `cases.mjs` and `advanced.mjs`. |
| `MODULAR_AGENT_SCRIPT_LOG` | Log model requests in the [reference format](../../docs/reference/standard-configuration.md#hooks-for-testing). |
| `MODULAR_AGENT_DATA_DIR` | Keep the same store across a restart. Do not erase or truncate it on startup. |
| `MA_AGUI_FIXTURE` | JSON file with `{ name, tokenFiles, offer, project, controlTokenFile }`. `name` identifies the case. `offer` is the browser's exact tool offer. The other fields supply disposable config paths. |

Print one line to stdout when the listener is ready. For a basic case print its origin, or `{"url":"http://127.0.0.1:PORT"}`. For a controlled case print `{"url":"http://127.0.0.1:PORT","control":"http://127.0.0.1:OTHER_PORT/fixture"}`. Send diagnostics to stderr. The kit keeps stdout and stderr in files on failure. It kills the fixture's group and waits for surviving processes before starting a replacement. Use a fresh port on restart.

Configure `acp: true` on the same listener, at the root WebSocket path. Use default same-origin browser policy. Enable attachment of the fixture's in-scope actors. Set the creation project and tenant on the operator side. The token roles are:

| File key | Actor and scope |
|---|---|
| `owner` | Actor `kit-owner`, client `kit-primary`, full fixture rights in the test project and tenant; trace context is trusted. |
| `rotated` | Same actor, client ID, rights and scope as `owner`, different token. The kit uses it to reconnect as the same executor route. |
| `sibling` | Same actor and scope, different client ID. No Interface tool registered on this route. |
| `foreign` | Another admitted actor in the same scope; allow `input`, `watch`, `tools`, `answer` and `approve`, but do not trust its trace context. |
| `watch` | `kit-owner` with a distinct client ID and a connection ceiling of `watch` only. |
| `tenant`, `project` | Tokens for a different tenant and a different project respectively, otherwise qualified to watch. |

Register `pick_color` from `offer` for actor `kit-owner`, route `kit-primary`, with `callers: ["model"]` and 60,000 ms result timeout. Do not register a handler. The fixture's `tool.before` changes `{"color":"draft-blue"}` to `{"color":"dispatch-blue"}` on the first pass; subsequent passes leave it unchanged. On successful reports `tool.after` replaces the report text with `Checked frontend result.`. Keep the error description on failed reports. Default to approval off except in the approval cases. Do not enable another answer route for those cases.

## Fixture controls

The control URL is a separate loopback-only, bearer-authenticated test endpoint. Never enable it on a deployed agent. It accepts `POST` JSON `{ operation, threadId, ...args }` and responds `200` with a JSON object (normally `{}`). In URL mode pass it with `--control URL --control-token-file FILE`. Basic cases do not use it. Crash cases require command mode. Do not use AG-UI requests for administrative fixture actions.

| Operation | Behavior |
|---|---|
| `tls` | Return `{ ca, cert, key, servername }` for the disposable test client only. This operation has no `threadId`. |
| `inspect` | Flush captured telemetry. Return `{ batches, model, dispatches, warnings, spans, erasure }`. `batches` contains committed shared entries grouped in store-write order; `model` is the parsed request log; `dispatches` lists executable handoff call IDs at release. `warnings` is a list of field names. `spans` contains `{ name, traceId, spanId, parentSpanId?, attributes, links }` with links `{ traceId, spanId }`. `erasure` is the last erasure report (or `{ outOfReach: [] }`). Inspect actual records and spans, not a fixture's predicted result. |
| `barrier` | Wait for the named boundary on this session, even if it has already happened. Use a latch in the relevant store, gate or fixture hook. |
| `advance` | Advance a controlled clock by `milliseconds`; run resulting closures, settlements and ready work to completion before responding. Do not wait for a wall clock timeout. |
| `release` | Release the pause at `beforeRelease`. |
| `revoke` | Remove the route's `tools` right without removing `watch`. |
| `move` | Move away from the just-completed conversation using another Interface. |
| `erase` | Erase the just-completed conversation or open handoff and its lineage using another Interface. Wait for the committed intent and reconciliation. |

Controlled cases add these behaviors:

| Case | Fixture behavior |
|---|---|
| `tls` | Use HTTPS with a disposable server certificate and mandatory client authentication. A trusted client certificate alone must not authorize discovery. The kit checks unknown CA and mismatched server name as well. |
| `approval*` | Ask for approval of the transformed call, with a closing deadline in 5,000 ms. In `approval-redacted`, change the arguments in the intended approval view. Signal `presenceLost` after disconnect and approval reconciliation. |
| `questions` | Ask the choice `yes` or `no` with a 5,000 ms closing deadline before completing the first turn. Record declines and time limits. |
| `mixed` | Stage the frontend tool and open an in-turn choice before `turnEnd`. The answer completes that turn, then the adapter can release the handoff. |
| `release-gate` | Pause at `beforeRelease` after the start/checkpoint and originating turn end commits, before executable framing. |
| `state-and-gate` | Use one state plugin with `{counter:0}`, valid patch to 1, stale patch to 2, and a patch to 3 that the output gate withholds. Suppress any replacement snapshot before `{counter:4}`, then deliver a patch to 5. Include a same-named event from an unconfigured plugin with `wrong-plugin-sentinel`. Offer visible `kit.visible` and a visible nonstandard entry, a withheld `withheld-extension-sentinel`, and a raw foreign event `{type:"fixture.foreign"}` from source `kit`. Give the Provider private data containing `provider-only-sentinel`. Redact the scripted output to `Gated text.` for the owner; withhold sibling snapshot replies. |
| `output-size` | Offer a gated optional custom event named `kit.oversized` whose encoded size exceeds 64 MiB. Configure a sibling snapshot view that would exceed 64 MiB and cannot be delivered as a complete snapshot; refuse it with `result_too_large`. Keep the owner's ordinary conversation deliverable. |
| `error-gate` | Block discovery and the scripted Provider diagnostic at the output gate. |
| `trace` | Capture real OpenTelemetry spans with an always-on sampler and metadata-only export. Allow the vendor key `kit` and ignore the other trace state and all baggage. |
| `crash-before-handoff` | Pause at `beforeHandoff` before committing `toolStarted`. Use a transient Runtime for interrupted turns. |
| `crash-after-handoff` | End the first run with a live handoff, then let the kit kill the process. Restore the open call without dispatching it. |
| `crash-after-result` | Pause at `afterResult` after the result commits, before the continuation starts. |
| `crash-continuation` | Pause at `duringContinuation` after committing its `turnStart` and trace checkpoint but before the model step. Use durable recovery and the original checkpoint. |

The fake checks whether the runner recognizes known good and deliberately wrong behavior. It does not show that an SDK enforces the gates, stores the records atomically, exports real spans, or recovers from a process death. The fake's recovery cases drop transport connections and reopen in-memory state. Run the managed kit with an SDK fixture to test a real crash.
