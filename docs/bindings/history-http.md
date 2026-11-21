# History service binding: `modular-agent-history/1`

This binding defines the HTTP wire for keeping ordered JSON records. The service does not interpret agent history. [Contracts](../contracts.md) defines core behavior, [Security](../security.md) defines deployment trust, and [Shared data](data.md#portable-sessions) defines portable reconstruction by agents.

## The basics

- The service MUST authenticate every request, including `GET /v1`, using a bearer token with at least 128 bits of entropy or mutual TLS. A bearer token MUST be sent as `Authorization: Bearer <token>` and compared in constant time.
- Clients and services MUST follow [Security's TLS rule](../security.md#authentication-on-each-wire). For the plaintext exception the client MUST require a numeric address in `127.0.0.0/8` or `::1`, with the service listening only on loopback. A client MUST NOT forward credentials to redirects. Peers MUST NOT log credentials or lease values.
- One credential authorizes raw reads, creation, append and erasure for every session, including authority records. It grants write trust, not just observation. Operators MUST share a service only among trusted writers and MUST NOT give its credentials to read-only observers. A `/1` service does not authorize projects or tenants. To isolate raw records between trust scopes, the operator MUST use separate service instances, credentials and backing namespaces. Neither a project query nor a tenant entry partitions a service. The operator MUST assign a session's store from trusted configuration, not from a client or project, and MUST NOT give a writer a route to a raw namespace it is not trusted to read and change.
- A nonempty body MUST be one UTF-8 JSON object with media type `application/json`, using the [shared JSON rules](data.md#general-rules). Responses MUST use that media type, including errors and `{}`. Senders MUST omit `Content-Encoding`. The service MUST reject request bodies over 64 MiB of actual body bytes.
- A path-scoped ID or lease MUST NOT be `.` or `..`. Clients MUST percent-encode each path segment and query value in UTF-8, escaping bytes other than RFC 3986 unreserved bytes. The service MUST reject raw or encoded dot segments before normalization. It MUST decode once without treating a decoded slash as a separator or `+` as space. It MUST reject invalid encodings and unknown or repeated query parameters.
- The service MUST check errors in this order: authentication, route, method, size, media type, request shape, session existence, then the operation's preconditions. An error response MUST leave session state unchanged. If the service cannot tell whether a mutation committed, it MUST close the request without a success or error response.

The two tables are the request and response definitions. `?` means optional; an omitted query has the default shown in the table. Where the table says none, the client MUST omit that query or body.

| Method and path | Query fields | Body |
|---|---|---|
| `GET /v1` | none | none |
| `PUT /v1/sessions/{id}` | none | Session metadata (below) without `id`; the service MUST reject a body containing `id` |
| `GET /v1/sessions` | `project?`: string (default all projects); `after?`: session ID (default start); `limit?`: integer 1 to 500 (default 500) | none |
| `GET /v1/sessions/{id}` | `after?`: entry ID (default start); `limit?`: integer 1 to 500 (default 500) | none |
| `POST /v1/sessions/{id}/lease` | none | `{ owner: Id }` |
| `POST /v1/sessions/{id}/lease/{lease}/renew` | none | none |
| `DELETE /v1/sessions/{id}/lease/{lease}` | none | none |
| `POST /v1/sessions/{id}/entries` | none | `{ lease: Lease, entries: Entry[] }` |
| `POST /v1/sessions/{id}/erase` | none | `{ entryIds: Id[], lease?: Lease }` (no lease by default) |

The service MUST return the status and body shown for each case. All errors MUST have `{ error: string, code: string }`, with `retryAfterMs` added as shown for `held`. The message is for humans; the code is for clients.

| Request or case | Status and body |
|---|---|
| `GET /v1` | `200 { binding: "modular-agent-history/1", ttlMs: PositiveMs, retention?: PositiveMs \| null }` |
| `PUT /v1/sessions/{id}`, new or identical | `200 {}` |
| `PUT /v1/sessions/{id}`, different metadata or previously expired ID | `409 conflict` |
| `GET /v1/sessions` | `200 { sessions: Session[], next?: Id }` |
| `GET /v1/sessions/{id}` | `200 { session: Session, entries: Entry[], next?: Id }` |
| List cursor not in the requested list | `404 unknown_session` |
| Entry cursor not in the requested session | `404 unknown_entry` |
| Acquire, granted or already held by this owner | `200 { lease: Lease, ttlMs: PositiveMs }` |
| Renew current lease | `200 { ttlMs: PositiveMs }` |
| Release, whether current or stale | `200 {}` |
| Append, including a batch with no new entries | `200 { kept: Count }` |
| Append with a conflicting entry ID | `409 conflict` |
| Append with an entry that cannot fit a page | `413 entry_too_large` |
| Erase | `200 { erased: Id[] }` |
| Acquire held by another owner or by the restart or failover wait, or erase without a lease while held | `409 { error: string, code: "held", retryAfterMs: PositiveMs }` |
| Renew, append or erase with a supplied lease that is not current | `409 lost` |
| Any operation on an unknown or expired session, except PUT | `404 unknown_session` |
| Missing or invalid authentication | `401 unauthorized`; a service accepting bearer tokens MUST include `WWW-Authenticate: Bearer` |
| Unknown path | `404 not_found` |
| Unlisted method on a known path | `405 method_not_allowed`, with the allowed methods in `Allow` |
| Request body over the size limit or metadata too large for the read envelope | `413 request_too_large` |
| Unsupported media type for a nonempty body | `415 unsupported_media_type` |
| Request with `Content-Encoding` | The service MAY refuse with `415 unsupported_media_type`. |
| Invalid JSON, request refused for [JSON depth](data.md#general-rules), invalid field, path or query value, missing required body, body where none is allowed, or an appended tombstone | `400 invalid_request` |
| Temporary service or storage failure | `503 unavailable` |

`Id` and `Count` use the [shared types](data.md#general-rules). `{lease}` and the `lease` fields use the [Lease type](#writing-one-writer-at-a-time). `PositiveMs` is a positive `Count` in milliseconds. An omitted `next` means there are no more results at the time of that read. A successful response MUST omit fields not in its shape, except unknown metadata and entry fields the service keeps.

## Sessions

A Session is `{ id: Id, project: string, created: Time, parentSessionId?: Id, forkedFrom?: { sessionId: Id, entryId: Id } }`. The two optional fields default to absent. Session metadata uses [shared time and equality](data.md#general-rules); project paths are compared as exact strings. The service MUST preserve unknown metadata fields and compare the entire metadata object on repeated PUT. It MUST NOT dereference or authorize lineage separately. The Harness is responsible for lineage and [tenant authorization](data.md#limits-and-tenants).

The service MUST list sessions with kept entries only, by descending `created`, then by ascending UTF-8 byte order of `id`. It MUST apply `project` before finding the cursor or taking a page. It MUST return session entries in append order. Each page MUST take the longest prefix after the cursor that fits the requested item limit and 4 MiB of the body it sends, including all metadata and the cursor. A page MUST contain at least one item when any remain. If more remain, `next` MUST be the ID of the last item; the client passes it as `after` on the next request. Reads need no lease and do not take a snapshot across pages.

For a new session the agent MUST defer PUT until its [first admitted input](data.md#setup-records). A fork instead MUST append the complete copied prefix and fresh setup in one initial batch. Before PUT the agent MUST measure the initial append body in its own encoding with a 128-byte ASCII placeholder for the lease, including the field and string quotes. The agent MUST send the lease characters unescaped in the append JSON. The agent MUST refuse the fork before PUT if the measured body exceeds 64 MiB. See [ACP](acp.md#extension-methods) for the refusal. The service MUST keep a metadata-only record unlisted, and GET returns an empty `entries` array for it. An agent MUST NOT open such a record as a durable session or infer setup from metadata. It MAY finish a known initial batch after identical PUT under a current lease; otherwise the record remains unlisted until retention or operator reclamation. See [Deliberate limits](../security.md#deliberate-limits) for a lost initial-create acknowledgement. There is no wire delete. Operators MUST bound unpublished metadata and ID reservations with quotas and retention or reclamation. On creation quota exhaustion the service MUST refuse new IDs with `503 unavailable`, preserving capacity for reads, release, erasure and settlement of existing work. The binding has no reservation request. An operator MUST provision storage and write capacity for writers' [outstanding reservations](../contracts.md#resource-reservations), for example by assigning each writer a share or deploying shared accounting. A client MUST NOT infer a reservation from a successful lease, append or `GET /v1`.

## Choosing a service at start

An agent that supports this binding MUST read these variables at startup:
- `MODULAR_AGENT_HISTORY_URL`: absolute `http` or `https` base URL, without userinfo, query or fragment. The client MUST append `/v1` after removing trailing slashes, preserving any configured path prefix.
- `MODULAR_AGENT_HISTORY_TOKEN_FILE`: UTF-8 bearer token file. The client MUST trim ASCII space, tab, CR and LF from both ends. The remaining value MUST be nonempty and use the HTTP Bearer token alphabet (`A-Z`, `a-z`, `0-9`, `-._~+/`, with optional trailing `=` characters). An unreadable file or configured URL without usable credentials is a configuration error.

When configured, the client MUST use this URL in preference to its local store. Operators SHOULD restrict the token file to the agent's account. The binding does not prescribe credential rotation or mTLS provisioning.

## Writing: one writer at a time

The service MUST apply each operation atomically with respect to other operations on that session, including across replicas. It MUST acknowledge a successful metadata, append or erase mutation only after durable commit. A read MUST see either the entire committed change or none of it. A service restart or failover MUST preserve committed records. A service that does not carry forward its current leases and their exclusions MUST invalidate the old leases. The service SHOULD keep `ttlMs` fixed for its lifetime. If it changes, the service MUST retain an upper bound across restarts and failovers on the TTLs it has granted or renewed. If it loses lease state, it MUST hold for at least the larger of its current `ttlMs` and the longest TTL it granted or renewed in the preceding interval of that upper bound. It MAY use the upper bound in place of the longest recent TTL, without tracking grant times. With no verifiable bound, it MUST stay unavailable until prior writer deadlines can be ruled out. See [Deliberate limits](../security.md#deliberate-limits) for legacy stores. During the hold it MUST refuse every acquisition and every erase without a lease with `409 held` and `retryAfterMs` for the remaining wait. A writer whose lease vanished in the restart may still be within its own deadline during that time. A service that preserves leases continues to enforce their existing expiries.

An owner is a run identifier, not a credential. A writer MUST generate a fresh owner per run with at least 122 random bits or equivalent uniqueness. The service MUST scope ownership to the authenticated identity and session. Every new lease MUST have a fresh, unguessable value with at least 128 bits of entropy. A Lease MUST be a string of 1 to 128 ASCII bytes from `A-Z`, `a-z`, `0-9`, `-` and `_`. A client MAY refuse a lease longer than 128 bytes.

| State at the operation | Operation | Required transition |
|---|---|---|
| Restart or failover hold | Acquire or erase without a lease | The service MUST refuse as `held`. |
| No current lease and no hold | Acquire | The service MUST make a new lease current, expiring one full `ttlMs` after grant. |
| Current lease for this owner and identity | Acquire | The service MUST return the same lease and full `ttlMs` without extending expiry. |
| Current lease for another owner or identity | Acquire | The service MUST refuse the acquire as `held`. |
| Current lease named by its authenticated writer | Renew | The service MUST set expiry to one full `ttlMs` after renewal. |
| Current lease named by its authenticated writer | Release | The service MUST end that lease. |
| Expiry reached or lease invalidated by restart or failover | Any | The service MUST treat that lease as no longer current. |
| A lease is no longer current or belongs to another identity | Renew, append or erase naming it | The service MUST refuse the operation as `lost`. |
| A lease is no longer current or belongs to another identity | Release naming it | The service MUST return success without changing state. |

The service MUST measure expiry with its monotonic clock. On `held`, it MUST report the remaining time rounded up to milliseconds when it forms the response. An ended lease MUST NOT become valid again.

The writer SHOULD use a monotonic clock that advances during suspension. If no such clock is available, the writer MUST subtract an [operator-configured margin](../security.md#what-an-operator-configures) from each local lease deadline. The writer MUST schedule renewal by `ttlMs / 3` and treat the lease as lost at `ttlMs / 2`, both measured from sending the request for the latest successful grant or renewal and adjusted by that margin when applicable. It MUST treat a success received at or beyond the earlier of the existing loss cutoff (if any) and the loss cutoff measured from that request's send time as loss. It MUST check that cutoff immediately before every new effect. A reported `lost` or uncertain writer access ends dispatch authority. A repeated acquire after a lost reply MUST be followed by a timely renew before use. A lost generation MUST NOT be revived. See [core recovery](../contracts.md#recovery-and-repeating-work); no lease fences outside effects.

An agent reopening a held session MUST use a monotonic open budget of the declared `ttlMs` plus 1,000 ms from receiving the first `held`. It MUST wait at least `retryAfterMs` before retrying. It MUST cap each acquire wait to the remaining budget. If the lease is still held at the cutoff or the next permitted retry cannot fit, the agent MUST fail the open with a retryable `held` error and the last `retryAfterMs` from the service. See [ACP Errors](acp.md#errors) for the wire mapping. The client MAY try a new open later. A restart hold can outlast the open budget if the service reduced its TTL. On a new lease the agent MUST reconcile committed state before effects.

| Uncertain mutation | Required client action |
|---|---|
| Still-current proven lease | The client MAY resend the identical append or erase under that lease. |
| Append under a lost or uncertain lease | The client MUST read under a new lease. All equal entries mean committed; none mean not found, not permission to dispatch. Tombstones bar replay. Partial or conflicting entries require reconciliation before more work. |
| Erase under a lost, uncertain or absent lease | The client MUST verify tombstones under a new lease. Remaining live targets stay pending until validated for deletion under that lease. Missing records do not confirm erasure. |

Neither `kept` nor an equal entry establishes whether an outside effect ran. Branch changes do not undo commits.

## Entries

For this service an Entry is any JSON object with `id: Id` and `parentId: Id | null`. The `erased: true` marker is reserved for service-created tombstones. The service MUST reject it on append. Other fields are opaque. The service MUST preserve and return those fields using [shared JSON equality](data.md#general-rules). It MUST NOT validate graph relationships or interpret kinds, authority or cross-session copies beyond the mechanical [tombstone projection](#erasure).

The service MUST validate the whole batch before committing and check the lease at the same atomic operation as the append. It MUST process entries in array order, skipping equal entries with the same ID already kept or staged in this batch. A different entry with an ID already kept or staged MUST conflict, including an original entry whose ID now holds a tombstone. `kept` counts newly appended entries. An empty batch has no effect and returns `kept: 0` under the current lease. Session IDs and entry IDs within a session MUST NOT be reused, including after erasure or retention.

The service MUST reject a new entry if that entry or its eventual tombstone, alone with session metadata and its own ID as `next`, would exceed the page limit. It MUST reject metadata that would not fit alone in a list page with its own ID as `next`, or in an empty session page.

## Erasure

The Harness MUST send the exact ids for each session after applying the [core erasure rules](../contracts.md#erasure). The service MUST check the lease and tombstone the requested records in one atomic operation. Without a lease it MUST erase only when no lease is current. A supplied stale lease gives `lost` even if the session is now unheld or another writer holds it.

The service MUST return distinct known IDs from the request in first occurrence order, including IDs already erased. Unknown IDs are ignored. It MUST replace each erased record by applying the [shared tombstone field table](data.md#entry-fields-and-tombstones), including [legacy association fallbacks](data.md#legacy-associations). It MUST use `kind: null` when the old `kind` is missing or not a string and omit non-string associations. It MUST preserve a valid `sources` array without deciding whether the entry belongs to a fork prefix. It MUST omit malformed optional additions and strip any fields other than the standard numeric fields from preserved usage. The service MUST remove the other fields from its live copies. It MUST NOT serve pre-erasure data after a restart or restore.

The Harness MUST follow [Cross-session coordination](../contracts.md#cross-session-coordination) before requesting deletion, including holding the current lease for each affected session and recording the `erasure` entry. The service's optional lease form does not relax the Harness's rule. After uncertain writes, the Harness MUST reconcile under the [lease rules](#writing-one-writer-at-a-time). The service does not compute lineage, enforce pending marks or write `erasure` entries. An offline backup is outside per-session atomicity; the deployment's erasure policy governs backup deletion.

## What the service declares

The client MUST check `GET /v1` before use and refuse a binding it does not speak. The service MUST use the declared `ttlMs` for grants and renewals. Absent or null `retention` disables expiry. Otherwise the service MUST treat the session as expired at operation lookup when it has no current lease and the declared interval since its last metadata or entry change has elapsed. An expired session and its cursors are unknown; its ID stays reserved. Sweeps reclaim storage, not authority. Expiry does not confirm erasure or reset usage.

## Changes

- **Proposed production rules.** Clarify raw history isolation, storage provisioning for reservations and the Harness's role in pending erasure. No new endpoints.

- **Production edition 2.** Bounded leases and fork preflight (all five builds: Elixir PE-2, Go P1, Python G88 and G99, Rust PE-01, TypeScript). Actual body and page bytes (Go P5), JSON depth and unencoded HTTP bodies (TypeScript), lease clocks (Rust PE-03, TypeScript), and retryable reopen after a restart hold (Go P4, TypeScript). See the limits on [initial create and legacy migration](../security.md#deliberate-limits) (Elixir PE-7, TypeScript).

- Production round two: conservative lease timing, reconciliation, path and bootstrap validation, retention cutoff and the [expanded tombstone identities](data.md#entry-fields-and-tombstones).

- **Production edition.** Defines the request and response shapes, paging, authentication, lease generations, durable writes and fenced erasure. The binding remains `modular-agent-history/1`.
  - Round three: lease exclusion after restart or failover, fork size preflight and the expanded tombstone projection.
  - Round four: lease exclusion across TTL changes and legacy associations in tombstones.

- **2026-11-18, round five.** An erased entry keeps its `turnId`, `stepId`, `toolCallId` and `jobId`, as the [shared data](data.md#history-entries) now says. They are identities, not content.
- **2026-11-18, round four.** `409 held` carries `retryAfterMs`, and an agent reopening a session after a crash waits for the old lease to run out. Both the TypeScript and Go agents failed the ACP kit's crash check on a history service: the killed process still held the lease, and the new one was refused. Reopening another agent's session is promised between agents that declare portable sessions.
- **2026-11-17, after round two.** Clarifications from the Go build's binding gaps, which the TypeScript service also follows:
  - `400 invalid_request`;
  - a resend has the same effect but answers `kept: 0`;
  - what is in scope;
  - `404 unknown_session` before a `PUT`;
  - leases end when the service restarts;
  - equal numbers;
  - erased entries can't be restored, and their `kind` may be null;
  - which ids `erased` lists, and that erasure is atomic per session.
