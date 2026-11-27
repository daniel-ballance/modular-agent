# History service conformance kit

With Node.js, checks a disposable [history service](../../docs/bindings/history-http.md) over HTTP on loopback or HTTPS. The kit writes, lists and erases records, and leaves test sessions in the store. Use a test-only bearer token with at least 128 bits of entropy. Do not point this kit at production data, even if the service shares only a project with the tests.

```sh
node conformance/history/run.mjs "$MODULAR_AGENT_HISTORY_URL" "$MODULAR_AGENT_HISTORY_TOKEN_FILE"
```

To start the TypeScript build's service from `typescript/`:

```sh
npm ci && npm run build
umask 077
scratch=$(mktemp -d)
token=$(openssl rand -hex 16)
printf '%s\n' "$token" > "$scratch/token"
node packages/services/dist/src/serve.js history \
  "{\"dir\":\"$scratch/store\",\"token\":\"$token\",\"port\":39071,\"leaseTtl\":2500}"
```

From another shell, run the kit against `http://127.0.0.1:39071` with the path to `$scratch/token`. An agent using this service takes the same URL and token file via the two variables above.

To include the restart check, leave the port free and pass `--restart -- <service command> [args...]` after the URL and token file. Use a fresh disposable store and a foreground service command that reuses that store and address when run again. The kit starts the service, kills it without graceful shutdown, and restarts it. Use a TTL of at most 60 seconds, long enough to cover restart and both probes.

If the service supports a change of TTL across restart, use `--restart-ttl` instead of `--restart`. Both flags set `MODULAR_AGENT_KIT_RESTART_PHASE` to `initial` on the first launch and `restart` on the second. Configure the same service address and store for both runs, with a longer TTL at first (for example, 6000 ms) and a shorter TTL on restart (for example, 1000 ms). The kit tests beyond the shorter TTL, while the old lease could still be live. Keep the startup time plus the shorter TTL well below the old TTL to exercise the check.

For the ADR 0030 deployment check, run two disposable services with distinct endpoints, backing directories and credentials. Add `--isolation-checks SECOND_URL SECOND_TOKEN_FILE` after the first URL and token file. The kit seeds only the second service, checks both cross-credential refusals, and verifies that neither a project filter nor a foreign session ID routes reads, lease acquisition, append or erase to the other store. The second service's records must stay unchanged. This checks the two configured endpoints, not how an agent selects among raw stores.

To check the optional [pending-erasure registry](../../docs/bindings/history-http.md#pending-erasure-registry-profile-pendingerasure-1), run:

```sh
node conformance/history/run.mjs "$MODULAR_AGENT_HISTORY_URL" "$MODULAR_AGENT_HISTORY_TOKEN_FILE" \
  --erasure-registry-checks --restart -- <service command> [args...]
```

Use the same foreground command and disposable store rules as for `--restart`; a service that changes its TTL across restart, such as the Rust SDK's example, uses `--restart-ttl` instead. Use a fixed TTL such as 2,500 ms. The option fails if the service does not declare `pendingErasure: 1`; the remaining profile checks run only if it does. Separate wire client processes publish a mark, refuse a cached copy, and complete it under a new lease. The kit restarts the service with the mark pending and again after completion. The reader fixture checks the wire cutoff; it does not test an SDK's delivery, dispatch or Provider behavior.

Stop any service you started and remove the scratch directory after use. Exit code 0 means all checks run passed.

Both SDK suites also run [durable-byte-saturation.json](durable-byte-saturation.json) against their native file and HTTP stores. They set the ordinary limit to the encoded bytes already retained, verify that a refused commit and fork leave the store unchanged, and retry pending erasure with reserved control headroom. The SDKs also check that a rewind intent refuses before changing working files at the ordinary limit, and that completion, compensation and reopen recovery fit in control headroom when another session fills ordinary space during restore.

What it checks:
- Authentication errors, declaration, 1 to 128 byte leases with the permitted alphabet, JSON nesting at 64 and 65 levels, selected response envelopes, and input validation including raw and percent-encoded dot segments sent without URL normalization.
- Exact metadata resend, conflict on changed metadata, project filtering and list order.
- Lease generation after release and expiry, renewals, `held` retry timing fields, and concurrent stale requests against a current writer. The expiry check is skipped when the advertised TTL exceeds the kit's 60-second wait budget.
- Ordered, full JSON round-trip of opaque entries and lineage metadata, numeric equality, equal duplicates and failure atomicity for conflicting or malformed batches.
- Cursor traversal, item and byte limits, and rejection of an entry that cannot fit a page.
- Erasure with and without a lease, ordered idempotent results, and the exact tombstone projection, including envelope associations, source ids, usage and keyed job ownership. A new writer sees the same identities. Nested payload fields confer none.
- With either restart flag, committed data survives a restart. If the service drops its old lease, acquire and unleased erase return `409 held` during the restart hold. If it preserves the lease, another owner still cannot acquire it. `--restart-ttl` checks the same exclusions after the shorter TTL has elapsed. The hold check is skipped if the restart and probes exceed the old lease TTL.

The wire kit does not control a service’s backup or witness. Both SDK suites use [restore-freshness.json](restore-freshness.json) to exercise older and matching restores of their built-in file and HTTP stores. The wire kit also does not check failover between replicas, retention expiry, all client lease loss paths, backup deletion, token entropy on the service, or TLS provisioning. It also does not check that a renewal does not wait for another session's storage work, or that a write checks its lease right before commit. Storage starts only after the service has read a whole request, and the kit cannot stall it from outside. Each language's built-in service tests both rules itself. The [ACP kit](../acp/README.md) with `--crash-checks` checks the client side of late renewal replies with a service TTL from 1,000 to 15,000 ms inclusive. Use the 2,500 ms example above if your service is outside that range. The bearer token is service-wide, not a test of tenant isolation. Passing these checks is not proof of [conformance](../../docs/conformance.md#what-conforms).
