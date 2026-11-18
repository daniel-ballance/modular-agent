# Plugin binding conformance kit

Checks a build's conformance plugin against the [plugin binding](../../docs/bindings/plugin.md), `modular-agent-plugin/1`. The kit is the host. It uses a temporary project and home, a scripted Provider and an environment that accepts only fixture callbacks. There is no external model or network dependency.

Run on a disposable Linux environment with Node.js, Bash, `setsid` and GNU coreutils. The command and its arguments should use absolute paths. The project directory is not a sandbox. Only run trusted test programs with no ambient credentials or production configuration.

```sh
node conformance/plugin/run.mjs -- <plugin command> [args...]
node conformance/plugin/run.mjs -- node "$PWD/packages/plugin-wire/dist/src/serve-cli.js"
```

Use `--verbose` before `--` for stderr and passing details. Use `--no-runtime` for the baseline roles alone.

What it checks:
- Handshake, supported version, selected parts, registration, replacement names, ping, framing and error envelopes, shutdown and natural EOF exit.
- The fixture Provider: stream order, the complete-response hook, a valid and an unoffered tool directive, and exact truncation to 200 Unicode code points from the first result after the latest user message.
- Tool calls through `host/env/*`, parent and session scope, fixture progress and exit text, and cancellation. The early-arrival cancel probe does not prove that dispatch had not started.
- Environment files, output, deadlines and background process ownership. The descendant test applies to the advertised containment. With `points: true`, it checks point lookup and in-place restore.
- Hook replies for a refusal, a system contribution, and lossless redaction across text events within a stream segment and within one standalone custom event.
- Scripted Runtime turns: exact dispatch order, refused calls, host-recorded model intent and result, normal and failed attempt order, fresh attempt ids on retry, preparation after context overflow with a scripted host compaction, cancellation and step limits. Serial and overlapping scheduling are both allowed for parallel-capable calls.
- `resumeTurn` against synthetic standard history. An unsafe started call is not repeated. A transient Runtime fails and does not dispatch; a durable one runs the calls it can recover. This is not an independent second build's history.

The [ACP kit](../acp/README.md) checks the host side:
- `--probe-checks`: out-of-phase Runtime callbacks leave no records, exact-call dispatch, output validation, and preservation of a completed result when its catalog refresh fails.
- `--probe-checks --portable-checks`: interrupted remote model attempts are aborted or replayed as specified in [Model attempt sequences](../../docs/bindings/plugin.md#model-attempt-sequences).
- `--job-checks --crash-checks`: job recovery refuses a second resume on the same plugin connection.

Use `--plugin-checks` with conformance parts from another build for an interoperability run. The probe, recovery and jobs programs are test fixtures, not production plugins.

The kit tests selected transcripts, not arbitrary schemas, credential handling, credential-bearing Providers, tenant separation, or reliable cleanup of unconfirmed external effects. Use separate acceptance tests for these. A pass is not proof of [conformance](../../docs/conformance.md#what-conforms).
