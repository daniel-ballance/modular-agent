# History service binding: `modular-agent-history/1`

This binding defines the HTTP wire for keeping ordered JSON records. The service does not interpret agent history. [Contracts](../contracts.md) defines core behavior, [Security](../security.md) defines deployment trust, and [Shared data](data.md#portable-sessions) defines portable reconstruction by agents.

## The basics

- The service MUST authenticate every request, including `GET /v1`, using a bearer token with at least 128 bits of entropy or mutual TLS. A bearer token MUST be sent as `Authorization: Bearer <token>` and compared in constant time.
- A request MAY carry W3C `traceparent` and optional `tracestate` headers. A participating service extracts them after authentication; absent, invalid or unknown context does not change the operation. This adds no endpoint or declaration and records remain opaque. See [Context on the wire](../telemetry.md#context-on-the-wire).
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
| `GET /v1` | `200 { binding: "modular-agent-history/1", ttlMs: PositiveMs, retention?: PositiveMs \| null, pendingErasure?: 1 }` |
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

The service MUST apply each operation atomically with respect to other operations on that session, including across replicas. It MUST acknowledge a successful metadata, append or erase mutation only after durable commit. A read MUST see either the entire committed change or none of it. A service restart or failover MUST preserve committed records. A service that does not carry forward its current leases and their exclusions MUST invalidate the old leases. The service SHOULD keep `ttlMs` fixed for its lifetime. If it changes, the service MUST retain an upper bound across restarts and failovers on the TTLs it has granted or renewed. If it loses lease state, it MUST hold for at least the larger of its current `ttlMs` and the longest TTL it granted or renewed in the preceding interval of that upper bound. It MAY use the upper bound in place of the longest recent TTL, without tracking grant times. With no verifiable bound, it MUST stay unavailable until prior writer deadlines can be ruled out. See [Deliberate limits](../security.md#deliberate-limits) for stores whose state cannot be verified. During the hold it MUST refuse every acquisition and every erase without a lease with `409 held` and `retryAfterMs` for the remaining wait. A writer whose lease vanished in the restart may still be within its own deadline during that time. A service that preserves leases continues to enforce their existing expiries.

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

The writer SHOULD use a monotonic clock that advances during suspension. Where the platform offers none to the writer, it MAY derive one: each reading advances by the larger of a monotonic clock's advance and the wall clock's advance since the previous reading, and if the wall clock moves back by more than a stated tolerance, the clock jumps far enough ahead that every lease measured before the jump is lost; the writer then subtracts that tolerance as its margin. Otherwise the writer MUST subtract an [operator-configured margin](../security.md#what-an-operator-configures) from each local lease deadline. The writer MUST schedule renewal by `ttlMs / 3` and treat the lease as lost at `ttlMs / 2`, both measured from sending the request for the latest successful grant or renewal and adjusted by that margin when applicable. It MUST treat a success received at or beyond the earlier of the existing loss cutoff (if any) and the loss cutoff measured from that request's send time as loss. It MUST check that cutoff immediately before every new effect. A reported `lost` or uncertain writer access ends dispatch authority. A repeated acquire after a lost reply MUST be followed by a timely renew before use. A lost generation MUST NOT be revived. See [core recovery](../contracts.md#recovery-and-repeating-work); no lease fences outside effects.

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

The service MUST return distinct known IDs from the request in first occurrence order, including IDs already erased. Unknown IDs are ignored. It MUST replace each erased record by applying the [shared tombstone field table](data.md#entry-fields-and-tombstones). Only envelope fields supply associations. It MUST use `kind: null` when the old `kind` is missing or not a string and omit non-string associations. It MUST preserve a valid `sources` array without deciding whether the entry belongs to a fork prefix. It MUST omit malformed optional additions and strip any fields other than the standard numeric fields from preserved usage. The service MUST remove the other fields from its live copies. It MUST NOT serve pre-erasure data after a restart or restore.

The Harness MUST follow [Cross-session coordination](../contracts.md#cross-session-coordination) before requesting deletion, including holding the current lease for each affected session and recording the `erasure` entry. The service's optional lease form does not relax the Harness's rule. After uncertain writes, the Harness MUST reconcile under the [lease rules](#writing-one-writer-at-a-time). The base service does not compute lineage, enforce pending marks or write `erasure` entries. The optional profile below adds coordination, not lineage or bookkeeping. An offline backup is outside per-session atomicity; the deployment's erasure policy governs backup deletion.

## Pending-erasure registry profile (`pendingErasure: 1`)

A service MAY implement this profile. If it does, it MUST declare `pendingErasure: 1` in `GET /v1` for the lifetime of that store. If it does not, it MUST omit the field. A client implementing this profile MUST use it when it finds version `1`. An HTTP history composition without a supported registry version MUST declare `erasure: false`. Finding the version does not by itself establish the Harness's [declared scope](../contracts.md#cross-session-coordination). This profile tracks history records only. It does not confirm deletion by Providers or other parts.

### Registry requests

The base authentication, paths, error order, media type and body limit apply. The new routes are absent without the profile. Objects in the following shapes have exactly the named fields. `Revision` is an opaque string with the same syntax as `Lease`, but grants no writer access. Registry IDs use `Id`; IDs used as path segments also follow the path rules.

| Method and path | Query | Request body | Success (`200`) |
|---|---|---|---|
| `GET /v1/sessions/{id}/pending-erasure` | `after?`: intent ID (default start); `limit?`: integer 1 to 500 (default 500) | none | `{ revision: Revision, plans: Plan[], next?: Id }` |
| `POST /v1/sessions/{id}/pending-erasure` | none | `{ lease: Lease, revision: Revision, intentId: Id, entryIds: Id[], copies: CopySet[] }` | `{ intentId: Id, sessionIds: Id[] }` |
| `POST /v1/sessions/{id}/pending-erasure/{intentId}/complete` | none | `{ lease: Lease, entryIds: Id[] }` | `{}` |

- `CopySet` is `{ sessionId: Id, recordId: Id, entryIds: Id[] }`. `recordId` is the ID the Harness will use for that session's `erasure` entry.
- `Plan` is `{ intentId: Id, sourceSessionId: Id, recordId: Id, copies: { entryId: Id, complete: boolean }[] }`. A plan covers only the path session. Each copy starts with `complete: false`. The registry MUST NOT contain payload, input keys or credentials. Input-key reservations belong in the `erasure` entry.
- All request arrays MUST be nonempty. Entry IDs in an array and session IDs in `copies` MUST be distinct. The source session MUST appear in `copies`, covering all requested source targets. A violation, unknown field or malformed revision is `400 invalid_request`.
- Registry GET MUST read authoritative state without a lease, include pending and completed plans, and send `Cache-Control: no-store`. It MUST also return plans for reserved IDs whose records expired; a never-created ID gives `404 unknown_session`. Plans are in intent publication order; copy order is the published order. Paging follows the [4 MiB prefix rule](#sessions), with the last plan's `intentId` as `next`. An unknown `after` gives `404 unknown_intent`. Publication MUST refuse a plan that would not fit by itself with the largest allowed revision and its intent ID as `next` (`413 request_too_large`).

### Publication and completion

- The revision is shared by all sessions in one service. The service MUST change it atomically with any committed change to session metadata, entries or registry state, and MUST NOT reuse a revision for a different state, including across restart or failover. No-op requests need not change it. Revisions do not prove restore freshness.
- The Harness MUST authorize the erasure, read the source registry revision **before** scanning history, and compute the exact copy set under the [core erasure rules](../contracts.md#erasure). The service does not interpret lineage or authorize the actor. Under the same serialization as append and erase, it MUST check the current source lease and compare the revision with the current one before publishing all plans atomically. It MUST NOT require a lease on a destination to mark it. An unknown destination session gives `404 unknown_session`; an unknown target or copy entry gives `404 unknown_entry`. A well-formed stale revision gives `409 stale_revision`; the client MUST take a fresh revision and rediscover copies before trying to publish again.
- Intent IDs are unique within the registry, and the operation is keyed by the source session and unordered set of source targets. After checking the source lease, if the submitted intent ID already exists but describes a different operation or different copy sets or bookkeeping IDs, the service MUST return `409 conflict`. An identical publication or a new intent ID for an existing operation MUST return the original `intentId`, without changing its plans or requiring a current revision. Every successful publication of an operation returns the same `sessionIds`: the `sessionId` of each copy set in the original publication, the source's own included, in published order, including any whose session has since expired, so a client that crashed can recover the whole plan by publishing again. The client uses the returned ID, even after an uncertain response. A new plan's `recordId` MUST be unused in its session and distinct from IDs reserved by other plans there (`409 conflict` otherwise).
- A participating client MUST send `History-Revision: <Revision>` on every append, including bookkeeping and initial fork batches. It MUST obtain the revision before checking which sources and copies the batch uses. It MUST NOT append a copy of pending or erased content. The service MUST compare a supplied revision atomically with append, after checking the current lease. A malformed or repeated header gives `400 invalid_request`; a stale one gives `409 stale_revision` without appending. The client MUST recheck the marks and data used to prepare the batch, not just replace the header and resend. The header does not change the base body size rule. The service MUST still accept base appends without this header; raw access is not participation in this profile. The operator MUST NOT let writers outside the profile publish copies into the coordinated scope.
- On either registry POST, a supplied lease that is not current gives `409 lost`. Before completing work, the current or later writer MUST read the plans, settle affected work, and commit a single `erasure` entry with the plan's `recordId`, listing its targets and preserving any required keys. It then sends the ordinary leased erase. To acknowledge completion, it sends the second registry POST for the copies it verified. The service MUST atomically check the destination lease, find the plan (`404 unknown_intent` if absent), and verify that every requested ID belongs to it (`400 invalid_request` otherwise). It MUST find the live `erasure` record by `recordId`, with `kind: "erasure"` and `data.entryIds` listing each requested ID, and a tombstone for each ID. Missing evidence gives `409 conflict`. Only then does it set those flags to `true`. Repeating a completion with the current lease and the same evidence succeeds. Retention or an absent entry does not count as a tombstone.

### Reader cutoff and restore

- Raw GET still returns the stored records, including pending payload. A participating Harness MUST NOT expose those bytes as a view. Before authorizing a delivery, dispatch or copy, it MUST prepare the operation and check fresh registry state for all sessions whose data the operation uses, including already-open sessions. It MUST read all applicable plan pages at one revision. It MUST refuse affected use if any plan is pending or a completed plan lacks the matching tombstone in the view being used. It MAY refuse the whole affected session. The check also covers cached views, callbacks, receipts, recovery and buffered output. If the registry cannot be read, a page or revision is inconsistent, or the Harness cannot establish that a scope is unaffected, it MUST fail closed with `unavailable`. It MUST NOT treat failure of a declared registry as absence of the capability.
- The authoritative check for the prepared operation is its admission point, ordered against intent publication by the service. An operation admitted before publication may finish that handoff; the check does not authorize later callbacks, queued deliveries or other uses. The Harness MUST check at the final handoff, not when it first opens a view or queues work. Guarded append checks again at commit. The profile cannot recall a handoff already made or order work outside the participating Harnesses.
- The service MUST durably store marks before acknowledging publication and preserve both pending and completed plans on restart, including after session expiry. It MUST refuse coordinated use with `503 unavailable` if authoritative registry state is missing or unreadable, and MUST NOT recreate it as empty. Before serving restored data, the operator MUST prove freshness against an authority independent of the restored backup, as required by [Security](../security.md#data-the-record-views-the-output-gate-and-erasure). An old history and old registry can agree while both are stale. Completed marks still fence stale views; completion is not permission to prune the marks.

## What the service declares

The client MUST check `GET /v1` before use and refuse a binding it does not speak. The service MUST use the declared `ttlMs` for grants and renewals. Absent or null `retention` disables expiry. Otherwise the service MUST treat the session as expired at operation lookup when it has no current lease and the declared interval since its last metadata or entry change has elapsed. An expired session and its cursors are unknown; its ID stays reserved. Sweeps reclaim storage, not authority. Expiry does not confirm erasure or reset usage.

## Changes

- **2026-11-22.** Allow optional W3C trace context headers per authenticated request.

- **2026-11-21.** Add the optional `pendingErasure: 1` profile for durable pending marks, guarded appends and leased completion without changing the base binding version.

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
