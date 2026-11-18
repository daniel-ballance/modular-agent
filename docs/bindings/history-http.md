# History service binding: `modular-agent-history/1`

This binding defines the HTTP wire for keeping ordered JSON records. The service does not interpret agent history. [Contracts](../contracts.md) defines core behavior, [Security](../security.md) defines deployment trust, and [Shared data](data.md#portable-sessions) defines portable reconstruction by agents.

## The basics

- The service MUST authenticate every request, including `GET /v1`, using a bearer token with at least 128 bits of entropy or mutual TLS. A bearer token MUST be sent as `Authorization: Bearer <token>` and compared in constant time.
- Clients and services MUST follow [Security's TLS rule](../security.md#authentication-on-each-wire). For the plaintext exception the client MUST require a numeric address in `127.0.0.0/8` or `::1`, with the service listening only on loopback. A client MUST NOT forward credentials to redirects. Peers MUST NOT log credentials or lease values.
- One credential authorizes raw reads, creation, append and erasure for every session, including authority records. It grants write trust, not just observation. Operators MUST share a service only among trusted writers and MUST NOT give its credentials to read-only observers. Isolation requires separate services and credentials.
- A nonempty body MUST be one UTF-8 JSON object with media type `application/json`, using the [shared JSON rules](data.md#general-rules). Responses MUST use that media type, including errors and `{}`. The service MUST reject request bodies over 64 MiB, measured in decoded body bytes.
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
| `POST /v1/sessions/{id}/entries` | none | `{ lease: Id, entries: Entry[] }` |
| `POST /v1/sessions/{id}/erase` | none | `{ entryIds: Id[], lease?: Id }` (no lease by default) |

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
| Acquire, granted or already held by this owner | `200 { lease: Id, ttlMs: PositiveMs }` |
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
| Invalid JSON, field, path or query value, missing required body, body where none is allowed, or an appended tombstone | `400 invalid_request` |
| Temporary service or storage failure | `503 unavailable` |

`Id` and `Count` use the [shared types](data.md#general-rules). `PositiveMs` is a positive `Count` in milliseconds. An omitted `next` means there are no more results at the time of that read. A successful response MUST omit fields not in its shape, except unknown metadata and entry fields the service keeps.

## Sessions

A Session is `{ id: Id, project: string, created: Time, parentSessionId?: Id, forkedFrom?: { sessionId: Id, entryId: Id } }`. The two optional fields default to absent. Session metadata uses [shared time and equality](data.md#general-rules); project paths are compared as exact strings. The service MUST preserve unknown metadata fields and compare the entire metadata object on repeated PUT. It MUST NOT dereference or authorize lineage separately. The Harness is responsible for lineage and [tenant authorization](data.md#limits-and-tenants).

The service MUST list sessions with kept entries only, by descending `created`, then by ascending UTF-8 byte order of `id`. It MUST apply `project` before finding the cursor or taking a page. It MUST return session entries in append order. Each page MUST take the longest prefix after the cursor that fits the requested item limit and 4 MiB of compact UTF-8 response JSON, including all metadata and the cursor. A page MUST contain at least one item when any remain. If more remain, `next` MUST be the ID of the last item; the client passes it as `after` on the next request. Reads need no lease and do not take a snapshot across pages.

For a new session the agent MUST defer PUT until its [first admitted input](data.md#setup-records). A fork instead MUST append the complete copied prefix and fresh setup in one initial batch. Before PUT the agent MUST check that the encoded initial append body fits the 64 MiB limit, including the lease field. Since the lease has not been issued yet, it MAY use a guaranteed upper bound on the encoded lease size. The agent MUST refuse a fork whose body cannot be shown to fit, without creating the destination. This binding does not transmit a lease-size bound. See [ACP](acp.md#extension-methods) for the refusal. The service MUST keep a metadata-only record unlisted, and GET returns an empty `entries` array for it. An agent MUST NOT open such a record as a durable session or infer setup from metadata. It MAY finish a known initial batch after identical PUT under a current lease; otherwise the record remains unlisted until retention or operator reclamation. There is no wire delete. Operators MUST bound unpublished metadata and ID reservations with quotas and retention or reclamation. On creation quota exhaustion the service MUST refuse new IDs with `503 unavailable`, preserving capacity for reads, release, erasure and settlement of existing work.

## Choosing a service at start

An agent that supports this binding MUST read these variables at startup:
- `MODULAR_AGENT_HISTORY_URL`: absolute `http` or `https` base URL, without userinfo, query or fragment. The client MUST append `/v1` after removing trailing slashes, preserving any configured path prefix.
- `MODULAR_AGENT_HISTORY_TOKEN_FILE`: UTF-8 bearer token file. The client MUST trim ASCII space, tab, CR and LF from both ends. The remaining value MUST be nonempty and use the HTTP Bearer token alphabet (`A-Z`, `a-z`, `0-9`, `-._~+/`, with optional trailing `=` characters). An unreadable file or configured URL without usable credentials is a configuration error.

When configured, the client MUST use this URL in preference to its local store. Operators SHOULD restrict the token file to the agent's account. The binding does not prescribe credential rotation or mTLS provisioning.

## Writing: one writer at a time

The service MUST apply each operation atomically with respect to other operations on that session, including across replicas. It MUST acknowledge a successful metadata, append or erase mutation only after durable commit. A read MUST see either the entire committed change or none of it. A service restart or failover MUST preserve committed records. A service that does not carry forward its current leases and their exclusions MUST invalidate the old leases. For `ttlMs` from the restart or failover, it MUST refuse every acquisition, and every erase without a lease, with `409 held` and `retryAfterMs` for the remaining wait. A writer whose lease vanished in the restart may still be within its own deadline during that time. A service that preserves leases continues to enforce their existing expiries.

An owner is a run identifier, not a credential. A writer MUST generate a fresh owner per run with at least 122 random bits or equivalent uniqueness. The service MUST scope ownership to the authenticated identity and session. Every new lease MUST have a fresh, unguessable value with at least 128 bits of entropy.

| State at the operation | Operation | Required transition |
|---|---|---|
| No current lease | Acquire | The service MUST make a new lease current, expiring one full `ttlMs` after grant. |
| Current lease for this owner and identity | Acquire | The service MUST return the same lease and full `ttlMs` without extending expiry. |
| Current lease for another owner or identity | Acquire | The service MUST refuse the acquire as `held`. |
| Current lease named by its authenticated writer | Renew | The service MUST set expiry to one full `ttlMs` after renewal. |
| Current lease named by its authenticated writer | Release | The service MUST end that lease. |
| Expiry reached or lease invalidated by restart or failover | Any | The service MUST treat that lease as no longer current. |
| A lease is no longer current or belongs to another identity | Renew, append or erase naming it | The service MUST refuse the operation as `lost`. |
| A lease is no longer current or belongs to another identity | Release naming it | The service MUST return success without changing state. |

The service MUST measure expiry with its monotonic clock. On `held`, it MUST report the remaining time rounded up to milliseconds when it forms the response. An ended lease MUST NOT become valid again.

The writer MUST use a monotonic clock that accounts for suspension, with renewal due at `ttlMs / 3` and loss at `ttlMs / 2` from sending the latest successful grant or renewal. It MUST treat a success received at or beyond the earlier of the existing loss cutoff (if any) and `ttlMs / 2` from sending that request as loss. It MUST check that cutoff immediately before every new effect. A reported `lost` or uncertain writer access ends dispatch authority. A repeated acquire after a lost reply MUST be followed by a timely renew before use. A lost generation MUST NOT be revived. See [core recovery](../contracts.md#recovery-and-repeating-work); no lease fences outside effects.

An agent reopening a held session MUST use a monotonic open budget of the declared `ttlMs` plus 1,000 ms from receiving the first `held`. It MUST respect `retryAfterMs`, fail if no retry fits, and cap each acquire wait to the remaining budget. On a new lease it MUST reconcile committed state before effects.

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

The service MUST return distinct known IDs from the request in first occurrence order, including IDs already erased. Unknown IDs are ignored. It MUST replace each erased record by applying the [shared tombstone field table](data.md#entry-fields-and-tombstones). It MUST use `kind: null` when the old `kind` is missing or not a string and omit non-string associations. It MUST preserve a valid `sources` array without deciding whether the entry belongs to a fork prefix. It MUST omit malformed optional additions and strip any fields other than the standard numeric fields from preserved usage. The service MUST remove the other fields from its live copies. It MUST NOT serve pre-erasure data after a restart or restore.

The Harness MUST keep a durable erasure intent before sending the deletion, and reconcile pending targets by reading if a commit or reply is uncertain. The agent, not the service, records the `erasure` entries. Per-session atomicity does not extend to copies in other sessions or to offline backups; the deployment's erasure policy governs backup deletion.

## What the service declares

The client MUST check `GET /v1` before use and refuse a binding it does not speak. The service MUST use the declared `ttlMs` for grants and renewals. Absent or null `retention` disables expiry. Otherwise the service MUST treat the session as expired at operation lookup when it has no current lease and the declared interval since its last metadata or entry change has elapsed. An expired session and its cursors are unknown; its ID stays reserved. Sweeps reclaim storage, not authority. Expiry does not confirm erasure or reset usage.

## Changes

- Production round two: conservative lease timing, reconciliation, path and bootstrap validation, retention cutoff and the [expanded tombstone identities](data.md#entry-fields-and-tombstones).

- **Production edition.** Defines the request and response shapes, paging, authentication, lease generations, durable writes and fenced erasure. The binding remains `modular-agent-history/1`.
  - Round three: lease exclusion after restart or failover, fork size preflight and the expanded tombstone projection.

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
