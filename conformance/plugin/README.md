# Plugin binding conformance kit

Checks a build's conformance plugin against the [plugin binding](../../docs/bindings/plugin.md), `modular-agent-plugin/1`. The kit is the host. It uses a temporary project and home, a scripted Provider and an environment that accepts only fixture callbacks. There is no external model or network dependency.

Run on a disposable Linux environment with Node.js, Bash, `setsid` and GNU coreutils. Use absolute paths in the command and its arguments. The kit sets a fresh `HOME`; the launcher cannot depend on per-user tool lookup. The project directory is not a sandbox. Only run trusted test programs with no ambient credentials or production configuration.

```sh
node conformance/plugin/run.mjs -- <plugin command> [args...]
```

For the TypeScript build, run `npm ci && npm run build` at the repository root, then use `node conformance/plugin/run.mjs -- node "$PWD/packages/plugin-wire/dist/src/serve-cli.js"`.

Use `--verbose` before `--` for stderr and passing details. Use `--no-runtime` for the baseline roles alone. The default run also exercises the Runtime tiers; use `--no-runtime` if neither tier is offered. Exit code 0 means all checks run passed.

What it checks:
- Handshake, supported version, selected parts, registration, replacement names, ping, framing, JSON nesting at 64 and 65 levels, error envelopes, shutdown and natural EOF exit.
- The fixture Provider: stream order, inference using the `provider.request` hook's answer, the complete-response hook, a valid and an unoffered tool directive, and exact truncation to 200 Unicode code points from the first result after the latest user message.
- Tool calls through `host/env/*`, parent and session scope, fixture progress and exit text, and cancellation. The early-arrival cancel probe does not prove that dispatch had not started.
- Environment files, output, deadlines and background process ownership. Platform claims use the binding's spellings for standard systems. Descendant tests use the advertised containment only for an exact platform match. With `points: true`, it checks non-mutating point lookup, in-place restore and `not_found` for unknown points and a point saved by a separate environment.
- [Edition 4 draft](../../docs/adr/0023-edition-4-draft.md), only where the plugin offers it. If the `tools` part registers `nest`: one `host/tools/call` under its own `tools/call`, the nested result passed on unchanged, including a refusal, and a protocol error turned into a failed result. `env/list` returns named entries with kinds, `not_found` for a missing directory and `invalid_request` for a file; an environment without it must say `not_supported` or `method_not_found`.
- Hook replies for a refusal, a system contribution, and lossless redaction across text events within a stream segment and within one standalone custom event.
- Scripted Runtime turns: exact dispatch order, refused calls, host-recorded model intent and result, normal and failed attempt order, fresh attempt ids on retry, preparation after context overflow with a scripted host compaction, cancellation and step limits. The Runtime reports only step usage and does not call `step.after` for the scripted auxiliary attempt. It simulates `turn_limit` before preparation or dispatch, and after the host has written a model intent and its bookkeeping abort. The Runtime reports the limit without submitting a response for the undispatched attempt. When steering is advertised, the Runtime makes its final check at the turn boundary. Serial and overlapping scheduling are both allowed for parallel-capable calls.
- `resumeTurn` against synthetic standard history. An unsafe started call is not repeated. A transient Runtime fails and does not dispatch; a durable one runs the calls it can recover. Neither resubmits a result already settled before resume. This is not an independent second build's history.

The [ACP kit](../acp/README.md) checks the host side:
- `--probe-checks`: out-of-phase Runtime callbacks leave no records, exact-call dispatch and its recorded registration, an already-dispatched tool's environment callback, refusal of a call not offered in the attempt, a refused call's committed result, acceptance of an unknown `provider.response` member, the steering cutoff, output validation, and preservation of a completed result when its catalog refresh fails. With tenant support, the host signals a latched limit at the next `prepareStep`. With tenant support and a history service, the kit also checks the host's aborted response after a post-intent limit.
- `--probe-checks --crash-checks`: separate crashes before and after `step.after` check settlement before Runtime handoff and reuse of a committed gate decision. See [The host asks the Runtime](../../docs/bindings/plugin.md#the-host-asks-the-runtime).
- `--probe-checks --portable-checks`: remote Runtime recovery and Provider commit checks, including abort and replay in [Model attempt sequences](../../docs/bindings/plugin.md#model-attempt-sequences). A normal `--portable-checks` run does not cover remote Runtime recovery.
- `--job-checks --crash-checks`: job recovery refuses a second resume on the same plugin connection.

Use the ACP kit's `--plugin-checks` with the `hooks` part from another build for an interoperability run. The probe, recovery and jobs programs are test fixtures, not production plugins.

The kit tests selected transcripts, not arbitrary schemas, credential handling, credential-bearing Providers, tenant separation, or reliable cleanup of unconfirmed external effects. Use separate acceptance tests for these. A pass is not proof of [conformance](../../docs/conformance.md#what-conforms).
