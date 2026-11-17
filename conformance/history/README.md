# History service conformance kit

Checks that a running history service follows the [history service binding](../../docs/bindings/history-http.md), `modular-agent-history/1`. It needs nothing but Node.

```sh
node run.mjs <service url> <token file>
```

It creates sessions with random ids. It checks:
- tokens;
- `GET /v1`;
- creating a session, safely and against a conflict;
- leases: the same owner, another owner, renewing, releasing, and a lost lease;
- keeping entries: all or none, resending, key order, and conflicts;
- `?after`, and unknown sessions and entries;
- listing, which leaves out sessions with no entries;
- erasure: refused without the lease, what an erased entry keeps, and erasing twice.

Exit code 0 means every check passed.

To swap history services across builds, point an agent at one. The TypeScript agent uses `MODULAR_AGENT_HISTORY_URL` and `MODULAR_AGENT_HISTORY_TOKEN_FILE`.
