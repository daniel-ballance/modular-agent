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

From another shell, run the kit against `http://127.0.0.1:39071` with the path to `$scratch/token`. Stop the service and remove the scratch directory after use. An agent using this service takes the same URL and token file via the two variables above.

What it checks:
- Authentication errors, declaration and lease length, selected response envelopes and input validation.
- Exact metadata resend, conflict on changed metadata, project filtering and list order.
- Lease generation after release and expiry, renewals, `held` retry timing fields, and concurrent stale requests against a current writer. The expiry check is skipped when the advertised TTL exceeds the kit's 60-second wait budget.
- Ordered, full JSON round-trip of opaque entries and lineage metadata, numeric equality, equal duplicates and failure atomicity for conflicting or malformed batches.
- Cursor traversal, item and byte limits, and rejection of an entry that cannot fit a page.
- Erasure with and without a lease, exact tombstones and ordered idempotent results.

It does not restart the service or check durable failover, retention expiry, agent lease renewal after network loss, backup deletion, token entropy on the service, or TLS provisioning. The bearer token is service-wide, not a test of tenant isolation. Passing these checks is not proof of [conformance](../../docs/conformance.md#what-conforms).
