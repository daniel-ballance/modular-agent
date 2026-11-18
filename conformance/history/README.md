# History service conformance kit

Checks a disposable [history service](../../docs/bindings/history-http.md) over HTTP on loopback or HTTPS. The kit writes, lists and erases records, and leaves test sessions in the store. Use a test-only bearer token with at least 128 bits of entropy. Do not point this kit at production data, even if the service shares only a project with the tests.

```sh
node conformance/history/run.mjs "$MODULAR_AGENT_HISTORY_URL" "$MODULAR_AGENT_HISTORY_TOKEN_FILE"
```

To start the TypeScript reference service from the repository root:

```sh
npm ci && npm run build
umask 077
scratch=$(mktemp -d)
token=$(openssl rand -hex 16)
printf '%s\n' "$token" > "$scratch/token"
node packages/services/dist/src/serve.js history \
  "{\"dir\":\"$scratch/store\",\"token\":\"$token\",\"port\":39071,\"leaseMs\":2500}"
```

From another shell, run the kit against `http://127.0.0.1:39071` with the path to `$scratch/token`. An agent using this service takes the same URL and token file via the two variables above.

To include the restart check, leave the port free and pass `--restart -- <service command> [args...]` after the URL and token file. Use a fresh disposable store and a foreground service command that reuses that store and address when run again. The kit starts the service, kills it without graceful shutdown, and restarts it. Use a TTL of at most 60 seconds, long enough to cover restart and both probes. Stop any service you started and remove the scratch directory after use.

What it checks:
- Authentication errors, declaration and lease length, selected response envelopes, and input validation including raw and percent-encoded dot segments sent without URL normalization.
- Exact metadata resend, conflict on changed metadata, project filtering and list order.
- Lease generation after release and expiry, renewals, `held` retry timing fields, and concurrent stale requests against a current writer. The expiry check is skipped when the advertised TTL exceeds the kit's 60-second wait budget.
- Ordered, full JSON round-trip of opaque entries and lineage metadata, numeric equality, equal duplicates and failure atomicity for conflicting or malformed batches.
- Cursor traversal, item and byte limits, and rejection of an entry that cannot fit a page.
- Erasure with and without a lease, ordered idempotent results, and the exact tombstone projection, including associations, source ids, usage and keyed job ownership.
- With `--restart`, committed data survives a restart. If the service drops its old lease, acquire and unleased erase return `409 held` during the restart hold. If it preserves the lease, another owner still cannot acquire it. The hold check is skipped if the restart and probes exceed the old lease TTL.

It does not check failover between replicas, retention expiry, all client lease loss paths, backup deletion, token entropy on the service, or TLS provisioning. The [ACP kit](../acp/README.md) with `--crash-checks` and a history service checks the client side of late renewal replies. The bearer token is service-wide, not a test of tenant isolation. Passing these checks is not proof of [conformance](../../docs/conformance.md#what-conforms).
